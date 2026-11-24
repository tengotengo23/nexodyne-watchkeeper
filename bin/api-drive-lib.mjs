// api-drive-lib (P2-278): the API drive's key store, prices, caps, usage log and HTTP helper, shared by wk-keys, wk-ask and the W panel.
// Keys: ~/.config/watchkeeper/keys/ (0700), gemini.key and anthropic.key (0600), written atomically with fs only (never argv, env, a shell
// or a log). Test override: WK_KEYS_DIR. A key is never printed: callers get saved/not saved and the last four characters.
// Usage log: ~/.wk/api-drive/usage.jsonl (0600, last 5,000 lines): time, provider, model, caller, tokens, cost, ms, ok; never a prompt,
// an answer or a key. Config: config/api-drive.json (public), merged with ~/.wk/api-drive.json (the user's overrides).
// No child processes in this file (a test checks it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PROVIDERS = {
  gemini: { file: 'gemini.key', label: 'Gemini', host: 'https://generativelanguage.googleapis.com', hostEnv: 'WK_GEMINI_API_HOST', modelRe: /^gemini-/ },
  claude: { file: 'anthropic.key', label: 'Claude', host: 'https://api.anthropic.com', hostEnv: 'WK_ANTHROPIC_API_HOST', modelRe: /^claude-/ },
};
export const ANTHROPIC_VERSION = '2023-06-01';
export const MAX_KEY = 256;
export const LOG_KEEP = 5000;
export const CALLERS = ['claude_code', 'antigravity', 'terminal'];
export const NO_KEY_MSG = "Paste your key in the W panel's API keys card.";

export function normProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  if (s === 'anthropic') return 'claude';
  return Object.hasOwn(PROVIDERS, s) ? s : null;
}
export const keysDir = () => path.resolve(process.env.WK_KEYS_DIR || path.join(os.homedir(), '.config', 'watchkeeper', 'keys'));
export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export const usageFile = () => path.join(wkHome(), 'api-drive', 'usage.jsonl');
export const userConfigFile = () => path.join(wkHome(), 'api-drive.json');
const keyFile = p => path.join(keysDir(), PROVIDERS[p].file);
const statusFile = () => path.join(keysDir(), 'status.json');

// ---------------------------------------------------------------- folder identity (the review's M1 and M5)
// The default keys folders: one from HOME and one from the account's own home folder (HOME can be changed; the account's cannot).
export function homeDirs() {
  const s = new Set(); try { s.add(path.resolve(os.homedir())); } catch {} try { s.add(path.resolve(os.userInfo().homedir)); } catch {}
  return [...s].filter(Boolean);
}
export const defaultKeysDirs = () => homeDirs().map(h => path.join(h, '.config', 'watchkeeper', 'keys'));
// The real path, case-folded (macOS folders ignore case): the deepest part that exists goes through realpath.native, the rest is appended.
export function realFold(p) {
  let d = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(d), ...rest).toLowerCase(); } catch {}
    const up = path.dirname(d); if (up === d) return path.resolve(p).toLowerCase();
    rest.unshift(path.basename(d)); d = up;
  }
}
const statOrNull = p => { try { return fs.statSync(p); } catch { return null; } };
// The same folder (or file): device plus inode when both exist, else the case-folded real path.
export function sameFolder(a, b) {
  const x = statOrNull(a), y = statOrNull(b);
  if (x && y) return x.dev === y.dev && x.ino === y.ino;
  return realFold(a) === realFold(b);
}
// Every folder from p up to /, as {dev, ino} where it exists and as a case-folded real path.
export function ancestry(p) {
  const out = []; let d = path.resolve(p);
  for (;;) { const st = statOrNull(d); out.push({ path: d, fold: realFold(d), dev: st?.dev, ino: st?.ino }); const up = path.dirname(d); if (up === d) return out; d = up; }
}
// true when folder `dir` is p itself or any folder above p (by device plus inode, or by the case-folded real path)
export function isAtOrAbove(dir, p) {
  const st = statOrNull(dir), f = realFold(dir);
  return ancestry(p).some(a => (st && a.dev === st.dev && a.ino === st.ino) || a.fold === f);
}
// Is the keys folder in use the real one? True when WK_KEYS_DIR is unset, or names a default keys folder by another spelling
// (a link, a case variant, doubled slashes), or holds a key file that is the default key file by a hard link (stat only, never read).
export function keysDirIsDefault(env = process.env) {
  if (!env.WK_KEYS_DIR) return true;
  const k = path.resolve(env.WK_KEYS_DIR);
  for (const d of defaultKeysDirs()) {
    if (sameFolder(k, d)) return true;
    for (const P of Object.values(PROVIDERS)) {
      const a = statOrNull(path.join(k, P.file)), b = statOrNull(path.join(d, P.file));
      if (a && b && a.dev === b.dev && a.ino === b.ino) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- atomic files
// Creates the folder with the mode; a folder that is already there keeps its mode (the review's N1: chmod only what we create).
function ensureDir(d, mode) {
  let st = null; try { st = fs.lstatSync(d); } catch { /* not there yet */ }
  if (st && st.isSymbolicLink()) throw new Error(`refused: ${d} is a symbolic link`);
  if (!st) { fs.mkdirSync(d, { recursive: true, mode }); fs.chmodSync(d, mode); }
}
function fsyncDir(d) { let fd; try { fd = fs.openSync(d, 'r'); fs.fsyncSync(fd); } catch { /* not supported here */ } finally { if (fd != null) try { fs.closeSync(fd); } catch {} } }
// A temp file in the same folder (created exclusively, mode 0600), then rename, then fsync of the folder: a reader sees the old file or
// the new one, never half, and the rename survives a power cut.
export function atomicWrite(file, text, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  fsyncDir(path.dirname(file));
}

// ---------------------------------------------------------------- key store
// trim; refuse empty, whitespace inside, non-printable ASCII, over 256 characters. Returns a plain reason, or null when the key is fine.
export function keyProblem(key) {
  if (typeof key !== 'string') return 'The key must be text.';
  const k = key.trim();
  if (!k) return 'The key is empty.';
  if (/\s/.test(k)) return 'The key has a space or line break inside; paste it again.';
  if (/[^\x21-\x7e]/.test(k)) return 'The key has characters an API key never has; paste it again.';
  if (k.length > MAX_KEY) return `The key is longer than ${MAX_KEY} characters; paste only the key.`;
  return null;
}
export function saveKey(provider, key) {
  const p = normProvider(provider); if (!p) throw new Error('Unknown provider: use gemini or claude.');
  const bad = keyProblem(key); if (bad) throw new Error(bad);
  ensureDir(keysDir(), 0o700);
  atomicWrite(keyFile(p), key.trim(), 0o600);
  setStatus(p, null);
  return { provider: p, saved: true, tail: keyTail(p) };
}
// internal: the key goes only into a request header, never to output
export function readKey(provider) {
  const p = normProvider(provider); if (!p) return null;
  try { const k = fs.readFileSync(keyFile(p), 'utf8').trim(); return k && !keyProblem(k) ? k : null; } catch { return null; }
}
export const hasKey = provider => !!readKey(provider);
export function keyTail(provider) { const k = readKey(provider); return k ? k.slice(-4) : null; }
export function removeKey(provider) {
  const p = normProvider(provider); if (!p) throw new Error('Unknown provider: use gemini or claude.');
  let removed = false;
  try { fs.unlinkSync(keyFile(p)); removed = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (fs.existsSync(keysDir())) setStatus(p, null);
  return { provider: p, saved: false, removed };
}

// ---------------------------------------------------------------- redaction
export function redact(s) {
  let t = String(s ?? '');
  for (const p of Object.keys(PROVIDERS)) { const k = readKey(p); if (k && k.length >= 8) t = t.split(k).join('[key]'); }
  return t.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key]').replace(/sk-ant-[0-9A-Za-z_-]{6,}/g, '[key]');
}

// ---------------------------------------------------------------- status (no secrets)
export function readStatusFile() { try { const j = JSON.parse(fs.readFileSync(statusFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
export function setStatus(provider, rec) {
  const p = normProvider(provider); if (!p) return;
  ensureDir(keysDir(), 0o700);
  const all = readStatusFile();
  if (rec) all[p] = { checked: rec.checked, ok: !!rec.ok, text: redact(rec.text).slice(0, 200) }; else delete all[p];
  atomicWrite(statusFile(), JSON.stringify(all, null, 2) + '\n', 0o600);
}
export function status() {
  const st = readStatusFile(), out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const tail = keyTail(p), s = st[p] || null;
    out[p] = { provider: p, saved: !!tail, tail, checked: tail && s ? s.checked || null : null, ok: tail && s ? !!s.ok : null, text: tail && s ? s.text || '' : '' };
  }
  return out;
}
const hhmm = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// "Not set" / "Saved, ends in 1a2b · checked 23:58: works" / "Saved, ends in 1a2b · checked 23:58: <plain error>"
export function statusLine(s) {
  if (!s || !s.saved) return 'Not set';
  let line = `Saved, ends in ${s.tail}`;
  if (s.checked) line += ` · checked ${hhmm(s.checked)}: ${s.ok ? 'works' : (s.text || 'did not work')}`;
  return line;
}

// ---------------------------------------------------------------- config and prices
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v;
  return o;
}
export function loadConfig() {
  let base = {}; try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'api-drive.json'), 'utf8')); } catch {}
  let user = {}; try { user = JSON.parse(fs.readFileSync(userConfigFile(), 'utf8')); } catch {}
  const c = merge(base, isObj(user) ? user : {});
  c.enabled = c.enabled !== false;
  c.daily_cap_usd = { gemini: 2, claude: 2, ...(isObj(c.daily_cap_usd) ? c.daily_cap_usd : {}) };
  c.hourly_calls = Number.isFinite(+c.hourly_calls) && +c.hourly_calls >= 0 ? +c.hourly_calls : 30;
  c.max_out = Number.isInteger(+c.max_out) && +c.max_out > 0 ? +c.max_out : 4096;
  c.max_files_kb = +c.max_files_kb > 0 ? +c.max_files_kb : 400;
  c.timeout_s = +c.timeout_s > 0 ? +c.timeout_s : 120;
  c.claude_cache_min_tokens = +c.claude_cache_min_tokens > 0 ? +c.claude_cache_min_tokens : 512;
  c.claude_cache_write_multiplier = +c.claude_cache_write_multiplier > 0 ? +c.claude_cache_write_multiplier : 1.25;
  c.aliases = isObj(c.aliases) ? c.aliases : {}; c.default_model = isObj(c.default_model) ? c.default_model : {}; c.prices = isObj(c.prices) ? c.prices : {};
  return c;
}
export const capFor = (provider, cfg = loadConfig()) => { const v = +cfg.daily_cap_usd[provider]; return Number.isFinite(v) && v >= 0 ? v : 2; };

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/;
// alias or full id -> model id; null when it is not a model id of that provider
export function resolveModel(provider, m, cfg = loadConfig()) {
  const al = cfg.aliases[provider] || {};
  const want = String(m || cfg.default_model[provider] || '').trim().toLowerCase();
  const id = Object.hasOwn(al, want) ? al[want] : want;
  return MODEL_RE.test(id) && PROVIDERS[provider].modelRe.test(id) ? id : null;
}
export const utcDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
// the price entry for a model on a day (dated entries: "from"/"until", inclusive) and prompt size (Haiku tiers: prompt_up_to / prompt_over)
export function priceFor(model, day = utcDay(), promptTokens = 0, cfg = loadConfig()) {
  const list = cfg.prices[model]; if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (e.from && day < e.from) continue;
    if (e.until && day > e.until) continue;
    if (e.prompt_up_to != null && promptTokens > e.prompt_up_to) continue;
    if (e.prompt_over != null && promptTokens <= e.prompt_over) continue;
    if ([e.input, e.output, e.cached].every(x => typeof x === 'number')) return e;
  }
  return null;
}
// usage is the normalised record: in (all prompt tokens), cached (cache reads), cache_write (Anthropic cache writes), out (incl. thinking)
export function costOf(provider, price, u, cfg = loadConfig()) {
  if (!price) return null;
  const M = 1e6, cached = u.cached || 0, write = u.cache_write || 0;
  if (provider === 'claude') {
    const plain = Math.max(0, (u.in || 0) - cached - write);
    return (plain * price.input + write * price.input * cfg.claude_cache_write_multiplier + cached * price.cached + (u.out || 0) * price.output) / M;
  }
  return (Math.max(0, (u.in || 0) - cached) * price.input + cached * price.cached + (u.out || 0) * price.output) / M;
}
// the cost charged against the daily cap: the real estimate, or for an unknown model the provider's most expensive known price
export function costForCap(provider, model, u, day = utcDay(), cfg = loadConfig()) {
  const p = priceFor(model, day, u.in || 0, cfg);
  if (p) { const c = costOf(provider, p, u, cfg); return { cost: c, cap_cost: c }; }
  let worst = 0;
  for (const [id, list] of Object.entries(cfg.prices)) {
    if (!PROVIDERS[provider].modelRe.test(id) || !Array.isArray(list)) continue;
    for (const e of list) { const c = costOf(provider, e, u, cfg); if (c > worst) worst = c; }
  }
  return { cost: null, cap_cost: worst };
}

// ---------------------------------------------------------------- usage log
// Parallel calls share one log, so the cap check, the reservation and every append run under one lock (the review's M4): a folder made
// with mkdir (atomic), removed when the work is done; a lock older than 30 s is from a crashed process and is cleared.
const LOCK_STALE_MS = 30000, LOCK_WAIT_MS = 15000, TRIM_SLACK = 500;
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function usageDir() { const d = path.dirname(usageFile()); ensureDir(path.dirname(d), 0o700); ensureDir(d, 0o700); return d; }
export function withUsageLock(fn) {
  const lock = path.join(usageDir(), '.lock'), start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch { /* gone already */ }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('The usage log is busy; try again.');
      nap(10 + Math.floor(Math.random() * 30));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
function readRaw() {
  let txt = ''; try { txt = fs.readFileSync(usageFile(), 'utf8'); } catch { return []; }
  const out = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
// The log as the caps see it: a reservation line drops out once its call is settled; an unsettled one still counts (a crashed call
// keeps its worst-case cost until the day ends, which errs on the safe side).
export function readUsage() {
  const raw = readRaw(), settled = new Set(raw.filter(r => r.settles).map(r => r.settles));
  return raw.filter(r => !(r.reserved && settled.has(r.id)));
}
// One line appended (never a rewrite), to a file that is not a link, mode 0600. Call only under the lock.
function appendLine(rec) {
  const fd = fs.openSync(usageFile(), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.appendFileSync(fd, JSON.stringify(rec) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function trimLog() {
  const raw = readRaw();
  if (raw.length > LOG_KEEP + TRIM_SLACK) atomicWrite(usageFile(), raw.slice(-LOG_KEEP).map(x => JSON.stringify(x)).join('\n') + '\n', 0o600);
}
const ID_RE = /^[0-9a-f]{16}$/;
const cleanCaller = c => CALLERS.includes(c) ? c : 'terminal';
// Before a request: under the lock, run check(lines) (it throws to refuse: cap, hourly limit, worst case), then write a reservation
// line that holds the worst-case cost and counts as a call. Returns the reservation id, which appendUsage settles afterwards.
export function reserveCall({ provider, model, caller, cap_cost }, check) {
  return withUsageLock(() => {
    if (check) check(readUsage());
    const id = crypto.randomBytes(8).toString('hex');
    appendLine({ id, reserved: true, time: new Date().toISOString(), provider, model: String(model || '').slice(0, 90), caller: cleanCaller(caller),
      cost: null, cap_cost: typeof cap_cost === 'number' && Number.isFinite(cap_cost) ? +cap_cost.toFixed(6) : 0, ok: false });
    return id;
  });
}
export function appendUsage(rec) {
  const clean = {
    time: rec.time || new Date().toISOString(), provider: rec.provider, model: String(rec.model || '').slice(0, 90), caller: cleanCaller(rec.caller),
    in: rec.in | 0, cached: rec.cached | 0, cache_write: rec.cache_write | 0, out: rec.out | 0,
    cost: typeof rec.cost === 'number' ? +rec.cost.toFixed(6) : null, cap_cost: typeof rec.cap_cost === 'number' ? +rec.cap_cost.toFixed(6) : 0,
    ms: rec.ms | 0, ok: !!rec.ok, ...(rec.status ? { status: rec.status | 0 } : {}), ...(ID_RE.test(rec.settles || '') ? { settles: rec.settles } : {}),
  };
  withUsageLock(() => {
    // settling: the reservation line is replaced by the real record (one line per call); a lost reservation means a plain append
    if (clean.settles) {
      let txt = ''; try { txt = fs.readFileSync(usageFile(), 'utf8'); } catch {}
      const lines = txt.split('\n').filter(l => l.trim());
      const i = lines.findIndex(l => { try { const r = JSON.parse(l); return r.reserved && r.id === clean.settles; } catch { return false; } });
      if (i >= 0) {
        const { settles, ...rec } = clean; lines[i] = JSON.stringify(rec);
        const keep = lines.length > LOG_KEEP + TRIM_SLACK ? lines.slice(-LOG_KEEP) : lines;
        atomicWrite(usageFile(), keep.join('\n') + '\n', 0o600);
        return;
      }
    }
    appendLine(clean); trimLog();
  });
  return clean;
}
export function todaySpend(provider, now = new Date(), lines = readUsage()) {
  const day = utcDay(now); let s = 0;
  for (const r of lines) if (r.provider === provider && String(r.time).slice(0, 10) === day) s += typeof r.cost === 'number' ? r.cost : (+r.cap_cost || 0);
  return s;
}
export function callsLastHour(provider, now = new Date(), lines = readUsage()) {
  const t = +now - 3600e3; return lines.filter(r => r.provider === provider && Date.parse(r.time) > t).length;
}
export function spendSummary(now = new Date()) {
  const cfg = loadConfig(), lines = readUsage(), out = {};
  for (const p of Object.keys(PROVIDERS)) out[p] = { today_usd: todaySpend(p, now, lines), cap_usd: capFor(p, cfg), calls_hour: callsLastHour(p, now, lines) };
  return { enabled: cfg.enabled, ...out };
}

// ---------------------------------------------------------------- caller
export function detectCaller(env = process.env) {
  if (CALLERS.includes(env.WK_CALLER)) return env.WK_CALLER;
  if (env.CLAUDECODE === '1') return 'claude_code';
  const hint = `${env.TERM_PROGRAM || ''} ${env.__CFBundleIdentifier || ''}`.toLowerCase();
  if (hint.includes('antigravity') || Object.keys(env).some(k => k.startsWith('ANTIGRAVITY'))) return 'antigravity';
  return 'terminal';
}

// ---------------------------------------------------------------- hosts and HTTP
// Keys go only to the provider's own API host, or, with a test keys folder, to a local test host (plain http only for 127.0.0.1 and localhost).
export function hostFor(provider, env = process.env) {
  const P = PROVIDERS[provider], raw = env[P.hostEnv];
  if (!raw) return P.host;
  // A test host is honoured only with a test keys folder (the review's M1): with the real keys it would send the real key to any local
  // listener. Nothing is sent then, rather than falling back to the real host behind the caller's back.
  if (keysDirIsDefault(env)) throw new Error(`${P.hostEnv} works only with a test keys folder (WK_KEYS_DIR, not the real keys folder); nothing was sent.`);
  let u; try { u = new URL(raw); } catch { throw new Error(`${P.hostEnv} is not a web address.`); }
  const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
  const official = u.protocol === 'https:' && u.origin === P.host;
  if (!(official || (local && ['http:', 'https:'].includes(u.protocol)))) throw new Error(`${P.hostEnv} may only point to ${P.host} or a local test server; nothing was sent.`);
  return u.origin;
}
export function authHeaders(provider, key) {
  return provider === 'gemini' ? { 'x-goog-api-key': key } : { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function retryWait(res) {
  const ra = res.headers.get('retry-after');
  if (ra != null && ra !== '') {
    const n = Number(ra); if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 30000);
    const t = Date.parse(ra); if (!isNaN(t)) return Math.max(0, Math.min(t - Date.now(), 30000));
  }
  const d = Number(process.env.WK_API_RETRY_MS); return Number.isFinite(d) && d >= 0 ? Math.min(d, 30000) : 2000;
}
function plainHttpError(status, body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = j?.error?.message || j?.message || ''; } catch { msg = String(body || '').slice(0, 200); }
  const head = status === 401 || status === 403 ? 'The key was refused' : status === 429 ? 'Too many requests or no quota left' : status >= 500 ? 'The provider had a server error' : 'The request was refused';
  return redact(`${head} (HTTP ${status})${msg ? ': ' + String(msg).slice(0, 300) : ''}.`);
}
// One request with a timeout; one retry on 429 or 5xx (Retry-After honoured up to 30 s). Never throws with a key in the message.
export async function request({ method = 'GET', url, headers = {}, body, timeoutMs = 120000, retry = true }) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ac.signal, redirect: 'error' });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      if (ac.signal.aborted) throw Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`), { code: 'timeout' });
      throw Object.assign(new Error(redact(`Could not reach the provider: ${e.cause?.code || e.message}.`)), { code: 'network' });
    }
    clearTimeout(timer);
    if (res.ok) { let json; try { json = JSON.parse(text); } catch { throw Object.assign(new Error('The provider sent an answer that is not JSON.'), { code: 'bad_json', status: res.status }); } return { status: res.status, json, attempts: attempt + 1 }; }
    if (retry && attempt === 0 && (res.status === 429 || res.status >= 500)) { await sleep(retryWait(res)); continue; }
    throw Object.assign(new Error(plainHttpError(res.status, text)), { code: 'http', status: res.status });
  }
}

// ---------------------------------------------------------------- key check (a free model-list call)
export async function checkKey(provider, { timeoutMs = 20000 } = {}) {
  const p = normProvider(provider); if (!p) throw new Error('Unknown provider: use gemini or claude.');
  const key = readKey(p);
  if (!key) return { provider: p, saved: false, ok: false, text: NO_KEY_MSG };
  const host = hostFor(p);
  const url = p === 'gemini' ? `${host}/v1beta/models` : `${host}/v1/models`;
  let ok = false, text;
  try { await request({ url, headers: authHeaders(p, key), timeoutMs, retry: false }); ok = true; text = 'works'; }
  catch (e) { text = redact(e.message); }
  const checked = new Date().toISOString();
  setStatus(p, { checked, ok, text });
  return { provider: p, saved: true, tail: key.slice(-4), checked, ok, text };
}

// ---------------------------------------------------------------- the key guard (the review's M1, M2, M3, S2 and S5)
// One rule set for both guards (Claude Code's wk-guard.mjs and Antigravity's guard hook). keyGuard returns a reason, or null.
// It closes the known ways to reach the keys: file tools by any spelling (case, links, doubled slashes), searches, lists and archives
// rooted at the keys folder or above it, globs that reach a key file, shell quoting, `cd` then a relative path, the test-host variables,
// and writes to the API drive's own cap and usage files. A shell can always be talked round in ways no list foresees; the keys are
// still only files in the user's home folder (see "The honest limit" in README.md).
const KEY_NAMES = ['gemini.key', 'anthropic.key', 'status.json'];
const isGlob = s => /[*?[\]{}]/.test(s);
const keyFolders = () => [...new Set([keysDir(), ...defaultKeysDirs()])];
function expandHome(s) {
  const h = os.homedir();
  return String(s).replace(/\$\{home\}|\$home(?![a-z0-9_])/gi, h).replace(/^~(?=\/|$)/, h);
}
const resolveIn = (cwd, p) => path.resolve(cwd || os.homedir(), expandHome(p));
function keyFileStats(k) { return KEY_NAMES.map(n => statOrNull(path.join(k, n))).filter(Boolean); }
// p is the keys folder, inside it, a link that resolves into it, or a hard link to a key file
function insideKeys(p) {
  const st = statOrNull(p), rf = realFold(p);
  return keyFolders().some(k => isAtOrAbove(k, p) || isAtOrAbove(k, rf) || rf.startsWith(realFold(k) + path.sep)
    || (st && st.isFile() && keyFileStats(k).some(s => s.dev === st.dev && s.ino === st.ino)));
}
// The folders a search or list must not start from: the keys folder and every folder above it, up to / for the account's own keys
// folder; for a keys folder elsewhere (a HOME or WK_KEYS_DIR override) up to the home folder that holds it, else its parent.
function aboveKeys(dir) {
  const acct = (() => { try { return path.resolve(os.userInfo().homedir); } catch { return null; } })();
  for (const k of keyFolders()) {
    if (!isAtOrAbove(dir, k)) continue;
    if (acct && isAtOrAbove(acct, k)) return true;
    const homes = homeDirs().filter(h => isAtOrAbove(h, k));
    const bounds = homes.length ? homes : [path.dirname(k)];
    if (bounds.some(b => isAtOrAbove(b, dir))) return true;
  }
  return false;
}
function segRe(seg) {
  let r = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else if (c === '[') { const j = seg.indexOf(']', i + 1); if (j < 0) { r += '\\['; continue; } r += '[' + seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    else if (c === '{') { const j = seg.indexOf('}', i + 1); if (j < 0) { r += '\\{'; continue; } r += '(' + seg.slice(i + 1, j).split(',').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')).join('|') + ')'; i = j; }
    else r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp('^' + r + '$', 'i'); } catch { return /.*/; }
}
// How an absolute glob relates to keys folder k: 'in' (it names the folder or a key file in it), 'above' (it stops above the folder,
// so a recursive walk from it would reach the keys) or null. Case-insensitive; `**` matches any number of folders.
function canReach(glob, k) {
  const g = path.resolve(glob).split('/').filter(Boolean);
  let i = 0; while (i < g.length && !isGlob(g[i])) i++;
  const pat = [...realFold('/' + g.slice(0, i).join('/')).split('/').filter(Boolean), ...g.slice(i)];
  let names = KEY_NAMES; try { names = [...KEY_NAMES, ...fs.readdirSync(k)]; } catch {}
  let best = null;
  for (const kk of new Set([realFold(k), path.resolve(k).toLowerCase()])) {
    const ks = kk.split('/').filter(Boolean), memo = new Map();
    const m = (pi, ki) => {
      const key = pi + ',' + ki; if (memo.has(key)) return memo.get(key);
      let out = null;
      if (ki === ks.length) {
        const rest = pat.slice(pi).filter(s => s !== '**');
        if (rest.length === 0 || (rest.length === 1 && names.some(n => segRe(rest[0]).test(n)))) out = 'in';
      } else if (pi === pat.length) out = 'above';
      else if (pat[pi] === '**') { const a = m(pi + 1, ki), b = m(pi, ki + 1); out = a === 'in' || b === 'in' ? 'in' : (a || b); }
      else if (segRe(pat[pi]).test(ks[ki])) out = m(pi + 1, ki + 1);
      memo.set(key, out); return out;
    };
    const r = m(0, 0); if (r === 'in') return 'in'; if (r) best = r;
  }
  return best;
}
const reach = glob => { let best = null; for (const k of keyFolders()) { const r = canReach(glob, k); if (r === 'in') return 'in'; if (r) best = r; } return best; };

// the API drive's own files (the review's S2): its caps and its usage log, which hold the spending limits
function driveTargets() {
  const cfg = new Set([userConfigFile()]), use = new Set([path.dirname(usageFile())]);
  for (const h of homeDirs()) { cfg.add(path.join(h, '.wk', 'api-drive.json')); use.add(path.join(h, '.wk', 'api-drive')); }
  return { cfg: [...cfg], use: [...use] };
}
function isDriveFile(p) {
  const { cfg, use } = driveTargets(), rf = realFold(p);
  return cfg.some(c => sameFolder(p, c) || rf === realFold(c)) || use.some(u => isAtOrAbove(u, p) || isAtOrAbove(u, rf));
}
// a folder above the usage folder, up to the home folder (an `rm -r ~/.wk` removes the log too)
function aboveDrive(p) {
  return driveTargets().use.some(u => isAtOrAbove(p, u) && homeDirs().some(h => isAtOrAbove(h, p)));
}
const driveGlob = g => { const { cfg, use } = driveTargets(); return [...cfg, ...use].some(t => { const r = canReachPath(g, t); return r === 'in'; }); };
// canReach for a single target path (a file or a folder) rather than a keys folder
function canReachPath(glob, t) {
  const g = path.resolve(glob).split('/').filter(Boolean);
  let i = 0; while (i < g.length && !isGlob(g[i])) i++;
  const pat = [...realFold('/' + g.slice(0, i).join('/')).split('/').filter(Boolean), ...g.slice(i)];
  for (const tt of new Set([realFold(t), path.resolve(t).toLowerCase()])) {
    const ts = tt.split('/').filter(Boolean);
    const m = (pi, ki) => {
      if (ki === ts.length) return pat.slice(pi).every(s => s === '**') ? 'in' : null;
      if (pi === pat.length) return null;
      if (pat[pi] === '**') return m(pi + 1, ki) || m(pi, ki + 1);
      return segRe(pat[pi]).test(ts[ki]) ? m(pi + 1, ki + 1) : null;
    };
    if (m(0, 0)) return 'in';
  }
  return null;
}

const KEY_TEXT = [/\.config\/watchkeeper\b/, /\b(gemini|anthropic)\.key\b/, /\bwk_keys_dir\b/];
const HOST_TEXT = /\bwk_(gemini|anthropic)_api_host\b/;
const RECURSIVE = new Set(['find', 'rg', 'ag', 'ack', 'fd', 'tar', 'bsdtar', 'gtar', 'zip', '7z', '7za', 'rsync', 'du', 'tree', 'ditto', 'pax', 'cpio', 'locate', 'mdfind']);
const WRITE_CMD = new Set(['rm', 'mv', 'cp', 'tee', 'truncate', 'touch', 'ln', 'chmod', 'chown', 'dd', 'unlink', 'shred', 'rmdir', 'install', 'rsync', 'srm', 'trash']);
const REMOVE_CMD = new Set(['rm', 'mv', 'rmdir', 'unlink', 'shred', 'rsync', 'srm', 'trash']);
const SCRIPT_CMD = /^(python[0-9.]*|node|ruby|perl|php|osascript|sh|bash|zsh|dash|fish|deno|bun|awk|gawk)$/;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'exec', 'xargs', 'builtin', 'doas']);
function isRecursive(cmd, opts) {
  if (RECURSIVE.has(cmd)) return true;
  const has = re => opts.some(o => re.test(o));
  if (/^(e|f)?grep$|^ggrep$/.test(cmd)) return has(/^-[a-z]*r/i) || has(/^--(dereference-)?recursive$/);
  if (cmd === 'cp' || cmd === 'scp' || cmd === 'gcp') return has(/^-[a-z]*[rRa]/) || has(/^--(recursive|archive)$/);
  if (cmd === 'ls' || cmd === 'gls') return has(/^-[a-z]*R/) || has(/^--recursive$/);
  if (cmd === 'chmod' || cmd === 'chown') return has(/^-[a-z]*R/);
  return false;
}
function bashGuard(command, cwd0) {
  const raw = String(command || '');
  let c = raw.replace(/\\\n/g, ' ').replace(/["'`\\]/g, '').replace(/\/{2,}/g, '/');
  const low = c.toLowerCase();
  if (HOST_TEXT.test(low)) return 'the command sets a test API host (WK_GEMINI_API_HOST or WK_ANTHROPIC_API_HOST); those work only in Watchkeeper\'s own tests with a test keys folder';
  if (KEY_TEXT.some(r => r.test(low))) return 'the command names the API key folder or a key file';
  c = c.replace(/(\|\||&&|[|;&<>()\n])/g, ' $1 ');
  let cwd = path.resolve(cwd0 || os.homedir());
  for (const seg of c.split(/\|\||&&|[|;&\n()]/)) {
    let words = seg.split(/\s+/).filter(Boolean);
    while (words.length && (/^[a-z_][a-z0-9_]*=/i.test(words[0]) || WRAPPERS.has(path.basename(words[0])))) words.shift();
    if (!words.length) continue;
    const cmd = path.basename(words[0]).toLowerCase(), args = words.slice(1);
    if (cmd === 'cd' || cmd === 'pushd') {
      const to = args.find(a => !a.startsWith('-'));
      cwd = to === undefined ? os.homedir() : resolveIn(cwd, to);
      if (insideKeys(cwd)) return 'the command enters the API key folder';
      continue;
    }
    const opts = args.filter(a => a.startsWith('-') && a !== '-');
    const toks = args.filter(a => a !== '<' && a !== '>' && !(a.startsWith('-') && !a.includes('='))).map(a => a.includes('=') && a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a).filter(Boolean);
    const redir = []; args.forEach((a, i) => { if (a === '>' && args[i + 1] && args[i + 1] !== '>') redir.push(args[i + 1]); });
    const rec = isRecursive(cmd, opts);
    let anyPath = false;
    for (const t of toks) {
      const abs = resolveIn(cwd, t);
      if (isGlob(t)) {
        const r = reach(abs);
        if (r === 'in') return 'a pattern in the command reaches the API key folder';
        if (r === 'above' && rec) return 'the command searches, lists or archives a folder that holds the API key folder';
      } else {
        if (statOrNull(abs)) anyPath = true;
        if (insideKeys(abs)) return 'the command touches the API key folder';
        if (rec && aboveKeys(abs)) return 'the command searches, lists or archives a folder that holds the API key folder';
      }
    }
    if (rec && !anyPath && aboveKeys(cwd)) return 'the command searches, lists or archives a folder that holds the API key folder';
    // S2: no write, move or delete of the API drive's caps or usage log
    const editsInPlace = (cmd === 'sed' || cmd === 'gsed' || cmd === 'perl') && opts.some(o => /^-[a-z]*i|^--in-place/.test(o));
    const targets = WRITE_CMD.has(cmd) || editsInPlace ? toks : redir;
    for (const t of targets) {
      const abs = resolveIn(cwd, t);
      if (isGlob(t) ? driveGlob(abs) : isDriveFile(abs)) return 'the command changes the API drive\'s caps or usage log (~/.wk/api-drive.json, ~/.wk/api-drive/)';
      if (REMOVE_CMD.has(cmd) && !isGlob(t) && aboveDrive(abs)) return 'the command removes a folder that holds the API drive\'s usage log';
    }
    if (SCRIPT_CMD.test(cmd) && /api-drive(\.json|\/|\b)/.test(seg.toLowerCase())) return 'the command runs a script that names the API drive\'s caps or usage log';
  }
  return null;
}

const FILE_TOOLS_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_NAME = /write|replace|edit|create|delete|remove|move|rename|save|patch|mkdir|copy|trash|unlink/i;
const REMOVE_NAME = /delete|remove|move|rename|trash|unlink/i;
const SEARCH_NAME = /list|search|find|grep|glob|tree|archive|zip|tar|walk|scan|index/i;
export function keyGuard({ tool, input, cwd, paths = [] } = {}) {
  const ti = input && typeof input === 'object' ? input : {};
  const name = String(tool || '');
  const base = path.resolve(expandHome(cwd || os.homedir()));
  if (name === 'Bash') {
    const r = bashGuard(ti.command, base);
    if (!r) return null;
    return /API drive/.test(r) ? r + '; only the owner changes them, in the W panel or by hand.' : r + '. The AI never reads the keys; ask the other model with wk-ask.';
  }
  const given = [...new Set([ti.file_path, ti.path, ti.notebook_path, ...paths].filter(v => typeof v === 'string' && v))];
  const abs = given.map(p => resolveIn(base, p));
  const why = s => s + '. The AI never reads the keys; ask the other model with wk-ask.';
  for (const a of abs) if (insideKeys(a)) return why('the call touches the API key folder');
  const isSearch = ['Grep', 'LS', 'Glob'].includes(name) || (!['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) && SEARCH_NAME.test(name));
  const root = resolveIn(base, typeof ti.path === 'string' && ti.path ? ti.path : '.');
  if (name === 'Glob') {
    const pat = typeof ti.pattern === 'string' ? ti.pattern : '';
    if (pat && reach(resolveIn(root, pat)) === 'in') return why('the pattern reaches the API key folder');
  } else if (isSearch) {
    if (aboveKeys(root)) return why('the call searches or lists a folder that holds the API key folder');
    if (typeof ti.pattern === 'string' && isGlob(ti.pattern) && /^[~\/$]/.test(ti.pattern) && reach(resolveIn(root, ti.pattern)) === 'in') return why('the pattern reaches the API key folder');
  }
  if (FILE_TOOLS_WRITE.has(name) || (!['Read', 'Grep', 'LS', 'Glob'].includes(name) && WRITE_NAME.test(name))) {
    for (const a of abs) {
      if (isDriveFile(a)) return 'the call changes the API drive\'s caps or usage log (~/.wk/api-drive.json, ~/.wk/api-drive/); only the owner changes them, in the W panel or by hand';
      if (REMOVE_NAME.test(name) && aboveDrive(a)) return 'the call removes a folder that holds the API drive\'s usage log; only the owner does that';
    }
  }
  return null;
}
