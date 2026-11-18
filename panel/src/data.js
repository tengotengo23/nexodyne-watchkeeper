'use strict';
// The W panel's data layer (P2-205). Plain Node, no dependencies. It reads files and runs one read-only command
// (`wk-ledger.mjs pace --json`). It writes only two things: the owner inbox line and the kill switch file.
// P2-223, on the owner's press only: nx answer (questions), the plugin's wk-suggest and wk-task, and its own panel-state.json ("Later").
// P2-227: it also reads the jobs (~/.wk/jobs), the projects (~/.wk/projects.json, git read-only, no fetch) and the phone files (remote*.json).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
// P2-227: the one list of legal words, shared with wk-job, the Gemini queue and the steward
const { isLegal, legalLabel } = require('./legal-words');

const HEAD_TAIL = 64 * 1024;
const MAX_TEXT = 4000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const KINDS = ['recommendation', 'rule'];
const COMMANDS = ['ready', 'refresh', 'send', 'kill', 'unkill', 'openAdvice', 'installAsk',
  // P2-223: "Waiting for you" and Gemini
  'answerQuestion', 'laterQuestion', 'decideSuggestion', 'openTaskDiff', 'addTask', 'copyAutomation',
  // P2-227: jobs and the phone
  'jobStart', 'jobReply', 'jobStop', 'trustKey', 'rejectKey', 'remoteOn', 'remoteOff'];

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
  const env = { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin',
    WK_STEWARD_DIR: path.join(dataDir, 'steward'), WK_LEDGER: path.join(dataDir, 'ledger.jsonl') };
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
    out.push({ id: n.replace(/\.meta\.json$/, ''), role: /\breview/i.test(task) ? 'Reviewer' : 'Worker', task,
      model: modelName(meta.model), effort: typeof meta.effort === 'string' ? meta.effort.slice(0, 12) : '',
      state, at, depth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : 1 });
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
    sessions.push({ id: s.id, title: info.title, project: info.cwd ? path.basename(info.cwd) : decodeProject(s.folder),
      at: s.mtime, active: now - s.mtime < activeMs, model: info.model, tokens: Math.round(info.size / 2.5),
      members: readMembers(path.join(root, s.folder, s.id, 'subagents'), now) });
  }
  sessions.sort((a, b) => (b.active - a.active) || b.at - a.at);
  return { missing: false, root, sessions, more: Math.max(0, found.length - max) };
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
    items.push({ id, status, from: str(m.from, 30) || 'an agent', at: Date.parse(m.asked_at) || 0, done: Date.parse(m.finished_at) || 0,
      preview: str(m.preview, 300), error: str(m.error, 160), cost: typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd) ? m.cost_usd : null,
      hasAnswer: !!statOrNull(path.join(dir, id, 'answer.md')) });
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
  return { version, route, last: { at: Number.isFinite(at) ? at : 0, result: UPDATE_RESULTS.includes(r.result) ? r.result : 'problem', problem: str(r.problem, 300), held: str(r.held, 300),
    moved: isObj(r.moved) ? { from: str(r.moved.from, 20), to: str(r.moved.to, 20) } : null } };
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
// wk-bridge and wk-job follow. Never a folder found in a workspace: answering runs that folder's nx, and a workspace is not trusted code.
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
    items.set(o.id, { id: o.id, at: Date.parse(o.at) || 0, from: FROM.includes(o.from) ? o.from : 'unknown',
      title: oneLine(o.title).slice(0, MAX_TITLE) || 'Untitled suggestion', detail: manyLines(typeof o.detail === 'string' ? o.detail : '').slice(0, MAX_TEXT),
      action: type, ref: type === 'task-merge' ? a.ref : '', money: false });
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
function readTasks(dataDir, n = 8) {
  const dir = path.join(dataDir, 'tasks');
  let names; try { names = fs.readdirSync(dir).filter(x => TASK_ID.test(x)).sort().reverse(); } catch { return { items: [], total: 0 }; }
  const items = [];
  for (const id of names) {
    if (items.length >= n) break;
    const m = readJsonSmall(path.join(dir, id, 'meta.json'), 64 * 1024);
    if (!m || m.id !== id) continue;
    const t = k => Date.parse(m[k]) || 0;
    items.push({ id, title: oneLine(m.title).slice(0, MAX_TITLE) || 'Untitled task', kind: TASK_KINDS.includes(m.kind) ? m.kind : '',
      model: str(m.model, 60), fallback: str(m.fallback, 60), modelUsed: str(m.model_used, 60),
      status: TASK_STATES.includes(m.status) ? m.status : 'unknown', from: FROM.includes(m.from) ? m.from : 'unknown',
      at: t('created_at'), takenAt: t('taken_at'), doneAt: t('done_at'), note: str(m.note, 300), hasDiff: !!taskDiffFile(dataDir, id), hasTest: !!m.test });
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
  const rows = parseLines(text).map(o => ({ at: Date.parse(o.at) || 0, id: str(o.conversation_id, 80), model: str(o.model, 60),
    folder: typeof o.workspace === 'string' && o.workspace ? str(path.basename(o.workspace.replace(/[\\/]+$/, '')), 60) : '' }))
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
  if (m.cmd === 'trustKey' || m.cmd === 'rejectKey') return typeof m.id === 'string' && CRED_ID.test(m.id) ? { ok: true, msg: { cmd: m.cmd, id: m.id } } : { ok: false, error: 'unknown phone key' };
  if (m.cmd === 'send') {
    if (!KINDS.includes(m.kind)) return { ok: false, error: 'unknown kind' };
    if (typeof m.text !== 'string') return { ok: false, error: 'no text' };
    const text = m.text.trim();
    if (!text) return { ok: false, error: 'Write something first.' };
    if (text.length > MAX_TEXT) return { ok: false, error: 'That is over 4,000 characters. Please shorten it.' };
    return { ok: true, msg: { cmd: 'send', kind: m.kind, text } };
  }
  return { ok: true, msg: { cmd: m.cmd } };
}

// ---------------------------------------------------------------- P2-227: jobs, projects and the phone (files written by wk-job, wk-projects and wk-bridge)
const JOB_ID = /^J-\d{8}-\d{4}-[0-9a-f]{4}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CRED_ID = /^[A-Za-z0-9_-]{16,1400}$/;
const MODELS = ['sonnet', 'opus', 'fable', 'haiku'];
const MODES = ['auto', 'acceptEdits', 'plan'];
const MODE_WORDS = { auto: 'Edit and run commands (auto mode)', acceptEdits: 'Edit files, no commands', plan: 'Look and plan only' };
const JOB_STATES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped'];
const MAX_PROMPT = 8000;
// No built-in server (P2-243): the same shape and values as bin/remote-lib.mjs; `wk-bridge config` sets origin, rp_id, host and user.
const REMOTE_DEFAULTS = { enabled: false, login: 'passkey', origin: '', rp_id: '', host: '', port: 22, user: '', server_command: '',
  key: '~/.ssh/wk_bridge_ed25519', max_jobs: 2, job_hours: 3, pace_stop_pct: 90 };
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
  return { enabled: r.enabled, origin: r.origin,
    trusted: (Array.isArray(k.keys) ? k.keys : []).filter(ok).slice(0, 20).map(x => ({ id: x.id, label: oneLine(x.label).slice(0, 40) || 'Phone', added_at: num(x.added_at) })),
    pending: (Array.isArray(p.keys) ? p.keys : []).filter(ok).slice(-5).map(x => ({ id: x.id, label: oneLine(x.label).slice(0, 40) || 'Phone', registered_at: num(x.registered_at) })) };
}

function readJobEvents(file, after = 0, max = 200) {
  let ht; try { ht = readHeadTail(file, 256 * 1024); } catch { return []; }
  const lines = parseLines(ht.whole ? ht.head : ht.tail, { dropFirst: !ht.whole });
  return lines.filter(e => isObj(e) && Number.isInteger(e.n) && e.n > after).slice(-max);
}
function jobSummary(m, dir, { tail = 0 } = {}) {
  const t = (s, n) => oneLine(s).slice(0, n);
  const first = (() => { try { return fs.readFileSync(path.join(dir, 'prompt-1.txt'), 'utf8').split('\n').find(l => l.trim() && !/^Work in .*\(project .*\)\.$/.test(l.trim())) || ''; } catch { return ''; } })();
  const out = { id: m.id, project: t(m.project, 64), model: MODELS.includes(m.model) ? m.model : '', mode: MODES.includes(m.mode) ? m.mode : '',
    from: ['phone', 'panel', 'cli'].includes(m.from) ? m.from : 'cli', state: JOB_STATES.includes(m.state) ? m.state : 'failed',
    started_at: num(m.started_at), ended_at: num(m.ended_at), cost_usd: fin(m.cost_usd), turns: fin(m.turns),
    title: t(first, 80) || 'Untitled job', last_text: t(m.last_text, 300) };
  // a legal job runs on the newest top model the plan has (wk-job, config/models.json): its label names the model it ran on
  if (m.legal === true) { out.legal = true; out.model_id = typeof m.model_id === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(m.model_id) ? m.model_id : ''; }
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
    execFile('git', ['-C', cwd, ...GIT_SAFE, ...args], { timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true, shell: false,
      env: { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } },
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
  return { key: p.key, name: p.name, path: tilde(p.path, home), kind: p.kind,
    branch: branch ? oneLine(branch).slice(0, 80) : '', git: branch != null,
    last: sha ? { sha7: sha.slice(0, 7), at: (Number(at) || 0) * 1000, subject: oneLine(subject).slice(0, 100) } : null,
    changed: st == null ? null : st.split('\n').filter(Boolean).length,
    ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null,
    items: openItems(repo, rel || null) };
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
    return { ...x,
      sessions: ss.filter(s => s.active && s.project === base).length,
      gemini: Object.entries(repoOf).filter(([r]) => r === abs).reduce((a, [, c]) => a + c, 0),
      jobs: js.filter(j => j.project === x.key && (j.state === 'running' || j.state === 'waiting')).length };
  });
  return { found: true, items, more: Math.max(0, f.projects.length - list.length) };
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
    return { now, paths: p, pluginOk, dataOk: false, pace: { state: 'no-plugin' }, kill: { on: false, at: 0, file: '' },
      ledger: { missing: true, totals: { usd: 0, runs: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }, top: [], wakeups: [], bad: 0 },
      sessions, locks, inbox: [], advice: { items: [], total: 0 }, ask: { installed: false, off: false, commandOk: false }, update: { version: null, last: null },
      questions: { available: false, items: [], total: 0, hidden: 0 }, suggestions: { items: [], total: 0 }, tasks: { items: [], total: 0 },
      gemini: { items: [], active: 0 }, geminiConfig: { found: false, prompt: '', routes: {} },
      jobs: [], projects: [], projectsFile: { found: false, more: 0 }, phone: { enabled: false, origin: '', trusted: [], pending: [] }, remote: null };
  }
  const later = safe(() => readPanelState(p.dataDir).later, {});
  const killFile = killFilePath(p.pluginPath, p.home);
  const jobs = safe(() => readJobs(p.dataDir), []);
  const [pace, pr] = await Promise.all([readPace(p.pluginPath, p.dataDir, opts),
    readProjects(p.dataDir, { home: p.home, now, sessions, jobs }).catch(() => ({ found: false, items: [], more: 0 }))]);
  return {
    now, paths: p, pluginOk,
    dataOk: !!statOrNull(p.dataDir),
    pace,
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
  };
}

module.exports = { pluginInstalled, HEAD_TAIL, MAX_TEXT, expandHome, resolvePaths, readPace, readHeadTail, parseLines, decodeProject, modelName,
  cleanText, userText, sessionInfo, readMembers, listSessions, readLedger, readLocks, appendInbox, readInbox, inboxFile,
  killFilePath, killState, setKill, validateMessage, collect, readAdvice, adviceFile, askState, installAsk, readUpdate,
  // P2-223
  COMMANDS, KINDS, TASK_KINDS, TASK_STATES, CHOICES, SUGGESTION_ID, TASK_ID, QUESTION_N, LATER_MS, isMoney, isLegal, legalLabel, oneLine, manyLines,
  questionsAvailable, questionsDir, updateRoute, parseQuestionLine, readQuestions, findOpenQuestion, okAnswer, answerQuestion, readPanelState, setLater, panelStateFile,
  readSuggestions, findOpenSuggestion, readTasks, taskDiffFile, readGeminiSessions, readGeminiConfig, readHookPass, MERGE_TIMEOUT_MS, MAX_TEST, decideSuggestion, addTask,
  // P2-227
  run, childEnv, writePrivate, readJsonSmall, JOB_ID, PROJECT_KEY, CRED_ID, MODELS, MODES, MODE_WORDS, JOB_STATES, MAX_PROMPT, REMOTE_DEFAULTS,
  readRemote, readPhone, readJobs, readJobEvents, jobSummary, readProjectsFile, readProjects, openItems, git };
