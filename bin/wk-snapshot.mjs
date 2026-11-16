#!/usr/bin/env node
// wk-snapshot [--visitors file.json] [--out dir]  -> writes <dir>/business-YYYY-MM-DD.json with TOTALS ONLY.
// Stripe: restricted read-only key from env STRIPE_RESTRICTED_KEY (never a file). No key -> stripe:null, missing:['stripe_key'], exit 0.
// Aborts (exit 2, nothing written) if scanPII hits the output or any key name is on the denylist.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { scanPII } from './lib.mjs';
export const DENY_KEYS = ['email', 'name', 'customer', 'card', 'phone', 'address'];
export function badKeys(o, p = '') { const out = []; if (Array.isArray(o)) o.forEach((v, i) => out.push(...badKeys(v, p + '[' + i + ']'))); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (DENY_KEYS.some(d => k.toLowerCase().includes(d))) out.push(p + '.' + k); out.push(...badKeys(v, p + '.' + k)); } return out; }
// default Stripe reader: GET list endpoint, paginate; returns raw objects (reduced to totals below, never stored)
export function realStripeFn(key) { return async (ep, params = {}) => { const all = []; let after; for (let i = 0; i < 100; i++) { const q = new URLSearchParams({ limit: '100', ...params, ...(after ? { starting_after: after } : {}) }); const r = await fetch('https://api.stripe.com/v1/' + ep + '?' + q, { headers: { Authorization: 'Bearer ' + key } }); if (!r.ok) throw new Error('stripe ' + ep + ' ' + r.status); const j = await r.json(); all.push(...j.data); if (!j.has_more) break; after = j.data[j.data.length - 1].id; } return all; }; }
const addTo = (m, cur, n) => { m[cur] = (m[cur] || 0) + n; };
export async function stripeTotals(stripeFn, now = Date.now()) {
  const sec = Math.floor(now / 1000), since = d => sec - d * 86400, out = { charges: {}, subscriptions: {}, refunds: {} };
  const ch = await stripeFn('charges', { 'created[gte]': String(since(28)) });
  for (const [d, label] of [[7, 'last_7d'], [28, 'last_28d']]) { const by = {}; for (const c of ch) if (c.paid && c.created >= since(d)) { const k = String(c.currency || 'unknown').toLowerCase(); by[k] = by[k] || { count: 0, gross: 0 }; by[k].count++; by[k].gross += (c.amount || 0) / 100; } for (const k in by) by[k].gross = Math.round(by[k].gross * 100) / 100; out.charges[label] = by; }
  const subs = await stripeFn('subscriptions', { status: 'all', 'created[gte]': String(since(28)) });
  out.subscriptions.new_last_7d = subs.filter(s => s.created >= since(7)).length; out.subscriptions.new_last_28d = subs.length;
  out.subscriptions.active = (await stripeFn('subscriptions', { status: 'active' })).length;
  const rf = await stripeFn('refunds', { 'created[gte]': String(since(28)) });
  out.refunds = { last_7d: rf.filter(r => r.created >= since(7)).length, last_28d: rf.length };
  return out;
}
// visitors file: {"site": 123} or {"site": {"visitors": 123, ...}}; only numeric totals per site are kept
export function visitorTotals(file) { const j = JSON.parse(fs.readFileSync(file, 'utf8')), out = {}; for (const [site, v] of Object.entries(j)) { const n = typeof v === 'number' ? v : (v && typeof v === 'object' ? (v.visitors ?? v.total ?? v.count) : undefined); if (Number.isFinite(n)) out[site] = n; } return out; }
export async function buildSnapshot({ stripeFn, key, visitorsFile, now = new Date() } = {}) {
  const snap = { schema_version: 1, generated: now.toISOString(), source: 'wk-snapshot', stripe: null, visitors: null, missing: [] };
  if (stripeFn || key) snap.stripe = await stripeTotals(stripeFn || realStripeFn(key), now.getTime()); else snap.missing.push('stripe_key');
  if (visitorsFile) snap.visitors = visitorTotals(visitorsFile);
  return snap;
}
export function writeSnapshot(snap, dir) { const text = JSON.stringify(snap, null, 2) + '\n', bk = badKeys(snap), hits = scanPII(text); if (bk.length || hits.length) { const e = new Error('snapshot refused: ' + (bk.length ? 'denied keys ' + bk.join(',') : '') + (hits.length ? ' pii ' + hits.join(',') : '')); e.code = 2; throw e; } fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'business-' + snap.generated.slice(0, 10) + '.json'); fs.writeFileSync(f, text, { mode: 0o600 }); return f; }
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const dir = opt('--out') || process.env.WK_SNAPSHOT_DIR || path.join(os.homedir(), '.wk', 'snapshots');
  try { const snap = await buildSnapshot({ key: process.env.STRIPE_RESTRICTED_KEY, visitorsFile: opt('--visitors') }); console.log(writeSnapshot(snap, dir)); if (snap.missing.length) console.error('missing: ' + snap.missing.join(',')); }
  catch (e) { console.error(e.message); process.exit(e.code === 2 ? 2 : 1); }
}
