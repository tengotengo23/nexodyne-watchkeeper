// P2-227: the Mac's judge (bin/remote-lib.mjs). Keys are made here with crypto.generateKeyPairSync; nothing leaves this process.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-remote-'));
process.env.HOME = HOME; process.env.WK_HOME = path.join(HOME, '.wk');
const L = await import('../bin/remote-lib.mjs');
const P = await import('./fixtures/passkey.mjs');

const remote = { ...L.REMOTE_DEFAULTS, enabled: true, rp_id: P.RP, origin: P.ORIGIN };
const pk = P.makePasskey();
const keys = P.trusted(pk);
const seenFile = () => path.join(fs.mkdtempSync(path.join(HOME, 's-')), 'seen.jsonl');
const check = (env, o = {}) => L.checkEnvelope(env, { remote, keys, seen: new L.Seen(seenFile()), ...o });

test('canonical: the brief\'s test vector, and base64url without padding', () => {
  assert.equal(L.canonical({ b: [2, { d: 1, c: 'é' }], a: 'x' }), '{"a":"x","b":[2,{"c":"é","d":1}]}');
  assert.equal(L.b64u(Buffer.from([0xfb, 0xff])), '-_8');
  assert.deepEqual([...L.fromB64u('-_8')], [0xfb, 0xff]);
  assert.throws(() => L.fromB64u('a+b='));
});

test('a valid passkey command passes; a valid grant command passes', () => {
  const r = check(P.viaPasskey(pk, P.command('ping')));
  assert.equal(r.ok, true, r.reason); assert.equal(r.via, 'passkey'); assert.equal(r.command.kind, 'ping');
  const g = P.makeGrant(pk);
  const r2 = check(P.viaGrant(g, P.command('later', { n: '12' })));
  assert.equal(r2.ok, true, r2.reason); assert.equal(r2.via, 'grant');
});

test('refused: wrong origin, wrong RP, no UV, no UP, bad signature, unknown key, wrong challenge, phone control off', () => {
  const cases = [
    [{ origin: 'https://evil.example' }, /another website/],
    [{ rpId: 'evil.example' }, /another site/],
    [{ flags: 0x01 }, /face or passcode/],
    [{ flags: 0x04 }, /confirm that you were there/],
    [{ signWith: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }, /not valid/],
    [{ challenge: L.b64u(Buffer.alloc(32)) }, /does not match/],
    [{ type: 'webauthn.create' }, /not a passkey sign-in/],
  ];
  for (const [opts, re] of cases) { const r = check(P.viaPasskey(pk, P.command('ping'), opts)); assert.equal(r.ok, false); assert.match(r.reason, re, JSON.stringify(opts)); }
  const stranger = P.makePasskey('Other');
  assert.match(check(P.viaPasskey(stranger, P.command('ping'))).reason, /not trusted/);
  assert.match(L.checkEnvelope(P.viaPasskey(pk, P.command('ping')), { remote: { ...remote, enabled: false }, keys, seen: null }).reason, /^Phone control is off on the Mac\.$/);
  // a forged command: the signature covers another command
  const a = P.viaPasskey(pk, P.command('ping')); a.command = { ...a.command, kind: 'stop-off' };
  assert.equal(check(a).ok, false);
});

test('the sign counter must rise when both sides count', () => {
  const k = { keys: [{ ...keys.keys[0], sign_count: 5 }], rejected: [] };
  assert.match(check(P.viaPasskey(pk, P.command('ping'), { counter: 5 }), { keys: k }).reason, /used before/);
  const ok = check(P.viaPasskey(pk, P.command('ping'), { counter: 6 }), { keys: k });
  assert.equal(ok.ok, true); assert.deepEqual(ok.bump, { cred: pk.id, counter: 6 });
  assert.equal(check(P.viaPasskey(pk, P.command('ping'), { counter: 0 }), { keys: k }).ok, true, 'a phone that does not count (0) passes');
});

test('replay returns the stored result and does not pass again; a new envelope with a seen id too', () => {
  const seen = new L.Seen(seenFile());
  const env = P.viaPasskey(pk, P.command('ping'));
  const first = L.checkEnvelope(env, { remote, keys, seen });
  assert.equal(first.ok, true);
  seen.add(first.id, { ok: true, text: 'pong mac 10:00' }, first.hash);
  const again = L.checkEnvelope(JSON.parse(JSON.stringify(env)), { remote, keys, seen });
  assert.equal(again.ok, false); assert.equal(again.stored.text, 'pong mac 10:00');
  const other = P.viaPasskey(pk, { ...env.command });   // same id, signed again
  const r = L.checkEnvelope(other, { remote, keys, seen: new L.Seen(seen.file) });
  assert.equal(r.ok, false); assert.equal(r.stored.text, 'pong mac 10:00', 'the store survives a restart');
});

test('too old, in the future: decide kinds 24 h, prompt kinds 2 h, 5 min ahead at most', () => {
  const now = Date.now();
  assert.match(check(P.viaPasskey(pk, P.command('ping', {}, now - 25 * 3600e3))).reason, /too old/);
  assert.equal(check(P.viaPasskey(pk, P.command('ping', {}, now - 23 * 3600e3))).ok, true);
  assert.match(check(P.viaPasskey(pk, P.command('stop-off', {}, now - 3 * 3600e3))).reason, /too old \(over 2 hours\)/);
  assert.match(check(P.viaPasskey(pk, P.command('ping', {}, now + 6 * 60e3))).reason, /future/);
  assert.equal(check(P.viaPasskey(pk, P.command('ping', {}, now + 4 * 60e3))).ok, true);
});

test('grants: prompt kinds refused, over 10 minutes, expired, outside the window, other scopes, bad session signature', () => {
  const g = P.makeGrant(pk);
  for (const kind of ['job-start', 'job-reply', 'stop-off']) {
    const args = kind === 'job-start' ? { project: 'site', prompt: 'hi', model: 'haiku', mode: 'plan' } : kind === 'job-reply' ? { job: 'J-20261116-1902-a3f9', prompt: 'go on' } : {};
    assert.match(check(P.viaGrant(g, P.command(kind, args))).reason, /fresh Face ID/, kind);
    assert.equal(check(P.viaPasskey(pk, P.command(kind, args))).ok, true, kind + ' with a passkey');
  }
  assert.match(check(P.viaGrant(P.makeGrant(pk, { life: 600001 }), P.command('ping'))).reason, /longer than 10 minutes/);
  const old = P.makeGrant(pk, { issued_at: Date.now() - 13 * 60e3 });
  assert.match(check(P.viaGrant(old, P.command('ping', {}, Date.now() - 12 * 60e3))).reason, /has ended/);
  const recent = P.makeGrant(pk, { issued_at: Date.now() - 11 * 60e3 });
  assert.equal(check(P.viaGrant(recent, P.command('ping', {}, Date.now() - 10.5 * 60e3))).ok, true, 'two minutes of clock grace');
  assert.match(check(P.viaGrant(g, P.command('ping', {}, g.grant.issued_at - 61e3))).reason, /outside the phone's session/);
  assert.match(check(P.viaGrant(g, P.command('ping', {}, g.grant.expires_at + 1))).reason, /outside the phone's session/);
  assert.match(check(P.viaGrant(P.makeGrant(pk, { scopes: ['decide', 'prompt'] }), P.command('ping'))).reason, /may only decide/);
  const env = P.viaGrant(g, P.command('ping')); env.auth.signature = L.b64u(Buffer.alloc(64, 1));
  assert.match(check(env).reason, /session signature is not valid/);
  const env2 = P.viaGrant(g, P.command('ping')); env2.auth.grant = { ...g.grant, expires_at: g.grant.expires_at - 1 };
  assert.match(check(env2).reason, /does not match/, 'a changed grant breaks its passkey assertion');
});

test('a kind not on the allowlist is refused; turning phone control on is not a kind', () => {
  for (const kind of ['remote-on', 'shell', 'trust', 'eval', 'job-run']) assert.equal(check(P.viaPasskey(pk, P.command(kind))).reason, 'Not something the phone can do.', kind);
});

test('bad arguments are refused for every kind', () => {
  const bad = {
    ping: [{ x: 1 }],
    answer: [{}, { n: '0', text: 'x' }, { n: '12' }, { n: '12', text: 'a', use_recommended: true }, { n: '12', text: 'x'.repeat(2001) }, { n: '12', text: 'two\nlines' },
      { n: '12', use_recommended: false }, { n: '12', text: '  ' }, { n: '12', text: 'x', confirmed: 'yes' }, { n: '12', text: 'x', extra: 1 }],
    later: [{}, { n: 'Q12' }, { n: '12', text: 'x' }],
    suggestion: [{ id: 'S-1', choice: 'ok' }, { id: 'S-20261116-120000-abcd', choice: 'maybe' }, { id: 'S-20261116-120000-abcd', choice: 'ok', confirmed: 1 }],
    task: [{ title: 'x'.repeat(121), text: '', kind: 'code' }, { title: 'a', text: 'x'.repeat(4001), kind: 'code' }, { title: 'a', text: '', kind: 'shell' }, { title: 'a', text: '', kind: 'code', test: 'a\nb' }, { title: 'a', text: '', kind: 'code', test: 'x'.repeat(501) }],
    send: [{ kind: 'rule' }, { kind: 'other', text: 'x' }, { kind: 'rule', text: 'x'.repeat(4001) }],
    'stop-on': [{ now: true }], 'remote-off': [{ x: 1 }], 'stop-off': [{ x: 1 }],
    'job-stop': [{}, { job: '../J-1' }],
    'job-start': [{ project: 'site', prompt: 'x', model: 'gpt', mode: 'plan' }, { project: 'site', prompt: 'x', model: 'haiku', mode: 'bypassPermissions' },
      { project: '../etc', prompt: 'x', model: 'haiku', mode: 'plan' }, { project: 'site', prompt: 'x'.repeat(8001), model: 'haiku', mode: 'plan' },
      { project: 'site', prompt: 'x', model: 'haiku', mode: 'plan', max_turns: 401 }, { project: 'site', prompt: 'x', model: 'haiku', mode: 'plan', max_turns: 0 },
      { project: 'site', prompt: 'x', model: 'haiku', mode: 'plan', add_dir: '/' }],
    'job-reply': [{ job: 'J-20261116-1902-a3f9' }, { job: 'J-x', prompt: 'x' }, { job: 'J-20261116-1902-a3f9', prompt: 'x'.repeat(8001) }],
  };
  for (const [kind, list] of Object.entries(bad)) for (const args of list) {
    assert.equal(check(P.viaPasskey(pk, P.command(kind, args))).reason, 'The command\'s details are not valid.', `${kind} ${JSON.stringify(args).slice(0, 80)}`);
  }
  const good = { answer: { n: 12, q: '0123456789abcdef', use_recommended: true, confirmed: true }, task: { title: 'Fix it', text: '', kind: 'auto', test: 'npm test' }, send: { kind: 'recommendation', text: 'hi' },
    suggestion: { id: 'S-20261116-120000-abcd', choice: 'later' }, 'job-stop': { job: 'J-20261116-1902-a3f9' }, 'job-start': { project: 'site', prompt: 'x', model: 'fable', mode: 'acceptEdits', max_turns: 400 } };
  for (const [kind, args] of Object.entries(good)) assert.equal(check(P.viaPasskey(pk, P.command(kind, args))).ok, true, kind);
});

test('envelope shape: no auth, an unsigned via, too large', () => {
  assert.match(check({ command: P.command('ping') }).reason, /broken or too large/);
  assert.match(check({ command: P.command('ping'), auth: { via: 'none' } }).reason, /not signed/);
  const big = P.viaPasskey(pk, P.command('send', { kind: 'rule', text: 'x'.repeat(3000) })); big.auth.pad = 'x'.repeat(70000);
  assert.match(check(big).reason, /too large/);
});

test('the scan: secrets, e-mail addresses and phone numbers hide; Watchkeeper ids, dates and the home folder do not', () => {
  const c = { hidden: 0 };
  const out = L.scrub({ a: `${HOME}/Projects/x`, b: 'key sk-ant-' + 'a'.repeat(30), c: 'mail mum@gmail.com', d: 'call +995 555 12 34 56', e: 'J-20261116-1902-a3f9 at 2026-11-16 19:02', f: [HOME], n: 5 }, { home: HOME, counter: c });
  assert.deepEqual(out, { a: '~/Projects/x', b: '[hidden]', c: '[hidden]', d: '[hidden]', e: 'J-20261116-1902-a3f9 at 2026-11-16 19:02', f: ['~'], n: 5 });
  assert.equal(c.hidden, 3);
  assert.equal(L.cleanCut('x'.repeat(10), 5), 'xxxx…');
});

// ---------------------------------------------------------------- review fixes (W2)
const { FAKE } = await import('./fixtures/fake-secrets.mjs');

test('answer: the question hash q is required, 16 lowercase hex; questionHash is SHA-256 of the UTF-8 text, cut to 16', () => {
  const ok = q => check(P.viaPasskey(pk, P.command('answer', { n: '7', ...(q === undefined ? {} : { q }), use_recommended: true }))).reason || 'ok';
  assert.equal(ok('0123456789abcdef'), 'ok');
  for (const q of [undefined, '', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', 'g123456789abcdef', 1234567890123456, null])
    assert.equal(ok(q), 'The command\'s details are not valid.', String(q));
  assert.equal(L.questionHash('Show the pace bar first?'), crypto.createHash('sha256').update('Show the pace bar first?', 'utf8').digest('hex').slice(0, 16));
  assert.equal(L.questionHash('Ünïcode ✓'), crypto.createHash('sha256').update(Buffer.from('Ünïcode ✓', 'utf8')).digest('hex').slice(0, 16));
  assert.match(L.questionHash('x'), /^[0-9a-f]{16}$/);
});

test('a grant dated more than 5 minutes ahead is refused; 4 minutes ahead (clock skew) still works', () => {
  const now = Date.now();
  const far = P.makeGrant(pk, { issued_at: now + 6 * 60000 });
  const r = check(P.viaGrant(far, P.command('ping', {}, now + 6 * 60000)), { now });
  assert.equal(r.ok, false); assert.equal(r.reason, 'The phone\'s session starts in the future. Check the phone\'s clock.');
  assert.equal(L.checkGrant(far.grant, { issued_at: now + 6 * 60000 }, now).ok, false);
  const near = P.makeGrant(pk, { issued_at: now + 4 * 60000 });
  assert.equal(L.checkGrant(near.grant, { issued_at: now + 4 * 60000 }, now).ok, true);
});

test('cleanCut scans before it cuts: a key the cut would split is still hidden', () => {
  const key = 'sk-ant-' + 'a'.repeat(25);   // a whole key; cut after 'sk-ant-aa' it no longer matches {20,}
  assert.equal(L.secretHit(('x'.repeat(90) + key).slice(0, 99)), false);   // the piece alone passes the scan: why the order matters
  const s = 'x'.repeat(90) + key;
  assert.equal(L.cleanCut(s, 100), '[hidden]');
  assert.equal(L.cleanCut('x'.repeat(200), 100), 'x'.repeat(99) + '…');   // plain text is still cut as before
});

test('the outgoing scan hides the review\'s extra shapes; gates.json (wk-guard\'s list) is unchanged', () => {
  for (const [k, v] of Object.entries(FAKE)) {
    assert.equal(L.secretHit(v), true, k);
    assert.deepEqual(L.scrub({ text: v }), { text: '[hidden]' }, k);
  }
  assert.equal(L.secretHit('const API_KEY = process.env.API_KEY'), true);   // fail closed here: hidden, never blocked
  assert.equal(L.secretHit('const apiKey = process.env.apiKey; token: string'), false);
  const g = JSON.parse(fs.readFileSync(path.resolve('config/gates.json'), 'utf8'));
  assert.deepEqual(g.secretPatterns, ['sk-ant-[A-Za-z0-9_-]{20,}', 'sk_live_[A-Za-z0-9]{16,}', 'AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{30,}', '-----BEGIN [A-Z ]*PRIVATE KEY-----']);
  for (const re of L.OUTGOING_SECRETS) assert.ok(!g.secretPatterns.includes(re), re);
});

// Owner's choice, 19 Nov 2026: the panel's own sign-in is the only one. Opt-in, set only on the Mac (wk-remote login panel).
test('login panel: unsigned panel commands pass only when the Mac chose it, and keep every other check', () => {
  const panel = { ...remote, login: 'panel' };
  const env = (kind, args, extra = {}) => ({ command: P.command(kind, args), auth: { via: 'panel', ...extra } });
  const ok = L.checkEnvelope(env('ping'), { remote: panel, keys: { keys: [] }, seen: new L.Seen(seenFile()) });
  assert.equal(ok.ok, true, ok.reason); assert.equal(ok.via, 'panel'); assert.equal(ok.verified, true);
  // prompt kinds run without a fresh Face ID in this mode
  const job = L.checkEnvelope(env('job-start', { project: 'site', prompt: 'hi', model: 'haiku', mode: 'plan' }), { remote: panel, keys: { keys: [] }, seen: null });
  assert.equal(job.ok, true, job.reason);
  // default (Face ID) mode refuses it, naming the fix; nothing counts against the budget
  const off = L.checkEnvelope(env('ping'), { remote, keys, seen: null });
  assert.equal(off.ok, false); assert.equal(off.verified, false); assert.match(off.reason, /wk-remote login panel/);
  assert.equal(L.readRemote().login, 'passkey');
  // phone control off, an extra field, an unknown kind, a bad argument and a replay still fail
  assert.match(L.checkEnvelope(env('ping'), { remote: { ...panel, enabled: false }, keys, seen: null }).reason, /off on the Mac/);
  assert.equal(L.checkEnvelope(env('ping', {}, { grant: {} }), { remote: panel, keys, seen: null }).ok, false);
  assert.match(L.checkEnvelope(env('format-disk'), { remote: panel, keys, seen: null }).reason, /Not something/);
  assert.match(L.checkEnvelope(env('job-start', { project: 'site', prompt: 'x', model: 'haiku', mode: 'bypassPermissions' }), { remote: panel, keys, seen: null }).reason, /not valid/);
  const seen = new L.Seen(seenFile()), e1 = env('ping');
  assert.equal(L.checkEnvelope(e1, { remote: panel, keys, seen }).ok, true);
});
