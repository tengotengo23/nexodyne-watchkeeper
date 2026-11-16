// Idea tests for the steward (P2-187): filing ideas (ingest), recovery of unfinished visits, self-tuning, the inbox, answers,
// the status snapshot, the weekly report, the phase switch and init. In-process; everything lives in a temp world (test/fixtures/world.mjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkWorld, env, cleanup, setConfig, run, setMeter, NOW0, WEEK_START, WEEK_END_S, HOUR, DAY, iso } from './fixtures/world.mjs';

const w0 = mkWorld({ projects: 3 });
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) || /^CLAUDE_CODE_USE_/.test(k) || k === 'CLAUDE_PLUGIN_ROOT' || k === 'WK_LANE') delete process.env[k];
Object.assign(process.env, env(w0));
const S = await import('../bin/steward-lib.mjs');
after(cleanup);

let nFresh = 0;
function fresh() {   // a new empty state folder and ledger inside the temp world
  const d = path.join(w0.dir, 'fresh-' + (++nFresh)); fs.mkdirSync(d, { recursive: true });
  process.env.WK_STEWARD_DIR = path.join(d, 'state'); process.env.WK_LEDGER = path.join(d, 'ledger.jsonl'); return d;
}
const cfgWith = obj => { setConfig(w0, obj); return S.loadConfig(); };
const C = () => cfgWith({});
const E = (type, o = {}, atMs = NOW0) => ({ type, at: iso(atMs), ...o });
const evs = type => S.readEvents().filter(e => !type || e.type === type);
const sf = (...p) => path.join(S.stewardDir(), ...p);

// ---------------------------------------------------------------- helpers for ideas
const TITLES = ['Add a lesson progress bar', 'Write a welcome guide for newcomers', 'Check the footer links on mobile', 'Sort the glossary by topic', 'Draft a calm onboarding tour', 'Plan a friendly feedback form'];
const ctx = (o = {}) => ({ project: 'alpha', lens: 'finish', wild: false, tick: 't000001', want: 4, minImpact: 2, ...o });
const idea = (title, o = {}) => ({ title, why: 'A short reason for it', kind: 'content', impact: 3, effort: 2, gate: 'ask', ...o });
const res = (ideas, o = {}) => ({ total_cost_usd: 0.01, structured_output: { ideas }, ...o });

// ---------------------------------------------------------------- 1. ingest
test('ingest: files ideas and one assumption, closes the tick, returns the counts', () => {
  fresh(); const cfg = C();
  const r = S.ingest({ cfg, ctx: ctx(), res: res([idea(TITLES[0], { kind: 'code', effort: 2, gate: 'auto' }), idea(TITLES[1], { effort: 1 })], { total_cost_usd: 0.123456789, structured_output: { ideas: [idea(TITLES[0], { kind: 'code', effort: 2, gate: 'auto' }), idea(TITLES[1], { effort: 1 })], qa: [{ q: 'Who uses it?', a: 'Beginners' }] } }) });
  assert.deepEqual(r, { proposed: 2, kept: 2, dropped: {}, qa: 1 });
  const added = evs('idea_added');
  // same impact: the lower effort comes first, so the welcome guide is i1 and the progress bar i2
  assert.deepEqual(added.map(e => [e.id, e.title, e.gate, e.effort]), [['i1', TITLES[1], 'ask', 1], ['i2', TITLES[0], 'auto', 2]]);
  assert.equal(added[0].ask, 'Should I go ahead with this?', 'a non-auto idea without an ask gets the default question');
  assert.equal('ask' in added[1], false, 'an auto idea carries no ask');
  assert.deepEqual([added[0].project, added[0].lens, added[0].wild, added[0].tick, added[0].kind, added[0].impact], ['alpha', 'finish', false, 't000001', 'content', 3]);
  assert.deepEqual(evs('assumption').map(e => [e.id, e.project, e.q, e.a, e.tick]), [['a1', 'alpha', 'Who uses it?', 'Beginners', 't000001']]);
  const fin = evs('tick_finished'); assert.equal(fin.length, 1);
  assert.deepEqual({ ...fin[0], at: undefined }, { type: 'tick_finished', at: undefined, tick: 't000001', outcome: 'ok', project: 'alpha', lens: 'finish', wild: false, cost_usd: 0.12346, proposed: 2, kept: 2, dropped: {}, qa: 1 });
});

test('ingest: ids continue after the existing ones', () => {
  fresh(); const cfg = C();
  S.ingest({ cfg, ctx: ctx(), res: res([idea(TITLES[0]), idea(TITLES[1])], { structured_output: { ideas: [idea(TITLES[0]), idea(TITLES[1])], qa: [{ q: 'First?', a: 'Yes' }] } }) });
  S.ingest({ cfg, ctx: ctx({ tick: 't000002' }), res: res([idea(TITLES[2]), idea(TITLES[3])], { structured_output: { ideas: [idea(TITLES[2]), idea(TITLES[3])], qa: [{ q: 'Second?', a: 'No' }] } }) });
  assert.deepEqual(evs('idea_added').map(e => e.id), ['i1', 'i2', 'i3', 'i4']);
  assert.deepEqual(evs('assumption').map(e => e.id), ['a1', 'a2']);
});

test('ingest: a duplicate is dropped inside one project but not across projects', () => {
  fresh(); const cfg = C();
  S.ingest({ cfg, ctx: ctx(), res: res([idea(TITLES[0])]) });
  const again = S.ingest({ cfg, ctx: ctx({ tick: 't000002' }), res: res([idea(TITLES[0])]) });
  assert.deepEqual(again, { proposed: 1, kept: 0, dropped: { dupe: 1 }, qa: 0 });
  const other = S.ingest({ cfg, ctx: ctx({ project: 'beta', tick: 't000003' }), res: res([idea(TITLES[0])]) });
  assert.deepEqual(other, { proposed: 1, kept: 1, dropped: {}, qa: 0 });
  assert.deepEqual(evs('idea_added').map(e => [e.id, e.project]), [['i1', 'alpha'], ['i2', 'beta']]);
  assert.deepEqual(evs('tick_finished').map(e => [e.kept, e.dropped]), [[1, {}], [0, { dupe: 1 }], [1, {}]]);
});

test('ingest: inbox.autoMax 1 keeps one of three auto ideas and drops two as queue_full', () => {
  fresh(); const cfg = cfgWith({ inbox: { autoMax: 1 } });
  const auto = (t, effort) => idea(t, { kind: 'code', gate: 'auto', effort });
  const r = S.ingest({ cfg, ctx: ctx(), res: res([auto(TITLES[0], 1), auto(TITLES[1], 2), auto(TITLES[2], 3)]) });
  assert.deepEqual(r, { proposed: 3, kept: 1, dropped: { queue_full: 2 }, qa: 0 });
  assert.deepEqual(evs('idea_added').map(e => [e.id, e.title]), [['i1', TITLES[0]]]);
  C();
});

test('ingest: inbox.perProject counts only ask and wait ideas of that project; auto and answered ideas do not count', () => {
  fresh(); const cfg = cfgWith({ inbox: { perProject: 1 } });
  const r = S.ingest({ cfg, ctx: ctx(), res: res([idea(TITLES[0], { kind: 'code', gate: 'auto', effort: 1 }), idea(TITLES[1], { effort: 2 }), idea(TITLES[2], { effort: 3 })]) });
  assert.deepEqual(r, { proposed: 3, kept: 2, dropped: { inbox_full: 1 }, qa: 0 });
  assert.deepEqual(evs('idea_added').map(e => [e.id, e.gate]), [['i1', 'auto'], ['i2', 'ask']]);
  // another project has its own room
  assert.equal(S.ingest({ cfg, ctx: ctx({ project: 'beta', tick: 't000002' }), res: res([idea(TITLES[3])]) }).kept, 1);
  // once the owner answers i2 it no longer counts, so alpha has room again
  S.answerIdea('i2', 'no', '');
  assert.equal(S.ingest({ cfg, ctx: ctx({ tick: 't000003' }), res: res([idea(TITLES[4])]) }).kept, 1);
  C();
});

test('ingest: inbox.total counts non-auto ideas over all projects', () => {
  fresh(); const cfg = cfgWith({ inbox: { total: 2 } });
  assert.equal(S.ingest({ cfg, ctx: ctx(), res: res([idea(TITLES[0], { effort: 1 }), idea(TITLES[1], { effort: 2 })]) }).kept, 2);
  const r = S.ingest({ cfg, ctx: ctx({ project: 'beta', tick: 't000002' }), res: res([idea(TITLES[2]), idea(TITLES[3], { kind: 'code', gate: 'auto', effort: 5 })]) });
  // the ask idea sorts first (effort 2 against 5) and is refused; the auto idea is not under the total
  assert.deepEqual(r, { proposed: 2, kept: 1, dropped: { inbox_full: 1 }, qa: 0 });
  assert.deepEqual(evs('idea_added').map(e => [e.id, e.project, e.gate]), [['i1', 'alpha', 'ask'], ['i2', 'alpha', 'ask'], ['i3', 'beta', 'auto']]);
  C();
});

test('ingest: recovered gives outcome recovered; res.result (a JSON string) is used without structured_output', () => {
  fresh(); const cfg = C();
  const r = S.ingest({ cfg, ctx: ctx(), recovered: true, res: { result: JSON.stringify({ ideas: [idea(TITLES[0])], qa: [{ q: 'Q one?', a: 'A one' }] }) } });
  assert.deepEqual(r, { proposed: 1, kept: 1, dropped: {}, qa: 1 });
  const fin = evs('tick_finished')[0];
  assert.equal(fin.outcome, 'recovered'); assert.equal(fin.cost_usd, null, 'no cost in the result gives null');
  assert.equal(evs('idea_added').length, 1);
});

// ---------------------------------------------------------------- 2. recoverUnfinished
const startTick = (tick, project = 'alpha', lens = 'finish') => S.appendEvent({ type: 'tick_started', tick, project, lens }, NOW0 - HOUR);
const writeRaw = (tick, obj) => { fs.mkdirSync(sf('raw'), { recursive: true }); fs.writeFileSync(sf('raw', `${tick}.json`), JSON.stringify(obj)); };

test('recoverUnfinished: nothing unfinished gives []', () => {
  fresh(); const cfg = C();
  assert.deepEqual(S.recoverUnfinished(cfg), []);
  startTick('t000001'); S.appendEvent({ type: 'tick_finished', tick: 't000001', outcome: 'ok', project: 'alpha' });
  assert.deepEqual(S.recoverUnfinished(cfg), []);
  assert.equal(evs('tick_finished').length, 1);
});

test('recoverUnfinished: a saved raw answer is filed once as recovered', () => {
  fresh(); const cfg = C();
  startTick('t000001');
  writeRaw('t000001', { tick: 't000001', ctx: ctx(), res: res([idea(TITLES[0]), idea(TITLES[1])]) });
  assert.deepEqual(S.recoverUnfinished(cfg), [{ tick: 't000001', outcome: 'recovered' }]);
  assert.equal(evs('idea_added').length, 2);
  const fin = evs('tick_finished'); assert.equal(fin.length, 1); assert.equal(fin[0].outcome, 'recovered'); assert.equal(fin[0].kept, 2);
  assert.deepEqual(S.recoverUnfinished(cfg), [], 'the second call has nothing to do');
  assert.equal(evs('idea_added').length, 2); assert.equal(evs('tick_finished').length, 1);
});

test('redactRaw: a secret-shaped string never reaches raw/, and a replay drops the idea as pii like the live path', () => {
  fresh(); const cfg = C(), secret = 'sk-ant-' + 'a1B2c3D4e5'.repeat(3);
  const bad = idea(TITLES[0], { why: `Use the key ${secret} for it` }), good = idea(TITLES[1]);
  const live = S.validateIdeas({ ideas: [bad, good] }, { cfg, want: 4, minImpact: 2, pastTitles: [] });
  assert.equal(live.dropped.pii, 1);
  const r = res([bad, good]), red = S.redactRaw({ ...r, result: JSON.stringify({ ideas: [bad, good] }) });
  assert.ok(!JSON.stringify(red).includes(secret), 'no secret survives in structured_output or result');
  startTick('t000002');
  writeRaw('t000002', { tick: 't000002', ctx: ctx({ tick: 't000002' }), res: red });
  assert.ok(!fs.readFileSync(sf('raw', 't000002.json'), 'utf8').includes(secret));
  S.recoverUnfinished(cfg);
  assert.equal(evs('idea_added').length, 1); assert.equal(evs('tick_finished')[0].dropped.pii, 1);
});

test('redactRaw: the marker is flagged even when the policy holds no canary pattern', () => {
  const root = fs.mkdtempSync(path.join(w0.dir, 'plugin-')), real = path.resolve('config/gates.json');
  fs.mkdirSync(path.join(root, 'config'));
  const g = JSON.parse(fs.readFileSync(real, 'utf8')), noCanary = a => a.filter(x => !JSON.stringify(x).includes('CANARY'));
  g.secretPatterns = noCanary(g.secretPatterns); g.lane.pii = noCanary(g.lane.pii);
  fs.writeFileSync(path.join(root, 'config', 'gates.json'), JSON.stringify(g));
  const code = `const S = await import(${JSON.stringify(path.resolve('bin/steward-lib.mjs'))});
    const r = S.redactRaw({ result: 'x', structured_output: { ideas: [{ why: 'key sk-ant-' + 'a1B2c3D4e5'.repeat(3) }] } });
    console.log(JSON.stringify(S.secretHits(r.structured_output.ideas[0].why)));`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' });
  assert.equal(p.stdout.trim(), '["secret"]', p.stderr);
});

test('recoverUnfinished: no raw file closes the visit as error / killed, with project and lens', () => {
  fresh(); const cfg = C();
  startTick('t000007', 'beta', 'risk');
  assert.deepEqual(S.recoverUnfinished(cfg), [{ tick: 't000007', outcome: 'error' }]);
  const fin = evs('tick_finished'); assert.equal(fin.length, 1);
  assert.deepEqual({ ...fin[0], at: undefined }, { type: 'tick_finished', at: undefined, tick: 't000007', outcome: 'error', reason: 'killed', project: 'beta', lens: 'risk' });
  assert.deepEqual(S.recoverUnfinished(cfg), []);
});

test('recoverUnfinished: a raw file with no res or no ctx is treated as missing (killed)', () => {
  fresh(); const cfg = C();
  startTick('t000001'); writeRaw('t000001', { tick: 't000001', ctx: ctx() });
  startTick('t000002'); writeRaw('t000002', { tick: 't000002', res: res([idea(TITLES[0])]) });
  startTick('t000003'); fs.mkdirSync(sf('raw'), { recursive: true }); fs.writeFileSync(sf('raw', 't000003.json'), '{ not json');
  S.recoverUnfinished(cfg);
  assert.deepEqual(evs('tick_finished').map(e => [e.tick, e.outcome, e.reason]), [['t000001', 'error', 'killed'], ['t000002', 'error', 'killed'], ['t000003', 'error', 'killed']]);
  assert.equal(evs('idea_added').length, 0);
});

test('recoverUnfinished: a raw file that ingest cannot handle gives error / recover_failed', () => {
  // ingest throws when the configuration it is given has no gates (waitRegexes reads cfg.gates.waitWords)
  fresh(); const good = C(), broken = { ...good, gates: null };
  startTick('t000001');
  writeRaw('t000001', { tick: 't000001', ctx: ctx(), res: res([idea(TITLES[0])]) });
  assert.deepEqual(S.recoverUnfinished(broken), [{ tick: 't000001', outcome: 'error' }]);
  const fin = evs('tick_finished'); assert.equal(fin.length, 1);
  assert.deepEqual({ ...fin[0], at: undefined }, { type: 'tick_finished', at: undefined, tick: 't000001', outcome: 'error', reason: 'recover_failed', project: 'alpha', lens: 'finish' }, 'project and lens come from the tick_started event');
  assert.equal(evs('idea_added').length, 0);
});

test('recoverUnfinished: ideas filed before the crash are not filed twice', () => {
  fresh(); const cfg = C();
  startTick('t000001');
  S.appendEvent({ type: 'idea_added', id: 'i1', project: 'alpha', lens: 'finish', wild: false, tick: 't000001', title: TITLES[0], why: 'x', kind: 'content', impact: 3, effort: 2, gate: 'ask', ask: 'Go?' });
  writeRaw('t000001', { tick: 't000001', ctx: ctx(), res: res([idea(TITLES[0])]) });
  assert.deepEqual(S.recoverUnfinished(cfg), [{ tick: 't000001', outcome: 'recovered' }]);
  assert.equal(evs('idea_added').length, 1);
  const fin = evs('tick_finished')[0];
  assert.deepEqual([fin.outcome, fin.proposed, fin.kept, fin.dropped], ['recovered', 1, 0, { dupe: 1 }]);
});

// ---------------------------------------------------------------- 3. self-tuning
const T0 = (over = {}) => { const t = S.loadTuning(C()); return { ...t, ...over, knobs: { ...t.knobs, ...(over.knobs || {}) } }; };
const step = (events, tuning, now = NOW0) => S.tuneStep({ cfg: C(), tuning, st: S.derive(events), now });
let nTick = 0;
const fin = (o = {}, at = NOW0 - DAY) => E('tick_finished', { tick: 'f' + (++nTick), outcome: 'ok', project: 'alpha', proposed: 4, kept: 2, dropped: {}, ...o }, at);
const fins = (n, o = {}) => Array.from({ length: n }, () => fin(o));
const ideaEv = (n, o = {}) => E('idea_added', { id: 'i' + n, project: 'alpha', wild: false, gate: 'ask', title: 'Idea number ' + n, impact: 3, effort: 2, ...o });
const ansEv = (n, answer) => E('idea_answered', { id: 'i' + n, answer, note: '' });
// answered ideas: list of [wild, answer]; ids i1..in
const answered = list => list.flatMap(([wild, a], k) => [ideaEv(k + 1, { wild }), ansEv(k + 1, a)]);
const pend = (o = {}) => ({ id: 'c1', rule: 'R1', knob: 'pastIdeasInBrief', dir: 'up', from: 20, to: 25, metric: 'dupeRate', better: 'lower', source: 'ticks', baseline: 0.5, startedAt: iso(NOW0 - DAY), tickCount: 3, ideaSeq: 1, ...o });

test('tuning R1: a dupe rate over 0.30 raises pastIdeasInBrief 20 to 25 and keeps the pending change', () => {
  // 3 visits, 12 proposed, 6 dupes: 0.5
  const r = step(fins(3, { dropped: { dupe: 2 } }), T0());
  assert.equal(r.changed, true); assert.equal(r.tuning.knobs.pastIdeasInBrief, 25);
  assert.deepEqual(r.tuning.pending, { id: 'c1', rule: 'R1', knob: 'pastIdeasInBrief', dir: 'up', from: 20, to: 25, metric: 'dupeRate', better: 'lower', source: 'ticks', baseline: 0.5, startedAt: iso(NOW0), tickCount: 3, ideaSeq: 1 });
  assert.equal(r.tuning.lastChangeAt, iso(NOW0)); assert.equal(r.tuning.seq, 1);
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'change', rule: 'R1', knob: 'pastIdeasInBrief', from: 20, to: 25, metric: 'dupeRate', baseline: 0.5 }]);
  assert.deepEqual(r.tuning.knobs, { ideasPerCall: 4, minImpact: 2, pastIdeasInBrief: 25, wildcardEvery: 5 });
});

test('tuning R1: exactly 0.30, fewer than 3 visits or fewer than 8 proposed do not fire', () => {
  assert.equal(step([fin({ proposed: 4, dropped: { dupe: 1 } }), fin({ proposed: 3, dropped: { dupe: 1 } }), fin({ proposed: 3, dropped: { dupe: 1 } })], T0()).changed, false, '3/10 is not over 0.30');
  assert.equal(step(fins(2, { proposed: 6, dropped: { dupe: 6 } }), T0()).changed, false, 'two visits are too few');
  assert.equal(step([fin({ proposed: 4, dropped: { dupe: 4 } }), fin({ proposed: 2, dropped: { dupe: 2 } }), fin({ proposed: 1, dropped: { dupe: 1 } })], T0()).changed, false, 'seven proposed are too few');
});

test('tuning R1b: with pastIdeasInBrief blocked or at its top, ideasPerCall goes down', () => {
  const data = fins(3, { dropped: { dupe: 2 } });
  for (const t of [T0({ blocks: [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0 + DAY) }] }), T0({ knobs: { pastIdeasInBrief: 40 } })]) {
    const r = step(data, t);
    assert.equal(r.changed, true); assert.equal(r.tuning.knobs.ideasPerCall, 3); assert.equal(r.tuning.knobs.pastIdeasInBrief, t.knobs.pastIdeasInBrief);
    assert.deepEqual([r.tuning.pending.rule, r.tuning.pending.knob, r.tuning.pending.dir, r.tuning.pending.from, r.tuning.pending.to, r.tuning.pending.id], ['R1b', 'ideasPerCall', 'down', 4, 3, 'c1']);
    assert.deepEqual([r.log[0].rule, r.log[0].from, r.log[0].to], ['R1b', 4, 3]);
  }
});

test('tuning R2: a low rate over 0.35 lowers minImpact (and exactly 0.35 does not)', () => {
  // 12 proposed, 6 low (0.5), 3 kept (0.25 yield)
  const r = step(fins(3, { kept: 1, dropped: { low: 2 } }), T0());
  assert.equal(r.changed, true); assert.equal(r.tuning.knobs.minImpact, 1);
  assert.deepEqual([r.tuning.pending.rule, r.tuning.pending.dir, r.tuning.pending.metric, r.tuning.pending.better, r.tuning.pending.source, r.tuning.pending.baseline], ['R2', 'down', 'yieldRate', 'higher', 'ticks', 0.25]);
  assert.deepEqual(r.log[0], { at: iso(NOW0), kind: 'change', rule: 'R2', knob: 'minImpact', from: 2, to: 1, metric: 'yieldRate', baseline: 0.25 });
  // 20 proposed, 7 low: 0.35
  assert.equal(step([fin({ proposed: 7, dropped: { low: 3 } }), fin({ proposed: 7, dropped: { low: 2 } }), fin({ proposed: 6, dropped: { low: 2 } })], T0()).changed, false);
});

test('tuning R3: at least 4 answers with acceptance under 0.30 raises minImpact', () => {
  const r = step(answered([[false, 'yes'], [false, 'no'], [false, 'no'], [false, 'no']]), T0());
  assert.equal(r.changed, true); assert.equal(r.tuning.knobs.minImpact, 3);
  assert.deepEqual(r.tuning.pending, { id: 'c1', rule: 'R3', knob: 'minImpact', dir: 'up', from: 2, to: 3, metric: 'accept', better: 'higher', source: 'answers', baseline: 0.25, startedAt: iso(NOW0), tickCount: 0, ideaSeq: 5 });
  assert.deepEqual(r.log[0], { at: iso(NOW0), kind: 'change', rule: 'R3', knob: 'minImpact', from: 2, to: 3, metric: 'accept', baseline: 0.25 });
  // only 3 answers: no change; 4 answers at 0.50: no change; "later" is not an answer
  assert.equal(step(answered([[false, 'no'], [false, 'no'], [false, 'no']]), T0()).changed, false);
  assert.equal(step(answered([[false, 'yes'], [false, 'yes'], [false, 'no'], [false, 'no']]), T0()).changed, false);
  assert.equal(step(answered([[false, 'no'], [false, 'no'], [false, 'no'], [false, 'later']]), T0()).changed, false);
});

test('tuning R5: a gap of 0.2 or more between wild and normal acceptance moves wildcardEvery, both directions', () => {
  // wild 3/3 yes, normal 1/3: wild is better, so wild ideas come more often: 5 down to 4
  const up = step(answered([[true, 'yes'], [true, 'yes'], [true, 'yes'], [false, 'yes'], [false, 'no'], [false, 'no']]), T0());
  assert.equal(up.changed, true); assert.equal(up.tuning.knobs.wildcardEvery, 4);
  assert.deepEqual([up.tuning.pending.rule, up.tuning.pending.dir, up.tuning.pending.from, up.tuning.pending.to, up.tuning.pending.baseline, up.tuning.pending.ideaSeq], ['R5', 'down', 5, 4, 4 / 6, 7]);
  // wild 0/3, normal 2/3: wild is worse, so fewer: 5 up to 6
  const down = step(answered([[true, 'no'], [true, 'no'], [true, 'no'], [false, 'yes'], [false, 'yes'], [false, 'no']]), T0());
  assert.equal(down.tuning.knobs.wildcardEvery, 6); assert.equal(down.tuning.pending.dir, 'up');
  // equal rates, or only 2 wild answers: nothing
  assert.equal(step(answered([[true, 'yes'], [true, 'yes'], [true, 'no'], [false, 'yes'], [false, 'yes'], [false, 'no']]), T0()).changed, false);
  assert.equal(step(answered([[true, 'yes'], [true, 'yes'], [false, 'no'], [false, 'no'], [false, 'no']]), T0()).changed, false);
});

test('tuning: no data means no change, and the state comes back equal', () => {
  const t = T0(), r = step([], t);
  assert.equal(r.changed, false); assert.deepEqual(r.log, []); assert.deepEqual(r.tuning, t);
});

test('tuning: nothing changes within 20 hours of the last change', () => {
  const data = fins(3, { dropped: { dupe: 2 } });
  assert.equal(step(data, T0({ lastChangeAt: iso(NOW0 - 10 * HOUR) })).changed, false);
  assert.equal(step(data, T0({ lastChangeAt: iso(NOW0 - 21 * HOUR) })).changed, true);
  assert.equal(step(data, T0({ lastChangeAt: iso(NOW0 - 20 * HOUR) })).changed, true, 'exactly 20 hours is allowed');
});

test('tuning: a knob at the edge of its range is skipped', () => {
  const dupes = fins(3, { dropped: { dupe: 2 } }), low = fins(3, { kept: 1, dropped: { low: 2 } });
  const a = step(low, T0({ knobs: { minImpact: 1 } })); assert.equal(a.changed, false); assert.equal(a.tuning.knobs.minImpact, 1);
  assert.equal(step(answered([[false, 'yes'], [false, 'no'], [false, 'no'], [false, 'no']]), T0({ knobs: { minImpact: 4 } })).changed, false);
  assert.equal(step(answered([[true, 'yes'], [true, 'yes'], [true, 'yes'], [false, 'yes'], [false, 'no'], [false, 'no']]), T0({ knobs: { wildcardEvery: 3 } })).changed, false);
  const b = step(dupes, T0({ knobs: { pastIdeasInBrief: 40, ideasPerCall: 2 } })); assert.equal(b.changed, false, 'both dupe knobs at their edge');
});

test('tuning: an active block stops a direction; an expired one does not', () => {
  const data = fins(3, { dropped: { dupe: 2 } });
  const active = step(data, T0({ blocks: [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0 + 1) }] }));
  assert.equal(active.tuning.knobs.pastIdeasInBrief, 20); assert.equal(active.tuning.pending.rule, 'R1b');
  assert.deepEqual(active.tuning.blocks, [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0 + 1) }]);
  const expired = step(data, T0({ blocks: [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0) }] }));
  assert.equal(expired.tuning.pending.rule, 'R1'); assert.deepEqual(expired.tuning.blocks, [], 'the expired block is dropped');
  const otherDir = step(data, T0({ blocks: [{ knob: 'pastIdeasInBrief', dir: 'down', until: iso(NOW0 + DAY) }] }));
  assert.equal(otherDir.tuning.pending.rule, 'R1', 'a block on the other direction does not matter');
});

const base3 = () => fins(3, { dropped: { dupe: 2 } });   // the three visits the pending R1 change started after
const pendT = (o = {}) => T0({ knobs: { pastIdeasInBrief: 25 }, pending: pend(o), lastChangeAt: iso(NOW0 - DAY) });

test('tuning pending (ticks): kept at a gain of 0.15 or more; the opposite direction is blocked', () => {
  // 6 new visits, 24 proposed, 0 dupes: 0.5 down to 0, gain 0.5
  const r = step([...base3(), ...fins(6, { dropped: {} })], pendT());
  assert.equal(r.changed, true); assert.equal(r.tuning.pending, null); assert.equal(r.tuning.knobs.pastIdeasInBrief, 25);
  assert.deepEqual(r.tuning.blocks, [{ knob: 'pastIdeasInBrief', dir: 'down', until: iso(NOW0 + 7 * DAY) }]);
  assert.equal(r.tuning.lastChangeAt, iso(NOW0 - DAY), 'a kept change does not restart the clock');
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'keep', rule: 'R1', knob: 'pastIdeasInBrief', value: 25, metric: 'dupeRate', baseline: 0.5, now: 0, gain: 0.5 }]);
});

test('tuning pending (ticks): reverted without a real gain; this direction is blocked and stays blocked', () => {
  // 6 new visits, 48 proposed, 18 dupes: 0.375, gain 0.125 (under 0.15)
  const data = [...base3(), ...fins(6, { proposed: 8, dropped: { dupe: 3 } })];
  const r = step(data, pendT());
  assert.equal(r.changed, true); assert.equal(r.tuning.pending, null); assert.equal(r.tuning.knobs.pastIdeasInBrief, 20);
  assert.deepEqual(r.tuning.blocks, [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0 + 7 * DAY) }]);
  assert.equal(r.tuning.lastChangeAt, iso(NOW0));
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'revert', rule: 'R1', knob: 'pastIdeasInBrief', value: 20, metric: 'dupeRate', baseline: 0.5, now: 0.375, gain: 0.125, why: 'no real gain' }]);
  // 21 hours later the dupe rate is still high (24 of 60), but the block on "up" sends the next step to ideasPerCall
  const next = step(data, r.tuning, NOW0 + 21 * HOUR);
  assert.equal(next.tuning.pending.rule, 'R1b'); assert.equal(next.tuning.knobs.pastIdeasInBrief, 20); assert.equal(next.tuning.knobs.ideasPerCall, 3);
});

test('tuning pending (ticks): left waiting with too few new visits, or visits with nothing proposed', () => {
  const t = pendT();
  for (const data of [[...base3(), ...fins(5, { dropped: {} })], [...base3(), ...fins(6, { proposed: 0, kept: 0 })]]) {
    const r = step(data, t); assert.equal(r.changed, false); assert.deepEqual(r.log, []); assert.deepEqual(r.tuning.pending, t.pending); assert.equal(r.tuning.knobs.pastIdeasInBrief, 25);
  }
});

test('tuning pending (ticks): expires after 14 days with "not proven in 14 days"', () => {
  const old = pendT({ startedAt: iso(NOW0 - 14 * DAY - 1) });
  const r = step([...base3(), ...fins(2, { dropped: {} })], old);
  assert.equal(r.changed, true); assert.equal(r.tuning.pending, null); assert.equal(r.tuning.knobs.pastIdeasInBrief, 20);
  assert.deepEqual(r.tuning.blocks, [{ knob: 'pastIdeasInBrief', dir: 'up', until: iso(NOW0 + 7 * DAY) }]);
  // 2 new visits, 8 proposed, 0 dupes: value 0, gain 0.5, but not enough samples
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'revert', rule: 'R1', knob: 'pastIdeasInBrief', value: 20, metric: 'dupeRate', baseline: 0.5, now: 0, gain: 0.5, why: 'not proven in 14 days' }]);
  // with no new visit at all the value is unknown: now null, gain -1
  const none = step(base3(), old); assert.deepEqual([none.log[0].now, none.log[0].gain, none.log[0].why], [null, -1, 'not proven in 14 days']);
  // exactly 14 days is still waiting
  const edge = step([...base3(), ...fins(2, { dropped: {} })], pendT({ startedAt: iso(NOW0 - 14 * DAY) })); assert.equal(edge.changed, false);
});

const apend = (o = {}) => T0({ knobs: { minImpact: 3 }, pending: pend({ id: 'c2', rule: 'R3', knob: 'minImpact', dir: 'up', from: 2, to: 3, metric: 'accept', better: 'higher', source: 'answers', baseline: 0.25, tickCount: 0, ideaSeq: 5, ...o }), lastChangeAt: iso(NOW0 - DAY) });
const oldAnswers = () => answered([[false, 'yes'], [false, 'no'], [false, 'no'], [false, 'no']]);   // i1..i4: before ideaSeq 5
const newIdeas = list => list.flatMap((a, k) => [ideaEv(5 + k), ansEv(5 + k, a)]);

test('tuning pending (answers): kept when acceptance on ideas from ideaSeq on gains 0.15 or more', () => {
  const r = step([...oldAnswers(), ...newIdeas(['yes', 'yes', 'yes', 'no'])], apend());
  assert.equal(r.changed, true); assert.equal(r.tuning.pending, null); assert.equal(r.tuning.knobs.minImpact, 3);
  assert.deepEqual(r.tuning.blocks, [{ knob: 'minImpact', dir: 'down', until: iso(NOW0 + 7 * DAY) }]);
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'keep', rule: 'R3', knob: 'minImpact', value: 3, metric: 'accept', baseline: 0.25, now: 0.75, gain: 0.5 }]);
});

test('tuning pending (answers): reverted when the new answers are no better, left waiting with 3 answers, old answers do not count', () => {
  const r = step([...oldAnswers(), ...newIdeas(['yes', 'no', 'no', 'no'])], apend());
  assert.equal(r.tuning.knobs.minImpact, 2); assert.deepEqual(r.tuning.blocks, [{ knob: 'minImpact', dir: 'up', until: iso(NOW0 + 7 * DAY) }]);
  assert.deepEqual(r.log, [{ at: iso(NOW0), kind: 'revert', rule: 'R3', knob: 'minImpact', value: 2, metric: 'accept', baseline: 0.25, now: 0.25, gain: 0, why: 'no real gain' }]);
  // 3 new answers (the 4 old ones are before ideaSeq): still waiting
  const w = step([...oldAnswers(), ...newIdeas(['yes', 'yes', 'yes'])], apend()); assert.equal(w.changed, false); assert.deepEqual(w.log, []);
  // 15 days old and still only 3 answers: expired
  const x = step([...oldAnswers(), ...newIdeas(['yes', 'yes', 'yes'])], apend({ startedAt: iso(NOW0 - 15 * DAY) }));
  assert.equal(x.log[0].kind, 'revert'); assert.equal(x.log[0].why, 'not proven in 14 days'); assert.equal(x.tuning.knobs.minImpact, 2);
});

test('loadTuning: no file gives the defaults; bad values are clamped or replaced', () => {
  fresh(); const cfg = C();
  assert.deepEqual(S.loadTuning(cfg), { knobs: { ideasPerCall: 4, minImpact: 2, pastIdeasInBrief: 20, wildcardEvery: 5 }, pending: null, blocks: [], lastChangeAt: null, seq: 0 });
  fs.mkdirSync(S.stewardDir(), { recursive: true });
  fs.writeFileSync(S.tuningFile(), JSON.stringify({ knobs: { ideasPerCall: 99, minImpact: 0, pastIdeasInBrief: 17.5, wildcardEvery: 'x', unknown: 7 }, pending: 'str', blocks: 'x', lastChangeAt: 5, seq: 'a' }));
  assert.deepEqual(S.loadTuning(cfg), { knobs: { ideasPerCall: 5, minImpact: 1, pastIdeasInBrief: 20, wildcardEvery: 5 }, pending: null, blocks: [], lastChangeAt: null, seq: 0 });
  const p = pend(), b = [{ knob: 'minImpact', dir: 'up', until: iso(NOW0) }];
  fs.writeFileSync(S.tuningFile(), JSON.stringify({ knobs: { ideasPerCall: -3, minImpact: 4, pastIdeasInBrief: 3, wildcardEvery: 10 }, pending: p, blocks: b, lastChangeAt: iso(NOW0), seq: 7 }));
  assert.deepEqual(S.loadTuning(cfg), { knobs: { ideasPerCall: 2, minImpact: 4, pastIdeasInBrief: 10, wildcardEvery: 10 }, pending: p, blocks: b, lastChangeAt: iso(NOW0), seq: 7 });
  fs.writeFileSync(S.tuningFile(), '{ broken');
  assert.equal(S.loadTuning(cfg).knobs.minImpact, 2, 'an unreadable file gives the defaults');
});

test('tickMetrics and answerMetrics: empty input and a mixed list', () => {
  assert.deepEqual(S.tickMetrics([]), { ticks: 0, proposed: 0, dupeRate: null, lowRate: null, yieldRate: null });
  assert.deepEqual(S.answerMetrics([]), { n: 0, accept: null });
  assert.deepEqual(S.tickMetrics([{ proposed: 4, kept: 2, dropped: { dupe: 1, low: 1 } }, { proposed: 6, kept: 3, dropped: { dupe: 2 } }, { outcome: 'ok' }]), { ticks: 3, proposed: 10, dupeRate: 0.3, lowRate: 0.1, yieldRate: 0.5 });
  assert.deepEqual(S.answerMetrics([{ status: 'yes' }, { status: 'no' }, { status: 'no' }, { status: 'later' }, { status: 'open' }]), { n: 3, accept: 1 / 3 });
});

test('tuningLog: reads the last n lines (default 20) and is empty without a file', () => {
  fresh(); assert.deepEqual(S.tuningLog(), []);
  fs.mkdirSync(S.stewardDir(), { recursive: true });
  fs.writeFileSync(sf('tuning.log.jsonl'), Array.from({ length: 25 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
  const l = S.tuningLog(); assert.equal(l.length, 20); assert.equal(l[0].i, 5); assert.equal(l[19].i, 24);
  assert.deepEqual(S.tuningLog(2).map(e => e.i), [23, 24]);
  // a broken line (a crash mid-write, a stray edit) is skipped; it does not hide the whole log
  fs.writeFileSync(sf('tuning.log.jsonl'), '{"i":1}\nnot json\n[2]\n{"i":3}\n');
  assert.deepEqual(S.tuningLog().map(e => e.i), [1, 3]);
});

test('tuning log trim: past 400 lines a visit that logs a change cuts the file to the newest 200', () => {
  // saveTuning is private, so this runs a real visit (fake claude): an old pending change expires, which logs one revert line
  const w = mkWorld({ projects: 1 });
  fs.writeFileSync(path.join(w.state, 'tuning.json'), JSON.stringify({ knobs: { ideasPerCall: 4, minImpact: 2, pastIdeasInBrief: 25, wildcardEvery: 5 }, seq: 1,
    pending: pend({ startedAt: iso(NOW0 - 30 * DAY), tickCount: 0 }), blocks: [], lastChangeAt: iso(NOW0 - 30 * DAY) }));
  fs.writeFileSync(path.join(w.state, 'tuning.log.jsonl'), Array.from({ length: 401 }, (_, i) => JSON.stringify({ at: iso(NOW0 - 30 * DAY), kind: 'change', n: i + 1 })).join('\n') + '\n');
  const r = run(w, ['tick', '--force', '--json'], { FAKE_UTIL: '0.1' });
  assert.equal(r.code, 0, r.err + r.out);
  const lines = fs.readFileSync(path.join(w.state, 'tuning.log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.length, 200);
  assert.equal(lines[0].n, 203, 'the oldest 202 lines are gone');
  assert.deepEqual([lines[199].kind, lines[199].rule, lines[199].why], ['revert', 'R1', 'not proven in 14 days']);
  // and a file of exactly 400 lines is left alone: 399 + the new line
  fs.writeFileSync(path.join(w.state, 'tuning.json'), JSON.stringify({ knobs: { ideasPerCall: 4, minImpact: 2, pastIdeasInBrief: 25, wildcardEvery: 5 }, seq: 2, pending: pend({ id: 'c2', startedAt: iso(NOW0 - 30 * DAY), tickCount: 0 }), blocks: [], lastChangeAt: iso(NOW0 - 30 * DAY) }));
  fs.writeFileSync(path.join(w.state, 'tuning.log.jsonl'), Array.from({ length: 399 }, (_, i) => JSON.stringify({ n: i + 1 })).join('\n') + '\n');
  const r2 = run(w, ['tick', '--force', '--json'], { FAKE_UTIL: '0.1', WK_NOW: iso(NOW0 + 2 * HOUR) });
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.equal(fs.readFileSync(path.join(w.state, 'tuning.log.jsonl'), 'utf8').split('\n').filter(Boolean).length, 400);
});

// ---------------------------------------------------------------- 4. inbox
function inboxLog() {
  const a = (n, o) => S.appendEvent({ type: 'idea_added', id: 'i' + n, project: 'alpha', title: 'Idea ' + n, why: 'x', kind: 'content', gate: 'ask', impact: 3, effort: 2, ...o }, NOW0 - HOUR);
  a(1, {}); a(2, { impact: 5, effort: 3 }); a(3, { project: 'beta', gate: 'wait', effort: 1 }); a(4, {}); a(5, { gate: 'auto', impact: 5, effort: 1 });
  a(6, { impact: 4, effort: 1 }); a(7, { project: 'beta', effort: 1 }); a(10, {});
  S.appendEvent({ type: 'idea_answered', id: 'i6', answer: 'yes', note: '' }); S.appendEvent({ type: 'idea_answered', id: 'i7', answer: 'later', note: '' });
}
test('inbox: impact high first, then effort low, then numeric id; auto and answered ideas are not shown', () => {
  fresh(); const cfg = C(); inboxLog();
  const ids = list => list.map(i => i.id);
  assert.deepEqual(ids(S.inbox(S.derive(S.readEvents()), cfg)), ['i2', 'i3', 'i1', 'i4', 'i10']);
  assert.deepEqual(ids(S.inbox(S.derive(S.readEvents()), cfg, 'alpha')), ['i2', 'i1', 'i4', 'i10']);
  assert.deepEqual(ids(S.inbox(S.derive(S.readEvents()), cfg, 'beta')), ['i3']);
  assert.deepEqual(ids(S.inbox(S.derive(S.readEvents()), cfg, 'gamma')), []);
});

test('inbox: the total cap applies to the whole list but not to a single project', () => {
  fresh(); const cfg = cfgWith({ inbox: { total: 2 } }); inboxLog();
  assert.deepEqual(S.inbox(S.derive(S.readEvents()), cfg).map(i => i.id), ['i2', 'i3']);
  assert.deepEqual(S.inbox(S.derive(S.readEvents()), cfg, 'alpha').map(i => i.id), ['i2', 'i1', 'i4', 'i10']);
  C();
});

// ---------------------------------------------------------------- 5. answerIdea
test('answerIdea: yes, no and later are filed; it returns the idea as it was before; later leaves the inbox', () => {
  fresh(); const cfg = C(); inboxLog();
  const before = S.answerIdea('i1', 'yes', '  Good\n idea <b> ');
  assert.equal(before.id, 'i1'); assert.equal(before.status, 'open', 'the idea as it was before the answer');
  assert.deepEqual(evs('idea_answered').slice(2).map(e => ({ id: e.id, answer: e.answer, note: e.note })), [{ id: 'i1', answer: 'yes', note: 'Good idea b' }]);
  assert.equal(S.derive(S.readEvents()).ideas.get('i1').status, 'yes');
  assert.equal(S.answerIdea('i1', 'no', undefined).status, 'yes', 'a second answer sees the first');
  assert.equal(evs('idea_answered')[3].note, '');   // [0] and [1] come from inboxLog
  assert.equal(S.derive(S.readEvents()).ideas.get('i1').status, 'no');
  S.answerIdea('i2', 'later', 'next month');
  assert.equal(S.derive(S.readEvents()).ideas.get('i2').status, 'later');
  assert.deepEqual(S.inbox(S.derive(S.readEvents()), cfg).map(i => i.id), ['i3', 'i4', 'i10']);
});

test('answerIdea: the note is tidied to 200 characters', () => {
  fresh(); inboxLog();
  S.answerIdea('i4', 'no', 'x'.repeat(300));
  assert.equal(evs('idea_answered')[2].note, 'x'.repeat(200));   // after the two from inboxLog
});

test('answerIdea: a wrong answer or an unknown idea is a usage error (exit 1) and files nothing', () => {
  fresh(); inboxLog();
  assert.throws(() => S.answerIdea('i1', 'maybe', ''), e => e instanceof S.StewardError && e.code === 1 && e.message === 'answer with yes, no or later');
  assert.throws(() => S.answerIdea('i99', 'yes', ''), e => e instanceof S.StewardError && e.code === 1 && e.message === 'no idea "i99"');
  assert.throws(() => S.answerIdea('i99', 'perhaps', ''), e => e.message === 'answer with yes, no or later', 'the answer is checked first');
  assert.equal(evs('idea_answered').length, 2, 'only the two from inboxLog');
});

// ---------------------------------------------------------------- 6. snapshot
const killPath = () => path.join(w0.home, '.wk', 'KILL');
const meterHere = (o = {}) => setMeter({ state: S.stewardDir(), now: NOW0 }, o);
test('snapshot: a fresh state', () => {
  fresh(); const cfg = C(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  const s = S.snapshot(cfg, NOW0);
  assert.deepEqual([s.mode, s.phase, s.cap, s.visits24h, s.source, s.used, s.meterAgeMin, s.killed], ['login', 'shadow', 2, 0, 'ledger', 0, null, false]);
  assert.equal(s.pace.go, true); assert.equal(s.pace.reason, null); assert.equal(s.backoff, null); assert.equal(s.lock, null); assert.equal(s.unfinished, 0); assert.equal(s.last, null);
  assert.deepEqual(s.projects.map(p => [p.id, p.weight, p.paused]), [['alpha', 3, false], ['beta', 2, false], ['gamma', 1, false]]);
  assert.deepEqual(s.ideas, { open: 0, auto: 0, ask: 0, wait: 0, answered: 0, accept: null });
  assert.deepEqual(s.win.end, WEEK_END_S * 1000); assert.equal(s.win.start, WEEK_START);
});

test('snapshot: killed is true while the kill file exists and false after it is removed', () => {
  fresh(); const cfg = C(); fs.mkdirSync(path.dirname(killPath()), { recursive: true });
  try {
    fs.writeFileSync(killPath(), 'stop'); assert.equal(S.snapshot(cfg, NOW0).killed, true);
  } finally { fs.rmSync(killPath(), { force: true }); }
  assert.equal(S.snapshot(cfg, NOW0).killed, false);
});

test('snapshot: a meter in the state folder is used', () => {
  fresh(); const cfg = C(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  meterHere({ util: 0.4, ageMin: 1 });
  const s = S.snapshot(cfg, NOW0);
  assert.deepEqual([s.source, s.used, s.meterAgeMin], ['meter', 0.4, 1]);
  assert.equal(s.pace.used, 0.4); assert.equal(s.pace.go, true);
  meterHere({ util: 0.7, ageMin: 1 });
  const ahead = S.snapshot(cfg, NOW0); assert.deepEqual([ahead.pace.go, ahead.pace.reason], [false, 'ahead']);
});

test('snapshot: a live lock is shown, a dead one is not', () => {
  fresh(); const cfg = C(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  const lock = { pid: process.pid, at: iso(NOW0) };
  fs.writeFileSync(sf('tick.lock'), JSON.stringify(lock)); assert.deepEqual(S.snapshot(cfg, NOW0).lock, lock);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; fs.writeFileSync(sf('tick.lock'), JSON.stringify({ pid: dead, at: iso(NOW0) })); assert.equal(S.snapshot(cfg, NOW0).lock, null);
});
test('snapshot: a backoff in the future is shown, one in the past is not', () => {
  fresh(); const cfg = C(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  const bo = { until: NOW0 + HOUR, count: 1, reason: 'limit', setAt: iso(NOW0) };
  fs.writeFileSync(sf('backoff.json'), JSON.stringify(bo)); assert.deepEqual(S.snapshot(cfg, NOW0).backoff, bo);
  fs.writeFileSync(sf('backoff.json'), JSON.stringify({ ...bo, until: NOW0 - 1 })); assert.equal(S.snapshot(cfg, NOW0).backoff, null);
  fs.writeFileSync(sf('backoff.json'), JSON.stringify({ ...bo, until: NOW0 })); assert.equal(S.snapshot(cfg, NOW0).backoff, null, 'until equal to now is over');
});

// ---------------------------------------------------------------- 7. report
test('report: every field over a constructed week', () => {
  fresh(); const cfg = C(); fs.mkdirSync(S.stewardDir(), { recursive: true });
  const IN = WEEK_START + 10 * HOUR, OUT = WEEK_START - HOUR;
  const ev = (e, at) => S.appendEvent(e, at);
  // started visits: two in the week with pace data (errors 0.1 and 0.05), one without pace, one before the week
  ev({ type: 'tick_started', tick: 't1', project: 'alpha', pace: { used: 0.4, elapsed: 0.5 } }, NOW0 - 10 * HOUR);
  ev({ type: 'tick_started', tick: 't2', project: 'alpha', pace: { used: 0.45, elapsed: 0.5 } }, NOW0 - 5 * HOUR);
  ev({ type: 'tick_started', tick: 't3', project: 'beta' }, NOW0 - 4 * HOUR);
  ev({ type: 'tick_started', tick: 't0', project: 'alpha', pace: { used: 0.9, elapsed: 0.1 } }, OUT);
  // finished: alpha ok, alpha ok, beta recovered, alpha invalid are counted visits; the error and the early one are not
  ev({ type: 'tick_finished', tick: 't1', outcome: 'ok', project: 'alpha' }, NOW0 - 9 * HOUR);
  ev({ type: 'tick_finished', tick: 't2', outcome: 'ok', project: 'alpha' }, NOW0 - 4 * HOUR);
  ev({ type: 'tick_finished', tick: 't3', outcome: 'recovered', project: 'beta' }, NOW0 - 3 * HOUR);
  ev({ type: 'tick_finished', tick: 't4', outcome: 'invalid', project: 'alpha' }, NOW0 - 2 * HOUR);
  ev({ type: 'tick_finished', tick: 't5', outcome: 'error', project: 'gamma' }, NOW0 - HOUR);
  ev({ type: 'tick_finished', tick: 't0', outcome: 'ok', project: 'alpha' }, OUT);
  // held: pace twice and owner once in the week, gap once before it
  ev({ type: 'tick_held', tick: 'h1', reason: 'pace' }, IN); ev({ type: 'tick_held', tick: 'h2', reason: 'pace' }, NOW0);
  ev({ type: 'tick_held', tick: 'h3', reason: 'owner' }, NOW0 + HOUR); ev({ type: 'tick_held', tick: 'h4', reason: 'gap' }, OUT);
  // ideas: five in the week (yes, no, no, open, later) and one before it (yes)
  const add = (n, at) => ev({ type: 'idea_added', id: 'i' + n, project: 'alpha', title: 'Idea ' + n, why: 'x', kind: 'content', gate: 'ask', impact: 3, effort: 2 }, at);
  add(1, IN); add(2, IN); add(3, IN); add(4, IN); add(5, IN); add(6, OUT);
  ev({ type: 'idea_answered', id: 'i1', answer: 'yes', note: '' }, NOW0); ev({ type: 'idea_answered', id: 'i2', answer: 'no', note: '' }, NOW0); ev({ type: 'idea_answered', id: 'i3', answer: 'no', note: '' }, NOW0);
  ev({ type: 'idea_answered', id: 'i5', answer: 'later', note: '' }, NOW0); ev({ type: 'idea_answered', id: 'i6', answer: 'yes', note: '' }, NOW0);
  // ledger: steward rows 0.1 and 0.25 in the week, 0.5 before it, and a non-steward row of 1.0 in the week
  const row = (item, at, cost) => JSON.stringify({ at: iso(at), item, cost_usd: cost }) + '\n';
  fs.writeFileSync(S.ledgerFile(), row('steward:alpha', IN, 0.1) + row('steward:beta', NOW0, 0.25) + row('steward:alpha', OUT, 0.5) + row('other', IN, 1.0));
  // tuning log: one change in the week, one before it
  fs.writeFileSync(sf('tuning.log.jsonl'), JSON.stringify({ at: iso(NOW0 - DAY), kind: 'change', rule: 'R1' }) + '\n' + JSON.stringify({ at: iso(OUT - DAY), kind: 'keep' }) + '\n');
  const r = S.report(cfg, NOW0);
  assert.deepEqual(r, {
    weekEnds: iso(WEEK_END_S * 1000), used: round2(1.35 / 20.94), elapsed: 0.5, source: 'ledger', visits: 4, byProject: { alpha: 3, beta: 1 }, held: { pace: 2, owner: 1 },
    spendUsd: 0.35, ideasAdded: 5, yes: 1, no: 2, open: 1, paceError: 0.075, acceptShare: 0.33, costPerAccepted: 0.35, tokens: { calls: 2, inPerCall: null, outPerCall: null, briefEst: null }, pace: { decision: 'hold', reason: 'meter', detail: 'no meter reading', reprobe: true, code: 3 }, tuningChanges: [{ at: iso(NOW0 - DAY), kind: 'change', rule: 'R1' }],
  });
});
const round2 = v => +v.toFixed(2);

test('report: an empty week has zeros and nulls', () => {
  fresh(); const cfg = C();
  assert.deepEqual(S.report(cfg, NOW0), { weekEnds: iso(WEEK_END_S * 1000), used: 0, elapsed: 0.5, source: 'ledger', visits: 0, byProject: {}, held: {}, spendUsd: 0, ideasAdded: 0, yes: 0, no: 0, open: 0, paceError: null, acceptShare: null, costPerAccepted: null, tokens: { calls: 0, inPerCall: null, outPerCall: null, briefEst: null }, pace: { decision: 'hold', reason: 'meter', detail: 'no meter reading', reprobe: true, code: 3 }, tuningChanges: [] });   // pace: the one pace line's fields (P2-178); no meter in this world
});

// ---------------------------------------------------------------- 8. setPhase
test('setPhase: writes and merges into the owner file', () => {
  const f = w0.ownerConfig;
  setConfig(w0, {});
  assert.equal(S.setPhase('half'), f);
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify({ pace: { phase: 'half' } }, null, 2) + '\n');
  assert.equal(S.loadConfig().pace.phase, 'half');
  setConfig(w0, { mode: 'login', pace: { ceiling: 0.8, phase: 'half' }, call: { model: 'haiku' } });
  S.setPhase('full');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mode: 'login', pace: { ceiling: 0.8, phase: 'full' }, call: { model: 'haiku' } });
  assert.equal(S.loadConfig().pace.phase, 'full'); assert.equal(S.loadConfig().pace.ceiling, 0.8);
  S.setPhase('shadow'); assert.equal(S.loadConfig().pace.phase, 'shadow');
  setConfig(w0, {});
});

test('setPhase: a wrong name is refused and the file is untouched', () => {
  setConfig(w0, { mode: 'login' });
  const before = fs.readFileSync(w0.ownerConfig, 'utf8');
  for (const bad of ['fast', '', 'Half', 'constructor']) assert.throws(() => S.setPhase(bad), e => e instanceof S.StewardError && e.code === 1 && e.message === 'phase must be one of: shadow, half, full', `name "${bad}"`);
  assert.equal(fs.readFileSync(w0.ownerConfig, 'utf8'), before);
  setConfig(w0, {});
});

test('setPhase: an owner file holding [] is refused; null becomes {}', () => {
  try {
    fs.writeFileSync(w0.ownerConfig, '[]');
    assert.throws(() => S.setPhase('half'), e => e instanceof S.StewardError && e.code === 1 && e.message === `${w0.ownerConfig} is not a JSON object`);
    assert.equal(fs.readFileSync(w0.ownerConfig, 'utf8'), '[]', 'nothing was written');
    fs.writeFileSync(w0.ownerConfig, 'null');
    S.setPhase('half');
    assert.deepEqual(JSON.parse(fs.readFileSync(w0.ownerConfig, 'utf8')), { pace: { phase: 'half' } });
  } finally { setConfig(w0, {}); }
});

// ---------------------------------------------------------------- 9. initFiles
test('initFiles: creates the projects file once from the example, never overwrites it, creates run/', () => {
  const d = fresh(); const pf = path.join(d, 'deep', 'projects.json'); process.env.WK_PROJECTS = pf;
  try {
    const r = S.initFiles();
    assert.deepEqual(r, { dir: S.stewardDir(), projects: pf, created: true });
    assert.equal(fs.readFileSync(pf, 'utf8'), fs.readFileSync(new URL('../config/projects.example.json', import.meta.url), 'utf8'));
    assert.equal(fs.statSync(path.join(S.stewardDir(), 'run')).isDirectory(), true);
    fs.writeFileSync(pf, '{"projects":[]}');
    assert.deepEqual(S.initFiles(), { dir: S.stewardDir(), projects: pf, created: false });
    assert.equal(fs.readFileSync(pf, 'utf8'), '{"projects":[]}');
  } finally { process.env.WK_PROJECTS = w0.projectsFile; }
});
