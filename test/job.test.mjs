// P2-227: wk-job, the phone's Claude Code jobs. A temp HOME and WK_HOME; claude is test/fixtures/fake-claude-job.mjs (WK_CLAUDE_BIN).
// Nothing here starts the real claude or touches the real ~/.wk, ~/.claude or ~/Projects.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-job-'));
const WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK;
const BIN = path.resolve('bin/wk-job.mjs'), FAKE = path.resolve('test/fixtures/fake-claude-job.mjs');
const J = await import('../bin/wk-job.mjs');
const { FORBIDDEN, claudeArgv, systemLine } = J;

// the projects: one repository, one monorepo with a product folder
const REPO = path.join(HOME, 'Projects', 'alpha'), MONO = path.join(HOME, 'Projects', 'mono');
for (const d of [REPO, path.join(MONO, 'shop')]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(REPO, '.git')); fs.mkdirSync(path.join(MONO, '.git'));
const ORCH = path.join(HOME, 'orch'); fs.mkdirSync(ORCH);
fs.mkdirSync(WK, { recursive: true });
fs.writeFileSync(path.join(WK, 'projects.json'), JSON.stringify({ projects: [
  { key: 'alpha', name: 'alpha', path: '~/Projects/alpha', kind: 'repo' },
  { key: 'shop', name: 'mono/shop', path: '~/Projects/mono/shop', kind: 'folder', repo: '~/Projects/mono' },
] }));
const setRemote = o => fs.writeFileSync(path.join(WK, 'remote.json'), JSON.stringify({ orchestration: ORCH, ...o }));
setRemote({});

const LOG = path.join(HOME, 'fake.jsonl');
const baseEnv = { ...process.env, HOME, WK_HOME: WK, WK_CLAUDE_BIN: FAKE, FAKE_JOB_LOG: LOG, WK_JOB_FREE_MB: '8000', WK_JOB_PACE_PCT: 'none', WK_JOB_KILL_MS: '600' };
for (const k of ['FAKE_JOB_MODE', 'FAKE_JOB_IGNORE_TERM', 'FAKE_JOB_CHILD_PID', 'FAKE_JOB_SECRET', 'FAKE_JOB_SECRET_TEXT', 'FAKE_JOB_SESSION', 'WK_JOB_WALL_MS', 'CLAUDE_PROJECT_DIR']) delete baseEnv[k];
const job = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 20000 });
const idOf = r => (/Started (J-\d{8}-\d{4}-[0-9a-f]{4})/.exec(r.stdout) || [])[1];
const meta = id => JSON.parse(fs.readFileSync(path.join(WK, 'jobs', id, 'meta.json'), 'utf8'));
const events = id => fs.readFileSync(path.join(WK, 'jobs', id, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const fakeCalls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const wait = async (fn, ms = 12000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };
const until = (id, states) => wait(() => { try { const m = meta(id); return states.includes(m.state) ? m : null; } catch { return null; } });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const start = (extra = [], env = {}, prompt = 'Fix the footer') => job(['start', '--project', 'alpha', '--from', 'phone', '--prompt', prompt, ...extra], env);
const stopAll = async () => { for (const id of fs.readdirSync(path.join(WK, 'jobs'))) { const m = meta(id); if (['running', 'queued'].includes(m.state)) { job(['stop', id]); await until(id, ['stopped', 'failed', 'waiting', 'done']); } } };

test('the argv is exactly the brief\'s, for every model and mode, and no forbidden flag can be in it', () => {
  const id = 'J-20261116-1902-a3f9';
  assert.deepEqual(claudeArgv({ id, model: 'sonnet', mode: 'auto', max_turns: 150 }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--model', 'sonnet', '--max-turns', '150', '--append-system-prompt', systemLine(id)]);
  assert.deepEqual(claudeArgv({ id, model: 'opus', mode: 'plan', max_turns: 3, session_id: 'sess-9' }).slice(-2), ['--resume', 'sess-9']);
  assert.match(systemLine(id), /^Started from the owner's phone through Watchkeeper \(job J-20261116-1902-a3f9\)\. The owner is not at the Mac: work on your own, follow CLAUDE\.md, and end with a short plain summary of what you did and what needs the owner\. Never print \.env files, keys or tokens: name them instead\.$/);
  for (const model of ['sonnet', 'opus', 'fable', 'haiku']) for (const mode of ['auto', 'acceptEdits', 'plan']) {
    const a = claudeArgv({ id, model, mode, max_turns: 400, session_id: 's' });
    for (const f of FORBIDDEN) assert.ok(!a.some(x => x.includes(f)), `${f} in ${a}`);
  }
  for (const mode of ['bypassPermissions', 'dontAsk', 'default']) assert.throws(() => claudeArgv({ id, model: 'sonnet', mode, max_turns: 5 }), /unknown mode/);
  assert.throws(() => claudeArgv({ id, model: 'gpt', mode: 'auto', max_turns: 5 }), /unknown model/);
  for (const t of [0, 401, 1.5]) assert.throws(() => claudeArgv({ id, model: 'sonnet', mode: 'auto', max_turns: t }), /1 to 400/);
  // the command line refuses the forbidden words as values and as options
  for (const args of [['--mode', 'bypassPermissions'], ['--mode', 'dontAsk'], ['--dangerously-skip-permissions'], ['--add-dir', '/'], ['--settings', 'x'], ['--allowedTools', 'Bash'], ['--mcp-config', 'x']]) {
    const r = start(args); assert.equal(r.status, 2, `${args}: ${r.stderr}`);
  }
  assert.equal(fakeCalls().length, 0);
});

test('a job runs to "waiting": the claude argv and stdin, the cwd, events kept, cut and secret-scanned', async () => {
  const r = start(['--model', 'opus', '--mode', 'acceptEdits', '--max-turns', '40'], { FAKE_JOB_SECRET: '1' });
  assert.equal(r.status, 0, r.stderr); const id = idOf(r); assert.ok(id, r.stdout);
  assert.match(r.stdout, /in alpha \(opus, edit files, no commands\)/);
  const m = await until(id, ['waiting', 'failed']);
  assert.equal(m.state, 'waiting', m.last_text);
  assert.equal(m.session_id, 'sess-0001'); assert.equal(m.cost_usd, 0.25); assert.equal(m.turns, 3); assert.equal(m.from, 'phone');
  assert.equal(m.last_text, '[hidden]');   // the result text carried a secret-shaped string
  const call = fakeCalls().at(-1);
  assert.deepEqual(call.argv, claudeArgv({ id, model: 'opus', mode: 'acceptEdits', max_turns: 40 }));
  assert.equal(call.stdin, 'Fix the footer'); assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(REPO));
  const st = fs.statSync(path.join(WK, 'jobs', id));
  assert.equal(st.mode & 0o777, 0o700);
  for (const f of ['meta.json', 'prompt-1.txt', 'events.jsonl']) assert.equal(fs.statSync(path.join(WK, 'jobs', id, f)).mode & 0o777, 0o600, f);
  const ev = events(id), types = ev.map(e => e.type);
  assert.deepEqual(types, ['prompt', 'init', 'text', 'tool', 'permission_denied', 'text', 'permission_denied', 'result']);
  assert.deepEqual(ev.map(e => e.n), ev.map((_, i) => i + 1));
  assert.deepEqual(ev[1], { n: 2, at: ev[1].at, type: 'init', session_id: 'sess-0001', model: 'claude-opus-test', permissionMode: 'acceptEdits' });
  assert.equal(ev[2].text, '[hidden]');                                  // text with a key: hidden whole
  assert.equal(ev[3].name, 'Bash'); assert.equal(ev[3].short, '[hidden]');
  assert.equal(ev[4].tool, 'WebFetch'); assert.equal(ev[6].tool, 'Write');
  assert.equal(ev[5].text.length, 4000); assert.ok(ev[5].text.endsWith('…'));
  assert.equal(ev[7].subtype, 'success'); assert.equal(ev[7].turns, 3);
  const raw = fs.readFileSync(path.join(WK, 'jobs', id, 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes('sk-ant-')); assert.ok(!raw.includes(HOME));
  // show --json gives events after a number
  const s = JSON.parse(job(['show', id, '--json', '--after', '5']).stdout);
  assert.deepEqual(s.events.map(e => e.n), [6, 7, 8]); assert.equal(s.next, 8);
});

test('home paths become ~ and the tool line is cut to 200', async () => {
  const id = idOf(start([], {}, 'Tidy ' + 'y'.repeat(300)));
  await until(id, ['waiting']);
  const ev = events(id), tool = ev.find(e => e.type === 'tool');
  assert.equal(tool.short, 'ls ~/Projects');
  const [cut] = J.eventsFrom({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo ' + 'z'.repeat(500) } }] } });
  assert.equal(cut.short.length, 200); assert.ok(cut.short.endsWith('…'));
  assert.deepEqual(J.eventsFrom({ type: 'user', message: { content: [] } }), []);   // tool results are not kept
  assert.ok(ev.find(e => e.type === 'text').text.startsWith('Working on: Tidy y'));
  assert.match(meta(id).last_text, /^Done: Tidy y+\. Needs the owner: nothing\.$/);
});

test('reply: only while waiting, with --resume and the same model and mode; cost and turns add up', async () => {
  const id = idOf(start(['--model', 'haiku', '--mode', 'plan']));
  await until(id, ['waiting']);
  const r = job(['reply', id, '--prompt', 'Now the header too']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Sent the reply/);
  const m = await wait(() => { const x = meta(id); return x.state === 'waiting' && x.prompts === 2 ? x : null; });
  const call = fakeCalls().at(-1);
  assert.deepEqual(call.argv, claudeArgv({ id, model: 'haiku', mode: 'plan', max_turns: 150, session_id: 'sess-0001' }));
  assert.equal(call.stdin, 'Now the header too');
  assert.equal(m.cost_usd, 0.5); assert.equal(m.turns, 6);
  assert.equal(fs.readFileSync(path.join(WK, 'jobs', id, 'prompt-2.txt'), 'utf8'), 'Now the header too');
  // not while running
  const h = idOf(start([], { FAKE_JOB_MODE: 'hang' }));
  await until(h, ['running']);
  const r2 = job(['reply', h, '--prompt', 'more']);
  assert.equal(r2.status, 1); assert.match(r2.stderr, /is running, not waiting/);
  job(['stop', h]); await until(h, ['stopped']);
  // not when stopped, failed or unknown; an empty reply is bad input
  assert.match(job(['reply', h, '--prompt', 'more']).stderr, /is stopped, not waiting/);
  assert.equal(job(['reply', 'J-20991231-2359-ffff', '--prompt', 'x']).status, 1);
  assert.equal(job(['reply', 'nonsense', '--prompt', 'x']).status, 2);
  assert.equal(job(['reply', id, '--prompt', '   ']).status, 2);
});

test('a failed run is "failed" with its result; a crash says so', async () => {
  const a = idOf(start([], { FAKE_JOB_MODE: 'fail' }));
  const m = await until(a, ['failed', 'waiting']);
  assert.equal(m.state, 'failed'); assert.equal(m.last_text, 'Ran out of turns.'); assert.equal(m.cost_usd, 0.5);
  const b = idOf(start([], { FAKE_JOB_MODE: 'crash' }));
  const n = await until(b, ['failed', 'waiting']);
  assert.equal(n.state, 'failed'); assert.match(n.last_text, /ended without a result \(exit 3\): fake: crashed/);
});

test('stop kills the whole process group: SIGTERM first, SIGKILL when it is ignored', async () => {
  const pidFile = path.join(HOME, 'grandchild.pid');
  const id = idOf(start([], { FAKE_JOB_MODE: 'hang', FAKE_JOB_IGNORE_TERM: '1', FAKE_JOB_CHILD_PID: pidFile }));
  const m = await until(id, ['running']);
  const grand = Number(await wait(() => { try { return fs.readFileSync(pidFile, 'utf8'); } catch { return null; } }));
  assert.ok(alive(m.pgid) && alive(grand));
  const t = Date.now();
  const r = job(['stop', id]); assert.equal(r.status, 0); assert.match(r.stdout, /Stopping job/);
  const s = await until(id, ['stopped']);
  assert.ok(Date.now() - t >= 500, 'waited for the grace period before SIGKILL');
  assert.equal(s.last_text, 'Stopped by the owner.');
  await wait(() => !alive(m.pgid) && !alive(grand), 5000);
  assert.equal(events(id).at(-1).text, 'Stopped by the owner.');
  // a plain hang ends on SIGTERM
  const id2 = idOf(start([], { FAKE_JOB_MODE: 'hang' }));
  const m2 = await until(id2, ['running']);
  job(['stop', id2]); await until(id2, ['stopped']); await wait(() => !alive(m2.pgid), 5000);
  assert.match(job(['stop', id2]).stdout, /already stopped/);
});

test('the wall clock ends a job that runs too long', async () => {
  const id = idOf(start([], { FAKE_JOB_MODE: 'hang', WK_JOB_WALL_MS: '700' }));
  const m = await until(id, ['failed', 'stopped', 'waiting']);
  assert.equal(m.state, 'failed'); assert.match(m.last_text, /minute limit was reached/);
  await wait(() => !alive(m.pgid), 5000);
});

test('a folder project runs in its repository with the "Work in" line first', async () => {
  const r = job(['start', '--project', 'shop', '--prompt', 'Add a page']);
  const id = idOf(r); assert.ok(id, r.stderr);
  await until(id, ['waiting']);
  const call = fakeCalls().at(-1);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(MONO));
  assert.equal(call.stdin, 'Work in shop/ (project mono/shop).\nAdd a page');
  assert.equal(events(id)[0].text, 'Add a page');   // the phone shows the owner's own words
});

test('refusals: stop switch, LOW_RAM (both places), free RAM, max_jobs, pace at 90 %, unknown project', async () => {
  await stopAll();
  const n0 = fakeCalls().length, jobs0 = fs.readdirSync(path.join(WK, 'jobs')).length;
  const refused = (r, re, code = 1) => { assert.equal(r.status, code, r.stdout + r.stderr); assert.match(r.stderr, re); assert.equal(r.stdout, ''); };
  fs.writeFileSync(path.join(WK, 'KILL'), '');
  refused(start(), /stop switch is on/, 3);
  fs.rmSync(path.join(WK, 'KILL'));
  fs.writeFileSync(path.join(ORCH, 'LOW_RAM'), '');
  refused(start(), /low on memory/);
  fs.rmSync(path.join(ORCH, 'LOW_RAM'));
  fs.mkdirSync(path.join(REPO, 'orchestration')); fs.writeFileSync(path.join(REPO, 'orchestration', 'LOW_RAM'), '');
  refused(start(), /low on memory/);
  fs.rmSync(path.join(REPO, 'orchestration'), { recursive: true });
  refused(start([], { WK_JOB_FREE_MB: '1499' }), /1499 MB free, under 1500 MB/);
  refused(start([], { WK_JOB_PACE_PCT: '90' }), /at 90%/);
  refused(start([], { WK_JOB_PACE_PCT: '97.4' }), /at 97%/);
  refused(job(['start', '--project', 'nope', '--prompt', 'x']), /not in the projects list/);
  assert.equal(job(['start', '--project', '../etc', '--prompt', 'x']).status, 2);
  assert.equal(job(['start', '--project', 'alpha', '--prompt', 'x'.repeat(8001)]).status, 2);
  assert.equal(fakeCalls().length, n0); assert.equal(fs.readdirSync(path.join(WK, 'jobs')).length, jobs0, 'a refusal makes no job folder');
  // pace under the line starts; max_jobs (1 here) refuses the next while one runs
  setRemote({ max_jobs: 1 });
  const id = idOf(start([], { WK_JOB_PACE_PCT: '89', FAKE_JOB_MODE: 'hang' })); assert.ok(id);
  await until(id, ['running']);
  refused(start(), /1 jobs are running, the most at once is 1/);
  job(['stop', id]); await until(id, ['stopped']);
  setRemote({ pace_stop_pct: 50 });
  refused(start([], { WK_JOB_PACE_PCT: '50' }), /at 50%, at or over the 50% line/);
  setRemote({});
});

test('sweep: a runner that is gone leaves "failed"; a job waiting a day is "done"', () => {
  const mk = (id, o) => { const d = path.join(WK, 'jobs', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'alpha', state: 'running', events: 0, ...o })); };
  mk('J-20200101-0000-0001', { state: 'running', runner_pid: 999999, started_at: Date.now() - 60000 });
  mk('J-20200101-0000-0002', { state: 'waiting', ended_at: Date.now() - 25 * 3600000 });
  const r = JSON.parse(job(['list', '--json']).stdout);
  assert.equal(r.find(x => x.id === 'J-20200101-0000-0001').state, 'failed');
  assert.equal(r.find(x => x.id === 'J-20200101-0000-0002').state, 'done');
  assert.ok(r.every(x => !('pgid' in x) && !('cwd' in x)));
});

// ---------------------------------------------------------------- legal wording: the newest top model (P2-227 follow-up)
const PICK = path.join(WK, 'model-pick.json'), AUDIT = path.join(WK, 'model-audit.jsonl');
const clearPick = () => { for (const f of [PICK, AUDIT, path.join(WK, 'fake-busy-count')]) fs.rmSync(f, { force: true }); };
const auditLines = () => { try { return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const modelsOf = calls => calls.map(c => c.argv[c.argv.indexOf('--model') + 1]);
const effortOf = c => (c.argv.includes('--effort') ? c.argv[c.argv.indexOf('--effort') + 1] : null);

test('a legal prompt runs on claude-fable-5-2 at xhigh, whatever model was picked; the label and the events say so', async () => {
  clearPick();
  const n0 = fakeCalls().length;
  const r = start(['--model', 'sonnet', '--json'], {}, 'Update the privacy policy for the new form');
  assert.equal(r.status, 0, r.stderr); const s = JSON.parse(r.stdout);
  assert.equal(s.legal, true);
  const m = await until(s.id, ['waiting', 'failed']);
  assert.equal(m.state, 'waiting', m.last_text);   // the stderr unrecognized_model tag is not a failure
  assert.equal(m.model, 'sonnet'); assert.equal(m.legal, true); assert.equal(m.model_id, 'claude-fable-5-2'); assert.equal(m.effort, 'xhigh');
  const calls = fakeCalls().slice(n0); assert.equal(calls.length, 1);
  assert.deepEqual(modelsOf(calls), ['claude-fable-5-2']); assert.equal(effortOf(calls[0]), 'xhigh');
  for (const f of FORBIDDEN) assert.ok(!calls[0].argv.some(x => x.includes(f)), f);
  const ev = events(s.id);
  assert.ok(ev.some(e => e.type === 'note' && /Legal wording \("privacy policy"\)/.test(e.text)));
  const mev = ev.find(e => e.type === 'model');
  assert.deepEqual([mev.model, mev.effort, mev.text], ['claude-fable-5-2', 'xhigh', 'Legal: newest top model (claude-fable-5-2)']);
  const row = JSON.parse(job(['show', s.id, '--json']).stdout);
  assert.deepEqual([row.legal, row.model_id, row.effort], [true, 'claude-fable-5-2', 'xhigh']);
  assert.ok(row.events.some(e => e.type === 'model'));
  assert.match(start([], {}, 'Rewrite the terms of service').stdout, /\(Legal: newest top model, /);
  await stopAll();
});

test('a stop before the runner starts claude: claude never starts, and the runner writes "stopped" (also after a reply)', async () => {
  if (fs.existsSync(path.join(WK, 'jobs'))) await stopAll();   // run alone, no job exists yet
  const deps = { freeMb: () => 8000, pacePct: () => null, spawnRunner: () => process.pid };   // this test stands in for a runner that is alive but has not run yet
  const n0 = fakeCalls().length;
  const m = J.start({ project: 'alpha', prompt: 'Fix the header', from: 'phone' }, { deps });
  assert.equal(fs.readFileSync(path.join(WK, 'jobs', m.id, 'runner.pid'), 'utf8'), String(process.pid));
  assert.equal(meta(m.id).runner_pid, null);
  assert.match(job(['stop', m.id]).stdout, /Stopping job/);
  assert.equal(meta(m.id).state, 'queued');   // the runner is alive, so stop leaves the end state to it
  assert.equal(job(['list']).status, 0); assert.equal(meta(m.id).state, 'queued');   // nor does the sweep call it failed
  const run = job(['_run', m.id]); assert.equal(run.error, undefined);
  assert.equal(meta(m.id).state, 'stopped'); assert.equal(fakeCalls().length, n0);   // claude never started
  assert.ok(events(m.id).some(e => e.type === 'note' && /Stopped by the owner/.test(e.text)));
  // a runner that is gone: stop writes "stopped" itself, and a late runner does nothing
  const g = J.start({ project: 'alpha', prompt: 'Fix the header again', from: 'phone' }, { deps: { ...deps, spawnRunner: () => 999999 } });
  job(['stop', g.id]); assert.equal(meta(g.id).state, 'stopped');
  job(['_run', g.id]); assert.equal(meta(g.id).state, 'stopped'); assert.equal(fakeCalls().length, n0);
  // a reply: the last run's pids are cleared, the new runner's pid is in runner.pid, and the same rules hold
  const w = idOf(start([], {}, 'Fix the sidebar')); await until(w, ['waiting']);
  await wait(() => !alive(meta(w).runner_pid), 5000);   // reply refuses while the last runner is still alive
  const n1 = fakeCalls().length;
  J.reply(w, 'Now the footer', { deps });
  assert.equal(meta(w).runner_pid, null); assert.equal(meta(w).pgid, null);
  assert.equal(fs.readFileSync(path.join(WK, 'jobs', w, 'runner.pid'), 'utf8'), String(process.pid));
  assert.match(job(['stop', w]).stdout, /Stopping job/); assert.equal(meta(w).state, 'queued');
  job(['_run', w]); assert.equal(meta(w).state, 'stopped'); assert.equal(fakeCalls().length, n1);
});

test('a 404 falls back to fable and is logged; the next run skips 5-2 for 24 hours; then 5-2 is tried again', async () => {
  clearPick();
  const env = { FAKE_JOB_MISSING: 'claude-fable-5-2' };
  let n0 = fakeCalls().length;
  const id = idOf(start([], env, 'Check the licence of the new font'));
  const m = await until(id, ['waiting', 'failed']);
  assert.equal(m.state, 'waiting', m.last_text); assert.equal(m.model_id, 'fable');
  assert.deepEqual(modelsOf(fakeCalls().slice(n0)), ['claude-fable-5-2', 'fable']);
  assert.ok(events(id).some(e => e.type === 'note' && /claude-fable-5-2 is not available on this plan: trying fable/.test(e.text)));
  assert.deepEqual(events(id).filter(e => e.type === 'model').map(e => e.model), ['claude-fable-5-2', 'fable']);
  const fb = auditLines().find(a => a.ev === 'model-fallback');
  assert.deepEqual([fb.lane, fb.model, fb.next], ['legal', 'claude-fable-5-2', 'fable']); assert.match(fb.from, new RegExp(id));
  const cache = JSON.parse(fs.readFileSync(PICK, 'utf8'));
  assert.ok(cache.unavailable['claude-fable-5-2']); assert.equal(cache.picked.legal.model, 'fable');
  assert.equal(fs.statSync(PICK).mode & 0o777, 0o600);
  // within 24 hours: one call, straight to fable
  n0 = fakeCalls().length;
  const id2 = idOf(start([], env, 'Is our GDPR consent banner right?'));
  assert.equal((await until(id2, ['waiting', 'failed'])).model_id, 'fable');
  assert.deepEqual(modelsOf(fakeCalls().slice(n0)), ['fable']);
  // 24 hours later the cache has expired: claude-fable-5-2 is tried first again (and now works)
  const old = Date.now() - 24 * 3600000 - 1000;
  cache.unavailable['claude-fable-5-2'].at = old; cache.picked.legal.at = old; fs.writeFileSync(PICK, JSON.stringify(cache));
  n0 = fakeCalls().length;
  const id3 = idOf(start([], {}, 'Draft a disclaimer for the quiz'));
  assert.equal((await until(id3, ['waiting', 'failed'])).model_id, 'claude-fable-5-2');
  assert.deepEqual(modelsOf(fakeCalls().slice(n0)), ['claude-fable-5-2']);
});

test('a 429 never downgrades: the same model again after the wait; a busy end keeps the model and says so', async () => {
  clearPick();
  let n0 = fakeCalls().length;
  const id = idOf(start([], { FAKE_JOB_BUSY: '2', WK_JOB_RETRY_MS: '30' }, 'Read the contract with the printer'));
  const m = await until(id, ['waiting', 'failed']);
  assert.equal(m.state, 'waiting', m.last_text); assert.equal(m.model_id, 'claude-fable-5-2');
  assert.deepEqual(modelsOf(fakeCalls().slice(n0)), ['claude-fable-5-2', 'claude-fable-5-2', 'claude-fable-5-2']);
  assert.ok(!auditLines().some(a => a.ev === 'model-fallback'));
  assert.ok(!JSON.parse(fs.readFileSync(PICK, 'utf8')).unavailable['claude-fable-5-2']);
  // busy every time: it gives up on the SAME model, with no fallback
  clearPick(); n0 = fakeCalls().length;
  const id2 = idOf(start([], { FAKE_JOB_BUSY: '9', WK_JOB_RETRY_MS: '30', WK_JOB_RETRIES: '1' }, 'Copyright line for the footer'));
  const m2 = await until(id2, ['waiting', 'failed']);
  assert.equal(m2.state, 'failed'); assert.equal(m2.model_id, 'claude-fable-5-2');
  assert.deepEqual(modelsOf(fakeCalls().slice(n0)), ['claude-fable-5-2', 'claude-fable-5-2']);
  assert.match(m2.last_text, /without changing the model \(claude-fable-5-2\)/);
  clearPick();   // the pace line that stops the retries is tested in model-pick.test.mjs
});

test('a prompt that is not legal is unchanged: the caller\'s model, no --effort, no model event', async () => {
  clearPick();
  const n0 = fakeCalls().length;
  for (const prompt of ['Fix the footer', 'Make the menu better in terms of speed', 'Add a fast counter']) {
    const r = start(['--model', 'opus', '--json'], {}, prompt); const s = JSON.parse(r.stdout);
    assert.ok(!('legal' in s), prompt);
    const m = await until(s.id, ['waiting', 'failed']);
    assert.equal(m.legal, false); assert.equal(m.model_id, null);
    assert.ok(!events(s.id).some(e => e.type === 'model'));
  }
  const calls = fakeCalls().slice(n0);
  assert.deepEqual(modelsOf(calls), ['opus', 'opus', 'opus']); assert.ok(calls.every(c => effortOf(c) === null));
  assert.ok(!fs.existsSync(AUDIT));
  // and a model outside both lists is still refused
  assert.throws(() => claudeArgv({ id: 'J-20261116-1902-a3f9', model: 'claude-fable-5-2', mode: 'auto', max_turns: 5 }), /unknown model/);
  assert.throws(() => claudeArgv({ id: 'J-20261116-1902-a3f9', model: 'sonnet', mode: 'auto', max_turns: 5, effort: 'huge' }));
});

test('a legal reply makes the job legal from then on', async () => {
  clearPick();
  const id = idOf(start());
  await until(id, ['waiting']);
  const n0 = fakeCalls().length;
  assert.equal(job(['reply', id, '--prompt', 'Now add a cookie policy page']).status, 0);
  const m = await wait(() => { const x = meta(id); return x.state === 'waiting' && x.model_id ? x : null; });
  assert.equal(m.legal, true); assert.equal(m.model_id, 'claude-fable-5-2');
  const c = fakeCalls().slice(n0)[0]; assert.equal(effortOf(c), 'xhigh'); assert.ok(c.argv.includes('--resume'));
});

test.after(async () => { try { await stopAll(); } catch { /* best effort */ } });

// review fixes (W2): each extra shape is hidden in a real job's events (text, tool input and result), and the system line says not to print them
test('job events hide whsec_, sk_test_, AIza, xox*- and NAME=value secrets', async () => {
  const { FAKE } = await import('./fixtures/fake-secrets.mjs');
  assert.match(systemLine('J-20261116-1902-a3f9'), /Never print \.env files, keys or tokens: name them instead\./);
  for (const [k, v] of Object.entries(FAKE)) {
    const r = start([], { FAKE_JOB_SECRET_TEXT: v }); assert.equal(r.status, 0, r.stderr); const id = idOf(r);
    const m = await until(id, ['waiting', 'failed']); assert.equal(m.state, 'waiting', `${k}: ${m.last_text}`);
    const ev = events(id);
    assert.equal(ev.find(e => e.type === 'text').text, '[hidden]', k);
    assert.equal(ev.find(e => e.type === 'tool').short, '[hidden]', k);
    assert.equal(m.last_text, '[hidden]', k);
    const raw = fs.readFileSync(path.join(WK, 'jobs', id, 'events.jsonl'), 'utf8') + JSON.stringify(m);
    assert.ok(!raw.includes(v.split(/[ =:]+/).at(-1)), `${k} leaked`);
  }
});

test('LOW_RAM is read only from remote.json "orchestration" (and the project\'s own folder): no built-in default folder, even when the old default folder exists', () => {
  const OLD = 'nexo' + 'dyne';   // the built-in default before 0.6.1: ~/Projects/<this name>/orchestration
  const d = path.join(HOME, 'Projects', OLD, 'orchestration'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'LOW_RAM'), '');
  const deps = { freeMb: () => 8000, pacePct: () => null };
  const base = { max_jobs: 99, pace_stop_pct: 90 };   // jobs from earlier tests never decide this one
  try {
    assert.equal(J.whyNot({ project: 'alpha', remote: base, deps }), null, 'unset: no folder, so no LOW_RAM from the default place');
    assert.match(J.whyNot({ project: 'alpha', remote: { ...base, orchestration: `~/Projects/${OLD}/orchestration` }, deps }).text, /low on memory/, 'set by hand: read, with ~ expanded');
  } finally { fs.rmSync(path.join(HOME, 'Projects', OLD), { recursive: true }); }
});
