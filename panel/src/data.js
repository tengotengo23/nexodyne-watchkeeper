'use strict';
// The W panel's data layer (P2-205). Plain Node, no dependencies. It reads files and runs one read-only command
// (`wk-ledger.mjs pace --json`). It writes only two things: the owner inbox line and the kill switch file.
// P2-223, on the owner's press only: nx answer (questions), the plugin's wk-suggest and wk-task, and its own panel-state.json ("Later").
// P2-227: it also reads the jobs (~/.wk/jobs), the projects (~/.wk/projects.json, git read-only, no fetch) and the phone files (remote*.json).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
// P2-227: the one list of legal words, shared with wk-job, the Gemini queue and the steward
const { isLegal, legalLabel } = require('./legal-words');
const { readGraphifyStats } = require('./graphify-layer');
const gate = require('./skill-gate');
const { readLearningSummary, EMPTY_SUMMARY } = require('./learning-bridge');
const { readWatchdogSummary, EMPTY_WATCHDOG } = require('./watchdog-bridge');
const { CHAT_SESSION_ID, TURN_ID, listChatSessionSummaries, listArchivedChatSessions } = require('./chat-sessions');

const HEAD_TAIL = 64 * 1024;
const MAX_TEXT = 4000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const KINDS = ['recommendation', 'rule'];
const COMMANDS = ['ready', 'refresh', 'send', 'kill', 'unkill', 'openAdvice', 'installAsk',
  // P2-223: "Waiting for you" and Gemini
  'answerQuestion', 'laterQuestion', 'decideSuggestion', 'openTaskDiff', 'addTask', 'copyAutomation',
  // P2-227: jobs and the phone
  'jobStart', 'jobReply', 'jobStop', 'trustKey', 'rejectKey', 'remoteOn', 'remoteOff',
  // v0.8.0: Full-IDE workspace, active Re-Prompt, Orchestrator Carbon High, Skills Library
  'openWorkspace', 'toggleMaximize', 'popOutWorkspace', 'repromptRewrite', 'repromptSend', 'repromptCopy', 'repromptStudio', 'repromptToggleAuto', 'orchestrateRun', 'skillsSync',
  // v2.1.0: Conversational session GUI with inline confirmation + mixed-model thinking visibility + seamless task/workspace takeover
  'chatNew', 'chatSelect', 'chatDelete', 'chatDraft', 'chatConfirm', 'chatCancel', 'chatSendToIde', 'chatInspectClaude', 'chatContinueFromClaude', 'chatToggleConfirm', 'chatToggleSyncIde', 'chatTakeTask', 'chatHandoffToClaude', 'chatToggleAutoTake',
  // P2-272 4B: the task splitter's plan card (dag-runner.js)
  'dagRun', 'dagNotNow', 'dagStop', 'dagMerge', 'dagMergeNo', 'dagCheck',
  // Watchdog 1-click scan & recovery actions
  'watchdogScan', 'watchdogRecover', 'graphRefresh',
  // P2-277 Bridge: open the waiting work in Claude (a terminal) or in Antigravity (wk-bridge open)
  'bridgeOpenClaude', 'bridgeOpenAntigravity',
  // P2-272 (B): the owner approves or rejects a staged skill source
  'skillApprove', 'skillReject',
  // P2-272 (P3-B): archive a finished session (✓ Done or /done) and reopen one from Archived (N)
  'chatDone', 'chatReopen',
  // P2-272 (P3 fixes, M1): delete an archived session for good, only with confirmed: true from the confirm line
  'chatPurge'];
// P2-272 (B): a skill source's slug or owner/repo; never starts with '-' (it becomes a CLI argument).
const SOURCE_REF = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})?$/;
const RP_TARGETS = ['auto', 'antigravity', 'claude', 'general'];
const RP_MODES = ['auto', 'balanced', 'spec', 'bugfix', 'refactor', 'concise'];
const ORCH_PREFER = ['auto', 'carbon', 'claude', 'gemini'];
const SESSION_ID = /^[A-Za-z0-9_-]{4,100}$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const statOrNull = p => { try { return fs.statSync(p); } catch { return null; } };

function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

// P2-243: where the Watchkeeper plugin is, in this order: the pluginPath setting when set; ~/Projects/watchkeeper (a clone) when it
// holds bin/wk-ledger.mjs and config/gates.json; the newest watchkeeper@* entry in Claude Code's plugins/installed_plugins.json whose
// installPath holds both; otherwise '' (none: the plugin parts stay hidden). A missing or broken file is "none", never an error.
const holdsPlugin = dir => typeof dir === 'string' && path.isAbsolute(dir)
  && !!statOrNull(path.join(dir, 'bin', 'wk-ledger.mjs')) && !!statOrNull(path.join(dir, 'config', 'gates.json'));
function installedPluginPath(claudeDir) {
  const j = readJsonSmall(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 1024 * 1024);
  if (!j || !isObj(j.plugins)) return '';
  let best = '', bestAt = -Infinity;
  for (const [name, list] of Object.entries(j.plugins)) {
    if (!/^watchkeeper@[^@\s]+$/.test(name) || !Array.isArray(list)) continue;
    for (const e of list) {
      if (!isObj(e) || !holdsPlugin(e.installPath)) continue;
      const at = Math.max(Date.parse(e.lastUpdated) || 0, Date.parse(e.installedAt) || 0);
      if (at > bestAt) { best = e.installPath; bestAt = at; }
    }
  }
  return best;
}
function findPlugin(setting, home, claudeDir) {
  if (typeof setting === 'string' && setting.trim()) return expandHome(setting.trim(), home);
  const clone = path.join(home, 'Projects', 'watchkeeper');
  if (holdsPlugin(clone)) return clone;
  try { return installedPluginPath(claudeDir); } catch { return ''; }
}

function resolvePaths(cfg = {}, home = os.homedir()) {
  const pick = (k, d) => expandHome(typeof cfg[k] === 'string' && cfg[k].trim() ? cfg[k].trim() : d, home);
  const claudeDir = pick('claudeDir', '~/.claude');
  return {
    pluginPath: findPlugin(cfg.pluginPath, home, claudeDir),
    dataDir: pick('dataDir', '~/.wk'),
    claudeDir,
    orchestrationDir: pick('orchestrationDir', ''),   // locks only; empty: the panel looks in the open workspace (extension.js). Questions: questionsDir()
    home,
  };
}

// ---------------------------------------------------------------- pace
const PACE_FIELDS = ['decision', 'reason', 'used', 'elapsed', 'target', 'behindPoints', 'limit', 'reservePoints', 'reserveHeld',
  'reserveReleaseAt', 'hoursLeft', 'resetsAt', 'meterAgeMin', 'fiveHour'];

function readPace(pluginPath, dataDir, { timeoutMs = 8000, nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-ledger.mjs');
  if (!statOrNull(script)) return Promise.resolve({ state: 'no-plugin', script });
  const env = {
    HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin',
    WK_STEWARD_DIR: path.join(dataDir, 'steward'), WK_LEDGER: path.join(dataDir, 'ledger.jsonl')
  };
  if (process.env.WK_NOW) env.WK_NOW = process.env.WK_NOW;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const bin = nodeBin || process.execPath;
  return new Promise(resolve => {
    execFile(bin, [script, 'pace', '--json'], { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, cwd: pluginPath },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        let j = null;
        const lines = String(stdout || '').trim().split('\n').filter(Boolean);
        try { j = JSON.parse(lines[lines.length - 1]); } catch { j = null; }
        if (isObj(j) && j.reason === 'meter') return resolve({ state: 'no-meter', code, detail: String(j.detail || 'no meter reading').slice(0, 200) });
        if (isObj(j) && Number.isFinite(j.used)) {
          const pace = {}; for (const k of PACE_FIELDS) if (k in j) pace[k] = j[k];
          return resolve({ state: 'ok', code, pace });
        }
        if (code === 3) return resolve({ state: 'no-meter', code, detail: 'no meter reading' });
        const first = String(stderr || (err && err.message) || 'no output').trim().split('\n')[0].slice(0, 200);
        return resolve({ state: 'error', code, detail: first });
      });
  });
}

// ---------------------------------------------------------------- the status bar's one line (P2-272 Phase 3)
// `bin/wk-status.mjs --json` gives { line, ... }; the panel shows only `line`. The child leads its own process group and the whole
// group is ended on a timeout (the process-group rule); nothing runs while the Stop switch (KILL) is on. Cached for ttlMs.
const STATUS_CACHE = new Map();
function readStatusLine(pluginPath, dataDir, { timeoutMs = 8000, nodeBin, cwd, killOn = false, ttlMs = 30000, now = Date.now() } = {}) {
  const script = path.join(pluginPath || '', 'bin', 'wk-status.mjs');
  if (!pluginPath || !statOrNull(script)) return Promise.resolve({ state: 'no-plugin', line: '' });
  if (killOn) return Promise.resolve({ state: 'stopped', line: '' });
  const key = `${script}\n${dataDir}\n${cwd || ''}`, hit = STATUS_CACHE.get(key);
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value);
  const env = childEnv({ WK_HOME: dataDir });
  if (process.env.WK_NOW) env.WK_NOW = process.env.WK_NOW;
  const bin = nodeBin || process.execPath;
  const runCwd = cwd && path.isAbsolute(cwd) && statOrNull(cwd) ? cwd : pluginPath;
  return new Promise(resolve => {
    let child, out = '', done = false, timer;
    const finish = value => {
      if (done) return; done = true; clearTimeout(timer);
      if (value.state === 'ok') STATUS_CACHE.set(key, { at: now, value });
      resolve(value);
    };
    try {
      child = spawn(bin, [script, '--json'], { cwd: runCwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
    } catch (e) { return finish({ state: 'error', line: '' }); }
    timer = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid > 1) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
      finish({ state: 'error', line: '' });
    }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 512 * 1024) out += d; });
    child.on('error', () => finish({ state: 'error', line: '' }));
    child.on('close', () => {
      let j = null; try { j = JSON.parse(out); } catch { j = null; }
      const line = isObj(j) && typeof j.line === 'string' ? oneLine(j.line).slice(0, 200) : '';
      finish(line ? { state: 'ok', line } : { state: 'error', line: '' });
    });
  });
}

// ---------------------------------------------------------------- the usage card (P2-272 Phase 3, spec 3.4)
// steward/meter.json keeps every rate-limit window the last headless call reported (bin/steward-lib.mjs meterFromEvents).
// A window that is missing, unreadable or past its reset time is "no reading yet": the card never shows an old number as current.
const USAGE_WINDOWS = ['seven_day', 'seven_day_fable', 'seven_day_opus', 'seven_day_sonnet', 'five_hour'];
const USAGE_KEY = /^(seven_day(_[a-z0-9_]{1,24})?|five_hour)$/;
function readUsageWindows(dataDir, now = Date.now()) {
  const m = readJsonSmall(path.join(dataDir || '', 'steward', 'meter.json'));
  const out = { found: !!m, fetchedAt: 0, windows: {} };
  if (!m) return out;
  const f = Date.parse(m.fetchedAt); out.fetchedAt = Number.isFinite(f) ? f : 0;
  const all = isObj(m.windows) ? { ...m.windows } : {};
  // older meters have no `windows`: the top-level reading is the weekly one, fiveHour the five-hour one
  if (!isObj(all.seven_day) && Number.isFinite(m.utilization) && Number.isFinite(+m.resetsAt)) all.seven_day = { utilization: m.utilization, resetsAt: m.resetsAt };
  if (!isObj(all.five_hour) && isObj(m.fiveHour)) all.five_hour = m.fiveHour;
  for (const [k, w] of Object.entries(all)) {
    if (!USAGE_KEY.test(k) || !isObj(w)) continue;
    const u = typeof w.utilization === 'number' ? w.utilization : NaN, r = Number(w.resetsAt);
    if (!Number.isFinite(u) || u < 0 || !Number.isFinite(r) || r <= 0) continue;
    const resetsAt = r < 1e11 ? r * 1000 : r;          // seconds in the meter; milliseconds tolerated
    if (resetsAt <= now) continue;                      // the window has reset since the reading: no reading yet
    // P2-272 (P3 fixes, S8): today's writers (steward-lib norm(), wk-handoff onStatusLine) store a fraction, so 1.2 is 120 %: over the
    // limit, shown as such, never folded into a silent 100. `over` says so; pct is not capped. A reading above 1.5 is taken as an
    // older meter's percentage (kept from stage C; the old-style test pins 12 as 12 %).
    const pct = Math.max(0, Math.round(u > 1.5 ? u : u * 100));
    out.windows[k] = { pct, over: pct > 100, resetsAt };
  }
  return out;
}

// The Claude account the IDE is signed in to: `claude auth status --json` (no secrets in it), only `email` kept. The child leads its own
// process group, is ended after timeoutMs, never runs while the Stop switch is on, and the answer is cached for ttlMs.
// P2-272 (P3 fixes, S7): an 'ok' answer is kept for ttlMs (10 minutes); every other state (signed out, unknown, error) for errTtlMs
// (30 seconds), so a failed read is not retried on every refresh nor kept for long. clearAccountCache() empties it (the Refresh button).
const ACCOUNT_CACHE = new Map();
function clearAccountCache() { ACCOUNT_CACHE.clear(); }
const EMAIL = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]{1,190}$/;
function readClaudeAccount({ timeoutMs = 5000, killOn = false, ttlMs = 10 * 60 * 1000, errTtlMs = 30 * 1000, now = Date.now(), env, bin = 'claude', cwd } = {}) {
  if (killOn) return Promise.resolve({ state: 'stopped', email: '' });
  const runEnv = env || childEnv();
  const key = `${bin}\n${runEnv.HOME || ''}\n${runEnv.PATH || ''}`, hit = ACCOUNT_CACHE.get(key);
  if (hit && now - hit.at < (hit.value.state === 'ok' ? ttlMs : errTtlMs)) return Promise.resolve(hit.value);
  return new Promise(resolve => {
    let child, out = '', done = false, timer;
    const finish = value => {
      if (done) return; done = true; clearTimeout(timer);
      ACCOUNT_CACHE.set(key, { at: now, value });
      resolve(value);
    };
    try {
      child = spawn(bin, ['auth', 'status', '--json'], { cwd: cwd || runEnv.HOME || os.homedir(), env: runEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
    } catch (e) { return finish({ state: 'error', email: '' }); }
    timer = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid > 1) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
      finish({ state: 'error', email: '' });
    }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 64 * 1024) out += d; });
    child.on('error', () => finish({ state: 'error', email: '' }));
    child.on('close', () => {
      let j = null; try { j = JSON.parse(out); } catch { j = null; }
      if (!isObj(j)) return finish({ state: 'error', email: '' });
      const email = typeof j.email === 'string' && EMAIL.test(j.email.trim()) ? j.email.trim() : '';
      finish({ state: j.loggedIn === false ? 'signed-out' : email ? 'ok' : 'unknown', email: j.loggedIn === false ? '' : email });
    });
  });
}

// Gemini through Antigravity: Watchkeeper's own count (the orchestrator's orchestrator_usage.json, reset each UTC day), never Antigravity's
// login files. There is no weekly Gemini figure anywhere (orchestrator_usage.json holds one UTC day only). The only dated record is the
// wk-task queue (tasks/<id>/meta.json created_at), so the week line counts tasks queued for Antigravity (P2-272 P3 fixes, M3).
// The label is only what the owner typed.
function geminiDataDir(home, env = process.env) {
  const e = env.REPROMPT_DATA_DIR || env.PLUGIN_DATA;
  if (e) return e === '~' ? home : /^~[\/]/.test(e) ? path.join(home, e.slice(2)) : e;
  const wk = path.join(home, '.gemini', 'antigravity', 'plugin_data', 'watchkeeper');
  if (statOrNull(wk) && statOrNull(wk).isDirectory()) return wk;
  return process.platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 're-prompt')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 're-prompt')
      : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 're-prompt');
}
const cleanLabel = v => typeof v === 'string' ? oneLine(v).slice(0, 80) : '';
const WEEK_MS = 7 * 24 * 3600 * 1000;
function countWeekTasks(dataDir, now = Date.now()) {
  let names; try { names = fs.readdirSync(path.join(dataDir, 'tasks')).filter(x => TASK_ID.test(x)); } catch { return null; }
  let n = 0;
  for (const id of names.slice(-500)) {
    const m = readJsonSmall(path.join(dataDir, 'tasks', id, 'meta.json'), 64 * 1024);
    const at = m && m.id === id ? Date.parse(m.created_at) : NaN;
    if (Number.isFinite(at) && at <= now + 60000 && now - at < WEEK_MS) n++;
  }
  return n;
}
function readGeminiUsage(home, { now = Date.now(), env = process.env, label = '', dataDir = '' } = {}) {
  const out = { label: cleanLabel(label), tracked: false, today: null, cooldownUntil: 0, cooldownReason: '', weekTasks: dataDir ? countWeekTasks(dataDir, now) : null };
  const raw = readJsonSmall(path.join(geminiDataDir(home || os.homedir(), env), 'orchestrator_usage.json'), 512 * 1024);
  const u = raw && isObj(raw.providers) && isObj(raw.providers.gemini) ? raw.providers.gemini : null;
  if (!u) return out;
  out.tracked = true;
  const today = new Date(now).toISOString().slice(0, 10);
  if (raw.date === today) out.today = { requests: Math.max(0, Math.floor(Number(u.requests) || 0)), spendUsd: Math.max(0, Number(u.spend_usd) || 0) };
  const until = Number(u.cooldown_until || 0) * 1000;
  if (until > now) { out.cooldownUntil = until; out.cooldownReason = oneLine(String(u.cooldown_reason || '')).slice(0, 60); }
  return out;
}

// ---------------------------------------------------------------- reading big files safely
function readHeadTail(file, n = HEAD_TAIL) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 2 * n) {
      const buf = Buffer.alloc(size); let got = 0;
      while (got < size) { const r = fs.readSync(fd, buf, got, size - got, got); if (!r) break; got += r; }
      return { head: buf.toString('utf8', 0, got), tail: '', size, bytesRead: got, whole: true };
    }
    const h = Buffer.alloc(n), t = Buffer.alloc(n);
    const hr = fs.readSync(fd, h, 0, n, 0), tr = fs.readSync(fd, t, 0, n, size - n);
    return { head: h.toString('utf8', 0, hr), tail: t.toString('utf8', 0, tr), size, bytesRead: hr + tr, whole: false };
  } finally { fs.closeSync(fd); }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  let ls = String(text).split('\n');
  if (dropFirst) ls = ls.slice(1);
  if (dropLast) ls = ls.slice(0, -1);
  const out = [];
  for (const l of ls) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (isObj(o)) out.push(o); } catch { /* partial or bad line */ } }
  return out;
}

// ---------------------------------------------------------------- names
function decodeProject(folder, user = os.userInfo().username) {
  let s = String(folder || '');
  if (/^-(private-)?tmp-/.test(s)) { const m = s.match(/-scratchpad-?(.*)$/); return m && m[1] ? `scratchpad ${m[1]}` : 'temporary folder'; }
  const homeRe = new RegExp('^-(?:Users|home)-' + user.replace(/[^A-Za-z0-9]/g, '.') + '(?:-|$)');
  if (homeRe.test(s)) s = s.replace(homeRe, ''); else s = s.replace(/^-(?:Users|home)-[^-]+-?/, '');
  if (!s) return 'home folder';
  for (const pre of ['Library-Mobile-Documents-com-apple-CloudDocs-', 'Projects-', 'Developer-', 'Documents-', 'Desktop-', 'code-', 'src-']) {
    if (s.startsWith(pre) && s.length > pre.length) { s = s.slice(pre.length); break; }
  }
  return s;
}

function modelName(id) {
  if (typeof id !== 'string' || !id || id === '<synthetic>') return '';
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  if (/^[a-z]+$/i.test(id)) return cap(id);
  return id.slice(0, 40);
}

// ---------------------------------------------------------------- sessions
function cleanText(t) {
  return String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[a-zA-Z][\w:-]*(\s[^>]{0,300})?>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function userText(o) {
  if (!isObj(o) || o.type !== 'user' || o.isMeta || o.isSidechain || !isObj(o.message)) return '';
  const c = o.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.filter(p => isObj(p) && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join(' ');
  t = cleanText(t);
  if (!t || t.startsWith('/') || /^\[Request interrupted/.test(t) || /^Caveat:/.test(t)) return '';
  return t;
}

function sessionInfo(file) {
  const ht = readHeadTail(file);
  const head = parseLines(ht.head, { dropLast: !ht.whole });
  const tail = ht.whole ? [] : parseLines(ht.tail, { dropFirst: true });
  let first = '', summary = '', custom = '', cwd = '', model = '';
  for (const o of head.concat(tail)) {
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!first) first = userText(o);
    if (o.type === 'summary' && typeof o.summary === 'string') summary = o.summary;
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') summary = o.aiTitle;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
    if (o.type === 'assistant' && isObj(o.message) && typeof o.message.model === 'string' && o.message.model !== '<synthetic>') model = o.message.model;
  }
  const title = (cleanText(custom) || cleanText(summary) || first || 'Untitled session').slice(0, 80);
  return { title, cwd, model: modelName(model), size: ht.size, bytesRead: ht.bytesRead };
}

function readMembers(subDir, now = Date.now()) {
  let names; try { names = fs.readdirSync(subDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^agent-[\w-]+\.meta\.json$/.test(n)) continue;
    const metaPath = path.join(subDir, n);
    let meta; try { const st = fs.statSync(metaPath); if (st.size > 64 * 1024) continue; meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
    if (!isObj(meta)) continue;
    const log = statOrNull(path.join(subDir, n.replace(/\.meta\.json$/, '.jsonl'))) || statOrNull(metaPath);
    const at = log ? log.mtimeMs : 0;
    const task = cleanText(typeof meta.description === 'string' ? meta.description : '').slice(0, 160) || 'No task given';
    const finished = meta.finished === true;
    const state = finished ? 'done' : now - at < 30 * MIN ? 'running' : 'stopped';
    out.push({
      id: n.replace(/\.meta\.json$/, ''), role: /\breview/i.test(task) ? 'Reviewer' : 'Worker', task,
      model: modelName(meta.model), effort: typeof meta.effort === 'string' ? meta.effort.slice(0, 12) : '',
      state, at, depth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : 1
    });
  }
  const rank = { running: 0, stopped: 1, done: 2 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
}

function listSessions(claudeDir, now = Date.now(), { windowMs = 24 * HOUR, activeMs = 10 * MIN, max = 25 } = {}) {
  const root = path.join(claudeDir, 'projects');
  let folders; try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return { missing: true, root, sessions: [], more: 0 }; }
  const found = [];
  for (const d of folders) {
    if (!d.isDirectory()) continue;
    let files; try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!/^[\w-]+\.jsonl$/.test(f)) continue;
      const p = path.join(root, d.name, f), st = statOrNull(p);
      if (!st || !st.isFile() || now - st.mtimeMs > windowMs) continue;
      found.push({ folder: d.name, file: p, id: f.slice(0, -6), mtime: st.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const s of found.slice(0, max)) {
    let info; try { info = sessionInfo(s.file); } catch { continue; }
    sessions.push({
      id: s.id, title: info.title, project: info.cwd ? path.basename(info.cwd) : decodeProject(s.folder),
      cwd: info.cwd || '',
      at: s.mtime, active: now - s.mtime < activeMs, model: info.model, tokens: Math.round(info.size / 2.5),
      members: readMembers(path.join(root, s.folder, s.id, 'subagents'), now)
    });
  }
  sessions.sort((a, b) => (b.active - a.active) || b.at - a.at);
  return { missing: false, root, sessions, more: Math.max(0, found.length - max) };
}

function readClaudeTranscript(claudeDir, sessionId, { maxBytes = 256 * 1024, maxTurns = 30 } = {}) {
  if (!claudeDir || !SESSION_ID.test(String(sessionId || ''))) return null;
  const root = path.resolve(claudeDir, 'projects');
  let folders;
  try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const d of folders) {
    if (!d.isDirectory()) continue;
    const cand = path.resolve(root, d.name, `${sessionId}.jsonl`);
    if (!cand.startsWith(root + path.sep)) continue;
    const st = statOrNull(cand);
    if (!st || !st.isFile()) continue;

    let raw = '';
    if (st.size > maxBytes) {
      const fd = fs.openSync(cand, 'r');
      try {
        const b = Buffer.alloc(maxBytes);
        const r = fs.readSync(fd, b, 0, maxBytes, st.size - maxBytes);
        raw = b.toString('utf8', 0, r).split('\n').slice(1).join('\n');
      } finally { fs.closeSync(fd); }
    } else {
      raw = fs.readFileSync(cand, 'utf8');
    }

    const lines = parseLines(raw);
    const info = sessionInfo(cand);
    const turns = [];
    for (const o of lines) {
      if (o.type === 'user' && !o.isMeta && !o.isSidechain && isObj(o.message)) {
        const txt = userText(o);
        if (txt) {
          turns.push({ role: 'user', at: Date.parse(o.timestamp) || 0, text: txt.slice(0, 4000) });
        }
      } else if (o.type === 'assistant' && isObj(o.message)) {
        const rawM = typeof o.message.model === 'string' && o.message.model !== '<synthetic>' ? modelName(o.message.model) : '';
        const content = o.message.content;
        const thinking = [];
        const text = [];
        const tools = [];
        if (typeof content === 'string') text.push(content);
        else if (Array.isArray(content)) {
          for (const b of content) {
            if (!isObj(b)) continue;
            if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) thinking.push(b.thinking.trim());
            else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) text.push(b.text.trim());
            else if (b.type === 'tool_use' && b.name && !tools.includes(String(b.name))) tools.push(String(b.name));
          }
        }
        if (text.length || thinking.length || tools.length) {
          turns.push({
            role: 'assistant',
            at: Date.parse(o.timestamp) || 0,
            model: rawM || info.model || 'Claude',
            thinking: thinking.join('\n').slice(0, 4000),
            tools: tools.slice(0, 16),
            text: text.join('\n').slice(0, 4000),
          });
        }
      }
    }
    const members = readMembers(path.join(root, d.name, sessionId, 'subagents'));
    return {
      id: sessionId,
      title: info.title,
      project: info.cwd ? path.basename(info.cwd) : decodeProject(d.name),
      cwd: info.cwd || '',
      model: info.model,
      turns: turns.slice(-maxTurns),
      members,
    };
  }
  return null;
}

// ---------------------------------------------------------------- ledger
function readLedger(file, now = Date.now(), days = 7) {
  const empty = { totals: { usd: 0, runs: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }, top: [], wakeups: [], bad: 0 };
  const st = statOrNull(file);
  if (!st) return { missing: true, file, ...empty };
  const cap = 8 * 1024 * 1024;
  let text;
  if (st.size > cap) { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(cap); const r = fs.readSync(fd, b, 0, cap, st.size - cap); text = b.toString('utf8', 0, r).split('\n').slice(1).join('\n'); } finally { fs.closeSync(fd); } }
  else text = fs.readFileSync(file, 'utf8');
  const since = now - days * 24 * HOUR, by = new Map(), out = { missing: false, file, ...empty, totals: { ...empty.totals }, wakeups: [] };
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { out.bad++; continue; }
    const at = isObj(o) ? Date.parse(o.at) : NaN;
    if (!isObj(o) || !Number.isFinite(at) || typeof o.item !== 'string') { out.bad++; continue; }
    if (at < since || at > now + HOUR) continue;
    const usd = num(o.cost_usd), t = out.totals;
    t.usd += usd; t.runs++; t.in += num(o.in); t.cache_read += num(o.cache_read); t.cache_write += num(o.cache_write); t.out += num(o.out);
    const item = o.item.slice(0, 80), cur = by.get(item) || { item, usd: 0, runs: 0 };
    cur.usd += usd; cur.runs++; by.set(item, cur);
    if (/wake/i.test(item)) out.wakeups.push({ item, at, usd, lens: typeof o.lens === 'string' ? o.lens.slice(0, 40) : '', model: modelName(o.model), error: o.error === true });
  }
  out.top = [...by.values()].sort((a, b) => b.usd - a.usd).slice(0, 5);
  out.wakeups.sort((a, b) => b.at - a.at); out.wakeups = out.wakeups.slice(0, 8);
  return out;
}

// ---------------------------------------------------------------- locks
function readLocks(orchDir) {
  if (typeof orchDir !== 'string' || !path.isAbsolute(orchDir)) return { missing: true, locks: [] };
  const dir = path.join(orchDir, 'locks');
  let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { missing: true, locks: [] }; }
  const locks = [];
  for (const d of names) {
    if (!d.isFile() || d.name.startsWith('.') || !/^[\w-]{1,40}$/.test(d.name)) continue;
    let raw; try { const p = path.join(dir, d.name); if (fs.statSync(p).size > 4096) continue; raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const line = raw.split('\n')[0].trim(); if (!line) continue;
    const [pid, label = '', since = ''] = line.split('|');
    const m = label.match(/\b[A-Z][A-Z0-9]*-\d+\b/);
    locks.push({ area: d.name, pid: /^\d+$/.test(pid) ? pid : '', label: cleanText(label).slice(0, 80), since: since.trim().slice(0, 16), item: m ? m[0] : '' });
  }
  return { missing: false, locks: locks.sort((a, b) => a.area.localeCompare(b.area)) };
}

// ---------------------------------------------------------------- owner inbox (one of the two writes)
const inboxFile = dataDir => path.join(dataDir, 'owner-inbox.jsonl');

// P2-223: kind 'decision' records an answer the owner gave in the panel: appendInbox(dataDir, 'decision', {ref, choice, title, text?}).
const DECISION_CHOICES = ['ok', 'later', 'no', 'answer'];
const DECISION_REF = /^(?:Q[1-9]\d{0,5}|S-\d{8}-\d{6}-[0-9a-f]{4})$/;
function appendInbox(dataDir, kind, text, now = new Date()) {
  let entry;
  if (kind === 'decision') {
    const d = isObj(text) ? text : {};
    if (typeof d.ref !== 'string' || !DECISION_REF.test(d.ref) || !DECISION_CHOICES.includes(d.choice)) throw new Error('bad decision');
    const t = String(d.text == null ? '' : d.text).replace(CONTROL, ' ').trim();
    if (t.length > MAX_TEXT) throw new Error('text length');
    entry = { at: now.toISOString(), kind, ref: d.ref, choice: d.choice, title: String(d.title || '').replace(CONTROL, ' ').trim().slice(0, MAX_TITLE), ...(t ? { text: t } : {}) };
  } else {
    if (!KINDS.includes(kind)) throw new Error('unknown kind');
    const t = String(text || '').trim();
    if (!t || t.length > MAX_TEXT) throw new Error('text length');
    entry = { at: now.toISOString(), kind, text: t, status: 'new' };
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(inboxFile(dataDir), 'a', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(entry) + '\n'); } finally { fs.closeSync(fd); }
  return entry;
}

function readInbox(dataDir, n = 10) {
  const f = inboxFile(dataDir);
  if (!statOrNull(f)) return [];
  const ht = readHeadTail(f, 32 * 1024);
  const rows = ht.whole ? parseLines(ht.head) : parseLines(ht.tail, { dropFirst: true });
  return rows.filter(r => KINDS.includes(r.kind) && typeof r.text === 'string').slice(-n).reverse()
    .map(r => ({ at: Date.parse(r.at) || 0, kind: r.kind, text: r.text.slice(0, 400), status: typeof r.status === 'string' ? r.status.slice(0, 20) : 'new' }));
}

// ---------------------------------------------------------------- questions answered for the owner (P2-208)
// wk-ask-claude writes ~/.wk/advice/<id>/{meta.json,question.md,answer.md}; the panel lists them and opens the files.
const ADVICE_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;
const ADVICE_STATES = ['asking', 'answered', 'failed', 'stopped'];
const str = (v, n) => (typeof v === 'string' ? cleanText(v).slice(0, n) : '');
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function readAdvice(dataDir, n = 5) {
  const dir = path.join(dataDir, 'advice');
  let names;
  try { names = fs.readdirSync(dir).filter(x => ADVICE_ID.test(x)).sort().reverse(); } catch { return { items: [], total: 0 }; }
  const items = [];
  for (const id of names) {
    if (items.length >= n) break;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')); } catch { continue; }
    if (!isObj(m) || m.id !== id) continue;
    let status = ADVICE_STATES.includes(m.status) ? m.status : 'failed';
    if (status === 'asking' && !pidAlive(m.pid)) status = 'stopped';
    items.push({
      id, status, from: str(m.from, 30) || 'an agent', at: Date.parse(m.asked_at) || 0, done: Date.parse(m.finished_at) || 0,
      preview: str(m.preview, 300), error: str(m.error, 160), cost: typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd) ? m.cost_usd : null,
      hasAnswer: !!statOrNull(path.join(dir, id, 'answer.md'))
    });
  }
  return { items, total: names.length };
}

// The only files the panel opens for the owner: an answer or a question inside the advice folder, by a checked id.
function adviceFile(dataDir, id, which = 'answer') {
  if (typeof id !== 'string' || !ADVICE_ID.test(id)) return null;
  const f = path.join(dataDir, 'advice', id, which === 'question' ? 'question.md' : 'answer.md');
  return statOrNull(f) ? f : null;
}

// Can Gemini ask? The ask-claude skill must sit in Antigravity's global plugins, and the plugin must not be switched off.
function askState(home = os.homedir(), pluginPath) {
  const gem = path.join(home, '.gemini', 'config');
  const skill = path.join(gem, 'plugins', 'watchkeeper', 'skills', 'ask-claude', 'SKILL.md');
  const cmd = pluginPath ? path.join(pluginPath, 'bin', 'wk-ask-claude.mjs') : null;
  let off = false;
  try { const c = JSON.parse(fs.readFileSync(path.join(gem, 'config.json'), 'utf8')); off = !!(isObj(c) && isObj(c.plugins) && isObj(c.plugins.watchkeeper) && c.plugins.watchkeeper.enabled === false); } catch { /* no config: not off */ }
  return { installed: !!statOrNull(skill), off, commandOk: !!(cmd && statOrNull(cmd)), skill };
}

function installAsk(pluginPath, { timeoutMs = 15000, nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-ask-claude.mjs');
  if (!statOrNull(script)) return Promise.resolve({ ok: false, text: 'The Watchkeeper plugin folder has no wk-ask-claude command. Check watchkeeper.pluginPath in Settings.' });
  const env = { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin' };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return new Promise(resolve => {
    execFile(nodeBin || process.execPath, [script, 'install-antigravity'], { env, timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, cwd: pluginPath },
      (err, stdout) => resolve(err ? { ok: false, text: 'Installing did not work. Nothing was changed.' }
        : { ok: true, text: String(stdout || '').trim().split('\n')[0].slice(0, 300) || 'Installed.' }));
  });
}

// ---------------------------------------------------------------- updates (P2-209): the last wk-update check here
const UPDATE_RESULTS = ['up to date', 'updated', 'would update', 'skipped', 'paused', 'problem'];
// How this copy of the plugin gets updates: a git clone (wk-update can follow its release tags), Claude Code's plugin cache
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>: `claude plugin update`), or neither.
function updateRoute(pluginPath) {
  if (typeof pluginPath !== 'string' || !pluginPath) return { kind: 'other' };
  const parts = path.resolve(pluginPath).split(path.sep), i = parts.lastIndexOf('cache');
  if (i > 0 && parts[i - 1] === 'plugins' && parts.length >= i + 3) return { kind: 'marketplace', marketplace: parts[i + 1], plugin: parts[i + 2] };
  return statOrNull(path.join(pluginPath, '.git')) ? { kind: 'clone' } : { kind: 'other' };
}

function readUpdate(dataDir, pluginPath) {
  const route = updateRoute(pluginPath);
  let version = null;
  try { const v = JSON.parse(fs.readFileSync(path.join(pluginPath, '.claude-plugin', 'plugin.json'), 'utf8')).version; if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) version = v; } catch { /* no plugin folder */ }
  let r = null;
  try { r = JSON.parse(fs.readFileSync(path.join(dataDir, 'update.json'), 'utf8')); } catch { /* no check has run here */ }
  if (!isObj(r)) return { version, route, last: null };
  const at = Date.parse(r.at);
  return {
    version, route, last: {
      at: Number.isFinite(at) ? at : 0, result: UPDATE_RESULTS.includes(r.result) ? r.result : 'problem', problem: str(r.problem, 300), held: str(r.held, 300),
      moved: isObj(r.moved) ? { from: str(r.moved.from, 20), to: str(r.moved.to, 20) } : null
    }
  };
}

// ---------------------------------------------------------------- kill switch (the other write)
// The policy names the kill file; the panel only follows a path inside the home folder, so an edited policy
// cannot make the panel create or delete a file elsewhere. Anything else falls back to ~/.wk/KILL.
function killFilePath(pluginPath, home = os.homedir()) {
  const fallback = expandHome('~/.wk/KILL', home);
  try {
    const g = JSON.parse(fs.readFileSync(path.join(pluginPath, 'config', 'gates.json'), 'utf8'));
    const f = isObj(g) && isObj(g.kill_switch) ? g.kill_switch.file : null;
    if (typeof f === 'string' && f.trim()) {
      const p = path.resolve(expandHome(f.trim(), home)), h = path.resolve(home);
      if (p.startsWith(h + path.sep) && path.basename(p) !== '') return p;
    }
  } catch { /* default below */ }
  return fallback;
}
function killState(file) { const st = statOrNull(file); return { on: !!st, at: st ? st.mtimeMs : 0, file }; }
function setKill(file, on, now = new Date()) {
  if (on) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 'wx' never follows or overwrites an existing file or link; if one is there, the switch is already on.
    try { fs.writeFileSync(file, `Stopped from the Watchkeeper panel at ${now.toISOString()}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  } else {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return killState(file);
}

// ---------------------------------------------------------------- P2-223: shared helpers for the new parts
const TASK_ID = ADVICE_ID;                                    // the brief: tasks use the advice id format
const SUGGESTION_ID = /^S-\d{8}-\d{6}-[0-9a-f]{4}$/;
const QUESTION_N = /^[1-9]\d{0,5}$/;                          // 1-6 digits, no leading zero (nx greps "Q<n> ")
const CHOICES = ['ok', 'later', 'no'];
const TASK_KINDS = ['read', 'quick', 'code', 'ui', 'plan', 'hard', 'review', 'legal'];
const TASK_STATES = ['queued', 'taken', 'verified', 'failed', 'out-of-scope', 'no-change', 'merged', 'discarded', 'conflict'];
const FROM = ['claude', 'gemini', 'watchkeeper', 'owner'];
const LATER_MS = 24 * HOUR;
const MAX_TITLE = 200, MAX_TEST = 500;
// Control characters (C0, DEL, C1) and the bidirectional overrides that can make a line read differently from what it holds.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
// One line of text for an argument: newlines and tabs fold to spaces, other control characters go, runs of spaces close up.
const oneLine = t => String(t == null ? '' : t).replace(/[\r\n\t\v\f]+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
// Several lines kept (a task's details): only the control characters other than the newline go.
const manyLines = t => String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim();
// About money, legal wording or an account: OK then needs a second press (the brief's word list; the legal words are in legal-words.js).
const MONEY = /\b(?:buy|buying|bought|pay|pays|paid|paying|payment|payments|price|prices|pricing|subscription|subscriptions|account|accounts|password|passwords|sign[ -]?in|stripe)\b|US\$|€|\bGEL\b/i;
const isMoney = t => MONEY.test(String(t || '')) || isLegal(t) !== null;
const isFile = p => { try { const st = fs.lstatSync(p); return st.isFile(); } catch { return false; } };
function readCapped(file, cap) {
  const st = statOrNull(file);
  if (!st || !st.isFile()) return null;
  if (st.size <= cap) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(cap); const r = fs.readSync(fd, b, 0, cap, st.size - cap); return b.toString('utf8', 0, r).split('\n').slice(1).join('\n'); } finally { fs.closeSync(fd); }
}
function readJsonSmall(file, cap = 256 * 1024) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > cap) return null; const j = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(j) ? j : null; } catch { return null; }
}
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmpFile, file);
}
// A child process environment with nothing from the IDE but the home folder and PATH (and WK_HOME for the plugin's scripts).
function childEnv(extra = {}) {
  const env = { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', ...extra };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
// Every run: execFile with an argument array, never a shell.
function run(file, args, { cwd, env, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      const firstLine = s => oneLine(String(s || '').trim().split('\n')[0]).slice(0, 300);
      resolve({ ok: !err, code, out: firstLine(stdout), err: firstLine(stderr) || (err && err.killed ? 'it took too long and was stopped' : '') });
    });
  });
}

// ---------------------------------------------------------------- questions (<orchestration>/QUESTIONS.md, answered only through nx)
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OPEN_Q = /^- \[ \] Q([1-9]\d{0,5}) \(([^)]{0,80})\): (.+)$/;
const RECOMMENDED = /\bRecommended(?: answer)?\s*:\s*/gi;

function questionsAvailable(orchDir) {
  if (typeof orchDir !== 'string' || !path.isAbsolute(orchDir)) return false;
  if (!isFile(path.join(orchDir, 'QUESTIONS.md'))) return false;
  try { const script = path.join(orchDir, 'nx'); if (!fs.statSync(script).isFile()) return false; fs.accessSync(script, fs.constants.X_OK); return true; } catch { return false; }
}

function parseQuestionLine(line) {
  const x = OPEN_Q.exec(line);
  if (!x) return null;
  const n = x[1], head = x[2], full = oneLine(x[3]).slice(0, 8000);
  const dm = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(head.trim());
  const date = dm && +dm[2] >= 1 && +dm[2] <= 12 ? `${+dm[3]} ${MONTHS3[+dm[2] - 1]}` : '';
  const tm = /tab ([^,)]{1,40})\s*$/.exec(head);   // the line format's "tab <x>" names who asked
  const asker = tm ? oneLine(tm[1]).slice(0, 30) : '';
  const id = full.match(/\b[A-Z]\d*-\d+\b/);   // an item id such as T-12 or P2-12
  const from = asker && asker !== '?' ? asker : id ? id[0] : '';
  let body = full, rec = '';
  let last = null, mm; RECOMMENDED.lastIndex = 0;
  while ((mm = RECOMMENDED.exec(full))) last = mm;
  if (last) { body = full.slice(0, last.index).trim(); rec = full.slice(last.index + last[0].length).trim(); }
  return { n, date, from, text: body || full, rec, money: isMoney(full) };
}

function readQuestions(orchDir, now = Date.now(), later = {}) {
  if (!questionsAvailable(orchDir)) return { available: false, items: [], total: 0, hidden: 0 };
  const text = readCapped(path.join(orchDir, 'QUESTIONS.md'), 4 * 1024 * 1024) || '';
  const all = [];
  for (const l of text.split('\n')) { const q = parseQuestionLine(l.replace(/\r$/, '')); if (q) all.push(q); }
  all.sort((a, b) => Number(b.n) - Number(a.n));
  const items = all.filter(q => !(Number(later['Q' + q.n]) > now));
  return { available: true, items, total: all.length, hidden: all.length - items.length };
}

// The only folder whose questions the panel lists and whose nx it runs: "orchestration" in <dataDir>/remote.json, the same rule
// wk-remote and wk-job follow. Never a folder found in a workspace: answering runs that folder's nx, and a workspace is not trusted code.
function questionsDir(dataDir, home = os.homedir()) {
  const j = readJsonSmall(path.join(dataDir, 'remote.json'), 64 * 1024) || {};
  return typeof j.orchestration === 'string' && j.orchestration.trim() ? expandHome(j.orchestration.trim(), home) : '';
}

// Read again just before nx runs: the question must still be an open line.
function findOpenQuestion(orchDir, n) {
  if (!QUESTION_N.test(String(n)) || !questionsAvailable(orchDir)) return null;
  const text = readCapped(path.join(orchDir, 'QUESTIONS.md'), 4 * 1024 * 1024) || '';
  for (const l of text.split('\n')) { const q = parseQuestionLine(l.replace(/\r$/, '')); if (q && q.n === String(n)) return q; }
  return null;
}

const okAnswer = rec => { const r = oneLine(rec); return 'OK: ' + (r.length > 300 ? r.slice(0, 299).trimEnd() + '…' : r); };

// `<orch>/nx answer <n> "<text>"`, run from the orchestration folder's parent; no shell.
function answerQuestion(orchDir, n, text, { timeoutMs = 15000 } = {}) {
  const t = oneLine(text);
  if (!QUESTION_N.test(String(n)) || !t || t.length > MAX_TEXT || !questionsAvailable(orchDir)) return Promise.resolve({ ok: false, code: null, out: '', err: 'not sent' });
  return run(path.join(orchDir, 'nx'), ['answer', String(n), t], { cwd: path.dirname(orchDir), env: childEnv(), timeoutMs });
}

// ---------------------------------------------------------------- panel-state.json (the panel's own "Later" list)
const panelStateFile = dataDir => path.join(dataDir, 'panel-state.json');
function readPanelState(dataDir) {
  const j = readJsonSmall(panelStateFile(dataDir));
  const later = {};
  if (j && isObj(j.later)) for (const [k, v] of Object.entries(j.later)) if (/^Q[1-9]\d{0,5}$/.test(k) && Number.isFinite(v)) later[k] = v;
  return { later };
}
function setLater(dataDir, n, now = Date.now()) {
  if (!QUESTION_N.test(String(n))) throw new Error('bad number');
  const st = readPanelState(dataDir);
  for (const k of Object.keys(st.later)) if (st.later[k] <= now) delete st.later[k];
  st.later['Q' + n] = now + LATER_MS;
  const keep = Object.entries(st.later).sort((a, b) => b[1] - a[1]).slice(0, 500);
  writePrivate(panelStateFile(dataDir), JSON.stringify({ later: Object.fromEntries(keep) }, null, 2) + '\n');
  return st.later['Q' + n];
}

// ---------------------------------------------------------------- suggestions (suggestions.jsonl: items and their events)
function readSuggestions(dataDir, now = Date.now()) {
  const text = readCapped(path.join(dataDir, 'suggestions.jsonl'), 4 * 1024 * 1024);
  if (text == null) return { items: [], total: 0 };
  const items = new Map(), last = new Map();
  for (const o of parseLines(text)) {
    if (typeof o.id !== 'string' || !SUGGESTION_ID.test(o.id)) continue;
    if (typeof o.status === 'string') { if (CHOICES.includes(o.status)) last.set(o.id, { status: o.status, at: Date.parse(o.at) || 0 }); continue; }
    if (typeof o.title !== 'string' || items.has(o.id)) continue;
    const a = isObj(o.action) ? o.action : {};
    const type = a.type === 'task-merge' && typeof a.ref === 'string' && TASK_ID.test(a.ref) ? 'task-merge' : 'none';
    items.set(o.id, {
      id: o.id, at: Date.parse(o.at) || 0, from: FROM.includes(o.from) ? o.from : 'unknown',
      title: oneLine(o.title).slice(0, MAX_TITLE) || 'Untitled suggestion', detail: manyLines(typeof o.detail === 'string' ? o.detail : '').slice(0, MAX_TEXT),
      action: type, ref: type === 'task-merge' ? a.ref : '', money: false
    });
  }
  const open = [];
  for (const s of items.values()) {
    const e = last.get(s.id);
    if (e && (e.status !== 'later' || e.at + LATER_MS > now)) continue;
    s.money = isMoney(s.title + ' ' + s.detail);
    s.hasDiff = s.action === 'task-merge' && !!taskDiffFile(dataDir, s.ref);
    open.push(s);
  }
  open.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return { items: open, total: items.size };
}
const findOpenSuggestion = (dataDir, id, now = Date.now()) => (SUGGESTION_ID.test(String(id)) ? readSuggestions(dataDir, now).items.find(s => s.id === id) || null : null);

// ---------------------------------------------------------------- Gemini: tasks, sessions, config
// P2-277: the owner's hold (tasks/<id>/hold, written by `wk-task hold`): the checker never requeues a held task.
// A hold with an `until` in the past counts as released, as in bin/wk-bridge.mjs holdOf.
function taskHeld(dataDir, id, now = Date.now()) {
  const h = readJsonSmall(path.join(dataDir, 'tasks', id, 'hold'), 16 * 1024);
  if (!h || typeof h !== 'object') return false;
  return !(h.until && Date.parse(h.until) <= now);
}
function readTasks(dataDir, n = 8) {
  const dir = path.join(dataDir, 'tasks');
  let names; try { names = fs.readdirSync(dir).filter(x => TASK_ID.test(x)).sort().reverse(); } catch { return { items: [], total: 0 }; }
  const items = [];
  for (const id of names) {
    if (items.length >= n) break;
    const m = readJsonSmall(path.join(dir, id, 'meta.json'), 64 * 1024);
    if (!m || m.id !== id) continue;
    const t = k => Date.parse(m[k]) || 0;
    items.push({
      id, title: oneLine(m.title).slice(0, MAX_TITLE) || 'Untitled task', kind: TASK_KINDS.includes(m.kind) ? m.kind : '',
      model: str(m.model, 60), fallback: str(m.fallback, 60), modelUsed: str(m.model_used, 60),
      status: TASK_STATES.includes(m.status) ? m.status : 'unknown', from: FROM.includes(m.from) ? m.from : 'unknown',
      at: t('created_at'), takenAt: t('taken_at'), doneAt: t('done_at'), note: str(m.note, 300), hasDiff: !!taskDiffFile(dataDir, id), hasTest: !!m.test,
      held: taskHeld(dataDir, id)
    });
  }
  return { items, total: names.length };
}

// The only task file the panel opens: change.diff inside the task's folder, by a checked id, a plain file (no link).
function taskDiffFile(dataDir, id) {
  if (typeof id !== 'string' || !TASK_ID.test(id)) return null;
  const f = path.join(dataDir, 'tasks', id, 'change.diff');
  return isFile(f) ? f : null;
}

function readGeminiSessions(dataDir, now = Date.now(), n = 5) {
  const text = readCapped(path.join(dataDir, 'gemini', 'sessions.jsonl'), 512 * 1024);
  if (text == null) return { items: [], active: 0 };
  const rows = parseLines(text).map(o => ({
    at: Date.parse(o.at) || 0, id: str(o.conversation_id, 80), model: str(o.model, 60),
    folder: typeof o.workspace === 'string' && o.workspace ? str(path.basename(o.workspace.replace(/[\\/]+$/, '')), 60) : ''
  }))
    .filter(r => r.at && r.at <= now + HOUR).sort((a, b) => b.at - a.at);
  const active = new Set(rows.filter(r => now - r.at < 10 * MIN).map(r => r.id || String(r.at))).size;
  // one row per conversation: its newest stop
  const seen = new Set(), items = [];
  for (const r of rows) { const k = r.id || String(r.at); if (seen.has(k)) continue; seen.add(k); items.push(r); if (items.length >= n) break; }
  return { items, active };
}

// The per-machine pass decision the installer wrote (~/.wk/antigravity-hook.json, shared format). Missing file or bad JSON: unknown.
function readHookPass(dataDir) {
  const j = typeof dataDir === 'string' && path.isAbsolute(dataDir) ? readJsonSmall(path.join(dataDir, 'antigravity-hook.json'), 16 * 1024) : null;
  return { pass: j && (j.pass === 'allow' || j.pass === 'ask') ? j.pass : 'unknown' };
}

function readGeminiConfig(pluginPath) {
  const j = typeof pluginPath === 'string' && path.isAbsolute(pluginPath) ? readJsonSmall(path.join(pluginPath, 'config', 'gemini.json')) : null;
  if (!j) return { found: false, prompt: '', routes: {} };
  const routes = {};
  if (isObj(j.routes)) for (const k of TASK_KINDS) if (isObj(j.routes[k])) routes[k] = { model: str(j.routes[k].model, 60), fallback: str(j.routes[k].fallback, 60), for: str(j.routes[k].for, 200) };
  return { found: true, prompt: typeof j.automation_prompt === 'string' ? manyLines(j.automation_prompt).slice(0, 2000) : '', routes };
}

// ---------------------------------------------------------------- the plugin's scripts (Desk A): decide a suggestion, add a task
// A merge on a big repository, or with slow repository hooks, can take minutes: stopping it half-way would leave MERGE_HEAD behind (review S7).
const MERGE_TIMEOUT_MS = 10 * 60 * 1000;
function decideSuggestion(pluginPath, dataDir, id, choice, text, { timeoutMs = MERGE_TIMEOUT_MS, nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-suggest.mjs');
  if (!SUGGESTION_ID.test(String(id)) || !CHOICES.includes(choice)) return Promise.resolve({ ok: false, code: null, out: '', err: 'not sent' });
  if (!isFile(script)) return Promise.resolve({ ok: false, code: null, out: '', err: 'the plugin has no bin/wk-suggest.mjs yet' });
  const t = oneLine(text).slice(0, MAX_TEXT);
  return run(nodeBin || process.execPath, [script, 'decide', id, choice, ...(t ? ['--text', t] : [])], { cwd: pluginPath, env: childEnv({ WK_HOME: dataDir }), timeoutMs });
}

function addTask(pluginPath, dataDir, { repo, title, text, kind, test }, { timeoutMs = 20000, nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-task.mjs');
  const t = oneLine(title).slice(0, MAX_TITLE), body = manyLines(text).slice(0, MAX_TEXT) || t;
  if (!t || (kind !== 'auto' && !TASK_KINDS.includes(kind))) return Promise.resolve({ ok: false, code: null, out: '', err: 'not sent' });
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || !(statOrNull(repo) || { isDirectory: () => false }).isDirectory()) return Promise.resolve({ ok: false, code: null, out: '', err: 'no folder is open' });
  if (!isFile(script)) return Promise.resolve({ ok: false, code: null, out: '', err: 'the plugin has no bin/wk-task.mjs yet' });
  const cmd = oneLine(test).slice(0, MAX_TEST);
  const args = [script, 'add', '--repo', repo, '--title', t, ...(kind === 'auto' ? [] : ['--kind', kind]), '--text', body, ...(cmd ? ['--test', cmd] : []), '--from', 'owner'];
  return run(nodeBin || process.execPath, args, { cwd: pluginPath, env: childEnv({ WK_HOME: dataDir }), timeoutMs });
}

// ---------------------------------------------------------------- webview messages
function validateMessage(m) {
  if (!isObj(m) || typeof m.cmd !== 'string' || !COMMANDS.includes(m.cmd)) return { ok: false, error: 'unknown message' };
  const num6 = v => (typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))) && QUESTION_N.test(String(v)) ? String(v) : null;
  if (m.cmd === 'answerQuestion') {
    const n = num6(m.n);
    if (!n) return { ok: false, error: 'unknown question' };
    if (m.useRecommended === true) return { ok: true, msg: { cmd: 'answerQuestion', n, useRecommended: true, confirmed: m.confirmed === true } };
    if (typeof m.text !== 'string') return { ok: false, error: 'no text' };
    if (m.text.length > MAX_TEXT) return { ok: false, error: 'That is over 4,000 characters. Please shorten it.' };
    const text = oneLine(m.text);
    if (!text) return { ok: false, error: 'Write an answer first.' };
    return { ok: true, msg: { cmd: 'answerQuestion', n, useRecommended: false, text, confirmed: m.confirmed === true } };
  }
  if (m.cmd === 'laterQuestion') { const n = num6(m.n); return n ? { ok: true, msg: { cmd: 'laterQuestion', n } } : { ok: false, error: 'unknown question' }; }
  if (m.cmd === 'decideSuggestion') {
    if (typeof m.id !== 'string' || !SUGGESTION_ID.test(m.id)) return { ok: false, error: 'unknown suggestion' };
    if (!CHOICES.includes(m.choice)) return { ok: false, error: 'unknown choice' };
    if (m.text != null && (typeof m.text !== 'string' || m.text.length > MAX_TEXT)) return { ok: false, error: 'That is over 4,000 characters. Please shorten it.' };
    const text = oneLine(m.text || '');
    return { ok: true, msg: { cmd: 'decideSuggestion', id: m.id, choice: m.choice, ...(text ? { text } : {}), confirmed: m.confirmed === true } };
  }
  if (m.cmd === 'openTaskDiff') return typeof m.id === 'string' && TASK_ID.test(m.id) ? { ok: true, msg: { cmd: 'openTaskDiff', id: m.id } } : { ok: false, error: 'unknown task' };
  if (m.cmd === 'addTask') {
    if (typeof m.title !== 'string' || (m.text != null && typeof m.text !== 'string')) return { ok: false, error: 'Write a title first.' };
    const kind = m.kind == null || m.kind === '' ? 'auto' : m.kind;
    if (kind !== 'auto' && !TASK_KINDS.includes(kind)) return { ok: false, error: 'unknown kind' };
    const title = oneLine(m.title), text = manyLines(m.text || '');
    if (!title) return { ok: false, error: 'Write a title first.' };
    if (title.length > MAX_TITLE) return { ok: false, error: 'The title is over 200 characters. Please shorten it.' };
    if (text.length > MAX_TEXT) return { ok: false, error: 'The details are over 4,000 characters. Please shorten them.' };
    if (m.test != null && typeof m.test !== 'string') return { ok: false, error: 'The test command must be text.' };
    if (typeof m.test === 'string' && m.test.length > MAX_TEST) return { ok: false, error: 'The test command is over 500 characters. Please shorten it.' };
    const test = oneLine(m.test || '');
    return { ok: true, msg: { cmd: 'addTask', title, text, kind, ...(test ? { test } : {}) } };
  }
  if (m.cmd === 'openAdvice') {
    if (typeof m.id !== 'string' || !ADVICE_ID.test(m.id)) return { ok: false, error: 'unknown question' };
    return { ok: true, msg: { cmd: 'openAdvice', id: m.id, which: m.which === 'question' ? 'question' : 'answer' } };
  }
  // P2-227
  if (m.cmd === 'jobStart') {
    if (typeof m.project !== 'string' || !PROJECT_KEY.test(m.project)) return { ok: false, error: 'Pick a project first.' };
    if (typeof m.prompt !== 'string' || !m.prompt.trim()) return { ok: false, error: 'Write what the job should do first.' };
    if (m.prompt.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    const model = m.model == null || m.model === '' ? 'sonnet' : m.model, mode = m.mode == null || m.mode === '' ? 'auto' : m.mode;
    if (!MODELS.includes(model)) return { ok: false, error: 'unknown model' };
    if (!MODES.includes(mode)) return { ok: false, error: 'unknown mode' };
    let turns = m.max_turns == null || m.max_turns === '' ? null : Number(m.max_turns);
    if (turns !== null && !(Number.isInteger(turns) && turns >= 1 && turns <= 400)) return { ok: false, error: 'Turns must be a whole number from 1 to 400.' };
    return { ok: true, msg: { cmd: 'jobStart', project: m.project, prompt: manyLines(m.prompt), model, mode, ...(turns ? { max_turns: turns } : {}) } };
  }
  if (m.cmd === 'jobReply') {
    if (typeof m.job !== 'string' || !JOB_ID.test(m.job)) return { ok: false, error: 'unknown job' };
    if (typeof m.prompt !== 'string' || !m.prompt.trim()) return { ok: false, error: 'Write a reply first.' };
    if (m.prompt.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    return { ok: true, msg: { cmd: 'jobReply', job: m.job, prompt: manyLines(m.prompt) } };
  }
  if (m.cmd === 'jobStop') return typeof m.job === 'string' && JOB_ID.test(m.job) ? { ok: true, msg: { cmd: 'jobStop', job: m.job } } : { ok: false, error: 'unknown job' };
  if (m.cmd === 'skillApprove' || m.cmd === 'skillReject') return typeof m.slug === 'string' && SOURCE_REF.test(m.slug) ? { ok: true, msg: { cmd: m.cmd, slug: m.slug } } : { ok: false, error: 'unknown skill source' };
  if (m.cmd === 'trustKey' || m.cmd === 'rejectKey') return typeof m.id === 'string' && CRED_ID.test(m.id) ? { ok: true, msg: { cmd: m.cmd, id: m.id } } : { ok: false, error: 'unknown phone key' };
  if (m.cmd === 'send') {
    if (!KINDS.includes(m.kind)) return { ok: false, error: 'unknown kind' };
    if (typeof m.text !== 'string') return { ok: false, error: 'no text' };
    const text = m.text.trim();
    if (!text) return { ok: false, error: 'Write something first.' };
    if (text.length > MAX_TEXT) return { ok: false, error: 'That is over 4,000 characters. Please shorten it.' };
    return { ok: true, msg: { cmd: 'send', kind: m.kind, text } };
  }
  if (m.cmd === 'repromptRewrite') {
    if (typeof m.draft !== 'string' || !m.draft.trim()) return { ok: false, error: 'Write a rough prompt first.' };
    if (m.draft.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    const target = m.target == null || m.target === '' ? 'antigravity' : m.target;
    const mode = m.mode == null || m.mode === '' ? 'balanced' : m.mode;
    if (!RP_TARGETS.includes(target)) return { ok: false, error: 'unknown target' };
    if (!RP_MODES.includes(mode)) return { ok: false, error: 'unknown mode' };
    const skills = m.skills != null ? oneLine(m.skills).slice(0, 300) : '';
    return { ok: true, msg: { cmd: 'repromptRewrite', draft: manyLines(m.draft), target, mode, skills } };
  }
  if (m.cmd === 'repromptSend') {
    if (typeof m.text !== 'string' || !m.text.trim()) return { ok: false, error: 'Rewrite or write a prompt first.' };
    if (m.text.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    const target = m.target == null || m.target === '' ? 'antigravity' : m.target;
    if (target !== 'antigravity' && target !== 'claude') return { ok: false, error: 'unknown target' };
    return { ok: true, msg: { cmd: 'repromptSend', text: manyLines(m.text), target } };
  }
  if (m.cmd === 'repromptCopy') {
    if (typeof m.text !== 'string' || !m.text.trim()) return { ok: false, error: 'Nothing to copy yet.' };
    if (m.text.length > 200000) return { ok: false, error: 'That is too large to copy.' };
    return { ok: true, msg: { cmd: 'repromptCopy', text: manyLines(m.text) } };
  }
  if (m.cmd === 'repromptStudio') {
    const tab = ['reprompt', 'orchestrator', 'skills'].includes(m.tab) ? m.tab : 'reprompt';
    return { ok: true, msg: { cmd: 'repromptStudio', tab } };
  }
  if (m.cmd === 'repromptToggleAuto') {
    return { ok: true, msg: { cmd: 'repromptToggleAuto', enabled: m.enabled === true } };
  }
  if (m.cmd === 'orchestrateRun') {
    if (typeof m.prompt !== 'string' || !m.prompt.trim()) return { ok: false, error: 'Write a task first.' };
    if (m.prompt.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    const prefer = m.prefer == null || m.prefer === '' ? 'auto' : m.prefer;
    if (!ORCH_PREFER.includes(prefer)) return { ok: false, error: 'unknown provider' };
    return { ok: true, msg: { cmd: 'orchestrateRun', prompt: manyLines(m.prompt), prefer } };
  }
  if (m.cmd === 'chatNew') {
    const title = m.title != null ? oneLine(m.title).slice(0, 80) : '';
    return { ok: true, msg: { cmd: 'chatNew', title } };
  }
  if (m.cmd === 'chatSelect' || m.cmd === 'chatDelete') {
    return typeof m.sessionId === 'string' && CHAT_SESSION_ID.test(m.sessionId)
      ? { ok: true, msg: { cmd: m.cmd, sessionId: m.sessionId } }
      : { ok: false, error: 'unknown session' };
  }
  if (m.cmd === 'chatDone') {
    if (m.sessionId == null || m.sessionId === '') return { ok: true, msg: { cmd: 'chatDone' } };
    return typeof m.sessionId === 'string' && CHAT_SESSION_ID.test(m.sessionId)
      ? { ok: true, msg: { cmd: 'chatDone', sessionId: m.sessionId } }
      : { ok: false, error: 'unknown session' };
  }
  if (m.cmd === 'chatPurge') {
    if (m.confirmed !== true) return { ok: false, error: 'not confirmed' };
    return typeof m.sessionId === 'string' && CHAT_SESSION_ID.test(m.sessionId)
      ? { ok: true, msg: { cmd: 'chatPurge', sessionId: m.sessionId, confirmed: true } }
      : { ok: false, error: 'unknown session' };
  }
  if (m.cmd === 'chatReopen') {
    return typeof m.sessionId === 'string' && CHAT_SESSION_ID.test(m.sessionId)
      ? { ok: true, msg: { cmd: 'chatReopen', sessionId: m.sessionId } }
      : { ok: false, error: 'unknown session' };
  }
  if (m.cmd === 'chatInspectClaude' || m.cmd === 'chatContinueFromClaude') {
    return typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId)
      ? { ok: true, msg: { cmd: m.cmd, sessionId: m.sessionId } }
      : { ok: false, error: 'unknown Claude session' };
  }
  if (m.cmd === 'chatDraft') {
    if (typeof m.prompt !== 'string' || !m.prompt.trim()) return { ok: false, error: 'Write a message first.' };
    if (m.prompt.length > MAX_PROMPT) return { ok: false, error: 'That is over 8,000 characters. Please shorten it.' };
    const target = m.target == null || m.target === '' ? 'auto' : m.target;
    const mode = m.mode == null || m.mode === '' ? 'auto' : m.mode;
    const route = m.route == null || m.route === '' ? 'auto' : m.route;
    if (!RP_TARGETS.includes(target)) return { ok: false, error: 'unknown target' };
    if (!RP_MODES.includes(mode)) return { ok: false, error: 'unknown mode' };
    if (!ORCH_PREFER.includes(route)) return { ok: false, error: 'unknown route' };
    const sessionId = typeof m.sessionId === 'string' && CHAT_SESSION_ID.test(m.sessionId) ? m.sessionId : '';
    const skills = m.skills != null ? oneLine(m.skills).slice(0, 300) : '';
    return {
      ok: true,
      msg: {
        cmd: 'chatDraft',
        sessionId,
        prompt: manyLines(m.prompt),
        target,
        mode,
        route,
        skills,
        confirmBeforeGo: m.confirmBeforeGo === true,
        syncToIde: m.syncToIde !== false,
        autoReprompt: m.autoReprompt !== false,
      },
    };
  }
  if (m.cmd === 'chatConfirm' || m.cmd === 'chatSendToIde') {
    if (typeof m.sessionId !== 'string' || !CHAT_SESSION_ID.test(m.sessionId)) return { ok: false, error: 'unknown session' };
    if (typeof m.turnId !== 'string' || !TURN_ID.test(m.turnId)) return { ok: false, error: 'unknown turn' };
    const target = m.target == null || m.target === '' ? 'auto' : m.target;
    const mode = m.mode == null || m.mode === '' ? 'auto' : m.mode;
    const route = m.route == null || m.route === '' ? 'auto' : m.route;
    if (!RP_TARGETS.includes(target)) return { ok: false, error: 'unknown target' };
    if (!RP_MODES.includes(mode)) return { ok: false, error: 'unknown mode' };
    if (!ORCH_PREFER.includes(route)) return { ok: false, error: 'unknown route' };
    const repromptedText = typeof m.repromptedText === 'string' ? manyLines(m.repromptedText).slice(0, MAX_PROMPT * 2) : '';
    const skills = Array.isArray(m.skills)
      ? m.skills.slice(0, 12).map(s => oneLine(s).slice(0, 80)).filter(Boolean)
      : (typeof m.skills === 'string' ? oneLine(m.skills).slice(0, 400).split(/\s+/).filter(Boolean) : null);
    return {
      ok: true,
      msg: { cmd: m.cmd, sessionId: m.sessionId, turnId: m.turnId, repromptedText, target, mode, route, skills },
    };
  }
  if (m.cmd === 'chatCancel') {
    if (typeof m.sessionId !== 'string' || !CHAT_SESSION_ID.test(m.sessionId)) return { ok: false, error: 'unknown session' };
    if (typeof m.turnId !== 'string' || !TURN_ID.test(m.turnId)) return { ok: false, error: 'unknown turn' };
    return { ok: true, msg: { cmd: 'chatCancel', sessionId: m.sessionId, turnId: m.turnId } };
  }
  // P2-272 4B: plan-card buttons carry only a session id and a turn id; dag-runner.js reads the run id from the stored turn.
  if (['dagRun', 'dagNotNow', 'dagStop', 'dagMerge', 'dagMergeNo', 'dagCheck'].includes(m.cmd)) {
    if (typeof m.sessionId !== 'string' || !CHAT_SESSION_ID.test(m.sessionId)) return { ok: false, error: 'unknown session' };
    if (typeof m.turnId !== 'string' || !TURN_ID.test(m.turnId)) return { ok: false, error: 'unknown turn' };
    return { ok: true, msg: { cmd: m.cmd, sessionId: m.sessionId, turnId: m.turnId } };
  }
  if (m.cmd === 'chatToggleConfirm') {
    return { ok: true, msg: { cmd: 'chatToggleConfirm', enabled: m.enabled === true } };
  }
  if (m.cmd === 'chatToggleSyncIde') {
    return { ok: true, msg: { cmd: 'chatToggleSyncIde', enabled: m.enabled !== false } };
  }
  if (m.cmd === 'chatToggleAutoTake') {
    return { ok: true, msg: { cmd: 'chatToggleAutoTake', enabled: m.enabled !== false } };
  }
  if (m.cmd === 'chatTakeTask') {
    const tid = m.taskId == null ? '' : String(m.taskId).trim();
    if (tid && !TASK_ID.test(tid)) return { ok: false, error: 'unknown task' };
    return { ok: true, msg: { cmd: 'chatTakeTask', taskId: tid } };
  }
  if (m.cmd === 'bridgeOpenAntigravity') {
    const tid = typeof m.taskId === 'string' ? m.taskId.trim() : '';
    if (!TASK_ID.test(tid)) return { ok: false, error: 'unknown task' };
    return { ok: true, msg: { cmd: 'bridgeOpenAntigravity', taskId: tid } };
  }
  if (m.cmd === 'bridgeOpenClaude') {
    // the folder is only a hint: the extension uses it only when it equals the one watch.json names
    const repo = typeof m.repo === 'string' && m.repo.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(m.repo) ? m.repo : '';
    return { ok: true, msg: { cmd: 'bridgeOpenClaude', repo } };
  }
  if (m.cmd === 'chatHandoffToClaude') {
    if (typeof m.sessionId !== 'string' || !CHAT_SESSION_ID.test(m.sessionId)) return { ok: false, error: 'unknown session' };
    const note = m.note != null ? manyLines(String(m.note)).slice(0, 1000) : '';
    return { ok: true, msg: { cmd: 'chatHandoffToClaude', sessionId: m.sessionId, note } };
  }
  return { ok: true, msg: { cmd: m.cmd } };
}

// ---------------------------------------------------------------- P2-227: jobs, projects and the phone (files written by wk-job, wk-projects and wk-remote)
const JOB_ID = /^J-\d{8}-\d{4}-[0-9a-f]{4}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CRED_ID = /^[A-Za-z0-9_-]{16,1400}$/;
const MODELS = ['sonnet', 'opus', 'fable', 'haiku'];
const MODES = ['auto', 'acceptEdits', 'plan'];
const MODE_WORDS = { auto: 'Edit and run commands (auto mode)', acceptEdits: 'Edit files, no commands', plan: 'Look and plan only' };
const JOB_STATES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped'];
const MAX_PROMPT = 8000;
// No built-in server (P2-243): the same shape and values as bin/remote-lib.mjs; `wk-remote config` sets origin, rp_id, host and user.
const REMOTE_DEFAULTS = {
  enabled: false, login: 'passkey', origin: '', rp_id: '', host: '', port: 22, user: '', server_command: '',
  key: '~/.ssh/wk_bridge_ed25519', max_jobs: 2, job_hours: 3, pace_stop_pct: 90
};
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readRemote(dataDir) {
  const j = readJsonSmall(path.join(dataDir, 'remote.json'), 64 * 1024) || {};
  const r = { ...REMOTE_DEFAULTS };
  for (const k of Object.keys(REMOTE_DEFAULTS)) if (k in j && typeof j[k] === typeof REMOTE_DEFAULTS[k]) r[k] = j[k];
  r.enabled = j.enabled === true;
  if (r.login !== 'panel') r.login = 'passkey';
  return r;
}
// The phone: trusted keys (only on the Mac's say), keys waiting for Trust, and whether phone control is on. No key material leaves here.
function readPhone(dataDir) {
  const r = readRemote(dataDir);
  const k = readJsonSmall(path.join(dataDir, 'remote-keys.json'), 512 * 1024) || {};
  const p = readJsonSmall(path.join(dataDir, 'remote-pending.json'), 512 * 1024) || {};
  const ok = x => isObj(x) && typeof x.id === 'string' && CRED_ID.test(x.id);
  return {
    enabled: r.enabled, origin: r.origin,
    trusted: (Array.isArray(k.keys) ? k.keys : []).filter(ok).slice(0, 20).map(x => ({ id: x.id, label: oneLine(x.label).slice(0, 40) || 'Phone', added_at: num(x.added_at) })),
    pending: (Array.isArray(p.keys) ? p.keys : []).filter(ok).slice(-5).map(x => ({ id: x.id, label: oneLine(x.label).slice(0, 40) || 'Phone', registered_at: num(x.registered_at) }))
  };
}

function readJobEvents(file, after = 0, max = 200) {
  let ht; try { ht = readHeadTail(file, 256 * 1024); } catch { return []; }
  const lines = parseLines(ht.whole ? ht.head : ht.tail, { dropFirst: !ht.whole });
  return lines.filter(e => isObj(e) && Number.isInteger(e.n) && e.n > after).slice(-max);
}
function jobSummary(m, dir, { tail = 0 } = {}) {
  const t = (s, n) => oneLine(s).slice(0, n);
  const first = (() => { try { return fs.readFileSync(path.join(dir, 'prompt-1.txt'), 'utf8').split('\n').find(l => l.trim() && !/^Work in .*\(project .*\)\.$/.test(l.trim())) || ''; } catch { return ''; } })();
  const out = {
    id: m.id, project: t(m.project, 64), model: MODELS.includes(m.model) ? m.model : '', mode: MODES.includes(m.mode) ? m.mode : '',
    from: ['phone', 'panel', 'cli'].includes(m.from) ? m.from : 'cli', state: JOB_STATES.includes(m.state) ? m.state : 'failed',
    started_at: num(m.started_at), ended_at: num(m.ended_at), cost_usd: fin(m.cost_usd), turns: fin(m.turns),
    title: t(first, 80) || 'Untitled job', last_text: t(m.last_text, 300)
  };
  // a legal job runs on the newest top model the plan has (wk-job, config/models.json): its label names the model it ran on
  if (m.legal === true) { out.legal = true; out.model_id = typeof m.model_id === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(m.model_id) ? m.model_id : ''; }
  if (m.carbon_fallback === true) {
    out.carbon_fallback = true;
    out.provider = typeof m.provider === 'string' ? oneLine(m.provider).slice(0, 40) : 'orchestrator-carbon-high';
    if (typeof m.model_id === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(m.model_id)) out.model_id = m.model_id;
  }
  if (tail) out.tail = readJobEvents(path.join(dir, 'events.jsonl'), 0, tail).map(e => {
    const x = { n: e.n, type: String(e.type || '').slice(0, 24) };
    for (const k of ['model', 'permissionMode', 'name', 'tool', 'subtype']) if (typeof e[k] === 'string') x[k] = oneLine(e[k]).slice(0, 60);
    for (const k of ['text', 'short']) if (typeof e[k] === 'string') x[k] = oneLine(e[k]).slice(0, 500);
    for (const k of ['cost_usd', 'turns']) if (fin(e[k]) != null) x[k] = e[k];
    return x;
  });
  return out;
}
// The newest jobs first; the running and waiting ones carry the last lines of their output.
function readJobs(dataDir, n = 12) {
  const dir = path.join(dataDir, 'jobs');
  let names; try { names = fs.readdirSync(dir).filter(x => JOB_ID.test(x)).sort().reverse(); } catch { return []; }
  const items = [];
  for (const id of names) {
    if (items.length >= n) break;
    const m = readJsonSmall(path.join(dir, id, 'meta.json'), 64 * 1024);
    if (!m || m.id !== id) continue;
    const live = m.state === 'running' || m.state === 'waiting' || items.length < 3;
    items.push(jobSummary(m, path.join(dir, id), { tail: live ? 12 : 0 }));
  }
  return items;
}

// ---- projects: ~/.wk/projects.json (wk-projects scan), with git read-only (no fetch), 5 s per project, kept for 60 s
const PROJECTS_MS = 60 * 1000;
const projectCache = new Map();
// Reading a project never runs a command that the project's own git config names (P2-243): a folder unpacked from
// an archive can bring its .git, and the project scan lists every repository it finds.
// - Every call: settings given on the command line win over the repository's files. No fsmonitor command, no
//   signature check (it would run gpg.program), no hooks, and no transport: every built-in one, ext:: included, is
//   set to "never" (the command line beats the repository's own protocol.<name>.allow), so git contacts no remote and
//   runs no remote command, not even for a partial clone's lazy fetch, which newer git also skips through GIT_NO_LAZY_FETCH.
// - `git status` first empties the filter commands that the repository's own config sets (an empty command means
//   no filter to git), and does not look inside submodules, so git never runs there. Filters from the user's global
//   config, such as Git LFS, stay. When git cannot list them, the status is not read (changed: unknown).
const NO_TRANSPORT = ['ext', 'fd', 'file', 'git', 'http', 'https', 'ssh', 'ftp', 'ftps'].flatMap(t => ['-c', `protocol.${t}.allow=never`]);
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'protocol.allow=never', ...NO_TRANSPORT];
function gitRun(cwd, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...GIT_SAFE, ...args], {
      timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true, shell: false,
      env: { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
    },
      (err, stdout) => resolve({ code: !err ? 0 : (typeof err.code === 'number' ? err.code : -1), out: String(stdout || '') }));
  });
}
const git = (cwd, args, timeoutMs) => gitRun(cwd, args, timeoutMs).then(r => (r.code === 0 ? r.out : null));
// The -c settings that empty each filter key the repository's own config sets (local, worktree or a file it
// includes). null when git cannot list them, or when a key cannot be written as -c (a driver name with "=").
async function repoFilterOff(repo) {
  const r = await gitRun(repo, ['config', '-z', '--show-scope', '--includes', '--get-regexp', '^filter\\.']);
  if (r.code === 1 && r.out === '') return [];
  if (r.code !== 0) return null;
  const f = r.out.split('\0'), off = [];
  if (f.pop() !== '' || f.length % 2) return null;
  for (let i = 0; i < f.length; i += 2) {
    if (f[i] === 'global' || f[i] === 'system') continue;
    const key = f[i + 1].split('\n')[0], dot = key.lastIndexOf('.'), name = key.slice(dot + 1);
    if (dot <= 'filter'.length || !['clean', 'smudge', 'process', 'required'].includes(name)) continue;
    if (key.includes('=')) return null;
    off.push('-c', key + (name === 'required' ? '=false' : '='));
  }
  return off;
}
function readProjectsFile(dataDir) {
  const j = readJsonSmall(path.join(dataDir, 'projects.json'), 512 * 1024);
  if (!j || !Array.isArray(j.projects)) return { found: false, projects: [] };
  const projects = j.projects.filter(p => isObj(p) && typeof p.key === 'string' && PROJECT_KEY.test(p.key) && typeof p.path === 'string')
    .map(p => ({ key: p.key, name: oneLine(p.name).slice(0, 80) || p.key, path: expandHome(p.path), kind: p.kind === 'folder' ? 'folder' : 'repo', ...(typeof p.repo === 'string' ? { repo: expandHome(p.repo) } : {}) }));
  return { found: true, projects };
}
// Open worklog items naming a folder: rows of orchestration/PHASE.md or worklog/PHASE.md ("| ID | ... | status |") not marked done.
function openItems(repo, word, n = 5) {
  for (const f of [path.join(repo, 'orchestration', 'PHASE.md'), path.join(repo, 'worklog', 'PHASE.md')]) {
    const text = readCapped(f, 2 * 1024 * 1024);
    if (text == null) continue;
    const out = [], re = word ? new RegExp(`(^|[^\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\b)`) : null;
    for (const line of text.split('\n')) {
      const x = /^\|\s*([A-Z][A-Z0-9]*-\d+[a-z]?)\s*\|(.*)\|\s*$/.exec(line);
      if (!x) continue;
      const cells = x[2].split('|'), status = oneLine(cells[cells.length - 1]);
      if (/^(done|dropped|parked|merged|closed)\b/i.test(status)) continue;
      if (re && !re.test(x[2])) continue;
      out.push({ id: x[1], status: status.slice(0, 120) });
    }
    return out.slice(-n).reverse();
  }
  return [];
}
async function projectInfo(p, home) {
  const repo = p.kind === 'folder' && p.repo ? p.repo : p.path;
  const rel = p.kind === 'folder' && p.repo ? path.relative(p.repo, p.path) : '';
  const scope = rel ? ['--', rel] : [];
  const status = async () => {
    const off = await repoFilterOff(repo);
    return off == null ? null : git(repo, [...off, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty', ...scope]);
  };
  const [branch, log, st, ab] = await Promise.all([
    git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repo, ['log', '-1', '--format=%h%x00%ct%x00%s', ...scope]),
    status(),
    git(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ]);
  const [sha, at, subject] = (log || '').trim().split('\0');
  const [behind, ahead] = (ab || '').trim().split(/\s+/).map(Number);
  return {
    key: p.key, name: p.name, path: tilde(p.path, home), kind: p.kind,
    branch: branch ? oneLine(branch).slice(0, 80) : '', git: branch != null,
    last: sha ? { sha7: sha.slice(0, 7), at: (Number(at) || 0) * 1000, subject: oneLine(subject).slice(0, 100) } : null,
    changed: st == null ? null : st.split('\n').filter(Boolean).length,
    ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null,
    items: openItems(repo, rel || null)
  };
}
const tilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
async function readProjects(dataDir, { home = os.homedir(), now = Date.now(), sessions, jobs, max = 40 } = {}) {
  const f = readProjectsFile(dataDir);
  if (!f.found) return { found: false, items: [], more: 0 };
  const list = f.projects.slice(0, max);
  const key = dataDir + '\0' + JSON.stringify(list);
  let hit = projectCache.get(key);
  if (!hit || now - hit.at > PROJECTS_MS) {
    const items = [];
    for (let i = 0; i < list.length; i += 8) items.push(...await Promise.all(list.slice(i, i + 8).map(p => projectInfo(p, home).catch(() => null))));
    hit = { at: now, items: items.filter(Boolean) };
    projectCache.set(key, hit);
  }
  // live counts are not cached: sessions, Gemini tasks and jobs for each project
  const repoOf = {};
  try {
    for (const id of fs.readdirSync(path.join(dataDir, 'tasks')).filter(x => TASK_ID.test(x)).slice(-200)) {
      const m = readJsonSmall(path.join(dataDir, 'tasks', id, 'meta.json'), 64 * 1024);
      if (m && typeof m.repo === 'string' && ['queued', 'taken'].includes(m.status)) repoOf[m.repo] = (repoOf[m.repo] || 0) + 1;
    }
  } catch { /* no tasks */ }
  const ss = (sessions && sessions.sessions) || [], js = Array.isArray(jobs) ? jobs : [];
  const items = hit.items.map(x => {
    const abs = expandHome(x.path, home), base = path.basename(abs);
    return {
      ...x,
      sessions: ss.filter(s => s.active && s.project === base).length,
      gemini: Object.entries(repoOf).filter(([r]) => r === abs).reduce((a, [, c]) => a + c, 0),
      jobs: js.filter(j => j.project === x.key && (j.state === 'running' || j.state === 'waiting')).length
    };
  });
  return { found: true, items, more: Math.max(0, f.projects.length - list.length) };
}

// v0.8.0: Skill Library (~/.gemini/skill-vault/index.json + ~/.wk/skill-sync.json) and Carbon High failover state
function readSkillLibrary(home, dataDir, maxItems = 120) {
  const vaultDir = typeof process.env.REPROMPT_SKILL_VAULT_DIR === 'string' && process.env.REPROMPT_SKILL_VAULT_DIR
    ? path.resolve(process.env.REPROMPT_SKILL_VAULT_DIR)
    : path.join(home, '.gemini', 'skill-vault');
  const idx = readJsonSmall(path.join(vaultDir, 'index.json'), 4 * 1024 * 1024);
  const syncRaw = readJsonSmall(path.join(dataDir, 'skill-sync.json'), 128 * 1024);
  const sync = syncRaw ? {
    lastAt: Date.parse(syncRaw.last_sync_at) || 0,
    discoveredTotal: num(syncRaw.discovered_total),
    addedRepos: Array.isArray(syncRaw.added_repos) ? syncRaw.added_repos.slice(0, 10).map(r => oneLine(r).slice(0, 80)) : [],
    totalRepos: num(syncRaw.total_repos),
    topTrending: Array.isArray(syncRaw.top_trending) ? syncRaw.top_trending.slice(0, 6).map(t => ({
      repo: oneLine(t && t.repo).slice(0, 80),
      stars: num(t && t.stars),
      forks: num(t && t.forks),
      domain: oneLine(t && t.domain).slice(0, 40),
    })) : [],
  } : null;
  // P2-272 (B): only approved sources count (panel/src/skill-gate.js, twin of skill_vault.is_approved).
  const sources = readJsonSmall(path.join(vaultDir, 'sources.json'), 4 * 1024 * 1024);
  const review = sources ? gate.pendingSources(sources).slice(0, 50).map(r => ({
    slug: oneLine(r.slug || '').slice(0, 100),
    repo: oneLine(r.repo || '').slice(0, 100),
    stars: num(r.stars),
    description: oneLine(r.description || r.ecosystem_focus || r.default_domain || '').slice(0, 160),
    url: /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(r.url || '')) ? String(r.url)
      : (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(r.repo || '')) ? `https://github.com/${r.repo}` : ''),
  })).filter(r => SOURCE_REF.test(r.slug) || SOURCE_REF.test(r.repo)) : [];
  const reviewCount = sources ? gate.pendingSources(sources).length : 0;
  const approvedCount = sources ? gate.approvedSources(sources).length : 0;
  if (!idx || !Array.isArray(idx.skills)) {
    return { ready: false, total: 0, skill_count: 0, repos: 0, repo_count: 0, clonedRepos: 0, cloned_repo_count: 0, domains: [], items: [], sync, review, reviewCount, approvedCount };
  }
  // Fails closed: when sources.json is missing, too big or does not parse, only the owner's own skills (local-installed) count.
  const allowed = gate.allowedSkills(idx, sources || {});
  const dc = isObj(idx.domain_counts) ? Object.entries(idx.domain_counts)
    .filter(([k, v]) => typeof k === 'string' && Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([domain, count]) => ({ domain: oneLine(domain).slice(0, 40), count })) : [];
  const ranked = [...allowed]
    .filter(isObj)
    .sort((a, b) => (Number(Boolean(b.trending)) - Number(Boolean(a.trending)))
      || (num(b.stars) - num(a.stars))
      || ((Number(a.tier) || 3) - (Number(b.tier) || 3))
      || String(a.name || '').localeCompare(String(b.name || '')));
  const items = ranked.slice(0, maxItems).map(s => ({
    id: oneLine(s.id || s.name).slice(0, 80),
    name: oneLine(s.name).slice(0, 60),
    domain: oneLine(s.domain).slice(0, 40),
    repo: oneLine(s.repo).slice(0, 80),
    description: oneLine(s.description).slice(0, 200),
    stars: num(s.stars),
    forks: num(s.forks),
    trending: Boolean(s.trending),
    tier: Number(s.tier) || 3,
  }));
  const totalSkills = allowed.length;
  const totalRepos = num(idx.repo_count);
  const clonedReposCount = num(idx.cloned_repo_count);
  return {
    ready: true,
    total: totalSkills,
    skill_count: totalSkills,
    repos: totalRepos,
    repo_count: totalRepos,
    clonedRepos: clonedReposCount,
    cloned_repo_count: clonedReposCount,
    domains: dc,
    items,
    sync,
    review,
    reviewCount,
    approvedCount,
  };
}

function readCarbonState(pace, home) {
  const used = pace && pace.state === 'ok' && pace.pace ? Number(pace.pace.used) : 0;
  const five = pace && pace.state === 'ok' && pace.pace ? Number(pace.pace.fiveHour) : 0;
  const reason = pace && pace.state === 'ok' && pace.pace ? pace.pace.reason : '';
  const claudeExhausted = Boolean(used >= 0.98 || five >= 0.98 || reason === 'ceiling' || reason === 'landed' || reason === 'five_hour');
  const agyReady = [
    path.join(home, '.gemini', 'bin', 'agy'),
    path.join(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ].some(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  return { claudeExhausted, agyReady, model: 'gemini-4-carbon-high' };
}

// The one check a stranger's panel makes beyond the session files: is the Watchkeeper plugin there?
const pluginInstalled = pluginPath => typeof pluginPath === 'string' && path.isAbsolute(pluginPath) && !!statOrNull(path.join(pluginPath, 'bin', 'wk-ledger.mjs'));

// ---------------------------------------------------------------- everything for one refresh
async function collect(cfg = {}, now = Date.now(), opts = {}) {
  const p = resolvePaths(cfg, opts.home);
  const pluginOk = pluginInstalled(p.pluginPath);
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const sessions = safe(() => listSessions(p.claudeDir, now), { missing: true, sessions: [], more: 0 });
  const locks = safe(() => readLocks(p.orchestrationDir), { missing: true, locks: [] });
  // Without the plugin the panel reads nothing else: no ~/.wk, no plugin files, no Gemini settings (README "Private by design").
  if (!pluginOk) {
    return {
      now, paths: p, pluginOk, dataOk: false, pace: { state: 'no-plugin' }, statusLine: '', statusState: 'no-plugin', kill: { on: false, at: 0, file: '' },
      ledger: { missing: true, totals: { usd: 0, runs: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }, top: [], wakeups: [], bad: 0 },
      sessions, locks, inbox: [], advice: { items: [], total: 0 }, ask: { installed: false, off: false, commandOk: false }, update: { version: null, last: null },
      questions: { available: false, items: [], total: 0, hidden: 0 }, suggestions: { items: [], total: 0 }, tasks: { items: [], total: 0 },
      gemini: { items: [], active: 0 }, geminiConfig: { found: false, prompt: '', routes: {} },
      jobs: [], projects: [], projectsFile: { found: false, more: 0 }, phone: { enabled: false, origin: '', trusted: [], pending: [] }, remote: null,
      skillLibrary: { ready: false, total: 0, repos: 0, clonedRepos: 0, domains: [], items: [], sync: null },
      learning: { ...EMPTY_SUMMARY, topSnippets: [], topHeuristics: [] },
      watchdog: { ...EMPTY_WATCHDOG, items: [] },
      carbon: { claudeExhausted: false, agyReady: false, model: 'gemini-4-carbon-high' },
      usage: { found: false, fetchedAt: 0, windows: {} }, account: { state: 'no-plugin', email: '' }, geminiUsage: { label: '', tracked: false, today: null, cooldownUntil: 0, cooldownReason: '', weekTasks: null },
      archivedChatSessions: [],
      bridge: { ...EMPTY_BRIDGE }
    };
  }
  const later = safe(() => readPanelState(p.dataDir).later, {});
  const killFile = killFilePath(p.pluginPath, p.home);
  const jobs = safe(() => readJobs(p.dataDir), []);
  const killNow = killState(killFile).on;
  const [pace, pr, status, account] = await Promise.all([readPace(p.pluginPath, p.dataDir, opts),
  readProjects(p.dataDir, { home: p.home, now, sessions, jobs }).catch(() => ({ found: false, items: [], more: 0 })),
  readStatusLine(p.pluginPath, p.dataDir, { ...opts, cwd: cfg.workspace || '', killOn: killNow, now }).catch(() => ({ state: 'error', line: '' })),
  // the account runs `claude` only when the caller asks (the extension does; tests pass a stub on a temp PATH)
  (opts.account ? readClaudeAccount({ killOn: killNow, now, ...(opts.accountEnv ? { env: opts.accountEnv } : {}) }) : Promise.resolve({ state: 'off', email: '' })).catch(() => ({ state: 'error', email: '' }))]);
  return {
    now, paths: p, pluginOk,
    dataOk: !!statOrNull(p.dataDir),
    pace,
    statusLine: status.line, statusState: status.state,
    kill: killState(killFile),
    ledger: safe(() => readLedger(path.join(p.dataDir, 'ledger.jsonl'), now), { missing: true, totals: { usd: 0, runs: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }, top: [], wakeups: [], bad: 0 }),
    sessions, locks,
    inbox: safe(() => readInbox(p.dataDir), []),
    advice: safe(() => readAdvice(p.dataDir), { items: [], total: 0 }),
    ask: safe(() => askState(p.home, p.pluginPath), { installed: false, off: false, commandOk: false }),
    update: safe(() => readUpdate(p.dataDir, p.pluginPath), { version: null, last: null }),
    // P2-223
    questions: safe(() => readQuestions(questionsDir(p.dataDir, p.home), now, later), { available: false, items: [], total: 0, hidden: 0 }),
    suggestions: safe(() => readSuggestions(p.dataDir, now), { items: [], total: 0 }),
    tasks: safe(() => readTasks(p.dataDir), { items: [], total: 0 }),
    gemini: safe(() => readGeminiSessions(p.dataDir, now), { items: [], active: 0 }),
    geminiConfig: safe(() => readGeminiConfig(p.pluginPath), { found: false, prompt: '', routes: {} }),
    hookPass: safe(() => readHookPass(p.dataDir), { pass: 'unknown' }),
    // P2-227
    jobs, projects: pr.items, projectsFile: { found: pr.found, more: pr.more },
    phone: safe(() => readPhone(p.dataDir), { enabled: false, origin: '', trusted: [], pending: [] }),
    remote: safe(() => { const r = readRemote(p.dataDir); return { enabled: r.enabled, origin: r.origin, max_jobs: r.max_jobs, job_hours: r.job_hours, pace_stop_pct: r.pace_stop_pct }; }, null),
    skillLibrary: safe(() => readSkillLibrary(p.home, p.dataDir), { ready: false, total: 0, repos: 0, clonedRepos: 0, domains: [], items: [], sync: null, review: [], reviewCount: 0, approvedCount: 0 }),
    learning: safe(() => readLearningSummary(p.dataDir), { ...EMPTY_SUMMARY, topSnippets: [], topHeuristics: [] }),
    watchdog: safe(() => readWatchdogSummary(p.dataDir, now), { ...EMPTY_WATCHDOG, items: [] }),
    carbon: safe(() => readCarbonState(pace, p.home), { claudeExhausted: false, agyReady: false, model: 'gemini-4-carbon-high' }),
    chatSessions: safe(() => listChatSessionSummaries(p.dataDir), []),
    graphify: safe(() => readGraphifyStats(cfg.workspace || ''), { available: false, totalNodes: 0, totalEdges: 0, mode: 'none' }),
    // P2-272 Phase 3 stage B: the usage card and archived chats
    usage: safe(() => readUsageWindows(p.dataDir, now), { found: false, fetchedAt: 0, windows: {} }),
    account: { state: account.state, email: account.email },
    geminiUsage: safe(() => readGeminiUsage(p.home, { now, env: opts.env || process.env, label: cfg.geminiLabel, dataDir: p.dataDir }), { label: '', tracked: false, today: null, cooldownUntil: 0, cooldownReason: '', weekTasks: null }),
    archivedChatSessions: safe(() => listArchivedChatSessions(p.dataDir), []),
    bridge: safe(() => readBridge(p.dataDir), { ...EMPTY_BRIDGE }),
  };
}

// P2-277 Bridge: the panel reads watch.json only (wk-watch writes it every 30 s and on each crossing). Nothing is run from here.
const BRIDGE_EVENTS = new Set(['queued', 'taken', 'done', 'failed', 'requeued', 'written', 'consumed']);
const EMPTY_BRIDGE = { found: false, on: false, at: '', counts: { queued_for_gemini: 0, waiting_for_claude: 0, in_flight: 0, done_24h: 0, stalled: 0 }, stalledIds: [], routes: { claude_wait: 'nobody', hooks: 'off', last_automation_run: null }, held: [], crossings: [], taskId: '', claudeRepo: '' };
// wk-watch writes claude_wait as {alive, pid} (bin/wk-bridge.mjs waitRoute); the card says who waits in plain words.
function waitWords(v) {
  if (!v || typeof v !== 'object') return 'nobody';
  const pid = Number.isInteger(v.pid) && v.pid > 0 ? v.pid : null;
  return v.alive === true ? (pid ? `a Claude tab (pid ${pid})` : 'a Claude tab') : 'nobody';
}
function readBridge(dataDir) {
  let w; try { w = JSON.parse(fs.readFileSync(path.join(dataDir, 'watch.json'), 'utf8')); } catch { return { ...EMPTY_BRIDGE }; }
  const b = w && typeof w === 'object' && w.bridge && typeof w.bridge === 'object' ? w.bridge : null;
  if (!b) return { ...EMPTY_BRIDGE };
  const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, n) : '');
  const num = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const c = b.counts && typeof b.counts === 'object' ? b.counts : {};
  const r = b.routes && typeof b.routes === 'object' ? b.routes : {};
  const ids = w.ids && typeof w.ids === 'object' ? w.ids : {};
  const firstTask = Array.isArray(ids.tasks_for_gemini) ? str(ids.tasks_for_gemini.find(x => typeof x === 'string' && /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/.test(x)) || '', 60) : '';
  const firstHand = Array.isArray(ids.handoffs_for_claude) ? str(ids.handoffs_for_claude.find(x => typeof x === 'string') || '', 600) : '';
  const at = firstHand.lastIndexOf('@'), repo = at > 0 ? firstHand.slice(0, at) : '';
  return {
    found: true, on: b.on === true, at: str(w.checked_at || w.at, 40),
    counts: { queued_for_gemini: num(c.queued_for_gemini), waiting_for_claude: num(c.waiting_for_claude), in_flight: num(c.in_flight), done_24h: num(c.done_24h), stalled: num(c.stalled) },
    stalledIds: Array.isArray(b.stalled_ids) ? b.stalled_ids.filter(x => typeof x === 'string').slice(0, 20).map(x => str(x, 60)) : [],
    routes: { claude_wait: waitWords(r.claude_wait), hooks: r.hooks === 'on' ? 'on' : 'off', last_automation_run: str(r.last_automation_run, 40) || null },
    crossings: (Array.isArray(b.last_crossings) ? b.last_crossings : []).filter(x => x && typeof x === 'object').slice(-10)
      .map(x => ({ at: str(x.at, 40), kind: x.kind === 'handoff' ? 'handoff' : 'task', from: str(x.from, 40), to: str(x.to, 40), event: BRIDGE_EVENTS.has(x.event) ? x.event : 'unknown', title: str(x.title, 120) })),
    held: Array.isArray(w.held) ? w.held.filter(x => typeof x === 'string' && /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/.test(x)).slice(0, 20) : [],
    taskId: firstTask, claudeRepo: path.isAbsolute(repo) ? repo : '',
  };
}

module.exports = {
  readBridge, EMPTY_BRIDGE, waitWords, taskHeld,
  pluginInstalled, HEAD_TAIL, MAX_TEXT, expandHome, resolvePaths, readPace, readStatusLine, readHeadTail, parseLines, decodeProject, modelName,
  cleanText, userText, sessionInfo, readMembers, listSessions, readClaudeTranscript, readLedger, readLocks, appendInbox, readInbox, inboxFile,
  killFilePath, killState, setKill, validateMessage, collect, readAdvice, adviceFile, askState, installAsk, readUpdate,
  // P2-223
  COMMANDS, KINDS, TASK_KINDS, TASK_STATES, CHOICES, SUGGESTION_ID, TASK_ID, QUESTION_N, SESSION_ID, LATER_MS, isMoney, isLegal, legalLabel, oneLine, manyLines,
  questionsAvailable, questionsDir, updateRoute, parseQuestionLine, readQuestions, findOpenQuestion, okAnswer, answerQuestion, readPanelState, setLater, panelStateFile,
  readSuggestions, findOpenSuggestion, readTasks, taskDiffFile, readGeminiSessions, readGeminiConfig, readHookPass, MERGE_TIMEOUT_MS, MAX_TEST, decideSuggestion, addTask,
  // P2-227
  run, childEnv, writePrivate, readJsonSmall, JOB_ID, PROJECT_KEY, CRED_ID, MODELS, MODES, MODE_WORDS, JOB_STATES, MAX_PROMPT, REMOTE_DEFAULTS,
  readRemote, readPhone, readJobs, readJobEvents, jobSummary, readProjectsFile, readProjects, openItems, git,
  // v0.8.0 + v2.1.0
  readSkillLibrary, SOURCE_REF, readCarbonState, RP_TARGETS, RP_MODES, ORCH_PREFER,
  // P2-272 Phase 3 stage B
  USAGE_WINDOWS, readUsageWindows, readClaudeAccount, clearAccountCache, readGeminiUsage, countWeekTasks, geminiDataDir
};
