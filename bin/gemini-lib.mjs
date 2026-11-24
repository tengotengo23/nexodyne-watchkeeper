// Shared code for the Gemini queue (P2-223): wk-task, wk-suggest, wk-state, the Antigravity hooks.
// Watchkeeper only writes and reads plain files under ~/.wk (or $WK_HOME). It never runs agy, never calls Google's
// service and never reads Antigravity's login. Every git call uses execFile with an argument array. No network.
// The file formats are in docs/DATA-CONTRACT.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root } from './lib.mjs';
import { isLegal } from './model-pick.mjs';

export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export const tasksDir = () => path.join(wkHome(), 'tasks');
export const worktreesDir = () => path.join(wkHome(), 'worktrees');
export const suggestionsFile = () => path.join(wkHome(), 'suggestions.jsonl');
export const inboxFile = () => path.join(wkHome(), 'owner-inbox.jsonl');
export const sessionsFile = () => path.join(wkHome(), 'gemini', 'sessions.jsonl');
export const configFile = () => path.join(root(), 'config', 'gemini.json');
export const version = () => { try { return JSON.parse(fs.readFileSync(path.join(root(), '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; } };

export const TASK_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;   // the same rule as advice ids
export const SUGGESTION_ID = /^S-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const FROM_TASK = ['claude', 'owner', 'gemini'];
export const FROM_SUGGESTION = ['claude', 'gemini', 'watchkeeper', 'owner'];
export const STATUSES = ['queued', 'taken', 'verified', 'failed', 'out-of-scope', 'no-change', 'merged', 'discarded', 'conflict'];
export const CHOICES = ['ok', 'later', 'no'];
export const MAX_TITLE = 200, MAX_NOTE = 4000, MAX_DETAIL = 4000, MAX_TEXT = 20000;

// ---------------------------------------------------------------- config (defaults when a key is missing)
const DEFAULTS = {
  default_kind: 'code',
  max_tasks_per_day: 12,
  test_timeout_min: 10,
  later_hours: 24,
  sessions_keep: 500,
  hook_pass_decision: 'ask',
  routes: { code: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'everyday coding' } },
  keywords: {},
  automation_prompt: '',
};
export function config() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch {}
  const o = { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  const posInt = (v, d, max) => (Number.isInteger(v) && v > 0 && v <= max ? v : d);
  o.max_tasks_per_day = posInt(o.max_tasks_per_day, DEFAULTS.max_tasks_per_day, 1000);
  o.test_timeout_min = posInt(o.test_timeout_min, DEFAULTS.test_timeout_min, 240);
  o.later_hours = posInt(o.later_hours, DEFAULTS.later_hours, 24 * 30);
  o.sessions_keep = posInt(o.sessions_keep, DEFAULTS.sessions_keep, 100000);
  if (!['allow', 'ask', 'force_ask'].includes(o.hook_pass_decision)) o.hook_pass_decision = 'ask';
  if (!o.routes || typeof o.routes !== 'object' || !o.routes[o.default_kind]) { o.routes = { ...DEFAULTS.routes, ...(o.routes || {}) }; if (!o.routes[o.default_kind]) o.default_kind = 'code'; }
  return o;
}
export const kinds = (c = config()) => Object.keys(c.routes);

// No kind given: the first kind (in the keywords table's order) with a word in the title or text, else the default.
// Legal wording comes first and uses the shared list (panel/src/legal-words.js), not a keyword copy of its own.
export function guessKind(title, text = '', c = config()) {
  if (c.routes && c.routes.legal && isLegal(`${title || ''} ${text || ''}`)) return 'legal';
  const hay = ` ${String(title || '')} ${String(text || '')} `.toLowerCase();
  for (const [kind, words] of Object.entries(c.keywords || {})) {
    if (!c.routes[kind] || !Array.isArray(words)) continue;
    for (const w of words) {
      if (typeof w !== 'string' || !w.trim()) continue;
      const re = new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(hay)) return kind;
    }
  }
  return c.default_kind;
}

// ---------------------------------------------------------------- text, ids, files
// One line: every control character becomes a space. Detail: keeps new lines and tabs.
export const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
export const multiLine = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim();

const pad = n => String(n).padStart(2, '0');
export const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export const slug = t => (String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task');
export const newSuggestionId = (now = new Date()) => `S-${stamp(now)}-${crypto.randomBytes(2).toString('hex')}`;

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} return d; }
export function writeFile(p, s) { ensureDir(path.dirname(p)); const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, s, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, p); }
export function appendLine(p, obj) {
  ensureDir(path.dirname(p));
  const fd = fs.openSync(p, 'a', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(obj) + '\n'); } finally { fs.closeSync(fd); }
}
export const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
export function readLines(p) {
  let s; try { s = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of s.split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch {} }
  return out;
}

// A lock made with 'wx' (never follows or overwrites). A lock older than staleMs is taken over.
export function withLock(file, fn, { waitMs = 15000, staleMs = 120000 } = {}) {
  ensureDir(path.dirname(file));
  const token = `${process.pid} ${Date.now()} ${crypto.randomBytes(4).toString('hex')}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, token + '\n'); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.rmSync(file, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('another Watchkeeper command holds the lock; try again in a minute');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { return fn(); } finally {
    try { if (fs.readFileSync(file, 'utf8').trim() === token) fs.rmSync(file, { force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- git (execFile, argument arrays, never the network)
export function git(cwd, args, { allowFail = false, input, raw = false } = {}) {   // raw: the bytes as a Buffer (change.diff and its hash)
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: raw ? 'buffer' : 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0' } });
  } catch (e) {
    if (allowFail) return null;
    const msg = String(e.stderr || e.stdout || e.message || '').trim().split('\n').filter(Boolean).pop() || 'git failed';
    throw new Error(`git ${args[0]}: ${msg.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- readers (the panel and wk-state read the same files)
export function readTask(id) { if (!TASK_ID.test(id)) return null; const m = readJSON(path.join(tasksDir(), id, 'meta.json')); return m && m.id === id ? m : null; }
export function listTasks() {
  let names = [];
  try { names = fs.readdirSync(tasksDir()).filter(x => TASK_ID.test(x)).sort(); } catch { return []; }
  return names.map(readTask).filter(Boolean);
}

export function readSuggestions(now = Date.now(), c = config()) {
  const items = new Map();
  for (const r of readLines(suggestionsFile())) {
    if (typeof r.id !== 'string' || !SUGGESTION_ID.test(r.id)) continue;
    if (typeof r.title === 'string') { if (!items.has(r.id)) items.set(r.id, { ...r, last: null }); continue; }
    if (CHOICES.includes(r.status) && items.has(r.id)) items.get(r.id).last = { at: r.at, status: r.status, ...(r.text ? { text: r.text } : {}) };
  }
  const hideMs = c.later_hours * 3600e3;
  return [...items.values()].map(s => {
    const l = s.last;
    const open = !l || (l.status === 'later' && (Date.parse(l.at) || 0) + hideMs <= now);
    const hidden = !!l && l.status === 'later' && !open;
    return { id: s.id, at: s.at, from: s.from, title: s.title, detail: s.detail || '', action: s.action || { type: 'none' }, state: open ? 'open' : hidden ? 'later' : l.status, decision: l };
  });
}

export function readSessions(n = 20) { return readLines(sessionsFile()).slice(-n).reverse(); }

// Questions: open lines "- [ ] Q<n> (<date time>, tab <x>): <text>" in <orchestration>/QUESTIONS.md. Read only; nx answers them.
export const QUESTION_LINE = /^- \[ \] Q(\d{1,6}) \(([^,()]*), tab ([^)]*)\):\s*(.*)$/;
export function readQuestions(orch) {
  if (!orch) return [];
  let s; try { s = fs.readFileSync(path.join(orch, 'QUESTIONS.md'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of s.split('\n')) {
    const m = QUESTION_LINE.exec(line.trimEnd());
    if (!m) continue;
    // the panel's rule (panel/src/data.js parseQuestionLine): the last "Recommended:" marker is the recommendation, cut from the text
    const full = oneLine(m[4]).slice(0, 4000);
    let last = null;
    for (const x of full.matchAll(/\bRecommended(?: answer)?\s*:\s*/gi)) last = x;
    const text = last ? full.slice(0, last.index).trim() || full : full;
    const rec = last ? full.slice(last.index + last[0].length).trim() : '';
    out.push({ n: Number(m[1]), at: oneLine(m[2]), tab: oneLine(m[3]).slice(0, 40), text, recommended: rec ? rec.slice(0, 1000) : null });
  }
  return out.sort((a, b) => b.n - a.n);
}
export function findOrchestration(cwd = process.cwd()) {
  const env = process.env.WK_ORCHESTRATION;
  if (env) return path.resolve(env);
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const o = path.join(d, 'orchestration');
    if (fs.existsSync(path.join(o, 'QUESTIONS.md'))) return o;
    if (path.dirname(d) === d) return null;
  }
}

// ---------------------------------------------------------------- writers shared by wk-task and wk-suggest
export function addSuggestion({ from, title, detail = '', action = { type: 'none' } }, now = new Date()) {
  if (!FROM_SUGGESTION.includes(from)) throw new Error(`from must be one of ${FROM_SUGGESTION.join(', ')}`);
  const t = oneLine(title), d = multiLine(detail);
  if (!t) throw new Error('a suggestion needs a title');
  if (t.length > MAX_TITLE) throw new Error(`the title is longer than ${MAX_TITLE} characters`);
  if (d.length > MAX_DETAIL) throw new Error(`the detail is longer than ${MAX_DETAIL} characters`);
  if (!action || !['none', 'task-merge'].includes(action.type)) throw new Error('unknown action');
  if (action.type === 'task-merge' && !TASK_ID.test(String(action.ref || ''))) throw new Error('a merge suggestion needs a task id');
  const item = { id: newSuggestionId(now), at: now.toISOString(), from, title: t, detail: d, action: action.type === 'none' ? { type: 'none' } : { type: 'task-merge', ref: action.ref } };
  appendLine(suggestionsFile(), item);
  return item;
}
export function appendDecision({ ref, choice, title, text }, now = new Date()) {
  const row = { at: now.toISOString(), kind: 'decision', ref, choice, title: oneLine(title).slice(0, MAX_TITLE) };
  const t = oneLine(text).slice(0, MAX_DETAIL);
  if (t) row.text = t;
  appendLine(inboxFile(), row);
  return row;
}
