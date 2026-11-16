// remote-lib (P2-227): what the Mac checks before the phone may make it act. Node built-ins only.
// canonical() and b64u() are the shared format (docs/REMOTE.md); checkEnvelope() is the judge: phone control on, every passkey
// assertion (trusted key, webauthn.get, origin, challenge, RP ID hash, UP and UV, DER signature, sign counter), the session grant
// (10 minutes at most, decide kinds only, P1363 signature), then the command itself (version, never-seen id, age, kind allowlist,
// prompt kinds only with a fresh passkey, exact arguments). It never runs anything: wk-bridge acts on what passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gates } from './lib.mjs';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = v => typeof v === 'number' && Number.isInteger(v);

// ------------------------------------------------------------------ the shared format
// JSON with object keys sorted at every level, no spaces, arrays in order, values as JSON.stringify writes them.
export function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(v => (v === undefined || typeof v === 'function' ? 'null' : canonical(v))).join(',') + ']';
  if (isObj(x)) return '{' + Object.keys(x).sort().filter(k => x[k] !== undefined && typeof x[k] !== 'function').map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
export const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B64U = /^[A-Za-z0-9_-]*$/;
export function fromB64u(s) {
  if (typeof s !== 'string' || !B64U.test(s) || s.length % 4 === 1) throw new Error('not base64url');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
export const sha256 = data => crypto.createHash('sha256').update(data).digest();
export const challengeFor = obj => b64u(sha256(Buffer.from(canonical(obj), 'utf8')));

// ------------------------------------------------------------------ files under ~/.wk (or $WK_HOME)
export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export const FILES = {
  remote: () => path.join(wkHome(), 'remote.json'),
  keys: () => path.join(wkHome(), 'remote-keys.json'),
  pending: () => path.join(wkHome(), 'remote-pending.json'),
  seen: () => path.join(wkHome(), 'remote-seen.jsonl'),
  log: () => path.join(wkHome(), 'remote-log.jsonl'),
  status: () => path.join(wkHome(), 'remote-status.json'),
};
// No built-in server (P2-243): origin, rp_id, host, user and server_command stay empty until `wk-bridge config` sets them (panel/src/data.js has the same shape).
// server_command: the program the server runs for this key (the forced command in its authorized_keys line).
export const REMOTE_DEFAULTS = Object.freeze({ enabled: false, origin: '', rp_id: '',
  host: '', port: 22, user: '', server_command: '', key: '~/.ssh/wk_bridge_ed25519', max_jobs: 2, job_hours: 3, pace_stop_pct: 90 });
const BRIDGE = 'node ' + path.join(path.dirname(new URL(import.meta.url).pathname), 'wk-bridge.mjs');
export const SET_SERVER = `Phone control needs a companion server (not published yet). If you run one: ${BRIDGE} config --origin https://... --host ...`;
export const SET_USER = `Set the ssh user first: ${BRIDGE} config --user NAME`;
export const SET_COMMAND = `Set the program the server runs for this ssh key first: ${BRIDGE} config --server-command PATH`;
// Why the link may not start yet (null: the server is set). The link and every command that reaches the server ask this first.
export function serverProblem(r) {
  if (!r || !r.origin || !r.host) return SET_SERVER;
  if (!r.user) return SET_USER;
  return null;
}
// wk-bridge config: checks each value and returns the patch for writeRemote, or throws with a plain message.
// o: { origin, host, port, user, rp_id, server_command } as typed (strings, null when not given); cur: readRemote().
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;   // the same rule as bridge-link's sshArgv: no spaces, no shell characters
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const COMMAND_RE = /^\/[A-Za-z0-9._\/-]{1,254}$/;   // an absolute path; it sits inside command="..." on the server, so nothing that could end the quotes
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export function serverPatch(cur, o) {
  const patch = {};
  if (o.origin != null) {
    let u = null; try { u = new URL(String(o.origin)); } catch { /* below */ }
    if (!u || u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('--origin must be an https address with nothing after the host name, like https://panel.example.com');
    patch.origin = u.origin;
  }
  if (o.host != null) {
    if (!HOST_RE.test(String(o.host))) throw new Error('--host must be a host name or IP address (letters, digits, dots, colons and dashes only)');
    patch.host = String(o.host);
  }
  if (o.port != null) {
    const n = /^\d{1,5}$/.test(String(o.port)) ? Number(o.port) : NaN;
    if (!(n >= 1 && n <= 65535)) throw new Error('--port must be a number from 1 to 65535');
    patch.port = n;
  }
  if (o.user != null) {
    if (!USER_RE.test(String(o.user))) throw new Error('--user must be a user name: a lower-case letter or _, then up to 31 letters, digits, _ or -');
    patch.user = String(o.user);
  }
  if (o.server_command != null) {
    if (!COMMAND_RE.test(String(o.server_command))) throw new Error('--server-command must be an absolute path (letters, digits, dots, underscores, dashes and slashes only), like /usr/local/sbin/example-bridge');
    patch.server_command = String(o.server_command);
  }
  const origin = patch.origin ?? cur.origin;
  if (o.rp_id != null || patch.origin) {
    if (!origin) throw new Error('--rp-id needs the origin: add --origin https://...');
    const host = new URL(origin).hostname.toLowerCase();
    const rp = o.rp_id != null ? String(o.rp_id).toLowerCase() : host;
    if (!DOMAIN_RE.test(rp)) throw new Error('--rp-id must be a domain name, like panel.example.com');
    if (rp !== host && !(rp.includes('.') && host.endsWith('.' + rp)))
      throw new Error(`--rp-id must be the origin's host name (${host}) or a parent domain of it`);
    patch.rp_id = rp;
  }
  const next = { ...cur, ...patch };
  if (!next.origin || !next.host) throw new Error('wk-bridge config needs both --origin and --host the first time');
  return patch;
}

export function readJsonFile(file, fallback) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > 2 * 1024 * 1024) return fallback; const j = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(j) ? j : fallback; } catch { return fallback; }
}
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
export function readRemote() {
  const j = readJsonFile(FILES.remote(), {});
  const r = { ...REMOTE_DEFAULTS };
  for (const k of Object.keys(REMOTE_DEFAULTS)) if (k in j && typeof j[k] === typeof REMOTE_DEFAULTS[k]) r[k] = j[k];
  for (const k of ['orchestration', 'task_repo']) if (typeof j[k] === 'string') r[k] = j[k];
  r.enabled = j.enabled === true;
  return r;
}
export function writeRemote(patch) {
  const cur = readJsonFile(FILES.remote(), {});
  const next = { ...REMOTE_DEFAULTS, ...cur, ...patch };
  writePrivate(FILES.remote(), JSON.stringify(next, null, 2) + '\n');
  return next;
}
export function readKeys() {
  const j = readJsonFile(FILES.keys(), {});
  return { keys: Array.isArray(j.keys) ? j.keys.filter(k => isObj(k) && typeof k.id === 'string' && typeof k.spki === 'string') : [],
    rejected: Array.isArray(j.rejected) ? j.rejected.filter(x => typeof x === 'string').slice(-200) : [] };
}
export const writeKeys = k => writePrivate(FILES.keys(), JSON.stringify({ keys: k.keys, rejected: k.rejected.slice(-200) }, null, 2) + '\n');
export function readPending() {
  const j = readJsonFile(FILES.pending(), {});
  return { keys: Array.isArray(j.keys) ? j.keys.filter(k => isObj(k) && typeof k.id === 'string') : [] };
}
export const writePending = p => writePrivate(FILES.pending(), JSON.stringify({ keys: p.keys.slice(-5) }, null, 2) + '\n');

// One line per check in remote-log.jsonl (no command text); the file starts again past 1 MB (the old one kept as .1).
export function logLine(o, now = Date.now()) {
  const f = FILES.log();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.1'); } catch { /* new file */ }
    fs.appendFileSync(f, JSON.stringify({ at: new Date(now).toISOString(), ...o }) + '\n', { mode: 0o600 });
  } catch { /* the log never stops a check */ }
}

// ------------------------------------------------------------------ the seen store (command ids, kept 7 days)
// At most once (P2-227): a command's id is written here with status "started", and flushed to disk, BEFORE the Mac acts on it;
// its result follows as a second line with status "done". A crash between the two leaves "started": the next start of the
// bridge turns it into "interrupted" with the result below, and the command never runs again. A lost command is safer than a
// doubled one (a second job, a second answer): the owner sends it again from the phone, which makes a new id.
export const INTERRUPTED = 'Interrupted, send again.';
export class Seen {
  constructor(file = FILES.seen(), now = Date.now()) {
    this.file = file; this.map = new Map(); this.interrupted = [];
    let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    let dropped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (typeof o.id === 'string' && isInt(o.at) && now - o.at <= 7 * DAY) this.map.set(o.id, o); else dropped++; } catch { dropped++; }
    }
    for (const [id, o] of this.map) {
      if (o.status !== 'started') continue;
      this.map.set(id, { ...o, ok: false, text: INTERRUPTED, status: 'interrupted' }); this.interrupted.push(id);
    }
    if (dropped || this.interrupted.length) this.rewrite();
  }
  rewrite() { try { writePrivate(this.file, [...this.map.values()].map(o => JSON.stringify(o)).join('\n') + (this.map.size ? '\n' : '')); } catch { /* kept in memory */ } }
  get(id) { return this.map.get(id) || null; }
  // Before the action: true only once the line is on disk (fsync). False means: do not act.
  start(id, hash, now = Date.now()) {
    const o = { id, at: now, status: 'started', ok: false, text: '', hash };
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fd = fs.openSync(this.file, 'a', 0o600); fs.writeSync(fd, JSON.stringify(o) + '\n'); fs.fsyncSync(fd);
    } catch { return false; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
    this.map.set(id, o);
    return true;
  }
  add(id, result, hash, now = Date.now()) {
    const o = { id, at: now, status: 'done', ok: !!result.ok, text: String(result.text || '').slice(0, 2000), hash };
    this.map.set(id, o);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); fs.appendFileSync(this.file, JSON.stringify(o) + '\n', { mode: 0o600 }); } catch { /* kept in memory */ }
    return o;
  }
}

// ------------------------------------------------------------------ the allowlist (v1)
export const DECIDE_KINDS = ['ping', 'answer', 'later', 'suggestion', 'task', 'send', 'stop-on', 'remote-off', 'job-stop'];
export const PROMPT_KINDS = ['job-start', 'job-reply', 'stop-off'];
export const MODELS = ['sonnet', 'opus', 'fable', 'haiku'];
export const MODES = ['auto', 'acceptEdits', 'plan'];
export const TASK_KINDS = ['auto', 'read', 'quick', 'code', 'ui', 'plan', 'hard', 'review', 'legal'];
export const JOB_ID = /^J-\d{8}-\d{4}-[0-9a-f]{4}$/;
export const PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CRED_ID = /^[A-Za-z0-9_-]{16,1400}$/;
const SUGGESTION_ID = /^S-\d{8}-\d{6}-[0-9a-f]{4}$/;
const QUESTION_N = /^[1-9]\d{0,5}$/;
const QUESTION_HASH = /^[0-9a-f]{16}$/;
// A question's fingerprint: the first 16 lowercase hex characters of SHA-256 over the UTF-8 bytes of its text exactly as pushed
// (after the scrub). The push puts it on questions.items[i].h; the phone sends it back as args.q; the Mac compares before acting.
export function questionHash(text) { return crypto.createHash('sha256').update(Buffer.from(String(text ?? ''), 'utf8')).digest('hex').slice(0, 16); }
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

const str = (v, max, { oneLine = false, empty = false } = {}) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0)
  && !CONTROL.test(v) && (!oneLine || !/[\r\n]/.test(v));
const onlyKeys = (o, allowed) => Object.keys(o).every(k => allowed.includes(k));
const qn = v => (typeof v === 'string' || isInt(v)) && QUESTION_N.test(String(v));

// Exact arguments per kind: anything extra, missing or out of range is refused.
export function checkArgs(kind, a) {
  if (!isObj(a)) return false;
  switch (kind) {
    case 'ping': case 'stop-on': case 'stop-off': case 'remote-off': return Object.keys(a).length === 0;
    case 'answer': {
      if (!onlyKeys(a, ['n', 'q', 'text', 'use_recommended', 'confirmed']) || !qn(a.n)) return false;
      if (typeof a.q !== 'string' || !QUESTION_HASH.test(a.q)) return false;   // bound to the question's text, not only its number
      if ('confirmed' in a && typeof a.confirmed !== 'boolean') return false;
      const hasText = 'text' in a, hasRec = 'use_recommended' in a;
      if (hasText === hasRec) return false;
      return hasText ? str(a.text, 2000, { oneLine: true }) : a.use_recommended === true;
    }
    case 'later': return onlyKeys(a, ['n']) && qn(a.n);
    case 'suggestion': return onlyKeys(a, ['id', 'choice', 'confirmed']) && typeof a.id === 'string' && SUGGESTION_ID.test(a.id)
      && ['ok', 'later', 'no'].includes(a.choice) && (!('confirmed' in a) || typeof a.confirmed === 'boolean');
    case 'task': return onlyKeys(a, ['title', 'text', 'kind', 'test']) && str(a.title, 120, { oneLine: true }) && str(a.text, 4000, { empty: true })
      && TASK_KINDS.includes(a.kind) && (!('test' in a) || str(a.test, 500, { oneLine: true }));
    case 'send': return onlyKeys(a, ['kind', 'text']) && ['recommendation', 'rule'].includes(a.kind) && str(a.text, 4000);
    case 'job-stop': return onlyKeys(a, ['job']) && typeof a.job === 'string' && JOB_ID.test(a.job);
    case 'job-start': return onlyKeys(a, ['project', 'prompt', 'model', 'mode', 'max_turns']) && typeof a.project === 'string' && PROJECT_KEY.test(a.project)
      && str(a.prompt, 8000) && MODELS.includes(a.model) && MODES.includes(a.mode)
      && (!('max_turns' in a) || (isInt(a.max_turns) && a.max_turns >= 1 && a.max_turns <= 400));
    case 'job-reply': return onlyKeys(a, ['job', 'prompt']) && typeof a.job === 'string' && JOB_ID.test(a.job) && str(a.prompt, 8000);
    default: return false;
  }
}

// ------------------------------------------------------------------ signatures
const no = reason => ({ ok: false, reason });
export function p256Key(spkiB64u) {
  try {
    const k = crypto.createPublicKey({ key: fromB64u(spkiB64u), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails && k.asymmetricKeyDetails.namedCurve === 'prime256v1' ? k : null;
  } catch { return null; }
}

// One WebAuthn assertion over `signed` (its challenge is b64u(sha256(canonical(signed)))).
export function verifyAssertion(a, signed, { keys, rpId, origin }) {
  if (!isObj(a) || typeof a.cred !== 'string' || typeof a.authenticatorData !== 'string' || typeof a.clientDataJSON !== 'string' || typeof a.signature !== 'string') return no('The passkey signature is missing or broken.');
  if (a.authenticatorData.length > 2048 || a.clientDataJSON.length > 8192 || a.signature.length > 256) return no('The passkey signature is too large.');
  const key = keys.find(k => k.id === a.cred);
  if (!key) return no('This phone key is not trusted on the Mac.');
  let cdBytes, cd, ad, sig;
  try { cdBytes = fromB64u(a.clientDataJSON); cd = JSON.parse(cdBytes.toString('utf8')); ad = fromB64u(a.authenticatorData); sig = fromB64u(a.signature); } catch { return no('The passkey signature is missing or broken.'); }
  if (!isObj(cd) || cd.type !== 'webauthn.get') return no('That is not a passkey sign-in.');
  if (cd.origin !== origin || cd.crossOrigin === true) return no('The signature came from another website.');
  if (cd.challenge !== challengeFor(signed)) return no('The signature does not match the command.');
  if (ad.length < 37) return no('The passkey signature is missing or broken.');
  if (!ad.subarray(0, 32).equals(sha256(Buffer.from(rpId, 'utf8')))) return no('The signature is for another site.');
  const flags = ad[32];
  if (!(flags & 0x01)) return no('The phone did not confirm that you were there.');
  if (!(flags & 0x04)) return no('The phone did not check your face or passcode.');
  const pub = p256Key(key.spki);
  if (!pub) return no('The trusted key on the Mac is broken. Set up the phone again.');
  let good = false;
  try { good = crypto.verify('sha256', Buffer.concat([ad, sha256(cdBytes)]), { key: pub, dsaEncoding: 'der' }, sig); } catch { good = false; }
  if (!good) return no('The signature is not valid.');
  const counter = ad.readUInt32BE(33), stored = isInt(key.sign_count) ? key.sign_count : 0;
  if (stored > 0 && counter > 0 && counter <= stored) return no('This passkey signature was used before.');
  return { ok: true, cred: key.id, counter };
}

const GRANT_KEYS = ['v', 'type', 'id', 'key', 'scopes', 'issued_at', 'expires_at'];
export function checkGrant(g, command, now) {
  if (!isObj(g) || !onlyKeys(g, GRANT_KEYS) || g.v !== 1 || g.type !== 'grant') return no('The phone\'s session is broken. Sign in again.');
  if (typeof g.id !== 'string' || !B64U.test(g.id) || g.id.length > 64) return no('The phone\'s session is broken. Sign in again.');
  if (!Array.isArray(g.scopes) || g.scopes.length !== 1 || g.scopes[0] !== 'decide') return no('The phone\'s session may only decide.');
  if (!isInt(g.issued_at) || !isInt(g.expires_at) || g.expires_at <= g.issued_at || g.expires_at - g.issued_at > 10 * MIN) return no('The phone\'s session is longer than 10 minutes.');
  if (now > g.expires_at + 2 * MIN) return no('The phone\'s session has ended. Sign in again.');
  if (g.issued_at > now + 5 * MIN) return no('The phone\'s session starts in the future. Check the phone\'s clock.');
  if (!isInt(command.issued_at) || command.issued_at < g.issued_at - MIN || command.issued_at > g.expires_at) return no('The command is outside the phone\'s session.');
  if (typeof g.key !== 'string' || g.key.length > 400 || !p256Key(g.key)) return no('The phone\'s session key is broken.');
  return { ok: true, key: p256Key(g.key) };
}

// ------------------------------------------------------------------ the judge
// Returns { ok, reason, verified, stored?, command?, bump? }. `bump` is the sign counter to save once a passkey assertion verified.
export function checkEnvelope(env, { remote, keys, seen, now = Date.now() }) {
  const sizeOk = (() => { try { return Buffer.byteLength(JSON.stringify(env), 'utf8') <= 64 * 1024; } catch { return false; } })();
  if (!isObj(env) || !isObj(env.command) || !isObj(env.auth) || !sizeOk) return { ok: false, verified: false, reason: 'The command is broken or too large.' };
  const c = env.command, a = env.auth;
  const id = typeof c.id === 'string' && B64U.test(c.id) && c.id.length >= 16 && c.id.length <= 64 ? c.id : null;
  // 1. phone control
  if (!remote.enabled) return { ok: false, verified: false, id, reason: 'Phone control is off on the Mac.' };
  // the very same envelope again: its stored result, without acting
  const hash = b64u(sha256(Buffer.from(canonical(env), 'utf8')));
  const before = id && seen ? seen.get(id) : null;
  if (before && before.hash === hash) return { ok: false, verified: true, id, hash, stored: before, reason: before.text };
  // 2 and 3. the assertions, and the grant
  const ctx = { keys: keys.keys, rpId: remote.rp_id, origin: remote.origin };
  let via, bump = null;
  if (a.via === 'passkey') {
    const v = verifyAssertion(a, c, ctx);
    if (!v.ok) return { ok: false, verified: false, id, reason: v.reason };
    via = 'passkey'; bump = { cred: v.cred, counter: v.counter };
  } else if (a.via === 'grant') {
    if (!isObj(a.grant) || typeof a.signature !== 'string' || a.signature.length > 200) return { ok: false, verified: false, id, reason: 'The phone\'s session is broken. Sign in again.' };
    const v = verifyAssertion(a.grant_auth, a.grant, ctx);
    if (!v.ok) return { ok: false, verified: false, id, reason: v.reason };
    bump = { cred: v.cred, counter: v.counter };
    const g = checkGrant(a.grant, c, now);
    if (!g.ok) return { ok: false, verified: false, id, reason: g.reason, bump };
    let good = false;
    try { good = crypto.verify('sha256', Buffer.from(canonical(c), 'utf8'), { key: g.key, dsaEncoding: 'ieee-p1363' }, fromB64u(a.signature)); } catch { good = false; }
    if (!good) return { ok: false, verified: false, id, reason: 'The session signature is not valid.', bump };
    via = 'grant';
  } else return { ok: false, verified: false, id, reason: 'The command is not signed.' };
  // 4. the command
  const fail = reason => ({ ok: false, verified: true, id, hash, reason, bump });
  if (c.v !== 1 || !id || !onlyKeys(c, ['v', 'id', 'kind', 'args', 'issued_at'])) return fail('The command is broken.');
  if (before) return { ok: false, verified: true, id, hash, stored: before, reason: before.text, bump };
  if (!isInt(c.issued_at)) return fail('The command is broken.');
  if (c.issued_at > now + 5 * MIN) return fail('The command is dated in the future. Check the phone\'s clock.');
  const isPrompt = PROMPT_KINDS.includes(c.kind);
  if (!isPrompt && !DECIDE_KINDS.includes(c.kind)) return fail('Not something the phone can do.');
  if (now - c.issued_at > (isPrompt ? 2 * HOUR : DAY)) return fail(`The command is too old (over ${isPrompt ? '2 hours' : '24 hours'}).`);
  if (isPrompt && via !== 'passkey') return fail('This needs a fresh Face ID on the phone.');
  if (!checkArgs(c.kind, c.args)) return fail('The command\'s details are not valid.');
  return { ok: true, verified: true, id, hash, command: c, via, bump };
}

// ------------------------------------------------------------------ secret and private-data scan for anything leaving the Mac
const FALLBACK_SECRETS = ['sk-ant-[A-Za-z0-9_-]{20,}', 'sk_(live|test)_[A-Za-z0-9]{16,}', 'rk_(live|test)_[A-Za-z0-9]{16,}', 'gh[pousr]_[A-Za-z0-9]{30,}',
  'AKIA[0-9A-Z]{16}', '-----BEGIN [A-Z ]*PRIVATE KEY-----', 'xox[abposr]-[A-Za-z0-9-]{10,}', 'AIza[0-9A-Za-z_-]{35}'];
// Only for what leaves the Mac (job events, state, results); never in gates.json, whose secretPatterns wk-guard also blocks on, and
// where NAME=value would refuse ordinary code such as "API_KEY: process.env.API_KEY". Here a hit only hides the string.
export const OUTGOING_SECRETS = ['whsec_[A-Za-z0-9]{16,}', 'sk_test_[A-Za-z0-9]{16,}', 'AIza[0-9A-Za-z_-]{35}', 'xox[abprs]-[A-Za-z0-9-]{10,}',
  '(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\\s*[=:]\\s*\\S{6,}'];
let PATTERNS = null;
function patterns() {
  if (PATTERNS) return PATTERNS;
  let secret = [], pii = [];
  try { const g = gates({ allowMismatch: true }); secret = g.secretPatterns.slice(); pii = g.lane.pii.map(p => ({ re: p.re, flags: p.flags || '' })); } catch { /* the built-in shapes below still apply */ }
  const compile = (s, f = '') => { try { return new RegExp(s, f); } catch { return null; } };
  PATTERNS = [...secret, ...FALLBACK_SECRETS, ...OUTGOING_SECRETS].map(s => compile(s)).concat(pii.map(p => compile(p.re, p.flags))).filter(Boolean);
  return PATTERNS;
}
// Watchkeeper's own ids, dates and session ids are not phone numbers: they are taken out before the scan (never from what is sent).
const SAFE = [/\bJ-\d{8}-\d{4}-[0-9a-f]{4}\b/g, /\bS-\d{8}-\d{6}-[0-9a-f]{4}\b/g, /\b\d{8}-\d{6}-[a-z0-9-]{1,40}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, /\b\d{1,2}:\d{2}\b/g];
export function secretHit(text) {
  let t = String(text ?? '');
  if (!t) return false;
  for (const re of SAFE) t = t.replace(re, ' ');
  return patterns().some(re => re.test(t));
}
// Home folder to "~" in every string, then every string through the scan; a hit becomes "[hidden]". Keys that hit drop their entry.
export function scrub(value, { home = os.homedir(), counter = { hidden: 0 } } = {}) {
  const fix = s => {
    let t = home && home !== '/' ? s.split(home + '/').join('~/') : s;
    if (home && t === home) t = '~';
    if (secretHit(t)) { counter.hidden++; return '[hidden]'; }
    return t;
  };
  const walk = v => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) { if (secretHit(k)) { counter.hidden++; continue; } o[k] = walk(x); } return o; }
    return v;
  };
  return walk(value);
}
// A plain, scanned, cut string for an event or a result. The scan runs on the whole string first, so a key the cut would
// split (and so no longer match) is still hidden; the cut piece is scanned again.
export function cleanCut(s, n) {
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  if (secretHit(t)) return '[hidden]';
  const cut = t.length > n ? t.slice(0, n - 1) + '…' : t;
  return secretHit(cut) ? '[hidden]' : cut;
}
