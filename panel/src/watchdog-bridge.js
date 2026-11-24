'use strict';
// Antigravity IDE / VS Code bridge for Watchkeeper's dynamic hanging-task watchdog & auto-recovery.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// P2-272: every child process the panel starts is tracked, so deactivate() can end them all.
// Patched here, before any other module destructures execFile/spawn (extension.js requires this file first).
const CHILDREN = new Set();
function installChildTracking() {
  if (cp.__wkTracked) return;
  Object.defineProperty(cp, '__wkTracked', { value: true });
  const track = (child, detached) => {
    if (child && typeof child.once === 'function') {
      child.__wkDetached = Boolean(detached);
      CHILDREN.add(child);
      const drop = () => CHILDREN.delete(child);
      child.once('exit', drop);
      child.once('error', drop);
    }
    return child;
  };
  for (const name of ['spawn', 'execFile', 'exec']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function (...args) {
      const opts = args.find(a => a && typeof a === 'object' && !Array.isArray(a));
      return track(orig.apply(this, args), opts && opts.detached);
    };
  }
}
installChildTracking();

/** SIGTERM every tracked child. Detached children lead their own process group: signal the group (negative pid). Never our own group. */
function killTrackedChildren(signal = 'SIGTERM') {
  let n = 0;
  for (const child of Array.from(CHILDREN)) {
    CHILDREN.delete(child);
    const pid = child && child.pid;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (process.platform !== 'win32' && child.__wkDetached) process.kill(-pid, signal);
      else child.kill(signal);
      n += 1;
    } catch { /* already gone */ }
  }
  return n;
}
const { execFile } = cp;

function getVscode() {
  try {
    return require('vscode');
  } catch {
    return null;
  }
}

const EMPTY_WATCHDOG = Object.freeze({
  available: false,
  scanned_at: null,
  activeCount: 0,
  warningCount: 0,
  hungCount: 0,
  items: [],
});

function resolveWkHome(dataDir = '') {
  const expand = s => String(s || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  if (dataDir && String(dataDir).trim()) return path.resolve(expand(dataDir));
  if (process.env.WK_HOME && process.env.WK_HOME.trim()) return path.resolve(expand(process.env.WK_HOME));
  return path.join(os.homedir(), '.wk');
}

function isKillOn(dataDir = '') {
  try {
    return fs.existsSync(path.join(resolveWkHome(dataDir), 'KILL'));
  } catch {
    return true;
  }
}

function findPython() {
  const candidates = [
    process.env.WK_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python3') return c;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch { /* try next */ }
  }
  return 'python3';
}

function resolveWatchdogScript(pluginPath = '') {
  let fallbackPlugin = '';
  try { fallbackPlugin = require('./data').findPlugin('', os.homedir(), path.join(os.homedir(), '.claude')); } catch { /* ignore */ }
  const roots = [
    pluginPath,
    path.resolve(__dirname, '..', '..'),
    fallbackPlugin,
  ].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'core', 'watchdog.py');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* continue */ }
  }
  return '';
}

function parseJsonSafe(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Fast read-only watchdog snapshot (creates zero files) for Panel rendering & idle checks. */
function readWatchdogSummary(dataDir = '', now = Date.now()) {
  const wkHome = resolveWkHome(dataDir);
  const sumPath = path.join(wkHome, 'watchdog', 'summary.json');
  try {
    if (fs.existsSync(sumPath)) {
      const parsed = parseJsonSafe(fs.readFileSync(sumPath, 'utf8'), null);
      if (parsed && typeof parsed === 'object') {
        return {
          available: true,
          scanned_at: parsed.scanned_at || null,
          activeCount: Number(parsed.activeCount || 0),
          warningCount: Number(parsed.warningCount || 0),
          hungCount: Number(parsed.hungCount || 0),
          items: Array.isArray(parsed.items) ? parsed.items.slice(0, 20) : [],
        };
      }
    }
  } catch { /* fallback to lightweight passive check */ }

  // Passive read-only fallback: detect clearly stalled chat turns without spawning subprocesses
  const chatStallMs = Math.max(1000, Number(process.env.WK_CHAT_STALL_MS) || 10 * 60 * 1000);
  const chatFile = path.join(wkHome, 'chat-sessions.json');
  const items = [];
  let activeCount = 0;
  let hungCount = 0;
  try {
    if (fs.existsSync(chatFile)) {
      const cdata = parseJsonSafe(fs.readFileSync(chatFile, 'utf8'), null);
      const sessions = Array.isArray(cdata && cdata.sessions) ? cdata.sessions : [];
      for (const s of sessions) {
        if (!s || !Array.isArray(s.turns)) continue;
        for (const t of s.turns) {
          if (!t || (t.status !== 'running' && t.status !== 'preparing')) continue;
          const updatedAt = Number(t.updatedAt || t.createdAt || s.updatedAt || now);
          const idleMs = Math.max(0, now - updatedAt);
          if (idleMs >= chatStallMs) {
            hungCount += 1;
            items.push({
              surface: 'chat_turn',
              id: `${s.id}:${t.id}`,
              title: String(s.title || t.rawPrompt || 'Chat turn').slice(0, 120),
              classification: 'hung',
              reason: 'chat_turn_stalled',
              idle_ms: idleMs,
            });
          } else {
            activeCount += 1;
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (!items.length && !activeCount) {
    return { ...EMPTY_WATCHDOG, items: [] };
  }
  return {
    available: true,
    scanned_at: new Date(now).toISOString(),
    activeCount,
    warningCount: 0,
    hungCount,
    items: items.slice(0, 20),
  };
}

// ---- P2-272: pending worktree removals (written by core/watchdog.py, read here; decisions go through wk_cli)
const REMOVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const REMOVAL_SUB = { approve: 'approve-remove', later: 'later', keep: 'keep' };

function readPendingRemovalsAll(dataDir = '') {
  try {
    const raw = fs.readFileSync(path.join(resolveWkHome(dataDir), 'watchdog', 'pending-removals.json'), 'utf8');
    const j = parseJsonSafe(raw, null);
    return j && j.items && typeof j.items === 'object' ? j.items : {};
  } catch { return {}; }
}

/** The rows the owner still has to decide on: no removed_at, no decision (or "later" whose time has passed). */
function readPendingRemovals(dataDir = '', now = Date.now()) {
  const out = [];
  for (const [key, it] of Object.entries(readPendingRemovalsAll(dataDir))) {
    if (!it || typeof it !== 'object' || it.removed_at) continue;
    if (it.decision) {
      if (it.decision !== 'later') continue;
      const until = Date.parse(it.later_until || '');
      if (!Number.isFinite(until) || until > now) continue;
    }
    const id = String(it.task_id || key);
    if (!REMOVAL_ID.test(id)) continue;
    out.push({
      task_id: id,
      worktree: String(it.worktree || ''),
      dirty: Boolean(it.dirty),
      reason: it.reason === 'hung_dirty' ? 'hung_dirty' : 'hung_clean',
      last_output_at: it.last_output_at || it.first_seen_at || null,
    });
  }
  return out;
}

function pluginRoot(pluginPath = '') {
  const script = resolveWatchdogScript(pluginPath);
  return script ? path.dirname(path.dirname(script)) : '';
}

/** decision: 'approve' | 'later' | 'keep'. Runs python3 <repo>/core/wk_cli.py watchdog <sub> <task_id>; resolves {ok, task_id, decision, message}. */
function runRemovalDecision(dataDir = '', pluginPath = '', decision = '', taskId = '', opts = {}) {
  const sub = REMOVAL_SUB[decision];
  if (!sub) return Promise.resolve({ ok: false, message: 'Unknown choice. Nothing was changed.' });
  if (!REMOVAL_ID.test(String(taskId))) return Promise.resolve({ ok: false, message: 'Unknown task. Nothing was changed.' });
  if (opts.trusted === false) return Promise.resolve({ ok: false, message: 'Untrusted workspace: nothing was changed.' });
  if (decision === 'approve' && isKillOn(dataDir)) return Promise.resolve({ ok: false, message: 'The Stop switch is on (~/.wk/KILL). Nothing was removed.' });
  if (!readPendingRemovals(dataDir).some(x => x.task_id === taskId)) {
    return Promise.resolve({ ok: false, message: 'That worktree is not waiting any more. Nothing was changed.' });
  }
  const root = pluginRoot(pluginPath);
  const cli = root && path.join(root, 'core', 'wk_cli.py');
  if (!cli || !fs.existsSync(cli)) return Promise.resolve({ ok: false, message: 'core/wk_cli.py not found. Nothing was changed.' });
  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONPATH: root, WK_HOME: resolveWkHome(dataDir) };
    execFile(findPython(), [cli, 'watchdog', sub, String(taskId)], { env, cwd: root, timeout: Number(opts.timeoutMs) || 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const lines = String(stdout || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0 && !parsed; i -= 1) parsed = parseJsonSafe(lines[i], null);
      if (parsed && typeof parsed === 'object') {
        resolve({ ok: parsed.ok === true, task_id: parsed.task_id || taskId, decision: parsed.decision || decision, message: String(parsed.message || (parsed.ok ? 'Done.' : 'That did not work.')) });
        return;
      }
      resolve({ ok: false, task_id: taskId, decision, message: String((err && err.message) || stderr || 'That did not work.').split('\n')[0].slice(0, 300) });
    });
  });
}

function runWatchdogCli(dataDir = '', pluginPath = '', action = 'scan', opts = {}) {
  const act = ['scan', 'status', 'recover'].includes(action) ? action : 'scan';
  if (act === 'recover' && opts.trusted === false) {
    return Promise.resolve({ ok: false, error: 'Untrusted workspace: recovery disabled.' });
  }
  if (act === 'recover' && !opts.dryRun && isKillOn(dataDir)) {
    return Promise.resolve({ ok: false, killed: true, error: 'Kill switch active (~/.wk/KILL); recovery refused.' });
  }
  const script = resolveWatchdogScript(pluginPath);
  if (!script) {
    return Promise.resolve({ ok: false, error: 'core/watchdog.py not found.' });
  }
  const args = [script, act, '--json'];
  if (dataDir) args.push('--wk-home', resolveWkHome(dataDir));
  if (act === 'recover' && opts.dryRun) args.push('--dry-run');

  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONPATH: path.dirname(path.dirname(script)) };
    if (dataDir) env.WK_HOME = resolveWkHome(dataDir);
    execFile(findPython(), args, { env, timeout: Number(opts.timeoutMs) || 12000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const parsed = parseJsonSafe(String(stdout || '').trim(), null);
      if (parsed) {
        resolve(parsed);
        return;
      }
      resolve({ ok: false, error: String((err && err.message) || stderr || 'Watchdog command failed').trim() });
    });
  });
}

function attachWatchdogToExtension(ctx, panel) {
  if (!ctx || !panel) return;
  const vscode = getVscode();
  if (!vscode) return;
  const subs = Array.isArray(ctx.subscriptions) ? ctx.subscriptions : [];
  const getCfg = () => {
    const raw = typeof panel.cfg === 'function' ? panel.cfg() : { dataDir: '', pluginPath: '' };
    return require('./data').resolvePaths(raw);
  };
  const isTrusted = () => Boolean(vscode.workspace && vscode.workspace.isTrusted === true);
  let busy = false;

  const hasPotentialActiveOrHungWork = (dataDir) => {
    const wkHome = resolveWkHome(dataDir);
    return (
      fs.existsSync(path.join(wkHome, 'jobs')) ||
      fs.existsSync(path.join(wkHome, 'tasks')) ||
      fs.existsSync(path.join(wkHome, 'chat-sessions.json')) ||
      fs.existsSync(path.join(wkHome, 'watchdog', 'processes.json'))
    );
  };

  // One notice per hung task id, ever: remembered in globalState (and notified_at in the contract file).
  const NOTIFIED_KEY = 'watchkeeper.watchdogNotified';
  const notifiedIds = () => {
    try { const v = ctx.globalState && ctx.globalState.get(NOTIFIED_KEY); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  const notifyOnce = (hung, pending) => {
    const seen = new Set(notifiedIds());
    const fresh = hung.filter(it => it && it.id && !seen.has(String(it.id)) && !(pending[it.id] && pending[it.id].notified_at));
    if (!fresh.length) return;
    for (const it of fresh) seen.add(String(it.id));
    try { Promise.resolve(ctx.globalState.update(NOTIFIED_KEY, Array.from(seen).slice(-500))).catch(() => { }); } catch { /* keep going */ }
    const titles = fresh.slice(0, 3).map(it => String(it.title || it.id).slice(0, 60)).join(', ');
    vscode.window?.showWarningMessage?.(`Watchkeeper: ${fresh.length === 1 ? 'a task has' : `${fresh.length} tasks have`} gone quiet (${titles}). Look under "Waiting for you" in the W panel.`);
  };

  const backgroundCheck = async () => {
    if (busy || !isTrusted()) return;
    const c = getCfg();
    if (!c || !c.dataDir || isKillOn(c.dataDir) || !hasPotentialActiveOrHungWork(c.dataDir)) return;
    busy = true;
    try {
      const scan = await runWatchdogCli(c.dataDir, c.pluginPath, 'scan', { trusted: true });
      if (scan && scan.ok && Number(scan.hungCount || 0) > 0) {
        const hung = (Array.isArray(scan.items) ? scan.items : []).filter(it => it && it.classification === 'hung');
        const pending = readPendingRemovalsAll(c.dataDir);
        // Tasks already hung_dirty, or waiting for the owner's decision, are never recovered again by the loop.
        const waits = it => it.reason === 'hung_dirty' || Boolean(pending[it.id] && !pending[it.id].removed_at);
        notifyOnce(hung, pending);
        const fresh = hung.filter(it => !waits(it));
        if (fresh.length || !hung.length) {
          const rec = await runWatchdogCli(c.dataDir, c.pluginPath, 'recover', { trusted: true });
          if (rec && rec.ok && Number(rec.recoveredCount || 0) > 0 && typeof panel.refresh === 'function') {
            panel.refresh();
          }
        } else if (typeof panel.refresh === 'function') {
          panel.refresh();
        }
      }
    } catch { /* non-fatal background watchdog */ } finally {
      busy = false;
    }
  };

  const intervalMs = Math.max(5000, Number(process.env.WK_WATCHDOG_POLL_MS) || 60000);
  const timer = setInterval(backgroundCheck, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  subs.push({ dispose: () => clearInterval(timer) });

  if (vscode.commands && typeof vscode.commands.registerCommand === 'function') {
    subs.push(
      vscode.commands.registerCommand('watchkeeper.watchdogScan', async () => {
        const c = getCfg();
        const res = await runWatchdogCli(c.dataDir, c.pluginPath, 'scan', { trusted: isTrusted() });
        if (res && res.ok) {
          vscode.window?.showInformationMessage?.(
            `Watchkeeper Watchdog: ${res.hungCount || 0} hung, ${res.warningCount || 0} warning, ${res.activeCount || 0} active.`
          );
          if (typeof panel.refresh === 'function') panel.refresh();
        } else {
          vscode.window?.showWarningMessage?.(`Watchkeeper Watchdog scan failed: ${(res && res.error) || 'unknown error'}`);
        }
        return res;
      }),
      vscode.commands.registerCommand('watchkeeper.watchdogRecover', async () => {
        if (!isTrusted()) {
          vscode.window?.showWarningMessage?.('Watchkeeper: Trust this workspace before running watchdog recovery.');
          return { ok: false, error: 'untrusted' };
        }
        const c = getCfg();
        const res = await runWatchdogCli(c.dataDir, c.pluginPath, 'recover', { trusted: true });
        if (res && res.ok) {
          vscode.window?.showInformationMessage?.(
            `Watchkeeper Watchdog recovered ${res.recoveredCount || 0} hanging item(s).`
          );
          if (typeof panel.refresh === 'function') panel.refresh();
        } else {
          vscode.window?.showWarningMessage?.(`Watchkeeper Watchdog recovery blocked: ${(res && res.reason) || (res && res.error) || 'failed'}`);
        }
        return res;
      })
    );
  }
}

module.exports = {
  EMPTY_WATCHDOG,
  // P2-272 4B: shared with panel/src/dag-runner.js (additive).
  isKillOn,
  findPython,
  pluginRoot,
  resolveWkHome,
  readWatchdogSummary,
  readPendingRemovals,
  runRemovalDecision,
  killTrackedChildren,
  runWatchdogCli,
  attachWatchdogToExtension,
};
