'use strict';
// P2-272 4B (brief-P4B.md B1 and B4): the panel side of the task splitter.
// The engine (core/wk_cli.py dag …) is replaced by a fake CLI and a fake run process; sessions are real
// (panel/src/chat-sessions.js) in a temp data folder made with mkdtemp. No network, no git, no Python.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DagRunner, cardFromManifest, cliArgv, ARCHIVE_REASON, WAIT_POLL_MS } = require('../src/dag-runner');
const CS = require('../src/chat-sessions');
const R = require('../src/render');
const D = require('../src/data');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-dagrun-'));
function removeOwnTmp(dir) {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`not inside the temporary folder: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => removeOwnTmp(TMP));

const EVIL = '<img src=x onerror="window.__xss=1">Fix the "quotes" & <b>tags</b>';
const RUN = '20261124-030000-abcd';

function manifest(status = 'planned', steps = {}) {
  return {
    id: RUN, status, task: 'Split the footer and the header', branch: 'main',
    nodes: [
      { id: 'n1', title: 'Header', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', dependsOn: [], ownedGlobs: ['src/header/**'], verifyCmd: 'npm test' },
      { id: 'n2', title: 'Footer', provider: 'gemini', model: 'gemini', effort: 'medium', dependsOn: ['n1'], ownedGlobs: ['src/footer/**'], verifyCmd: 'npm test' },
    ],
    waves: [['n1'], ['n2']],
    steps,
  };
}

// A fake engine CLI: answers by action, and records every call.
function fakeCli(answers) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args.slice());
    const a = answers[args[0]];
    return typeof a === 'function' ? a(args) : a;
  };
  fn.calls = calls;
  fn.actions = () => calls.map(c => c[0]);
  return fn;
}

// A run process the test ends by hand.
function fakeSpawn() {
  let finish;
  const fn = (runId) => { fn.started.push(runId); return new Promise(res => { finish = res; }); };
  fn.started = [];
  fn.finish = (code = 0) => finish(code);
  return fn;
}

let n = 0;
function setup({ answers = {}, kill = false, viewing = '' } = {}) {
  const dataDir = path.join(TMP, `data-${++n}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const sess = CS.createChatSession(dataDir, { title: 'Split task', promptMode: 'reprompt' });
  const turn = { id: CS.makeTurnId ? CS.makeTurnId() : 'T-abc123def', createdAt: Date.now(), status: 'preparing', rawPrompt: 'Split the footer and the header', steps: [] };
  CS.upsertTurn(dataDir, sess.id, turn);
  const cli = fakeCli({ plan: { ok: true, run: manifest() }, ...answers });
  const spawnRun = fakeSpawn();
  const archived = [];
  const view = { id: viewing };
  const st = { kill };
  const dag = new DagRunner({
    paths: () => ({ dataDir }),
    cli, spawnRun,
    archive: (dir, id, reason, now) => { archived.push({ id, reason }); return CS.archiveChatSession(dir, id, reason, now); },
    isKill: () => st.kill,
    viewing: () => view.id,
    triage: async () => ({ route: 'plan', reason: 'two areas' }),
    pollMs: 60000,
  });
  const stored = () => (CS.getChatSession(dataDir, sess.id) || { turns: [] }).turns.find(t => t.id === turn.id);
  return { dataDir, sid: sess.id, turn, tid: turn.id, cli, spawnRun, archived, view, st, dag, stored };
}

async function planned(o) {
  const s = setup(o);
  assert.equal(await s.dag.maybePlan(s.sid, s.turn, { prompt: 'Split the footer and the header', repo: TMP, route: 'auto' }), true);
  return s;
}

const tick = () => new Promise(res => setImmediate(res));

test('B1: the plan card waits for the click; nothing runs before it', async () => {
  const s = await planned();
  const t = s.stored();
  assert.equal(t.dag.phase, 'plan');
  assert.equal(t.status, 'awaiting_confirm');
  assert.equal(t.dag.nodes.length, 2);
  assert.deepEqual(s.cli.actions(), ['plan']);
  assert.equal(s.spawnRun.started.length, 0);
});

test('B1: "Not now" on the plan runs nothing and keeps the session', async () => {
  const s = await planned();
  assert.equal(s.dag.notNow(s.sid, s.tid), true);
  const t = s.stored();
  assert.equal(t.dag.phase, 'declined-plan');
  assert.equal(t.dag.message, 'Not run. Nothing was changed.');
  assert.equal(t.status, 'done');
  assert.deepEqual(s.cli.actions(), ['plan']);
  assert.equal(s.spawnRun.started.length, 0);
  assert.equal(s.archived.length, 0);
  assert.ok(CS.getChatSession(s.dataDir, s.sid), 'the session stays in the list');
  // a late "Run these steps" after "Not now" does nothing either
  assert.equal(await s.dag.run(s.sid, s.tid), false);
  assert.equal(s.spawnRun.started.length, 0);
});

test('B1: only the auto route with a "plan" triage makes a card', async () => {
  for (const opts of [{ route: 'claude' }, { route: 'auto', raw: true }, { route: 'auto', repo: '' }]) {
    const s = setup();
    assert.equal(await s.dag.maybePlan(s.sid, s.turn, { prompt: 'x', repo: TMP, ...opts }), false);
    assert.deepEqual(s.cli.actions(), []);
  }
  const s = setup();
  s.dag.triage = async () => ({ route: 'single', reason: 'one file' });
  assert.equal(await s.dag.maybePlan(s.sid, s.turn, { prompt: 'x', repo: TMP, route: 'auto' }), false);
  assert.deepEqual(s.cli.actions(), []);
  // a one-node plan runs on the single route
  const one = setup({ answers: { plan: { ok: true, run: { ...manifest(), nodes: manifest().nodes.slice(0, 1), waves: [['n1']] } } } });
  assert.equal(await one.dag.maybePlan(one.sid, one.turn, { prompt: 'x', repo: TMP, route: 'auto' }), false);
});

test('B1: the real triage (bin/dag-lib.mjs) sends a simple question to the single route', async () => {
  const s = setup();
  const root = path.resolve(__dirname, '..', '..');
  const dag = new DagRunner({ paths: () => ({ dataDir: s.dataDir }), root, cli: s.cli, spawnRun: s.spawnRun, isKill: () => false });
  assert.equal(await dag.maybePlan(s.sid, s.turn, { prompt: 'What does this function return?', repo: TMP, route: 'auto' }), false);
  assert.deepEqual(s.cli.actions(), []);
});

test('B1: the Stop switch blocks the run and the merge', async () => {
  const s = await planned({ kill: true });
  assert.equal(await s.dag.run(s.sid, s.tid), false);
  assert.equal(s.spawnRun.started.length, 0);
  assert.match(s.stored().dag.message, /Stop switch is on/);
  assert.equal(s.stored().dag.phase, 'plan');
});

test('B1: a passed run offers the merge and waits for its click; merge then archives with task-done', async () => {
  const s = await planned({ answers: {
    status: { ok: true, run: manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed' } }) },
    merge: { ok: true, message: 'Merged into main. Nothing was pushed.' },
  } });
  const p = s.dag.run(s.sid, s.tid);
  await tick();
  assert.equal(s.stored().dag.phase, 'running');
  assert.equal(s.stored().status, 'running');
  s.spawnRun.finish(0);
  await p;
  const t = s.stored();
  assert.equal(t.dag.phase, 'merge-offer');
  assert.equal(t.status, 'awaiting_confirm');
  assert.equal(t.dag.steps.n1.state, 'passed');
  assert.ok(!s.cli.actions().includes('merge'), 'no merge before the click');
  assert.equal(s.archived.length, 0, 'no archive before the click');
  assert.equal(await s.dag.merge(s.sid, s.tid), true);
  assert.deepEqual(s.cli.calls.find(c => c[0] === 'merge'), ['merge', RUN]);
  assert.ok(!s.cli.calls.some(c => c.includes('push')), 'never a push');
  assert.deepEqual(s.archived, [{ id: s.sid, reason: ARCHIVE_REASON }]);
  assert.equal(ARCHIVE_REASON, 'task-done');
  assert.equal(CS.getChatSession(s.dataDir, s.sid), null);
  assert.ok(CS.listArchivedChatSessions(s.dataDir).some(a => a.id === s.sid));
});

test('B1: "Not now" on the merge leaves the branch, finishes the task and archives', async () => {
  const s = await planned({ answers: { status: { ok: true, run: manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed' } }) } } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  assert.equal(s.dag.mergeNo(s.sid, s.tid), true);
  assert.ok(!s.cli.actions().includes('merge'));
  assert.deepEqual(s.archived, [{ id: s.sid, reason: 'task-done' }]);
});

test('B1: while the owner views the session, the archive waits until they leave it', async () => {
  const s = await planned({ answers: { status: { ok: true, run: manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed' } }) } } });
  s.view.id = s.sid;
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  s.dag.mergeNo(s.sid, s.tid);
  assert.equal(s.archived.length, 0);
  assert.ok(CS.getChatSession(s.dataDir, s.sid));
  assert.equal(s.dag.onLeave(s.sid), 'deferred', 'still viewing');
  s.view.id = 'WKS-20261124-000000-ffff';
  assert.equal(s.dag.onLeave(s.sid), 'archived');
  assert.deepEqual(s.archived, [{ id: s.sid, reason: 'task-done' }]);
});

test('B1: never archive while a turn is busy; archive once it is not', async () => {
  const s = await planned({ answers: { status: { ok: true, run: manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed' } }) } } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  // the owner sends another prompt in the same session; it is still running
  const busy = { id: 'T-zzz999busy', createdAt: Date.now(), status: 'running', rawPrompt: 'And the sidebar', steps: [] };
  CS.upsertTurn(s.dataDir, s.sid, busy);
  s.dag.mergeNo(s.sid, s.tid);
  assert.equal(s.archived.length, 0);
  assert.ok(CS.getChatSession(s.dataDir, s.sid), 'kept while busy');
  // the busy check in archiveChatSession holds too, if it is reached
  assert.throws(() => CS.archiveChatSession(s.dataDir, s.sid, 'task-done'), e => e.code === 'SESSION_BUSY');
  assert.equal(s.dag.tryArchive(s.sid), 'busy');
  CS.upsertTurn(s.dataDir, s.sid, { ...busy, status: 'done' });
  assert.equal(s.dag.onLeave(s.sid), 'archived');
});

test('B1: a failed run keeps the session with the reason in plain words', async () => {
  const s = await planned({ answers: { status: { ok: true, run: { ...manifest('failed', { n1: { state: 'failed', reason: 'npm test failed' }, n2: { state: 'skipped' } }), message: 'Step n1: the check failed.' } } } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(1); await p;
  const t = s.stored();
  assert.equal(t.dag.phase, 'failed');
  assert.equal(t.status, 'error');
  assert.match(t.dag.message, /A step failed, so the run stopped there\. Everything is kept\. Step n1: the check failed\./);
  assert.equal(t.dag.steps.n1.reason, 'npm test failed');
  assert.equal(s.archived.length, 0);
  assert.ok(CS.getChatSession(s.dataDir, s.sid));
  assert.equal(await s.dag.merge(s.sid, s.tid), false, 'no merge after a failure');
  assert.equal(s.dag.onLeave(s.sid), '', 'nothing waits to be archived');
});

test('B1: a run that ends without a known state is kept, not archived', async () => {
  const s = await planned({ answers: { status: { ok: true, run: manifest('running', { n1: { state: 'running' } }) } } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(3); await p;
  assert.equal(s.stored().dag.phase, 'failed');
  assert.match(s.stored().dag.message, /without a result \(exit 3\)\. Everything is kept/);
  assert.equal(s.archived.length, 0);
});

test('B1: Stop mid-run asks the engine to stop, deletes nothing, and keeps the session', async () => {
  const keep = path.join(TMP, 'fake-worktree');
  fs.mkdirSync(keep, { recursive: true }); fs.writeFileSync(path.join(keep, 'work.txt'), 'kept\n');
  let stopped = false;
  const s = await planned({ answers: {
    status: () => ({ ok: true, run: stopped ? manifest('stopped', { n1: { state: 'stopped' }, n2: { state: 'pending' } }) : manifest('running', { n1: { state: 'running' } }) }),
    stop: () => { stopped = true; return { ok: true, run: manifest('stopped', { n1: { state: 'stopped' } }) }; },
  } });
  const p = s.dag.run(s.sid, s.tid);
  await tick();
  await s.dag.poll(RUN);
  assert.equal(s.stored().dag.steps.n1.state, 'running', 'progress reaches the card');
  assert.equal(await s.dag.stop(s.sid, s.tid), true);
  assert.deepEqual(s.cli.calls.find(c => c[0] === 'stop'), ['stop', RUN]);
  s.spawnRun.finish(130);
  await p;
  const t = s.stored();
  assert.equal(t.dag.phase, 'stopped');
  assert.equal(t.status, 'cancelled');
  assert.equal(t.dag.message, 'Stopped. Nothing was deleted; the work folders are kept.');
  assert.deepEqual([...new Set(s.cli.actions())].sort(), ['plan', 'status', 'stop'], 'no merge, no clean-up');
  assert.equal(fs.readFileSync(path.join(keep, 'work.txt'), 'utf8'), 'kept\n');
  assert.equal(s.archived.length, 0);
  assert.ok(CS.getChatSession(s.dataDir, s.sid));
});

test('B1: a waiting run shows the queued Antigravity task', async () => {
  const s = await planned({ answers: { status: { ok: true, run: manifest('waiting', { n1: { state: 'passed' }, n2: { state: 'queued', taskId: '20261124-031500-gem1' } }) } } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  const t = s.stored();
  assert.equal(t.dag.phase, 'waiting');
  assert.equal(t.status, 'queued');
  assert.equal(t.dag.message, 'Queued for Antigravity as task 20261124-031500-gem1. Antigravity takes it when you run /wk-take-task there.');
  assert.equal(s.archived.length, 0);
});

test('B4: the plan card shows hostile node titles, globs, checks and branch names as text', () => {
  const man = manifest('planned', { n2: { state: 'queued', taskId: 'task-1', reason: EVIL } });
  man.branch = EVIL; man.task = EVIL;
  for (const node of man.nodes) { node.title = EVIL; node.ownedGlobs = [EVIL, 'src/**']; node.verifyCmd = EVIL; node.model = EVIL; node.effort = EVIL; }
  const card = cardFromManifest(man);
  for (const phase of ['plan', 'running', 'waiting', 'merge-offer', 'failed', 'stopped']) {
    const t = { id: 'T-abc123def', status: 'awaiting_confirm', dag: { ...card, phase, message: EVIL } };
    const html = R.dagCard(t, 'WKS-20261124-030000-abcd', false);
    assert.ok(!html.includes('<img'), phase + ': raw <img');
    assert.ok(!html.includes('<b>tags'), phase + ': raw <b>');
    assert.ok(html.includes('&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'), phase + ': escaped text shown');
    // escaped text holds no '<', so every '<…>' is a real tag: none may carry an on* handler
    for (const tag of html.match(/<[^>]*>/g) || []) assert.ok(!/\son[a-z]+\s*=/i.test(tag), phase + ': inline handler in ' + tag);
    assert.ok(!/javascript:/i.test(html));
  }
  const plan = R.dagCard({ id: 'T-abc123def', status: 'awaiting_confirm', dag: { ...card, phase: 'plan' } }, 'WKS-20261124-030000-abcd', false);
  assert.match(plan, /data-cmd="dagRun"/);
  assert.match(plan, /data-cmd="dagNotNow"/);
  assert.match(plan, />Run these steps</);
  const merge = R.dagCard({ id: 'T-abc123def', status: 'awaiting_confirm', dag: { ...card, phase: 'merge-offer', branch: 'main' } }, 'WKS-20261124-030000-abcd', false);
  assert.match(merge, /data-cmd="dagMerge"/);
  assert.match(merge, /Merge into main/);
  // an untrusted folder disables the run button
  const un = R.dagCard({ id: 'T-abc123def', status: 'awaiting_confirm', dag: { ...card, phase: 'plan' } }, 'WKS-20261124-030000-abcd', true);
  assert.match(un, /data-cmd="dagRun"[^>]*disabled|disabled[^>]*data-cmd="dagRun"/);
});

test('B1: the plan-card commands are validated (ids only)', () => {
  for (const cmd of ['dagRun', 'dagNotNow', 'dagStop', 'dagMerge', 'dagMergeNo', 'dagCheck']) {
    const ok = D.validateMessage({ cmd, sessionId: 'WKS-20261124-030000-abcd', turnId: 'T-abc123def', runId: '../../x' });
    assert.equal(ok.ok, true, cmd);
    assert.deepEqual(ok.msg, { cmd, sessionId: 'WKS-20261124-030000-abcd', turnId: 'T-abc123def' });
    assert.equal(D.validateMessage({ cmd, sessionId: '../x', turnId: 'T-abc123def' }).ok, false);
    assert.equal(D.validateMessage({ cmd, sessionId: 'WKS-20261124-030000-abcd', turnId: '<img>' }).ok, false);
  }
});

// ---- Phase 4 review fixes (M3, M4, S4, S7, N5, N6) ----
const WAITING = (taskStatus) => manifest('waiting', { n1: { state: 'passed' }, n2: { state: 'queued', taskId: '20261124-031500-gem1', taskStatus } });
async function waiting(answers) {
  const s = await planned({ answers: { status: { ok: true, run: WAITING('queued') }, ...answers } });
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  assert.equal(s.stored().dag.phase, 'waiting');
  return s;
}

test('M3: the waiting card says what to do next and offers Check again beside Stop', async () => {
  const s = await waiting();
  const t = s.stored();
  assert.equal(t.dag.hint, 'Waits for you: run /wk-take-task in Antigravity, then press Check again.');
  const html = R.dagCard(t, s.sid, false);
  assert.match(html, /data-cmd="dagCheck"[^>]*>Check again</);
  assert.match(html, /data-cmd="dagStop"/);
  assert.match(html, /id="dag-check-/);
  assert.ok(html.includes('Waits for you: run /wk-take-task in Antigravity, then press Check again.'));
  assert.ok(!/data-cmd="dagRun"/.test(html), 'no Run button while waiting');
  s.dag.dispose();
});

test('M3: Check again before Antigravity has finished runs nothing; after it, the run continues', async () => {
  let taskStatus = 'queued', spawned = 0;
  const s = await waiting({ status: () => ({ ok: true, run: spawned >= 2 ? manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed', taskId: '20261124-031500-gem1' } }) : WAITING(taskStatus) }) });
  const origSpawn = s.dag.spawnRun;
  s.dag.spawnRun = (id) => { spawned += 1; return origSpawn(id); };
  spawned = 1;  // the first run already happened
  assert.equal(await s.dag.checkAgain(s.sid, s.tid), false);
  assert.equal(spawned, 1, 'nothing ran while the task is queued');
  assert.match(s.stored().dag.message, /^Antigravity has not finished yet\. Queued for Antigravity as task 20261124-031500-gem1/);
  assert.equal(s.stored().dag.phase, 'waiting');
  taskStatus = 'taken';
  assert.equal(await s.dag.checkAgain(s.sid, s.tid), false);
  assert.equal(spawned, 1, 'a taken task is not finished either');
  taskStatus = 'verified';
  const p = s.dag.checkAgain(s.sid, s.tid);
  await tick(); await tick();
  assert.equal(spawned, 2, 'the run continues once');
  assert.equal(s.stored().dag.phase, 'running');
  s.spawnRun.finish(0);
  assert.equal(await p, true);
  assert.equal(s.stored().dag.phase, 'merge-offer');
  assert.ok(!s.cli.actions().includes('merge'), 'Check again never merges');
  s.dag.dispose();
});

test('M3: the optional wait check calls status only, at most once a minute, and saves only on a change', async () => {
  let taskStatus = 'queued';
  const s = await waiting({ status: () => ({ ok: true, run: WAITING(taskStatus) }) });
  assert.ok(s.dag.waitTimers.has(RUN), 'a waiting card gets the minute check');
  assert.equal(new DagRunner({ waitPollMs: 10 }).waitPollMs, WAIT_POLL_MS);
  assert.equal(WAIT_POLL_MS, 60000);
  let saves = 0;
  const realSave = s.dag.save.bind(s.dag);
  s.dag.save = (...a) => { saves += 1; return realSave(...a); };
  const before = s.cli.calls.length;
  assert.equal(await s.dag.waitPoll(RUN), false, 'no change: nothing saved');
  assert.equal(saves, 0);
  taskStatus = 'verified';
  assert.equal(await s.dag.waitPoll(RUN), true);
  assert.equal(saves, 1);
  assert.equal(s.stored().dag.hint, 'Antigravity has finished task 20261124-031500-gem1. Press Check again to take its work.');
  assert.equal(await s.dag.waitPoll(RUN), false, 'the same answer again: nothing saved');
  assert.equal(saves, 1);
  assert.deepEqual([...new Set(s.cli.calls.slice(before).map(c => c[0]))], ['status'], 'status only');
  assert.equal(s.spawnRun.started.length, 1, 'the wait check never runs anything');
  s.dag.dispose();
  assert.equal(s.dag.waitTimers.size, 0);
});

test('M4: at start-up every stored running or waiting turn is checked; a closed window shows as stopped', async () => {
  const msg = 'Stopped: the window closed or the process ended. Your work is kept in /tmp/x/.wk/dag/' + RUN + '.';
  let engine = 'stopped';
  const s = await planned({ answers: { status: () => ({ ok: true, run: engine === 'stopped'
    ? { ...manifest('stopped', { n1: { state: 'stopped' } }), message: msg }
    : manifest('running', { n1: { state: 'running' } }) }) } });
  const t = s.stored(); t.dag.phase = 'running'; t.status = 'running'; CS.upsertTurn(s.dataDir, s.sid, t);
  assert.equal(await s.dag.reconcileAll(), 1);
  assert.equal(s.stored().dag.phase, 'stopped');
  assert.equal(s.stored().dag.message, msg);
  assert.equal(s.stored().status, 'cancelled');
  assert.deepEqual([...new Set(s.cli.actions())].sort(), ['plan', 'status'], 'reconcile only reads');
  // a run the engine still runs (another window) shows as running
  const t2 = s.stored(); t2.dag.phase = 'waiting'; CS.upsertTurn(s.dataDir, s.sid, t2);
  engine = 'running';
  assert.equal(await s.dag.reconcileAll(), 1);
  assert.equal(s.stored().dag.phase, 'running');
  assert.equal(s.stored().dag.message, 'Running in another window.');
  // finished turns are left alone
  const t3 = s.stored(); t3.dag.phase = 'merged'; CS.upsertTurn(s.dataDir, s.sid, t3);
  const calls = s.cli.calls.length;
  assert.equal(await s.dag.reconcileAll(), 0);
  assert.equal(s.cli.calls.length, calls);
  assert.equal(s.spawnRun.started.length, 0, 'reconcile never runs anything');
  s.dag.dispose();
});

test('S4: Stop on a waiting run says the Antigravity task stays in the queue', async () => {
  const s = await waiting({ stop: { ok: true, run: manifest('stopped', { n1: { state: 'passed' }, n2: { state: 'queued', taskId: '20261124-031500-gem1' } }) } });
  assert.equal(await s.dag.stop(s.sid, s.tid), true);
  const t = s.stored();
  assert.equal(t.dag.phase, 'stopped');
  assert.equal(t.dag.message, 'Stopped. Nothing was deleted; the work folders are kept. The Antigravity task 20261124-031500-gem1 stays in the queue; Watchkeeper never deletes it.');
  assert.equal(t.dag.hint, undefined);
  assert.equal(s.dag.waitTimers.size, 0, 'the wait check stops');
  assert.ok(!s.cli.actions().some(a => /delete|clean|remove/.test(a)));
  s.dag.dispose();
});

test('N6: "Not now" on the merge says how to merge later and where the work is', async () => {
  const s = await planned({ answers: { status: { ok: true, run: { ...manifest('passed', { n1: { state: 'passed' }, n2: { state: 'passed' } }), integration: '/w/.wk/dag/' + RUN + '/integ' } } } });
  s.view.id = s.sid; // the owner is viewing, so the archive waits and the words can be read
  const p = s.dag.run(s.sid, s.tid); await tick(); s.spawnRun.finish(0); await p;
  assert.equal(s.dag.mergeNo(s.sid, s.tid), true);
  assert.match(s.stored().dag.message, new RegExp(`To merge later, run: wk dag merge ${RUN}\\. The work is in /w/\\.wk/dag/${RUN}/integ\\.$`));
});

test('S7: "Still planning" shows only for a slow planner, never flashes, and clears; N5: the prompt goes after --', async () => {
  // quick planner: never shown
  const quick = setup();
  quick.dag.planningShowMs = 200;
  const seen = [];
  const realSave = quick.dag.save.bind(quick.dag);
  quick.dag.save = (sid, turn) => { seen.push(!!turn.planning); return realSave(sid, turn); };
  assert.equal(await quick.dag.maybePlan(quick.sid, quick.turn, { prompt: '--repo /etc', repo: TMP, route: 'auto' }), true);
  assert.ok(!seen.includes(true), 'a quick plan never shows "Still planning"');
  const call = quick.cli.calls.find(c => c[0] === 'plan');
  assert.deepEqual(call, ['plan', '--repo', TMP, '--only-split', '--', '--repo /etc']);
  // slow planner: shown once, then cleared
  let release;
  const slow = setup({ answers: { plan: () => new Promise(res => { release = () => res({ ok: true, run: manifest() }); }) } });
  slow.dag.planningShowMs = 5;
  const p = slow.dag.maybePlan(slow.sid, slow.turn, { prompt: 'x', repo: TMP, route: 'auto' });
  await new Promise(res => setTimeout(res, 40));
  assert.equal(slow.stored().planning, true);
  const sess = CS.getChatSession(slow.dataDir, slow.sid);
  assert.match(R.renderChatThread({ activeSession: sess }), /role="status">[\s\S]*Still planning the steps…/);
  const quiet = { ...sess, turns: sess.turns.map(t => ({ ...t, planning: undefined })) };
  assert.ok(!R.renderChatThread({ activeSession: quiet }).includes('Still planning'), 'not before the wait');
  release();
  assert.equal(await p, true);
  assert.equal(slow.stored().planning, undefined, 'cleared when the plan arrives');
});

test('N5: the engine CLI gets --json right after the action, and the prompt after --', () => {
  assert.deepEqual(cliArgv('/r', ['plan', '--repo', '/x', '--only-split', '--', '--evil']),
    [path.join('/r', 'core', 'wk_cli.py'), 'dag', 'plan', '--json', '--repo', '/x', '--only-split', '--', '--evil']);
  assert.deepEqual(cliArgv('/r', ['status', RUN]), [path.join('/r', 'core', 'wk_cli.py'), 'dag', 'status', '--json', RUN]);
});
