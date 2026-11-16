// Week tests for the steward (P2-187): the owner's main claim, run end to end through the command line against the fake claude.
// The steward spends the weekly limit across exactly one week, never ahead of the straight line, rotates fairly, never repeats
// itself, tunes itself one proven step at a time, keeps nothing private in its files and survives crashes.
// Every expected number below was worked out by hand from bin/steward-lib.mjs and config/steward.json (see the comments).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkWorld, env, run, start, events, calls, ledger, stateFile, setUtil, waitFor, pidAlive, cleanup, NOW0, WEEK_START, WEEK_END_S, HOUR, DAY, iso } from './fixtures/world.mjs';

const w0 = mkWorld({ projects: 1 });
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) || /^CLAUDE_CODE_USE_/.test(k) || k === 'CLAUDE_PLUGIN_ROOT' || k === 'WK_LANE') delete process.env[k];
Object.assign(process.env, env(w0));
const { scanPII } = await import('../bin/lib.mjs');

const leftover = new Set();   // pids this file started; any still alive at the end are killed
after(() => { for (const pid of leftover) { try { process.kill(pid, 'SIGKILL'); } catch {} } cleanup(); });

const r3 = v => +v.toFixed(3);
const tickAt = (w, ms, extra = {}) => run(w, ['tick', '--json'], { WK_NOW: iso(ms), ...extra });
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const filesUnder = d => { const out = []; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) out.push(...filesUnder(p)); else if (e.isFile()) out.push(p); } return out; };
// fake secrets in the steward's own environment: login mode must strip them before any call, and they must never reach a file
const FAKE_SECRETS = { ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_AUTH_TOKEN: 'test-token-not-real' };

// ================================================================ 1. a faked week
// Owner config: phase 'full' gives a daily cap of max(1, ceil(6 x 1)) = 6 (the default phase 'shadow' would give 2 and bind).
// The 7-hour spacing puts at most 4 visit starts in any 24 h, so the cap of 6 and the 45-min gap never bind. inbox.autoMax 500:
// the fake's ideas are all gate 'auto' (kinds code..admin, impact 3 < askImpact 4), and 19 visits x 4 ideas = 76 would pass the
// default 40 and drop ideas as queue_full. No transcripts exist, so "owner active" never holds; the meter is always readable,
// so the unknown-meter cap never applies. Only the pace decides.
const W = mkWorld({ projects: 3, config: { pace: { phase: 'full' }, call: { maxPerDay: 6 }, inbox: { autoMax: 500 } } });
const HOURS = [...Array.from({ length: 24 }, (_, k) => 1 + 7 * k), 167];   // 1, 8, ..., 162, then 167: 25 steps
// the owner's own use of the week, as a share of the weekly limit
const ownerUse = h => { const e = h / 168; if (h < 70) return 0.7 * e; if (h < 90) return e + 0.10; if (h < 155) return 85 / 168 + 0.10; return { 155: 0.93, 162: 0.985, 167: 0.995 }[h]; };
// By hand (pace: ceiling 0.92, landTo 0.99, lastHours 6, aheadSlack 0.03; elapsed e = h/168, hoursLeft = 168 - h):
// h < 70: 0.7e <= e + 0.03, go. 71, 78, 85: e + 0.10 > e + 0.03, ahead. 92: 0.606 > 0.548 + 0.03 = 0.578, ahead.
// 99..148: 0.606 <= e + 0.03 (0.619 at 99), go. 155: 0.93 >= 0.92 with 13 h left, ceiling.
// 162: exactly 6 h left, so hoursLeft <= lastHours is true: the last stretch, limit landTo 0.99; 0.985 < 0.99 and
//      0.985 <= 0.964 + 0.03 = 0.994, go. 167: 0.995 >= 0.99, landed.
const HOLD = { 71: 'ahead', 78: 'ahead', 85: 'ahead', 92: 'ahead', 155: 'ceiling', 167: 'landed' };
// Fair rotation by the deficit rule, weights 3, 2, 1: the order repeats every 6 visits (a b g a b a); 19 visits = 3 x 6 + 1.
const ORDER = [...'abgaba'.repeat(3), 'a'].map(c => ({ a: 'alpha', b: 'beta', g: 'gamma' })[c]);
// Lenses: the least recently used first, in config order; a wildcard on each project's 5th and 10th visit (wildcardEvery 5).
const LENSES = ['finish', 'features', 'fixes', 'content', 'growth', 'outreach', 'competitors', 'money', 'risk', 'delight'];
const LENS_SEQ = { alpha: ['finish', 'features', 'fixes', 'content', 'wildcard', 'growth', 'outreach', 'competitors', 'money', 'wildcard'],
  beta: ['finish', 'features', 'fixes', 'content', 'wildcard', 'growth'], gamma: ['finish', 'features', 'fixes'] };
const steps = [];

test('week: 25 ticks across one week, each held or run exactly as the pace says', () => {
  for (const h of HOURS) {
    setUtil(W, ownerUse(h));
    const r = tickAt(W, WEEK_START + h * HOUR, { FAKE_UTIL_FILE: W.utilFile, ...FAKE_SECRETS });
    steps.push({ h, ...r });
    if (HOLD[h]) {
      assert.equal(r.code, 3, `h ${h}: held, exit 3 (${r.out}${r.err})`);
      assert.equal(r.json?.held, 'pace', `h ${h}`);
      assert.ok(r.json.detail.startsWith(HOLD[h] + ':'), `h ${h}: ${r.json.detail}`);
    } else {
      assert.equal(r.code, 0, `h ${h}: a visit, exit 0 (${r.out}${r.err})`);
      assert.equal(r.json?.outcome, 'ok', `h ${h}`);
      assert.equal(r.json.kept, 4, `h ${h}: 4 ideas kept`);
    }
  }
  assert.equal(steps.filter(s => s.code === 0).length, 19);
});

test('week: 19 visits, pace holds at 71, 78, 85, 92 (ahead), 155 (ceiling) and 167 (landed)', () => {
  const started = events(W, 'tick_started'), held = events(W, 'tick_held'), finished = events(W, 'tick_finished');
  assert.equal(started.length, 19); assert.equal(finished.length, 19); assert.ok(finished.every(e => e.outcome === 'ok'));
  assert.deepEqual(held.map(e => [Math.round((Date.parse(e.at) - WEEK_START) / HOUR), e.reason, e.detail.split(':')[0]]),
    Object.entries(HOLD).map(([h, why]) => [+h, 'pace', why]));
  assert.deepEqual(started.map(e => Math.round((Date.parse(e.at) - WEEK_START) / HOUR)), HOURS.filter(h => !HOLD[h]));
});

test('week: every visit starts on or behind the straight line plus the slack, read from the meter', () => {
  for (const e of events(W, 'tick_started')) {
    const h = Math.round((Date.parse(e.at) - WEEK_START) / HOUR);
    assert.equal(e.pace.source, 'meter', `h ${h}`);
    assert.equal(e.pace.used, r3(ownerUse(h)), `h ${h}: used`); assert.equal(e.pace.elapsed, r3(h / 168), `h ${h}: elapsed`);
    assert.ok(e.pace.used <= e.pace.elapsed + 0.03, `h ${h}: ${e.pace.used} <= ${e.pace.elapsed} + 0.03`);
    assert.equal(e.phase, 'full'); assert.equal(e.mode, 'login');
  }
});

test('week: 6 h before the reset counts as the last stretch (limit landTo 0.99), so h 162 runs; 155 and 167 stop at their limits', () => {
  const s162 = events(W, 'tick_started').find(e => Math.round((Date.parse(e.at) - WEEK_START) / HOUR) === 162);
  assert.ok(s162, 'a visit at h 162');
  assert.equal(s162.pace.limit, 0.99); assert.equal(s162.pace.used, 0.985); assert.equal(s162.pace.headroom, 0.005);
  const at = h => events(W, 'tick_held').find(e => Math.round((Date.parse(e.at) - WEEK_START) / HOUR) === h);
  assert.deepEqual([at(155).pace.limit, at(155).pace.used], [0.92, 0.93]);
  assert.deepEqual([at(167).pace.limit, at(167).pace.used], [0.99, 0.995]);
});

test('week: 23 meter probes and 19 main calls (S1: no probe at the two ahead-holds); the ledger total is the sum of the fake costs', () => {
  const c = calls(W), probes = c.filter(x => x.probe), main = c.filter(x => !x.probe);
  // S1 (P2-187 review): meter.json is older than meterFreshMin (20 min) at every step, but at h 78 and h 92 the stored meter (7 h old, from the probe at h 71 / h 85)
  // already reads ahead of the line, so the hold needs no probe. Before the fix this was 25 probes, one per step.
  assert.equal(probes.length, 23); assert.equal(main.length, 19);
  assert.ok(c.every(x => x.apiKeySource === 'none' && x.env.key === false && x.env.token === false), 'no key reached the fake');
  const L = ledger(W);
  assert.equal(L.filter(r => r.item === 'steward:probe').length, 23); assert.equal(L.filter(r => /^steward:(alpha|beta|gamma)$/.test(r.item)).length, 19);
  const total = L.reduce((s, r) => s + r.cost_usd, 0), expected = 23 * 0.0006 + 19 * 0.012;
  assert.ok(Math.abs(total - expected) < 1e-9, `ledger ${total}, fake ${expected}`); assert.ok(Math.abs(total - 0.2418) < 1e-9);
});

test('week: fair rotation, alpha 10, beta 6, gamma 3 in the order a b g a b a', () => {
  const started = events(W, 'tick_started'), n = { alpha: 0, beta: 0, gamma: 0 };
  assert.deepEqual(started.map(e => e.project), ORDER);
  for (const e of started) n[e.project]++;
  assert.deepEqual(n, { alpha: 10, beta: 6, gamma: 3 });
  for (const [id, wt] of [['alpha', 3], ['beta', 2], ['gamma', 1]]) assert.ok(Math.abs(n[id] - 19 * wt / 6) <= 1, `${id} within 1 of its share`);
});

test('week: lenses never repeat for a project until the non-wildcard lenses run out; a wildcard every 5th visit', () => {
  const started = events(W, 'tick_started');
  for (const id of ['alpha', 'beta', 'gamma']) {
    const mine = started.filter(e => e.project === id);
    assert.deepEqual(mine.map(e => e.lens), LENS_SEQ[id], id);
    assert.ok(mine.every(e => e.wild === (e.lens === 'wildcard')), `${id}: wild flag`);
    const plain = mine.filter(e => !e.wild).map(e => e.lens).slice(0, LENSES.length);
    assert.equal(new Set(plain).size, plain.length, `${id}: ${plain}`);
  }
});

test('week: 76 ideas, no title twice; no unfinished visit and no lock at the end; the saved report agrees', () => {
  const ideas = events(W, 'idea_added'), titles = ideas.map(i => i.title.toLowerCase());
  assert.equal(ideas.length, 76); assert.equal(new Set(titles).size, titles.length, 'no duplicate idea titles');
  assert.equal(new Set(ideas.map(i => i.id)).size, 76);
  const fin = new Set(events(W, 'tick_finished').map(e => e.tick));
  assert.deepEqual(events(W, 'tick_started').filter(e => !fin.has(e.tick)), []);
  assert.equal(fs.existsSync(path.join(W.state, 'tick.lock')), false);
  const r = run(W, ['report', '--save', '--json'], { WK_NOW: iso(WEEK_START + 167 * HOUR) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.weekEnds, iso(WEEK_END_S * 1000)); assert.equal(r.json.visits, 19); assert.deepEqual(r.json.byProject, { alpha: 10, beta: 6, gamma: 3 });
  assert.deepEqual(r.json.held, { pace: 6 }); assert.equal(r.json.spendUsd, 0.2418); assert.equal(r.json.ideasAdded, 76);
  assert.equal(r.json.used, 0.99, 'the week ends at 99.5%, rounded to 0.99');
  assert.ok(fs.existsSync(path.join(W.state, 'reports', '2026-11-09.json')));
});

// ================================================================ 2. self-tuning across visits
// R3: at least 4 answered ideas and an accept share under 0.30 raise minImpact by one step (2 to 3) as a pending change.
// It is judged on ideas filed after the change (id >= ideaSeq): kept when 4 of them (evalSamples.answers) are answered and the
// accept share beats the baseline by at least noise 0.15. The tuning log keeps its last 200 lines once it passes 400.
const T = mkWorld({ projects: 1, config: { pace: { phase: 'full' } } });
const tt = (k, extra = {}) => tickAt(T, NOW0 + k * HOUR, { FAKE_UTIL: '0.3', FAKE_LOG_PROMPT: '1', ...extra });
const answer = (id, a) => { const r = run(T, ['answer', id, a, 'test note']); assert.equal(r.code, 0, r.err); };
const tuning = () => stateFile(T, 'tuning.json');
const logLines = () => (readText(path.join(T.state, 'tuning.log.jsonl')) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('tuning: four "no" answers make R3 raise minImpact from 2 to 3 as a pending change', () => {
  let r = tt(0); assert.equal(r.code, 0, r.out + r.err); assert.equal(r.json.kept, 4);
  assert.equal(tuning(), null, 'nothing to tune after one visit with no answers');
  for (const id of ['i1', 'i2', 'i3', 'i4']) answer(id, 'no');
  // 399 old lines: the change makes 400, which is not over the limit, so nothing is trimmed yet
  fs.writeFileSync(path.join(T.state, 'tuning.log.jsonl'), Array.from({ length: 399 }, (_, i) => JSON.stringify({ at: iso(NOW0 - 30 * DAY), kind: 'filler', n: i + 1 })).join('\n') + '\n');
  r = tt(1); assert.equal(r.code, 0, r.out + r.err);
  const t = tuning();
  assert.equal(t.knobs.minImpact, 3);
  assert.deepEqual(t.pending, { id: 'c1', rule: 'R3', knob: 'minImpact', dir: 'up', from: 2, to: 3, metric: 'accept', better: 'higher', source: 'answers', baseline: 0,
    startedAt: iso(NOW0 + HOUR), tickCount: 2, ideaSeq: 9 });
  const L = logLines(); assert.equal(L.length, 400);
  assert.deepEqual(L.at(-1), { at: iso(NOW0 + HOUR), kind: 'change', rule: 'R3', knob: 'minImpact', from: 2, to: 3, metric: 'accept', baseline: 0 });
});

test('tuning: the next visit asks for impact 3; three "yes" answers are not enough to judge, the fourth keeps the change', () => {
  let r = tt(2); assert.equal(r.code, 0, r.out + r.err);
  assert.equal(events(T, 'tick_started').at(-1).minImpact, 3);
  assert.match(calls(T).filter(c => !c.probe).at(-1).prompt, /WANT: 4 ideas, impact 3 or more\./);
  assert.ok(tuning().pending, 'still pending: none of the new ideas is answered');
  for (const id of ['i9', 'i10', 'i11']) answer(id, 'yes');
  r = tt(3); assert.equal(r.code, 0, r.out + r.err);
  assert.equal(tuning().pending?.id, 'c1', 'three answers: not enough samples yet'); assert.equal(logLines().length, 400);
  answer('i12', 'yes');
  r = tt(4); assert.equal(r.code, 0, r.out + r.err);
  const t = tuning();
  assert.equal(t.pending, null); assert.equal(t.knobs.minImpact, 3, 'kept');
  assert.deepEqual(t.blocks, [{ knob: 'minImpact', dir: 'down', until: iso(NOW0 + 4 * HOUR + 7 * DAY) }]);
  // the keep made 401 lines, over 400, so only the last 200 stay: fillers 202..399, then the change, then the keep
  const L = logLines(); assert.equal(L.length, 200);
  assert.deepEqual(L[0], { at: iso(NOW0 - 30 * DAY), kind: 'filler', n: 202 });
  assert.equal(L[198].kind, 'change');
  assert.deepEqual(L[199], { at: iso(NOW0 + 4 * HOUR), kind: 'keep', rule: 'R3', knob: 'minImpact', value: 3, metric: 'accept', baseline: 0, now: 1, gain: 1 });
});

// ================================================================ 3. privacy of every file the steward writes
test('privacy: no file in the state folders or the ledgers carries private data or a fake key', () => {
  const files = [...filesUnder(W.state), ...filesUnder(T.state), W.ledger, T.ledger];
  const names = files.map(f => path.relative(path.dirname(path.dirname(f)), f));
  for (const want of ['events.jsonl', 'meter.json', 'tuning.json', 'tuning.log.jsonl', '2026-11-09.json']) assert.ok(files.some(f => path.basename(f) === want), `${want} was scanned`);
  assert.ok(files.some(f => f.includes(path.sep + 'raw' + path.sep)), 'raw files were scanned');
  // One known false positive: meter.json stores the reset time as epoch seconds ("resetsAt":1794189600), and the lane's phone
  // pattern matches any run of 10 or more digits. That number comes from the CLI's rate event, not from a person. So the scan
  // masks exactly that one value, and the raw meter file must hit 'phone' and nothing else (a new hit there still fails).
  const RESET = `"resetsAt":${WEEK_END_S}`;
  for (const f of files) {
    const text = readText(f);
    assert.ok(!text.includes('test-key-not-real') && !text.includes('test-token-not-real'), `${f}: a fake key`);
    if (path.basename(f) === 'meter.json') { assert.ok(text.includes(RESET), f); assert.deepEqual(scanPII(text), ['phone'], `${f}: only the reset epoch`); }
    const masked = text.split(RESET).join('"resetsAt":0');
    assert.deepEqual(scanPII(masked), [], `${f}: ${scanPII(masked)}`);
  }
  // the fake's own log records only whether a key was present, never a value
  for (const f of [W.fakeLog, T.fakeLog]) assert.ok(!readText(f).includes('not-real'), f);
  assert.ok(names.length > 10);
});

// ================================================================ 4. crash and recovery
test('crash: a visit killed mid-call leaves a lock and an unfinished tick; the next tick takes the lock and closes it as killed', async () => {
  const w = mkWorld({ projects: 1, config: { pace: { phase: 'full' } } });
  const s = start(w, ['tick', '--json'], { FAKE_MODE: 'hang', FAKE_UTIL: '0.3' }); leftover.add(s.p.pid);
  const hung = await waitFor(() => events(w, 'tick_started').length === 1 && calls(w).find(c => !c.probe && c.mode === 'hang'));
  leftover.add(hung.pid);
  assert.deepEqual(stateFile(w, 'tick.lock'), { pid: s.p.pid, at: iso(NOW0) });
  const busy = tickAt(w, NOW0, { FAKE_UTIL: '0.3' });   // a live holder keeps the lock
  assert.equal(busy.code, 3); assert.equal(busy.json.held, 'lock'); assert.match(busy.json.detail, new RegExp(`pid ${s.p.pid}`));
  s.p.kill('SIGKILL'); process.kill(hung.pid, 'SIGKILL');
  const d = await s.done; assert.equal(d.signal, 'SIGKILL');
  await waitFor(() => !pidAlive(s.p.pid) && !pidAlive(hung.pid));
  const tick = events(w, 'tick_started')[0].tick;
  assert.deepEqual(events(w, 'tick_finished'), []); assert.ok(fs.existsSync(path.join(w.state, 'tick.lock')));
  assert.equal(fs.existsSync(path.join(w.state, 'raw', `${tick}.json`)), false, 'killed before the answer: no raw file');
  // 10 min later: the lock is only 10 min old, so it is taken over because its pid is dead; recovery runs before the gap check
  const r1 = tickAt(w, NOW0 + 10 * 60000, { FAKE_UTIL: '0.3' });
  assert.equal(r1.code, 3); assert.equal(r1.json.held, 'gap', r1.out);
  const fin = events(w, 'tick_finished');
  assert.equal(fin.length, 1);
  assert.deepEqual([fin[0].tick, fin[0].outcome, fin[0].reason, fin[0].project], [tick, 'error', 'killed', 'alpha']);
  assert.equal(fs.existsSync(path.join(w.state, 'tick.lock')), false);
  const r2 = tickAt(w, NOW0 + HOUR, { FAKE_UTIL: '0.3' });
  assert.equal(r2.code, 0, r2.out + r2.err); assert.equal(r2.json.outcome, 'ok');
  assert.equal(events(w, 'tick_finished').filter(e => e.tick === tick).length, 1, 'closed once');
  const done = new Set(events(w, 'tick_finished').map(e => e.tick));
  assert.deepEqual(events(w, 'tick_started').filter(e => !done.has(e.tick)), []);
  assert.equal(fs.existsSync(path.join(w.state, 'tick.lock')), false);
});

// visit writes raw/<tick>.json after the call returns and before ingest files anything (steward-lib.mjs: the writeAtomic before
// `ingest`). A crash in that gap, or part way through ingest, leaves: the raw file, the ledger row, the meter, tick_started and
// the first `keep` idea_added events, but no tick_finished. This helper makes that state honestly: it runs a real visit, then
// cuts the event log back to what had been written at the crash.
function crashAfterRaw(keep) {
  const w = mkWorld({ projects: 1, config: { pace: { phase: 'full' } } });
  const r = tickAt(w, NOW0, { FAKE_UTIL: '0.3' }); assert.equal(r.code, 0, r.out + r.err);
  const f = path.join(w.state, 'events.jsonl'), lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean), ev = lines.map(l => JSON.parse(l));
  const s = ev.findIndex(e => e.type === 'tick_started'), tick = ev[s].tick;
  assert.deepEqual(ev.slice(s + 1).map(e => e.type), ['idea_added', 'idea_added', 'idea_added', 'idea_added', 'tick_finished']);
  assert.ok(fs.existsSync(path.join(w.state, 'raw', `${tick}.json`)));
  const titles = ev.filter(e => e.type === 'idea_added').map(e => e.title);
  fs.writeFileSync(f, lines.slice(0, s + 1 + keep).join('\n') + '\n');
  return { w, tick, titles };
}
for (const keep of [0, 2, 4]) {
  test(`recovery: an unfinished visit with its raw answer and ${keep} of 4 ideas filed is recovered, each idea filed exactly once`, () => {
    const { w, tick, titles } = crashAfterRaw(keep);
    const r = tickAt(w, NOW0 + HOUR, { FAKE_UTIL: '0.3' }); assert.equal(r.code, 0, r.out + r.err); assert.equal(r.json.outcome, 'ok');
    const fin = events(w, 'tick_finished').filter(e => e.tick === tick);
    assert.equal(fin.length, 1);
    assert.equal(fin[0].outcome, 'recovered'); assert.equal(fin[0].proposed, 4); assert.equal(fin[0].kept, 4 - keep);
    assert.deepEqual(fin[0].dropped, keep ? { dupe: keep } : {});
    const mine = events(w, 'idea_added').filter(e => e.tick === tick);
    assert.deepEqual(mine.map(e => e.title).sort(), titles.slice().sort(), 'the same four ideas, once each');
    assert.deepEqual(mine.map(e => e.id), ['i1', 'i2', 'i3', 'i4']);
    const all = events(w, 'idea_added').map(e => e.title.toLowerCase());
    assert.equal(all.length, 8); assert.equal(new Set(all).size, 8, 'no duplicate titles after recovery and a new visit');
    // a later tick does not recover it again
    const r2 = tickAt(w, NOW0 + 2 * HOUR, { FAKE_UTIL: '0.3' }); assert.equal(r2.code, 0, r2.out + r2.err);
    assert.equal(events(w, 'tick_finished').filter(e => e.tick === tick).length, 1);
    assert.equal(events(w, 'idea_added').filter(e => e.tick === tick).length, 4);
  });
}

test('limit: after a "limit" outcome the steward waits for the reset, then runs again', () => {
  const w = mkWorld({ projects: 1, config: { pace: { phase: 'full' } } });
  const reset = Math.floor(NOW0 / 1000) + 3 * 3600;
  const r1 = tickAt(w, NOW0, { FAKE_MODE: 'limit', FAKE_LIMIT_RESET: String(reset), FAKE_UTIL: '0.3' });
  assert.equal(r1.code, 4, r1.out + r1.err); assert.equal(r1.json.outcome, 'limit'); assert.equal(r1.json.until, iso(reset * 1000));
  const f1 = events(w, 'tick_finished').at(-1); assert.deepEqual([f1.outcome, f1.until], ['limit', iso(reset * 1000)]);
  const bo = stateFile(w, 'backoff.json'); assert.deepEqual([bo.until, bo.count, bo.reason], [reset * 1000, 1, 'limit']);
  const nCalls = calls(w).length; assert.equal(nCalls, 2, 'the probe and the call');
  const r2 = tickAt(w, reset * 1000 - 60000, { FAKE_UTIL: '0.3' });
  assert.equal(r2.code, 3); assert.equal(r2.json.held, 'backoff'); assert.equal(r2.json.until, iso(reset * 1000));
  assert.equal(calls(w).length, nCalls, 'no call while waiting, not even the probe');
  const r3x = tickAt(w, reset * 1000 + 60000, { FAKE_UTIL: '0.3' });
  assert.equal(r3x.code, 0, r3x.out + r3x.err); assert.equal(r3x.json.outcome, 'ok'); assert.equal(r3x.json.kept, 4);
  assert.equal(stateFile(w, 'backoff.json'), null, 'a good call clears the backoff');
});
