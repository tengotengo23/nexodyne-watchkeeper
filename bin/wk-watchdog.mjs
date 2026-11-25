#!/usr/bin/env node
// Dynamic hanging-task watchdog & detached process-group helper for Watchkeeper Node runners and CLI.
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { findPython } from './antigravity-lib.mjs';
import { testShell } from './env-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CPU_ACTIVE_THRESHOLD = 5.0;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function inspectProcessTree(pid, pgid = null) {
  const alive = pidAlive(pid);
  const hasPgid = Number.isInteger(pgid) && pgid > 1;
  if (!alive && !hasPgid) {
    return { alive: false, totalCpu: 0, pids: [], zombie: false, stopped: false };
  }
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,pcpu=,state='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = new Map();
    const byPpid = new Map();
    for (const line of String(out || '').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const p = Number(parts[0]);
      const pp = Number(parts[1]);
      const pg = Number(parts[2]);
      const cpu = Number(String(parts[3]).replace(',', '.'));
      const state = String(parts[4] || '');
      if (!Number.isInteger(p) || p <= 1) continue;
      rows.set(p, { pid: p, ppid: pp, pgid: pg, cpu: Number.isFinite(cpu) ? cpu : 0, state });
      if (!byPpid.has(pp)) byPpid.set(pp, []);
      byPpid.get(pp).push(p);
    }

    const seen = new Set();
    const queue = [];
    if (Number.isInteger(pid) && rows.has(pid)) queue.push(pid);
    if (hasPgid) {
      for (const r of rows.values()) {
        if (r.pgid === pgid) queue.push(r.pid);
      }
    }
    while (queue.length) {
      const cur = queue.pop();
      if (seen.has(cur) || cur <= 1) continue;
      seen.add(cur);
      for (const ch of byPpid.get(cur) || []) {
        if (!seen.has(ch)) queue.push(ch);
      }
    }
    if (!seen.size) {
      return { alive, totalCpu: 0, pids: alive ? [pid] : [], zombie: false, stopped: false };
    }
    let totalCpu = 0;
    let liveNonZombie = false;
    let hasZombie = false;
    let hasStopped = false;
    for (const p of seen) {
      const r = rows.get(p);
      if (!r) continue;
      totalCpu += r.cpu;
      if (r.state.startsWith('Z')) hasZombie = true;
      else if (r.state.startsWith('T')) hasStopped = true;
      else liveNonZombie = true;
    }
    const rootRow = rows.get(pid);
    const zombie = Boolean((rootRow && rootRow.state.startsWith('Z')) || (hasZombie && !liveNonZombie));
    const stopped = Boolean((rootRow && rootRow.state.startsWith('T')) || (hasStopped && !liveNonZombie));
    return {
      alive: liveNonZombie || (alive && !zombie),
      totalCpu: Math.round(totalCpu * 100) / 100,
      pids: [...seen].sort((a, b) => a - b),
      zombie,
      stopped,
    };
  } catch {
    return { alive, totalCpu: 0, pids: alive ? [pid] : [], zombie: false, stopped: false };
  }
}

export function killProcessGroup(pid, graceMs = 1500, pgid = null) {
  const selfPid = process.pid;
  const targets = [];
  if (Number.isInteger(pid) && pid > 1 && pid !== selfPid) targets.push(pid);
  const tree = inspectProcessTree(pid, pgid);
  for (const p of tree.pids) {
    if (p > 1 && p !== selfPid && !targets.includes(p)) targets.push(p);
  }

  const sigGroupOrTargets = (sig) => {
    const rawGid = Number.isInteger(pgid) && pgid > 1 ? pgid : (Number.isInteger(pid) && pid > 1 ? pid : null);
    const groupId = rawGid && rawGid !== selfPid ? rawGid : null;
    if (groupId && process.platform !== 'win32') {
      try { process.kill(-groupId, sig); } catch { /* ignore */ }
    }
    for (const t of targets) {
      if (t !== selfPid) {
        try { process.kill(t, sig); } catch { /* ignore */ }
      }
    }
  };

  if (!targets.length) return { stopTimer: null };
  sigGroupOrTargets('SIGTERM');
  const esc = setTimeout(() => sigGroupOrTargets('SIGKILL'), Math.max(100, graceMs));
  if (esc && typeof esc.unref === 'function') esc.unref();
  return { stopTimer: esc };
}

/**
 * Dynamic multi-signal stall guard:
 * - resets idle timer on every `touch()`
 * - fires `onWarning` once when idle >= 0.5 * stallMs and CPU is quiescent
 * - at idle >= stallMs inspects OS process-tree CPU/state before escalating to `onStall`
 * - uses `.unref()` on internal timers so tests and short CLI processes exit cleanly
 */
export function createDynamicStallGuard({
  pid = null,
  pgid = null,
  stallMs = 300000,
  maxWallMs = 3600000,
  probeMs = null,
  onWarning = null,
  onStall = null,
} = {}) {
  const effMaxWallMs = Math.max(100, Number(maxWallMs) || 3600000);
  const effStallMs = Math.min(effMaxWallMs, Math.max(100, Number(stallMs) || 300000));
  const effProbeMs = Math.max(40, Math.min(5000, Number(probeMs) || Math.floor(effStallMs / 3)));
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let warnedForStretch = false;
  let idleStrikes = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    const elapsedMs = now - startedAt;

    if (elapsedMs >= effMaxWallMs) {
      stopped = true;
      clearInterval(iv);
      if (typeof onStall === 'function') {
        onStall({ reason: 'wall', idleMs, elapsedMs, cpu: 0, pids: pid ? [pid] : [] });
      }
      return;
    }

    if (idleMs >= Math.floor(effStallMs * 0.5) && !warnedForStretch) {
      const tree = Number.isInteger(pid) ? inspectProcessTree(pid, pgid) : { alive: true, totalCpu: 0, pids: [], zombie: false, stopped: false };
      if (tree.totalCpu < CPU_ACTIVE_THRESHOLD) {
        warnedForStretch = true;
        if (typeof onWarning === 'function') {
          try { onWarning({ idleMs, elapsedMs, cpu: tree.totalCpu, pids: tree.pids }); } catch { /* ignore */ }
        }
      }
    }

    if (idleMs >= effStallMs) {
      const tree = Number.isInteger(pid) ? inspectProcessTree(pid, pgid) : { alive: true, totalCpu: 0, pids: [], zombie: false, stopped: false };
      if (tree.zombie || (tree.stopped && idleMs >= effStallMs)) {
        stopped = true;
        clearInterval(iv);
        if (typeof onStall === 'function') {
          onStall({ reason: tree.zombie ? 'zombie' : 'stopped', idleMs, elapsedMs, cpu: tree.totalCpu, pids: tree.pids });
        }
        return;
      }
      if (tree.totalCpu >= CPU_ACTIVE_THRESHOLD) {
        idleStrikes = 0;
        return;
      }
      idleStrikes += 1;
      if (idleStrikes >= 2) {
        stopped = true;
        clearInterval(iv);
        if (typeof onStall === 'function') {
          onStall({ reason: 'stall', idleMs, elapsedMs, cpu: tree.totalCpu, pids: tree.pids });
        }
      }
    }
  };

  const iv = setInterval(tick, effProbeMs);
  if (iv && typeof iv.unref === 'function') iv.unref();

  return {
    touch() {
      if (stopped) return;
      lastActivityAt = Date.now();
      warnedForStretch = false;
      idleStrikes = 0;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(iv);
    },
    status() {
      const now = Date.now();
      return {
        stopped,
        idleMs: now - lastActivityAt,
        elapsedMs: now - startedAt,
        stallMs: effStallMs,
        maxWallMs: effMaxWallMs,
      };
    },
  };
}

/**
 * Synchronous `/bin/sh -c` runner using a detached child helper so timed-out or stalled
 * test suites have their entire process group (-pid) killed without leaving orphans.
 */
export function runDetachedCommandSync(cmd, { cwd = process.cwd(), env = process.env, timeoutMs = 600000, idleMs = 300000 } = {}) {
  const maxBytes = 64 * 1024;
  const helperCode = `
const { spawn } = require('child_process');
const cmd = process.argv[1];
const timeoutMs = Number(process.argv[2]) || 600000;
const idleMs = Number(process.argv[3]) || timeoutMs;
const maxBuf = 64 * 1024;
let out = '', err = '', timedOut = false, stalled = false, settled = false;
let lastAt = Date.now();
// P2-282: the shell comes from the parent (env-lib testShell): /bin/sh -c here, cmd.exe /d /s /c on Windows
const shFile = process.argv[4] || '/bin/sh';
const shArgs = (process.argv[5] || '-c').split(' ').filter(Boolean);
const c = spawn(shFile, [...shArgs, cmd], {
  cwd: process.cwd(),
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
const killGrp = (sig) => {
  if (c.pid > 1 && process.platform !== 'win32') { try { process.kill(-c.pid, sig); } catch {} }
  try { c.kill(sig); } catch {}
};
const halt = (kind) => {
  if (settled) return;
  if (kind === 'stall') stalled = true;
  else timedOut = true;
  killGrp('SIGTERM');
  setTimeout(() => killGrp('SIGKILL'), 1000).unref();
};
const tWall = setTimeout(() => halt('wall'), Math.max(50, timeoutMs));
tWall.unref();
const tIdle = setInterval(() => {
  if (Date.now() - lastAt >= Math.max(50, idleMs)) halt('stall');
}, Math.max(25, Math.min(2000, Math.floor(idleMs / 3))));
tIdle.unref();
c.stdout.on('data', d => { lastAt = Date.now(); out = (out + d.toString('utf8')).slice(-maxBuf); });
c.stderr.on('data', d => { lastAt = Date.now(); err = (err + d.toString('utf8')).slice(-maxBuf); });
const finish = (code, errMsg = '') => {
  if (settled) return;
  settled = true;
  clearTimeout(tWall);
  clearInterval(tIdle);
  killGrp('SIGKILL');
  process.stdout.write(JSON.stringify({ status: typeof code === 'number' ? code : null, timedOut, stalled, stdout: out, stderr: err, errorMessage: errMsg }));
};
c.on('error', e => finish(null, e && e.message ? e.message : String(e)));
c.on('close', code => finish(code));
`;

  const effTimeout = Math.max(50, Number(timeoutMs) || 600000);
  const effIdle = Math.max(50, Math.min(effTimeout, Number(idleMs) || effTimeout));
  const nodeEnv = { ...env };
  if (process.versions && process.versions.electron) nodeEnv.ELECTRON_RUN_AS_NODE = '1';

  const sh = testShell(process.platform);
  const r = spawnSync(process.execPath, ['-e', helperCode, cmd, String(effTimeout), String(effIdle), sh.file, sh.args.join(' ')], {
    cwd,
    env: nodeEnv,
    encoding: 'utf8',
    timeout: effTimeout + 5000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });

  const raw = String(r.stdout || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        status: typeof parsed.status === 'number' ? parsed.status : null,
        timedOut: Boolean(parsed.timedOut || parsed.stalled),
        stalled: Boolean(parsed.stalled),
        stdout: String(parsed.stdout || '').slice(-maxBytes),
        stderr: String(parsed.stderr || '').slice(-maxBytes),
        errorMessage: String(parsed.errorMessage || ''),
      };
    } catch { /* fall through */ }
  }
  const outerTimeout = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  return {
    status: typeof r.status === 'number' ? r.status : null,
    timedOut: outerTimeout,
    stalled: false,
    stdout: String(r.stdout || '').slice(-maxBytes),
    stderr: String(r.stderr || '').slice(-maxBytes),
    errorMessage: outerTimeout ? 'ETIMEDOUT' : (r.error ? String(r.error.message || r.error) : ''),
  };
}

export function runWatchdogCli(argv = process.argv.slice(2), opts = {}) {
  const py = findPython() || 'python3';
  const script = path.join(ROOT, 'core', 'watchdog.py');
  // P2-272: explicit 30 s limit (WK_WATCHDOG_CLI_TIMEOUT_MS overrides); exit 124 on timeout.
  // P2-276 review: a caller may pass a longer limit and a gentler signal (wk-watch's recover backs up worktrees:
  // 10 minutes, SIGTERM, so watchdog.py can stop between steps; an interrupted removal resumes on the next pass).
  const envMs = Number(process.env.WK_WATCHDOG_CLI_TIMEOUT_MS);
  const timeoutMs = Math.max(1000, envMs > 0 ? envMs : (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000));
  const killSignal = opts.killSignal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL';
  const r = spawnSync(py, [script, ...argv], {
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    process.stderr.write(`wk-watchdog: watchdog.py stopped after ${Math.round(timeoutMs / 1000)}s (timeout).\n`);
    return 124;
  }
  return typeof r.status === 'number' ? r.status : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  process.exitCode = runWatchdogCli();
}
