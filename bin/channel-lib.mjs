// channel-lib (P2-272): the developer's signed channel. Two files, each with a detached Ed25519 signature:
//   update.json (+ .sig)  which release the developer tested and signed off; followers move only to that release
//   news.json   (+ .sig)  news, update notes and tips from the developer, plus the developer's contact address (the
//                         address in release/contact.txt, which stays in the private repository; it travels only inside
//                         the signed file)
// Signing (bin/wk-sign.mjs) needs the developer's passphrase, and the passphrase is the protection: wk-sign's terminal
// check only prevents accidents (a determined script can get round it). Never type the passphrase into a chat or an
// agent's terminal; sign in a plain terminal you opened yourself. Everything here only reads and verifies: Node's
// built-in crypto, no dependencies.
// The key: the pinned public key is WK_HOME/release-key.pub.pem (default ~/.wk). On first use it is pinned from the
// working tree of the installed release (release/release-key.pub; never from git or GitHub) and its fingerprint is
// printed: trust on first use. After that the pinned key wins; a changed key in the repository is never picked up by
// itself. A pin that is a symbolic link, can be changed by other users or belongs to another user is refused.
// Transports: git (`git show refs/remotes/origin/main:release/channel/<file>`: the full ref name, so a tag called
// origin/main cannot stand in for the branch) and https (default DEFAULT_URL; a plain GET with
// User-Agent "Watchkeeper", no query string, no cookies). Verified copies are cached in WK_HOME/channel/ and verified
// again on every read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

export const CONTACT_IN_REPO = path.join('release', 'contact.txt');
// A contact address: one plain e-mail address, nothing else.
export const isContact = v => typeof v === 'string' && v.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v);
// The developer's address from the private repository (release/contact.txt), or null.
export function readContact(repo) {
  try { const c = fs.readFileSync(path.join(repo, CONTACT_IN_REPO), 'utf8').trim(); return isContact(c) ? c : null; } catch { return null; }
}
export const DEFAULT_URL = 'https://nexodyne.org/watchkeeper/channel/';
export const FILES = ['update.json', 'news.json'];
export const PRODUCT = 'watchkeeper';
export const KINDS = ['news', 'update', 'tip'];
export const KEY_IN_REPO = path.join('release', 'release-key.pub');
export const CHANNEL_IN_REPO = path.join('release', 'channel');
const MAX_BYTES = 256 * 1024;

export const wkHome = (env = process.env) => path.resolve(env.WK_HOME || path.join(os.homedir(), '.wk'));
export const pinnedKeyPath = (home = wkHome()) => path.join(home, 'release-key.pub.pem');

// The exact bytes that get signed: what wk-sign writes, and what is read back.
export const manifestBytes = obj => Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');

// true only for a valid Ed25519 signature over exactly these bytes with this public key; never throws.
export function verifyChannelFile(bytes, sigB64, pubKeyPem) {
  try {
    if (!bytes || !sigB64 || !pubKeyPem) return false;
    const key = crypto.createPublicKey(pubKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const sig = Buffer.from(String(sigB64).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), key, sig);
  } catch { return false; }
}

// sha256 of the public key (SPKI DER), in groups of four, so the owner can compare it by eye.
export function fingerprint(pubKeyPem) {
  const der = crypto.createPublicKey(pubKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').match(/.{4}/g).join(':');
}

const readOr = (f, d = null) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const isEd25519Pem = pem => { try { return crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519'; } catch { return false; } };
const git = (repo, args, timeout = 30000) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: r.stdout || Buffer.alloc(0) };
};

// Why the pinned key file cannot be trusted, in words, or null when it is fine (or not there yet).
export function pinProblem(home = wkHome()) {
  const at = pinnedKeyPath(home), dir = path.dirname(at);
  let st; try { st = fs.lstatSync(at); } catch { return null; }
  if (st.isSymbolicLink()) return `the pinned release key ${at} is a symbolic link; it must be a plain file`;
  if (!st.isFile()) return `the pinned release key ${at} is not a plain file`;
  if (st.mode & 0o022) return `the pinned release key ${at} can be changed by other users (mode ${(st.mode & 0o777).toString(8)}); fix it with: chmod 644 ${at}`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `the pinned release key ${at} belongs to another user`;
  let ds; try { ds = fs.statSync(dir); } catch { return null; }
  if (ds.mode & 0o022) return `the folder ${dir} can be changed by other users (mode ${(ds.mode & 0o777).toString(8)}); fix it with: chmod 700 ${dir}`;
  return null;
}

// The pinned key. On first use, pin the key in the working tree of this folder (never one from git or GitHub) and say so
// with its fingerprint. Returns { pem, fingerprint, pinnedNow } or null when there is no usable key yet; a pin that
// pinProblem refuses gives null and a line in the log.
export function pinnedKey({ home = wkHome(), repo = null, log = s => process.stderr.write(s + '\n') } = {}) {
  const at = pinnedKeyPath(home);
  let exists = false; try { fs.lstatSync(at); exists = true; } catch { /* not pinned yet */ }
  if (exists) {
    const why = pinProblem(home);
    if (why) { log(`Watchkeeper: not using the pinned key: ${why}.`); return null; }
    const have = readOr(at);
    return have && isEd25519Pem(have) ? { pem: have, fingerprint: fingerprint(have), pinnedNow: false } : null;
  }
  if (!repo) return null;
  const pem = readOr(path.join(repo, KEY_IN_REPO));
  if (!pem || !isEd25519Pem(pem)) return null;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(at, pem, { mode: 0o644, flag: 'wx' });
  const fp = fingerprint(pem);
  log(`Watchkeeper: pinned the developer's release key (first use). Fingerprint ${fp}. Compare it with the one in the README; to change it later, replace ${at} by hand.`);
  return { pem, fingerprint: fp, pinnedNow: true };
}

// ---------------------------------------------------------------- what the files may say
// A string that is not empty after trimming, returned trimmed; anything else is null.
const str = (v, max) => (typeof v === 'string' && v.length <= max && v.trim().length > 0 ? v.trim() : null);
// Plain text: drop control characters other than newline and tab, C1 controls, the soft hyphen, zero-width spaces and
// joiners that hide text, bidirectional overrides and isolates, and the byte-order mark. U+200C-U+200F (zero-width
// non-joiner and joiner, left-to-right and right-to-left marks) stay: real scripts need them. Markup is kept as the
// literal characters it is; whatever shows it must show it as text.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b\u2060-\u2064\u202a-\u202e\u2066-\u2069\ufeff]/g;
export const plainText = s => String(s).replace(/\r\n?/g, '\n').replace(HIDDEN, '');
// plainText plus how many hidden characters it removed (for wk-sign's preview).
export function cleanText(s) {
  const n = String(s).replace(/\r\n?/g, '\n');
  return { text: n.replace(HIDDEN, ''), removed: (n.match(HIDDEN) || []).length };
}
const httpsLink = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };

// Returns the manifest, or throws with the reason in words.
export function parseUpdate(bytes) {
  let m; try { m = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); } catch { throw new Error('update.json is not JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('update.json is not an object');
  if (m.schema !== 1) throw new Error(`update.json has schema ${JSON.stringify(m.schema)}, not 1`);
  if (m.type !== 'update') throw new Error(`update.json is of type ${JSON.stringify(m.type)}, not "update"`);
  if (m.product !== PRODUCT) throw new Error(`update.json is for ${JSON.stringify(m.product)}, not ${PRODUCT}`);
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(m.version || '')) throw new Error('update.json has no X.Y.Z version');
  if (m.tag !== `v${m.version}`) throw new Error(`update.json names tag ${JSON.stringify(m.tag)} for version ${m.version}`);
  if (!/^[0-9a-f]{40}$/.test(m.commit || '')) throw new Error('update.json has no full commit id');
  if (!str(m.released_at, 40) || Number.isNaN(Date.parse(m.released_at))) throw new Error('update.json has no release time');
  if (m.notes !== undefined && typeof m.notes !== 'string') throw new Error('update.json notes are not text');
  // public_tree (optional, S7): the git tree id of the public mirror's copy of commit (sha1 or sha256).
  if (m.public_tree !== undefined && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(typeof m.public_tree === 'string' ? m.public_tree : '')) throw new Error('update.json has a public_tree that is not a git tree id');
  return { schema: 1, type: 'update', product: PRODUCT, version: m.version, tag: m.tag, commit: m.commit, ...(m.public_tree !== undefined ? { public_tree: m.public_tree } : {}), released_at: m.released_at, notes: plainText(m.notes || '') };
}

export function parseNews(bytes) {
  let n; try { n = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); } catch { throw new Error('news.json is not JSON'); }
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('news.json is not an object');
  if (n.schema !== 1) throw new Error(`news.json has schema ${JSON.stringify(n.schema)}, not 1`);
  if (n.type !== 'news') throw new Error(`news.json is of type ${JSON.stringify(n.type)}, not "news"`);
  if (!Array.isArray(n.items)) throw new Error('news.json has no items');
  if (!isContact(n.contact)) throw new Error('news.json has no contact address');
  const items = n.items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`news item ${i + 1} is not an object`);
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(it.id || '')) throw new Error(`news item ${i + 1} has no valid id`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) throw new Error(`news item ${it.id} has no YYYY-MM-DD date`);
    if (!KINDS.includes(it.kind)) throw new Error(`news item ${it.id} has kind ${JSON.stringify(it.kind)}`);
    const title = str(typeof it.title === 'string' ? plainText(it.title).replace(/\n/g, ' ') : null, 200);
    const body = str(typeof it.body === 'string' ? plainText(it.body) : null, 8000);
    if (!title) throw new Error(`news item ${it.id} has no title`);
    if (!body) throw new Error(`news item ${it.id} has no body`);
    if (it.link !== undefined && !httpsLink(it.link)) throw new Error(`news item ${it.id} has a link that is not https`);
    const out = { id: it.id, date: it.date, kind: it.kind, title, body };
    if (it.link !== undefined) out.link = it.link;
    return out;
  });
  return { schema: 1, type: 'news', issued_at: String(n.issued_at || ''), contact: n.contact, items };
}
const PARSE = { 'update.json': parseUpdate, 'news.json': parseNews };

// ---------------------------------------------------------------- transports
// git: the file and its signature as they are on GitHub's main branch (refs/remotes/origin/main, after a fetch; the full
// ref name, so a tag called origin/main cannot shadow the branch). null when either is missing.
export const ORIGIN_MAIN = 'refs/remotes/origin/main';
export function gitChannelFile(repo, file) {
  const p = `${CHANNEL_IN_REPO.split(path.sep).join('/')}/${file}`;
  const b = git(repo, ['show', `${ORIGIN_MAIN}:${p}`]), s = git(repo, ['show', `${ORIGIN_MAIN}:${p}.sig`]);
  if (!b.ok || !s.ok) return null;
  return { bytes: b.out, sig: s.out.toString('utf8').trim() };
}

// One https GET: https only, no redirects, status 200 only (404 means missing), at most 256 KB, and an overall deadline
// (a server that drips bytes cannot hold it open). Resolves { body } | { missing } | { error }; never rejects.
// `request` is there for the tests (loopback http); production always uses https.request.
export function get(url, timeout = 15000, { request = https.request } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve({ error: 'not a URL' }); }
    if (u.protocol !== 'https:') return resolve({ error: 'only https is read' });
    let done = false, req = null;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { finish({ error: 'timed out' }); if (req) req.destroy(); }, timeout);
    try {
      req = request(u.href, { method: 'GET', headers: { 'User-Agent': 'Watchkeeper', Accept: '*/*' }, timeout }, res => {
        if (res.statusCode === 404) { res.resume(); return finish({ missing: true }); }
        if (res.statusCode !== 200) { res.resume(); return finish({ error: `HTTP ${res.statusCode}` }); }
        const chunks = []; let n = 0, ended = false;
        res.on('data', c => { if (done) return; n += c.length; if (n > MAX_BYTES) { finish({ error: 'too large' }); req.destroy(); } else chunks.push(c); });
        res.on('end', () => { ended = true; finish({ body: Buffer.concat(chunks) }); });
        res.on('error', e => finish({ error: (e && e.message) || 'the connection failed' }));
        res.on('aborted', () => finish({ error: 'the connection was cut' }));
        res.on('close', () => { if (!ended) finish({ error: 'the connection closed before the end' }); });
      });
    } catch (e) { return finish({ error: e.message }); }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => finish({ error: e.message }));
    req.end();
  });
}

// https: the file and its signature from the channel folder. { bytes, sig } | { missing } | { error }.
export async function httpsChannelFile(base, file, { timeout = 15000, fetchImpl = get } = {}) {
  const url = new URL(file, base.endsWith('/') ? base : base + '/');
  url.search = ''; url.hash = '';
  const [b, s] = await Promise.all([fetchImpl(url.href, timeout), fetchImpl(url.href + '.sig', timeout)]);
  if (b.error || s.error) return { error: b.error || s.error };
  if (b.missing || s.missing) return { missing: true };
  return { bytes: b.body, sig: s.body.toString('utf8').trim() };
}

// ---------------------------------------------------------------- the cache
const cacheDir = home => path.join(home, 'channel');
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; };
const when = s => { const t = Date.parse(s); return Number.isNaN(t) ? -Infinity : t; };
// true when `value` (a parsed channel file) is older than `cached`: update.json by version, news.json by issued_at.
export function olderThan(file, value, cached) {
  if (!value || !cached) return false;
  return file === 'update.json' ? cmpVer(value.version, cached.version) < 0 : when(value.issued_at) < when(cached.issued_at);
}
// Cache a verified file. With the key, a newer verified copy already in the cache is never replaced by an older one:
// returns false then (and true when it wrote).
export function cacheWrite(home, file, bytes, sig, pem = null) {
  if (pem) {
    const have = cacheRead(home, file, pem);
    let value = null; try { value = PARSE[file](bytes); } catch { /* checked by the caller */ }
    if (have && olderThan(file, value, have)) return false;
  }
  const d = cacheDir(home);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const [f, data] of [[file, bytes], [`${file}.sig`, sig + '\n']]) {
    const t = path.join(d, `${f}.${process.pid}.tmp`); fs.writeFileSync(t, data, { mode: 0o600 }); fs.renameSync(t, path.join(d, f));
  }
  return true;
}
export function cacheRead(home, file, pem) {
  const d = cacheDir(home);
  let bytes, sig; try { bytes = fs.readFileSync(path.join(d, file)); sig = fs.readFileSync(path.join(d, `${file}.sig`), 'utf8'); } catch { return null; }
  if (!verifyChannelFile(bytes, sig, pem)) return null;
  try { return PARSE[file](bytes); } catch { return null; }
}

// Verify one fetched file: { value } when the signature and the contents are good, { problem } otherwise.
export function checkFile(file, got, pem) {
  if (!verifyChannelFile(got.bytes, got.sig, pem)) return { problem: `${file} is not signed by the developer's key` };
  try { return { value: PARSE[file](got.bytes) }; } catch (e) { return { problem: e.message }; }
}

// Read both files through one transport, verify, cache what verifies. Per file: { value, from } or { missing } or
// { problem }; a file that cannot be fetched falls back to the verified cache, and so does one older than the cached copy.
export async function readChannel({ transport = 'https', repo = null, url = DEFAULT_URL, home = wkHome(), fetchImpl, log } = {}) {
  const key = pinnedKey({ home, repo, log });
  const out = { key: key && key.fingerprint, contact: null };
  for (const file of FILES) {
    if (!key) { out[file] = { problem: 'no developer key is pinned yet' }; continue; }
    const got = transport === 'git' ? (gitChannelFile(repo, file) || { missing: true }) : await httpsChannelFile(url, file, { fetchImpl });
    if (got.error) { const c = cacheRead(home, file, key.pem); out[file] = c ? { value: c, from: 'cache' } : { problem: `could not read ${file} (${got.error})` }; continue; }
    if (got.missing) { out[file] = { missing: true }; continue; }
    const r = checkFile(file, got, key.pem);
    if (r.value) {
      const have = cacheRead(home, file, key.pem);
      if (have && olderThan(file, r.value, have)) out[file] = { value: have, from: 'cache' };
      else { cacheWrite(home, file, got.bytes, got.sig, key.pem); out[file] = { value: r.value, from: transport }; }
    }
    else out[file] = r;
  }
  if (out['news.json'] && out['news.json'].value) out.contact = out['news.json'].value.contact;   // only from the signed file
  return out;
}
