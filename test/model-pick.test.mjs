// P2-227 follow-up: the model picker (bin/model-pick.mjs) and the one list of legal words (panel/src/legal-words.js).
// A temp HOME and WK_HOME; nothing here runs claude. The signals are read from trimmed real samples in test/fixtures
// (model-missing.*, model-ok-fable-5-2.*) and two constructed busy answers (model-busy.json, model-overloaded.json).
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-pick-'));
const WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK;
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const FX = n => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');
const P = await import('../bin/model-pick.mjs');
const S = await import('../bin/steward-lib.mjs');
const G = await import('../bin/gemini-lib.mjs');
const H = 3600000, T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const clear = () => fs.rmSync(WK, { recursive: true, force: true });
const auditLines = () => { try { return fs.readFileSync(P.auditFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('config/models.json: legal starts with claude-fable-5-2 and ends with a model every plan has; efforts xhigh and max', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'config', 'models.json'), 'utf8'));
  assert.deepEqual(raw.legal, ['claude-fable-5-2', 'fable', 'opus', 'sonnet']);
  assert.match(raw._comment, /newer Fable/);
  const c = P.config();
  assert.deepEqual(P.order('legal', c), raw.legal); assert.equal(c.legal_effort_job, 'xhigh'); assert.equal(c.legal_effort_ask, 'max'); assert.equal(c.cache_hours, 24);
  assert.ok(P.inOrder('legal', 'fable', c)); assert.ok(!P.inOrder('legal', 'haiku', c));
});

test('signals: the real 404 sample is "not available"; the stderr tag and a good run are not; 429 and 529 are busy, never unavailable', () => {
  const missingJson = FX('model-missing.json'), missingNd = FX('model-missing.ndjson'), ok = FX('model-ok-fable-5-2.json');
  assert.ok(P.isUnavailable(missingJson)); assert.ok(P.isUnavailable(missingNd)); assert.ok(P.isUnavailable(JSON.parse(missingJson)));
  // the result line alone, and the synthetic assistant message alone, are each enough
  const nd = missingNd.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(P.isUnavailable(nd.filter(o => o.type === 'result'))); assert.ok(P.isUnavailable(nd.filter(o => o.type === 'assistant')));
  assert.equal(JSON.parse(missingJson).subtype, 'success', 'the real sample says "success" even so: is_error is what counts');
  assert.ok(!P.isBusy(missingJson));
  assert.ok(!P.isUnavailable(ok)); assert.ok(!P.isBusy(ok));
  assert.ok(!P.isUnavailable(FX('model-ok-fable-5-2.stderr.txt'))); assert.ok(!P.isBusy(FX('model-ok-fable-5-2.stderr.txt')));
  for (const f of ['model-busy.json', 'model-overloaded.json']) { assert.ok(P.isBusy(FX(f)), f); assert.ok(!P.isUnavailable(FX(f)), f); }
  // a rate-limit event that is not "allowed" makes a failed run busy; an allowed one, or one on a good run, does not
  const fail = { type: 'result', is_error: true, result: 'error' };
  assert.ok(P.isBusy([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, fail]));
  assert.ok(!P.isBusy([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, fail]));
  assert.ok(!P.isBusy([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, { type: 'result', is_error: false }]));
  for (const x of [null, '', 'not json', {}, [], 42]) { assert.ok(!P.isUnavailable(x)); assert.ok(!P.isBusy(x)); }
});

test('pick and the 24-hour cache: unavailable models are skipped, then tried again; the file is private', () => {
  clear();
  assert.deepEqual(P.pick('legal', { now: T0 }), { lane: 'legal', model: 'claude-fable-5-2', skipped: [], exhausted: false });
  P.markUnavailable('legal', 'claude-fable-5-2', { now: T0, from: 'test', why: 'not available', next: 'fable' });
  assert.equal(P.pick('legal', { now: T0 + 23 * H }).model, 'fable');
  assert.deepEqual(P.pick('legal', { now: T0 + 23 * H }).skipped, ['claude-fable-5-2']);
  assert.equal(P.pick('legal', { now: T0 + 24 * H }).model, 'claude-fable-5-2', 'the cache expires after 24 hours');
  assert.equal(fs.statSync(P.cacheFile()).mode & 0o777, 0o600);
  const a = auditLines(); assert.equal(a.length, 1);
  assert.deepEqual([a[0].ev, a[0].lane, a[0].model, a[0].next, a[0].from], ['model-fallback', 'legal', 'claude-fable-5-2', 'fable', 'test']);
  // every model unavailable: the last one (the most widely held) is tried again
  for (const m of ['fable', 'opus', 'sonnet']) P.markUnavailable('legal', m, { now: T0 });
  assert.deepEqual(P.pick('legal', { now: T0 + H }), { lane: 'legal', model: 'sonnet', skipped: ['claude-fable-5-2', 'fable', 'opus', 'sonnet'], exhausted: true });
  // markWorked writes an audit line only when the pick changes
  clear();
  P.markWorked('legal', 'fable', { now: T0 }); P.markWorked('legal', 'fable', { now: T0 + 1 }); P.markWorked('legal', 'claude-fable-5-2', { now: T0 + 2 });
  assert.deepEqual(auditLines().map(x => [x.ev, x.model]), [['model-picked', 'fable'], ['model-picked', 'claude-fable-5-2']]);
  // a broken or hostile cache file is ignored, never trusted
  fs.writeFileSync(P.cacheFile(), JSON.stringify({ unavailable: { 'claude-fable-5-2': { at: T0 + 99 * H }, '../etc': { at: T0 } }, picked: 'x' }));
  assert.equal(P.pick('legal', { now: T0 }).model, 'claude-fable-5-2');
  fs.writeFileSync(P.cacheFile(), 'not json'); assert.equal(P.pick('legal', { now: T0 }).model, 'claude-fable-5-2');
  assert.throws(() => P.pick('nope'), /no model order/);
});

test('runPicked: "not available" moves on; busy waits and tries the SAME model, only while the pace allows', async () => {
  const ok = { out: FX('model-ok-fable-5-2.json') }, missing = { out: FX('model-missing.ndjson') }, busy = { out: FX('model-busy.json') }, over = { out: FX('model-overloaded.json') };
  const run = async (answers, o = {}) => { const seen = [], waits = []; const q = [...answers];
    const res = await P.runPicked('legal', async m => { seen.push(m); return typeof q[0] === 'function' ? q.shift()(m) : q.shift() || ok; }, { sleep: async ms => { waits.push(ms); }, waitMs: 5, ...o });
    return { res, seen, waits }; };
  clear();
  let x = await run([missing, ok]);
  assert.deepEqual(x.seen, ['claude-fable-5-2', 'fable']); assert.equal(x.res.model, 'fable'); assert.equal(x.res.fallbacks.length, 1); assert.equal(x.waits.length, 0);
  x = await run([ok]); assert.deepEqual(x.seen, ['fable'], 'the cached fallback holds for the next call');
  clear();
  x = await run([busy, over, ok]);
  assert.deepEqual(x.seen, ['claude-fable-5-2', 'claude-fable-5-2', 'claude-fable-5-2']); assert.deepEqual(x.waits, [5, 5]);
  assert.equal(x.res.model, 'claude-fable-5-2'); assert.equal(x.res.busy, false);
  assert.ok(!auditLines().some(a => a.ev === 'model-fallback'), 'busy never counts as a fallback');
  x = await run([busy, busy, busy], { retries: 1 });
  assert.deepEqual(x.seen, ['claude-fable-5-2', 'claude-fable-5-2']); assert.equal(x.res.busy, true); assert.equal(x.res.model, 'claude-fable-5-2');
  let paceChecks = 0;
  x = await run([busy, ok], { paceOk: () => { paceChecks++; return false; } });
  assert.deepEqual(x.seen, ['claude-fable-5-2'], 'over the pace line: no retry, and no other model'); assert.equal(x.res.busy, true); assert.equal(paceChecks, 1);
  clear();
  x = await run([missing, missing, missing, missing]);
  assert.deepEqual(x.seen, ['claude-fable-5-2', 'fable', 'opus', 'sonnet']); assert.equal(x.res.exhausted, true);
  x = await run([{ stopped: true }]); assert.equal(x.res.r.stopped, true);
});

test('the CLI prints the pick and the skipped models', () => {
  clear(); P.markUnavailable('legal', 'claude-fable-5-2', { now: Date.now() });
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'model-pick.mjs'), 'legal', '--json'], { encoding: 'utf8', env: { ...process.env, HOME, WK_HOME: WK } });
  assert.equal(r.status, 0, r.stderr); const j = JSON.parse(r.stdout);
  assert.equal(j.model, 'fable'); assert.deepEqual(j.skipped, ['claude-fable-5-2']);
  clear();
});

test('the legal words: every word in the brief matches, plain English does not', () => {
  for (const t of ['terms', 'Privacy', 'licence', 'license', 'Licensed fonts', 'contract', 'consent', 'GDPR', 'compliance', 'liability', 'disclaimer',
    'copyright', 'trademark', 'cookie policy', 'data protection', 'refund policy', 'warranty', 'legal', 'Terms-of-Service', 'the NDA', 'EULA'])
    assert.notEqual(P.isLegal(`Please check the ${t} page`), null, t);
  assert.equal(P.isLegal('Rewrite the privacy policy'), 'privacy policy', 'the longest phrase is reported');
  for (const t of ['Fix the footer', 'Make it better in terms of speed', 'An illegally long line', 'contractor list', 'the patently obvious bug', '', null, undefined])
    assert.equal(P.isLegal(t), null, String(t));
  assert.equal(P.legalLabel('claude-fable-5-2'), 'Legal: newest top model (claude-fable-5-2)'); assert.equal(P.legalLabel(), 'Legal: newest top model');
  assert.ok(Object.isFrozen(P.LEGAL_WORDS));
});

test('one list only: no other file keeps three or more legal words of its own; the steward and the Gemini lane use the list', () => {
  const words = new Set(P.LEGAL_WORDS.map(w => w.toLowerCase()));
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(m?js|json|css|html)$/.test(e.name)) files.push(f); } };
  for (const d of ['bin', 'panel/src', 'panel/media', 'panel/scripts', 'config', 'antigravity']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  assert.ok(files.length > 20, `${files.length} files scanned`);
  const own = path.join(root, 'panel', 'src', 'legal-words.js');
  for (const f of files) {
    if (f === own) continue;
    const t = fs.readFileSync(f, 'utf8').toLowerCase(), found = new Set();
    // quoted strings, and the pieces of a regular-expression alternation
    for (const m of t.matchAll(/(['"`])([^'"`\n]{2,40}?)\1/g)) if (words.has(m[2].trim())) found.add(m[2].trim());
    for (const m of t.matchAll(/[(|]([a-z][a-z \\s-]{1,30})(?=[|)])/g)) { const w = m[1].replace(/\\s[+*]?/g, ' ').trim(); if (words.has(w)) found.add(w); }
    assert.ok(found.size < 3, `${path.relative(root, f)} keeps its own legal words: ${[...found].join(', ')}`);
  }
  // the steward's waitWords no longer hold legal words; a legal idea still waits for the owner
  const st = JSON.parse(fs.readFileSync(path.join(root, 'config', 'steward.json'), 'utf8'));
  for (const w of st.gates.waitWords) assert.equal(P.isLegal(w), null, `steward waitWords keeps "${w}"`);
  const Gt = st.gates, re = S.waitRegexes(Gt);
  for (const title of ['Update the privacy policy', 'Add a GDPR consent banner', 'Check the font licence', 'Fix the trademark line'])
    assert.equal(S.finalGate({ title, why: 'x', kind: 'code', impact: 1, gate: 'auto' }, Gt, re), 'wait', title);
  assert.equal(S.finalGate({ title: 'Fix the footer', why: 'x', kind: 'code', impact: 1, gate: 'auto' }, Gt, re), 'auto');
  assert.equal(S.finalGate({ title: 'Change the price', why: 'x', kind: 'code', impact: 1, gate: 'auto' }, Gt, re), 'wait', 'the other wait words still work');
  // the Gemini queue: a legal title goes to the legal lane, the strongest Gemini model
  const gc = G.config();
  assert.equal(G.guessKind('Draft the terms of service', '', gc), 'legal');
  assert.notEqual(G.guessKind('Fix the footer', '', gc), 'legal');
  assert.equal(gc.routes.legal.model, gc.routes.hard.model); assert.equal(gc.routes.legal.fallback, gc.routes.hard.fallback);
});
