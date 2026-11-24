'use strict';
// Data layer tests for the W panel (P2-205). Every fixture lives in a temp folder; nothing touches ~/.wk or ~/.claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data');
const R = require('../src/render');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wk-panel-'));
const write = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); return p; };
const NOW = Date.parse('2026-11-11T08:00:00Z');

function stubPlugin(body) {
  const dir = tmp();
  write(path.join(dir, 'bin', 'wk-ledger.mjs'), body);
  return dir;
}

test('pace adapter: ok reading', async () => {
  const j = { decision: 'slow', reason: 'ahead', code: 0, used: 0.33, elapsed: 0.313, target: 0.313, behindPoints: -1.7, limit: 0.8, reservePoints: 20,
    reserveHeld: true, reserveReleaseAt: '2026-11-15T02:00:00.000Z', hoursLeft: 115.5, resetsAt: '2026-11-16T02:00:00.000Z', meterAgeMin: 13.2, secretish: 'x' };
  const r = await D.readPace(stubPlugin(`console.log(${JSON.stringify(JSON.stringify(j))}); process.exit(0);`), tmp());
  assert.equal(r.state, 'ok');
  assert.equal(r.pace.used, 0.33);
  assert.equal(r.pace.behindPoints, -1.7);
  assert.equal('secretish' in r.pace, false, 'only the known fields are kept');
  assert.equal(R.paceSentence(r.pace, NOW).split('.')[0], '2 points ahead of the line; slowing down');
  assert.match(R.paceSentence(r.pace, NOW), /Reset \w{3} 16 Nov \d\d:\d\d, in 115 hours\.$/);
});

test('pace adapter: exit 3 (no meter) and hold with numbers', async () => {
  const none = await D.readPace(stubPlugin(`console.log(JSON.stringify({decision:'hold',reason:'meter',detail:'no meter reading',reprobe:true,code:3})); process.exit(3);`), tmp());
  assert.equal(none.state, 'no-meter');
  assert.equal(none.code, 3);
  const bare = await D.readPace(stubPlugin(`process.exit(3);`), tmp());
  assert.equal(bare.state, 'no-meter');
  const hold = await D.readPace(stubPlugin(`console.log(JSON.stringify({decision:'hold',reason:'ceiling',code:3,used:0.81,elapsed:0.5,behindPoints:-31})); process.exit(3);`), tmp());
  assert.equal(hold.state, 'ok');
  assert.equal(hold.pace.decision, 'hold');
  const html = R.renderPace({ pace: none, now: NOW, paths: { home: '/h' } });
  assert.match(html, /No meter reading yet/);
});

test('pace adapter: no plugin, and a crashing script', async () => {
  const r = await D.readPace(path.join(tmp(), 'nothing-here'), tmp());
  assert.equal(r.state, 'no-plugin');
  const bad = await D.readPace(stubPlugin(`console.error('boom: broken'); process.exit(1);`), tmp());
  assert.equal(bad.state, 'error');
  assert.match(bad.detail, /boom/);
});

test('pace adapter: the real plugin reads a temp meter and writes nothing', async t => {
  const plugin = path.join(__dirname, '..', '..');
  if (!fs.existsSync(path.join(plugin, 'bin', 'wk-ledger.mjs'))) return t.skip('plugin not beside the panel');
  const data = tmp();
  const meter = { fetchedAt: '2026-11-11T07:50:00.000Z', utilization: 0.33, resetsAt: Date.parse('2026-11-16T02:00:00Z') / 1000, status: 'allowed', fiveHour: null, source: 'event' };
  write(path.join(data, 'steward', 'meter.json'), JSON.stringify(meter));
  const before = fs.readdirSync(path.join(data, 'steward'));
  process.env.WK_NOW = '2026-11-11T08:00:00Z';
  try {
    const r = await D.readPace(plugin, data);
    assert.equal(r.state, 'ok', JSON.stringify(r));
    assert.equal(r.pace.used, 0.33);
    assert.ok(r.pace.meterAgeMin >= 9.9 && r.pace.meterAgeMin <= 10.1);
  } finally { delete process.env.WK_NOW; }
  assert.deepEqual(fs.readdirSync(path.join(data, 'steward')), before);
  const empty = await D.readPace(plugin, tmp());
  assert.equal(empty.state, 'no-meter');
});

test('ledger totals, top items, wake-ups and bad lines', () => {
  const dir = tmp(), f = path.join(dir, 'ledger.jsonl');
  const row = (o) => JSON.stringify({ model: 'claude-sonnet-5-5', turns: 3, in: 10, cache_read: 1000, out: 50, error: false, ...o });
  write(f, [
    row({ at: '2026-11-11T05:40:00Z', item: 'T-178-wake-1', cost_usd: 0.2, lens: 'quality' }),
    row({ at: '2026-11-10T05:40:00Z', item: 'T-178-wake-2', cost_usd: 0.1, cache_write: 400 }),
    row({ at: '2026-11-09T05:40:00Z', item: 'T-10', cost_usd: 1.5 }),
    row({ at: '2026-10-01T05:40:00Z', item: 'old', cost_usd: 99 }),
    '{not json', '[1,2]', JSON.stringify({ item: 'no time', cost_usd: 1 }), '',
  ].join('\n') + '\n');
  const l = D.readLedger(f, NOW);
  assert.equal(l.missing, false);
  assert.equal(l.totals.runs, 3);
  assert.equal(Math.round(l.totals.usd * 100), 180);
  assert.equal(l.totals.in, 30);
  assert.equal(l.totals.cache_read, 3000);
  assert.equal(l.totals.cache_write, 400);
  assert.equal(l.totals.out, 150);
  assert.equal(l.bad, 3);
  assert.equal(l.top[0].item, 'T-10');
  assert.deepEqual(l.wakeups.map(w => w.item), ['T-178-wake-1', 'T-178-wake-2']);
  assert.equal(l.wakeups[0].lens, 'quality');
  assert.equal(D.readLedger(path.join(dir, 'missing.jsonl'), NOW).missing, true);
  const html = R.renderSpend({ ledger: l, now: NOW, paths: { home: '/h', dataDir: dir } });
  assert.match(html, /US\$1\.80/);
  assert.match(html, /3 lines could not be read/);
});

test('transcript head/tail: a 5 MB file is read in under 100 ms and never whole', () => {
  const dir = tmp(), f = path.join(dir, 'big.jsonl');
  const head = [
    JSON.stringify({ type: 'session-owner', accountUuid: 'secret-ish' }),
    JSON.stringify({ type: 'user', isMeta: true, cwd: '/Users/x/Projects/nexodyne', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'user', cwd: '/Users/x/Projects/nexodyne', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>Build the   W panel for the owner, with care and tests and a long tail of words that runs past eighty characters' }] } }),
  ].join('\n') + '\n';
  const filler = JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: 'x'.repeat(900) } }) + '\n';
  const fd = fs.openSync(f, 'w');
  fs.writeSync(fd, head);
  const chunk = filler.repeat(1000);
  while (fs.fstatSync(fd).size < 5 * 1024 * 1024) fs.writeSync(fd, chunk);
  fs.writeSync(fd, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: 'last' } }) + '\n');
  fs.closeSync(fd);
  const size = fs.statSync(f).size;
  assert.ok(size >= 5 * 1024 * 1024);
  const t0 = process.hrtime.bigint();
  const info = D.sessionInfo(f);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `took ${ms} ms`);
  assert.ok(info.bytesRead <= 2 * D.HEAD_TAIL, `read ${info.bytesRead} of ${size} bytes`);
  assert.equal(info.size, size);
  assert.equal(info.model, 'Opus 5.5');
  assert.equal(info.cwd, '/Users/x/Projects/nexodyne');
  assert.equal(info.title.length, 80);
  assert.ok(info.title.startsWith('Build the W panel for the owner'));
  assert.ok(!/ignore me|secret/.test(info.title));
});

test('session title prefers the summary line; sessions list orders active first', () => {
  const claude = tmp(), proj = path.join(claude, 'projects', '-Users-x-Projects-nexodyne');
  const a = write(path.join(proj, 'aaaa-1.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/Users/x/Projects/nexodyne', message: { role: 'user', content: 'first message' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'A neat summary' }),
  ].join('\n') + '\n');
  const b = write(path.join(proj, 'bbbb-2.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'quiet one' } }) + '\n');
  const old = write(path.join(proj, 'cccc-3.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'old' } }) + '\n');
  const now = Date.now();
  fs.utimesSync(a, new Date(now - 3 * 60e3), new Date(now - 3 * 60e3));
  fs.utimesSync(b, new Date(now - 2 * 3600e3), new Date(now - 2 * 3600e3));
  fs.utimesSync(old, new Date(now - 30 * 3600e3), new Date(now - 30 * 3600e3));
  write(path.join(proj, 'aaaa-1', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fresh review of the panel', model: 'fable', effort: 'high', finished: true }));
  const s = D.listSessions(claude, now);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions[0].title, 'A neat summary');
  assert.equal(s.sessions[0].active, true);
  assert.equal(s.sessions[0].project, 'nexodyne');
  assert.equal(s.sessions[1].title, 'quiet one');
  assert.equal(s.sessions[1].project, 'nexodyne', 'decoded from the folder name when no cwd');
  assert.equal(s.sessions[0].members[0].role, 'Reviewer');
  assert.equal(D.listSessions(path.join(claude, 'nope'), now).missing, true);
});

test('project names decode from folder names', () => {
  assert.equal(D.decodeProject('-Users-x-Projects-nexodyne', 'x'), 'nexodyne');
  assert.equal(D.decodeProject('-Users-samuelson', 'samuelson'), 'home folder');
  assert.equal(D.decodeProject('-Users-x-Library-Mobile-Documents-com-apple-CloudDocs-Antigravity-Projects', 'x'), 'Antigravity-Projects');
  assert.equal(D.decodeProject('-private-tmp-claude-502--Users-x-Projects-nexodyne-abc-scratchpad-probe', 'x'), 'scratchpad probe');
  assert.equal(D.decodeProject('-home-ann-code-shop', 'ann'), 'shop');
});

test('members from meta files: roles, states, bad files skipped', () => {
  const dir = tmp(), now = Date.now();
  write(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ description: 'Build the W panel extension', model: 'opus', effort: 'high', spawnDepth: 1 }));
  write(path.join(dir, 'agent-a1.jsonl'), '{}\n');
  write(path.join(dir, 'agent-a2.meta.json'), JSON.stringify({ description: 'Fresh review of README', model: 'fable', effort: 'high', finished: true }));
  const stale = write(path.join(dir, 'agent-a3.meta.json'), JSON.stringify({ description: 'Package 3', model: 'claude-sonnet-5-5' }));
  fs.utimesSync(stale, new Date(now - 3600e3), new Date(now - 3600e3));
  write(path.join(dir, 'agent-a4.meta.json'), '{broken');
  write(path.join(dir, 'notes.txt'), 'x');
  const m = D.readMembers(dir, now);
  assert.equal(m.length, 3);
  assert.deepEqual(m.map(x => [x.role, x.state, x.model]), [['Worker', 'running', 'Opus'], ['Worker', 'stopped', 'Sonnet 5.5'], ['Reviewer', 'done', 'Fable']]);
  assert.deepEqual(D.readMembers(path.join(dir, 'missing'), now), []);
});

test('locks: area, label and item ID', () => {
  const orch = tmp();
  write(path.join(orch, 'locks', 'site'), '74913|T-206 Shop packages|2026-11-11 10:35\n');
  write(path.join(orch, 'locks', 'other'), '32867|T-205 Panel|2026-11-11 10:30');
  write(path.join(orch, 'locks', '.keep'), '');
  write(path.join(orch, 'locks', 'odd'), 'no pipes here');
  const l = D.readLocks(orch);
  assert.equal(l.missing, false);
  assert.deepEqual(l.locks.map(x => [x.area, x.item]), [['odd', ''], ['other', 'T-205'], ['site', 'T-206']]);
  assert.equal(l.locks[2].since, '2026-11-11 10:35');
  assert.equal(D.readLocks(path.join(orch, 'none')).missing, true);
});

test('owner inbox: append with mode 600, last 10 newest first', () => {
  const dir = path.join(tmp(), 'wk');
  for (let i = 0; i < 12; i++) D.appendInbox(dir, i % 2 ? 'rule' : 'recommendation', `note ${i}`, new Date(NOW + i * 1000));
  const f = D.inboxFile(dir);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 12);
  assert.deepEqual(Object.keys(lines[0]), ['at', 'kind', 'text', 'status']);
  assert.equal(lines[0].status, 'new');
  const r = D.readInbox(dir);
  assert.equal(r.length, 10);
  assert.equal(r[0].text, 'note 11');
  assert.equal(r[0].kind, 'rule');
  fs.chmodSync(f, 0o644);
  D.appendInbox(dir, 'recommendation', 'again');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'a wider mode is tightened back');
  assert.throws(() => D.appendInbox(dir, 'other', 'x'));
  assert.throws(() => D.appendInbox(dir, 'rule', ' '));
  assert.throws(() => D.appendInbox(dir, 'rule', 'x'.repeat(4001)));
});

test('kill switch: path from policy, on and off', () => {
  const plugin = tmp(), home = tmp();
  assert.equal(D.killFilePath(plugin, home), path.join(home, '.wk', 'KILL'), 'default without a policy file');
  write(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: '~/stop/KILL' } }));
  const f = D.killFilePath(plugin, home);
  assert.equal(f, path.join(home, 'stop', 'KILL'));
  assert.equal(D.killState(f).on, false);
  assert.equal(D.setKill(f, true).on, true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(D.setKill(f, true).on, true, 'twice is fine');
  assert.equal(D.setKill(f, false).on, false);
  assert.equal(D.setKill(f, false).on, false, 'removing twice is fine');
  const real = path.join(__dirname, '..', '..', 'config', 'gates.json');
  if (fs.existsSync(real)) assert.equal(D.killFilePath(path.join(__dirname, '..', '..'), home), path.join(home, '.wk', 'KILL'));
});

test('kill switch: a policy path outside the home folder is refused; an existing file or link is not overwritten', () => {
  const plugin = tmp(), home = tmp(), outside = tmp();
  const def = path.join(home, '.wk', 'KILL');
  for (const bad of [path.join(outside, 'KILL'), '/etc/KILL', '~/../KILL', home, '~/', '../KILL']) {
    write(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: bad } }));
    assert.equal(D.killFilePath(plugin, home), def, `refused: ${bad}`);
  }
  write(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: '~/a/../b/KILL' } }));
  assert.equal(D.killFilePath(plugin, home), path.join(home, 'b', 'KILL'), 'a path that stays inside home is kept, normalized');
  const target = path.join(outside, 'precious.txt');
  fs.writeFileSync(target, 'keep me');
  fs.mkdirSync(path.dirname(def), { recursive: true });
  fs.symlinkSync(target, def);
  assert.equal(D.setKill(def, true).on, true, 'a link already there counts as on');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me', 'the link target is not written');
});

test('review fixes: five-hour words from the reading, stopped wording, lock dates', () => {
  const ok = pace => ({ pace: { state: 'ok', pace }, now: NOW, paths: { home: '/h' }, kill: { on: false } });
  const hold = R.status(ok({ decision: 'hold', reason: 'five_hour', fiveHour: 0.92, used: 0.4, elapsed: 0.4 }));
  assert.equal(hold.note, 'Pace says hold: the five-hour window is 92% used.');
  assert.ok(!/three quarters/.test(hold.note));
  assert.equal(R.status(ok({ decision: 'slow', reason: 'five_hour', fiveHour: 0.78 })).note, 'Pace says slow down: the five-hour window is 78% used.');
  assert.equal(R.status(ok({ decision: 'hold', reason: 'five_hour' })).note, 'Pace says hold: the five-hour window is nearly used up.');
  assert.equal(R.status(ok({ decision: 'hold', reason: 'ceiling' })).note, 'Pace says hold: the hold line is reached.');
  const none = { state: 'no-meter', detail: 'no meter reading' };
  assert.match(R.renderPace({ pace: none, now: NOW, paths: { home: '/h' }, kill: { on: false } }), /The next wake-up reads/);
  const stoppedNone = R.renderPace({ pace: none, now: NOW, paths: { home: '/h' }, kill: { on: true } });
  assert.match(stoppedNone, /wake-ups are stopped now, so none will until you allow them again/);
  assert.ok(!/The next wake-up reads/.test(stoppedNone));
  const old = { state: 'ok', pace: { decision: 'run', used: 0.3, elapsed: 0.3, meterAgeMin: 600 } };
  assert.match(R.renderPace({ pace: old, now: NOW, paths: { home: '/h' }, kill: { on: false } }), /10 hours old; the next wake-up reads a new one\./);
  assert.match(R.renderPace({ pace: old, now: NOW, paths: { home: '/h' }, kill: { on: true } }), /10 hours old; wake-ups are stopped now/);
  const today = new Date(NOW), y = new Date(NOW - 2 * 86400000);
  const local = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 09:05`;
  assert.equal(R.lockSince(local(today), NOW), 'today 09:05');
  assert.equal(R.lockSince(local(y), NOW), R.when(new Date(y.getFullYear(), y.getMonth(), y.getDate(), 9, 5).getTime(), NOW));
  assert.match(R.lockSince(local(y), NOW), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} 09:05$/);
  assert.equal(R.lockSince('not a date', NOW), 'not a date');
});

test('webview messages are validated', () => {
  assert.equal(D.validateMessage(null).ok, false);
  assert.equal(D.validateMessage({ cmd: 'rm -rf' }).ok, false);
  assert.equal(D.validateMessage({ cmd: 'send', kind: 'rule' }).ok, false);
  assert.equal(D.validateMessage({ cmd: 'send', kind: 'x', text: 'hi' }).ok, false);
  assert.equal(D.validateMessage({ cmd: 'send', kind: 'rule', text: '   ' }).ok, false);
  assert.equal(D.validateMessage({ cmd: 'send', kind: 'rule', text: 'x'.repeat(4001) }).ok, false);
  assert.deepEqual(D.validateMessage({ cmd: 'send', kind: 'rule', text: ' do X ', extra: 1 }), { ok: true, msg: { cmd: 'send', kind: 'rule', text: 'do X' } });
  assert.deepEqual(D.validateMessage({ cmd: 'kill', file: '/etc/passwd' }), { ok: true, msg: { cmd: 'kill' } });
});

test('a hostile title is escaped everywhere it is shown', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'`&';
  const m = {
    now: NOW, paths: { home: '/h', dataDir: '/h/.wk', pluginPath: '/h/p' }, kill: { on: false, file: '/h/.wk/KILL' },
    pace: { state: 'error', detail: evil },
    ledger: { missing: false, totals: { usd: 1, runs: 1, in: 1, cache_read: 1, cache_write: 0, out: 1 }, top: [{ item: evil, usd: 1, runs: 1 }], wakeups: [{ item: evil, at: NOW, usd: 1, lens: evil }], bad: 0 },
    sessions: { missing: false, more: 0, sessions: [{ id: 'abc', title: evil, project: evil, at: NOW, active: true, model: evil, tokens: 10,
      members: [{ id: 'a', role: 'Worker', task: evil, model: evil, effort: evil, state: 'running', at: NOW }] }] },
    locks: { missing: false, locks: [{ area: 'site', label: evil, since: evil, item: '' }] },
    inbox: [{ at: NOW, kind: 'rule', text: evil, status: evil }],
  };
  const all = Object.values(R.renderSections(m)).join('\n');
  assert.ok(!all.includes('<img'), 'no raw tag');
  assert.ok(!all.includes('<script'), 'no raw script');
  assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/"'`&</.test(all));
  assert.equal(R.esc('<a href="x">\'`&'), '&lt;a href=&quot;x&quot;&gt;&#39;&#96;&amp;');
});

// ---------------------------------------------------------------- P2-208: questions answered for the owner
test('advice: newest first, states, a dead "asking" reads as stopped, bad records skipped', () => {
  const data = tmp(), dir = path.join(data, 'advice');
  const rec = (id, meta, answer) => { write(path.join(dir, id, 'meta.json'), JSON.stringify({ id, ...meta })); if (answer) write(path.join(dir, id, 'answer.md'), answer); };
  rec('20261111-101500-which-app-next', { from: 'gemini', status: 'answered', asked_at: '2026-11-11T06:15:00Z', finished_at: '2026-11-11T06:21:00Z', preview: 'Which app next?', cost_usd: 2.5 }, 'Answer: the timer.');
  rec('20261111-111500-left-behind', { from: 'gemini', status: 'asking', pid: 999999, preview: 'Left behind' });
  rec('20261111-121500-still-going', { from: 'gemini', status: 'asking', pid: process.pid, preview: 'Still going' });
  rec('20261111-131500-failed-one', { from: 'gemini', status: 'failed', error: 'timed out', preview: 'Failed one' });
  rec('20261111-141500-wrong-id', { id: 'something-else' });
  write(path.join(dir, '20261111-151500-broken', 'meta.json'), '{not json');
  write(path.join(dir, '../../escape', 'meta.json'), '{}');
  write(path.join(dir, '.busy'), '1');
  const a = D.readAdvice(data);
  assert.deepEqual(a.items.map(x => [x.id.slice(16), x.status, x.hasAnswer]), [['failed-one', 'failed', false], ['still-going', 'asking', false], ['left-behind', 'stopped', false], ['which-app-next', 'answered', true]]);
  assert.equal(a.total, 6);
  assert.equal(a.items[3].cost, 2.5);
  assert.equal(a.items[0].error, 'timed out');
  assert.deepEqual(D.readAdvice(tmp()), { items: [], total: 0 });
});

test('advice: only checked ids open, only inside the advice folder', () => {
  const data = tmp(), id = '20261111-101500-which-app-next';
  write(path.join(data, 'advice', id, 'answer.md'), 'a'); write(path.join(data, 'advice', id, 'question.md'), 'q');
  assert.equal(D.adviceFile(data, id), path.join(data, 'advice', id, 'answer.md'));
  assert.equal(D.adviceFile(data, id, 'question'), path.join(data, 'advice', id, 'question.md'));
  assert.equal(D.adviceFile(data, '../../etc/passwd'), null);
  assert.equal(D.adviceFile(data, '20261111-101500-missing'), null);
  assert.deepEqual(D.validateMessage({ cmd: 'openAdvice', id, which: '../x' }), { ok: true, msg: { cmd: 'openAdvice', id, which: 'answer' } });
  assert.equal(D.validateMessage({ cmd: 'openAdvice', id: '../../etc/passwd' }).ok, false);
  assert.deepEqual(D.validateMessage({ cmd: 'installAsk', dest: '/etc' }), { ok: true, msg: { cmd: 'installAsk' } });
});

test('advice: can Gemini ask? installed, switched off, command present', () => {
  const home = tmp(), plugin = tmp();
  assert.deepEqual(D.askState(home, plugin).installed, false);
  write(path.join(plugin, 'bin', 'wk-ask-claude.mjs'), '');
  write(path.join(home, '.gemini', 'config', 'plugins', 'watchkeeper', 'skills', 'ask-claude', 'SKILL.md'), 'x');
  let s = D.askState(home, plugin); assert.equal(s.installed, true); assert.equal(s.off, false); assert.equal(s.commandOk, true);
  write(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ plugins: { watchkeeper: { enabled: false } } }));
  s = D.askState(home, plugin); assert.equal(s.off, true);
  const html = R.renderAdvice({ now: NOW, ask: s, advice: { items: [], total: 0 } });
  assert.match(html, /switched off in Antigravity/);
  assert.match(R.renderAdvice({ now: NOW, ask: { installed: false, commandOk: true }, advice: { items: [], total: 0 } }), /data-cmd="installAsk"/);
});

test('advice: render escapes what agents wrote and offers the right file', () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const html = R.renderAdvice({ now: NOW, ask: { installed: true }, advice: { total: 7, items: [
    { id: '20261111-101500-a', status: 'answered', from: 'gemini', at: NOW - 60e3, preview: evil, cost: 2.5, hasAnswer: true, error: '' },
    { id: '20261111-111500-b', status: 'failed', from: evil, at: NOW, preview: 'q', cost: null, hasAnswer: false, error: evil },
  ] } });
  assert.ok(!html.includes('<img'));
  assert.match(html, /Read the answer/); assert.match(html, /data-which="question"/);
  assert.match(html, /US\$2\.50/); assert.match(html, /5 older questions/);
  assert.match(html, /Answered[\s\S]*Not answered/);
});

test('updates: the last check is read safely and shown in words', () => {
  const data = tmp(), plugin = tmp(), home = path.dirname(plugin);
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.3.0' }));
  let u = D.readUpdate(data, plugin);
  assert.deepEqual(u, { version: '0.3.0', route: { kind: 'other' }, last: null });
  const m = up => ({ now: NOW, update: up, paths: { pluginPath: plugin, home } });
  let html = R.renderUpdate(m(u));
  assert.match(html, /not a git clone, so it cannot update itself/); assert.doesNotMatch(html, /wk-update\.mjs install/, 'no updater hint for a copy it cannot update');
  // a git clone: the updater's install line
  fs.mkdirSync(path.join(plugin, '.git'));
  u = D.readUpdate(data, plugin);
  assert.deepEqual(u.route, { kind: 'clone' });
  html = R.renderUpdate(m(u));
  assert.match(html, /not set up on this computer/); assert.match(html, /bin\/wk-update\.mjs install/);
  // installed by Claude Code (the plugin cache): the two claude plugin lines, never the updater, even if the folder holds .git
  const cached = path.join(tmp(), '.claude', 'plugins', 'cache', 'nexodyne', 'watchkeeper', '0.3.0');
  write(path.join(cached, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.3.0' })); fs.mkdirSync(path.join(cached, '.git'));
  const cu = D.readUpdate(data, cached);
  assert.deepEqual(cu.route, { kind: 'marketplace', marketplace: 'nexodyne', plugin: 'watchkeeper' });
  const ch = R.renderUpdate({ now: NOW, update: cu, paths: { pluginPath: cached, home } });
  assert.match(ch, /claude plugin marketplace update nexodyne<\/code>, then <code>claude plugin update watchkeeper@nexodyne/);
  assert.match(ch, /auto-update is on/); assert.doesNotMatch(ch, /wk-update/);
  const evil = '<img src=x onerror=alert(1)>';
  write(path.join(data, 'update.json'), JSON.stringify({ at: new Date(NOW - 3600e3).toISOString(), result: 'problem', problem: `the folder has changes ${evil}`, version: '0.3.0' }));
  u = D.readUpdate(data, plugin);
  html = R.renderUpdate(m(u));
  assert.ok(!html.includes('<img')); assert.match(html, /class="warn"/); assert.match(html, /was not updated/); assert.match(html, /Why: the folder has changes/);
  write(path.join(data, 'update.json'), JSON.stringify({ at: new Date(NOW - 600e3).toISOString(), result: 'updated', moved: { from: '0.2.0', to: '0.3.0' } }));
  html = R.renderUpdate(m(D.readUpdate(data, plugin)));
  assert.match(html, /Watchkeeper 0\.3\.0: updated from 0\.2\.0/); assert.ok(!html.includes('class="warn"'));
  write(path.join(data, 'update.json'), JSON.stringify({ at: new Date(NOW - 30 * 3600e3).toISOString(), result: 'up to date' }));
  html = R.renderUpdate(m(D.readUpdate(data, plugin)));
  assert.match(html, /up to date/); assert.match(html, /The last check was 30 h ago/);
  write(path.join(data, 'update.json'), JSON.stringify({ at: new Date(NOW - 600e3).toISOString(), result: 'up to date', held: `this is a developer's copy, ahead of release v0.3.0 ${evil}` }));
  html = R.renderUpdate(m(D.readUpdate(data, plugin)));
  assert.match(html, /left as they are: this is a developer(&#39;|&#x27;|')s copy, ahead of release v0\.3\.0/); assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('class="warn"'), 'a held copy is a plain line, not a warning');
  write(path.join(data, 'update.json'), JSON.stringify({ at: 'not a date', result: 'something odd' }));
  assert.equal(D.readUpdate(data, plugin).last.result, 'problem', 'an unknown result counts as a problem');
  write(path.join(data, 'update.json'), '{ broken');
  assert.equal(D.readUpdate(data, plugin).last, null);
  assert.match(R.renderUpdate(m({ version: '0.3.0', last: { at: NOW, result: 'paused' } })), /paused while wake-ups are stopped/);
});

// P2-212: a stranger's world (no Watchkeeper plugin): only the sessions, an honest note, no owner paths, nothing written.
test('sessions only: without the plugin the panel shows sessions and the about note, and hides the plugin parts', async () => {
  const home = tmp(), claude = path.join(home, '.claude'), proj = path.join(claude, 'projects', '-Users-someone-code-app');
  const s = write(path.join(proj, 'aaaa-1111.jsonl'), [{ type: 'user', cwd: '/Users/someone/code/app', message: { role: 'user', content: 'Add a login page' } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } }].map(o => JSON.stringify(o)).join('\n') + '\n');
  const t = new Date(); fs.utimesSync(s, t, t);
  // plugin data and Gemini settings that a stranger might have: without the plugin none of it is read
  write(path.join(home, '.wk', 'owner-inbox.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'rule', text: 'secret note' }) + '\n');
  write(path.join(home, '.wk', 'KILL'), 'on');
  write(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ plugins: { watchkeeper: { enabled: false } } }));
  const snap = dir => fs.readdirSync(dir, { recursive: true }).sort().map(f => { const st = fs.lstatSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
  const before = snap(home);
  const m = await D.collect({}, Date.now(), { home });
  assert.equal(m.pace.state, 'no-plugin');
  assert.deepEqual([m.inbox.length, m.kill.on, m.ask.off, m.dataOk], [0, false, false, false], 'no ~/.wk or Gemini file read without the plugin');
  assert.equal(m.locks.missing, true, 'no orchestration folder by default, and never a relative one');
  const sec = R.renderSections(m);
  assert.equal(sec.mode, 'sessions');
  assert.match(sec.status, /1 session active/);
  assert.doesNotMatch(sec.status, /Not set up/);
  assert.match(sec.sessions, /Add a login page/);
  assert.doesNotMatch(sec.sessions, /Wake-ups/);
  assert.match(sec.about, /~\/\.claude\/projects/);
  assert.match(sec.about, /makes no network calls and writes nothing/);
  assert.match(sec.about, /A worker is a sub-agent that a session started/);
  assert.match(sec.sessions, /transcript ~[\d.]+k? tokens/);
  assert.doesNotMatch(sec.sessions, /Director|Desk|Quiet|last news/, 'plain words for a stranger');
  // the plugin's published install address (the README's two lines) is the one place the publisher's name may appear; nothing else may
  const INSTALL = ['/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper', '/plugin marketplace add tengotengo23/nexodyne-watchkeeper', '/plugin install watchkeeper@nexodyne'];
  for (const l of INSTALL) assert.ok(sec.about.includes(`<code>${l}</code>`), l);
  assert.doesNotMatch(INSTALL.reduce((t, l) => t.split(`<code>${l}</code>`).join(''), Object.values(sec).join(' ')), /nexodyne|raise\s?steady/i, 'no owner names in a stranger\'s panel');
  assert.equal(snap(home), before, 'nothing written or changed anywhere in the home folder');
  // the plugin's own sections stay where they were when the plugin is there
  const plugin = path.join(home, 'Projects', 'watchkeeper');
  write(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
  write(path.join(plugin, 'config', 'gates.json'), '{}');   // P2-243: a plugin folder holds both files
  const fm = await D.collect({}, Date.now(), { home });
  const full = R.renderSections(fm);
  assert.equal(full.mode, 'full');
  assert.deepEqual([fm.inbox.length, fm.kill.on, fm.ask.off], [1, true, true], 'with the plugin its data is read');
  assert.match(full.sessions, /Wake-ups/);
});

// P2-243: the panel finds the plugin by itself: the setting, then ~/Projects/watchkeeper, then Claude Code's installed_plugins.json.
test('plugin lookup: setting first, then the ~/Projects/watchkeeper clone, then the newest installed watchkeeper@*; missing or broken JSON is none', () => {
  const home = tmp(), claude = path.join(home, '.claude'), list = path.join(claude, 'plugins', 'installed_plugins.json');
  const plugin = dir => { write(path.join(dir, 'bin', 'wk-ledger.mjs'), 'process.exit(3);'); write(path.join(dir, 'config', 'gates.json'), '{}'); return dir; };
  const find = (cfg = {}) => D.resolvePaths(cfg, home).pluginPath;
  assert.equal(find(), '', 'nothing there: none');
  assert.equal(D.pluginInstalled(find()), false);
  for (const bad of ['{ not json', '[]', '{"version":2,"plugins":[]}', '{"version":2,"plugins":{"watchkeeper@nexodyne":"x"}}', '{"version":2,"plugins":{"watchkeeper@nexodyne":[null,7,{"installPath":"relative/p"}]}}']) {
    write(list, bad); assert.equal(find(), '', `broken: ${bad}`);
  }
  const cache = v => path.join(claude, 'plugins', 'cache', 'nexodyne', 'watchkeeper', v);
  const v1 = plugin(cache('0.6.0')), v2 = plugin(cache('0.7.0'));
  const gone = cache('0.8.0');                                   // listed but deleted: skipped
  const half = cache('0.9.0'); write(path.join(half, 'bin', 'wk-ledger.mjs'), 'x');   // no config/gates.json: skipped
  const other = plugin(path.join(claude, 'plugins', 'cache', 'x', 'other', '9.9.9'));
  const e = (installPath, lastUpdated) => ({ scope: 'user', installPath, version: path.basename(installPath), installedAt: '2026-11-01T10:00:00.000Z', lastUpdated, gitCommitSha: 'abc' });
  write(list, JSON.stringify({ version: 2, plugins: {
    'other@x': [e(other, '2026-11-20T10:00:00.000Z')],
    'watchkeeper@nexodyne': [e(v1, '2026-11-10T10:00:00.000Z'), e(gone, '2026-11-18T10:00:00.000Z'), e(half, '2026-11-19T10:00:00.000Z')],
    'watchkeeper@fork': [e(v2, '2026-11-16T10:00:00.000Z'), { installPath: v1, lastUpdated: 'not a date' }],
  } }));
  assert.equal(find(), v2, 'the newest watchkeeper@* entry whose folder holds the plugin');
  assert.equal(D.pluginInstalled(find()), true);
  // a clone at ~/Projects/watchkeeper (the owner's set-up) comes before the installed copy, but only when it holds both files
  const clone = path.join(home, 'Projects', 'watchkeeper');
  write(path.join(clone, 'bin', 'wk-ledger.mjs'), 'x');
  assert.equal(find(), v2, 'a clone without config/gates.json is not used');
  write(path.join(clone, 'config', 'gates.json'), '{}');
  assert.equal(find(), clone);
  // the setting wins, as typed (with ~), even where nothing is
  assert.equal(find({ pluginPath: '~/elsewhere' }), path.join(home, 'elsewhere'));
  assert.equal(find({ pluginPath: '  ' }), clone, 'a blank setting means automatic');
  // the claudeDir setting moves the installed list with it
  fs.rmSync(path.join(clone, 'config'), { recursive: true });
  assert.equal(find({ claudeDir: path.join(home, 'nowhere') }), '');
  assert.equal(find(), v2);
});

test('sessions only: the page marks the plugin sections, and the about section starts hidden', () => {
  const html = R.renderPage({ nonce: 'abc', cspSource: 'x', styleUris: [], scriptUri: 'x' });
  assert.equal((html.match(/data-needs="plugin"/g) || []).length, 7); // P2-272 P3: 6 to 7, the usage card is one more plugin section; nothing cut
  assert.equal((html.match(/data-needs="plugin" hidden>/g) || []).length, 7, 'plugin sections start hidden until the data says the plugin is there');
  assert.equal(D.pluginInstalled(''), false);
  assert.equal(D.pluginInstalled('Projects/watchkeeper'), false, 'a relative plugin folder is never used');
  assert.match(html, /<section aria-labelledby="h-about" data-needs="no-plugin" hidden>/);
  assert.equal(D.readLocks('').missing, true);
  assert.equal(D.readLocks('orchestration').missing, true, 'a relative folder is never read');
  assert.equal(D.resolvePaths({}, '/h').orchestrationDir, '');
});

test('dev puppeteer: WK_PUPPETEER_FROM first, else the panel folder; not found says how to install it and exits 1', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'puppeteer.mjs');
  const run = from => spawnSync(process.execPath, ['--input-type=module', '-e', `const p = await import(${JSON.stringify('file://' + script)}); console.log(typeof p.launch, p.puppeteer.fake === true)`],
    { encoding: 'utf8', env: { ...process.env, WK_PUPPETEER_FROM: from }, timeout: 20000 });
  const empty = tmp();
  const none = run(write(path.join(empty, 'package.json'), '{}'));
  assert.equal(none.status, 1);
  assert.equal(none.stderr.trim(), 'puppeteer is not installed: run npm i --no-save puppeteer in panel/, or set WK_PUPPETEER_FROM to a package.json whose folder has it');
  const has = tmp();
  write(path.join(has, 'node_modules', 'puppeteer', 'index.js'), 'module.exports = { fake: true, launch: () => null };');
  const ok = run(write(path.join(has, 'package.json'), '{}'));
  assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout.trim(), 'function true');
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /Projects|homedir/, 'no owner folder');
});
