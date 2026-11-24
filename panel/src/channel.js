'use strict';
// channel.js (P2-272): the developer's signed channel for the panel: is a signed update out, and the developer's news.
// Self-contained CommonJS (the panel cannot import the .mjs tools). It trusts only the key pinned on this computer
// (<wkHome>/release-key.pub.pem, pinned by wk-update on first use); with no pinned key it shows nothing and says why.
// Every file must carry a valid Ed25519 signature over its exact bytes; news is plain text only (show it with
// textContent or escapeHtml, never as HTML). The developer's contact address comes only from the signed news.json.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const isContact = v => typeof v === 'string' && v.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v);
const DEFAULT_URL = 'https://nexodyne.org/watchkeeper/channel/';
const KINDS = ['news', 'update', 'tip'];
const MAX_BYTES = 256 * 1024;

// Control characters, C1, soft hyphen, zero-width space, invisible operators, bidi embeddings, overrides and isolates,
// and the byte-order mark. Joiners (U+200C, U+200D) and the LRM/RLM marks (U+200E, U+200F) stay: scripts need them.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b\u2060-\u2064\u202a-\u202e\u2066-\u2069\ufeff]/g;
const plainText = s => String(s).replace(/\r\n?/g, '\n').replace(HIDDEN, '');
const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A string that is non-empty after trim and not longer than max, returned trimmed; else null.
const str = (v, max) => (typeof v === 'string' && v.length <= max && v.trim().length > 0 ? v.trim() : null);
const httpsLink = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };

function verify(bytes, sigB64, pem) {
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const sig = Buffer.from(String(sigB64).trim(), 'base64');
    return sig.length === 64 && crypto.verify(null, bytes, key, sig);
  } catch { return false; }
}

function parseUpdate(bytes) {
  const m = JSON.parse(bytes.toString('utf8'));
  if (!m || m.schema !== 1 || m.type !== 'update' || m.product !== 'watchkeeper') throw new Error('update.json is not a Watchkeeper update');
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(m.version || '') || m.tag !== `v${m.version}`) throw new Error('update.json has no valid version');
  if (!/^[0-9a-f]{40}$/.test(m.commit || '')) throw new Error('update.json has no full commit id');
  // Optional; same rule as bin/channel-lib.mjs (a SHA-1 or SHA-256 git tree id).
  if (m.public_tree !== undefined && !(typeof m.public_tree === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(m.public_tree))) throw new Error('update.json has a public_tree that is not a git tree id');
  return { type: 'update', version: m.version, tag: m.tag, commit: m.commit, ...(m.public_tree !== undefined ? { public_tree: m.public_tree } : {}), released_at: String(m.released_at || ''), notes: plainText(typeof m.notes === 'string' ? m.notes : '') };
}

// The developer's address inside a signed news.json, or null.
function parseContact(bytes) { try { const n = JSON.parse(bytes.toString('utf8')); return isContact(n && n.contact) ? n.contact : null; } catch { return null; } }

function parseNews(bytes) {
  const n = JSON.parse(bytes.toString('utf8'));
  if (!n || n.schema !== 1 || n.type !== 'news' || !Array.isArray(n.items)) throw new Error('news.json is not a news list');
  if (!isContact(n.contact)) throw new Error('news.json has no contact address');
  return n.items.map((it, i) => {
    const title = typeof it?.title === 'string' ? str(plainText(it.title).replace(/\n/g, ' '), 200) : null;
    const body = typeof it?.body === 'string' ? str(plainText(it.body), 8000) : null;
    if (!it || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(it.id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(it.date || '') || !KINDS.includes(it.kind)
      || !title || !body || (it.link !== undefined && !httpsLink(it.link))) throw new Error(`news item ${i + 1} is not valid`);
    const out = { id: it.id, date: it.date, kind: it.kind, title, body };
    if (it.link !== undefined) out.link = it.link;
    return out;
  });
}

const newer = (a, b) => { const x = a.split('.').map(Number), y = String(b || '0.0.0').replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

// One GET over https: status 200 only (404 means missing), no redirects, at most 256 KB, and an overall deadline so a
// server that drips bytes or never closes cannot hold the panel. `request` is for loopback tests only.
function httpsGet(url, timeout = 15000, request = https.request) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve({ error: 'not a URL' }); }
    if (u.protocol !== 'https:') return resolve({ error: 'only https is read' });
    let done = false, req = null, timer = null;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); if (req && !r.body) { try { req.destroy(); } catch { /* gone */ } } resolve(r); };
    timer = setTimeout(() => finish({ error: 'timed out' }), timeout);
    try {
      req = request(u.href, { method: 'GET', headers: { 'User-Agent': 'Watchkeeper' }, timeout }, res => {
        if (res.statusCode === 404) { res.resume(); return finish({ missing: true }); }
        if (res.statusCode !== 200) { res.resume(); return finish({ error: `HTTP ${res.statusCode}` }); }
        const chunks = []; let n = 0, ended = false;
        res.on('data', c => { n += c.length; if (n > MAX_BYTES) finish({ error: 'too large' }); else chunks.push(c); });
        res.on('end', () => { ended = true; finish({ body: Buffer.concat(chunks) }); });
        res.on('error', e => finish({ error: e.message }));
        res.on('aborted', () => finish({ error: 'the connection was cut' }));
        res.on('close', () => { if (!ended) finish({ error: 'the connection was cut' }); });
      });
    } catch (e) { return finish({ error: e.message }); }
    req.on('timeout', () => finish({ error: 'timed out' }));
    req.on('error', e => finish({ error: e.message }));
    req.end();
  });
}

// createChannel({ url, wkHome, currentVersion, fetchImpl(url) -> Promise<{body}|{missing}|{error}>, now, minIntervalMs })
//   .check({ force }) -> { ok, updateAvailable, version, notes, items, contact, error, checkedAt, from }
function createChannel(opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const home = opts.wkHome || process.env.WK_HOME || path.join(require('os').homedir(), '.wk');
  const fetchImpl = opts.fetchImpl || httpsGet;
  const now = opts.now || (() => Date.now());
  const minIntervalMs = opts.minIntervalMs == null ? 3600e3 : opts.minIntervalMs;
  const dir = path.join(home, 'channel');
  const stampFile = path.join(dir, 'last-check.json');
  const base = url.endsWith('/') ? url : url + '/';

  const readPin = () => { try { const pem = fs.readFileSync(path.join(home, 'release-key.pub.pem'), 'utf8'); return crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519' ? pem : null; } catch { return null; } };
  const cached = (file, pem) => { try { const b = fs.readFileSync(path.join(dir, file)); return verify(b, fs.readFileSync(path.join(dir, file + '.sig'), 'utf8'), pem) ? b : null; } catch { return null; } };
  // The signed date of a file: update.json by version, news.json by issued_at; null when it does not parse.
  const stamp = (file, bytes) => { try { return file === 'update.json' ? parseUpdate(bytes).version : (t => (Number.isFinite(t) ? t : null))(Date.parse(JSON.parse(bytes.toString('utf8')).issued_at)); } catch { return null; } };
  // True when the verified cached copy is newer than these bytes (so they must not replace it).
  const olderThanCache = (file, bytes, pem) => {
    const c = cached(file, pem); if (!c) return false;
    const a = stamp(file, bytes), b = stamp(file, c); if (a == null || b == null) return false;
    return file === 'update.json' ? newer(b, a) : a < b;
  };
  const save = (file, bytes, sig) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [f, d] of [[file, bytes], [file + '.sig', sig + '\n']]) { const t = path.join(dir, `${f}.${process.pid}.tmp`); fs.writeFileSync(t, d, { mode: 0o600 }); fs.renameSync(t, path.join(dir, f)); }
  };
  const lastCheck = () => { try { return JSON.parse(fs.readFileSync(stampFile, 'utf8')).at || 0; } catch { return 0; } };

  async function fetchFile(file, pem, online, problems) {
    if (online) {
      const u = new URL(file, base).href;
      const [b, s] = await Promise.all([fetchImpl(u), fetchImpl(u + '.sig')]);
      if (b.missing || s.missing) return null;
      if (!b.error && !s.error) {
        const sig = s.body.toString('utf8').trim();
        if (verify(b.body, sig, pem)) {
          if (olderThanCache(file, b.body, pem)) return cached(file, pem);   // an older signed file: keep the newer copy
          save(file, b.body, sig); return b.body;
        }
        problems.push(`${file} is not signed by the developer's key`);
      } else problems.push(`could not read ${file} (${b.error || s.error})`);
    }
    return cached(file, pem);
  }

  async function check({ force = false } = {}) {
    const res = { ok: false, updateAvailable: false, version: null, notes: '', items: [], contact: null, error: null, checkedAt: null, from: 'cache' };
    const pem = readPin();
    // P3 S13: `hint` is what the panel shows; `error` stays the machine-side reason.
    if (!pem) { res.error = 'no developer key is pinned on this computer yet (run wk-update once)'; res.hint = 'No developer key yet. The developer signs the first release; then run wk-update.'; return res; }
    const t = now(), online = force || t - lastCheck() >= minIntervalMs;
    const problems = [];
    const up = await fetchFile('update.json', pem, online, problems);
    const nw = await fetchFile('news.json', pem, online, problems);
    // The stamp holds back the next check for an hour, so it is written only when every fetch worked.
    if (online) { res.from = 'network'; if (!problems.length) try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(stampFile, JSON.stringify({ at: t })); } catch { /* read-only home: check again next time */ } res.checkedAt = new Date(t).toISOString(); }
    else res.checkedAt = new Date(lastCheck()).toISOString();
    try { if (up) { const m = parseUpdate(up); res.version = m.version; res.notes = m.notes; res.updateAvailable = !!opts.currentVersion && newer(m.version, opts.currentVersion); } } catch (e) { problems.push(e.message); }
    try { if (nw) { res.items = parseNews(nw); res.contact = parseContact(nw); } } catch (e) { problems.push(e.message); }
    res.error = problems.length ? problems.join('; ') : null;
    res.ok = !res.error;
    return res;
  }
  return { check };
}

module.exports = { createChannel, escapeHtml, plainText, verify, parseUpdate, parseNews, parseContact, isContact, httpsGet, DEFAULT_URL };
