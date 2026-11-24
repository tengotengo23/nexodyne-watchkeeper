// Tests Orchestrator Carbon High failover across wk-carbon-fallback, wk-job, wk-ask-claude, and steward-lib.
// P2-272 Q163: the fallback no longer runs Gemini; it queues a wk-task for Antigravity. These tests used to expect an agy
// call and a Gemini answer; they now expect a queued task and that the fake agy is never called (the kill and limit checks stay).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('.');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-carbon-'));
// A6: remove only the folder this run made with mkdtemp, after checking that it lies inside the temporary folder
function removeOwnTmp(dir) {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`not inside the temporary folder: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => removeOwnTmp(TMP));

function makeFakeAgy(dir) {
  const log = path.join(dir, 'agy-calls.jsonl');
  const bin = path.join(dir, 'fake-agy');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : '';
const mode = process.env.FAKE_AGY_MODE || 'ok';
if (mode === 'unavail_carbon' && model === 'gemini-4-carbon-high') {
  process.stderr.write('Error: Model gemini-4-carbon-high is not available on current plan\\n');
  process.exit(1);
}
const promptArg = args.find(a => a.startsWith('-p=')) || '';
if (promptArg.includes('[Output Format Requirement]') || process.env.FAKE_AGY_JSON === '1') {
  const payload = {
    ideas: [{
      project: 'alpha',
      kind: 'code',
      title: 'Speed up local checks',
      why: 'Tighter verification cycle',
      firstStep: 'Inspect test helper timings',
      impact: 2,
      effort: 1,
      links: [],
    }],
    qa: [],
  };
  process.stdout.write(JSON.stringify(payload) + '\\n');
  process.exit(0);
}
process.stdout.write([
  'Answer: Keep modular boundaries.',
  'Why: Keeps modules decoupled.',
  'Do or avoid: Prefer small single-purpose helpers.',
  'Waits for the owner: Nothing.',
  'Sources: README.md',
].join('\\n') + '\\n');
`,
    { mode: 0o755 },
  );
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []) };
}

// a real temp git repository with one commit (wk-task add needs one)
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = args => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  g(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  g(['add', 'README.md']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

// the wk-tasks queued under one WK_HOME: [{ id, files: {name: text} }]
function queuedTasks(wk) {
  const d = path.join(wk, 'tasks');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(x => !x.startsWith('.') && fs.statSync(path.join(d, x)).isDirectory()).map(id => ({
    id,
    all: fs.readdirSync(path.join(d, id)).filter(f => fs.statSync(path.join(d, id, f)).isFile()).map(f => fs.readFileSync(path.join(d, id, f), 'utf8')).join('\n'),
  }));
}

test('runCarbonHigh queues a wk-task for Antigravity (never runs agy) and respects KILL', async () => {
  const { runCarbonHigh, isClaudeLimitError } = await import('../bin/wk-carbon-fallback.mjs');
  assert.equal(isClaudeLimitError("You've hit your limit · resets 5am"), true);
  assert.equal(isClaudeLimitError({ api_error_status: 429 }), true);
  assert.equal(isClaudeLimitError('normal success'), false);

  const dir = path.join(TMP, 'unit');
  const wk = path.join(dir, 'wk');
  fs.mkdirSync(wk, { recursive: true });
  const fake = makeFakeAgy(dir);
  const repo = gitRepo(path.join(dir, 'repo'));
  const env = { ...process.env, HOME: dir, WK_HOME: wk, WK_AGY_BIN: fake.bin, WK_CARBON_FALLBACK: '1' };

  const res = await runCarbonHigh({ prompt: 'Inspect module layout', mode: 'plan', sandbox: true, cwd: repo, env, item: 'test-unit' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.queued, true);
  assert.equal(res.provider, 'antigravity-queue');
  assert.equal(res.effort, 'high');
  assert.ok(res.taskId);
  assert.match(res.text, /Queued for Antigravity/);
  let tasks = queuedTasks(wk);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].all, /Inspect module layout/);
  // A7: with no scope given, the queued task is answer-only (a wk-task without --allow could change any file)
  assert.match(tasks[0].all, /Answer only; change no files\./);
  assert.match(tasks[0].all, /"allow": \[\s*"\.watchkeeper-answer-only\/no-file-may-change"\s*\]/);

  // a schema request is queued too, with the schema in the task text; Gemini is never run
  const res2 = await runCarbonHigh({ prompt: 'Return idea json', schema: { type: 'object' }, cwd: repo, env: { ...env, FAKE_AGY_MODE: 'unavail_carbon', FAKE_AGY_JSON: '1' }, item: 'test-downgrade' });
  assert.equal(res2.ok, true);
  assert.equal(res2.queued, true);
  tasks = queuedTasks(wk);
  assert.equal(tasks.length, 2);
  assert.deepEqual(fake.calls(), [], 'agy must never be called');

  // a folder that is not a git repository cannot hold a task: a plain failure, still no agy
  const plain = path.join(dir, 'plain'); fs.mkdirSync(plain);
  const res3 = await runCarbonHigh({ prompt: 'No repo here', cwd: plain, env, item: 'test-plain' });
  assert.equal(res3.ok, false);
  assert.equal(res3.reason, 'queue_failed');
  assert.deepEqual(fake.calls(), []);

  // A1: agy missing (no WK_AGY_BIN, no agy on PATH) still queues; queueing runs nothing
  const noAgyEnv = { ...env, PATH: '/usr/bin:/bin' };
  delete noAgyEnv.WK_AGY_BIN;
  const resNoAgy = await runCarbonHigh({ prompt: 'No agy installed', cwd: repo, env: noAgyEnv, item: 'test-no-agy' });
  assert.equal(resNoAgy.ok, true, JSON.stringify(resNoAgy));
  assert.equal(resNoAgy.queued, true);
  assert.ok(resNoAgy.taskId);

  // A1: a Claude Code caller queues too (both markers), and agy is never run
  for (const extra of [{ CLAUDECODE: '1' }, { WK_CALLER: 'claude_code' }]) {
    const rc = await runCarbonHigh({ prompt: 'Asked from Claude', cwd: repo, env: { ...env, ...extra }, item: 'test-claude' });
    assert.equal(rc.ok, true, JSON.stringify(rc));
    assert.equal(rc.queued, true);
    assert.ok(rc.taskId);
  }

  // A5: a prompt longer than the task limit is cut first, so the scope and source note stays whole
  const resLong = await runCarbonHigh({ prompt: 'L'.repeat(25000), cwd: repo, env, item: 'test-long' });
  assert.equal(resLong.ok, true, JSON.stringify(resLong));
  const longTask = queuedTasks(wk).find(t => t.id === resLong.taskId);
  assert.ok(longTask);
  assert.match(longTask.all, /Answer only; change no files\. Queued by Watchkeeper for Antigravity because Claude's limits were tight; source: test-long\.\)/);

  // A7: an explicit scope, or an edit job's own folder, is passed to the task as --allow
  const resScoped = await runCarbonHigh({ prompt: 'Edit the docs', cwd: repo, env, item: 'test-scope', allow: ['docs/**'] });
  assert.equal(resScoped.ok, true, JSON.stringify(resScoped));
  assert.match(queuedTasks(wk).find(t => t.id === resScoped.taskId).all, /Change only files matching: docs\/\*\*/);
  const resEdit = await runCarbonHigh({ prompt: 'Edit the project', cwd: repo, env, item: 'test-edit', editCwd: true });
  assert.equal(resEdit.ok, true, JSON.stringify(resEdit));
  assert.match(queuedTasks(wk).find(t => t.id === resEdit.taskId).all, /Change only files matching: \*\*/);
  assert.match(queuedTasks(wk).find(t => t.id === resScoped.taskId).all, /"allow": \[\s*"docs\/\*\*"\s*\]/);
  assert.deepEqual(fake.calls(), [], 'agy must never be called');

  // KILL switch blocks execution cleanly
  const kRes = await runCarbonHigh({ prompt: 'Blocked', env, killCheck: () => true });
  assert.equal(kRes.ok, false);
  assert.equal(kRes.killed, true);
  assert.equal(kRes.reason, 'kill_switch');
});

// P2-272 Phase 4A fixes (A3): this test used to assert that the question was queued for Antigravity. The asker is Gemini
// (or Antigravity) itself, so queueing its own question is forbidden; it now asserts a plain failure and an empty queue.
test('wk-ask-claude fails plainly at Claude\'s limit and queues nothing', () => {
  const dir = path.join(TMP, 'ask');
  const wk = path.join(dir, 'wk');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(wk, { recursive: true });
  gitRepo(repo);
  const fake = makeFakeAgy(dir);
  const fakeClaude = path.join(dir, 'fake-claude');
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
process.stderr.write("API Error: 429 rate_limit exceeded\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'wk-ask-claude.mjs'), '--from', 'gemini', '--project', repo, 'Should we keep light theme secondary and preserve module tests?'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, WK_HOME: wk, WK_ASK_CLAUDE_BIN: fakeClaude, WK_CLAUDE: fakeClaude, WK_AGY_BIN: fake.bin, WK_CARBON_FALLBACK: '1', WK_ASK_CWD: repo },
      timeout: 15000,
    },
  );
  // not answered: exit 1 with the carry-on line, status failed, and nothing queued
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.match(r.stdout, /Carry on with the choice/);
  assert.doesNotMatch(r.stdout, /Queued for Antigravity/);
  const adviceDirs = fs.readdirSync(path.join(wk, 'advice')).filter(x => !x.startsWith('.'));
  assert.equal(adviceDirs.length, 1);
  const meta = JSON.parse(fs.readFileSync(path.join(wk, 'advice', adviceDirs[0], 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'failed');
  assert.equal(meta.error, 'Claude Code reached its usage limit; not answered');
  assert.ok(!meta.queued_task);
  assert.equal(queuedTasks(wk).length, 0);
  assert.deepEqual(fake.calls(), [], 'agy must never be called');
});

test('wk-job queues the job for Antigravity when Claude hits usage limit', async () => {
  const dir = path.join(TMP, 'job');
  const wk = path.join(dir, 'wk');
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(wk, { recursive: true });
  gitRepo(repo);
  fs.writeFileSync(path.join(wk, 'projects.json'), JSON.stringify({ projects: [{ key: 'proj', name: 'proj', path: repo, kind: 'repo' }] }));
  fs.writeFileSync(path.join(wk, 'remote.json'), JSON.stringify({}));
  const fake = makeFakeAgy(dir);
  const fakeClaudeJob = path.join(dir, 'fake-claude-job');
  fs.writeFileSync(
    fakeClaudeJob,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your limit · resets 5am" }));
process.exit(1);
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, HOME: dir, WK_HOME: wk, WK_CLAUDE_BIN: fakeClaudeJob, WK_AGY_BIN: fake.bin, WK_CARBON_FALLBACK: '1', WK_JOB_FREE_MB: '8000', WK_JOB_PACE_PCT: 'none' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-job.mjs'), 'start', '--project', 'proj', '--prompt', 'Audit README layout', '--mode', 'plan'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const jobId = (/Started (J-\d{8}-\d{4}-[0-9a-f]{4})/.exec(r.stdout) || [])[1];
  assert.ok(jobId, r.stdout);

  const deadline = Date.now() + 10000;
  let meta = null;
  while (Date.now() < deadline) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(wk, 'jobs', jobId, 'meta.json'), 'utf8'));
      if (['waiting', 'failed', 'stopped'].includes(m.state)) { meta = m; break; }
    } catch { /* wait */ }
    await new Promise(res => setTimeout(res, 50));
  }
  assert.equal(meta?.state, 'waiting', JSON.stringify(meta));
  assert.equal(meta?.provider, 'antigravity-queue');
  assert.match(meta?.last_text || '', /Queued for Antigravity as task/);
  assert.ok(meta?.queued_task);
  const tasks = queuedTasks(wk);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].all, /Audit README layout/);
  // A7: a plan-mode job is queued answer-only
  assert.match(tasks[0].all, /Answer only; change no files\./);
  assert.deepEqual(fake.calls(), [], 'agy must never be called');
});

test('steward visit is queued for Antigravity when weekly meter is exhausted', async () => {
  const dir = path.join(TMP, 'steward');
  const wk = path.join(dir, 'wk');
  const proj = path.join(dir, 'alpha');
  const stewardDir = path.join(wk, 'steward');
  fs.mkdirSync(stewardDir, { recursive: true });
  gitRepo(proj);
  const fake = makeFakeAgy(dir);
  const nowIso = '2026-11-22T12:00:00Z';
  const resetIso = '2026-11-29T00:00:00Z';
  const resetS = Math.floor(Date.parse(resetIso) / 1000);
  fs.writeFileSync(path.join(wk, 'projects.json'), JSON.stringify({ projects: [{ id: 'alpha', path: proj, weight: 1, paused: false }] }));
  fs.writeFileSync(
    path.join(stewardDir, 'meter.json'),
    JSON.stringify({ utilization: 0.99, fiveHour: 0.99, resetsAt: resetS, fetchedAt: nowIso, status: 'rejected', source: 'test' }),
  );
  fs.writeFileSync(
    path.join(wk, 'steward.json'),
    JSON.stringify({ mode: 'login', call: { lockMaxMin: 20, timeoutMs: 30000 } }),
  );

  const prev = { ...process.env };
  Object.assign(process.env, {
    HOME: dir,
    WK_HOME: wk,
    WK_STEWARD_DIR: stewardDir,
    WK_LEDGER: path.join(wk, 'ledger.jsonl'),
    WK_PROJECTS: path.join(wk, 'projects.json'),
    WK_NOW: nowIso,
    WK_WEEK_END: resetIso,
    WK_AGY_BIN: fake.bin,
    WK_CARBON_FALLBACK: '1',
    FAKE_AGY_JSON: '1',
  });
  try {
    const S = await import(`../bin/steward-lib.mjs?carbon=${Date.now()}`);
    const res = await S.tick({ force: true, project: 'alpha' });
    assert.equal(res.code, 0, JSON.stringify(res));
    assert.equal(res.outcome, 'queued');
    assert.equal(res.provider, 'antigravity-queue');
    assert.ok(res.taskId);
    assert.equal(queuedTasks(wk).length, 1);
    assert.deepEqual(fake.calls(), [], 'agy must never be called');
  } finally {
    for (const k of ['HOME', 'WK_HOME', 'WK_STEWARD_DIR', 'WK_LEDGER', 'WK_PROJECTS', 'WK_NOW', 'WK_WEEK_END', 'WK_AGY_BIN', 'WK_CARBON_FALLBACK', 'FAKE_AGY_JSON']) {
      if (k in prev) process.env[k] = prev[k];
      else delete process.env[k];
    }
  }
});

// S8 (P2-272 review): while a fallback task from the same named source is still open (queued or taken) in the same repo,
// a second request reuses it instead of queuing a duplicate. Different items, the generic item and finished tasks never merge.
test('queueForAntigravity reuses the open task for the same item and repo, and only then', async () => {
  const { queueForAntigravity, openTaskFor } = await import('../bin/wk-carbon-fallback.mjs');
  const dir = fs.mkdtempSync(path.join(TMP, 'reuse-'));
  const wk = path.join(dir, 'wk');
  const repo = gitRepo(path.join(dir, 'repo'));
  const fake = makeFakeAgy(dir);
  const env = { ...process.env, HOME: dir, WK_HOME: wk, WK_AGY_BIN: fake.bin };
  const a = queueForAntigravity({ prompt: 'Check the footer', cwd: repo, item: 'steward:site', env });
  assert.equal(a.ok, true, a.stderr);
  assert.equal(a.reused, undefined);
  assert.match(a.text, /Suggestions/);
  const b = queueForAntigravity({ prompt: 'Check the footer again', cwd: repo, item: 'steward:site', env });
  assert.equal(b.ok, true);
  assert.equal(b.reused, true);
  assert.equal(b.taskId, a.taskId);
  assert.match(b.text, new RegExp(`Task ${a.taskId} is still waiting for Antigravity, so nothing new was queued\\.`));
  assert.match(b.text, /Suggestions/);
  assert.equal(queuedTasks(wk).length, 1, 'the same item queued a second task');
  assert.equal(openTaskFor('steward:site', repo, env), a.taskId);

  const c = queueForAntigravity({ prompt: 'Another item', cwd: repo, item: 'steward:other', env });
  assert.equal(c.reused, undefined);
  assert.notEqual(c.taskId, a.taskId);
  const g1 = queueForAntigravity({ prompt: 'Generic one', cwd: repo, env });
  const g2 = queueForAntigravity({ prompt: 'Generic two', cwd: repo, env });
  assert.equal(g1.reused, undefined);
  assert.equal(g2.reused, undefined);
  assert.notEqual(g1.taskId, g2.taskId, 'the generic item must never merge');
  assert.equal(queuedTasks(wk).length, 4);

  // a finished task (done, merged or discarded) no longer blocks a new one for the same item
  for (const status of ['done', 'merged', 'discarded']) {
    const open = openTaskFor('steward:site', repo, env);
    assert.ok(open, `an open task is expected before marking it ${status}`);
    const metaPath = path.join(wk, 'tasks', open, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.status = status;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    assert.equal(openTaskFor('steward:site', repo, env), '');
    const n = queueForAntigravity({ prompt: `After ${status}`, cwd: repo, item: 'steward:site', env });
    assert.equal(n.reused, undefined, `a ${status} task was reused`);
    assert.notEqual(n.taskId, open);
  }
  assert.equal(queuedTasks(wk).length, 7);
  assert.equal(fake.calls().length, 0, 'agy was started');
});

// S11 (P2-272 review): the kept agy chain throws before it can start anything.
test('legacyAgyChain throws the canon refusal and never starts agy', async () => {
  const { legacyAgyChain, NEVER_AGY } = await import('../bin/wk-carbon-fallback.mjs');
  const dir = fs.mkdtempSync(path.join(TMP, 'legacy-'));
  const fake = makeFakeAgy(dir);
  await assert.rejects(
    legacyAgyChain({ agyBin: fake.bin, g: null, prompt: 'x', system: '', schema: null, cwd: dir, mode: 'ask', sandbox: true, timeoutMs: 1000, killCheck: () => false, item: 'x', env: { ...process.env, HOME: dir } }),
    { message: NEVER_AGY },
  );
  assert.equal(NEVER_AGY, 'Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.');
  assert.equal(fake.calls().length, 0);
});
