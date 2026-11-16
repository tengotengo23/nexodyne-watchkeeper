// State tests for the steward (P2-187): the lock, the event log, the projects file, which project and lens come next,
// the brief and the facts it carries. In-process; everything lives in a temp world (test/fixtures/world.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkWorld, env, cleanup, setConfig, NOW0, HOUR, DAY, iso } from './fixtures/world.mjs';

const w0 = mkWorld({ projects: 3 });
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) || /^CLAUDE_CODE_USE_/.test(k) || k === 'CLAUDE_PLUGIN_ROOT' || k === 'WK_LANE') delete process.env[k];
Object.assign(process.env, env(w0));
const S = await import('../bin/steward-lib.mjs');
const { scanPII } = await import('../bin/lib.mjs');
after(cleanup);

let nFresh = 0;
function fresh() {   // a new empty state folder and ledger inside the temp world
  const d = path.join(w0.dir, 'fresh-' + (++nFresh)); fs.mkdirSync(d, { recursive: true });
  process.env.WK_STEWARD_DIR = path.join(d, 'state'); process.env.WK_LEDGER = path.join(d, 'ledger.jsonl'); return d;
}
const cfgWith = obj => { setConfig(w0, obj); return S.loadConfig(); };
const C = () => cfgWith({});
const E = (type, o = {}, atMs = NOW0) => ({ type, at: iso(atMs), ...o });
const lockFile = () => path.join(S.stewardDir(), 'tick.lock');
const writeLock = v => { fs.mkdirSync(S.stewardDir(), { recursive: true }); fs.writeFileSync(lockFile(), typeof v === 'string' ? v : JSON.stringify(v)); };
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
let nProj = 0;
function useProjects(raw) {   // null: back to the world's file; undefined: a file that does not exist; a string is written as it is
  if (raw === null) return (process.env.WK_PROJECTS = w0.projectsFile);
  const f = path.join(w0.dir, `projects-${++nProj}.json`);
  if (raw !== undefined) fs.writeFileSync(f, typeof raw === 'string' ? raw : JSON.stringify(raw));
  return (process.env.WK_PROJECTS = f);
}
const stamp = `${Math.floor((NOW0 - 3 * DAY) / 1000)} +0000`;
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
  { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: w0.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
const ALPHA = { id: 'alpha', name: 'Alpha', kind: 'site', goal: 'Help a beginner finish the first lesson in one short visit', audience: 'People who are new to the subject', number: 'Visitors who come back the next week', notes: '' };
const KNOBS = { ideasPerCall: 4, minImpact: 2, pastIdeasInBrief: 20, wildcardEvery: 5 };

// ---------------------------------------------------------------- the lock
test('lock: a free lock is taken with our pid and the time, then released', () => {
  fresh();
  assert.deepEqual(S.takeLock(C(), NOW0), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(), 'utf8')), { pid: process.pid, at: iso(NOW0) });
  S.releaseLock(); assert.equal(fs.existsSync(lockFile()), false);
});
test('lock: a live holder younger than lockMaxMin keeps it, and release leaves a lock that is not ours', () => {
  fresh(); writeLock({ pid: process.ppid, at: iso(NOW0 - 29 * 60000) });
  assert.deepEqual(S.takeLock(C(), NOW0), { ok: false, pid: process.ppid });
  S.releaseLock(); assert.equal(fs.existsSync(lockFile()), true);
  assert.deepEqual(S.takeLock(cfgWith({ call: { lockMaxMin: 20 } }), NOW0), { ok: true }, 'a shorter lockMaxMin makes the same lock stale');
});
const ageFile = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); };
test('lock: an old, dead, unreadable or badly formed lock is taken over', () => {
  const cases = [{ pid: process.ppid, at: iso(NOW0 - 31 * 60000) }, { pid: deadPid(), at: iso(NOW0) }, 'not json at all', '', { pid: String(process.ppid), at: iso(NOW0) },
    { pid: 1.5, at: iso(NOW0) }, { at: iso(NOW0) }, { pid: process.ppid }, [process.ppid]];
  for (const c of cases) {
    fresh(); writeLock(c);
    if (typeof c === 'string') ageFile(lockFile(), 10000);   // an unreadable lock holds for its first few seconds (next test)
    assert.deepEqual(S.takeLock(C(), NOW0), { ok: true }, JSON.stringify(c));
    assert.equal(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid, process.pid);
    S.releaseLock(); assert.equal(fs.existsSync(lockFile()), false);
  }
});
test('lock: an unreadable lock holds for a few seconds (it may be one being written), then it is taken over', () => {
  for (const text of ['', '{"pid": 12', 'not json at all']) {
    fresh(); writeLock(text);
    assert.deepEqual(S.takeLock(C(), NOW0), { ok: false, pid: null }, `fresh ${JSON.stringify(text)} holds`);
    assert.equal(fs.readFileSync(lockFile(), 'utf8'), text, 'and is left as it is');
    ageFile(lockFile(), 10000);
    assert.deepEqual(S.takeLock(C(), NOW0), { ok: true }, `${JSON.stringify(text)} ten seconds old is taken over`);
    S.releaseLock(); assert.equal(fs.existsSync(lockFile()), false);
  }
});
test('lock: a live steward visit keeps its lock even when it is older than lockMaxMin (a slow call, or a Mac that slept)', () => {
  // a live process whose command line names wk-steward, as a real visit's does
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'wk-steward.mjs', 'tick'], { stdio: 'ignore' });
  try {
    fresh(); writeLock({ pid: child.pid, at: iso(NOW0 - 5 * HOUR) });
    assert.deepEqual(S.takeLock(C(), NOW0), { ok: false, pid: child.pid });
    assert.equal(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid, child.pid, 'the visit still holds it');
  } finally { child.kill('SIGKILL'); }
});
// many processes race for the lock at the same instant: exactly one may win, whether the lock was free, dead, old or broken
const RACER = `const S = await import(${JSON.stringify(new URL('../bin/steward-lib.mjs', import.meta.url).href)}); const fs = await import('node:fs');
const [go, end, now] = process.argv.slice(1); while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
process.stdout.write(JSON.stringify(S.takeLock({ call: { lockMaxMin: 30 } }, +now)) + '\\n'); while (!fs.existsSync(end)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`;
test('lock: of six ticks that race for the lock at the same instant, exactly one gets it', async () => {
  const starts = [null, { pid: deadPid(), at: iso(NOW0) }, { pid: process.ppid, at: iso(NOW0 - 31 * 60000) }, 'not json at all'];
  for (let round = 0; round < 12; round++) {
    const d = fresh(), start = starts[round % starts.length], go = path.join(d, 'go'), end = path.join(d, 'end');
    if (start !== null) { writeLock(start); ageFile(lockFile(), 60000); }
    const kids = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', RACER, go, end, String(NOW0)], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] }));
    const outs = kids.map(k => new Promise(r => { let s = ''; k.stdout.on('data', x => { s += x; if (s.includes('\n')) r(JSON.parse(s)); }); k.on('exit', () => r(s ? JSON.parse(s) : { exited: true })); }));
    await new Promise(r => setTimeout(r, 400)); fs.writeFileSync(go, '');
    const res = await Promise.all(outs); fs.writeFileSync(end, '');
    await Promise.all(kids.map(k => new Promise(r => k.exitCode !== null ? r() : k.on('exit', r))));
    assert.equal(res.filter(x => x.ok === true).length, 1, `round ${round} (${JSON.stringify(start)}): ${JSON.stringify(res)}`);
    assert.ok(kids.map(k => k.pid).includes(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid), 'the lock names the winner');
    assert.deepEqual(fs.readdirSync(S.stewardDir()).sort(), ['tick.lock'], 'no guard folder or temp file is left behind');
  }
});

// ---------------------------------------------------------------- the event log
test('events: appendEvent stamps the time; an event that brings its own time keeps it', () => {
  fresh();
  S.appendEvent({ type: 'note', x: 1 }, NOW0 - HOUR);
  S.appendEvent({ type: 'note', at: '2026-01-01T00:00:00.000Z' }, NOW0);
  S.appendEvent({ type: 'note' });
  assert.deepEqual(S.readEvents(), [{ at: iso(NOW0 - HOUR), type: 'note', x: 1 }, { at: '2026-01-01T00:00:00.000Z', type: 'note' }, { at: iso(NOW0), type: 'note' }]);
});
test('events: readEvents skips blank, broken and non-object lines; no file gives an empty list', () => {
  fresh(); assert.deepEqual(S.readEvents(), []);
  fs.mkdirSync(S.stewardDir(), { recursive: true });
  fs.writeFileSync(path.join(S.stewardDir(), 'events.jsonl'), ['{"type":"a"}', '', '   ', '{"type":', '[1,2]', '"text"', '42', 'null', '{"type":"b"}', ''].join('\n'));
  assert.deepEqual(S.readEvents().map(e => e.type), ['a', 'b']);
});
test('events: after a torn last line (a write cut short) the next event starts on its own line and the tick ids never repeat', () => {
  fresh(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  const f = path.join(S.stewardDir(), 'events.jsonl');
  fs.writeFileSync(f, JSON.stringify(E('tick_started', { tick: 't000001', project: 'alpha' })) + '\n' + JSON.stringify(E('tick_finished', { tick: 't000001', outcome: 'ok' })) + '\n{"type":"tick_started","tick":"t0000');
  S.appendEvent({ type: 'tick_started', tick: 't000002', project: 'beta' }, NOW0);
  assert.deepEqual(S.readEvents().map(e => `${e.type} ${e.tick}`), ['tick_started t000001', 'tick_finished t000001', 'tick_started t000002'], 'only the torn line is lost');
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
  assert.equal(S.derive(S.readEvents()).nextTick, 't000003');
  // a lost line no longer brings an id back: t000002 to t000004 are missing from the log, the next is still after the highest
  fs.writeFileSync(f, [E('tick_started', { tick: 't000001' }), E('tick_finished', { tick: 't000001', outcome: 'ok' }), E('tick_held', { tick: 't000005', reason: 'gap' })].map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(S.derive(S.readEvents()).nextTick, 't000006');
  // an empty file and a file that ends cleanly get no blank line
  fs.writeFileSync(f, ''); S.appendEvent({ type: 'note' }, NOW0); S.appendEvent({ type: 'note' }, NOW0);
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').length, 3);
});
test('derive: an empty log', () => {
  const d = S.derive([]);
  assert.equal(d.nextTick, 't000001'); assert.equal(d.nextIdea, 1); assert.equal(d.nextAssumption, 1);
  assert.deepEqual(d.unfinished, []); assert.equal(d.lastStart, 0); assert.equal(d.ideas.size, 0); assert.deepEqual(d.counted, []);
});
test('derive: ideas, answers, assumptions, ticks and the next ids from a mixed log', () => {
  const T = h => NOW0 + h * HOUR;
  const d = S.derive([
    E('tick_started', { tick: 't000001', project: 'alpha', lens: 'finish' }, T(0)),
    E('idea_added', { id: 'i1', project: 'alpha', title: 'One' }, T(0)), E('idea_added', { id: 'i7', project: 'alpha', title: 'Seven' }, T(0)),
    E('idea_added', { id: 42, project: 'alpha', title: 'A number is not an id' }, T(0)), E('assumption', { id: 'a3', project: 'alpha', q: 'q', a: 'a' }, T(0)),
    E('tick_finished', { tick: 't000001', outcome: 'ok', project: 'alpha' }, T(0)),
    E('tick_held', { tick: 't000002', reason: 'gap' }, T(1)),
    E('tick_started', { tick: 't000003', project: 'beta' }, T(2)), E('tick_finished', { tick: 't000003', outcome: 'error', project: 'beta' }, T(2)),
    E('tick_started', { tick: 't000004', project: 'gamma' }, T(3)), E('tick_finished', { tick: 't000004', outcome: 'invalid', project: 'gamma' }, T(3)),
    E('tick_started', { tick: 't000005', project: 'alpha' }, T(4)),
    E('idea_answered', { id: 'i1', answer: 'yes', note: 'good' }, T(5)), E('idea_answered', { id: 'i7', answer: 'later', note: '' }, T(5)),
    E('idea_answered', { id: 'i99', answer: 'no', note: '' }, T(5)), E('something_new', {}, T(5)),
  ]);
  assert.deepEqual([...d.ideas.keys()], ['i1', 'i7']);
  assert.equal(d.ideas.get('i1').status, 'yes'); assert.equal(d.ideas.get('i1').answeredAt, iso(T(5))); assert.equal(d.ideas.get('i1').note, 'good');
  assert.equal(d.ideas.get('i7').status, 'later');
  assert.equal(d.nextIdea, 8); assert.equal(d.nextAssumption, 4);
  assert.deepEqual(d.unfinished.map(e => e.tick), ['t000005']);
  assert.equal(d.nextTick, 't000006', 'four starts and one hold came before');
  assert.deepEqual(d.counted.map(e => e.outcome), ['ok', 'invalid'], 'errors are not counted visits');
  assert.equal(d.finished.length, 3); assert.equal(d.held.length, 1); assert.equal(d.lastStart, T(4));
});
test('derive: an idea filed again is open again; a tick id used twice keeps the later start', () => {
  const d = S.derive([E('idea_added', { id: 'i1', title: 'x' }), E('idea_answered', { id: 'i1', answer: 'no' }), E('idea_added', { id: 'i1', title: 'x' }),
    E('tick_started', { tick: 't000001', project: 'alpha' }), E('tick_started', { tick: 't000001', project: 'beta' }, NOW0 + HOUR)]);
  assert.equal(d.ideas.get('i1').status, 'open');
  assert.equal(d.started.size, 1); assert.equal(d.started.get('t000001').project, 'beta'); assert.equal(d.nextTick, 't000002'); assert.equal(d.unfinished.length, 1);
});

// ---------------------------------------------------------------- the projects file
test('projects: no file, no list, and the bare-array form', () => {
  useProjects(undefined);
  const a = S.loadProjects(); assert.equal(a.missing, true); assert.deepEqual(a.projects, []); assert.match(a.problems[0], /^no projects file yet: run wk-steward init/);
  for (const raw of [{ other: 1 }, 'null', '"text"', { projects: 'alpha' }]) {
    useProjects(raw); const b = S.loadProjects();
    assert.equal(b.missing, true); assert.deepEqual(b.problems, ['the projects file has no "projects" list'], JSON.stringify(raw));
  }
  useProjects([{ id: 'solo', path: w0.dir }]); const c = S.loadProjects();
  assert.deepEqual(c.projects.map(p => p.id), ['solo']); assert.equal(c.missing, undefined); assert.deepEqual(c.problems, []);
  useProjects(null);
});
test('projects: problems are named, text is cleaned, weights are clamped and the list is sorted', () => {
  const BAD = 'a project has a missing or bad id (use a-z, 0-9 and -)';
  useProjects({ projects: [
    { id: 'zeta', path: '~/somewhere', weight: 99, name: 'Zeta <b>bold</b>', kind: '', paused: 'yes' },
    { id: 'alpha', path: ' /tmp/x ', weight: 'x' },
    { id: 'beta', path: '/tmp/y', weight: 0.4, paused: true, goal: 'a\u0007b   c', notes: 'n'.repeat(500) },
    { id: 'Bad_Id', path: '/tmp/z' }, { path: '/tmp/z' }, 'not an object', { id: '-dash', path: '/tmp/z' }, { id: 'a'.repeat(32), path: '/tmp/z' },
    { id: 'a'.repeat(31), path: '/tmp/z' },
    { id: 'alpha', path: '/tmp/dup' }, { id: 'gamma' }, { id: 'delta', path: '   ' },
  ] });
  const r = S.loadProjects();
  assert.deepEqual(r.problems, [BAD, BAD, BAD, BAD, BAD, 'alpha: duplicate id', 'gamma: no path', 'delta: no path']);
  assert.deepEqual(r.projects.map(p => p.id), ['a'.repeat(31), 'alpha', 'beta', 'zeta']);
  const [, a, b, z] = r.projects;
  assert.equal(z.path, path.join(os.homedir(), 'somewhere')); assert.equal(z.weight, 10); assert.equal(z.name, 'Zeta b bold /b'); assert.equal(z.kind, 'project'); assert.equal(z.paused, false);
  assert.equal(a.path, '/tmp/x'); assert.equal(a.weight, 1); assert.equal(a.name, 'alpha'); assert.equal(a.goal, '');
  assert.equal(b.weight, 1); assert.equal(b.paused, true); assert.equal(b.goal, 'a b c'); assert.equal(b.notes.length, 400);
  useProjects(null);
});
test('projects: a file that is not JSON stops with a clear error instead of guessing', () => {
  useProjects('{ "projects": [ ');
  assert.throws(() => S.loadProjects(), e => e instanceof S.StewardError && e.code === 1 && /cannot be read as JSON/.test(e.message));
  useProjects(null);
});

// ---------------------------------------------------------------- which projects may be visited now
test('eligible: paused, missing folder, privacy block and two errors, in that order', () => {
  useProjects(null);
  const g = S.loadProjects().projects.find(p => p.id === 'gamma'), missing = { ...g, path: path.join(w0.dir, 'no-such-folder') };
  const pii = (h, project = 'gamma', reason = 'pii') => E('tick_held', { tick: 't1', reason, project }, NOW0 - h * HOUR);
  const fin = (h, outcome = 'error', project = 'gamma') => E('tick_finished', { tick: 'x', outcome, project }, NOW0 - h * HOUR);
  const why = (p, log) => { const r = S.eligibleProjects([p], S.derive(log), NOW0); return r.skipped.length ? (assert.equal(r.skipped[0].id, p.id), r.skipped[0].why) : (assert.equal(r.list[0], p), 'ok'); };
  const all = [pii(1), fin(2), fin(1)];
  assert.equal(why({ ...missing, paused: true }, all), 'paused');
  assert.equal(why(missing, all), 'folder missing');
  assert.equal(why(g, all), 'blocked 24 h: the brief held private data');
  assert.equal(why(g, [pii(23)]), 'blocked 24 h: the brief held private data');
  assert.equal(why(g, [pii(25), fin(2), fin(1)]), 'two errors in a row, waits 6 h');
  assert.equal(why(g, [pii(25)]), 'ok', 'the block ends after 24 h');
  assert.equal(why(g, [pii(1, 'beta')]), 'ok', "another project's block");
  assert.equal(why(g, [pii(1, 'gamma', 'gap')]), 'ok', 'another hold reason');
  assert.equal(why(g, [fin(3), fin(2, 'ok', 'beta'), fin(1)]), 'two errors in a row, waits 6 h', 'another project in between does not break the run');
  assert.equal(why(g, [fin(3), fin(2, 'ok'), fin(1)]), 'ok', 'error, ok, error');
  assert.equal(why(g, [fin(3), fin(2, 'invalid'), fin(1)]), 'ok', 'an invalid answer is not an error');
  assert.equal(why(g, [fin(9), fin(7)]), 'ok', 'the last error is over 6 h old');
  assert.equal(why(g, [fin(1)]), 'ok', 'one error is not enough');
});

// ---------------------------------------------------------------- which project comes next
function rotate(list, cfg, n, start = []) {   // pick n times; each pick becomes a counted visit one minute after the last
  const log = [...start], out = [];
  for (let i = 0; i < n; i++) {
    const p = S.pickProject(list, S.derive(log), cfg); out.push(p.id);
    log.push(E('tick_finished', { tick: 'k' + i, outcome: 'ok', project: p.id }, NOW0 + log.length * 60000));
  }
  return out.map(id => id[0]).join('');
}
test('pickProject: weights 3, 2 and 1 share the visits fairly, the longest-waiting first on a tie', () => {
  const cfg = C();
  assert.equal(rotate([{ id: 'alpha', weight: 3 }, { id: 'beta', weight: 2 }, { id: 'gamma', weight: 1 }], cfg, 12), 'abgabaabgaba');
  assert.equal(rotate([{ id: 'alpha', weight: 1 }, { id: 'beta', weight: 1 }, { id: 'gamma', weight: 1 }], cfg, 9), 'abgabgabg');
  assert.equal(rotate([{ id: 'beta', weight: 1 }], cfg, 3), 'bbb');
});
test('pickProject: only the last `window` counted visits decide; failed visits do not count', () => {
  const list = [{ id: 'alpha', weight: 3 }, { id: 'beta', weight: 2 }, { id: 'gamma', weight: 1 }];
  const hist = ['beta', 'beta', 'beta', 'alpha', 'alpha', 'alpha'].map((p, i) => E('tick_finished', { tick: 'h' + i, outcome: 'ok', project: p }, NOW0 - (10 - i) * HOUR));
  assert.equal(S.pickProject(list, S.derive(hist), cfgWith({ rotation: { window: 3 } })).id, 'beta');
  assert.equal(S.pickProject(list, S.derive(hist), C()).id, 'gamma');
  const errs = [0, 1, 2].map(i => E('tick_finished', { tick: 'e' + i, outcome: 'error', project: 'alpha' }, NOW0 - i * HOUR));
  assert.equal(S.pickProject(list, S.derive(errs), C()).id, 'alpha', 'three errors leave alpha still owed its visit');
});

// ---------------------------------------------------------------- which lens comes next
function lenses(cfg, knobs, n, log = []) {
  const got = [];
  for (let i = 0; i < n; i++) {
    const r = S.pickLens(cfg, S.derive(log), { id: 'alpha' }, knobs); got.push(r);
    log.push(E('tick_finished', { tick: 'l' + i, outcome: 'ok', project: 'alpha', lens: r.lens, wild: r.wild }, NOW0 + i * 60000));
    log.push(E('tick_finished', { tick: 'b' + i, outcome: 'ok', project: 'beta', lens: 'risk', wild: false }, NOW0 + i * 60000 + 1));   // another project's visits
  }
  return got;
}
test('pickLens: the least recently used lens first, and a wildcard on every fifth visit that avoids the last three', () => {
  const cfg = C(), got = lenses(cfg, KNOBS, 6);
  assert.deepEqual(got.map(r => r.lens), ['finish', 'features', 'fixes', 'content', 'wildcard', 'growth']);
  assert.deepEqual(got[0], { lens: 'finish', wild: false, avoid: [] });
  assert.deepEqual(got[4], { lens: 'wildcard', wild: true, avoid: ['content', 'fixes', 'features'] });
});
test('pickLens: with no wildcard every lens comes once, in config order, then the oldest again; failed visits do not use a lens', () => {
  const cfg = C(), keys = Object.keys(cfg.lenses);
  assert.deepEqual(lenses(cfg, { ...KNOBS, wildcardEvery: 1000 }, 11).map(r => r.lens), [...keys, keys[0]]);
  const log = [E('tick_finished', { tick: 'x', outcome: 'error', project: 'alpha', lens: 'finish' })];
  assert.equal(S.pickLens(cfg, S.derive(log), { id: 'alpha' }, KNOBS).lens, 'finish');
});

// ---------------------------------------------------------------- the brief
test('brief: the plain form, word for word', () => {
  const cfg = C(), r = S.buildBrief({ project: ALPHA, lens: 'finish', wild: false, avoid: [], cfg, knobs: KNOBS, facts: ['fact one', 'fact two'], st: S.derive([]) });
  assert.equal(r.text, ['PROJECT: Alpha (site)', `GOAL: ${ALPHA.goal}`, `AUDIENCE: ${ALPHA.audience}`, `NUMBER THAT MATTERS: ${ALPHA.number}`, `LENS: finish. ${cfg.lenses.finish}`,
    'WANT: 4 ideas, impact 2 or more.', '<facts>', 'fact one', 'fact two', '</facts>', 'PAST IDEAS (do not repeat):', '- none yet', 'INBOX: 0 of 5 questions open for this project.'].join('\n'));
  assert.equal(r.pastShown, 20);
});
test('brief: owner notes, empty fields, and the wildcard line with and without a list to avoid', () => {
  const cfg = C(), st = S.derive([]), b = o => S.buildBrief({ cfg, knobs: KNOBS, facts: [], st, lens: 'finish', wild: false, avoid: [], ...o }).text.split('\n');
  const t = b({ project: { ...ALPHA, notes: 'Keep it calm.', goal: '', audience: '', number: '' } });
  assert.deepEqual(t.slice(1, 5), ['GOAL: not set', 'AUDIENCE: not set', 'NUMBER THAT MATTERS: not set', 'OWNER NOTES: Keep it calm.']);
  assert.equal(b({ project: ALPHA, lens: 'wildcard', wild: true, avoid: ['content', 'fixes'] })[4], 'LENS: wildcard. Pick your own angle, not one of: content, fixes.');
  assert.equal(b({ project: ALPHA, lens: 'wildcard', wild: true, avoid: [] })[4], 'LENS: wildcard. Pick your own angle.');
});
test("brief: past ideas of this project in id order with their answers, the last three assumptions, and a full inbox", () => {
  const cfg = C();
  const log = [E('idea_added', { id: 'i1', project: 'alpha', title: 'First idea for alpha', gate: 'ask' }), E('idea_added', { id: 'i2', project: 'beta', title: 'An idea for beta', gate: 'ask' }),
    E('idea_added', { id: 'i10', project: 'alpha', title: 'Tenth idea for alpha', gate: 'auto' }), E('idea_added', { id: 'i3', project: 'alpha', title: 'Third idea for alpha', gate: 'wait' }),
    E('idea_answered', { id: 'i1', answer: 'no' }), E('idea_answered', { id: 'i3', answer: 'yes' }),
    ...[1, 2, 3, 4].map(n => E('assumption', { id: 'a' + n, project: 'alpha', q: 'Q' + n, a: 'A' + n })), E('assumption', { id: 'a5', project: 'beta', q: 'Qb', a: 'Ab' })];
  const b = (lg, knobs = KNOBS) => S.buildBrief({ project: ALPHA, lens: 'finish', wild: false, avoid: [], cfg, knobs, facts: [], st: S.derive(lg) }).text.split('\n');
  const t = b(log), at = t.indexOf('PAST IDEAS (do not repeat):');
  assert.deepEqual(t.slice(at + 1), ['- [no] First idea for alpha', '- [yes] Third idea for alpha', '- Tenth idea for alpha',
    'ASSUMED EARLIER (not confirmed by the owner):', '- Q2 -> A2', '- Q3 -> A3', '- Q4 -> A4', 'INBOX: 0 of 5 questions open for this project.']);
  assert.deepEqual(b(log, { ...KNOBS, pastIdeasInBrief: 2 }).slice(at + 1, at + 3), ['- [yes] Third idea for alpha', '- Tenth idea for alpha']);
  const asks = [1, 2, 3, 4, 5].map(n => E('idea_added', { id: 'i' + (20 + n), project: 'alpha', title: 'Open question ' + n, gate: n % 2 ? 'ask' : 'wait' }));
  assert.equal(b(asks.slice(0, 4)).at(-1), 'INBOX: 4 of 5 questions open for this project.');
  assert.equal(b(asks).at(-1), 'INBOX: full. Give only ideas with gate auto.');
});
test('brief: past ideas are halved until the brief fits, then the facts go, then it refuses', () => {
  const cfg = cfgWith({ limits: { briefMaxTokens: 600 } }), knobs = { ...KNOBS, pastIdeasInBrief: 40 }, log = [];
  for (let i = 1; i <= 60; i++) log.push(E('idea_added', { id: 'i' + i, project: 'alpha', title: `Idea number ${i} with a fairly long title that fills most of a line`, gate: 'auto' }));
  const st = S.derive(log), b = o => S.buildBrief({ project: ALPHA, lens: 'finish', wild: false, avoid: [], cfg, knobs, facts: ['fact one'], st, ...o });
  const r = b({}), shown = r.text.split('\n').filter(l => l.startsWith('- Idea number'));
  assert.ok(r.text.length <= 1500, String(r.text.length)); assert.ok([20, 10, 5, 2, 1].includes(r.pastShown), String(r.pastShown));
  assert.equal(r.tokens, S.estTokens(r.text)); assert.ok(r.tokens <= 600, String(r.tokens));
  assert.equal(shown.length, r.pastShown); assert.match(shown.at(-1), /^- Idea number 60 /); assert.match(r.text, /\nfact one\n/);
  const big = b({ facts: Array.from({ length: 30 }, (_, i) => `fact ${i} ` + 'x'.repeat(60)) });
  assert.match(big.text, /<facts>\n\(left out to save space\)\n<\/facts>/); assert.equal(big.pastShown, 0); assert.ok(big.text.length <= 1500); assert.ok(big.tokens <= 600);
  assert.throws(() => b({ project: { ...ALPHA, goal: 'g'.repeat(2000) } }), e => e instanceof S.StewardError && /too long even without facts/.test(e.message));
});

test('brief: the budget is in tokens, so the same number of Georgian letters can be refused where English fits', () => {
  const cfg = cfgWith({ limits: { briefMaxTokens: 600 } }), st = S.derive([]);
  const b = notes => S.buildBrief({ project: { ...ALPHA, notes }, lens: 'finish', wild: false, avoid: [], cfg, knobs: KNOBS, facts: ['fact one'], st });
  const base = b('').tokens, n = Math.floor((600 - base - 20) * 2.5);   // English letters that still fit beside the facts
  assert.ok(n >= 500, `room for ${n} letters`);
  const en = b('a'.repeat(n));
  assert.ok(en.tokens <= 600, String(en.tokens)); assert.match(en.text, /\nfact one\n/, 'English keeps the facts');
  assert.throws(() => b('ა'.repeat(n)), e => e instanceof S.StewardError && e.code === 1 && /too long even without facts/.test(e.message));   // 3 bytes a letter
});

// ---------------------------------------------------------------- the facts
test('facts: the six lines for a small git project, word for word', () => {
  assert.deepEqual(S.collectFacts({ path: w0.specs[0].path }, NOW0), [
    'git: branch main; last commit 3 days ago; 0 uncommitted files', 'recent commits: "Add the first function"; "Start the project"', 'files: 3 (js 1, json 1, md 1)',
    'TODO/FIXME markers: 1 (src/app.js 1)', 'npm scripts: test, build', 'has: README; missing: tests, CI, LICENSE, CHANGELOG']);
  assert.match(S.collectFacts({ path: w0.specs[0].path }, NOW0 - 3 * DAY)[0], /last commit today;/);
  assert.match(S.collectFacts({ path: w0.specs[0].path }, NOW0 - 2 * DAY)[0], /last commit 1 day ago;/);
});
test('facts: a folder that is not a git repository; one uncommitted file', () => {
  const dir = path.join(w0.dir, 'plain'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing to do here\n');
  assert.deepEqual(S.collectFacts({ path: dir }, NOW0), ['git: not a repository', 'files: 1 (txt 1)', 'TODO/FIXME markers: 0', 'has: nothing from the list; missing: README, tests, CI, LICENSE, CHANGELOG']);
  const w1 = mkWorld({ projects: ['solo'] }), d1 = w1.specs[0].path; fs.writeFileSync(path.join(d1, 'new.md'), 'x');
  assert.equal(S.collectFacts({ path: d1 }, NOW0)[0], 'git: branch main; last commit 3 days ago; 1 uncommitted file');
});
test('facts: private data in commit subjects, file names and the branch never reaches the brief', () => {
  const w1 = mkWorld({ projects: ['solo'] }), dir = w1.specs[0].path;
  fs.writeFileSync(path.join(dir, '2026-11-08-notes.md'), 'TODO one\nTODO two\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'Thanks jane.doe@gmail.com for the report');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'Call +1 415 555 0100 about the bug');
  git(dir, 'checkout', '-q', '-b', 'release-2026-11-08');
  const f = S.collectFacts({ path: dir }, NOW0);
  assert.deepEqual(f.slice(0, 4), ['git: branch unknown; last commit 3 days ago; 0 uncommitted files', 'recent commits: "Add the first function"; "Start the project"',
    'files: 4 (md 2, js 1, json 1)', 'TODO/FIXME markers: 3 (src/app.js 1)']);
  const all = f.join('\n');
  assert.deepEqual(scanPII(all), []); assert.doesNotMatch(all, /gmail|415|2026/);
});
// fake keys are built from parts at run time, so no file holds one a secret scanner would flag
const FAKE_ANT = 'sk-' + 'ant-api03-' + 'x'.repeat(24), FAKE_AWS = 'AK' + 'IA' + 'QWERTYUIOPASDFGH', FAKE_GH = 'gh' + 'p_' + 'a'.repeat(36);
test('facts: secret-shaped strings (the policy secretPatterns) in commit subjects, the branch and file names never reach the brief', () => {
  const w1 = mkWorld({ projects: ['solo'] }), dir = w1.specs[0].path;
  fs.writeFileSync(path.join(dir, `notes-${FAKE_GH}.md`), 'TODO one\nTODO two\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', `remove the leaked key ${FAKE_ANT}`);
  // the key straddles the 80-character cut of a subject: it is checked before the cut
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'rotate the old cloud credentials after the incident in the staging bucket ' + FAKE_AWS);
  git(dir, 'checkout', '-q', '-b', 'rotate-' + FAKE_ANT);
  const f = S.collectFacts({ path: dir }, NOW0);
  assert.deepEqual(f.slice(0, 4), ['git: branch unknown; last commit 3 days ago; 0 uncommitted files', 'recent commits: "Add the first function"; "Start the project"',
    'files: 4 (md 2, js 1, json 1)', 'TODO/FIXME markers: 3 (src/app.js 1)']);
  const brief = S.buildBrief({ project: ALPHA, lens: 'finish', wild: false, avoid: [], cfg: C(), knobs: KNOBS, facts: f, st: S.derive([]) }).text;
  for (const k of [FAKE_ANT, FAKE_AWS, FAKE_GH, 'sk-ant-', 'AKIA', 'ghp_']) assert.ok(!brief.includes(k), `${k.slice(0, 7)} must not reach the brief`);
  assert.deepEqual(S.secretHits(brief), []);
  assert.deepEqual(S.secretHits(`a ${FAKE_ANT} b`), ['secret']); assert.deepEqual(S.secretHits('write to jane.doe@gmail.com'), ['email']);
});
test('facts: node_modules, build folders, hidden folders and symlinks are left out; the walk stops at 4000 files', () => {
  const w1 = mkWorld({ projects: ['solo'] }), dir = w1.specs[0].path;
  for (const [d, f] of [['node_modules/pkg', 'index.js'], ['.cache', 'x.js'], ['dist', 'out.js']]) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, f), '// ' + 'TO' + 'DO left out\n'); }
  fs.symlinkSync(path.join(dir, 'src', 'app.js'), path.join(dir, 'link.js'));
  const f = S.collectFacts({ path: dir }, NOW0);
  assert.equal(f[2], 'files: 3 (js 1, json 1, md 1)'); assert.equal(f[3], 'TODO/FIXME markers: 1 (src/app.js 1)');
  const many = path.join(dir, 'many'); fs.mkdirSync(many);
  for (let i = 0; i < 4000; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(4, '0')}.txt`), '');
  assert.match(S.collectFacts({ path: dir }, NOW0)[2], /^files: 4000\+ \(count stopped\) \(txt /);
});
test('facts: the has line finds tests, CI, the licence and the changelog', () => {
  const w1 = mkWorld({ projects: ['solo'] }), dir = w1.specs[0].path;
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'app.test.js'), ''); fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT'); fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changes');
  assert.equal(S.collectFacts({ path: dir }, NOW0).at(-1), 'has: README, tests, CI, LICENSE, CHANGELOG; missing: nothing from the list');
});
test('facts: a marker counts only where a person left one (a comment or the start of a line), not where code or prose names the word', () => {
  // the words are built from parts so this test file does not count as markers itself when the steward visits this repository
  const T = 'TO' + 'DO', F = 'FIX' + 'ME', X = 'X' + 'XX', H = 'HA' + 'CK';
  const counted = [`// ${T}: handle the empty list`, `  /* ${F} later */`, ` * ${H} around the old bug`, `x(); // ${X} check this`, `# ${T} in a shell comment`,
    `<!-- ${T} -->`, `-- ${T} in SQL`, `- [ ] ${T} write the docs`, `${T} at the start of a line`];
  const notCounted = [`const re = /(${T}|${F})/;`, `lines.push('${T}/${F} markers');`, `// the ${T} count`, `const todo = "${F}";`];
  const w1 = mkWorld({ projects: ['solo'] }), dir = w1.specs[0].path;
  fs.writeFileSync(path.join(dir, 'm.js'), [...counted, ...notCounted].join('\n') + '\n');
  assert.equal(S.collectFacts({ path: dir }, NOW0).find(l => l.startsWith('TODO/FIXME')), 'TODO/FIXME markers: 10 (m.js 9, src/app.js 1)');
});

test('facts: when git status fails, the count is "unknown", never a made-up 0', () => {
  const w = mkWorld({ projects: ['solo'] }), dir = w.specs[0].path;
  fs.writeFileSync(path.join(dir, '.git', 'index'), 'junk');   // a corrupt index: status fails, log still works
  const facts = S.collectFacts({ path: dir }, NOW0);
  assert.equal(facts[0], 'git: branch main; last commit 3 days ago; uncommitted files unknown');
  assert.match(facts[1], /^recent commits: "Add the first function"; "Start the project"$/);
});
