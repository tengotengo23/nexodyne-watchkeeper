// Installs the Antigravity plugin (antigravity/plugins/watchkeeper) into ~/.gemini/config/plugins/watchkeeper (P2-208, P2-223).
// Placeholders in .md and .json files: {{NODE}} (a stable node), {{WK_BIN}} (bin/wk-ask-claude.mjs), {{WK_BIN_DIR}} (this bin folder).
// An older copy is backed up to ~/.wk/backups/ (or $WK_HOME/backups/) before it is replaced. Plain file copies only: nothing here runs agy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './lib.mjs';

const homedir = () => (process.env.HOME ? path.resolve(process.env.HOME) : os.homedir());
const wkHome = () => path.resolve(process.env.WK_HOME || path.join(homedir(), '.wk'));
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const uniqueBackup = (prefix, now) => {
  let b = path.join(wkHome(), 'backups', `${prefix}-${stamp(now)}`);
  for (let i = 2; fs.existsSync(b); i++) b = path.join(wkHome(), 'backups', `${prefix}-${stamp(now)}-${i}`);
  return b;
};
export const defaultDest = () => path.join(homedir(), '.gemini', 'config', 'plugins');
export const pluginSource = () => path.join(root(), 'antigravity', 'plugins', 'watchkeeper');

// The node Gemini runs the command with: a path that survives a Homebrew upgrade, and never the IDE's own
// Electron binary (the W panel runs this file with ELECTRON_RUN_AS_NODE, so process.execPath is the app there).
export function findNode({ env = process.env, execPath = process.execPath, stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node'] } = {}) {
  const ok = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  if (env.WK_NODE && path.isAbsolute(env.WK_NODE) && ok(env.WK_NODE)) return env.WK_NODE;
  for (const p of stable) if (ok(p)) return p;
  for (const d of String(env.PATH || '').split(path.delimiter).filter(d => path.isAbsolute(d))) { const p = path.join(d, 'node'); if (ok(p)) return p; }
  return path.basename(execPath) === 'node' ? execPath : 'node';
}

export function findPython({ env = process.env, stable = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'], platform = process.platform } = {}) {
  const ok = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  if (platform === 'win32') return findPythonWindows(env);
  if (env.WK_PYTHON && path.isAbsolute(env.WK_PYTHON) && ok(env.WK_PYTHON)) return env.WK_PYTHON;
  for (const p of stable) if (ok(p)) return p;
  for (const d of String(env.PATH || '').split(path.delimiter).filter(d => path.isAbsolute(d))) { const p = path.join(d, 'python3'); if (ok(p)) return p; }
  return 'python3';
}

// Windows: python.exe, then python3.exe, then the py launcher (it starts Python 3 by default, so no -3 is needed).
// The Microsoft Store stubs in \WindowsApps\ only open the Store, so they are skipped.
function findPythonWindows(env) {
  const w = path.win32, isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (env.WK_PYTHON && w.isAbsolute(env.WK_PYTHON) && isFile(env.WK_PYTHON)) return env.WK_PYTHON;
  const dirs = String(env.PATH || env.Path || '').split(';').filter(d => d && w.isAbsolute(d) && !/\\WindowsApps\\?$/i.test(d));
  for (const n of ['python.exe', 'python3.exe', 'py.exe']) for (const d of dirs) { const p = w.join(d, n); if (isFile(p)) return p; }
  return 'python';
}

function sourceFiles(src) {
  const files = [];
  const walk = (dir, rel = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (e.isFile()) files.push(r); } };
  walk(src);
  return files.sort();
}
function renderer(src) {
  const node = findNode(), python = findPython(), bin = path.join(root(), 'bin'), repromptDir = path.join(root(), 'reprompt');
  const vals = {
    '{{NODE}}': node,
    '{{PYTHON}}': python,
    '{{WK_BIN}}': path.join(bin, 'wk-ask-claude.mjs'),
    '{{WK_BIN_DIR}}': bin,
    '{{WK_REPROMPT_DIR}}': repromptDir,
  };
  return rel => {
    const full = path.join(src, rel);
    if (rel.endsWith('.md')) {
      const s = fs.readFileSync(full, 'utf8');
      return Buffer.from(Object.entries(vals).reduce((t, [k, v]) => t.split(k).join(v), s), 'utf8');
    }
    if (rel.endsWith('.json')) {
      const s = fs.readFileSync(full, 'utf8');
      return Buffer.from(Object.entries(vals).reduce((t, [k, v]) => t.split(k).join(JSON.stringify(v).slice(1, -1)), s), 'utf8');
    }
    return fs.readFileSync(full);
  };
}

// ---------------------------------------------------------------- the hook's pass decision, per machine (P2-223 S1)
// What the PreToolUse hook prints when it lets a call through: in Watchkeeper's conversations for its 8 known tools, in
// your own chats for every tool. "allow" only when Antigravity runs with the Turbo preset, eager commands and Turbo
// browser scripts, so Watchkeeper never loosens a stricter setup. Only those three keys of ~/.gemini/config/config.json
// are read and kept; nothing else in that file is read, printed or stored.
export const hookFile = () => path.join(wkHome(), 'antigravity-hook.json');
export const agyConfigFile = (home = homedir()) => path.join(home, '.gemini', 'config', 'config.json');
export const TURBO = 'AGENT_PERMISSION_PRESET_TURBO', EAGER = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER', BROWSER_TURBO = 'BROWSER_JS_EXECUTION_POLICY_TURBO';
const isTurbo = r => r.preset === TURBO && r.policy === EAGER && r.browser_policy === BROWSER_TURBO;
const settingValue = v => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(v) ? v : null);
export function detectPass({ file = agyConfigFile() } = {}) {
  let preset = null, policy = null, browser_policy = null;
  try {
    const u = JSON.parse(fs.readFileSync(file, 'utf8'))?.userSettings;
    if (u && typeof u === 'object') { preset = settingValue(u.permissionPreset); policy = settingValue(u.autoExecutionPolicy); browser_policy = settingValue(u.browserJsExecutionPolicy); }
  } catch { /* missing or bad: ask */ }
  const r = { preset, policy, browser_policy };
  return { pass: isTurbo(r) ? 'allow' : 'ask', ...r };
}
export function readPass() {
  try { const j = JSON.parse(fs.readFileSync(hookFile(), 'utf8')); if (['allow', 'ask'].includes(j.pass)) return j; } catch {}
  return null;
}
// pass: "allow"|"ask" (by hand), "detect" (back to detection), or undefined: detect, but keep a choice made by hand
export function writePass({ pass, now = new Date() } = {}) {
  if (pass !== undefined && !['allow', 'ask', 'detect'].includes(pass)) throw new Error('--pass must be allow, ask or detect');
  const old = readPass();
  if (pass === undefined && old && old.source === 'flag') return old;
  const d = detectPass();
  const row = { pass: pass === 'allow' || pass === 'ask' ? pass : d.pass, preset: d.preset, policy: d.policy, browser_policy: d.browser_policy, detected_at: now.toISOString(), source: pass === 'allow' || pass === 'ask' ? 'flag' : 'detected' };
  fs.mkdirSync(wkHome(), { recursive: true, mode: 0o700 });
  const p = hookFile(), tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(row, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, p);
  return row;
}
export function passWords(row) {
  if (!row) return 'Pass decision: not set on this machine yet, so in your own chats the hook reads the three Antigravity settings at each call (allow only under the Turbo preset, eager commands and Turbo browser scripts, else ask); in Watchkeeper\'s conversations config/gemini.json decides. Run install to set it.';
  const what = row.pass === 'allow' ? "allow: Antigravity runs Gemini's steps without asking you" : 'ask: Antigravity asks you first, and the hourly automation refuses those steps';
  const why = row.source === 'flag' ? 'you set it with --pass' : isTurbo(row) ? 'your Antigravity uses the Turbo preset, eager commands and Turbo browser scripts'
    : row.preset || row.policy || row.browser_policy ? 'your Antigravity is not on the Turbo preset, eager commands and Turbo browser scripts' : "Watchkeeper found no Antigravity setting";
  return `Pass decision: ${what} (${why}). In the conversations that do Watchkeeper work, Watchkeeper still blocks secrets, pushes, and every step while the kill switch (~/.wk/KILL) is on. Your own chats get only this decision.`;
}

function tidyCandidates(cfgRoot, prefix, candidates, now) {
  const present = candidates.filter(x => fs.existsSync(x.p));
  if (!present.length) return [];
  const backup = uniqueBackup(prefix, now);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const removed = [];
  for (const c of present) {
    const b = path.join(backup, c.rel);
    fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
    fs.cpSync(c.p, b, { recursive: true });
    fs.rmSync(c.p, { recursive: c.dir, force: true });
    removed.push(c.p);
  }
  return removed;
}

function tidyStandaloneGraphify(dest, now) {
  if (path.resolve(dest) !== path.resolve(defaultDest())) return [];
  const cfgRoot = path.dirname(dest);
  return tidyCandidates(cfgRoot, 'antigravity-graphify', [
    { rel: path.join('skills', 'graphify'), p: path.join(cfgRoot, 'skills', 'graphify'), dir: true },
    { rel: path.join('rules', 'graphify.md'), p: path.join(cfgRoot, 'rules', 'graphify.md'), dir: false },
  ], now);
}

function tidyStandaloneRePrompt(dest, now) {
  if (path.resolve(dest) !== path.resolve(defaultDest())) return [];
  const cfgRoot = path.dirname(dest);
  return tidyCandidates(cfgRoot, 'antigravity-reprompt', [
    { rel: path.join('plugins', 're-prompt'), p: path.join(cfgRoot, 'plugins', 're-prompt'), dir: true },
    { rel: path.join('skills', 're-prompt'), p: path.join(cfgRoot, 'skills', 're-prompt'), dir: true },
    { rel: path.join('skills', 'duo-orchestrator'), p: path.join(cfgRoot, 'skills', 'duo-orchestrator'), dir: true },
    { rel: path.join('skills', 'profession-skill-vault'), p: path.join(cfgRoot, 'skills', 'profession-skill-vault'), dir: true },
    { rel: path.join('rules', 're-prompt.md'), p: path.join(cfgRoot, 'rules', 're-prompt.md'), dir: false },
  ], now);
}

export function installAntigravity({ dest = defaultDest(), dryRun = false, now = new Date(), pass } = {}) {
  const src = pluginSource(), target = path.join(dest, 'watchkeeper');
  const files = sourceFiles(src), render = renderer(src);
  if (pass !== undefined && !['allow', 'ask', 'detect'].includes(pass)) throw new Error('--pass must be allow, ask or detect');
  const same = fs.existsSync(target) && files.every(rel => { try { return fs.readFileSync(path.join(target, rel)).equals(render(rel)); } catch { return false; } });
  if (dryRun) return { target, state: same ? 'current' : fs.existsSync(target) ? 'would-update' : 'would-install', files };
  const passRow = writePass({ pass, now });   // again on every install and update: the owner can change the preset
  const removedDuplicates = [
    ...tidyStandaloneGraphify(dest, now),
    ...tidyStandaloneRePrompt(dest, now),
  ];
  if (same) return { target, state: 'current', files, pass: passRow, removedDuplicates };
  let backup = null;
  if (fs.existsSync(target)) {
    backup = uniqueBackup('antigravity-plugin', now);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.cpSync(target, backup, { recursive: true });
    fs.rmSync(target, { recursive: true });
  }
  for (const rel of files) { const p = path.join(target, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, render(rel)); }
  return { target, state: backup ? 'updated' : 'installed', backup, files, pass: passRow, removedDuplicates };
}

const names = (dir, re) => { try { return fs.readdirSync(dir).filter(n => re.test(n)).sort(); } catch { return []; } };
export function antigravityStatus({ dest = defaultDest() } = {}) {
  const target = path.join(dest, 'watchkeeper'), src = pluginSource();
  const readVer = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'plugin.json'), 'utf8')).version || null; } catch { return null; } };
  const installed = fs.existsSync(path.join(target, 'plugin.json'));
  // The self-contained marketplace copy (P2-275) has no plugin source: this runtime/ sits inside the plugin itself, so it is
  // current when the installed copy is the one running.
  const own = path.join(root(), '..'), selfContained = !fs.existsSync(src) && fs.existsSync(path.join(own, 'plugin.json'));
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  let current;
  if (selfContained) current = installed && real(own) === real(target);
  else { const files = sourceFiles(src), render = renderer(src); current = installed && files.every(rel => { try { return fs.readFileSync(path.join(target, rel)).equals(render(rel)); } catch { return false; } }); }
  return {
    target, installed, current, self_contained: selfContained, version: installed ? readVer(target) : null, source_version: readVer(selfContained ? own : src),
    skills: names(path.join(target, 'skills'), /^[a-z0-9-]+$/).filter(n => fs.existsSync(path.join(target, 'skills', n, 'SKILL.md'))),
    agents: names(path.join(target, 'agents'), /\.md$/).map(n => n.replace(/\.md$/, '')),
    rules: names(path.join(target, 'rules'), /\.md$/),
    hooks: fs.existsSync(path.join(target, 'hooks.json')),
    mcp: fs.existsSync(path.join(target, 'mcp_config.json')),
    pass: readPass(),
  };
}
