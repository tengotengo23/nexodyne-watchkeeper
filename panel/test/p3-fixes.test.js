'use strict';
// P2-272 Phase 3 review fixes: one test per finding (M1, M2, M3, S5, S7, S8, S12, S14, N2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mkTmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV_KEYS = ['HOME', 'PATH', 'WK_HOME', 'CLAUDECODE', 'WK_CALLER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
function withEnv(set, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) if (!['HOME', 'PATH'].includes(k)) delete process.env[k];
  for (const [k, v] of Object.entries(set)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const done = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  return Promise.resolve(r).finally(done);
}

// S14: a stub agy that writes a marker; Watchkeeper never runs it, in the IDE or in Claude Code.
test('S14: agy is never run, in the IDE context or the Claude Code context (stub writes a marker)', async () => {
  const engine = require('../src/reprompt-engine');
  const { defaultExecuteChannel } = require('../src/reprompt-orchestrator');
  const home = fs.realpathSync(mkTmp('wk-s14-home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(home, 'AGY-RAN');
  fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\necho ran >> "' + marker + '"\necho ok\n', { mode: 0o755 });
  const base = { HOME: home, PATH: bin + path.delimiter + '/usr/bin' + path.delimiter + '/bin', WK_HOME: path.join(home, 'wk') };
  const refusal = /Watchkeeper does not run Antigravity's agent\. Put the task in the queue for Antigravity \(wk-task add\)\.$/;
  for (const ctx of [{ name: 'IDE' }, { name: 'Claude Code', CLAUDECODE: '1' }, { name: 'Claude Code caller', WK_CALLER: 'claude_code' }]) {
    const { name, ...vars } = ctx;
    await withEnv({ ...base, ...vars }, async () => {
      assert.equal(engine.findAgyBinary(), null, name + ': findAgyBinary');
      assert.equal(engine.agyBlockedForClaude(path.join(bin, 'agy')), true, name + ': guard');
      assert.notEqual(engine.resolveAutoProvider({}), 'agy', name + ': auto');
      const st = engine.getProviderStatuses().find(s => s.id === 'agy');
      assert.equal(st.available, false, name + ': status');
      assert.match(st.detail, refusal);
      assert.deepEqual(await engine.listAgyModels(), [], name + ': models');
      await assert.rejects(engine.rewriteWithProvider({ settings: { provider: 'agy' }, secrets: {}, prompt: 'x' }), refusal);
      for (const channel of ['agy_gemini', 'agy_claude']) {
        // P2-272 4B: the lane queues a wk-task instead of refusing; home is not a git repo, so nothing is queued or run.
        const res = await defaultExecuteChannel({ channel, model: 'm', prompt: 'p', workspaceDir: home, onProgress() {} });
        assert.equal(res.queued_task, null, name + ': ' + channel);
        assert.match(res.text, /is not a git repository/);
      }
      assert.equal(fs.existsSync(marker), false, name + ': the stub never ran');
    });
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- chat sessions: M1, M2, S12, N2 (pure functions on new temp data folders) ----
const CS = require('../src/chat-sessions');
let seq = 0;
function sess(status, updatedAt) {
  const id = `WKS-20261124-0100${String(seq % 100).padStart(2, '0')}-${(0x1000 + seq++).toString(16).slice(-4)}`;
  return { id, title: 't' + seq, createdAt: updatedAt, updatedAt, turns: status ? [{ id: 'T-x' + seq, status }] : [] };
}
const archived = (dir, id) => path.join(CS.archiveDir(dir), `${id}.json`);

test('M1: × archives with the reason "deleted"; "Delete for good" removes only the archive file', () => {
  const dir = mkTmp('wk-m1-');
  const a = sess('done', 1000), b = sess('done', 2000);
  CS.saveChatSessions(dir, [a, b], 3000);
  const rec = CS.archiveChatSession(dir, a.id, 'deleted', 4000);
  assert.equal(rec.archiveReason, 'deleted');
  assert.equal(JSON.parse(fs.readFileSync(archived(dir, a.id), 'utf8')).archiveReason, 'deleted');
  assert.deepEqual(CS.loadChatSessions(dir).map(s => s.id), [b.id]);
  assert.equal(CS.purgeArchivedChatSession(dir, a.id), true);
  assert.equal(fs.existsSync(archived(dir, a.id)), false);
  assert.equal(CS.purgeArchivedChatSession(dir, a.id), false, 'a second purge finds nothing');
  assert.equal(CS.purgeArchivedChatSession(dir, b.id), false, 'an active session is never purged');
  assert.deepEqual(CS.loadChatSessions(dir).map(s => s.id), [b.id]);
  assert.equal(CS.purgeArchivedChatSession(dir, '../x'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M2: a running or waiting session is never archived (Done, × and /done); the error says why', () => {
  const dir = mkTmp('wk-m2-');
  for (const st of ['running', 'queued', 'preparing', 'awaiting_confirm']) {
    const s = sess(st, 1000);
    CS.saveChatSessions(dir, [s], 2000);
    for (const reason of ['done', 'deleted']) {
      assert.throws(() => CS.archiveChatSession(dir, s.id, reason), e => e.code === 'SESSION_BUSY' && e.message === 'Still running. Stop it first, or wait.');
    }
    assert.equal(fs.existsSync(archived(dir, s.id)), false);
    assert.deepEqual(CS.loadChatSessions(dir).map(x => x.id), [s.id]);
  }
  const fin = sess('done', 3000);
  CS.saveChatSessions(dir, [fin], 4000);
  assert.ok(CS.archiveChatSession(dir, fin.id, 'done'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S12: over 40 sessions, the oldest idle ones are archived with the reason "overflow"; a busy one never is', () => {
  const dir = mkTmp('wk-s12-');
  const busyOld = sess('running', 1);
  const list = [busyOld];
  for (let i = 0; i < 41; i++) list.push(sess('done', 100 + i));
  const kept = CS.saveChatSessions(dir, list, 5000);
  assert.equal(kept.length, 40);
  assert.ok(kept.some(s => s.id === busyOld.id), 'the busy, oldest session stays');
  assert.equal(fs.existsSync(archived(dir, busyOld.id)), false);
  const gone = list.filter(s => !kept.some(k => k.id === s.id));
  assert.equal(gone.length, 2);
  assert.deepEqual(gone.map(s => s.updatedAt).sort((x, y) => x - y), [100, 101], 'the two oldest idle ones');
  for (const s of gone) assert.equal(JSON.parse(fs.readFileSync(archived(dir, s.id), 'utf8')).archiveReason, 'overflow');
  assert.equal(CS.loadChatSessions(dir).length, 40);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('N2: a reopen that cannot save the list leaves the session in Archived only; a good reopen moves it to the list only', { skip: process.getuid && process.getuid() === 0 ? 'root ignores folder permissions' : false }, () => {
  const dir = mkTmp('wk-n2-');
  const a = sess('done', 1000), b = sess('done', 2000);
  CS.saveChatSessions(dir, [a, b], 3000);
  CS.archiveChatSession(dir, a.id, 'done', 4000);
  fs.chmodSync(dir, 0o500);               // the list cannot be written; the archive folder still can
  try {
    assert.throws(() => CS.reopenChatSession(dir, a.id, 5000));
  } finally { fs.chmodSync(dir, 0o700); }
  assert.equal(fs.existsSync(archived(dir, a.id)), true, 'still in Archived');
  assert.deepEqual(CS.loadChatSessions(dir).map(s => s.id), [b.id], 'not in the list');
  assert.equal(CS.listArchivedChatSessions(dir).filter(s => s.id === a.id).length, 1);
  const back = CS.reopenChatSession(dir, a.id, 6000);
  assert.equal(back.id, a.id);
  assert.equal(fs.existsSync(archived(dir, a.id)), false, 'gone from Archived');
  assert.equal(CS.listArchivedChatSessions(dir).filter(s => s.id === a.id).length, 0);
  assert.deepEqual(CS.loadChatSessions(dir).map(s => s.id), [a.id, b.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- M3: the Gemini usage part says only what the code backs ----
test('M3: the Gemini part: honest hint, "Nothing counted yet.", no "Ready", no weekly %, cooldown reason escaped and cut; a real 7-day count', () => {
  const R = require('../src/render');
  const D = require('../src/data');
  const now = Date.UTC(2026, 10, 24, 12);
  const none = R.renderUsage({ now, geminiUsage: { tracked: false, weekTasks: null } });
  assert.match(none, /Watchkeeper's own count on this Mac, not Google's figure\./);
  assert.match(none, /Nothing counted yet\./);
  assert.doesNotMatch(none, /Ready/);
  assert.doesNotMatch(none, /Last 7 days/);
  const reason = '<img src=x onerror=alert(1)>' + 'z'.repeat(100);
  const busy = R.renderUsage({ now, geminiUsage: { tracked: true, today: { requests: 3, spendUsd: 0.5 }, cooldownUntil: now + 3600e3, cooldownReason: reason, weekTasks: 2 } });
  assert.doesNotMatch(busy, /<img/);
  assert.doesNotMatch(busy, /Nothing counted yet|Ready/);
  const shown = /Cooldown until [^(]*\((.*?)\)<\/span>/.exec(busy)[1];
  assert.ok(shown.endsWith('…') && shown.replace(/&[a-z#0-9]+;/g, 'x').length <= 60, 'cut to about 60 characters');
  const gem = busy.slice(busy.lastIndexOf('usage-block'));
  assert.match(gem, /Last 7 days.*2 tasks queued for Antigravity/);
  assert.doesNotMatch(gem, /\d+\s*%/, 'no weekly percent for Gemini');
  // countWeekTasks: only tasks created in the last 7 days, read from meta.json
  const dir = mkTmp('wk-m3-');
  const mk = (id, at) => { fs.mkdirSync(path.join(dir, 'tasks', id), { recursive: true }); fs.writeFileSync(path.join(dir, 'tasks', id, 'meta.json'), JSON.stringify({ id, created_at: Number.isFinite(at) ? new Date(at).toISOString() : 'not a date' })); };
  mk('20261124-110000-new', now - 3600e3);
  mk('20261120-110000-mid', now - 4 * 86400e3);
  mk('20261110-110000-old', now - 14 * 86400e3);
  mk('20261123-110000-bad', NaN);
  assert.equal(D.countWeekTasks(dir, now), 2);
  assert.equal(D.countWeekTasks(path.join(dir, 'none'), now), null, 'no queue: no weekly line');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- S8: the percent reader ----
test('S8: the meter fraction reads unambiguously: 0, 0.09, 1, 1.2 (over the limit, not capped)', () => {
  const D = require('../src/data');
  const R = require('../src/render');
  const dir = mkTmp('wk-s8-');
  const now = Date.UTC(2026, 10, 24, 12), resetsAt = Math.floor(now / 1000) + 3600;
  fs.mkdirSync(path.join(dir, 'steward'), { recursive: true });
  const expect = { 0: [0, false], 0.09: [9, false], 1: [100, false], 1.2: [120, true] };
  for (const [u, [pct, over]] of Object.entries(expect)) {
    fs.writeFileSync(path.join(dir, 'steward', 'meter.json'), JSON.stringify({ fetchedAt: new Date(now).toISOString(), windows: { seven_day: { utilization: Number(u), resetsAt } } }));
    const w = D.readUsageWindows(dir, now).windows.seven_day;
    assert.equal(w.pct, pct, `utilization ${u}`);
    assert.equal(w.over, over, `utilization ${u} over`);
    const html = R.renderUsage({ now, usage: { found: true, windows: { seven_day: w } } });
    if (over) assert.match(html, /120%.*over the limit/); else assert.doesNotMatch(html, /over the limit/);
    const meter = /<meter[^>]*value="(\d+)"/.exec(html);
    assert.ok(meter && Number(meter[1]) <= 100, 'the meter stays inside its box');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- S7: the account cache ----
test('S7: the account answer is kept 10 minutes when ok, 30 seconds otherwise; clearAccountCache (Refresh) empties it', async () => {
  const D = require('../src/data');
  const home = fs.realpathSync(mkTmp('wk-s7-'));
  const count = path.join(home, 'runs'), mode = path.join(home, 'mode');
  const bin = path.join(home, 'claude-stub');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${count}"\nif [ "$(cat "${mode}")" = ok ]; then echo '{"loggedIn":true,"email":"someone@example.test"}'; else echo '{"loggedIn":false}'; fi\n`, { mode: 0o755 });
  const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const t0 = 1_800_000_000_000;
  D.clearAccountCache();
  fs.writeFileSync(mode, 'ok');
  assert.equal((await D.readClaudeAccount({ bin, env, now: t0 })).state, 'ok');
  await D.readClaudeAccount({ bin, env, now: t0 + 9 * 60e3 });
  assert.equal(runs(), 1, 'ok is kept for 10 minutes');
  await D.readClaudeAccount({ bin, env, now: t0 + 10 * 60e3 + 1 });
  assert.equal(runs(), 2, 'and read again after');
  D.clearAccountCache();
  fs.writeFileSync(mode, 'out');
  assert.equal((await D.readClaudeAccount({ bin, env, now: t0 })).state, 'signed-out');
  await D.readClaudeAccount({ bin, env, now: t0 + 29e3 });
  assert.equal(runs(), 3, 'signed out is kept for 30 seconds');
  await D.readClaudeAccount({ bin, env, now: t0 + 31e3 });
  assert.equal(runs(), 4, 'and read again after');
  D.clearAccountCache();
  await D.readClaudeAccount({ bin, env, now: t0 + 32e3 });
  assert.equal(runs(), 5, 'Refresh (clearAccountCache) reads again at once');
  assert.equal((await D.readClaudeAccount({ bin, env, killOn: true })).state, 'stopped');
  assert.equal(runs(), 5, 'nothing runs while Stop is on');
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(ext, /m\.cmd === 'refresh'[^\n]*clearAccountCache\(\)/, 'the Refresh button clears the cache');
  D.clearAccountCache();
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- S5: automatic archiving writes only when the folder is trusted, the plugin is there and Stop is off ----
test('S5: mayWrite needs trust, the plugin and Stop off; refresh archives only through it; Stop on archives nothing', async t => {
  const Module = require('module');
  const home = fs.realpathSync(mkTmp('wk-s5-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const cfg = { pluginPath: path.join(home, 'plugin'), dataDir: path.join(home, 'wk'), claudeDir: path.join(home, 'claude'), orchestrationDir: path.join(home, 'orch') };
  const registered = {};
  const fakeVscode = {
    Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: k => cfg[k] }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; }, showWarningMessage: async () => undefined },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
  t.after(() => {
    Module._load = load;
    for (const p of Object.values(registered)) if (p && p.stop) p.stop();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const ext = require('../extension.js');
  ext.activate({ extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] });
  const p = registered['watchkeeper.panel'];
  const ok = { pluginOk: true, kill: { on: false } };
  assert.equal(p.mayWrite(ok), true);
  assert.equal(p.mayWrite({ ...ok, pluginOk: false }), false, 'no plugin');
  assert.equal(p.mayWrite({ ...ok, kill: { on: true } }), false, 'Stop on');
  assert.equal(p.mayWrite(null), false);
  fakeVscode.workspace.isTrusted = false;
  assert.equal(p.mayWrite(ok), false, 'untrusted folder');
  fakeVscode.workspace.isTrusted = true;
  // the only call to autoArchive sits behind mayWrite
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const calls = src.split('\n').filter(l => /\.autoArchive\(/.test(l));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /this\.mayWrite\(model\) && this\.autoArchive\(/);
  // and autoArchive itself does nothing while the KILL file is there
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const s = sess('done', 1000);
  s.taskId = '20261124-010000-x';
  CS.saveChatSessions(cfg.dataDir, [s], 2000);
  fs.writeFileSync(path.join(cfg.dataDir, 'KILL'), 'on');
  assert.deepEqual(p.autoArchive({ dataDir: cfg.dataDir }, 3000), []);
  assert.deepEqual(CS.loadChatSessions(cfg.dataDir).map(x => x.id), [s.id]);
  fs.rmSync(path.join(cfg.dataDir, 'KILL'));
  assert.deepEqual(p.autoArchive({ dataDir: cfg.dataDir }, 3000), [s.id], 'with Stop off the finished task session is archived');
});
