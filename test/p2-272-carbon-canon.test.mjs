// P2-272 canon: agy (Gemini on the owner's Google login) never runs from Claude.
// The Carbon fallback must refuse under Claude (CLAUDECODE=1 with the real home, or WK_CALLER=claude_code),
// while a test stub inside a temporary HOME still works and the owner's own terminal is unaffected.
// Hermetic: every agy here is a stub that only logs its calls; nothing reaches Google.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-carbon-canon-'));
// A6: remove only the folder this run made with mkdtemp, after checking that it lies inside the temporary folder
function removeOwnTmp(dir) {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`not inside the temporary folder: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => removeOwnTmp(TMP));

const ACCOUNT_HOME = os.userInfo().homedir;

function makeStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'agy-calls.log');
  const bin = path.join(dir, 'agy-stub');
  fs.writeFileSync(bin, `#!/bin/sh\necho "called $*" >> ${JSON.stringify(log)}\necho '{"ok":true}'\n`, { mode: 0o755 });
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

function baseEnv(extra) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.WK_CALLER;
  delete env.WK_CARBON_FALLBACK;
  return { ...env, WK_CARBON_FALLBACK: '1', ...extra };
}

test('agyBlockedForClaude: the same rule as the Python engine and the panel', async () => {
  const { agyBlockedForClaude } = await import('../bin/lib.mjs');
  const home = path.join(TMP, 'home-a');
  const inside = makeStub(path.join(home, 'bin'));
  const outside = makeStub(path.join(TMP, 'elsewhere'));
  assert.equal(agyBlockedForClaude(outside.bin, { CLAUDECODE: '1', HOME: ACCOUNT_HOME }), true, 'real home under Claude: blocked');
  assert.equal(agyBlockedForClaude(inside.bin, { WK_CALLER: 'claude_code', HOME: home }), true, 'the Claude Code hook: always blocked');
  assert.equal(agyBlockedForClaude(inside.bin, { WK_CALLER: ' Claude_Code ', HOME: home }), true, 'caller match ignores case and spaces');
  assert.equal(agyBlockedForClaude(inside.bin, { CLAUDECODE: '1', HOME: home }), false, 'a stub inside a temporary HOME may stand in');
  assert.equal(agyBlockedForClaude(outside.bin, { CLAUDECODE: '1', HOME: home }), true, 'a temporary HOME does not unlock an agy outside it');
  assert.equal(agyBlockedForClaude(null, { CLAUDECODE: '1', HOME: home }), true, 'no path under Claude: blocked');
  assert.equal(agyBlockedForClaude(outside.bin, { CLAUDECODE: '1' }), true, 'no HOME under Claude: blocked');
  assert.equal(agyBlockedForClaude(outside.bin, { HOME: ACCOUNT_HOME }), false, "the owner's own terminal is not affected");
});

// P2-272 Phase 4B (A8): this test used to assert false under Claude ("canCarbonFallback is false under Claude with the real
// home, true in the owner terminal"). The gate now stands only in front of the queue, and queueing runs nothing, so it asserts
// the rule instead: true wherever Antigravity is present (its CLI or its IDE folder), under Claude too; false when it is absent
// or the off switch is set; and checking never runs agy.
test('canCarbonFallback: true where Antigravity is present, also under Claude; false when absent or switched off', async () => {
  const { canCarbonFallback, antigravityIdePresent } = await import('../bin/wk-carbon-fallback.mjs');
  const stub = makeStub(path.join(TMP, 'can'));
  const home = path.join(TMP, 'home-b');
  const inside = makeStub(path.join(home, 'bin'));
  const apps = path.join(TMP, 'apps-empty');
  fs.mkdirSync(apps, { recursive: true });
  const iso = { WK_ISOLATE_PATH: '1', WK_APPLICATIONS_DIR: apps };
  assert.equal(canCarbonFallback({ env: baseEnv({ CLAUDECODE: '1', HOME: ACCOUNT_HOME, WK_AGY_BIN: stub.bin }) }), true, 'Claude with the real home: queueing is allowed');
  assert.equal(canCarbonFallback({ env: baseEnv({ WK_CALLER: 'claude_code', HOME: home, WK_AGY_BIN: inside.bin }) }), true, 'the Claude Code hook: queueing is allowed');
  assert.equal(canCarbonFallback({ env: baseEnv({ CLAUDECODE: '1', HOME: home, WK_AGY_BIN: inside.bin }) }), true, 'test stub in a temporary HOME');
  assert.equal(canCarbonFallback({ env: baseEnv({ HOME: ACCOUNT_HOME, WK_AGY_BIN: stub.bin }) }), true, "owner's terminal");
  // absent: no agy anywhere it looks, no IDE folder, no app
  const bare = path.join(TMP, 'home-bare');
  fs.mkdirSync(bare, { recursive: true });
  const absent = baseEnv({ CLAUDECODE: '1', WK_CALLER: 'claude_code', HOME: bare, PATH: '/usr/bin:/bin', ...iso });
  delete absent.WK_AGY_BIN;
  const noSystemAgy = !fs.existsSync('/usr/local/bin/agy') && !fs.existsSync('/opt/homebrew/bin/agy');
  if (noSystemAgy) assert.equal(canCarbonFallback({ env: absent }), false, 'no agy and no IDE folder: false');
  assert.equal(antigravityIdePresent(absent), false);
  // the IDE folder alone, then the app alone, count as present
  fs.mkdirSync(path.join(bare, '.antigravity-ide'));
  assert.equal(canCarbonFallback({ env: absent }), true, 'the IDE folder ~/.antigravity-ide');
  const home2 = path.join(TMP, 'home-app');
  fs.mkdirSync(home2, { recursive: true });
  const apps2 = path.join(TMP, 'apps-with-ide');
  fs.mkdirSync(path.join(apps2, 'Antigravity IDE.app'), { recursive: true });
  assert.equal(canCarbonFallback({ env: { ...absent, HOME: home2, WK_APPLICATIONS_DIR: apps2 } }), true, 'the app in the apps folder');
  // the off switch wins over everything
  assert.equal(canCarbonFallback({ env: { ...baseEnv({ HOME: home, WK_AGY_BIN: inside.bin }), WK_CARBON_FALLBACK: '0' } }), false, 'WK_CARBON_FALLBACK=0');
  assert.equal(canCarbonFallback({ env: { ...absent, WK_CARBON_FALLBACK: '0' } }), false, 'WK_CARBON_FALLBACK=0 with the IDE folder');
  // the fake-claude guard stays: a fake claude without the opt-in or a WK_AGY_BIN gets no fallback
  const guarded = { ...absent };
  delete guarded.WK_CARBON_FALLBACK;
  assert.equal(canCarbonFallback({ env: guarded, hasFakeClaude: true }), false, 'fake claude guard');
  assert.equal(stub.calls() + inside.calls(), '', 'checking never runs agy');
});

// A8 end to end: wk-job under the Claude env (CLAUDECODE=1, WK_CALLER=claude_code) with a stub claude at its usage limit
// lands the job in the temporary wk-task queue and never starts the stub agy.
test('wk-job under Claude at the usage limit queues the task and never runs agy', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = path.join(TMP, 'e2e');
  const home = path.join(dir, 'home');
  const wk = path.join(dir, 'wk');
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(wk, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
  }
  fs.writeFileSync(path.join(wk, 'projects.json'), JSON.stringify({ projects: [{ key: 'proj', name: 'proj', path: repo, kind: 'repo' }] }));
  fs.writeFileSync(path.join(wk, 'remote.json'), JSON.stringify({}));
  const agy = makeStub(path.join(home, '.gemini', 'bin'));
  const marker = path.join(dir, 'agy-ran.marker');
  fs.writeFileSync(agy.bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const claude = path.join(dir, 'fake-claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your limit · resets 5am" }));\nprocess.exit(1);\n`, { mode: 0o755 });
  const env = { ...baseEnv({}), CLAUDECODE: '1', WK_CALLER: 'claude_code', HOME: home, WK_HOME: wk, WK_CLAUDE_BIN: claude,
    WK_AGY_BIN: agy.bin, WK_ISOLATE_PATH: '1', WK_JOB_FREE_MB: '8000', WK_JOB_PACE_PCT: 'none' };
  delete env.WK_CARBON_FALLBACK;
  const r = spawnSync(process.execPath, [path.resolve('bin/wk-job.mjs'), 'start', '--project', 'proj', '--prompt', 'Audit README layout', '--mode', 'plan'], { encoding: 'utf8', env, timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const jobId = (/Started (J-\d{8}-\d{4}-[0-9a-f]{4})/.exec(r.stdout) || [])[1];
  assert.ok(jobId, r.stdout);
  let meta = null;
  for (const end = Date.now() + 10000; Date.now() < end;) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(wk, 'jobs', jobId, 'meta.json'), 'utf8'));
      if (['waiting', 'failed', 'stopped'].includes(m.state)) { meta = m; break; }
    } catch { /* wait */ }
    await new Promise(res => setTimeout(res, 50));
  }
  assert.equal(meta?.state, 'waiting', JSON.stringify(meta));
  assert.equal(meta?.provider, 'antigravity-queue');
  assert.ok(meta?.queued_task);
  const tasks = fs.readdirSync(path.join(wk, 'tasks')).filter(x => !x.startsWith('.'));
  assert.equal(tasks.length, 1);
  assert.equal(fs.existsSync(marker), false, 'the stub agy never ran');
});

// P2-272 Phase 4A fixes (A1): this test used to assert reason canon_blocked. Queueing runs nothing, so it is the allowed lane
// under Claude too; it now asserts that the task is queued and that no agy, not even a stub, is ever run.
test('runCarbonHigh under Claude queues the task and never starts agy', async () => {
  const { spawnSync } = await import('node:child_process');
  const { runCarbonHigh } = await import('../bin/wk-carbon-fallback.mjs');
  const wk = path.join(TMP, 'wk');
  fs.mkdirSync(wk, { recursive: true });
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
  }

  const stub = makeStub(path.join(TMP, 'run'));
  const r1 = await runCarbonHigh({ prompt: 'Inspect module layout', cwd: repo, env: baseEnv({ CLAUDECODE: '1', HOME: ACCOUNT_HOME, WK_HOME: wk, WK_AGY_BIN: stub.bin }), item: 'p2-272-canon' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.queued, true);
  assert.ok(r1.taskId);

  const home = path.join(TMP, 'home-c');
  const inside = makeStub(path.join(home, 'bin'));
  const r2 = await runCarbonHigh({ prompt: 'Inspect module layout', cwd: repo, env: baseEnv({ WK_CALLER: 'claude_code', HOME: home, WK_HOME: wk, WK_AGY_BIN: inside.bin }), item: 'p2-272-canon-2' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(r2.taskId);
  assert.notEqual(r2.taskId, r1.taskId);
  // S8 (P2-272 review): the same item again, while its task is still queued, reuses that task and queues nothing new.
  const r3 = await runCarbonHigh({ prompt: 'Inspect module layout', cwd: repo, env: baseEnv({ WK_CALLER: 'claude_code', HOME: home, WK_HOME: wk, WK_AGY_BIN: inside.bin }), item: 'p2-272-canon' });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(r3.reused, true);
  assert.equal(r3.taskId, r1.taskId);

  assert.equal(stub.calls(), '', 'the stub outside a temporary HOME was never run');
  assert.equal(inside.calls(), '', 'the Claude Code caller never runs agy, even a stub');
});

// A2: the stall-guarded runner starts only a binary whose real path lies inside the temporary folder.
test('execWithStallGuard refuses a binary outside the temporary folder and does not start it', async () => {
  const { execWithStallGuard } = await import('../bin/wk-carbon-fallback.mjs');
  const { AGY_CANON_MESSAGE } = await import('../bin/lib.mjs');
  for (const bin of ['/usr/bin/true', '/bin/sh']) {
    const r = await execWithStallGuard({ agyBin: bin, model: 'gemini-4-carbon-high', fullPrompt: 'x', cwd: TMP, timeoutMs: 5000, env: baseEnv({}) });
    assert.equal(r.ok, false, bin);
    assert.equal(r.reason, 'canon_blocked', bin);
    assert.equal(r.err, AGY_CANON_MESSAGE, bin);
    assert.equal(r.code, -1, bin);
  }
  const stub = makeStub(path.join(TMP, 'ok-stub'));
  const r = await execWithStallGuard({ agyBin: stub.bin, model: 'gemini-4-carbon-high', fullPrompt: 'x', cwd: TMP, timeoutMs: 5000, env: baseEnv({}) });
  assert.notEqual(r.reason, 'canon_blocked', 'a stub inside the temporary folder may still run');
  assert.match(stub.calls(), /called/);
});
