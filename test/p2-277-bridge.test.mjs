// P2-277: Bridge (bin/wk-bridge.mjs): the wait, crossings, claims, holds, open, and the move of the old phone-link agent.
// Everything runs in a temporary HOME and WK_HOME; launchctl, open and pbcopy are stubs; agy, claude, gemini and
// antigravity on PATH are fakes that only write a marker. The agent markers must never appear.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../bin/antigravity-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(root, 'bin', 'wk-bridge.mjs');
const AGENTS = ['agy', 'claude', 'gemini', 'antigravity', 'Antigravity'];

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2-277-')));
  const s = { base, home: path.join(base, 'home'), wk: path.join(base, 'home', '.wk'), bin: path.join(base, 'fakebin'), marks: path.join(base, 'marks') };
  for (const d of [s.home, s.wk, s.bin, s.marks]) fs.mkdirSync(d, { recursive: true });
  for (const name of [...AGENTS, 'launchctl', 'open', 'pbcopy', 'osascript']) {
    const f = path.join(s.bin, name);
    const stdin = name === 'pbcopy' ? `cat > '${path.join(s.marks, 'clipboard')}'\n` : '';
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(s.marks, name)}'\n${stdin}exit 0\n`, { mode: 0o755 });
  }
  s.env = (extra = {}) => ({ PATH: `${s.bin}:/usr/bin:/bin`, HOME: s.home, WK_HOME: s.wk, TMPDIR: os.tmpdir(),
    WK_LAUNCH_AGENTS: path.join(s.home, 'Library', 'LaunchAgents'), WK_LAUNCHCTL: path.join(s.bin, 'launchctl'), WK_LAUNCHCTL_PAUSE_MS: '0',
    WK_OSASCRIPT: path.join(s.bin, 'osascript'), WK_BRIDGE_SAFETY_MS: '100', ...extra });
  s.mark = name => { try { return fs.readFileSync(path.join(s.marks, name), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  s.noAgents = () => { for (const a of AGENTS) assert.deepEqual(s.mark(a), [], `${a} must never be started`); };
  s.run = (args, extra = {}) => spawnSync(process.execPath, [BRIDGE, ...args], { env: s.env(extra), encoding: 'utf8', timeout: 60000 });
  s.task = (id, meta = {}) => {
    const d = path.join(s.wk, 'tasks', id); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, status: 'queued', title: `title of ${id}`, repo: s.base, from: 'claude', ...meta }));
    return d;
  };
  s.handoffs = ws => fs.writeFileSync(path.join(s.wk, 'shared-workspace.json'), JSON.stringify({ workspaces: ws }));
  return s;
}
// Runs the module's functions inside the sandbox (WK_HOME is read on each call).
function inSandbox(s, body) {
  const code = `import * as b from ${JSON.stringify(BRIDGE)};\nconst r = await (async () => { ${body} })();\nprocess.stdout.write(JSON.stringify(r ?? null));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function waitAsync(s, args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BRIDGE, 'wait', ...args], { env: s.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
const delay = ms => new Promise(r => setTimeout(r, ms));
const handoffTo = (s, engine, title = 'finish the parser') => ({ [s.base]: { workspace: s.base, from_engine: engine === 'claude' ? 'antigravity' : 'claude', to_engine: engine, title, updated_at: '2026-11-24T20:00:00Z' } });

// ---------------------------------------------------------------- wait
test('wait --for claude exits 0 with one JSON line when a handoff arrives, and claims it', async () => {
  const s = sandbox();
  const pending = waitAsync(s, ['--for', 'claude', '--max', '1']);
  await delay(400);
  s.handoffs(handoffTo(s, 'claude'));
  const r = await pending;
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out.trim());
  assert.deepEqual(Object.keys(j).sort(), ['id', 'kind', 'repo', 'title']);
  assert.equal(j.kind, 'handoff'); assert.equal(j.repo, s.base); assert.equal(j.title, 'finish the parser');
  assert.equal(fs.readdirSync(path.join(s.wk, 'bridge', 'claims')).length, 1, 'the handoff is claimed');
  // A second wait does not take the same (claimed) handoff.
  const again = s.run(['wait', '--for', 'claude', '--max', '0.005']);
  assert.equal(again.status, 1, again.stderr);
  assert.equal(fs.existsSync(path.join(s.wk, 'bridge', 'wait-claude.pid')), false, 'the pid file is removed on exit');
  s.noAgents();
});

test('wait ends with 2 under the kill switch and when Bridge is off; 1 when nothing comes within --max', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.wk, 'KILL'), '');
  assert.equal(s.run(['wait', '--for', 'claude', '--max', '1']).status, 2);
  fs.unlinkSync(path.join(s.wk, 'KILL'));
  assert.equal(s.run(['off']).status, 0);
  const off = s.run(['wait', '--for', 'gemini', '--max', '1']);
  assert.equal(off.status, 2); assert.match(off.stderr, /Bridge is off/);
  assert.equal(s.run(['on']).status, 0);
  const t0 = Date.now();
  const none = s.run(['wait', '--for', 'claude', '--max', '0.01']);
  assert.equal(none.status, 1, none.stderr);
  assert.ok(Date.now() - t0 < 20000);
  assert.equal(s.run(['wait', '--for', 'nobody']).status, 2, 'bad side is a usage error');
  s.noAgents();
});

test('a held task is not waiting for Gemini; an expired hold counts as released', () => {
  const s = sandbox();
  const id = '20261124-200000-held', other = '20261124-200100-free';
  const d = s.task(id); s.task(other, { status: 'taken' });
  fs.writeFileSync(path.join(d, 'hold'), JSON.stringify({ at: new Date().toISOString(), until: null, note: 'mine' }));
  let st = JSON.parse(s.run(['status', '--json']).stdout);
  assert.deepEqual(st.waiting.gemini, []);
  assert.equal(st.held.length, 1);
  fs.writeFileSync(path.join(d, 'hold'), JSON.stringify({ at: '2026-11-01T00:00:00Z', until: '2026-11-01T01:00:00Z', note: '' }));
  st = JSON.parse(s.run(['status', '--json']).stdout);
  assert.deepEqual(st.waiting.gemini.map(x => x.id), [id]);
  const w = s.run(['wait', '--for', 'gemini', '--max', '0.01']);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(JSON.parse(w.stdout.trim()).id, id);
  s.noAgents();
});

// ---------------------------------------------------------------- crossings
test('crossings: private file, trimmed to 2,000 lines, inbox marker written', () => {
  const s = sandbox();
  const r = inSandbox(s, `
    for (let i = 0; i < 2010; i++) b.recordCrossing({ kind: 'task', id: 'T' + i, from: 'claude', to: 'gemini', event: 'queued', title: 'x\\ny' });
    return b.readCrossings(3);`);
  const f = path.join(s.wk, 'bridge', 'crossings.jsonl');
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2000);
  assert.equal(JSON.parse(lines[0]).id, 'T10', 'the oldest lines go');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(path.join(s.wk, 'bridge', 'inbox')).length >= 1, 'a marker wakes the agent');
  assert.equal(r.length, 3); assert.equal(r[r.length - 1].id, 'T2009');
  for (const x of r) { assert.deepEqual(Object.keys(x).sort(), ['at', 'event', 'from', 'id', 'kind', 'title', 'to']); assert.ok(!/\n/.test(x.title)); }
  const shown = s.run(['crossings']);
  assert.equal(shown.status, 0); assert.match(shown.stdout, /claude -> gemini {2}queued/);
});

// ---------------------------------------------------------------- claims
test('claims are exclusive and a claim older than 15 minutes may be taken again', () => {
  const s = sandbox();
  const r = inSandbox(s, `
    const now = Date.now();
    const first = b.claimHandoff('ws@1', 'tab-a', now);
    const second = b.claimHandoff('ws@1', 'tab-b', now + 60000);
    const fresh = b.claimedFresh('ws@1', now + 60000);
    const late = b.claimHandoff('ws@1', 'tab-c', now + b.CLAIM_TTL_MS + 1000);
    return { first, second, fresh, late, name: b.claimName('ws@1') };`);
  assert.deepEqual([r.first, r.second, r.fresh], [true, false, true]);
  assert.equal(r.name.length, 32);
  const f = path.join(s.wk, 'bridge', 'claims', r.name);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(r.late, true, 'a claim older than 15 minutes is stale and is taken again');
  assert.match(fs.readFileSync(f, 'utf8'), /tab-c/);
});

// ---------------------------------------------------------------- open
test('open --handoff for Claude only prints the line; open --task opens Antigravity and copies the command, nothing more', () => {
  const s = sandbox();
  s.handoffs(handoffTo(s, 'claude'));
  const c = s.run(['open', '--handoff', s.base]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stdout.trim(), `cd '${s.base}' && claude '/wk-take-task --handoff --cwd "${s.base}"'`, 'the click takes the handoff as a handoff');
  assert.ok(!c.stdout.includes('--claim'));
  assert.deepEqual(s.mark('open'), []);
  const id = '20261124-200500-open';
  s.task(id);
  const g = s.run(['open', '--task', id, '--json']);
  assert.equal(g.status, 0, g.stderr);
  const j = JSON.parse(g.stdout);
  assert.equal(j.opened, true); assert.equal(j.copied, true);
  assert.deepEqual(s.mark('open'), [`-a Antigravity ${s.base}`]);
  assert.equal(fs.readFileSync(path.join(s.marks, 'clipboard'), 'utf8'), '/wk-take-task');
  assert.equal(s.run(['open', '--task', '../etc']).status, 2, 'a bad id opens nothing');
  fs.writeFileSync(path.join(s.wk, 'KILL'), '');
  assert.equal(s.run(['open', '--task', id]).status, 2, 'the kill switch opens nothing');
  assert.equal(s.mark('open').length, 1);
  s.noAgents();
});

// ---------------------------------------------------------------- the old phone-link agent
const REMOTE = path.join(root, 'bin', 'wk-remote.mjs');
const plistOf = args => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>org.nexodyne.wk-bridge</string>`
  + `<key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array></dict></plist>\n`;
function inRemote(s, body) {
  const code = `import * as r from ${JSON.stringify(REMOTE)};\nconst out = [];\nconst v = await (async () => { ${body} })();\nprocess.stdout.write(JSON.stringify({ v: v ?? null, out }));`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env(), encoding: 'utf8', timeout: 60000 });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}
test('wk-bridge run (the old LaunchAgent waking) prints one line, exit 2, and touches nothing; wk-remote install moves the old agent', () => {
  const s = sandbox();
  const la = path.join(s.home, 'Library', 'LaunchAgents'); fs.mkdirSync(la, { recursive: true });
  const old = path.join(la, 'org.nexodyne.wk-bridge.plist');
  fs.writeFileSync(old, plistOf(['/usr/local/bin/node', '/x/watchkeeper/bin/wk-bridge.mjs', 'run']));
  const r = s.run(['run']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1, 'exactly one line (review should-fix 8)');
  assert.match(r.stderr, /phone control moved to wk-remote\. Run: wk-remote run/);
  assert.equal(fs.existsSync(old), true, 'the shim moves nothing; wk-remote install does');
  assert.deepEqual(s.mark('launchctl'), []);
  const m = inRemote(s, `return r.migrateOldAgent(l => out.push(l));`);
  assert.equal(m.v.migrated, true);
  assert.equal(fs.existsSync(old), false, 'the old plist is moved');
  assert.equal(fs.readdirSync(path.join(s.wk, 'backups')).filter(n => n.includes('org.nexodyne.wk-bridge')).length, 1);
  assert.ok(s.mark('launchctl').some(l => /^bootout .*org\.nexodyne\.wk-bridge$/.test(l)), s.mark('launchctl').join('|'));
  s.noAgents();
});
test('the old agent is recognised by its ProgramArguments (…/bin/wk-bridge.mjs then run), not by a mention of the name', () => {
  const s = sandbox();
  const r = inRemote(s, `return [
    r.isOldPhoneAgent(${JSON.stringify(plistOf(['/usr/local/bin/node', '/Users/x/watchkeeper/bin/wk-bridge.mjs', 'run']))}),
    r.isOldPhoneAgent(${JSON.stringify(plistOf(['node', 'bin/wk-bridge.mjs', 'run']))}),
    r.isOldPhoneAgent(${JSON.stringify(plistOf(['/usr/local/bin/node', '/Users/x/watchkeeper/bin/wk-bridge.mjs', 'wait', '--for', 'claude']))}),
    r.isOldPhoneAgent(${JSON.stringify(plistOf(['/bin/sh', '-c', 'echo wk-bridge.mjs run']))}),
    r.isOldPhoneAgent(${JSON.stringify(plistOf(['/usr/local/bin/node', '/x/bin/not-wk-bridge.mjs', 'run']))}),
    r.isOldPhoneAgent('<plist><string>/x/bin/wk-bridge.mjs</string><string>run</string></plist>'),
    r.programArguments(${JSON.stringify(plistOf(['/a &amp; b/bin/wk-bridge.mjs', 'run']))})];`);
  assert.deepEqual(r.v.slice(0, 6), [true, true, false, false, false, false]);
  assert.deepEqual(r.v[6], ['/a & b/bin/wk-bridge.mjs', 'run']);
  // A plist that only mentions the name is left alone by the migration.
  const la = path.join(s.home, 'Library', 'LaunchAgents'); fs.mkdirSync(la, { recursive: true });
  const old = path.join(la, 'org.nexodyne.wk-bridge.plist');
  fs.writeFileSync(old, plistOf(['/bin/sh', '-c', 'echo wk-bridge.mjs run']));
  assert.equal(inRemote(s, `return r.migrateOldAgent();`).v.migrated, false);
  assert.equal(fs.existsSync(old), true);
  assert.deepEqual(s.mark('launchctl'), []);
});
test('the wk-remote plist is written to a tmp file with mode 0644 and renamed into place (review must-fix 5)', () => {
  const s = sandbox();
  const src = fs.readFileSync(REMOTE, 'utf8');
  assert.ok(!/writeFileSync\(\s*(f|plistFile\(\))\s*,/.test(src), 'no direct writeFileSync of the plist');
  const f = path.join(s.home, 'Library', 'LaunchAgents', 'org.nexodyne.wk-remote.plist');
  inRemote(s, `r.writePlist(${JSON.stringify(f)}, '<plist>one</plist>\\n'); r.writePlist(${JSON.stringify(f)}, '<plist>two</plist>\\n');`);
  assert.equal(fs.readFileSync(f, 'utf8'), '<plist>two</plist>\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(n => n.includes('.tmp-')), [], 'no tmp file left');
  // A tmp name that is already taken (O_EXCL) fails cleanly and leaves the old plist whole.
  const pid = inRemote(s, `return process.pid;`);
  assert.ok(Number.isInteger(pid.v));
});

// ---------------------------------------------------------------- review fixes: race, hold, prune, handoff mode
test('racing claimers on a stale claim: exactly one wins, every round (steal lock)', async () => {
  const s = sandbox();
  const name = inSandbox(s, `return b.claimName('ws@race');`);
  const dir = path.join(s.wk, 'bridge', 'claims'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  const one = (start, tag) => new Promise(resolve => {
    const code = `import * as b from ${JSON.stringify(BRIDGE)};\nwhile (Date.now() < ${start}) {}\nprocess.stdout.write(b.claimHandoff('ws@race', '${tag}') ? 'won' : 'lost');`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: s.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => { out += d; });
    p.on('close', () => resolve(out));
  });
  for (let round = 0; round < 12; round++) {
    fs.writeFileSync(f, JSON.stringify({ id: 'ws@race', by: 'old' }) + '\n', { mode: 0o600 });
    const old = (Date.now() - 16 * 60 * 1000) / 1000; fs.utimesSync(f, old, old);
    const start = Date.now() + 400;
    const got = await Promise.all([one(start, 'a'), one(start, 'b'), one(start, 'c'), one(start, 'd')]);
    assert.equal(got.filter(x => x === 'won').length, 1, `round ${round}: ${got.join(',')}`);
    assert.equal(got.filter(x => x === 'lost').length, 3);
    const by = JSON.parse(fs.readFileSync(f, 'utf8')).by;
    assert.notEqual(by, 'old');
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.steal')), [], 'no steal lock left');
  }
});
test('held: a held task shows in watch.json held whatever its state; an expired hold does not', () => {
  const s = sandbox();
  const ids = ['20261124-210000-q', '20261124-210100-t', '20261124-210200-d', '20261124-210300-x'];
  s.task(ids[0]); s.task(ids[1], { status: 'taken' }); s.task(ids[2], { status: 'done' }); s.task(ids[3], { status: 'taken' });
  for (const id of ids.slice(0, 3)) fs.writeFileSync(path.join(s.wk, 'tasks', id, 'hold'), JSON.stringify({ at: new Date().toISOString() }));
  fs.writeFileSync(path.join(s.wk, 'tasks', ids[3], 'hold'), JSON.stringify({ at: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' }));
  const r = inSandbox(s, `return { held: b.heldTasks().sort(), status: b.status().held.sort() };`);
  assert.deepEqual(r.held, ids.slice(0, 3));
  assert.deepEqual(r.status, ids.slice(0, 3));
  const w = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-watch.mjs'), 'check', '--json'], { env: s.env(), encoding: 'utf8', timeout: 60000 });
  assert.equal(w.status, 0, w.stderr);
  const watch = JSON.parse(fs.readFileSync(path.join(s.wk, 'watch.json'), 'utf8'));
  assert.deepEqual([...watch.held].sort(), ids.slice(0, 3), 'the taken and done held tasks show too (review must-fix 4)');
  assert.deepEqual(watch.bridge.routes.claude_wait, { alive: false, pid: null });
  s.noAgents();
});
test('pruneBridge: claims older than a day and chain files with no stamp inside the hour go; fresh ones stay', () => {
  const s = sandbox();
  const claims = path.join(s.wk, 'bridge', 'claims'), chains = path.join(s.wk, 'bridge', 'chains');
  fs.mkdirSync(claims, { recursive: true }); fs.mkdirSync(chains, { recursive: true });
  const now = Date.now(), sec = now / 1000;
  for (const [n, ageH] of [['old', 25], ['x.steal', 2], ['new', 1]]) { const f = path.join(claims, n); fs.writeFileSync(f, '{}'); fs.utimesSync(f, sec - ageH * 3600, sec - ageH * 3600); }
  fs.writeFileSync(path.join(chains, 'gone.json'), JSON.stringify({ at: [sec - 7200] }));
  fs.writeFileSync(path.join(chains, 'live.json'), JSON.stringify({ at: [sec - 7200, sec - 60] }));
  const lock = path.join(chains, 'orphan.json.lock'); fs.writeFileSync(lock, ''); fs.utimesSync(lock, sec - 7200, sec - 7200);
  const r = inSandbox(s, `return b.pruneBridge(${now});`);
  assert.deepEqual(fs.readdirSync(claims).sort(), ['new']);
  assert.deepEqual(fs.readdirSync(chains).sort(), ['live.json']);
  assert.equal(r.claims, 2); assert.ok(r.chains >= 1);
});
test('take-task --handoff takes the handoff, never the queued task; a second run exits 5', () => {
  const s = sandbox();
  s.task('20261124-210500-queued', { title: 'a queued task for Claude', to: 'claude', from: 'antigravity' });
  s.handoffs(handoffTo(s, 'claude', 'the handoff itself'));
  const wk = path.join(root, 'bin', 'wk.mjs');
  const a = spawnSync(process.execPath, [wk, 'take-task', '--handoff', '--cwd', s.base, '--json'], { env: s.env(), encoding: 'utf8', timeout: 60000, cwd: s.base });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /the handoff itself/);
  assert.doesNotMatch(a.stdout, /a queued task for Claude/);
  const meta = JSON.parse(fs.readFileSync(path.join(s.wk, 'tasks', '20261124-210500-queued', 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'queued', 'the queued task is not taken');
  const b2 = spawnSync(process.execPath, [wk, 'take-task', '--handoff', '--cwd', s.base], { env: s.env(), encoding: 'utf8', timeout: 60000, cwd: s.base });
  assert.equal(b2.status, 5, b2.stdout + b2.stderr);
  s.noAgents();
});

test('the Antigravity bundle ships wk-bridge and wk-remote', () => {
  assert.deepEqual(TOOLS['wk-bridge'], ['node', 'bin/wk-bridge.mjs']);
  assert.deepEqual(TOOLS['wk-remote'], ['node', 'bin/wk-remote.mjs']);
});

test('nothing in the Antigravity plugin asks its agent to continue', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const hits = walk(path.join(root, 'antigravity')).filter(f => /"decision"\s*:\s*"continue"/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});
