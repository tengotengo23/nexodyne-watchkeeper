// P2-282 run budget: wk-task add --minutes, inbox totals, take --run new|<id> (exit 6 when the run is used), the order of the
// stop checks (3 kill, 4 cap, 6 run, 5 nothing), the queue block of a plain take, and the shipped texts (automation prompt,
// Desk rules quoted word for word in SKILL.md and the README). Everything runs in a temporary HOME and WK_HOME with temporary
// git repositories; agy, gemini and claude are never started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGate, estimateOf, minutesOf, RUN_ID } from '../bin/wk-task.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gemini.json'), 'utf8'));
const NEW_RULE = "One task at a time; in an automation run, after done, take the next task while the run's budget lasts (the take command says when to stop).";

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2-282-')));
  const s = { base, home: path.join(base, 'home'), wk: path.join(base, 'home', '.wk') };
  fs.mkdirSync(s.wk, { recursive: true });
  s.env = () => ({ PATH: process.env.PATH, HOME: s.home, WK_HOME: s.wk, TMPDIR: os.tmpdir(),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  s.run = args => spawnSync(process.execPath, [path.join(root, 'bin', 'wk-task.mjs'), ...args], { env: s.env(), encoding: 'utf8', timeout: 60000 });
  s.repo = name => {
    const d = path.join(base, name); fs.mkdirSync(d);
    const g = a => execFileSync('git', a, { cwd: d, env: s.env(), stdio: 'pipe' });
    g(['init', '-q']); fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); g(['add', 'a.txt']); g(['commit', '-q', '-m', 'init']);
    return d;
  };
  s.add = (repo, title, extra = []) => { const r = s.run(['add', '--repo', repo, '--title', title, '--text', 'do it', ...extra]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  s.runFile = id => path.join(s.wk, 'runs', `${id}.json`);
  s.meta = id => JSON.parse(fs.readFileSync(path.join(s.wk, 'tasks', id, 'meta.json'), 'utf8'));
  return s;
}
const runIdOf = out => { const m = /Run (r-\d{8}-\d{4}-[0-9a-f]{4}):/.exec(out); assert.ok(m, out); return m[1]; };

test('add stores --minutes; without it the kind estimate is stored; 4, 481 and text are refused', () => {
  const s = sandbox(); const repo = s.repo('A');
  const a = s.add(repo, 'sized task', ['--minutes', '45']);
  assert.equal(s.meta(a).minutes, 45);
  const b = s.add(repo, 'unsized task', ['--kind', 'read']);
  assert.equal(s.meta(b).minutes, CFG.estimate_minutes.read, 'without --minutes, add stores the kind estimate');
  assert.equal(minutesOf({ kind: 'read' }, CFG), CFG.estimate_minutes.read, 'an older task without minutes uses the estimate');
  assert.equal(minutesOf(s.meta(b), CFG), CFG.estimate_minutes.read);
  for (const bad of ['4', '481', 'abc', '30.5']) {
    const r = s.run(['add', '--repo', repo, '--title', `bad ${bad}`, '--text', 'x', '--minutes', bad]);
    assert.equal(r.status, 2, `--minutes ${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--minutes must be a whole number from 5 to 480/);
  }
  assert.equal(s.run(['add', '--repo', repo, '--title', 'edge 5', '--text', 'x', '--minutes', '5']).status, 0);
  assert.equal(s.run(['add', '--repo', repo, '--title', 'edge 480', '--text', 'x', '--minutes', '480']).status, 0);
});

test('inbox --brief shows the total minutes and ~N min per task; 0 waiting when empty and under the Stop switch', () => {
  const s = sandbox(); const repo = s.repo('A');
  assert.equal(s.run(['inbox', '--brief']).stdout.trim(), '0 waiting');
  s.add(repo, 'one', ['--minutes', '45']); s.add(repo, 'two', ['--kind', 'read']);
  const out = s.run(['inbox', '--brief']).stdout.trim().split('\n');
  assert.equal(out[0], `2 waiting (about ${45 + CFG.estimate_minutes.read} min)`);
  assert.ok(out.some(l => / · one · ~45 min$/.test(l)), out.join('\n'));
  assert.ok(out.some(l => new RegExp(` · two · ~${CFG.estimate_minutes.read} min$`).test(l)), out.join('\n'));
  fs.writeFileSync(path.join(s.wk, 'KILL'), '');
  assert.equal(s.run(['inbox', '--brief']).stdout.trim(), '0 waiting (the Stop switch is on)');
});

test('take --run new writes the run file (0600, folder 0700), prints the Run line; the next take prefers the same repository', () => {
  const s = sandbox(); const A = s.repo('A'), B = s.repo('B');
  const a1 = s.add(A, 'a first in A'); const b1 = s.add(B, 'b in B'); const a2 = s.add(A, 'c second in A');
  const r1 = s.run(['take', '--run', 'new']);
  assert.equal(r1.status, 0, r1.stderr);
  const id = runIdOf(r1.stdout);
  assert.ok(RUN_ID.test(id));
  assert.match(r1.stdout, new RegExp(`Run ${id}: budget 60 min, used 0 min, task 1 of 6\\.`));
  assert.match(r1.stdout, new RegExp(`Next: when this task is done, run take --run ${id} again; it says when to stop\\.`));
  assert.doesNotMatch(r1.stdout, /Queue after this task:/);
  assert.equal(fs.statSync(s.runFile(id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(s.wk, 'runs')).mode & 0o777, 0o700);
  const run = JSON.parse(fs.readFileSync(s.runFile(id), 'utf8'));
  assert.deepEqual(run.task_ids, [a1]); assert.equal(run.repo_last, A); assert.equal(run.budget_min, 60); assert.equal(run.max_tasks, 6);
  const r2 = s.run(['take', '--run', id, '--json']);
  assert.equal(r2.status, 0, r2.stderr);
  const m2 = JSON.parse(r2.stdout);
  assert.equal(m2.id, a2, 'a task in the same repository comes before the older one elsewhere');
  assert.equal(m2.run.id, id); assert.equal(m2.run.n, 2);
  assert.equal(s.meta(b1).status, 'queued');
});

test('a used budget and the task limit both exit 6 with one stop line on stdout; runGate is pure', () => {
  const s = sandbox(); const A = s.repo('A');
  s.add(A, 'one'); s.add(A, 'two'); s.add(A, 'three');
  const id = runIdOf(s.run(['take', '--run', 'new']).stdout);
  const f = s.runFile(id); const run = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...run, started_at: new Date(Date.now() - 61 * 60000).toISOString() }));
  const r = s.run(['take', '--run', id]);
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stdout.trim(), new RegExp(`^Run ${id} is complete \\(used 6\\d min of 60; 1 task\\)\\. Stop here\\.$`));
  fs.writeFileSync(f, JSON.stringify({ ...run, task_ids: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'] }));
  const r6 = s.run(['take', '--run', id]);
  assert.equal(r6.status, 6, r6.stdout + r6.stderr);
  assert.match(r6.stdout, /6 tasks\)\. Stop here\./);
  // pure gate with a faked clock
  const now = new Date('2026-11-25T10:00:00Z');
  const fresh = { id: 'r-20261125-0930-abcd', started_at: '2026-11-25T09:30:00Z', budget_min: 60, max_tasks: 6, task_ids: ['t1'] };
  assert.equal(runGate(fresh, CFG, now), null);
  const g = runGate(fresh, CFG, new Date('2026-11-25T10:30:00Z'));
  assert.equal(g.used, 60); assert.equal(g.tasks, 1);
  assert.equal(g.msg, 'Run r-20261125-0930-abcd is complete (used 60 min of 60; 1 task). Stop here.');
  assert.ok(runGate({ ...fresh, task_ids: [1, 2, 3, 4, 5, 6] }, CFG, now));
  assert.equal(runGate({ ...fresh, budget_min: undefined, max_tasks: undefined }, { run_budget_minutes: 90, max_tasks_per_run: 6 }, new Date('2026-11-25T10:30:00Z')), null, 'a run file without its own budget uses the config');
  assert.equal(estimateOf('nope', CFG), 30); assert.equal(estimateOf('hard', {}), 30);
});

test('the daily cap comes before the run gate, the Stop switch before both; nothing waiting exits 5', () => {
  const s = sandbox(); const A = s.repo('A');
  s.add(A, 'one'); s.add(A, 'two');
  const id = runIdOf(s.run(['take', '--run', 'new']).stdout);
  const f = s.runFile(id); const run = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...run, started_at: new Date(Date.now() - 5 * 3600000).toISOString() }));
  // fill today's cap with finished tasks
  for (let i = 0; i < CFG.max_tasks_per_day; i++) {
    const tid = `20261125-0000${String(i).padStart(2, '0')}-cap-${i}`; const d = path.join(s.wk, 'tasks', tid); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: tid, status: 'merged', title: 'cap', repo: A, from: 'claude', kind: 'quick', taken_at: new Date().toISOString() }));
  }
  const r4 = s.run(['take', '--run', id]);
  assert.equal(r4.status, 4, r4.stdout + r4.stderr);
  assert.match(r4.stdout, /Today's cap of \d+ tasks is reached/);
  fs.writeFileSync(path.join(s.wk, 'KILL'), '');
  const r3 = s.run(['take', '--run', id]);
  assert.equal(r3.status, 3, r3.stdout + r3.stderr);
  assert.match(r3.stdout, /The Stop switch is on/);
  const e = sandbox(); e.repo('A');
  const r5 = e.run(['take', '--run', 'new']);
  assert.equal(r5.status, 5, r5.stdout + r5.stderr);
  assert.equal(fs.existsSync(path.join(e.wk, 'runs')) ? fs.readdirSync(path.join(e.wk, 'runs')).length : 0, 0, 'nothing taken leaves no run file');
});

test('a malformed or unknown run id is refused (exit 2) and takes nothing', () => {
  const s = sandbox(); const A = s.repo('A'); const t = s.add(A, 'one');
  for (const [arg, re] of [['bogus', /--run must be new or a run id/], ['../x', /--run must be new or a run id/], ['r-20261125-0930-abcd', /no run r-20261125-0930-abcd/]]) {
    const r = s.run(['take', '--run', arg]);
    assert.equal(r.status, 2, arg + r.stdout + r.stderr); assert.match(r.stderr, re);
  }
  assert.equal(s.meta(t).status, 'queued');
});

test('a plain take shows the queue after this task only when others wait', () => {
  const s = sandbox(); const A = s.repo('A');
  s.add(A, 'only one');
  const r = s.run(['take']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Queue after this task:/); assert.doesNotMatch(r.stdout, /^Run r-/m);
  const s2 = sandbox(); const B = s2.repo('B');
  s2.add(B, 'first', ['--minutes', '20']); const second = s2.add(B, 'second', ['--minutes', '45']);
  const q = s2.run(['take']);
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /Queue after this task:/);
  assert.ok(q.stdout.includes(`${second} · second · ~45 min`), q.stdout);
  assert.match(q.stdout, /1 task waiting after this one, about 45 min in all\./);
});

test('shipped texts: the prompt keeps its placeholders; the Desk rules carry the run rule and are quoted word for word', () => {
  for (const p of ['<ABS>', '<desk_rules>', '<budget>', 'inbox --brief', '--run new', 'Never run agy']) assert.ok(CFG.automation_prompt.includes(p), p);
  assert.ok(CFG.desk_rules.includes(NEW_RULE));
  assert.ok(!CFG.desk_rules.includes('One task per turn'));
  assert.equal(CFG.run_budget_minutes, 60); assert.equal(CFG.max_tasks_per_run, 6);
  assert.equal(CFG.automation_schedule.default, '*/30 9-21 * * *'); assert.equal(CFG.automation_schedule.quiet, '0 8-23 * * *');
  for (const k of Object.keys(CFG.routes)) assert.ok(Number.isInteger(CFG.estimate_minutes[k]) && CFG.estimate_minutes[k] >= 5 && CFG.estimate_minutes[k] <= 480, k);
  const skill = fs.readFileSync(path.join(root, 'antigravity', 'plugins', 'watchkeeper', 'skills', 'wk-take-task', 'SKILL.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(skill.includes(CFG.desk_rules), 'SKILL.md quotes the Desk rules word for word');
  assert.ok(readme.includes(CFG.desk_rules), 'README quotes the Desk rules word for word');
  assert.ok(readme.includes('*/30 9-21 * * *') && readme.includes('0 8-23 * * *'));
  assert.match(readme, /never creates, installs or turns it on/);
  const cmd = fs.readFileSync(path.join(root, 'commands', 'wk-take-task.md'), 'utf8');
  assert.match(cmd, /--run/);
});
