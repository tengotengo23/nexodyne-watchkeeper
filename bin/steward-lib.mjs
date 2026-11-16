// Watchkeeper steward library (P2-187). No dependencies.
// The steward is a small planner. A few times a day it wakes up, visits ONE project, asks a cheap model for a few small ideas,
// checks every idea in code, files them in an inbox for the owner, and tunes itself by one small step. v1 never edits a project.
// State lives in WK_STEWARD_DIR (default ~/.wk/steward). Order of every visit: policy, kill switch, lock, recovery, backoff, caps,
// owner activity, project, privacy scan, meter and pace, call, validation. Any doubt means hold; the steward never guesses.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawn, spawnSync } from 'node:child_process';
import { scanPII, gates, killOn, killFile, homeWk, readJSON, root } from './lib.mjs';
import { isLegal } from './model-pick.mjs';

export const HOUR = 36e5, DAY = 864e5, WEEK = 7 * DAY;
export const KINDS = ['code', 'design', 'content', 'research', 'admin', 'outreach', 'money'];
const COUNTED = new Set(['ok', 'recovered', 'invalid']);                       // outcomes that count as a visit for fairness and tuning
const HELD_CODE = { policy: 2, kill: 2, pii: 2, auth: 2, lock: 3, backoff: 3, gap: 3, cap: 3, owner: 3, pace: 3, no_project: 3 };
const RANK = { auto: 0, ask: 1, wait: 2 };
export class StewardError extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }

// ---------------------------------------------------------------- small helpers
export const nowMs = () => { const v = Date.parse(process.env.WK_NOW || ''); return Number.isFinite(v) ? v : Date.now(); };
export const iso = ms => new Date(ms).toISOString();
export const stewardDir = () => process.env.WK_STEWARD_DIR || path.join(homeWk(), 'steward');
const sp = (...p) => path.join(stewardDir(), ...p);
const ensure = d => { fs.mkdirSync(d, { recursive: true }); return d; };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const round = (v, n = 3) => Number.isFinite(v) ? +v.toFixed(n) : null;
const pct = v => Number.isFinite(v) ? Math.round(v * 100) + '%' : '?';
const expandHome = p => p.replace(/^~(?=\/|$)/, os.homedir());
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// tokens, as measured in P2-191 (10 Nov 2026): about 2.5 bytes of English, code or markdown per token (not 4 characters); Georgian about
// 0.8 and Chinese about 1 token a letter. UTF-8 bytes / 2.5 fits English and over-counts those scripts (3 bytes a letter): the safe side.
export const estTokens = s => Math.ceil(Buffer.byteLength(String(s ?? ''), 'utf8') / 2.5);
const clampInt = (v, lo, hi, d) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v)) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
export function writeAtomic(file, text) { ensure(path.dirname(file)); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function readStrict(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw new StewardError(`${p} cannot be read as JSON (${String(e.message).slice(0, 80)})`, 1); } }
// text that came from a file, a commit or the model: one line, no control characters, no angle brackets or backticks (they could break the <facts> wrapper)
export const tidy = (s, n) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export function clipWords(s, n) { s = tidy(s, 100000); if (s.length <= n) return s; const cut = s.slice(0, n + 1).replace(/\s+\S*$/, ''); return (cut && cut.length <= n ? cut : s.slice(0, n)).trim(); }
const wordsOf = s => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
export function jaccard(a, b) { const A = new Set(wordsOf(a)), B = new Set(wordsOf(b)); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i); }
const tryParse = s => { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } };
// one check for any outside text that could reach the model or the state files: the policy's private-data rules (lane.pii) and its
// secret shapes (secretPatterns: API keys, tokens, private keys). Returns the hit ids; 'secret' stands for any secret shape.
// the redaction marker (see redactRaw) always counts, whatever the policy holds, so a replayed redacted idea is always dropped
export function secretHits(text) { const t = String(text ?? ''), hits = scanPII(t); if (t.includes(REDACTED) || gates().secretPatterns.some(s => new RegExp(s).test(t))) hits.push('secret'); return hits; }
const isSafe = (...xs) => xs.every(x => !secretHits(x).length);
// what raw/<tick>.json keeps of a model answer: every string secretHits flags becomes a marker that secretHits flags too,
// so a replay through recoverUnfinished drops that idea as pii, exactly like the live path
const REDACTED = 'redacted WK-PRIVATE-CANARY text';
export function redactRaw(res) {
  const walk = v => typeof v === 'string' ? (secretHits(v).length ? REDACTED : v) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const text = String(res.result ?? ''), parsed = tryParse(text);
  return { ...res, result: (isObj(parsed) || Array.isArray(parsed)) ? JSON.stringify(walk(parsed)) : walk(text), structured_output: walk(res.structured_output ?? null) };
}

// ---------------------------------------------------------------- config (plugin defaults + the owner's overrides, type-checked)
export function mergeConfig(base, own, warn = [], pre = '') {
  const out = { ...base };
  for (const [k, v] of Object.entries(isObj(own) ? own : {})) {
    if (k === '_comment') continue;
    if (!Object.hasOwn(base, k)) { warn.push(`${pre}${k}: unknown, ignored`); continue; }
    if (kindOf(base[k]) !== kindOf(v)) { warn.push(`${pre}${k}: wrong type, ignored`); continue; }
    out[k] = kindOf(v) === 'object' ? mergeConfig(base[k], v, warn, `${pre}${k}.`) : v;
  }
  return out;
}
export function validateConfig(c) {
  const bad = [], num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi, int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const strs = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length < 80), chk = (ok, name) => { if (!ok) bad.push(name); };
  chk(['login', 'api'].includes(c.mode), 'mode');
  // S6 (P2-187 review): an anchor without Z or an offset would be read in local time, so the week would move with the machine's zone
  chk(typeof c.week.anchor === 'string' && Number.isFinite(Date.parse(c.week.anchor)) && /(Z|[+-]\d\d:\d\d)$/.test(c.week.anchor), 'week.anchor'); chk(num(c.week.weeklyUsd, 0.01, 1e6), 'week.weeklyUsd');
  const k = c.call;
  for (const m of ['model', 'probeModel']) chk(typeof k[m] === 'string' && /^[\w.\-[\]]{1,60}$/.test(k[m]), 'call.' + m);
  chk(['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(k.effort), 'call.effort'); chk(num(k.capUsd, 0.001, 1), 'call.capUsd'); chk(num(k.probeCapUsd, 0.001, 0.5), 'call.probeCapUsd');
  chk(int(k.timeoutMs, 200, 1800000), 'call.timeoutMs'); chk(int(k.maxPerDay, 1, 48), 'call.maxPerDay'); chk(int(k.minGapMin, 0, 1440), 'call.minGapMin'); chk(int(k.lockMaxMin, 1, 720), 'call.lockMaxMin');
  // a visit lasts at most the call, the meter check (120 s) and a minute for git and the rest: the lock must outlive it
  if (int(k.lockMaxMin, 1, 720) && int(k.timeoutMs, 200, 1800000)) chk(k.lockMaxMin * 60000 > k.timeoutMs + 120000 + 60000, 'call.lockMaxMin (must be longer than call.timeoutMs plus 3 min)');
  const p = c.pace;
  chk(num(p.ceiling, 0.1, 1), 'pace.ceiling'); chk(num(p.landTo, 0.1, 1), 'pace.landTo'); chk(num(p.lastHours, 0, 48), 'pace.lastHours'); chk(num(p.aheadSlack, 0, 0.5), 'pace.aheadSlack');
  chk(num(p.meterMaxAgeH, 0.1, 168), 'pace.meterMaxAgeH'); chk(num(p.meterFreshMin, 0, 1440), 'pace.meterFreshMin'); chk(num(p.ownerActiveMin, 0, 1440), 'pace.ownerActiveMin');
  chk(int(p.unknownMaxCallsPerDay, 0, 48), 'pace.unknownMaxCallsPerDay'); chk(num(p.fiveHourHold, 0.1, 1), 'pace.fiveHourHold');
  chk(isObj(p.ramp) && Object.values(p.ramp).every(v => num(v, 0.01, 1)) && Object.hasOwn(p.ramp, p.phase), 'pace.phase');
  chk(int(c.rotation.window, 3, 1000), 'rotation.window');
  chk(int(c.inbox.perProject, 1, 100), 'inbox.perProject'); chk(int(c.inbox.total, 1, 500), 'inbox.total'); chk(int(c.inbox.autoMax, 1, 5000), 'inbox.autoMax');
  chk(num(c.dedupe.jaccard, 0.3, 1), 'dedupe.jaccard');
  for (const [n, lo, hi] of [['titleMax', 20, 200], ['whyMax', 40, 600], ['askMax', 40, 400], ['qaMax', 0, 5], ['briefMaxTokens', 600, 8000]]) chk(int(c.limits[n], lo, hi), 'limits.' + n);
  const G = c.gates; for (const n of ['waitKinds', 'askKinds', 'autoKinds', 'waitWords']) chk(strs(G[n]), 'gates.' + n); chk(int(G.askImpact, 1, 5), 'gates.askImpact');
  chk(isObj(c.lenses) && Object.keys(c.lenses).length >= 3 && Object.values(c.lenses).every(v => typeof v === 'string' && v.length < 200) && !Object.hasOwn(c.lenses, 'wildcard'), 'lenses');
  const T = c.tuning;
  chk(num(T.minHoursBetweenChanges, 0, 720), 'tuning.minHoursBetweenChanges'); chk(num(T.noise, 0, 1), 'tuning.noise'); chk(int(T.window, 3, 200), 'tuning.window'); chk(num(T.cooldownDays, 0, 90), 'tuning.cooldownDays');
  chk(int(T.evalSamples.ticks, 1, 100) && int(T.evalSamples.answers, 1, 100), 'tuning.evalSamples');
  for (const n of ['ideasPerCall', 'minImpact', 'pastIdeasInBrief', 'wildcardEvery']) { const s = T.knobs[n]; chk(isObj(s) && [s.min, s.max, s.step, s.default].every(Number.isInteger) && s.min >= 1 && s.step >= 1 && s.min <= s.default && s.default <= s.max, 'tuning.knobs.' + n); }
  if (bad.length) throw new StewardError('steward config is invalid: ' + bad.join(', '), 1);
}
export const userConfigFile = () => process.env.WK_STEWARD_CONFIG || path.join(homeWk(), 'steward.json');
// the owner's file, read the same way by loadConfig and setPhase: missing or null is empty; anything else that is not a JSON object
// ([], text, a number, true or false) is refused, never silently ignored
function readOwnerConfig() {
  const f = userConfigFile(), own = readStrict(f);
  if (own === undefined || own === null) return {};
  if (!isObj(own)) throw new StewardError(`${f} is not a JSON object`, 1);
  return own;
}
export function loadConfig() {
  const base = readStrict(path.join(root(), 'config/steward.json'));
  if (!isObj(base)) throw new StewardError('config/steward.json is missing from the plugin folder', 1);
  const warn = [], cfg = mergeConfig(base, readOwnerConfig(), warn);
  validateConfig(cfg); cfg._warnings = warn; return cfg;
}

// ---------------------------------------------------------------- projects (the owner's list; nothing private belongs in it)
export const projectsFile = () => process.env.WK_PROJECTS || path.join(homeWk(), 'projects.json');
export function loadProjects() {
  const raw = readStrict(projectsFile()), problems = [];
  if (raw === undefined) return { projects: [], problems: [`no projects file yet: run wk-steward init (${projectsFile()})`], missing: true };
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : null;
  if (!list) return { projects: [], problems: ['the projects file has no "projects" list'], missing: true };
  const seen = new Set(), projects = [];
  for (const p of list) {
    if (!isObj(p) || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(p.id)) { problems.push('a project has a missing or bad id (use a-z, 0-9 and -)'); continue; }
    if (seen.has(p.id)) { problems.push(`${p.id}: duplicate id`); continue; } seen.add(p.id);
    if (typeof p.path !== 'string' || !p.path.trim()) { problems.push(`${p.id}: no path`); continue; }
    projects.push({ id: p.id, name: tidy(p.name, 60) || p.id, kind: tidy(p.kind, 20) || 'project', path: path.resolve(expandHome(p.path.trim())), weight: clampInt(p.weight, 1, 10, 1),
      goal: tidy(p.goal, 300), audience: tidy(p.audience, 200), number: tidy(p.number, 200), notes: tidy(p.notes, 400), paused: p.paused === true });
  }
  projects.sort((a, b) => a.id < b.id ? -1 : 1);
  return { projects, problems };
}

// ---------------------------------------------------------------- ledger (same row format as wk-ledger.mjs)
export const ledgerFile = () => process.env.WK_LEDGER || path.join(homeWk(), 'ledger.jsonl');
export function ledgerRows() { let t; try { t = fs.readFileSync(ledgerFile(), 'utf8'); } catch { return []; } const out = []; for (const l of t.split('\n')) { try { const r = JSON.parse(l); if (r && typeof r.at === 'string') out.push(r); } catch {} } return out; }
// the CLI can add small calls of its own (seen 10 Nov 2026: a Haiku side call next to the Sonnet answer), so a row names the costliest model
export const mainModel = mu => { const e = isObj(mu) ? Object.entries(mu).filter(([, v]) => isObj(v)) : []; return e.length ? e.reduce((a, b) => ((+b[1].costUSD || 0) > (+a[1].costUSD || 0) ? b : a))[0] : null; };
export function ledgerAdd(item, res) {
  const u = res.usage || {}, row = { at: iso(nowMs()), item, model: mainModel(res.modelUsage), cost_usd: Number.isFinite(res.total_cost_usd) ? res.total_cost_usd : null, turns: res.num_turns ?? null,
    in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cache_read: u.cache_read_input_tokens ?? null, out: u.output_tokens ?? null, error: !!res.is_error, p80_estimate: null };
  ensure(path.dirname(ledgerFile())); fs.appendFileSync(ledgerFile(), JSON.stringify(row) + '\n'); return row;
}
// a call stopped before its result (timeout, kill switch): the cost is unknown (null, as wk-ledger.mjs readers expect) and error is true;
// estimate_usd (the call's cap) is an extra field that only the steward's ledger pacing reads
export function ledgerAddUnknown(item, estimate) {
  const row = { at: iso(nowMs()), item, model: null, cost_usd: null, turns: null, in: null, cache_read: null, out: null, error: true, p80_estimate: null, estimate_usd: estimate };
  ensure(path.dirname(ledgerFile())); fs.appendFileSync(ledgerFile(), JSON.stringify(row) + '\n'); return row;
}
const rowSpend = r => Number.isFinite(r.cost_usd) ? r.cost_usd : r.cost_usd === null && r.error === true && Number.isFinite(r.estimate_usd) ? r.estimate_usd : 0;
export const ledgerSpend = (from, to) => ledgerRows().reduce((s, r) => { const t = Date.parse(r.at); return t >= from && t < to ? s + rowSpend(r) : s; }, 0);

// ---------------------------------------------------------------- the weekly meter (read from the rate_limit_event of any headless call)
export const meterFile = () => sp('meter.json');
const norm = u => (u > 1.5 ? u / 100 : u);
function windowsOf(ev) {
  const i = ev?.rate_limit_info, out = {}; if (!isObj(i)) return out;
  // only a number or a numeric string is a reading: Number(null), Number(''), Number([]) and Number(false) are 0, which would read as "nothing used"
  const num = v => typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  const put = (k, w) => { if (!isObj(w)) return; const u = num(w.utilization); if (Number.isFinite(u) && u >= 0) out[k] = { utilization: norm(u), resetsAt: Number.isFinite(+w.resetsAt) ? +w.resetsAt : null, status: typeof w.status === 'string' ? w.status : null }; };
  // S5 (P2-187 review): every seven_day* window (seven_day, seven_day_sonnet, seven_day_opus ...) is a weekly reading
  const weekly = k => typeof k === 'string' && /^seven_day(_[a-z0-9_]+)?$/.test(k);
  if (weekly(i.rateLimitType) || i.rateLimitType === 'five_hour') put(i.rateLimitType, i);
  if (isObj(i.unifiedWindows)) for (const k of Object.keys(i.unifiedWindows)) if (weekly(k) || k === 'five_hour') put(k, i.unifiedWindows[k]);
  return out;
}
export function meterFromEvents(events, now, source) {
  const w = {}; for (const e of events) Object.assign(w, windowsOf(e));
  // pace on the highest weekly window; on a tie the plain seven_day wins
  let top = null; for (const [k, v] of Object.entries(w)) if (k.startsWith('seven_day') && (!top || v.utilization > w[top].utilization || (v.utilization === w[top].utilization && k === 'seven_day'))) top = k;
  if (!top && !w.five_hour) return null;
  const t = top ? w[top] : null;
  return { fetchedAt: iso(now), utilization: t ? t.utilization : null, resetsAt: t ? t.resetsAt : null, status: t ? t.status : null, fiveHour: w.five_hour || null, source };
}
// the five-hour reading stands on its own: it counts while its own window has not ended and the reading is not older than maxAgeMs
export function fiveHourOf(m, now, maxAgeMs) {
  const f = isObj(m) ? m.fiveHour : null; if (!isObj(f) || !Number.isFinite(f.utilization)) return null;
  const age = now - Date.parse(m.fetchedAt); if (!(age > -60000) || age > maxAgeMs) return null;
  if (Number.isFinite(f.resetsAt) ? f.resetsAt * 1000 <= now : age > 5 * HOUR) return null;
  return f.utilization;
}
// a reading is usable when it has a weekly value, is not older than maxAgeMs and does not belong to a week that has already ended
export function meterOk(m, now, maxAgeMs) {
  if (!isObj(m) || !Number.isFinite(m.utilization)) return false;
  const age = now - Date.parse(m.fetchedAt); if (!(age > -60000) || age > maxAgeMs) return false;
  return !(Number.isFinite(m.resetsAt) && m.resetsAt * 1000 <= now);
}

// ---------------------------------------------------------------- the week and the pace
export function weekWindow(cfg, now, meter) {
  let end;
  if (isObj(meter) && Number.isFinite(meter.resetsAt) && meter.resetsAt * 1000 > now - 8 * WEEK) { end = meter.resetsAt * 1000; while (end <= now) end += WEEK; while (end - WEEK > now) end -= WEEK; }
  else { const a = Date.parse(cfg.week.anchor); end = a + Math.ceil((now - a) / WEEK) * WEEK; if (end <= now) end += WEEK; }
  const start = end - WEEK; return { start, end, elapsed: (now - start) / WEEK, hoursLeft: (end - now) / HOUR };
}
export function usageFrom(cfg, now, meter) {
  const win = weekWindow(cfg, now, meter);
  const five = cfg.mode === 'login' ? fiveHourOf(meter, now, cfg.pace.meterMaxAgeH * HOUR) : null;   // S5: the five-hour reading counts even when the weekly value is missing
  if (cfg.mode === 'login' && meterOk(meter, now, cfg.pace.meterMaxAgeH * HOUR)) return { source: 'meter', used: meter.utilization, fiveHour: five, win, meterAgeMin: (now - Date.parse(meter.fetchedAt)) / 60000 };
  return { source: 'ledger', used: ledgerSpend(win.start, win.end) / cfg.week.weeklyUsd, fiveHour: five, win, meterAgeMin: null };
}
// The one pace reading of the company (P2-178): what `wk-ledger pace` and the weekly report print. It reuses the functions above, with no arithmetic of its own.
// Only a usable weekly meter paces; anything else is a hold that says "re-probe". It never falls back to the dollar budget.
export function paceReading(cfg, now, meter) {
  const maxMs = cfg.pace.meterMaxAgeH * HOUR, p = cfg.pace;
  if (!meterOk(meter, now, maxMs)) {
    const why = !isObj(meter) ? 'no meter reading' : !Number.isFinite(meter.utilization) ? 'the meter has no weekly value' : Number.isFinite(meter.resetsAt) && meter.resetsAt * 1000 <= now ? 'the meter belongs to a week that has ended' : `the meter reading is ${round((now - Date.parse(meter.fetchedAt)) / HOUR, 1)} h old (limit ${p.meterMaxAgeH} h)`;
    return { decision: 'hold', reason: 'meter', detail: why, reprobe: true, code: 3 };
  }
  const win = weekWindow(cfg, now, meter), five = fiveHourOf(meter, now, maxMs), d = paceDecision({ cfg, win, used: meter.utilization, fiveHour: five });
  const releaseAt = win.end - p.lastHours * HOUR, ageMin = round((now - Date.parse(meter.fetchedAt)) / 60000, 1);
  let decision = 'run', reason = null;
  if (!d.go) { decision = 'hold'; reason = d.reason; }
  else if (meter.utilization > win.elapsed) { decision = 'slow'; reason = 'ahead'; }
  else if (Number.isFinite(five) && five >= 0.75) { decision = 'slow'; reason = 'five_hour'; }
  return { decision, reason, reprobe: false, code: decision === 'hold' ? 3 : 0, used: d.used, elapsed: d.elapsed, target: d.elapsed, behindPoints: round((win.elapsed - meter.utilization) * 100, 1), limit: d.limit, fiveHour: five,
    reservePoints: round((1 - p.ceiling) * 100, 1), reserveHeld: !d.lastStretch, reserveReleaseAt: iso(releaseAt), hoursLeft: d.hoursLeft, resetsAt: iso(win.end), meterAgeMin: ageMin };
}
export function paceDecision({ cfg, win, used, fiveHour }) {
  const p = cfg.pace, last = win.hoursLeft <= p.lastHours, limit = last ? p.landTo : p.ceiling; let reason = null;
  if (used >= limit) reason = last ? 'landed' : 'ceiling';
  else if (used > win.elapsed + p.aheadSlack) reason = 'ahead';
  else if (Number.isFinite(fiveHour) && fiveHour >= p.fiveHourHold) reason = 'five_hour';
  return { go: !reason, reason, used: round(used), elapsed: round(win.elapsed), limit, headroom: round(Math.max(0, limit - used)), behind: round(win.elapsed - used), lastStretch: last, hoursLeft: round(win.hoursLeft, 1) };
}
// the owner's own Claude sessions leave transcripts; any written in the last few minutes means "the owner is working": hold
export function ownerActive(cfg, now) {
  const dir = path.join(process.env.WK_CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'projects'); let newest = 0, n = 0;
  try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { if (!d.isDirectory()) continue; let fl = []; try { fl = fs.readdirSync(path.join(dir, d.name)); } catch {} for (const f of fl) { if (!f.endsWith('.jsonl') || ++n > 20000) continue; try { const m = fs.statSync(path.join(dir, d.name, f)).mtimeMs; if (m > newest) newest = m; } catch {} } } } catch {}
  const ageMin = newest ? (now - newest) / 60000 : null; return { active: ageMin !== null && ageMin < cfg.pace.ownerActiveMin, ageMin };
}

// ---------------------------------------------------------------- events (append-only) and the state derived from them
const evFile = () => sp('events.jsonl');
export function readEvents() { let t; try { t = fs.readFileSync(evFile(), 'utf8'); } catch { return []; } const out = []; for (const l of t.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (isObj(e)) out.push(e); } catch {} } return out; }
// a write cut short (disk full, power loss) can leave a last line without its newline: start on a new line, so only the torn line is lost
const endsTorn = f => { let fd; try { fd = fs.openSync(f, 'r'); const n = fs.fstatSync(fd).size; if (!n) return false; const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, n - 1); return b[0] !== 10; } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} } };
export function appendEvent(e, now = nowMs()) { ensure(stewardDir()); const f = evFile(); fs.appendFileSync(f, (endsTorn(f) ? '\n' : '') + JSON.stringify({ at: iso(now), ...e }) + '\n'); }
export function derive(events) {
  const d = { ideas: new Map(), assumptions: [], started: new Map(), finishedIds: new Set(), finished: [], counted: [], held: [], nextIdea: 1, nextAssumption: 1, lastStart: 0 };
  for (const e of events) {
    if (e.type === 'tick_started') { d.started.set(e.tick, e); d.lastStart = Math.max(d.lastStart, Date.parse(e.at) || 0); }
    else if (e.type === 'tick_finished') { d.finishedIds.add(e.tick); d.finished.push(e); if (COUNTED.has(e.outcome)) d.counted.push(e); }
    else if (e.type === 'tick_held') d.held.push(e);
    else if (e.type === 'idea_added' && typeof e.id === 'string') { d.ideas.set(e.id, { ...e, status: 'open' }); d.nextIdea = Math.max(d.nextIdea, (+e.id.slice(1) || 0) + 1); }
    else if (e.type === 'idea_answered') { const i = d.ideas.get(e.id); if (i) { i.status = e.answer; i.answeredAt = e.at; i.note = e.note; } }
    else if (e.type === 'assumption') { d.assumptions.push(e); d.nextAssumption = Math.max(d.nextAssumption, (+String(e.id).slice(1) || 0) + 1); }
  }
  d.unfinished = [...d.started.values()].filter(e => !d.finishedIds.has(e.tick));
  // from the highest tick number seen (as nextIdea), never from counts: a lost line must not make an id come back
  let top = 0; for (const e of events) if (/^tick_(started|finished|held)$/.test(e.type) && /^t\d+$/.test(String(e.tick))) top = Math.max(top, +String(e.tick).slice(1));
  d.nextTick = 't' + String(top + 1).padStart(6, '0');
  return d;
}
const seqOf = i => +String(i.id).slice(1) || 0;

// ---------------------------------------------------------------- which project, which lens
export function eligibleProjects(projects, st, now) {
  const list = [], skipped = [];
  for (const p of projects) {
    let why = null;
    if (p.paused) why = 'paused'; else if (!isDir(p.path)) why = 'folder missing';
    else if (st.held.some(h => h.project === p.id && h.reason === 'pii' && now - Date.parse(h.at) < DAY)) why = 'blocked 24 h: the brief held private data';
    else { let n = 0; for (let i = st.finished.length - 1; i >= 0; i--) { const e = st.finished[i]; if (e.project !== p.id) continue; if (e.outcome === 'error') n++; else break; } const lastErr = st.finished.filter(e => e.project === p.id).pop(); if (n >= 2 && lastErr && now - Date.parse(lastErr.at) < 6 * HOUR) why = 'two errors in a row, waits 6 h'; }
    (why ? skipped.push({ id: p.id, why }) : list.push(p));
  }
  return { list, skipped };
}
// deficit rule: each project's fair share of the last `window` counted visits minus the visits it got; ties go to the longest-waiting, then id order
export function pickProject(list, st, cfg) {
  const win = st.counted.slice(-cfg.rotation.window), total = list.reduce((s, p) => s + p.weight, 0), cnt = new Map(), last = new Map(); let best = null;
  for (const e of win) cnt.set(e.project, (cnt.get(e.project) || 0) + 1);
  for (const e of st.counted) last.set(e.project, Date.parse(e.at) || 0);
  for (const p of list) {
    const deficit = p.weight / total * (win.length + 1) - (cnt.get(p.id) || 0), lv = last.has(p.id) ? last.get(p.id) : -Infinity;
    if (!best || deficit > best.deficit + 1e-9 || (Math.abs(deficit - best.deficit) <= 1e-9 && lv < best.lv)) best = { p, deficit, lv };
  }
  return best.p;
}
export function pickLens(cfg, st, project, knobs) {
  const mine = st.counted.filter(e => e.project === project.id), keys = Object.keys(cfg.lenses), used = new Map();
  mine.forEach((e, i) => { if (e.lens && e.lens !== 'wildcard') used.set(e.lens, i); });
  const order = keys.slice().sort((a, b) => (used.has(a) ? used.get(a) : -1) - (used.has(b) ? used.get(b) : -1) || keys.indexOf(a) - keys.indexOf(b));
  const recent = []; for (let i = mine.length - 1; i >= 0 && recent.length < 3; i--) if (mine[i].lens && mine[i].lens !== 'wildcard' && !recent.includes(mine[i].lens)) recent.push(mine[i].lens);
  return (mine.length + 1) % knobs.wildcardEvery === 0 ? { lens: 'wildcard', wild: true, avoid: recent } : { lens: order[0], wild: false, avoid: [] };
}

// ---------------------------------------------------------------- facts about a project (free tools only; no model, no network)
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'venv', 'Pods', 'DerivedData', 'target', '__pycache__']);
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'html', 'css', 'scss', 'md', 'sh', 'sql', 'vue', 'svelte']);
const WALK_MAX = 4000;
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0 ? r.stdout : null;
}
function walk(top) {
  const files = [], stack = [[top, 0]];
  while (stack.length && files.length < WALK_MAX) {
    const [dir, depth] = stack.pop(); let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => a.name < b.name ? -1 : 1);
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (depth < 6 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) stack.push([path.join(dir, e.name), depth + 1]); }
      else if (e.isFile()) { files.push(path.join(dir, e.name)); if (files.length >= WALK_MAX) break; }
    }
  }
  return files;
}
// every string that came from outside is scanned on its own and dropped on a hit; times are relative ("3 days ago"), never dates
// a marker counts only where a person left one (at most one a line): right after a comment opener (// # /* <!--, or * -- ; that begin a
// line) or at the start of a line (text and markdown lists, "- [ ] ..."); code, strings and prose that only name the words do not count
const MARKER = /(?:^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s*)?|(?:\/\/+|\/\*+|<!--|#+)\s*|^\s*(?:\*+|--+|;+)\s*)@?(?:TODO|FIXME|XXX|HACK)\b/;
export function collectFacts(project, now) {
  const dir = project.path, lines = [], clean = s => { const t = tidy(s, 120); return t && isSafe(s, t) ? t : null; };
  if ((git(dir, ['rev-parse', '--is-inside-work-tree']) || '').trim() === 'true') {
    const b = (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim(), branch = /^[\w./-]{1,60}$/.test(b) && isSafe(b) ? b : 'unknown';
    const ct = parseInt((git(dir, ['log', '-1', '--format=%ct']) || '').trim(), 10), days = Number.isFinite(ct) ? Math.max(0, Math.floor((now / 1000 - ct) / 86400)) : null;
    const stat = git(dir, ['status', '--porcelain']), dirty = stat === null ? null : stat.split('\n').filter(Boolean).length;   // null: git failed or took over 5 s
    lines.push(`git: branch ${branch}; last commit ${days === null ? 'unknown' : days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago'}; ${dirty === null ? 'uncommitted files unknown' : `${dirty} uncommitted file${dirty === 1 ? '' : 's'}`}`);
    const subs = (git(dir, ['log', '-5', '--format=%s']) || '').split('\n').filter(s => isSafe(s)).map(s => tidy(s, 80)).filter(s => s && isSafe(s));   // checked whole, before the cut
    if (subs.length) lines.push('recent commits: ' + subs.map(s => `"${s}"`).join('; '));
  } else lines.push('git: not a repository');
  const files = walk(dir), ext = new Map(), rel = files.map(f => path.relative(dir, f));
  for (const f of files) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(f), k = m ? m[1].toLowerCase() : 'none'; ext.set(k, (ext.get(k) || 0) + 1); }
  lines.push(`files: ${files.length}${files.length >= WALK_MAX ? '+ (count stopped)' : ''} (${[...ext].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`);
  let read = 0, total = 0; const per = [];
  for (const f of files) {
    const m = /\.([A-Za-z0-9]+)$/.exec(f); if (!m || !TEXT_EXT.has(m[1].toLowerCase())) continue; if (read >= 4e6) break;
    let size; try { size = fs.statSync(f).size; } catch { continue; } if (size > 65536) continue;
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; } read += size;
    let n = 0; for (const l of t.split('\n')) if (MARKER.test(l)) n++; if (n) { total += n; per.push([path.relative(dir, f), n]); }
  }
  per.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const names = per.slice(0, 3).map(([n, c]) => [clean(n), c]).filter(x => x[0]).map(([n, c]) => `${n} ${c}`);
  lines.push(`TODO/FIXME markers: ${total}${names.length ? ' (' + names.join(', ') + ')' : ''}`);
  const pkg = readJSON(path.join(dir, 'package.json'), null), sc = isObj(pkg?.scripts) ? Object.keys(pkg.scripts).filter(k => /^[\w:.-]{1,24}$/.test(k) && isSafe(k)).slice(0, 8) : [];
  if (sc.length) lines.push('npm scripts: ' + sc.join(', '));
  let top = []; try { top = fs.readdirSync(dir); } catch {}
  const has = n => top.some(x => x.toLowerCase().startsWith(n)), flags = [['README', has('readme')], ['tests', rel.some(r => /(^|\/)(tests?|__tests__|spec)\//i.test(r) || /\.(test|spec)\.[a-z]+$/i.test(r))],
    ['CI', isDir(path.join(dir, '.github/workflows')) || has('.gitlab-ci')], ['LICENSE', has('license') || has('copying')], ['CHANGELOG', has('changelog')]];
  lines.push('has: ' + (flags.filter(f => f[1]).map(f => f[0]).join(', ') || 'nothing from the list') + '; missing: ' + (flags.filter(f => !f[1]).map(f => f[0]).join(', ') || 'nothing from the list'));
  return lines.map(l => l.replace(/[<>]/g, ' '));
}

// ---------------------------------------------------------------- the brief (the only thing about a project that ever reaches the model)
export function buildBrief({ project, lens, wild, avoid, cfg, knobs, facts, st }) {
  const mine = [...st.ideas.values()].filter(i => i.project === project.id).sort((a, b) => seqOf(a) - seqOf(b)), assumed = st.assumptions.filter(a => a.project === project.id).slice(-3);
  const openAsk = mine.filter(i => i.status === 'open' && i.gate !== 'auto').length;
  const build = (nPast, withFacts) => {
    const L = [`PROJECT: ${project.name} (${project.kind})`, `GOAL: ${project.goal || 'not set'}`, `AUDIENCE: ${project.audience || 'not set'}`, `NUMBER THAT MATTERS: ${project.number || 'not set'}`];
    if (project.notes) L.push(`OWNER NOTES: ${project.notes}`);
    L.push(wild ? `LENS: wildcard. Pick your own angle${avoid.length ? ', not one of: ' + avoid.join(', ') : ''}.` : `LENS: ${lens}. ${cfg.lenses[lens]}`);
    L.push(`WANT: ${knobs.ideasPerCall} ideas, impact ${knobs.minImpact} or more.`, '<facts>', ...(withFacts ? facts : ['(left out to save space)']), '</facts>', 'PAST IDEAS (do not repeat):');
    const past = nPast > 0 ? mine.slice(-nPast) : [];
    if (past.length) for (const i of past) L.push(`- ${i.status === 'no' ? '[no] ' : i.status === 'yes' ? '[yes] ' : ''}${i.title}`); else L.push('- none yet');
    if (assumed.length) { L.push('ASSUMED EARLIER (not confirmed by the owner):'); for (const a of assumed) L.push(`- ${a.q} -> ${a.a}`); }
    L.push(openAsk >= cfg.inbox.perProject ? 'INBOX: full. Give only ideas with gate auto.' : `INBOX: ${openAsk} of ${cfg.inbox.perProject} questions open for this project.`);
    return L.join('\n');
  };
  // the budget is in tokens, not characters: a Georgian or Chinese project text costs more per letter than English
  const over = t => estTokens(t) > cfg.limits.briefMaxTokens;
  let n = knobs.pastIdeasInBrief, text = build(n, true);
  while (over(text) && n > 0) { n = Math.floor(n / 2); text = build(n, true); }
  if (over(text)) text = build(0, false);
  if (over(text)) throw new StewardError('the brief is too long even without facts: shorten the project text in projects.json', 1);
  return { text, pastShown: n, tokens: estTokens(text) };
}

// ---------------------------------------------------------------- the model call
export const IDEA_SCHEMA = { type: 'object', additionalProperties: false, required: ['ideas'], properties: {
  ideas: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['title', 'why', 'kind', 'impact', 'effort', 'gate'], properties: {
    title: { type: 'string' }, why: { type: 'string' }, kind: { type: 'string', enum: KINDS }, impact: { type: 'integer', minimum: 1, maximum: 5 }, effort: { type: 'integer', minimum: 1, maximum: 5 },
    gate: { type: 'string', enum: ['auto', 'ask', 'wait'] }, ask: { type: 'string' } } } },
  qa: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } } } };
const PROBE = 'Reply with the single word: ok';
export const claudeBin = () => process.env.WK_CLAUDE || 'claude';
export function apiKey() { if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) return process.env.ANTHROPIC_API_KEY.trim(); try { return fs.readFileSync(process.env.WK_API_KEY_FILE || path.join(os.homedir(), '.config/nexodyne/lane-api-key.txt'), 'utf8').trim() || null; } catch { return null; } }
// both modes strip, by a deny list (an allow list could break the macOS keychain login of the real CLI), every variable that could switch
// the call to another account, login, provider, proxy or model: any ANTHROPIC_* (base URL, key, token, custom headers, Foundry, model
// aliases such as ANTHROPIC_DEFAULT_SONNET_MODEL), any CLAUDE_CODE_USE_* (Bedrock, Vertex, Foundry), CLAUDE_CODE_OAUTH_* (another login),
// CLAUDE_CONFIG_DIR (another login folder) and the proxy variables in either case (in api mode the lane key must not travel to a proxy);
// api mode then adds the one key (never printed)
const CHILD_DENY = [/^ANTHROPIC_/, /^CLAUDE_CODE_USE_/, /^CLAUDE_CODE_OAUTH_/, /^CLAUDE_CONFIG_DIR$/, /^(HTTPS?|ALL|NO)_PROXY$/i];
export function childEnv(cfg) {
  // measured with real calls on 10 Nov 2026 (P2-187): the terminal-title switch stops a hidden Haiku side call on every visit (about 1,200
  // tokens); visits are hours apart with a new brief each time, so a prompt-cache write is pure overhead (one call: USD 0.0062 cached, 0.0034 not)
  const e = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', DISABLE_PROMPT_CACHING: '1', WK_STEWARD_CALL: '1' };
  const key = cfg.mode === 'login' ? null : apiKey();
  if (cfg.mode !== 'login' && !key) throw new StewardError('api mode needs ANTHROPIC_API_KEY or the key file ~/.config/nexodyne/lane-api-key.txt', 1);
  for (const k of Object.keys(e)) if (CHILD_DENY.some(r => r.test(k))) delete e[k];
  if (key) e.ANTHROPIC_API_KEY = key;
  return e;
}
// the verified shape (8 Nov): no tools, no settings from the user's folders, no MCP, no skills, no session file, a hard cost cap. Prompt first: --tools is variadic.
export function callArgs({ prompt, system, model, schema, cap, effort }) {
  const a = ['-p', prompt, '--model', model, '--system-prompt', system, '--output-format', 'stream-json', '--verbose'];
  if (schema) a.push('--json-schema', JSON.stringify(schema));
  a.push('--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-budget-usd', String(cap));
  if (effort) a.push('--effort', effort);
  return a;
}
const authGuard = cfg => o => { if (o.type === 'system' && o.subtype === 'init') { const src = o.apiKeySource; if (cfg.mode === 'login' ? src !== 'none' : src === 'none') return 'auth'; } return null; };
export function runClaude({ args, env, cwd, timeoutMs, killCheck, onEvent }) {
  return new Promise(resolve => {
    const events = []; let buf = '', err = '', size = 0, aborted = null, done = false, child;
    try { child = spawn(claudeBin(), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ events, spawnError: e.code || 'spawn', stderr: String(e.message) }); }
    const kill = why => { if (!aborted) aborted = why; try { child.kill('SIGKILL'); } catch {} setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 3000).unref(); };
    const timer = setTimeout(() => kill('timeout'), timeoutMs), poll = setInterval(() => { if (killCheck && killCheck()) kill('kill'); }, 500);
    const finish = r => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); resolve({ events, stderr: err, aborted, ...r }); };
    const line = l => { if (!l.trim()) return; let o; try { o = JSON.parse(l); } catch { return; } events.push(o); const a = onEvent && onEvent(o); if (a) kill(a); };
    child.stdout.on('data', d => { size += d.length; if (size > 25e6) return kill('output_too_big'); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', d => { if (err.length < 4000) err += d; });
    child.on('error', e => finish({ spawnError: e.code || 'spawn', stderr: String(e.message) }));
    child.on('close', (code, signal) => { if (buf.trim()) line(buf); finish({ code, signal }); });
  });
}
// kinds: ok | invalid | limit | error | refused | killed | timeout | spawn
export function classify(run, { needIdeas }) {
  let init = null, res = null; const rates = [];
  for (const e of run.events) { if (e.type === 'system' && e.subtype === 'init') init = e; else if (e.type === 'result') res = e; else if (e.type === 'rate_limit_event') rates.push(e); }
  const out = { res, rates, init, kind: 'ok', reason: null };
  if (run.spawnError) return { ...out, kind: 'spawn', reason: run.spawnError };
  if (run.aborted === 'auth') return { ...out, kind: 'refused', reason: 'auth_mode' };
  if (run.aborted === 'kill') return { ...out, kind: 'killed', reason: 'kill_switch' };
  if (run.aborted === 'timeout') return { ...out, kind: 'timeout', reason: 'timeout' };
  if (run.aborted) return { ...out, kind: 'error', reason: run.aborted };
  const failed = !res || res.is_error === true || (typeof res.subtype === 'string' && res.subtype !== 'success');
  if (failed) {
    const text = `${res?.result || ''} ${run.stderr || ''}`;
    if (res?.api_error_status === 429 || /usage limit|rate.?limit|limit reached|too many requests/i.test(text) || rates.some(r => r.rate_limit_info?.status === 'rejected')) return { ...out, kind: 'limit', reason: 'limit' };
    return { ...out, kind: 'error', reason: res ? String(res.subtype || 'error') : 'no_result' };
  }
  if (needIdeas) { const parsed = isObj(res.structured_output) ? res.structured_output : tryParse(res.result); if (!isObj(parsed) || !Array.isArray(parsed.ideas)) return { ...out, kind: 'invalid', reason: 'no_ideas' }; }
  return out;
}
const runDir = () => ensure(sp('run'));
async function probeMeter(cfg, g, now) {
  const run = await runClaude({ args: callArgs({ prompt: PROBE, system: PROBE, model: cfg.call.probeModel, cap: cfg.call.probeCapUsd }), env: childEnv(cfg), cwd: runDir(), timeoutMs: Math.min(cfg.call.timeoutMs, 120000), killCheck: () => killOn(g), onEvent: authGuard(cfg) });
  const c = classify(run, { needIdeas: false });
  if (c.res) ledgerAdd('steward:probe', c.res);
  const meter = meterFromEvents(c.rates, now, 'probe'); if (meter) writeAtomic(meterFile(), JSON.stringify(meter));
  return { ...c, meter };
}

// ---------------------------------------------------------------- checking what the model sent (every rule here is code, none is a request to the model)
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// gates.waitWords plus the one shared list of legal words (panel/src/legal-words.js): a legal idea always waits for the owner
export const waitRegexes = G => G.waitWords.map(w => new RegExp('\\b' + escRe(w.trim()) + (/\s$/.test(w) ? '\\b' : ''), 'i'))
  .concat({ test: t => isLegal(t) !== null });
export function finalGate(idea, G, waitRe) {
  const text = `${idea.title} ${idea.why} ${idea.ask || ''}`; let code = G.autoKinds.includes(idea.kind) ? 'auto' : 'ask';
  if (G.askKinds.includes(idea.kind)) code = 'ask';
  if (code === 'auto' && idea.impact >= G.askImpact) code = 'ask';
  if (G.waitKinds.includes(idea.kind) || waitRe.some(r => r.test(text))) code = 'wait';
  const model = typeof idea.gate === 'string' && Object.hasOwn(RANK, idea.gate) ? idea.gate : 'ask';
  return RANK[model] >= RANK[code] ? model : code;
}
export function validateIdeas(parsed, { cfg, want, minImpact, pastTitles }) {
  const L = cfg.limits, G = cfg.gates, dropped = {}, drop = r => { dropped[r] = (dropped[r] || 0) + 1; }, waitRe = waitRegexes(G);
  const list = Array.isArray(parsed?.ideas) ? parsed.ideas.slice(0, 12) : [], cand = [], out = { kept: [], dropped, qa: [], proposed: list.length };
  list.forEach((it, idx) => {
    if (!isObj(it)) return drop('shape');
    const title = tidy(it.title, 400), why = clipWords(it.why, L.whyMax), ask = clipWords(it.ask, L.askMax);
    if (wordsOf(title).length < 3 || title.length > L.titleMax) return drop('title');
    if (!KINDS.includes(it.kind)) return drop('kind');
    if (!Number.isInteger(it.impact) || it.impact < 1 || it.impact > 5 || !Number.isInteger(it.effort) || it.effort < 1 || it.effort > 5) return drop('range');
    if (it.impact < minImpact) return drop('low');
    if (/https?:\/\/|www\./i.test(`${title} ${why} ${ask}`)) return drop('url');
    if (!isSafe(title, why, ask, it.title, it.why, it.ask)) return drop('pii');   // also the text before the cut
    if ([...pastTitles, ...cand.map(c => c.title)].some(t => jaccard(t, title) >= cfg.dedupe.jaccard)) return drop('dupe');
    const idea = { title, why, kind: it.kind, impact: it.impact, effort: it.effort, ask, idx }; idea.gate = finalGate({ ...idea, gate: it.gate }, G, waitRe);
    if (idea.gate !== 'auto' && !idea.ask) idea.ask = 'Should I go ahead with this?';
    if (idea.gate === 'auto') idea.ask = '';
    cand.push(idea);
  });
  cand.sort((a, b) => b.impact - a.impact || a.effort - b.effort || a.idx - b.idx);
  out.kept = cand.slice(0, want); for (let i = want; i < cand.length; i++) drop('extra');
  for (const x of (Array.isArray(parsed?.qa) ? parsed.qa : []).slice(0, L.qaMax)) {
    if (!isObj(x)) continue; const q = tidy(x.q, 400), a = tidy(x.a, 600);
    if (!q || !a || q.length > 140 || a.length > 200 || !isSafe(q, a, x.q, x.a) || waitRe.some(r => r.test(`${q} ${a}`)) || /https?:\/\//i.test(q + a)) { drop('qa'); continue; }
    out.qa.push({ q, a });
  }
  return out;
}
// file what survived: ideas into the inbox (or the auto queue), assumptions, and the closing event. Used for a live call and for a recovered one.
export function ingest({ cfg, ctx, res, recovered }) {
  const st = derive(readEvents()), parsed = isObj(res.structured_output) ? res.structured_output : tryParse(res.result);
  const v = validateIdeas(parsed, { cfg, want: ctx.want, minImpact: ctx.minImpact, pastTitles: [...st.ideas.values()].filter(i => i.project === ctx.project).map(i => i.title) });
  const open = [...st.ideas.values()].filter(i => i.status === 'open'); let perProj = open.filter(i => i.project === ctx.project && i.gate !== 'auto').length, total = open.filter(i => i.gate !== 'auto').length, autos = open.filter(i => i.gate === 'auto').length, n = st.nextIdea, kept = 0;
  const drop = r => { v.dropped[r] = (v.dropped[r] || 0) + 1; };
  for (const it of v.kept) {
    if (it.gate === 'auto') { if (autos >= cfg.inbox.autoMax) { drop('queue_full'); continue; } autos++; }
    else { if (perProj >= cfg.inbox.perProject || total >= cfg.inbox.total) { drop('inbox_full'); continue; } perProj++; total++; }
    appendEvent({ type: 'idea_added', id: 'i' + n++, project: ctx.project, lens: ctx.lens, wild: !!ctx.wild, tick: ctx.tick, title: it.title, why: it.why, kind: it.kind, impact: it.impact, effort: it.effort, gate: it.gate, ...(it.ask ? { ask: it.ask } : {}) }); kept++;
  }
  let m = st.nextAssumption; for (const x of v.qa) appendEvent({ type: 'assumption', id: 'a' + m++, project: ctx.project, q: x.q, a: x.a, tick: ctx.tick });
  appendEvent({ type: 'tick_finished', tick: ctx.tick, outcome: recovered ? 'recovered' : 'ok', project: ctx.project, lens: ctx.lens, wild: !!ctx.wild, cost_usd: round(res.total_cost_usd, 5), proposed: v.proposed, kept, dropped: v.dropped, qa: v.qa.length });
  return { proposed: v.proposed, kept, dropped: v.dropped, qa: v.qa.length };
}

// ---------------------------------------------------------------- lock, backoff, recovery
export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const LOCK_GRACE_MS = 5000;   // an unreadable lock younger than this may be one being written: it holds
// is this live pid a steward visit? null when ps cannot tell (then the lock holds: never steal from what may be a live visit)
const stewardPid = pid => { const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }); if (r.error || r.status === null) return null; return r.status === 0 ? /wk-steward/.test(r.stdout) : false; };
// what the current lock means: { gone } (released meanwhile), { held, pid } or { stale, raw, ino }
function lockView(f, cfg, now) {
  let raw, ino, mtime; try { const st = fs.statSync(f); ino = st.ino; mtime = st.mtimeMs; raw = fs.readFileSync(f, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { gone: true } : { held: true, pid: null }; }
  const cur = tryParse(raw);
  if (cur === null && raw.trim() !== 'null') return Date.now() - mtime < LOCK_GRACE_MS ? { held: true, pid: null } : { stale: true, raw, ino };
  if (!isObj(cur) || !Number.isInteger(cur.pid) || cur.pid <= 0 || !pidAlive(cur.pid)) return { stale: true, raw, ino };
  // a live pid: held while younger than lockMaxMin; older, it is still held if that pid is a steward (a long visit, or a Mac that slept),
  // and stale only when the pid now belongs to some other program (the old holder died and its number was reused)
  if (now - Date.parse(cur.at) < cfg.call.lockMaxMin * 60000 || stewardPid(cur.pid) !== false) return { held: true, pid: cur.pid };
  return { stale: true, raw, ino };
}
// atomic: the lock is written to a file of our own and linked into place, so it appears whole or not at all, and only one tick can create it.
// A stale lock is replaced under a small guard folder (mkdir is atomic), and only if it is still the very lock that was judged stale.
export function takeLock(cfg, now) {
  const f = sp('tick.lock'), guard = sp('tick.lock.take'); ensure(stewardDir());
  const create = () => {
    const tmp = `${f}.${process.pid}.new`; fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: iso(now) }));
    try { fs.linkSync(tmp, f); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { try { fs.unlinkSync(tmp); } catch {} }
  };
  for (let i = 0; i < 3; i++) {
    if (create()) return { ok: true };
    const v = lockView(f, cfg, now);
    if (v.gone) continue;
    if (v.held) return { ok: false, pid: v.pid };
    try { fs.mkdirSync(guard); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(guard).mtimeMs > 30000) fs.rmdirSync(guard); } catch {}   // left by a crash; the next tick tries again
      return { ok: false, pid: null };
    }
    try {
      let same = false; try { same = fs.statSync(f).ino === v.ino && fs.readFileSync(f, 'utf8') === v.raw; } catch {}
      if (same) { try { fs.unlinkSync(f); } catch {} if (create()) return { ok: true }; }
    } finally { try { fs.rmdirSync(guard); } catch {} }
  }
  return { ok: false, pid: null };
}
export function releaseLock() { const f = sp('tick.lock'); try { if (readJSON(f, null)?.pid === process.pid) fs.unlinkSync(f); } catch {} }
const backoffFile = () => sp('backoff.json');
function setBackoff(rates, reason, now) {
  const prev = readJSON(backoffFile(), null), count = (prev?.count || 0) + 1, rej = rates.map(r => r.rate_limit_info).filter(i => i?.status === 'rejected').pop();
  let until = Number.isFinite(+rej?.resetsAt) ? +rej.resetsAt * 1000 : 0;
  if (!(until > now)) until = now + [1, 2, 4, 6][Math.min(count - 1, 3)] * HOUR;
  until = Math.min(until, now + 8 * DAY); writeAtomic(backoffFile(), JSON.stringify({ until, count, reason, setAt: iso(now) })); return until;
}
function pruneRaw() { try { const fl = fs.readdirSync(sp('raw')).filter(f => f.endsWith('.json')).sort(); for (const f of fl.slice(0, Math.max(0, fl.length - 60))) fs.unlinkSync(sp('raw', f)); } catch {} }
export function recoverUnfinished(cfg) {
  const out = [];
  for (const e of derive(readEvents()).unfinished) {
    const raw = readJSON(sp('raw', `${e.tick}.json`), null);
    if (isObj(raw?.res) && isObj(raw?.ctx)) { try { ingest({ cfg, ctx: raw.ctx, res: raw.res, recovered: true }); out.push({ tick: e.tick, outcome: 'recovered' }); continue; } catch (err) { appendEvent({ type: 'tick_finished', tick: e.tick, outcome: 'error', reason: 'recover_failed', project: e.project, lens: e.lens }); out.push({ tick: e.tick, outcome: 'error' }); continue; } }
    appendEvent({ type: 'tick_finished', tick: e.tick, outcome: 'error', reason: 'killed', project: e.project, lens: e.lens }); out.push({ tick: e.tick, outcome: 'error' });
  }
  return out;
}

// ---------------------------------------------------------------- self-tuning: one small step at a time, kept only if it measurably helped
export const tuningFile = () => sp('tuning.json');
export function loadTuning(cfg) {
  const t = readJSON(tuningFile(), {}), knobs = {};
  for (const [k, s] of Object.entries(cfg.tuning.knobs)) { const v = t.knobs?.[k]; knobs[k] = Math.min(s.max, Math.max(s.min, Number.isInteger(v) ? v : s.default)); }
  return { knobs, pending: isObj(t.pending) ? t.pending : null, blocks: Array.isArray(t.blocks) ? t.blocks : [], lastChangeAt: typeof t.lastChangeAt === 'string' ? t.lastChangeAt : null, seq: Number.isInteger(t.seq) ? t.seq : 0 };
}
export function tickMetrics(counted) {
  let proposed = 0, kept = 0, dupe = 0, low = 0;
  for (const e of counted) { proposed += e.proposed || 0; kept += e.kept || 0; dupe += e.dropped?.dupe || 0; low += e.dropped?.low || 0; }
  return { ticks: counted.length, proposed, dupeRate: proposed ? dupe / proposed : null, lowRate: proposed ? low / proposed : null, yieldRate: proposed ? kept / proposed : null };
}
const acceptOf = list => { const a = list.filter(i => i.status === 'yes' || i.status === 'no'); return { n: a.length, accept: a.length ? a.filter(i => i.status === 'yes').length / a.length : null }; };
export const answerMetrics = acceptOf;
export function tuneStep({ cfg, tuning, st, now }) {
  const T = cfg.tuning, log = [], t = JSON.parse(JSON.stringify(tuning)), at = iso(now), ideas = [...st.ideas.values()];
  const block = (knob, dir) => t.blocks.push({ knob, dir, until: iso(now + T.cooldownDays * DAY) });
  t.blocks = t.blocks.filter(b => Date.parse(b.until) > now);
  if (t.pending) {
    const p = t.pending; let value = null, enough = false;
    if (p.source === 'ticks') { const m = tickMetrics(st.counted.slice(p.tickCount)); value = m[p.metric]; enough = st.counted.length - p.tickCount >= T.evalSamples.ticks && value !== null; }
    else { const m = acceptOf(ideas.filter(i => seqOf(i) >= p.ideaSeq)); value = m.accept; enough = m.n >= T.evalSamples.answers && value !== null; }
    const expired = now - Date.parse(p.startedAt) > 14 * DAY;
    if (!enough && !expired) return { tuning: t, log, changed: false };
    const gain = value === null ? -1 : p.better === 'lower' ? p.baseline - value : value - p.baseline;
    if (enough && gain >= T.noise) { block(p.knob, p.dir === 'up' ? 'down' : 'up'); log.push({ at, kind: 'keep', rule: p.rule, knob: p.knob, value: t.knobs[p.knob], metric: p.metric, baseline: round(p.baseline), now: round(value), gain: round(gain) }); }
    else { t.knobs[p.knob] = p.from; block(p.knob, p.dir); t.lastChangeAt = at; log.push({ at, kind: 'revert', rule: p.rule, knob: p.knob, value: p.from, metric: p.metric, baseline: round(p.baseline), now: round(value), gain: round(gain), why: enough ? 'no real gain' : 'not proven in 14 days' }); }
    t.pending = null; return { tuning: t, log, changed: true };
  }
  if (t.lastChangeAt && now - Date.parse(t.lastChangeAt) < T.minHoursBetweenChanges * HOUR) return { tuning: t, log, changed: false };
  const win = st.counted.slice(-T.window), tm = tickMetrics(win), am = acceptOf(ideas), enoughTicks = win.length >= 3 && tm.proposed >= 8, cands = [];
  if (enoughTicks && tm.dupeRate > 0.30) { cands.push({ rule: 'R1', knob: 'pastIdeasInBrief', dir: 'up', metric: 'dupeRate', better: 'lower', source: 'ticks', baseline: tm.dupeRate }); cands.push({ rule: 'R1b', knob: 'ideasPerCall', dir: 'down', metric: 'dupeRate', better: 'lower', source: 'ticks', baseline: tm.dupeRate }); }
  if (enoughTicks && tm.lowRate > 0.35) cands.push({ rule: 'R2', knob: 'minImpact', dir: 'down', metric: 'yieldRate', better: 'higher', source: 'ticks', baseline: tm.yieldRate });
  if (am.n >= 4 && am.accept < 0.30) cands.push({ rule: 'R3', knob: 'minImpact', dir: 'up', metric: 'accept', better: 'higher', source: 'answers', baseline: am.accept });
  const aw = acceptOf(ideas.filter(i => i.wild)), an = acceptOf(ideas.filter(i => !i.wild));
  if (aw.n >= 3 && an.n >= 3 && Math.abs(aw.accept - an.accept) >= 0.2) cands.push({ rule: 'R5', knob: 'wildcardEvery', dir: aw.accept > an.accept ? 'down' : 'up', metric: 'accept', better: 'higher', source: 'answers', baseline: am.accept });
  for (const c of cands) {
    const s = T.knobs[c.knob], from = t.knobs[c.knob], to = c.dir === 'up' ? from + s.step : from - s.step;
    if (to < s.min || to > s.max || t.blocks.some(b => b.knob === c.knob && b.dir === c.dir)) continue;
    t.seq = (t.seq || 0) + 1; t.knobs[c.knob] = to; t.lastChangeAt = at;
    t.pending = { id: 'c' + t.seq, rule: c.rule, knob: c.knob, dir: c.dir, from, to, metric: c.metric, better: c.better, source: c.source, baseline: c.baseline, startedAt: at, tickCount: st.counted.length, ideaSeq: st.nextIdea };
    log.push({ at, kind: 'change', rule: c.rule, knob: c.knob, from, to, metric: c.metric, baseline: round(c.baseline) }); return { tuning: t, log, changed: true };
  }
  return { tuning: t, log, changed: false };
}
function saveTuning(r) {
  if (!r.changed && !r.log.length) return;
  writeAtomic(tuningFile(), JSON.stringify(r.tuning, null, 1));
  if (r.log.length) { const f = sp('tuning.log.jsonl'); fs.appendFileSync(f, r.log.map(e => JSON.stringify(e)).join('\n') + '\n'); try { const ls = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); if (ls.length > 400) writeAtomic(f, ls.slice(-200).join('\n') + '\n'); } catch {} }
}
// a broken line is skipped, not the whole log
export const tuningLog = (n = 20) => { let t; try { t = fs.readFileSync(sp('tuning.log.jsonl'), 'utf8'); } catch { return []; } const out = []; for (const l of t.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (isObj(e)) out.push(e); } catch {} } return out.slice(-n); };

// ---------------------------------------------------------------- one visit
export async function tick(opts = {}) {
  const dry = !!opts.dryRun, now = nowMs(), cfg = loadConfig();
  const early = (reason, detail, extra = {}) => {
    if (!dry) { try { appendEvent({ type: 'tick_held', tick: derive(readEvents()).nextTick, reason, detail, ...extra }, now); } catch {} }
    return { code: HELD_CODE[reason] ?? 3, held: reason, detail, dryRun: dry, ...extra };
  };
  let g; try { g = gates(); } catch (e) { return early('policy', String(e.message).slice(0, 200)); }
  if (killOn(g)) return early('kill', `the kill switch is on (${killFile(g)})`);
  let locked = false;
  if (!dry) { const l = takeLock(cfg, now); if (!l.ok) return early('lock', l.pid ? `another visit is running (pid ${l.pid})` : 'the visit lock could not be taken'); locked = true; }
  try { return await visit(cfg, g, now, opts, early); } catch (e) { if (e?.code === 'POLICY') return early('policy', String(e.message).slice(0, 200)); throw e; } finally { if (locked) releaseLock(); }
}
const guardPolicy = fn => { try { return fn(); } catch (e) { if (e instanceof StewardError) throw e; if (/^policy |^project override |lane mode needs a pinned policy|policy changed since/.test(String(e?.message))) { const x = new Error(e.message); x.code = 'POLICY'; throw x; } throw e; } };
async function visit(cfg, g, now, opts, early) {
  const dry = !!opts.dryRun;
  if (!dry) { pruneRaw(); recoverUnfinished(cfg); }
  const st = derive(readEvents()), tuning = loadTuning(cfg), knobs = tuning.knobs, bo = readJSON(backoffFile(), null);
  if (isObj(bo) && bo.until > now) return early('backoff', `waiting until ${iso(bo.until)} (${bo.reason})`, { until: iso(bo.until) });
  const cap = Math.max(1, Math.ceil(cfg.call.maxPerDay * cfg.pace.ramp[cfg.pace.phase])), recent = [...st.started.values()].filter(e => now - Date.parse(e.at) < DAY);
  if (!opts.force) {
    if (st.lastStart && now - st.lastStart < cfg.call.minGapMin * 60000) return early('gap', `the last visit began less than ${cfg.call.minGapMin} min ago`);
    if (recent.length >= cap) return early('cap', `${recent.length} of ${cap} visits in the last 24 h (phase ${cfg.pace.phase})`);
    const oa = ownerActive(cfg, now); if (oa.active) return early('owner', `a Claude session of yours wrote ${Math.round(oa.ageMin)} min ago`);
  }
  const pj = loadProjects(); if (pj.missing) throw new StewardError(pj.problems[0], 1);
  let project; const el = eligibleProjects(pj.projects, st, now);
  if (opts.project) { project = pj.projects.find(p => p.id === opts.project); if (!project) throw new StewardError(`no project "${opts.project}" in ${projectsFile()}`, 1); if (!isDir(project.path)) throw new StewardError(`the folder of "${project.id}" is missing`, 1); }
  else { if (!el.list.length) return early('no_project', 'no project is ready: ' + (el.skipped.map(s => `${s.id} (${s.why})`).join('; ') || 'the list is empty')); project = pickProject(el.list, st, cfg); }
  if (opts.lens && opts.lens !== 'wildcard' && !Object.hasOwn(cfg.lenses, opts.lens)) throw new StewardError(`unknown lens "${opts.lens}" (${Object.keys(cfg.lenses).join(', ')}, wildcard)`, 1);
  const pick = opts.lens ? { lens: opts.lens, wild: opts.lens === 'wildcard', avoid: [] } : pickLens(cfg, st, project, knobs);
  const facts = guardPolicy(() => collectFacts(project, now)), brief = buildBrief({ project, lens: pick.lens, wild: pick.wild, avoid: pick.avoid, cfg, knobs, facts, st });
  const hits = guardPolicy(() => secretHits(brief.text)); if (hits.length) return early('pii', `the brief for "${project.id}" would carry private data (${hits.join(', ')}); the call was not made`, { project: project.id, hits });
  let meter = readJSON(meterFile(), null);
  // S1 (P2-187 review): a stored meter that is still usable and already says "hold" on the weekly value (ceiling, landed, ahead) needs no probe: asking again would only spend a call after the budget is gone
  const holdsOnStored = cfg.mode === 'login' && meterOk(meter, now, cfg.pace.meterMaxAgeH * HOUR) && ['ceiling', 'landed', 'ahead'].includes(paceDecision({ cfg, win: weekWindow(cfg, now, meter), used: meter.utilization, fiveHour: null }).reason);
  if (cfg.mode === 'login' && !dry && !holdsOnStored && !meterOk(meter, now, cfg.pace.meterFreshMin * 60000)) {
    const pr = await probeMeter(cfg, g, now);
    if (pr.kind === 'killed') return early('kill', 'the kill switch went on during the meter check');
    if (pr.kind === 'refused') { const until = setBackoff([], 'auth mode mismatch', now); return early('auth', 'login mode needs the subscription login, but this call would bill another way (apiKeySource is not "none"); nothing was spent beyond the check; waiting until ' + iso(until), { until: iso(until) }); }
    if (pr.kind === 'limit') { const until = setBackoff(pr.rates, 'limit (meter check)', now); return early('backoff', `the account is at its limit; waiting until ${iso(until)}`, { until: iso(until) }); }
    if (pr.kind === 'error' || pr.kind === 'timeout' || pr.kind === 'spawn') { const until = setBackoff([], `meter check failed (${pr.reason})`, now); return early('backoff', `the meter check failed (${pr.reason}); waiting until ${iso(until)}`, { until: iso(until) }); }
    if (pr.meter) meter = pr.meter;
  }
  const u = usageFrom(cfg, now, meter), pace = paceDecision({ cfg, win: u.win, used: u.used, fiveHour: u.fiveHour }), paceInfo = { used: pace.used, elapsed: pace.elapsed, limit: pace.limit, headroom: pace.headroom, source: u.source };
  if (!pace.go) return early('pace', `${pace.reason}: ${pct(pace.used)} of the week used, the line is ${pct(pace.elapsed)}, the limit now is ${pct(pace.limit)}`, { pace: paceInfo, project: project.id });
  if (!opts.force && cfg.mode === 'login' && u.source === 'ledger' && recent.filter(e => e.pace?.source === 'ledger').length >= cfg.pace.unknownMaxCallsPerDay) return early('cap', `the weekly meter is unreadable, so at most ${cfg.pace.unknownMaxCallsPerDay} visits a day`, { pace: paceInfo });
  const tickId = st.nextTick, ctx = { tick: tickId, project: project.id, lens: pick.lens, wild: pick.wild, want: knobs.ideasPerCall, minImpact: knobs.minImpact };
  if (dry) return { code: 0, dryRun: true, wouldCall: true, tick: tickId, project: project.id, lens: pick.lens, wild: pick.wild, briefChars: brief.text.length, briefTokens: brief.tokens, pace: paceInfo, mode: cfg.mode, brief: opts.showBrief ? brief.text : undefined };
  const system = fs.readFileSync(path.join(root(), 'playbooks/ideas.md'), 'utf8').split('{{N}}').join(String(knobs.ideasPerCall)).split('{{MIN_IMPACT}}').join(String(knobs.minImpact));
  const env = childEnv(cfg);
  appendEvent({ type: 'tick_started', tick: tickId, project: project.id, lens: pick.lens, wild: pick.wild, mode: cfg.mode, phase: cfg.pace.phase, pace: paceInfo, want: ctx.want, minImpact: ctx.minImpact, briefTokens: brief.tokens });
  const run = await runClaude({ args: callArgs({ prompt: brief.text, system, model: cfg.call.model, schema: IDEA_SCHEMA, cap: cfg.call.capUsd, effort: cfg.call.effort }), env, cwd: runDir(), timeoutMs: cfg.call.timeoutMs, killCheck: () => killOn(g), onEvent: authGuard(cfg) });
  const c = classify(run, { needIdeas: true }), after = nowMs(), base = { tick: tickId, project: project.id, lens: pick.lens, wild: pick.wild };
  // a paid answer is saved first, so nothing below can lose it (the next visit recovers it from raw/ if this one dies)
  if (c.res && (c.kind === 'ok' || c.kind === 'invalid')) { const r = redactRaw(c.res); ensure(sp('raw')); writeAtomic(sp('raw', `${tickId}.json`), JSON.stringify({ tick: tickId, ctx, res: { subtype: r.subtype, is_error: r.is_error, result: String(r.result ?? '').slice(0, 20000), structured_output: r.structured_output ?? null, total_cost_usd: r.total_cost_usd, num_turns: r.num_turns, usage: r.usage, modelUsage: r.modelUsage } })); }
  const warn = (what, e) => { try { appendEvent({ type: 'warning', tick: tickId, what, detail: tidy(String(e?.message || e), 200) }, after); } catch {} };
  // a call stopped by the timeout or the kill switch sends no result, but it may have spent: a row with the cost unknown and the cap as the estimate
  try { if (c.res) ledgerAdd(`steward:${project.id}`, c.res); else if (c.kind === 'timeout' || c.kind === 'killed') ledgerAddUnknown(`steward:${project.id}`, cfg.call.capUsd); } catch (e) { warn('ledger', e); }
  let m = null; try { m = meterFromEvents(c.rates, after, 'call'); if (m) writeAtomic(meterFile(), JSON.stringify(m)); } catch (e) { warn('meter', e); }
  const cost =c.res && Number.isFinite(c.res.total_cost_usd) ? round(c.res.total_cost_usd, 5) : 0;
  if (c.kind === 'refused') { setBackoff([], 'auth mode mismatch', after); appendEvent({ type: 'tick_finished', ...base, outcome: 'error', reason: 'auth_mode', cost_usd: cost }, after); return { code: 2, outcome: 'refused', reason: 'auth_mode', ...base, detail: 'the call would not use the expected billing (apiKeySource); its result was discarded' }; }
  if (c.kind === 'killed') { appendEvent({ type: 'tick_finished', ...base, outcome: 'error', reason: 'kill_switch', cost_usd: cost }, after); return { code: 2, outcome: 'killed', ...base }; }
  if (c.kind === 'limit') { const until = setBackoff(c.rates, 'limit', after); appendEvent({ type: 'tick_finished', ...base, outcome: 'limit', cost_usd: cost, until: iso(until) }, after); return { code: 4, outcome: 'limit', ...base, until: iso(until) }; }
  if (c.kind === 'error' || c.kind === 'timeout' || c.kind === 'spawn') { appendEvent({ type: 'tick_finished', ...base, outcome: 'error', reason: c.reason, cost_usd: cost }, after); return { code: 4, outcome: c.kind === 'spawn' ? 'error' : c.kind, reason: c.reason, ...base, cost_usd: cost }; }
  try { fs.unlinkSync(backoffFile()); } catch {}
  if (c.kind === 'invalid') { appendEvent({ type: 'tick_finished', ...base, outcome: 'invalid', reason: c.reason, cost_usd: cost, proposed: 0, kept: 0, dropped: {} }, after); return { code: 4, outcome: 'invalid', reason: c.reason, ...base, cost_usd: cost }; }
  const r = guardPolicy(() => ingest({ cfg, ctx, res: c.res }));
  const st2 = derive(readEvents()); saveTuning(tuneStep({ cfg, tuning: loadTuning(cfg), st: st2, now: after }));
  return { code: 0, outcome: 'ok', ...base, cost_usd: cost, ...r, pace: paceInfo, meter: m ? { used: m.utilization, source: m.source } : null };
}

// ---------------------------------------------------------------- reading the state: status, inbox, answers, report
export function inbox(st, cfg, project) {
  const list = [...st.ideas.values()].filter(i => i.status === 'open' && i.gate !== 'auto' && (!project || i.project === project));
  list.sort((a, b) => b.impact - a.impact || a.effort - b.effort || seqOf(a) - seqOf(b)); return project ? list : list.slice(0, cfg.inbox.total);
}
export function answerIdea(id, answer, note) {
  if (!['yes', 'no', 'later'].includes(answer)) throw new StewardError('answer with yes, no or later', 1);
  const i = derive(readEvents()).ideas.get(id); if (!i) throw new StewardError(`no idea "${id}"`, 1);
  appendEvent({ type: 'idea_answered', id, answer, note: tidy(note || '', 200) }); return i;
}
// the one pace line (also used by the weekly report)
// local-zone wording only; the decision never depends on the zone (it is computed from epoch milliseconds in steward-lib)
function when(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}
const pc = v => Math.round(v * 100) + '%', pts = n => `${n} point${n === 1 ? '' : 's'}`;
export function paceLine(r) {
  if (r.reprobe) return `pace: hold · ${r.detail} · re-probe the meter before anything is released`;
  const gap = Math.round(-r.behindPoints), where = gap === 0 ? 'on the line' : gap > 0 ? `${pts(gap)} ahead` : `${pts(-gap)} behind`;
  const reserve = r.reserveHeld ? `owner reserve ${Math.round(r.reservePoints)} points held until ${when(Date.parse(r.reserveReleaseAt))}` : 'owner reserve released for the last stretch';
  const why = { ceiling: `ceiling: ${pc(r.used)} used is at the ${pc(r.limit)} limit now`, landed: `landed: ${pc(r.used)} used is at the ${pc(r.limit)} limit now`, ahead: r.decision === 'slow' ? 'ahead of the line, inside the slack' : 'too far ahead of the line', five_hour: `five-hour reading ${pc(r.fiveHour)}` }[r.reason];
  const verdict = r.decision === 'run' ? 'run' : `${r.decision}, ${why}`;
  return `pace: used ${pc(r.used)} · week ${pc(r.elapsed)} gone · target now ${pc(r.target)} · ${where} · ${reserve} · ${r.hoursLeft} h to the reset (${when(Date.parse(r.resetsAt))}) · decision: ${verdict} (meter ${Math.round(r.meterAgeMin)} min old)`;
}
export function snapshot(cfg, now) {
  const st = derive(readEvents()), tuning = loadTuning(cfg), meter = readJSON(meterFile(), null), u = usageFrom(cfg, now, meter), pace = paceDecision({ cfg, win: u.win, used: u.used, fiveHour: u.fiveHour });
  const bo = readJSON(backoffFile(), null), lock = readJSON(sp('tick.lock'), null), oa = ownerActive(cfg, now), pj = loadProjects(), el = eligibleProjects(pj.projects, st, now);
  const cap = Math.max(1, Math.ceil(cfg.call.maxPerDay * cfg.pace.ramp[cfg.pace.phase])), recent = [...st.started.values()].filter(e => now - Date.parse(e.at) < DAY);
  let killed = false; try { killed = killOn(gates({ allowMismatch: true })); } catch { killed = null; }
  const ideas = [...st.ideas.values()], open = ideas.filter(i => i.status === 'open'), ans = acceptOf(ideas);
  return { mode: cfg.mode, phase: cfg.pace.phase, cap, visits24h: recent.length, win: u.win, source: u.source, used: u.used, meterAgeMin: u.meterAgeMin, pace, backoff: isObj(bo) && bo.until > now ? bo : null, lock: lock && pidAlive(lock.pid) ? lock : null, killed, ownerActive: oa,
    projects: pj.projects.map(p => ({ id: p.id, weight: p.weight, paused: p.paused })), skipped: el.skipped, problems: pj.problems, last: st.finished.slice(-1)[0] || null, unfinished: st.unfinished.length, warnings: cfg._warnings,
    ideas: { open: open.length, auto: open.filter(i => i.gate === 'auto').length, ask: open.filter(i => i.gate === 'ask').length, wait: open.filter(i => i.gate === 'wait').length, answered: ans.n, accept: round(ans.accept, 2) }, tuning };
}
export function report(cfg, now) {
  const st = derive(readEvents()), meter = readJSON(meterFile(), null), u = usageFrom(cfg, now, meter), w = u.win, inWin = e => { const t = Date.parse(e.at); return t >= w.start && t < w.end; };
  const started = [...st.started.values()].filter(inWin), counted = st.counted.filter(inWin), held = st.held.filter(inWin), ideas = [...st.ideas.values()].filter(inWin);
  const heldBy = {}; for (const h of held) heldBy[h.reason] = (heldBy[h.reason] || 0) + 1;
  const by = {}; for (const e of counted) by[e.project] = (by[e.project] || 0) + 1;
  const rows = ledgerRows().filter(r => /^steward:/.test(r.item || '') && Date.parse(r.at) >= w.start && Date.parse(r.at) < w.end), spend = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  // tokens per visit, so the owner can measure again after a change (the P2-191 habit): lower medians of the main calls, and of the brief estimate
  const med = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const mainCalls = rows.filter(r => r.item !== 'steward:probe' && !r.error), tokens = { calls: mainCalls.length, inPerCall: med(mainCalls.map(r => Number.isFinite(r.in) ? r.in + (Number.isFinite(r.cache_read) ? r.cache_read : 0) : NaN)), outPerCall: med(mainCalls.map(r => r.out)), briefEst: med(started.map(e => e.briefTokens)) };
  const yes = ideas.filter(i => i.status === 'yes').length, no = ideas.filter(i => i.status === 'no').length;
  const errs = started.map(e => e.pace).filter(p => p && Number.isFinite(p.used) && Number.isFinite(p.elapsed)).map(p => Math.abs(p.used - p.elapsed));
  return { weekEnds: iso(w.end), used: round(u.used, 2), elapsed: round(w.elapsed, 2), source: u.source, visits: counted.length, byProject: by, held: heldBy, spendUsd: round(spend, 4), ideasAdded: ideas.length, yes, no, open: ideas.filter(i => i.status === 'open').length,
    paceError: errs.length ? round(errs.reduce((a, b) => a + b, 0) / errs.length, 3) : null, acceptShare: yes + no ? round(yes / (yes + no), 2) : null, costPerAccepted: yes ? round(spend / yes, 4) : null, tokens, pace: paceReading(cfg, now, meter), tuningChanges: tuningLog(200).filter(e => Date.parse(e.at) >= w.start && Date.parse(e.at) < w.end) };
}
export function setPhase(name) {
  const cfg = loadConfig(); if (!Object.hasOwn(cfg.pace.ramp, name)) throw new StewardError(`phase must be one of: ${Object.keys(cfg.pace.ramp).join(', ')}`, 1);
  const f = userConfigFile(), own = readOwnerConfig();
  own.pace = { ...(isObj(own.pace) ? own.pace : {}), phase: name }; writeAtomic(f, JSON.stringify(own, null, 2) + '\n'); return f;
}
export function initFiles() {
  ensure(stewardDir()); ensure(sp('run')); const pf = projectsFile(); let created = false;
  if (!fs.existsSync(pf)) { ensure(path.dirname(pf)); fs.copyFileSync(path.join(root(), 'config/projects.example.json'), pf); created = true; }
  return { dir: stewardDir(), projects: pf, created };
}
