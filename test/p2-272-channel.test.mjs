// P2-272: the developer's signed channel (wk-sign, wk-channel, wk-news, channel-lib, the panel's channel.js).
// Every test works in its own new temp folder; HOME points there for anything that could reach ~/Developer/keys.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import { manifestBytes, verifyChannelFile, parseNews, parseUpdate, fingerprint, CONTACT_IN_REPO, isContact, readContact, KEY_IN_REPO, CHANNEL_IN_REPO, get, checkFile, readChannel, cacheRead } from '../bin/channel-lib.mjs';
import { REFUSAL, makeKeyPair, loadPrivateKey, signBytes, publicPemOf, refusal, writeSigned, newsManifest, updateManifest, verifyFiles, sealPrivateKey, SCRYPT, ENVELOPE_BEGIN, ENVELOPE_END, releaseFacts, confirmMatches, hiddenCount, factsText } from '../bin/wk-sign.mjs';
import { plan, publish } from '../bin/wk-channel.mjs';
import { addDraft, readDrafts, parseDraft } from '../bin/wk-news.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const BIN = n => path.join(root, 'bin', n);
const panel = createRequire(import.meta.url)('../panel/src/channel.js');
const PASS = 'correct horse battery staple';
const COMMIT = 'c'.repeat(40);
const SAMPLE_CONTACT = 'news@example.org';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2c-')));
const gone = d => fs.rmSync(d, { recursive: true, force: true });
const pair = () => { const k = crypto.generateKeyPairSync('ed25519'); return { key: k.privateKey, pem: k.publicKey.export({ type: 'spki', format: 'pem' }) }; };
const news = (items = [{ id: '2026-11-23-hello', date: '2026-11-23', kind: 'news', title: 'Hello', body: 'First news.' }]) => newsManifest(items, new Date('2026-11-23T12:00:00Z'), SAMPLE_CONTACT);
// a repository folder with the release key and signed channel files
function repoWith(k, files = { 'update.json': updateManifest({ version: '1.2.3', commit: COMMIT, now: new Date('2026-11-23T12:00:00Z') }), 'news.json': news() }) {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'release'), { recursive: true });
  fs.writeFileSync(path.join(repo, KEY_IN_REPO), k.pem);
  const dir = path.join(repo, CHANNEL_IN_REPO);
  for (const [f, obj] of Object.entries(files)) writeSigned(dir, f, { schema: 1, product: 'watchkeeper', ...obj, ...(f === 'news.json' ? { product: undefined } : {}) }, k.key, k.pem);
  return { repo, dir };
}

test('sign then verify passes; a changed byte, a wrong key or a missing signature fails', () => {
  const k = pair(), other = pair();
  const bytes = manifestBytes(news());
  const sig = signBytes(bytes, k.key);
  assert.ok(verifyChannelFile(bytes, sig, k.pem));
  const changed = Buffer.from(bytes); changed[10] ^= 1;
  assert.equal(verifyChannelFile(changed, sig, k.pem), false, 'a changed byte');
  assert.equal(verifyChannelFile(bytes, sig, other.pem), false, 'a wrong key');
  assert.equal(verifyChannelFile(bytes, '', k.pem), false, 'no signature');
  assert.equal(verifyChannelFile(bytes, undefined, k.pem), false, 'no signature');
  assert.equal(verifyChannelFile(bytes, sig.slice(0, -4) + 'AAAA', k.pem), false, 'a changed signature');
  // the panel's own copy of the check agrees
  assert.ok(panel.verify(bytes, sig, k.pem));
  assert.equal(panel.verify(changed, sig, k.pem), false); assert.equal(panel.verify(bytes, sig, other.pem), false); assert.equal(panel.verify(bytes, '', k.pem), false);
  assert.match(fingerprint(k.pem), /^[0-9a-f]{4}(:[0-9a-f]{4})+$/);
});

test('the private key is encrypted: it cannot load without the passphrase or with a wrong one', () => {
  assert.throws(() => makeKeyPair('short'), /at least 12/);
  const { privatePem, publicPem } = makeKeyPair(PASS);
  assert.match(privatePem, /BEGIN WATCHKEEPER ENCRYPTED KEY/); assert.doesNotMatch(privatePem, /BEGIN PRIVATE KEY/);
  assert.throws(() => loadPrivateKey(privatePem, ''));
  assert.throws(() => loadPrivateKey(privatePem, 'wrong passphrase here'));
  assert.throws(() => crypto.createPrivateKey(privatePem), 'no passphrase at all');
  const key = loadPrivateKey(privatePem, PASS);
  assert.equal(publicPemOf(key), publicPem);
  const b = Buffer.from('x'); assert.ok(verifyChannelFile(b, signBytes(b, key), publicPem));
});

test('signing refuses without a terminal; the passphrase is never taken from arguments', () => {
  const tty = { isTTY: true }, pipe = { isTTY: false };
  assert.equal(refusal({ stdin: tty, stdout: tty, env: {} }), null);
  assert.equal(refusal({ stdin: pipe, stdout: tty, env: {} }), REFUSAL);
  assert.equal(refusal({ stdin: tty, stdout: pipe, env: {} }), REFUSAL);
  assert.equal(refusal({ stdin: tty, stdout: tty, env: { CLAUDECODE: '1' } }), REFUSAL);
  const home = tmp(), repo = tmp();
  try {
    const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_UPDATE_REPO: repo };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];   // so the refusal comes from the pipe alone
    for (const args of [['keygen'], ['release', 'v1.2.3'], ['news']]) {
      const r = spawnSync(process.execPath, [BIN('wk-sign.mjs'), ...args], { env, input: `${PASS}\n${PASS}\nsign\n`, encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, 3, `${args[0]}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(REFUSAL.replace(/[.:]/g, '\\$&')));
    }
    for (const args of [['keygen', '--passphrase', PASS], ['release', 'v1.2.3', `--pass=${PASS}`], ['news', '-pass', PASS]]) {
      const r = spawnSync(process.execPath, [BIN('wk-sign.mjs'), ...args], { env, input: '', encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /never passed as an argument/);
    }
    assert.ok(!fs.existsSync(path.join(home, 'Developer')), 'no key folder was made');
    assert.deepEqual(fs.readdirSync(repo), [], 'nothing was written to the repository');
  } finally { gone(home); gone(repo); }
});

test('wk-sign verify: the repository key, then the pinned key; a changed file is named', () => {
  const k = pair(), { repo, dir } = repoWith(k), home = tmp();
  try {
    let r = verifyFiles(repo, undefined, home);
    assert.ok(r.ok, r.lines.join('\n')); assert.match(r.lines[0], /NOT PINNED: from the repository/);
    fs.writeFileSync(path.join(home, 'release-key.pub.pem'), pair().pem);
    r = verifyFiles(repo, undefined, home);
    assert.equal(r.ok, false, 'another pinned key wins over the repository key'); assert.match(r.lines.join('\n'), /NOT VERIFIED/);
    fs.writeFileSync(path.join(home, 'release-key.pub.pem'), k.pem);
    fs.appendFileSync(path.join(dir, 'news.json'), ' ');
    r = verifyFiles(repo, undefined, home);
    assert.equal(r.ok, false); assert.match(r.lines.join('\n'), /NOT VERIFIED: .*news\.json/);
  } finally { gone(repo); gone(home); }
});

test('wk-channel publish copies only verified files and refuses the rest; dry run copies nothing', () => {
  const k = pair(), { repo, dir } = repoWith(k), home = tmp(), out = path.join(tmp(), 'web');
  try {
    let r = publish({ repo, to: out, dryRun: true, home });
    assert.deepEqual(r.copy, ['news.json', 'update.json']); assert.deepEqual(r.refused, []);
    assert.ok(!fs.existsSync(out), 'dry run made nothing');
    r = publish({ repo, to: out, home });
    assert.deepEqual(fs.readdirSync(out).sort(), ['news.json', 'news.json.sig', 'update.json', 'update.json.sig']);
    assert.deepEqual(fs.readFileSync(path.join(out, 'news.json')), fs.readFileSync(path.join(dir, 'news.json')));
    assert.throws(() => publish({ repo, to: dir, home }), /channel folder itself/);
    assert.throws(() => publish({ repo, home }), /--to/);
    // tampered, unsigned, foreign-key and stray files are each refused by name
    fs.appendFileSync(path.join(dir, 'update.json'), ' ');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    fs.renameSync(path.join(dir, 'news.json.sig'), path.join(dir, 'news.json.sig.off'));
    const p = plan(dir, k.pem);
    assert.deepEqual(p.copy, []);
    const why = Object.fromEntries(p.refused.map(x => [x.file, x.why]));
    assert.match(why['update.json'], /does not verify/); assert.match(why['news.json'], /no \.sig/);
    assert.match(why['notes.txt'], /not a channel file/); assert.match(why['news.json.sig.off'], /not a channel file/);
    fs.renameSync(path.join(dir, 'news.json.sig.off'), path.join(dir, 'news.json.sig'));
    assert.match(plan(dir, pair().pem).refused.find(x => x.file === 'news.json').why, /does not verify/, 'a foreign key');
    // the CLI: exit 1, nothing new copied, the published copies left as they were
    const before = fs.readFileSync(path.join(out, 'update.json'));
    const c = spawnSync(process.execPath, [BIN('wk-channel.mjs'), 'publish', '--to', out], { env: { ...process.env, HOME: home, WK_HOME: home, WK_UPDATE_REPO: repo }, encoding: 'utf8', timeout: 30000 });
    assert.equal(c.status, 1, c.stdout + c.stderr); assert.match(c.stdout, /refused: update\.json/); assert.match(c.stdout, /refused: notes\.txt/);
    assert.deepEqual(fs.readFileSync(path.join(out, 'update.json')), before);
    // no key anywhere: nothing can be checked, nothing is copied
    fs.renameSync(path.join(repo, KEY_IN_REPO), path.join(repo, 'release', 'key.off'));
    r = publish({ repo, to: path.join(path.dirname(out), 'web2'), home });
    assert.deepEqual(r.copy, []); assert.match(r.refused[0].why, /no developer key/);
  } finally { gone(repo); gone(home); gone(path.dirname(out)); }
});

test('news stays plain text: control characters go, only https links, a bad item is refused', () => {
  const base = { id: '2026-11-23-a', date: '2026-11-23', kind: 'tip', title: 'A\u0007 <b>tip</b>', body: 'Line one\r\nLine\u001b[31m two <script>x</script>' };
  const doc = items => manifestBytes({ schema: 1, type: 'news', issued_at: '2026-11-23T00:00:00Z', contact: SAMPLE_CONTACT, items });
  for (const parse of [b => parseNews(b).items, panel.parseNews]) {
    const [it] = parse(doc([base]));
    assert.equal(it.title, 'A <b>tip</b>'); assert.equal(it.body, 'Line one\nLine[31m two <script>x</script>');
    assert.throws(() => parse(doc([{ ...base, link: 'http://example.com/' }])));
    assert.throws(() => parse(doc([{ ...base, link: 'javascript:alert(1)' }])));
    assert.throws(() => parse(doc([{ ...base, kind: 'html' }])));
    assert.throws(() => parse(doc([{ ...base, title: 'x'.repeat(201) }])));
    assert.throws(() => parse(doc([{ ...base, body: 'x'.repeat(8001) }])));
    assert.equal(parse(doc([{ ...base, link: 'https://nexodyne.org/x' }]))[0].link, 'https://nexodyne.org/x');
  }
  assert.equal(panel.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(news().contact, SAMPLE_CONTACT); assert.equal(parseNews(manifestBytes(news())).contact, SAMPLE_CONTACT);
  assert.throws(() => newsManifest([base], new Date()), /no contact address/, 'no contact: the signer stops');
  assert.throws(() => newsManifest([base], new Date(), 'not an address'), /no contact address/);
  const noContact = manifestBytes({ schema: 1, type: 'news', issued_at: '2026-11-23T00:00:00Z', items: [base] });
  assert.throws(() => parseNews(noContact), /contact/); assert.throws(() => panel.parseNews(noContact), /contact/);
  assert.ok(isContact(SAMPLE_CONTACT) && panel.isContact(SAMPLE_CONTACT)); assert.ok(!isContact('a@b') && !panel.isContact('<x>@y.org'));
  assert.equal(panel.parseContact(Buffer.from(manifestBytes(news()))), SAMPLE_CONTACT); assert.equal(panel.parseContact(Buffer.from(noContact)), null);
  const repo = tmp();
  try {
    assert.equal(readContact(repo), null, 'no file: no contact');
    fs.mkdirSync(path.join(repo, 'release'));
    fs.writeFileSync(path.join(repo, CONTACT_IN_REPO), 'not an address\n'); assert.equal(readContact(repo), null);
    fs.writeFileSync(path.join(repo, CONTACT_IN_REPO), '  ' + SAMPLE_CONTACT + '\n'); assert.equal(readContact(repo), SAMPLE_CONTACT);
  } finally { gone(repo); }
  assert.throws(() => newsManifest([{ ...base, link: 'http://x' }], new Date(), SAMPLE_CONTACT), 'the signer refuses what a reader would refuse');
  assert.throws(() => parseUpdate(manifestBytes({ schema: 1, product: 'watchkeeper', version: '1.2.3', tag: 'v1.2.4', commit: COMMIT })));
  assert.throws(() => panel.parseUpdate(Buffer.from(manifestBytes({ schema: 1, product: 'watchkeeper', version: '1.2.3', tag: 'v1.2.3', commit: 'abc' }))));
});

test('wk-news: add, list, show and remove drafts (a removed draft is kept)', () => {
  const repo = tmp();
  try {
    const dir = path.join(repo, 'release', 'news-drafts');
    const name = addDraft({ dir, kind: 'update', title: 'Version 1.2.3 is out', body: 'What changed.', link: 'https://nexodyne.org/w', date: '2026-11-23' });
    assert.equal(name, '2026-11-23-update-version-1-2-3-is-out.txt');
    assert.throws(() => addDraft({ dir, kind: 'update', title: 'Version 1.2.3 is out', body: 'again', date: '2026-11-23' }), /exists already/);
    assert.throws(() => addDraft({ dir, kind: 'ad', title: 't', body: 'b' }), /--kind/);
    assert.throws(() => addDraft({ dir, kind: 'tip', title: 't', body: 'b', link: 'http://x.org' }), /https/);
    assert.throws(() => parseDraft('bad.txt', 'x\ny'), /name/);
    const { items, problems } = readDrafts(dir);
    assert.deepEqual(problems, []); assert.equal(items[0].id, '2026-11-23-version-1-2-3-is-out'); assert.equal(items[0].link, 'https://nexodyne.org/w');
    const env = { ...process.env, WK_UPDATE_REPO: repo };
    const run = (...a) => spawnSync(process.execPath, [BIN('wk-news.mjs'), ...a], { env, encoding: 'utf8', timeout: 30000 });
    let r = run('add', '--kind', 'tip', '--title', 'Use the panel', '--body', 'Open it daily.', '--date', '2026-11-24');
    assert.equal(r.status, 0, r.stderr);
    r = run('list'); assert.equal(r.status, 0); assert.match(r.stdout, /\[tip\]\s+Use the panel/); assert.match(r.stdout, /\[update\]/);
    r = run('show', '2026-11-24-use-the-panel'); assert.match(r.stdout, /Open it daily\./);
    r = run('remove', '2026-11-24-use-the-panel'); assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.removed', '2026-11-24-tip-use-the-panel.txt')), 'kept, not deleted');
    assert.equal(readDrafts(dir).items.length, 1);
  } finally { gone(repo); }
});

test('--help works for wk-sign, wk-news and wk-channel', () => {
  for (const n of ['wk-sign.mjs', 'wk-news.mjs', 'wk-channel.mjs']) {
    const r = spawnSync(process.execPath, [BIN(n), '--help'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `${n}: ${r.stderr}`); assert.match(r.stdout, /usage:/);
  }
});

test('the panel channel: trusts only the pinned key, caches what verified, reads the cache between checks', async () => {
  const k = pair(), home = tmp();
  try {
    const upd = Buffer.from(manifestBytes({ schema: 1, type: 'update', product: 'watchkeeper', version: '1.2.3', tag: 'v1.2.3', commit: COMMIT, released_at: '2026-11-23T12:00:00Z', notes: 'Better\u0007 notes' }));
    const nws = Buffer.from(manifestBytes(news()));
    let calls = 0, served = { 'update.json': upd, 'news.json': nws }, key = k.key;
    const fetchImpl = async url => {
      calls++;
      const f = url.split('/').pop();
      if (f.endsWith('.sig')) { const b = served[f.slice(0, -4)]; return b ? { body: Buffer.from(signBytes(b, key) + '\n') } : { missing: true }; }
      return served[f] ? { body: served[f] } : { missing: true };
    };
    let t = 1_000_000_000_000;
    const ch = cur => panel.createChannel({ url: 'https://example.invalid/channel', wkHome: home, currentVersion: cur, fetchImpl, now: () => t, minIntervalMs: 3600e3 });
    let r = await ch('1.2.0').check();
    assert.equal(r.ok, false); assert.match(r.error, /no developer key is pinned/); assert.equal(calls, 0, 'no pin: not even fetched');
    fs.writeFileSync(path.join(home, 'release-key.pub.pem'), k.pem);
    r = await ch('1.2.0').check();
    assert.ok(r.ok, r.error); assert.equal(r.from, 'network'); assert.equal(r.updateAvailable, true); assert.equal(r.version, '1.2.3');
    assert.equal(r.notes, 'Better notes'); assert.equal(r.items.length, 1); assert.equal(r.contact, SAMPLE_CONTACT);
    assert.equal(calls, 4);
    assert.ok(fs.existsSync(path.join(home, 'channel', 'update.json.sig')), 'verified files are cached');
    r = await ch('1.2.3').check();
    assert.equal(calls, 4, 'within the hour: the cache only'); assert.equal(r.from, 'cache'); assert.equal(r.updateAvailable, false); assert.equal(r.items.length, 1);
    // a bad signature on the network: named, and the verified cache is still shown
    key = pair().key; t += 3600e3;
    r = await ch('1.2.0').check();
    assert.equal(r.ok, false); assert.match(r.error, /update\.json is not signed by the developer's key/); assert.equal(r.version, '1.2.3', 'the cached, verified copy');
    // a tampered cache is not trusted
    fs.appendFileSync(path.join(home, 'channel', 'news.json'), ' ');
    r = await ch('1.2.0').check();
    assert.deepEqual(r.items, [], 'a changed cached file is dropped');
    // force reads the network even within the hour
    key = k.key; const before = calls;
    r = await ch('1.2.0').check({ force: true });
    assert.ok(r.ok, r.error); assert.equal(calls, before + 4); assert.equal(r.items.length, 1);
  } finally { gone(home); }
});

// ---------------------------------------------------------------- P2-272 part C: the security review's fixes
const envelope = pem => JSON.parse(Buffer.from(pem.slice(pem.indexOf(ENVELOPE_BEGIN) + ENVELOPE_BEGIN.length, pem.indexOf(ENVELOPE_END)).replace(/\s+/g, ''), 'base64').toString('utf8'));
const seal = obj => `${ENVELOPE_BEGIN}\n${Buffer.from(JSON.stringify(obj)).toString('base64').match(/.{1,64}/g).join('\n')}\n${ENVELOPE_END}\n`;

test('S1: the key envelope uses scrypt N >= 2^17 with AES-GCM; wrong passphrase, a changed byte or weaker settings are refused; old keys still load', () => {
  const { privatePem, publicPem } = makeKeyPair(PASS);
  const e = envelope(privatePem);
  assert.equal(e.kdf, 'scrypt'); assert.ok(e.N >= 2 ** 17, `N = ${e.N}`); assert.equal(e.N, SCRYPT.N);
  assert.equal(publicPemOf(loadPrivateKey(privatePem, PASS)), publicPem);
  assert.throws(() => loadPrivateKey(privatePem, 'wrong passphrase here'), /wrong passphrase or damaged key file/);
  const ct = Buffer.from(e.ct, 'base64'); ct[0] ^= 1;
  assert.throws(() => loadPrivateKey(seal({ ...e, ct: ct.toString('base64') }), PASS), /wrong passphrase or damaged key file/, 'a changed ciphertext byte');
  assert.throws(() => loadPrivateKey(seal({ ...e, N: 1024 }), PASS), /below 131072; refused/, 'a lowered N in the file');
  const k = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => loadPrivateKey(sealPrivateKey(k.privateKey, PASS, { N: 1024, r: 8, p: 1 }), PASS), /below 131072; refused/);
  assert.throws(() => loadPrivateKey(`${ENVELOPE_BEGIN}\n!!!\n${ENVELOPE_END}\n`, PASS), /the key file is damaged/);
  const old = k.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS });
  assert.equal(publicPemOf(loadPrivateKey(old, PASS)), k.publicKey.export({ type: 'spki', format: 'pem' }), 'an older PKCS#8 key loads');
  assert.throws(() => loadPrivateKey(old, 'wrong passphrase here'));
});

test('M3: releaseFacts says where the tag points here, on GitHub, and where this folder stands; the confirmation is the first 7 characters', () => {
  const base = tmp();
  const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', cwd, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  try {
    const bare = path.join(base, 'origin.git'), repo = path.join(base, 'work');
    g(base, 'init', '-q', '--bare', '-b', 'main', bare); g(base, 'init', '-q', '-b', 'main', repo); g(repo, 'remote', 'add', 'origin', bare);
    const commit = msg => { fs.writeFileSync(path.join(repo, 'f.txt'), msg); g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
    const a = commit('one'); g(repo, 'tag', 'v1.0.0'); g(repo, 'push', '-q', 'origin', 'main', 'refs/tags/v1.0.0');
    let f = releaseFacts(repo, '1.0.0');
    assert.equal(f.commit, a); assert.equal(f.origin, 'same'); assert.equal(f.relation, 'same'); assert.equal(f.subject, 'one');
    const b = commit('two');
    f = releaseFacts(repo, 'v1.0.0'); assert.equal(f.relation, '1 commits after the tag');
    g(repo, 'tag', 'v2.0.0', b);
    assert.equal(releaseFacts(repo, '2.0.0').origin, 'no tag');
    g(repo, 'push', '-q', 'origin', `${a}:refs/tags/v2.0.0`);
    f = releaseFacts(repo, '2.0.0'); assert.equal(f.origin, `different ${a}`); assert.match(factsText(f), /DIFFERENT commit/);
    g(repo, 'checkout', '-q', '--detach', a);
    assert.match(releaseFacts(repo, '2.0.0').relation, /^1 commits before the tag/);
    g(repo, 'checkout', '-q', '--orphan', 'other'); g(repo, 'commit', '-q', '-m', 'unrelated');
    assert.equal(releaseFacts(repo, '1.0.0').relation, 'not related');
    g(repo, 'remote', 'set-url', 'origin', path.join(base, 'nowhere.git'));
    assert.match(releaseFacts(repo, '1.0.0').origin, /^unreachable /);
    assert.throws(() => releaseFacts(repo, '9.9.9'), /there is no tag v9\.9\.9 here/);
    assert.equal(confirmMatches(a.slice(0, 7).toUpperCase(), a), true, 'upper case');
    assert.equal(confirmMatches(`  ${a.slice(0, 7)} \n`, a), true, 'spaces');
    assert.equal(confirmMatches(a.slice(0, 6), a), false, 'six characters');
    assert.equal(confirmMatches(b.slice(0, 7) === a.slice(0, 7) ? 'zzzzzzz' : b.slice(0, 7), a), false, 'another commit');
    assert.equal(confirmMatches('', a), false); assert.equal(confirmMatches(undefined, a), false);
  } finally { gone(base); }
});

// a loopback server; `request` turns the https URL into http so get() and httpsGet() can be tested without the network
function loopback() {
  const timers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); return res.end('hello'); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.alloc(300 * 1024, 97)); }
    if (req.url === '/cut') { res.writeHead(200, { 'Content-Length': '100' }); res.write('half'); return setTimeout(() => res.socket.destroy(), 50); }
    if (req.url === '/drip') { res.writeHead(200); const t = setInterval(() => res.write('x'), 300); timers.add(t); res.on('close', () => { clearInterval(t); timers.delete(t); }); return; }
    res.writeHead(500); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    url: p => `https://127.0.0.1:${server.address().port}${p}`,
    request: (u, o, cb) => http.request(u.replace(/^https:/, 'http:'), o, cb),
    close: () => new Promise(c => { for (const t of timers) clearInterval(t); server.closeAllConnections(); server.close(() => c()); }),
  })));
}

test('S3: an https read has an overall deadline, a size limit, and a cut connection is an error (channel-lib and the panel)', async () => {
  const s = await loopback();
  try {
    for (const [name, fetch] of [['channel-lib', (u, t) => get(u, t, { request: s.request })], ['panel', (u, t) => panel.httpsGet(u, t, s.request)]]) {
      assert.equal(String((await fetch(s.url('/ok'), 1000)).body), 'hello', name);
      assert.deepEqual(await fetch(s.url('/missing'), 1000), { missing: true }, name);
      assert.deepEqual(await fetch(s.url('/big'), 2000), { error: 'too large' }, name);
      const cut = await fetch(s.url('/cut'), 2000);
      assert.ok(cut.error && !cut.body, `${name}: a cut body is an error, got ${JSON.stringify(cut)}`);
      const t0 = Date.now(), drip = await fetch(s.url('/drip'), 1000), took = Date.now() - t0;
      assert.deepEqual(drip, { error: 'timed out' }, name); assert.ok(took < 2000, `${name}: a dripping server is cut off after the deadline (${took} ms)`);
      assert.match((await fetch('http://127.0.0.1/ok', 1000)).error, /only https/, name);
    }
  } finally { await s.close(); }
});

// a signed-file server for readChannel and the panel: `served` maps a file name to its bytes
const server4 = (k, served) => async url => {
  const f = url.split('/').pop();
  if (f.endsWith('.sig')) { const b = served[f.slice(0, -4)]; return b ? { body: Buffer.from(signBytes(b, k.key) + '\n') } : { missing: true }; }
  return served[f] ? { body: served[f] } : { missing: true };
};
const upd = v => manifestBytes({ schema: 1, type: 'update', product: 'watchkeeper', version: v, tag: `v${v}`, commit: COMMIT, released_at: '2026-11-23T12:00:00Z', notes: `notes ${v}` });
const nws = (when, title) => manifestBytes({ ...newsManifest([{ id: 'n1', date: '2026-11-23', kind: 'news', title, body: 'b' }], new Date(when), SAMPLE_CONTACT) });

test('S4: an older signed file never replaces a newer cached one (update by version, news by issued_at)', async () => {
  const k = pair(), home = tmp(), home2 = tmp();
  try {
    for (const h of [home, home2]) fs.writeFileSync(path.join(h, 'release-key.pub.pem'), k.pem);
    const served = { 'update.json': upd('1.2.0'), 'news.json': nws('2026-11-23T12:00:00Z', 'Newer') };
    const lib = () => readChannel({ url: 'https://example.invalid/channel/', home, fetchImpl: server4(k, served), log: () => {} });
    let r = await lib();
    assert.equal(r['update.json'].value.version, '1.2.0'); assert.equal(r['update.json'].from, 'https');
    served['update.json'] = upd('1.1.0'); served['news.json'] = nws('2026-11-01T12:00:00Z', 'Older');
    r = await lib();
    assert.deepEqual([r['update.json'].value.version, r['update.json'].from], ['1.2.0', 'cache'], 'the older update is not taken');
    assert.deepEqual([r['news.json'].value.items[0].title, r['news.json'].from], ['Newer', 'cache'], 'the older news is not taken');
    assert.equal(cacheRead(home, 'update.json', k.pem).version, '1.2.0'); assert.equal(cacheRead(home, 'news.json', k.pem).items[0].title, 'Newer');
    // the panel
    const p = { 'update.json': upd('1.2.0'), 'news.json': nws('2026-11-23T12:00:00Z', 'Newer') };
    const ch = () => panel.createChannel({ url: 'https://example.invalid/channel', wkHome: home2, currentVersion: '1.0.0', fetchImpl: server4(k, p) });
    let q = await ch().check({ force: true });
    assert.ok(q.ok, q.error); assert.equal(q.version, '1.2.0');
    p['update.json'] = upd('1.1.0'); p['news.json'] = nws('2026-11-01T12:00:00Z', 'Older');
    q = await ch().check({ force: true });
    assert.equal(q.version, '1.2.0', 'the panel keeps the newer update'); assert.equal(q.items[0].title, 'Newer', 'and the newer news');
    assert.equal(parseUpdate(fs.readFileSync(path.join(home2, 'channel', 'update.json'))).version, '1.2.0');
    // a newer one still replaces it
    p['update.json'] = upd('1.3.0'); q = await ch().check({ force: true }); assert.equal(q.version, '1.3.0');
  } finally { gone(home); gone(home2); }
});

test('N3: hidden Unicode (bidi override, zero-width space, NEL, BOM) is taken out of news by the signer and both readers', () => {
  const title = 'Sa‮fe​ up\u0085da﻿te';
  const items = [{ id: 'n3', date: '2026-11-23', kind: 'news', title, body: `body‮​\u0085﻿ here` }];
  assert.equal(hiddenCount(items), 8);
  const m = newsManifest(items, new Date('2026-11-23T12:00:00Z'), SAMPLE_CONTACT);
  assert.equal(m.items[0].title, 'Safe update'); assert.equal(m.items[0].body, 'body here');
  const raw = manifestBytes({ schema: 1, type: 'news', issued_at: '2026-11-23T12:00:00Z', contact: SAMPLE_CONTACT, items });
  assert.equal(parseNews(raw).items[0].title, 'Safe update');
  assert.equal(parseNews(raw).items[0].body, 'body here');
  assert.equal(panel.parseNews(raw)[0].title, 'Safe update'); assert.equal(panel.parseNews(raw)[0].body, 'body here');
  assert.equal(panel.plainText('a‌b‍c'), 'a‌b‍c', 'joiners stay');
});

test('N5: a check that failed is not stamped, so the next check reads the network again', async () => {
  const k = pair(), home = tmp();
  try {
    fs.writeFileSync(path.join(home, 'release-key.pub.pem'), k.pem);
    let calls = 0;
    const ch = panel.createChannel({ url: 'https://example.invalid/channel', wkHome: home, fetchImpl: async () => { calls++; return { error: 'down' }; }, now: () => 5e12 });
    let r = await ch.check();
    assert.equal(r.ok, false); assert.match(r.error, /could not read update\.json \(down\)/); assert.equal(calls, 4);
    assert.ok(!fs.existsSync(path.join(home, 'channel', 'last-check.json')), 'no stamp after a failure');
    r = await ch.check();
    assert.equal(calls, 8, 'the second check goes to the network again'); assert.equal(r.from, 'network');
  } finally { gone(home); }
});

test('N7: a signed news.json served as update.json (or the other way round) is refused', async () => {
  const k = pair(), home = tmp();
  try {
    const n = nws('2026-11-23T12:00:00Z', 'Hello'), u = upd('1.2.3');
    assert.match(checkFile('update.json', { bytes: n, sig: signBytes(n, k.key) }, k.pem).problem, /of type "news", not "update"/);
    assert.ok(checkFile('news.json', { bytes: u, sig: signBytes(u, k.key) }, k.pem).problem, 'an update as news');
    assert.ok(checkFile('update.json', { bytes: u, sig: signBytes(u, k.key) }, k.pem).value, 'the right file passes');
    fs.writeFileSync(path.join(home, 'release-key.pub.pem'), k.pem);
    const r = await panel.createChannel({ url: 'https://example.invalid/channel', wkHome: home, currentVersion: '1.0.0', fetchImpl: server4(k, { 'update.json': n, 'news.json': u }) }).check({ force: true });
    assert.equal(r.ok, false); assert.equal(r.version, null); assert.deepEqual(r.items, []);
    assert.match(r.error, /update\.json is not a Watchkeeper update/); assert.match(r.error, /news\.json is not a news list/);
  } finally { gone(home); }
});

test('N5: wk-sign release refuses when scripts/publish-public.mjs differs from HEAD, before any question or key', () => {
  const home = tmp(), repo = tmp();
  try {
    const g = (...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    g('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.writeFileSync(path.join(repo, 'scripts', 'publish-public.mjs'), '// committed\n');
    g('add', '.'); g('commit', '-qm', 'one');
    const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_UPDATE_REPO: repo };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];   // the refusal under test is N5, not the terminal one
    // A real terminal (pty) so the terminal refusal does not answer first.
    const cmd = [process.execPath, BIN('wk-sign.mjs'), 'release', 'v1.2.3'];
    // expect(1) gives the child a pty even when this test runs without one; its exit code is the child's.
    const tcl = `spawn -noecho ${cmd.map(s => `{${s}}`).join(' ')}; expect eof; catch wait r; exit [lindex $r 3]`;
    const run = () => spawnSync('expect', ['-c', tcl], { env, input: '', encoding: 'utf8', timeout: 30000 });
    // Unchanged: the N5 check passes and the run stops later (no tag v1.2.3 here).
    let r = run(); let out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, out); assert.doesNotMatch(out, /differs from HEAD/); assert.doesNotMatch(out, /never run from Claude|own terminal/i, out);
    fs.appendFileSync(path.join(repo, 'scripts', 'publish-public.mjs'), '// changed\n');
    r = run(); out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, out);
    assert.match(out, /scripts\/publish-public\.mjs differs from HEAD/);
    assert.match(out, /nothing was signed/);
    assert.doesNotMatch(out, /This is what will be signed off|Type the first 7|passphrase/i);
    assert.ok(!fs.existsSync(path.join(home, 'Developer')), 'no key folder was touched');
    assert.ok(!fs.existsSync(path.join(repo, CHANNEL_IN_REPO)), 'nothing was written');
  } finally { gone(home); gone(repo); }
});
