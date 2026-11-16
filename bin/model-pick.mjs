// Watchkeeper's model picker (P2-227). The owner's rule (16 Nov 2026): legal wording is always checked by the newest top model
// (Fable 5.2 today, or any later one), and a user without Fable gets the best model they have.
// The order of each lane is in config/models.json; a newer Fable needs one change there: its id first in "legal".
// There is no separate probe call (a bare call costs about US$0.16 to US$0.42 in start-up context): the first real call is the probe.
//   - The next model is tried ONLY on the "not available" signal: is_error with api_error_status 404, or the text
//     "There's an issue with the selected model". Claude Code also prints [claude-code:unrecognized_model] on stderr for
//     claude-fable-5-2 when it works, so stderr is never a signal.
//   - A busy answer (429, 529, overloaded, a rate limit) never changes the model: the caller waits and tries the same model again,
//     only while its pace rules allow.
//   - The models found unavailable, and the last pick of each lane, are kept in ~/.wk/model-pick.json for cache_hours (24).
//     Every fallback is a line in the audit, ~/.wk/model-audit.jsonl.
//   node bin/model-pick.mjs [lane] [--json]   -> the model the lane would use now, and the ones skipped
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root } from './lib.mjs';

const require = createRequire(import.meta.url);
export const { LEGAL_WORDS, isLegal, legalLabel } = require('../panel/src/legal-words.js');

export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export const cacheFile = () => path.join(wkHome(), 'model-pick.json');
export const auditFile = () => path.join(wkHome(), 'model-audit.jsonl');
export const configFile = () => path.join(root(), 'config', 'models.json');
export const MODEL_ID = /^[a-z][a-z0-9.-]{1,63}$/;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HOUR = 3600000;
const DEFAULTS = { legal: ['claude-fable-5-2', 'fable', 'opus', 'sonnet'], legal_effort_job: 'xhigh', legal_effort_ask: 'max', cache_hours: 24 };

export function config() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { /* the defaults */ }
  const o = { ...DEFAULTS };
  if (c && typeof c === 'object') {
    for (const [k, v] of Object.entries(c)) {
      if (Array.isArray(v) && v.length && v.length <= 12 && v.every(x => typeof x === 'string' && MODEL_ID.test(x))) o[k] = [...new Set(v)];
    }
    for (const k of ['legal_effort_job', 'legal_effort_ask']) if (EFFORTS.includes(c[k])) o[k] = c[k];
    if (Number.isFinite(c.cache_hours) && c.cache_hours >= 1 && c.cache_hours <= 720) o.cache_hours = c.cache_hours;
  }
  return o;
}
export const order = (lane = 'legal', c = config()) => (Array.isArray(c[lane]) ? c[lane] : []);
export const inOrder = (lane, model, c = config()) => order(lane, c).includes(model);

// ---------------------------------------------------------------- the cache (24 hours) and the audit
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
}
export function readCache(now = Date.now(), c = config()) {
  let j = {}; try { j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { /* none yet */ }
  const keep = ms => Number.isFinite(ms) && ms <= now && now - ms < c.cache_hours * HOUR;
  const out = { v: 1, unavailable: {}, picked: {} };
  for (const [m, x] of Object.entries(j && typeof j.unavailable === 'object' && j.unavailable ? j.unavailable : {})) {
    if (MODEL_ID.test(m) && x && keep(x.at)) out.unavailable[m] = { at: x.at, lane: String(x.lane || '').slice(0, 20), why: String(x.why || '').slice(0, 200) };
  }
  for (const [l, x] of Object.entries(j && typeof j.picked === 'object' && j.picked ? j.picked : {})) {
    if (x && MODEL_ID.test(String(x.model)) && keep(x.at)) out.picked[l] = { model: x.model, at: x.at };
  }
  return out;
}
const saveCache = o => { try { writePrivate(cacheFile(), JSON.stringify(o, null, 2) + '\n'); return true; } catch { return false; } };
export function audit(o, now = Date.now()) {
  try {
    fs.mkdirSync(wkHome(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditFile(), JSON.stringify({ at: new Date(now).toISOString(), ...o }) + '\n', { mode: 0o600 });
  } catch { /* the audit never stops a run */ }
}

// The model a lane uses now: the first in its order not found unavailable in the last cache_hours.
// When every model was found unavailable, the last one (the most widely held) is tried again.
export function pick(lane = 'legal', { now = Date.now(), c = config(), also = [] } = {}) {
  const ord = order(lane, c);
  if (!ord.length) throw new Error(`no model order for the lane "${lane}" in config/models.json`);
  const cache = readCache(now, c);
  const out = m => Boolean(cache.unavailable[m]) || also.includes(m);
  const skipped = ord.filter(out);
  const model = ord.find(m => !out(m)) || ord[ord.length - 1];
  return { lane, model, skipped, exhausted: skipped.length === ord.length };
}
export function markUnavailable(lane, model, { now = Date.now(), from = '', why = '', next = null, c = config() } = {}) {
  const cache = readCache(now, c);
  cache.unavailable[model] = { at: now, lane, why: String(why).slice(0, 200) };
  if (cache.picked[lane] && cache.picked[lane].model === model) delete cache.picked[lane];
  saveCache(cache);
  audit({ ev: 'model-fallback', lane, from, model, next, why: String(why).slice(0, 200) }, now);
}
export function markWorked(lane, model, { now = Date.now(), from = '', c = config() } = {}) {
  const cache = readCache(now, c);
  const before = cache.picked[lane] && cache.picked[lane].model;
  cache.picked[lane] = { model, at: now };
  saveCache(cache);
  if (before !== model) audit({ ev: 'model-picked', lane, from, model }, now);
}

// ---------------------------------------------------------------- the signals
// Accepts a result object, an array of stream-json objects, or the text of stdout (one JSON or ndjson).
function objects(x) {
  if (Array.isArray(x)) return x.filter(o => o && typeof o === 'object');
  if (x && typeof x === 'object') return [x];
  if (typeof x !== 'string') return [];
  const out = [];
  for (const line of x.split('\n')) { const t = line.trim(); if (!t) continue; try { const o = JSON.parse(t); if (o && typeof o === 'object') out.push(o); } catch { /* not JSON */ } }
  return out;
}
const NOT_AVAILABLE = /There[’']s an issue with the selected model|It may not exist or you may not have access to it/i;
const BUSY = /\b(?:429|529)\b|overloaded|rate[ _-]?limit/i;
const textOf = o => (o && o.message && Array.isArray(o.message.content) ? o.message.content.filter(c => c && c.type === 'text').map(c => String(c.text || '')).join(' ') : '');
const isResult = o => o.type === 'result' || (o.type === undefined && 'is_error' in o);
export function isUnavailable(x) {
  return objects(x).some(o => (isResult(o) && o.is_error === true && (o.api_error_status === 404 || NOT_AVAILABLE.test(String(o.result || ''))))
    || (o.type === 'assistant' && o.message && o.message.model === '<synthetic>' && NOT_AVAILABLE.test(textOf(o))));
}
export function isBusy(x) {
  const os_ = objects(x);
  if (isUnavailable(os_)) return false;
  const failed = os_.some(o => isResult(o) && o.is_error === true);
  if (!failed) return false;
  return os_.some(o => (isResult(o) && ([429, 529].includes(o.api_error_status) || BUSY.test(String(o.result || ''))))
    || (o.type === 'assistant' && o.message && o.message.model === '<synthetic>' && BUSY.test(textOf(o)))
    || (o.type === 'rate_limit_event' && o.rate_limit_info && typeof o.rate_limit_info.status === 'string' && !/^allowed/.test(o.rate_limit_info.status)));
}

// Runs runOnce(model) on the lane's pick. runOnce returns { out } (what the signals read) plus anything the caller wants back.
// A "not available" answer marks the model and tries the next one; a busy answer waits waitMs and tries the SAME model again,
// at most `retries` times and only while paceOk() is true. Returns { model, r, fallbacks, busy, exhausted }.
export async function runPicked(lane, runOnce, { from = '', retries = 3, waitMs = 60000, paceOk = () => true, sleep = ms => new Promise(r => setTimeout(r, ms)),
  onFallback = () => {}, onBusy = () => {}, now = () => Date.now(), c = config() } = {}) {
  const tried = [], fallbacks = [];
  let busyTries = 0;
  for (;;) {
    const p = pick(lane, { now: now(), c, also: tried });
    if (p.exhausted && tried.length) return { model: tried[tried.length - 1], r: fallbacks.at(-1).r, fallbacks, busy: false, exhausted: true };
    const model = p.model;
    const r = await runOnce(model);
    if (r && r.stopped) return { model, r, fallbacks, busy: false, exhausted: false };
    const out = r && r.out;
    if (isUnavailable(out)) {
      tried.push(model);
      const next = pick(lane, { now: now(), c, also: tried });
      const why = 'not available on this plan (api_error 404)';
      markUnavailable(lane, model, { now: now(), from, why, next: next.exhausted ? null : next.model, c });
      fallbacks.push({ model, next: next.exhausted ? null : next.model, r });
      onFallback(model, next.exhausted ? null : next.model);
      busyTries = 0;
      continue;
    }
    if (isBusy(out)) {
      if (busyTries < retries && paceOk()) { busyTries++; onBusy(model, busyTries, waitMs); await sleep(waitMs); continue; }
      return { model, r, fallbacks, busy: true, exhausted: false };
    }
    markWorked(lane, model, { now: now(), from, c });
    return { model, r, fallbacks, busy: false, exhausted: false };
  }
}

// steward-lib imports this file, sometimes from `node -e` whose argv[1] is not a file: the check never throws
const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname); } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2), json = a.includes('--json'), lane = a.find(x => !x.startsWith('--')) || 'legal';
  try {
    const p = pick(lane);
    if (json) console.log(JSON.stringify({ ...p, order: order(lane) }));
    else console.log(`${lane}: ${p.model}${p.skipped.length ? ` (skipped for now: ${p.skipped.join(', ')})` : ''}; order ${order(lane).join(', ')}`);
  } catch (e) { console.error(`model-pick: ${e.message}`); process.exit(1); }
}
