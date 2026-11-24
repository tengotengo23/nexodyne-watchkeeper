// P2-272 P1-C: the /wk command family. Temporary HOME and WK_HOME only; agy is never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WK = path.join(ROOT, 'bin', 'wk.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p1c-'));
const home = path.join(tmp, 'home');
const wkHome = path.join(home, '.wk');
fs.mkdirSync(wkHome, { recursive: true });
const env = { ...process.env, HOME: home, WK_HOME: wkHome, WK_LAUNCH_AGENTS: path.join(tmp, 'la'), WK_LAUNCHCTL: '/usr/bin/true' };
const wk = (args, cwd = ROOT) => spawnSync(process.execPath, [WK, ...args], { env, cwd, encoding: 'utf8' });
const KILL = path.join(wkHome, 'KILL');

test('help lists the family and the old names', () => {
  const r = wk(['help']);
  assert.equal(r.status, 0);
  for (const w of ['/wk status', '/wk graph', '/wk sync', '/wk stop', '/wk go', '/wk task', '/wk take-task', '/wk-status', '/wk-take-task', '/wk-add-task', '/wk-suggest', 'Stop switch']) assert.ok(r.stdout.includes(w), w);
  assert.ok(!/kill switch/i.test(r.stdout));
});

test('stop writes a reason and time, go removes it, both idempotent', () => {
  const s = wk(['stop', 'testing', 'the', 'switch']);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /Stop switch is on: testing the switch/);
  assert.match(fs.readFileSync(KILL, 'utf8'), /^testing the switch \(\d{4}-\d\d-\d\dT[\d:.]+Z\)\n$/);
  const g = wk(['go']);
  assert.equal(g.status, 0);
  assert.match(g.stdout, /Stop switch is off/);
  assert.ok(!fs.existsSync(KILL));
  assert.match(wk(['go']).stdout, /already off/);
});

test('stop without a reason uses a default line', () => {
  assert.equal(wk(['/STOP']).status, 0);
  assert.match(fs.readFileSync(KILL, 'utf8'), /^stopped with \/wk stop \(/);
  wk(['go']);
});

test('sync refuses with exit 3 while the Stop switch is on and installs no launchd job', () => {
  wk(['stop', 'sync test']);
  const r = wk(['sync']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Stop switch is on/);
  assert.ok(!fs.existsSync(path.join(tmp, 'la')) || fs.readdirSync(path.join(tmp, 'la')).length === 0);
  wk(['go']);
});

test('task queues a file task in a git repo, makes no worktree', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'i');
  const r = wk(['task', 'fix', 'the', 'thing'], repo);
  assert.equal(r.status, 0, r.stderr);
  const dirs = fs.readdirSync(path.join(wkHome, 'tasks'));
  assert.equal(dirs.length, 1);
  assert.ok(fs.existsSync(path.join(wkHome, 'tasks', dirs[0], 'meta.json')));
  assert.ok(!fs.existsSync(path.join(wkHome, 'worktrees')) || fs.readdirSync(path.join(wkHome, 'worktrees')).length === 0);
});

test('task without text, or outside a git repo, exits 2', () => {
  assert.equal(wk(['task']).status, 2);
  const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
  const r = wk(['task', 'something'], plain);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git repository/);
});

test('graph with a bad subcommand reaches the python CLI and fails with 2', () => {
  assert.equal(wk(['graph', 'nonsense']).status, 2);
});

test('take-task alias does not crash', () => {
  const r = wk(['wk-take-task']);
  assert.ok(r.status === 0 || r.status === 1 || r.status === 5, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(r.stderr));
});

test('bin/wk.mjs never spawns agy or Gemini', () => {
  const src = fs.readFileSync(WK, 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/['"`]agy['"`]/.test(src));
  assert.ok(!/gemini/i.test(src));
});

test('docs name the Stop switch and list the family on every surface', () => {
  const files = [
    'commands/wk.md', 'skills/wk/SKILL.md', 'antigravity/plugins/watchkeeper/skills/wk/SKILL.md',
  ];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const w of ['/wk status', '/wk graph', '/wk sync', '/wk stop', '/wk go', '/wk task', '/wk take-task', '/wk-status', 'Stop switch']) assert.ok(t.includes(w), `${f}: ${w}`);
    assert.ok(!/kill switch/i.test(t), f);
  }
  const alias = { 'commands/wk-take-task.md': 'take-task', 'commands/wk-add-task.md': 'task ', 'commands/status.md': 'wk-status', 'commands/wk-status.md': 'wk-status' };
  for (const [f, w] of Object.entries(alias)) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(t.includes('${CLAUDE_PLUGIN_ROOT}/bin/wk.mjs" ' + w), f);
  }
  for (const s of ['wk-status', 'wk-add-task', 'wk-take-task', 'wk-suggest']) {
    const t = fs.readFileSync(path.join(ROOT, 'antigravity/plugins/watchkeeper/skills', s, 'SKILL.md'), 'utf8');
    assert.ok(t.includes('Part of the /wk family'), s);
    assert.ok(!/kill switch/i.test(t), s);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /## The \/wk command family/);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
