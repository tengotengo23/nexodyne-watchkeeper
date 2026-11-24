'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const R = require('../src/render');
const { runStreamingSubprocess } = require('../src/reprompt-orchestrator');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

test('wk-job dynamically terminates a hung runner child with zero orphan processes', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-job-hang-'));
  try {
    const wkHome = path.join(base, 'wkhome');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(wkHome, { recursive: true });
    fs.writeFileSync(path.join(wkHome, 'projects.json'), JSON.stringify({
      projects: [{ key: 'demo', name: 'Demo', path: repo, kind: 'repo' }],
    }));

    const pidFile = path.join(base, 'child.pid');
    const fakeClaude = path.join(base, 'fake-claude.sh');
    fs.writeFileSync(fakeClaude, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`, { mode: 0o755 });

    const env = {
      ...process.env,
      HOME: path.join(base, 'home'),
      WK_HOME: wkHome,
      WK_CLAUDE_BIN: fakeClaude,
      WK_JOB_PACE_PCT: '10',
      WK_JOB_FREE_MB: '8000',
      WK_JOB_STALL_MS: '350',
      WK_JOB_KILL_MS: '250',
    };
    fs.mkdirSync(env.HOME, { recursive: true });

    const { start, runJob, readMeta, readEvents } = await import('../../bin/wk-job.mjs');
    const prevEnv = {};
    for (const k of ['HOME', 'WK_HOME', 'WK_CLAUDE_BIN', 'WK_JOB_PACE_PCT', 'WK_JOB_FREE_MB', 'WK_JOB_STALL_MS', 'WK_JOB_KILL_MS']) {
      prevEnv[k] = process.env[k];
      process.env[k] = env[k];
    }
    try {
      const m = start({ project: 'demo', prompt: 'Hang silently', model: 'sonnet', mode: 'auto', max_turns: 5, from: 'cli' });
      const code = await runJob(m.id);
      assert.equal(code, 0);
      const after = readMeta(m.id);
      assert.equal(after.state, 'failed');
      assert.match(after.last_text, /hung/i);
      const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      assert.equal(pidAlive(childPid), false, 'hung claude process must be dead');
      const evs = readEvents(m.id);
      assert.ok(evs.some(e => e.type === 'note' && /hung/i.test(e.text || '')));
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wk-carbon-fallback detects idle stall and fails over to next model dynamically', async () => {
  // P2-272 Q163: runCarbonHigh no longer runs agy; it queues a wk-task, which needs a git repository. This test used to expect
  // the agy chain to answer; now it checks that a non-git folder is refused in plain words without calling agy, and the stall
  // detection it protects is checked on the stall-guarded runner itself (still in a folder that is not a git repository).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-carb-hang-'));
  try {
    // P2-272 canon: under Claude only a stub inside a temporary HOME may stand in for agy.
    const home = path.join(base, 'home');
    fs.mkdirSync(home, { recursive: true });
    const fakeAgy = path.join(home, 'fake-agy.sh');
    const hangPidFile = path.join(base, 'agy-hang.pid');
    fs.writeFileSync(
      fakeAgy,
      `#!/bin/sh\necho "$*" | grep -q "gemini-4-carbon-high" && { echo $$ > "${hangPidFile}"; sleep 30; exit 0; }\necho "Fallback succeeded cleanly"\n`,
      { mode: 0o755 }
    );
    const env = {
      ...process.env,
      HOME: home,
      WK_HOME: path.join(base, 'wkhome'),
      WK_AGY_BIN: fakeAgy,
      WK_CARBON_IDLE_MS: '300',
    };
    const { runCarbonHigh, execWithStallGuard } = await import('../../bin/wk-carbon-fallback.mjs');
    const res = await runCarbonHigh({ prompt: 'Check failover on hung primary', cwd: base, timeoutMs: 10000, env });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.reason, 'queue_failed');
    assert.match(res.stderr, /not a git repository/);
    assert.equal(fs.existsSync(hangPidFile), false, 'the fallback must never call agy');

    const hung = await execWithStallGuard({ agyBin: fakeAgy, model: 'gemini-4-carbon-high', fullPrompt: 'x', cwd: base,
      mode: 'auto', sandbox: false, timeoutMs: 10000, killCheck: null, env });
    assert.equal(hung.ok, false);
    assert.equal(hung.stalled, true, JSON.stringify(hung));
    const hungPid = Number(fs.readFileSync(hangPidFile, 'utf8').trim());
    await new Promise(r => setTimeout(r, 300));
    assert.equal(pidAlive(hungPid), false, 'hung primary agy process must be terminated');
    const next = await execWithStallGuard({ agyBin: fakeAgy, model: 'gemini-4-argon-high', fullPrompt: 'x', cwd: base,
      mode: 'auto', sandbox: false, timeoutMs: 10000, killCheck: null, env });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.match(next.out, /Fallback succeeded cleanly/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reprompt-orchestrator runStreamingSubprocess aborts stalled silent stream cleanly', async () => {
  const prevIdle = process.env.WK_ORCH_IDLE_MS;
  process.env.WK_ORCH_IDLE_MS = '250';
  try {
    await assert.rejects(
      runStreamingSubprocess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 10000),
      /stalled with no output/i
    );
  } finally {
    if (prevIdle === undefined) delete process.env.WK_ORCH_IDLE_MS;
    else process.env.WK_ORCH_IDLE_MS = prevIdle;
  }
});

test('wk-task doneTask kills entire hung test process group including grandchildren', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-task-hang-'));
  const prevEnv = { WK_HOME: process.env.WK_HOME, WK_TASK_TEST_IDLE_MS: process.env.WK_TASK_TEST_IDLE_MS };
  try {
    const wkHome = path.join(base, 'wkhome');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);

    process.env.WK_HOME = wkHome;
    process.env.WK_TASK_TEST_IDLE_MS = '300';
    const gcPidFile = path.join(base, 'gc.pid');

    const { addTask, takeTask, doneTask } = await import('../../bin/wk-task.mjs');
    const meta = addTask({
      repo,
      title: 'Hanging test guard',
      text: 'Verify hung test process group cleanup',
      allow: [],
      test: `sleep 30 & echo $! > "${gcPidFile}"; wait`,
      from: 'claude',
    });
    const taken = takeTask({ id: meta.id });
    fs.writeFileSync(path.join(taken.worktree, 'a.txt'), 'v2\n');
    const res = doneTask({ id: meta.id });
    assert.equal(res.code, 1);
    assert.equal(res.m.status, 'failed');
    await new Promise(r => setTimeout(r, 120));
    const gcPid = Number(fs.readFileSync(gcPidFile, 'utf8').trim());
    assert.equal(pidAlive(gcPid), false, 'hung test grandchild process must be terminated');
  } finally {
    if (prevEnv.WK_HOME === undefined) delete process.env.WK_HOME;
    else process.env.WK_HOME = prevEnv.WK_HOME;
    if (prevEnv.WK_TASK_TEST_IDLE_MS === undefined) delete process.env.WK_TASK_TEST_IDLE_MS;
    else process.env.WK_TASK_TEST_IDLE_MS = prevEnv.WK_TASK_TEST_IDLE_MS;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('panel watchdog-bridge enforces trust & KILL, registers commands, and escapes UI alerts', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-panel-wd-'));
  try {
    const dataDir = path.join(base, 'wkhome');
    fs.mkdirSync(dataDir, { recursive: true });
    const oldTs = Date.now() - 30 * 60 * 1000;
    fs.writeFileSync(
      path.join(dataDir, 'chat-sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [{
          id: 'WKS-20261122-030000-1234',
          title: 'Stuck UI session',
          updatedAt: oldTs,
          turns: [{ id: 'T-uihang1', rawPrompt: 'Test', status: 'running', createdAt: oldTs, updatedAt: oldTs }],
        }],
      })
    );

    const registered = {};
    const cmds = [];
    const load = Module._load;
    const fakeVscode = {
      workspace: { isTrusted: false },
      window: { showInformationMessage: () => {}, showWarningMessage: () => {} },
      commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
    };
    Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
    try {
      delete require.cache[require.resolve('../src/watchdog-bridge.js')];
      const wb = require('../src/watchdog-bridge.js');

      // Passive read detects stalled turn with zero writes
      const sum = wb.readWatchdogSummary(dataDir);
      assert.equal(sum.available, true);
      assert.equal(sum.hungCount, 1);

      // Untrusted workspace blocks recover
      const untrusted = await wb.runWatchdogCli(dataDir, ROOT, 'recover', { trusted: false });
      assert.equal(untrusted.ok, false);

      // Trusted + KILL blocks recover
      fs.writeFileSync(path.join(dataDir, 'KILL'), '');
      const killed = await wb.runWatchdogCli(dataDir, ROOT, 'recover', { trusted: true });
      assert.equal(killed.ok, false);
      assert.equal(killed.killed, true);
      fs.rmSync(path.join(dataDir, 'KILL'));

      // Command registration + scan/recover
      const ctx = { subscriptions: [] };
      const fakePanel = { cfg: () => ({ dataDir, pluginPath: ROOT }), refresh: () => {} };
      wb.attachWatchdogToExtension(ctx, fakePanel);
      assert.ok(registered['watchkeeper.watchdogScan']);
      assert.ok(registered['watchkeeper.watchdogRecover']);
      for (const s of ctx.subscriptions) if (s.dispose) s.dispose();

      fakeVscode.workspace.isTrusted = true;
      const rec = await registered['watchkeeper.watchdogRecover']();
      assert.equal(rec.ok, true);
      assert.equal(rec.recoveredCount, 1);

      // Escapes hostile HTML inside renderJobs alert
      const html = R.renderJobs({
        now: Date.now(),
        host: 'antigravity',
        jobs: [],
        projects: [],
        watchdog: {
          available: true,
          hungCount: 1,
          warningCount: 0,
          items: [{ surface: 'task', title: '<img src=x onerror=alert(1)>', classification: 'hung', reason: '<script>x</script>' }],
        },
      });
      assert.match(html, /Watchdog:/);
      assert.ok(!html.includes('<script>x'));
      assert.ok(!html.includes('<img src=x'));
    } finally {
      delete require.cache[require.resolve('../src/watchdog-bridge.js')];
      Module._load = load;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
