#!/usr/bin/env node
// wk-ledger add <item> < claude -p --output-format json output   -> appends a row to ~/.wk/ledger.jsonl
// wk-ledger context <transcript.jsonl>   -> context size per call (median, p90, max, share of input read above 200k): the P2-176 regression check
// wk-ledger summary [days]               -> cost and calls per item/model
// wk-ledger pace [--event <file>|-] [--json] -> the company's ONE pace line, read from the plan's real seven-day meter (P2-178, Q90). It reuses the steward's
//                                           reader and arithmetic (bin/steward-lib.mjs); it keeps none of its own. --event takes a stream-json file or one rate_limit_event line
//                                           (or - for stdin), stores the reading the way the steward does, then paces on it. Exit 0 = run or slow, exit 3 = hold. A meter that
//                                           is missing, unreadable, too old or from a week that has ended is a hold that says "re-probe"; it never falls back to dollars.
// wk-ledger spike                         -> exit 3 when today > 3x the median of the previous days (3+ days of history) or > 2x the day's share (WK_WEEKLY_USD, default 20.94, over 7)
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { loadConfig, meterFile, meterFromEvents, paceReading, paceLine, writeAtomic, nowMs, StewardError, mainModel } from './steward-lib.mjs';
import { readJSON } from './lib.mjs';
if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) {
  console.log('usage: wk-ledger add <item> [p80] | context <transcript> | summary [days] | pace [--event <file>|-] [--json] | spike');
  process.exit(0);
}
const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
const L = process.env.WK_LEDGER || path.join(wkHome(), 'ledger.jsonl'); const [cmd, a, b] = process.argv.slice(2);
const q = (xs, p) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0;
function eventsFrom(text) {
  const out = []; for (const l of String(text).split('\n')) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j); } catch {} }
  return out;
}
function pace(args) {
  const json = args.includes('--json'), i = args.indexOf('--event'), src = i >= 0 ? args[i + 1] : null;
  try {
    if (i >= 0 && !src) throw new StewardError('--event needs a file, or - for standard input', 1);
    const cfg = loadConfig(), now = nowMs();
    if (src) {
      let text; try { text = fs.readFileSync(src === '-' ? 0 : src, 'utf8'); } catch (e) { throw new StewardError(`cannot read the event file (${e.code || e.message})`, 1); }
      const m = meterFromEvents(eventsFrom(text), now, 'event'); if (!m) throw new StewardError('the event holds no seven-day or five-hour reading', 1);
      writeAtomic(meterFile(), JSON.stringify(m));
    }
    const r = paceReading(cfg, now, readJSON(meterFile(), null));
    console.log(json ? JSON.stringify(r) : paceLine(r)); return r.code;
  } catch (e) { console.error(e.message); return e.code === 1 ? 1 : 3; }
}

if (cmd === 'add') {
  const text = fs.readFileSync(0, 'utf8'); let j;
  try { j = JSON.parse(text); } catch { try { j = JSON.parse(text.trim().split('\n').pop()); } catch {} }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { console.error('wk-ledger add: expected a `claude -p` result object on stdin (the `--output-format json` output, or the last line of `--output-format stream-json`), got ' + (text.trim() ? 'text that is not a JSON object' : 'nothing') + '; no row written'); process.exit(1); }
  const u = j.usage || {};
  const row = { at: new Date().toISOString(), item: a || null, model: mainModel(j.modelUsage) || j.model || null, cost_usd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, in: u.input_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null, out: u.output_tokens ?? null, error: !!j.is_error, p80_estimate: b ? +b : null };
  fs.mkdirSync(path.dirname(L), { recursive: true }); fs.appendFileSync(L, JSON.stringify(row) + '\n');
  if (row.p80_estimate && row.cost_usd > 2 * row.p80_estimate) { console.error(`STOP: ${a} cost ${row.cost_usd} > 2x its p80 estimate ${row.p80_estimate}`); process.exit(3); }
  console.log(JSON.stringify(row));
} else if (cmd === 'context') {
  if (!a) { console.error('usage: wk-ledger context <transcript.jsonl>'); process.exit(2); }
  const ctx = []; for (const l of fs.readFileSync(a, 'utf8').split('\n')) { try { const u = JSON.parse(l).message?.usage; if (u) ctx.push((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)); } catch {} }
  const tot = ctx.reduce((x, y) => x + y, 0), over = ctx.filter(c => c > 200000).reduce((x, y) => x + y, 0);
  console.log(JSON.stringify({ calls: ctx.length, median: q(ctx, .5), p90: q(ctx, .9), max: Math.max(0, ...ctx), share_over_200k: tot ? +(over / tot).toFixed(2) : 0, verdict: tot && over / tot > .3 ? 'WARN: compaction fires too late; run wk-optimise' : 'ok' }));
} else if (cmd === 'summary') {
  const since = Date.now() - (+a || 7) * 864e5, by = {};
  for (const l of fs.existsSync(L) ? fs.readFileSync(L, 'utf8').split('\n') : []) { try { const r = JSON.parse(l); if (Date.parse(r.at) < since) continue; const k = `${r.item || '-'} ${r.model || '-'}`; (by[k] ||= { runs: 0, usd: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }); by[k].runs++; by[k].usd += r.cost_usd || 0; for (const f of ['in', 'cache_read', 'cache_write', 'out']) by[k][f] += r[f] || 0; } catch {} }
  console.table(by);
} else if (cmd === 'pace') {
  process.exit(pace(process.argv.slice(3)));
} else if (cmd === 'spike') {
  const rows = []; for (const l of fs.existsSync(L) ? fs.readFileSync(L, 'utf8').split('\n') : []) { try { const r = JSON.parse(l); if (r.cost_usd != null) rows.push(r); } catch {} }
  const day = x => (process.env.WK_TZ_UTC ? x.slice(0, 10) : new Date(x).toLocaleDateString('en-CA')), today = day(process.env.WK_NOW || new Date().toISOString());
  const by = {}; for (const r of rows) by[day(r.at)] = (by[day(r.at)] || 0) + r.cost_usd;
  const share = (+process.env.WK_WEEKLY_USD || 20.94) / 7, spent = by[today] || 0;
  const prev = Object.entries(by).filter(([d]) => d < today).sort().slice(-7).map(([, v]) => v), med = q(prev, .5);
  const spike = (prev.length >= 3 && med > 0 && spent > 3 * med) || spent > 2 * share, hold = spent >= share;
  const out = { today, spent: +spent.toFixed(2), day_share: +share.toFixed(2), remaining: +Math.max(0, share - spent).toFixed(2), median_prev: +med.toFixed(2), hold, spike };
  console.log(JSON.stringify(out)); process.exit(spike ? 3 : 0);
} else { console.error('usage: wk-ledger add <item> [p80] | context <transcript> | summary [days] | pace [--event <file>|-] [--json] | spike'); process.exit(1); }
