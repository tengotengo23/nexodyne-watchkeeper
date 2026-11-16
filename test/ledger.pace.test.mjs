// Tests for `wk-ledger pace` (P2-178 package 3): one pace line for the whole company, read from the plan's real seven-day meter.
// Run: node --test test/ledger.pace.test.mjs        Every test works in a temp world (test/fixtures/world.mjs); the real ~/.wk and ~/.claude are never touched.
// The shipped pace numbers (Q90, 11 Nov 2026): ceiling 80% (the 20-point owner reserve), landing 98%, reserve released for the last 24 h.
// The test week ends Mon 9 Nov 2026 02:00Z (WEEK_END_S); h = hours since its start, so h 84 is half way and hoursLeft = 168 - h.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkWorld, env, cleanup, setMeter, setConfig, WEEK_START, WEEK_END_S, HOUR, iso, ROOT } from './fixtures/world.mjs';

after(cleanup);
const LEDGER = path.join(ROOT, 'bin', 'wk-ledger.mjs');
const W = (h, o = {}) => { const w = mkWorld({ projects: 1, oldPace: false, ...o }); w.now = WEEK_START + h * HOUR; return w; };   // the owner file is empty: the shipped numbers apply
const pace = (w, args = [], extra = {}, input = '') => {
  const r = spawnSync(process.execPath, [LEDGER, 'pace', ...args], { env: env(w, { WK_NOW: iso(w.now), ...extra }), encoding: 'utf8', input, cwd: w.dir, timeout: 30000 });
  let json; if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch {} }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
};
const at = (h, util, o = {}) => { const w = W(h); setMeter(w, { util, ...o }); return w; };
const dec = (h, util, o = {}) => { const r = pace(at(h, util, o), ['--json']); return { code: r.code, decision: r.json.decision, reason: r.json.reason }; };

test('the shipped pace numbers (Q90): ceiling 0.80, landTo 0.98, lastHours 24, aheadSlack 0.03', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'steward.json'), 'utf8')).pace;
  assert.equal(c.ceiling, 0.8); assert.equal(c.landTo, 0.98); assert.equal(c.lastHours, 24); assert.equal(c.aheadSlack, 0.03);
  assert.match(fs.readFileSync(path.join(ROOT, 'config', 'steward.json'), 'utf8'), /Q90/);
});

test('used 0%, 74%, 75% (top-level utilization), 99%: the decision and the exit code', () => {
  assert.deepEqual(dec(84, 0), { code: 0, decision: 'run', reason: null });
  assert.deepEqual(dec(130, 0.74), { code: 0, decision: 'run', reason: null }, '74% at h 130 (77% gone, 38 h left) is behind the line and under the 80% ceiling');
  // 75% arrives with a top-level utilization next to unifiedWindows: stored through --event, then paced
  const w = W(130), line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: WEEK_END_S, rateLimitType: 'seven_day', utilization: 0.75, surpassedThreshold: 0.75, unifiedWindows: { seven_day: { utilization: 0.75, resetsAt: WEEK_END_S, status: 'allowed_warning' } } } });
  const f = path.join(w.dir, 'e.jsonl'); fs.writeFileSync(f, line + '\n');
  const r = pace(w, ['--event', f, '--json']); assert.equal(r.code, 0, r.err); assert.equal(r.json.used, 0.75); assert.equal(r.json.decision, 'run');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'meter.json'), 'utf8')).utilization, 0.75, 'the reading is stored the way the steward stores it');
  assert.deepEqual(dec(130, 0.99), { code: 3, decision: 'hold', reason: 'ceiling' });
  assert.deepEqual(dec(150, 0.99), { code: 3, decision: 'hold', reason: 'landed' }, 'in the last stretch the limit is 98%');
  assert.deepEqual(dec(150, 0.97), { code: 3, decision: 'hold', reason: 'ahead' }, '97% is under the 98% limit but 8 points ahead of the line');
  assert.deepEqual(dec(150, 0.92), { code: 0, decision: 'slow', reason: 'ahead' }, 'and 92% (3 points ahead, inside the slack) still goes, slowly');
});

test('the owner reserve: 81% with 30 h left holds (ceiling), 81% with 20 h left goes', () => {
  assert.deepEqual(dec(138, 0.81), { code: 3, decision: 'hold', reason: 'ceiling' });
  assert.deepEqual(dec(148, 0.81), { code: 0, decision: 'run', reason: null });
  assert.deepEqual(dec(144.5, 0.81, {}).decision, 'run', '23.5 h left: the reserve is released');
  const held = pace(at(138, 0.81), ['--json']).json, freed = pace(at(148, 0.81), ['--json']).json;
  assert.equal(held.reserveHeld, true); assert.equal(held.reservePoints, 20); assert.equal(held.reserveReleaseAt, iso(WEEK_END_S * 1000 - 24 * HOUR));
  assert.equal(freed.reserveHeld, false);
  assert.match(pace(at(138, 0.81)).out, /owner reserve 20 points held until /); assert.match(pace(at(148, 0.81)).out, /owner reserve released for the last stretch/);
});

test('slow: a little ahead of the line, or a five-hour reading at 75% or more; hold when well ahead or the five-hour reading is at 90%', () => {
  assert.deepEqual(dec(84, 0.51), { code: 0, decision: 'slow', reason: 'ahead' }, '1 point ahead is inside the slack');
  assert.deepEqual(dec(84, 0.5), { code: 0, decision: 'run', reason: null }, 'exactly on the line');
  assert.deepEqual(dec(84, 0.56), { code: 3, decision: 'hold', reason: 'ahead' });
  assert.deepEqual(dec(84, 0.3, { five: 0.8 }), { code: 0, decision: 'slow', reason: 'five_hour' });
  assert.deepEqual(dec(84, 0.3, { five: 0.95 }), { code: 3, decision: 'hold', reason: 'five_hour' });
  assert.deepEqual(dec(84, 0.3, { five: 0.5 }), { code: 0, decision: 'run', reason: null });
});

test('the line: used, week gone, target, points ahead or behind, reserve, hours to the reset, decision, meter age', () => {
  const w = at(84, 0.32, { ageMin: 3 }); w.now = WEEK_START + 84 * HOUR;
  const r = pace(w, [], { TZ: 'UTC' });
  assert.equal(r.code, 0); assert.equal(r.out.split('\n').filter(Boolean).length, 1, 'one line');
  assert.equal(r.out, 'pace: used 32% · week 50% gone · target now 50% · 18 points behind · owner reserve 20 points held until Sun 8 Nov 02:00 · 84 h to the reset (Mon 9 Nov 02:00) · decision: run (meter 3 min old)\n');
  const ahead = pace(at(84, 0.52), [], { TZ: 'UTC' }).out; assert.match(ahead, /2 points ahead/); assert.match(ahead, /decision: slow, ahead of the line, inside the slack/);
  assert.match(pace(at(84, 0.6), [], { TZ: 'UTC' }).out, /decision: hold, too far ahead of the line/, 'beyond the slack it holds');
  assert.match(pace(at(84, 0.5), [], { TZ: 'UTC' }).out, /on the line/);
  assert.match(pace(at(138, 0.95), [], { TZ: 'UTC' }).out, /decision: hold, ceiling: 95% used is at the 80% limit now/);
  assert.match(pace(at(84, 0.3, { five: 0.8 }), [], { TZ: 'UTC' }).out, /decision: slow, five-hour reading 80%/);
  const j = pace(at(84, 0.32), ['--json']).json; assert.equal(j.used, 0.32); assert.equal(j.elapsed, 0.5); assert.equal(j.hoursLeft, 84); assert.equal(j.limit, 0.8); assert.equal(j.resetsAt, iso(WEEK_END_S * 1000));
});

test('a reading older than pace.meterMaxAgeH holds and says re-probe; younger goes', () => {
  const old = pace(at(84, 0.3, { ageMin: 13 * 60 }), ['--json']); assert.equal(old.code, 3); assert.equal(old.json.decision, 'hold'); assert.equal(old.json.reprobe, true);
  assert.match(pace(at(84, 0.3, { ageMin: 13 * 60 }), [], { TZ: 'UTC' }).out, /^pace: hold · the meter reading is 13 h old \(limit 12 h\) · re-probe/);
  assert.equal(pace(at(84, 0.3, { ageMin: 11 * 60 }), ['--json']).code, 0);
  // the limit is the owner's setting
  const w = W(84, { config: { pace: { meterMaxAgeH: 6 } } }); setMeter(w, { util: 0.3, ageMin: 7 * 60 });
  assert.equal(pace(w).code, 3); setMeter(w, { util: 0.3, ageMin: 5 * 60 }); assert.equal(pace(w).code, 0);
});

test('the week boundary: one second before the reset the reading counts; one second after it is a hold that says re-probe', () => {
  const before = W(0); before.now = WEEK_END_S * 1000 - 1000; setMeter(before, { util: 0.5, ageMin: 1 });
  const b = pace(before, ['--json']); assert.equal(b.code, 0, b.err + b.out); assert.equal(b.json.decision, 'run'); assert.ok(b.json.hoursLeft <= 0.1 && b.json.elapsed >= 0.99);
  const after = W(0); after.now = WEEK_END_S * 1000 + 1000; setMeter(after, { util: 0.5, ageMin: 1 });
  const a = pace(after, ['--json']); assert.equal(a.code, 3); assert.equal(a.json.decision, 'hold'); assert.equal(a.json.reprobe, true); assert.match(a.json.detail, /week that has ended/);
  assert.match(pace(after, [], { TZ: 'UTC' }).out, /re-probe/);
  // a reading for next week's reset (the new week has begun and the meter was refreshed) paces on the new week
  const next = W(0); next.now = WEEK_END_S * 1000 + 3600000; setMeter(next, { util: 0.02, ageMin: 1, reset: WEEK_END_S + 7 * 86400 });
  const n = pace(next, ['--json']); assert.equal(n.code, 0); assert.ok(n.json.elapsed < 0.01); assert.equal(n.json.resetsAt, iso((WEEK_END_S + 7 * 86400) * 1000));
});

test('a missing or corrupt meter file holds (exit 3), says re-probe, and never falls back to the dollar budget', () => {
  const w = W(84); fs.writeFileSync(w.ledger, JSON.stringify({ at: iso(w.now - HOUR), cost_usd: 99 }) + '\n');   // plenty of spend: the old dollar path would have held for another reason
  const missing = pace(w, [], { TZ: 'UTC' }); assert.equal(missing.code, 3); assert.match(missing.out, /^pace: hold · no meter reading · re-probe/); assert.ok(!/US\$|\$/.test(missing.out));
  for (const bad of ['{ nope', '', '[]', 'null', '{"fetchedAt":"x"}', '{"utilization":"0.3","fetchedAt":"' + iso(w.now) + '"}']) {
    fs.writeFileSync(path.join(w.state, 'meter.json'), bad); const r = pace(w, ['--json']);
    assert.equal(r.code, 3, JSON.stringify(bad)); assert.equal(r.json.decision, 'hold'); assert.equal(r.json.reprobe, true);
  }
  // WK_WEEKLY_USD no longer does anything
  fs.writeFileSync(path.join(w.state, 'meter.json'), '');
  assert.equal(pace(w, [], { WK_WEEKLY_USD: '1000' }).code, 3);
  setMeter(w, { util: 0.3 }); assert.equal(pace(w, [], { WK_WEEKLY_USD: '0.01' }).code, 0, 'a tiny dollar budget does not hold a healthy meter');
});

test('the same decision under TZ=UTC and TZ=Asia/Tbilisi; only the wording of the times follows the zone', () => {
  for (const [h, util] of [[84, 0.3], [138, 0.81], [148, 0.81], [10, 0.05], [166, 0.97]]) {
    const w = at(h, util), u = pace(w, ['--json'], { TZ: 'UTC' }), t = pace(w, ['--json'], { TZ: 'Asia/Tbilisi' });
    assert.deepEqual(t.json, u.json, `h ${h}`); assert.equal(t.code, u.code);
    const ut = pace(w, [], { TZ: 'UTC' }).out, tb = pace(w, [], { TZ: 'Asia/Tbilisi' }).out;
    assert.equal(ut.replace(/[A-Z][a-z]{2} \d+ [A-Z][a-z]{2} \d\d:\d\d/g, 'T'), tb.replace(/[A-Z][a-z]{2} \d+ [A-Z][a-z]{2} \d\d:\d\d/g, 'T'), `h ${h}: only the times differ`);
  }
  const w = at(84, 0.3); assert.match(pace(w, [], { TZ: 'UTC' }).out, /to the reset \(Mon 9 Nov 02:00\)/); assert.match(pace(w, [], { TZ: 'Asia/Tbilisi' }).out, /to the reset \(Mon 9 Nov 06:00\)/);
  // the week boundary is the same instant in both zones
  const b = W(0); b.now = WEEK_END_S * 1000 - 1000; setMeter(b, { util: 0.5, ageMin: 1 });
  assert.equal(pace(b, [], { TZ: 'UTC' }).code, pace(b, [], { TZ: 'Asia/Tbilisi' }).code);
});

test('--event: the real reading of 11 Nov 2026 (from a file, a stream, and standard input), stored and paced', () => {
  const REAL = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794794400, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.32, resetsAt: 1794794400, status: 'allowed' } } } };
  const w = W(0); w.now = Date.parse('2026-11-11T05:26:00Z');
  const f = path.join(w.dir, 'real.jsonl'); fs.writeFileSync(f, JSON.stringify(REAL) + '\n');
  const r = pace(w, ['--event', f], { TZ: 'Asia/Tbilisi' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'pace: used 32% · week 31% gone · target now 31% · 1 point ahead · owner reserve 20 points held until Sun 15 Nov 06:00 · 116.6 h to the reset (Mon 16 Nov 06:00) · decision: slow, ahead of the line, inside the slack (meter 0 min old)\n');
  const m = JSON.parse(fs.readFileSync(path.join(w.state, 'meter.json'), 'utf8')); assert.equal(m.utilization, 0.32); assert.equal(m.resetsAt, 1794794400); assert.equal(m.source, 'event'); assert.equal(m.fetchedAt, iso(w.now));
  // a stream-json file with other lines around the event, and a torn line
  const w2 = W(0); w2.now = w.now; const g = path.join(w2.dir, 'stream.jsonl');
  fs.writeFileSync(g, [JSON.stringify({ type: 'system', subtype: 'init' }), '{ torn', JSON.stringify(REAL), JSON.stringify({ type: 'result', is_error: false })].join('\n') + '\n');
  assert.equal(pace(w2, ['--event', g, '--json']).json.used, 0.32);
  // standard input
  const w3 = W(0); w3.now = w.now; const s = pace(w3, ['--event', '-', '--json'], {}, JSON.stringify(REAL) + '\n'); assert.equal(s.code, 0, s.err); assert.equal(s.json.used, 0.32);
  // the Sonnet window is the highest: the pace follows it
  const w4 = W(0); w4.now = w.now; const son = JSON.parse(JSON.stringify(REAL)); son.rate_limit_info.unifiedWindows.seven_day_sonnet = { utilization: 0.88, resetsAt: 1794794400, status: 'allowed_warning' };
  const h = path.join(w4.dir, 'son.jsonl'); fs.writeFileSync(h, JSON.stringify(son) + '\n'); const so = pace(w4, ['--event', h, '--json']); assert.equal(so.json.used, 0.88); assert.equal(so.json.decision, 'hold'); assert.equal(so.code, 3);
});

test('--event errors: no file, an unreadable file, and a file with no reading exit 1 and leave the stored meter alone', () => {
  const w = at(84, 0.3), before = fs.readFileSync(path.join(w.state, 'meter.json'), 'utf8');
  assert.equal(pace(w, ['--event']).code, 1);
  assert.equal(pace(w, ['--event', path.join(w.dir, 'nope.jsonl')]).code, 1);
  const f = path.join(w.dir, 'none.jsonl'); fs.writeFileSync(f, JSON.stringify({ type: 'assistant' }) + '\n{ torn\n');
  const r = pace(w, ['--event', f]); assert.equal(r.code, 1); assert.match(r.err, /no seven-day or five-hour reading/);
  assert.equal(fs.readFileSync(path.join(w.state, 'meter.json'), 'utf8'), before);
});

test('a bad owner config exits 1 with a message, and nothing is written to the real home', () => {
  const w = W(84); setMeter(w, { util: 0.3 }); setConfig(w, { week: { anchor: '2026-01-05T02:00:00' } });
  const r = pace(w); assert.equal(r.code, 1); assert.match(r.err, /week\.anchor/);
  setConfig(w, {});
  assert.equal(pace(w).code, 0);
  assert.ok(w.home.startsWith(path.dirname(w.state)), 'the temp home sits in the temp world'); assert.deepEqual(fs.readdirSync(w.home), []);
});

test('wk-ledger add, context, summary and spike still work as before', () => {
  const w = W(84), run = (args, input = '') => spawnSync(process.execPath, [LEDGER, ...args], { env: env(w, { WK_NOW: iso(w.now), WK_TZ_UTC: '1' }), encoding: 'utf8', input });
  const a = run(['add', 'T-1', '1'], JSON.stringify({ total_cost_usd: 0.5, num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 } })); assert.equal(a.status, 0); assert.equal(JSON.parse(a.stdout).item, 'T-1');
  assert.equal(run(['spike']).status, 0);
  const rows = ['2026-11-05', '2026-11-06', '2026-11-07'].map(d => JSON.stringify({ at: d + 'T10:00:00Z', cost_usd: 1 })); fs.writeFileSync(w.ledger, rows.join('\n') + '\n' + JSON.stringify({ at: iso(w.now), cost_usd: 30 }) + '\n');
  assert.equal(run(['spike']).status, 3);
  assert.equal(run(['bogus']).status, 1);
});

test('the weekly report carries the same pace line', () => {
  const w = at(84, 0.32, { ageMin: 3 }), r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-steward.mjs'), 'report'], { env: env(w, { WK_NOW: iso(w.now), TZ: 'UTC' }), encoding: 'utf8', cwd: w.dir });
  assert.equal(r.status, 0, r.stderr);
  const line = pace(w, [], { TZ: 'UTC' }).out.trim();
  assert.ok(r.stdout.split('\n').includes(line), `the report holds the ledger line:\n${r.stdout}`);
  const j = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-steward.mjs'), 'report', '--json'], { env: env(w, { WK_NOW: iso(w.now) }), encoding: 'utf8', cwd: w.dir });
  assert.equal(JSON.parse(j.stdout).pace.decision, 'run'); assert.match(r.stdout, /Tokens per visit/);
});
