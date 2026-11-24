// P2-272 Phase 4 (stage 4A): the task splitter's JS parts. dag-lib (shared triage vectors with the Python), the Claude lane
// with a stub `claude` (keeps every meter window), and the Gemini lane (only a wk-task in the queue; a stub agy must never run).
// Temp HOME and WK_HOME, temp git repos, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lib from '../bin/dag-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// A6: each folder this run makes with mkdtemp is removed after the run, and only after checking it lies inside the temporary folder
const MADE = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-dag-js-'))); MADE.push(d); return d; };
after(() => {
  const base = fs.realpathSync(os.tmpdir());
  for (const d of MADE) {
    const rel = path.relative(base, d);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(d).startsWith('wk-dag-js-')) throw new Error(`not a folder this run made: ${d}`);
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const node = (id, globs, deps = [], kv = {}) => ({ id, title: `Step ${id}`, dependsOn: deps, provider: 'claude', model: 'sonnet',
  effort: 'medium', ownedGlobs: globs, interfaceContract: '', verifyCmd: 'true', ...kv });

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  g('add', 'README.md');
  g('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'first');
  return dir;
}

test('triage: shared vectors match, each under 50 ms', () => {
  const vecs = lib.loadVectors();
  assert.ok(vecs.length >= 10);
  for (const v of vecs) {
    const t0 = performance.now();
    const got = lib.triage(v.prompt);
    assert.ok(performance.now() - t0 < 50, v.prompt);
    assert.equal(got.route, v.route, v.prompt);
    assert.equal(got.reason, v.reason, v.prompt);
  }
  const t0 = performance.now();
  lib.triage('Refactor the panel and the server API, then update the tests.\n'.repeat(400));
  assert.ok(performance.now() - t0 < 50);
});

test('plan checks: bad schema and cycles refused', () => {
  assert.equal(lib.validatePlan([]).ok, false);
  const bad = lib.validatePlan([node('A', ['x']), node('b', ['/etc/**']), node('c', ['../x']), node('d', ['x'], [], { provider: 'openai' }),
    node('integration', ['x']), node('e', ['x'], [], { verifyCmd: 'a\nb' })]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 5);
  assert.equal(lib.validatePlan(Array.from({ length: 21 }, (_, i) => node(`n${i}`, [`d${i}/**`]))).ok, false);
  const cyc = lib.validatePlan([node('a', ['a/**'], ['c']), node('b', ['b/**'], ['a']), node('c', ['c/**'], ['b'])]);
  assert.equal(cyc.ok, false);
  assert.match(cyc.errors.join(' '), /circle/);
  assert.equal(lib.validatePlan([node('a', ['x'], ['a'])]).ok, false);
  assert.equal(lib.validatePlan([node('a', ['x']), node('b', ['y'], ['a'], { provider: 'gemini', model: 'gemini-3-pro' })]).ok, true);
});

test('waves: overlap serialized, disjoint parallel, dependencies ordered', () => {
  const nodes = lib.validatePlan([node('a', ['src/**']), node('b', ['src/a.py']), node('c', ['docs/**'])]).nodes;
  const waves = lib.planWaves(nodes);
  const at = Object.fromEntries(waves.flatMap((w, i) => w.map(id => [id, i])));
  assert.notEqual(at.a, at.b);
  assert.equal(at.a, at.c);
  assert.ok(lib.globsMayOverlap('**', 'docs/x.md'));
  assert.ok(!lib.globsMayOverlap('src/**', 'docs/**'));
  assert.deepEqual(lib.planWaves(lib.validatePlan([node('a', ['a/**']), node('b', ['b/**'], ['a'])]).nodes), [['a'], ['b']]);
});

test('evidence gate refuses a file outside the step and a deny file', () => {
  const deny = ['**/.env', '**/*.pem'];
  assert.equal(lib.gateCheck(['src/a.py', 'src/x/b.py'], ['src/**'], deny).ok, true);
  const out = lib.gateCheck(['src/a.py', 'README.md'], ['src/**'], deny, 'x');
  assert.equal(out.ok, false);
  assert.deepEqual(out.outside, ['README.md']);
  const den = lib.gateCheck(['src/.env'], ['src/**'], deny);
  assert.equal(den.ok, false);
  assert.deepEqual(den.denied, ['src/.env']);
  assert.equal(lib.gateCheck(['../etc/passwd'], ['**'], deny).ok, false);
  // N8: the deny list ignores letter case
  assert.deepEqual(lib.gateCheck(['.ENV', 'src/Key.PEM'], ['**'], deny).denied, ['.ENV', 'src/Key.PEM']);
  assert.deepEqual(lib.singleNode('Fix it\nmore')[0].ownedGlobs, ['**']);
});

test('Claude lane with a stub claude: the step runs and every meter window is kept', async () => {
  const t = tmp();
  const wk = path.join(t, '.wk');
  const steward = path.join(wk, 'steward');
  fs.mkdirSync(steward, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(steward, 'meter.json'), JSON.stringify({ windows: { seven_day_sonnet: { utilization: 0.1, resetsAt: reset } } }));
  const win = u => ({ utilization: u, resetsAt: reset, status: 'allowed' });
  const rate = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.4, resetsAt: reset, status: 'allowed',
    unifiedWindows: { seven_day_fable: win(0.2), seven_day_opus: win(0.3), five_hour: win(0.5) } } };
  const result = { type: 'result', subtype: 'success', result: 'changed one file', total_cost_usd: 0 };
  fs.writeFileSync(path.join(t, 'lines.jsonl'), JSON.stringify(rate) + '\n' + JSON.stringify(result) + '\n');
  const stub = path.join(t, 'stub-claude.sh');
  fs.writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\nmkdir -p src\necho 'print(1)' > src/a.py\ncat '${path.join(t, 'lines.jsonl')}'\n`, { mode: 0o755 });
  const wt = gitRepo(path.join(t, 'wt'));
  fs.writeFileSync(path.join(t, 'prompt.txt'), 'Add src/a.py');
  const keep = { WK_CLAUDE_BIN: process.env.WK_CLAUDE_BIN, WK_HOME: process.env.WK_HOME, WK_STEWARD_DIR: process.env.WK_STEWARD_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { WK_CLAUDE_BIN: stub, WK_HOME: wk, HOME: t });
  delete process.env.WK_STEWARD_DIR;
  const lines = [];
  try {
    const { main } = await import('../bin/wk-dag-lane.mjs');
    const rc = await main(['claude', '--cwd', wt, '--model', 'sonnet', '--effort', 'medium', '--prompt-file', path.join(t, 'prompt.txt'), '--id', 'dag-x-a'], s => lines.push(s));
    assert.equal(rc, 0, lines.join('\n'));
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const out = JSON.parse(lines.at(-1));
  assert.equal(out.ok, true);
  assert.equal(out.result, 'changed one file');
  assert.ok(fs.existsSync(path.join(wt, 'src', 'a.py')), 'the stub did not edit the worktree');
  const meter = JSON.parse(fs.readFileSync(path.join(steward, 'meter.json'), 'utf8'));
  for (const w of ['seven_day', 'seven_day_fable', 'seven_day_opus', 'five_hour', 'seven_day_sonnet']) {
    assert.ok(meter.windows && meter.windows[w], `meter lost the ${w} window: ${Object.keys(meter.windows || {})}`);
  }
});

test('Gemini lane only queues a wk-task with --allow and --test; a stub agy is never called', () => {
  const t = tmp();
  const wk = path.join(t, '.wk');
  const repo = gitRepo(path.join(t, 'repo'));
  const bin = path.join(t, 'stubbin');
  fs.mkdirSync(bin);
  const marker = path.join(t, 'agy-called');
  fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: t, WK_HOME: wk, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.WK_STEWARD_DIR;
  const r = spawnSync('node', [path.join(ROOT, 'bin', 'wk-task.mjs'), 'add', '--repo', repo, '--title', 'Notes step', '--allow', 'notes/**',
    '--test', 'test -d notes', '--from', 'claude', '--text', 'Write the notes.'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
  const ids = fs.readdirSync(path.join(wk, 'tasks')).filter(n => !n.startsWith('.'));
  assert.equal(ids.length, 1);
  const meta = JSON.parse(fs.readFileSync(path.join(wk, 'tasks', ids[0], 'meta.json'), 'utf8'));
  assert.deepEqual(meta.allow, ['notes/**']);
  assert.equal(meta.test, 'test -d notes');
  assert.equal(fs.existsSync(marker), false, 'agy was called');
});
