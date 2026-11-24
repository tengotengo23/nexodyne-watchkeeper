// P2-278 API drive: the W panel's API keys card. Temp WK_KEYS_DIR, WK_HOME and HOME; fake keys only; no network
// (a check without a key must not call out, and the counting server on 127.0.0.1 proves it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-apikeys-')));
process.env.HOME = TMP;
process.env.WK_HOME = path.join(TMP, '.wk');
process.env.WK_KEYS_DIR = path.join(TMP, 'keys');

const D = require('../src/data');
const R = require('../src/render');
const A = require('../src/actions');

const ROOT = path.resolve(__dirname, '..', '..');            // the plugin (repo) root: bin/api-drive-lib.mjs lives there
const PANEL = path.resolve(__dirname, '..');
const GEMINI_FAKE = 'AIza' + 'FAKE' + 'x'.repeat(31) + 'g7Q2';
const CLAUDE_FAKE = 'sk-ant-' + 'FAKE' + '-' + 'y'.repeat(40) + 'c9Z1';

let hits = 0, server;
test.before(async () => {
  server = http.createServer((q, s) => { hits++; s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"models":[],"data":[]}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  process.env.WK_GEMINI_API_HOST = host; process.env.WK_ANTHROPIC_API_HOST = host;
});
test.after(() => { server.close(); });

const leaks = s => { const j = JSON.stringify(s); return j.includes(GEMINI_FAKE) || j.includes(CLAUDE_FAKE) || j.includes('FAKExxxx') || j.includes('FAKE-yyyy'); };

test('the page has the keys card: password boxes, Save, Check, Remove, the Gemini notice under its box', () => {
  const page = R.renderPage({ nonce: 'n', cspSource: 'c', scriptUri: 's' });
  for (const p of ['gemini', 'claude']) {
    assert.match(page, new RegExp(`<input type="password" id="apikey-${p}" class="apikey-input" autocomplete="off"`));
    for (const c of ['apiKeySave', 'apiKeyCheck', 'apiKeyRemove']) assert.ok(page.includes(`data-cmd="${c}" data-provider="${p}"`), `${c} ${p}`);
  }
  assert.ok(page.includes('Gemini API key (paid)') && page.includes('Claude API key'));
  assert.ok(R.GEMINI_FREE_NOTICE.startsWith('With a free Gemini API key, Google uses what you send'));
  assert.ok(page.includes('In the European Economic Area, Switzerland and the United Kingdom, use a paid key.'));
  assert.ok(page.indexOf('id="apikey-gemini"') < page.indexOf('With a free Gemini API key'), 'the notice sits under the Gemini box');
  assert.ok(page.includes('id="feedback-apikeys"') && page.includes('data-needs="apikeys"'));
});

test('the Mac panel fills the card; the phone page (host web) gets nothing', async () => {
  const m = await D.collect({ pluginPath: ROOT }, Date.now(), { home: TMP });
  assert.equal(m.apiKeys.available, true);
  assert.equal(m.apiKeys.gemini.line, 'Not set');
  const mac = R.renderSections({ ...m, host: 'antigravity' });
  assert.equal(mac.show.apikeys, true);
  assert.match(mac.apikeyGemini, /Not set/);
  assert.match(mac.apikeyClaude, /Today US\$0\.00 of 2\.00/);
  assert.match(mac.apikeysFoot, /Daily cap US\$2\.00 each\. The AI never sees these keys\./);
  const web = R.renderSections({ ...m, host: 'web' });
  assert.equal(web.show.apikeys, false);
  assert.equal(web.apikeyGemini + web.apikeyClaude + web.apikeysFoot, '');
  const old = R.renderApiKeys({ apiKeys: { available: false } });
  assert.match(old.gemini, /Update the Watchkeeper plugin to use API keys\./);
});

test('validateMessage: the provider is checked and no error ever echoes the key', () => {
  const bad = D.validateMessage({ cmd: 'apiKeySave', provider: 'openai', key: GEMINI_FAKE });
  assert.equal(bad.ok, false); assert.ok(!leaks(bad));
  for (const key of [GEMINI_FAKE + ' tail', GEMINI_FAKE + '\n' + GEMINI_FAKE, GEMINI_FAKE.repeat(10), 'é' + GEMINI_FAKE, 42]) {
    const v = D.validateMessage({ cmd: 'apiKeySave', provider: 'gemini', key });
    assert.equal(v.ok, false); assert.ok(!leaks(v), 'error leaks the key'); assert.ok(typeof v.error === 'string');
  }
  const ok = D.validateMessage({ cmd: 'apiKeySave', provider: 'gemini', key: '  ' + GEMINI_FAKE + '\n' });
  assert.deepEqual(ok.msg, { cmd: 'apiKeySave', provider: 'gemini', key: GEMINI_FAKE });
  assert.deepEqual(D.validateMessage({ cmd: 'apiKeyCheck', provider: 'claude', key: CLAUDE_FAKE }).msg, { cmd: 'apiKeyCheck', provider: 'claude' });
});

test('save, check and remove through the action: the answer carries the last four characters only; the file is 0600 in a 0700 folder', async () => {
  const paths = { pluginPath: ROOT };
  const before = hits;
  const noKey = await A.apiKey(paths, { cmd: 'apiKeyCheck', provider: 'claude' });
  assert.equal(noKey.ok, false); assert.match(noKey.text, /Paste your key in the W panel's API keys card\./);
  assert.equal(hits, before, 'a check without a key made a request');

  const g = await A.apiKey(paths, { cmd: 'apiKeySave', provider: 'gemini', key: GEMINI_FAKE });
  assert.equal(g.ok, true); assert.equal(g.where, 'apikeys'); assert.equal(g.cleared, true);
  assert.deepEqual(g.extra, { provider: 'gemini', saved: true, tail: 'g7Q2' });
  assert.equal(g.text, 'Gemini key saved, ends in g7Q2.');
  assert.ok(!leaks(g));
  const file = path.join(process.env.WK_KEYS_DIR, 'gemini.key');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(process.env.WK_KEYS_DIR).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), GEMINI_FAKE);

  const c = await A.apiKey(paths, { cmd: 'apiKeySave', provider: 'claude', key: CLAUDE_FAKE });
  assert.equal(c.ok, true); assert.ok(fs.existsSync(path.join(process.env.WK_KEYS_DIR, 'anthropic.key')));
  const chk = await A.apiKey(paths, { cmd: 'apiKeyCheck', provider: 'claude' });
  assert.equal(chk.ok, true); assert.match(chk.text, /^Claude: Saved, ends in c9Z1 · checked \d\d:\d\d: works$/);
  assert.equal(hits, before + 1);

  const st = await D.apiKeysState(ROOT);
  assert.equal(st.gemini.tail, 'g7Q2'); assert.equal(st.claude.ok, true);
  assert.ok(!leaks(st));
  const shown = R.renderSections({ ...(await D.collect({ pluginPath: ROOT }, Date.now(), { home: TMP })), host: 'antigravity' });
  assert.ok(!leaks(shown)); assert.match(shown.apikeyGemini, /Saved, ends in g7Q2/);

  const bad = await A.apiKey(paths, { cmd: 'apiKeySave', provider: 'gemini', key: 'two words' });
  assert.equal(bad.ok, false); assert.equal(bad.cleared, true);
  const rm = await A.apiKey(paths, { cmd: 'apiKeyRemove', provider: 'gemini' });
  assert.equal(rm.text, 'Gemini key removed.'); assert.equal(fs.existsSync(file), false);
  assert.equal((await A.apiKey(paths, { cmd: 'apiKeyRemove', provider: 'gemini' })).text, 'No Gemini key was saved.');
  assert.equal((await A.apiKey({ pluginPath: path.join(TMP, 'nowhere') }, { cmd: 'apiKeyCheck', provider: 'gemini' })).text, 'Update the Watchkeeper plugin to use API keys.');
  // nothing in the Watchkeeper data folder carries a key
  const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of walk(process.env.WK_HOME)) assert.ok(!leaks(fs.readFileSync(f, 'utf8')), f);
});

test('the webview posts the key once, clears the box at once and never keeps it in state', () => {
  const js = fs.readFileSync(path.join(PANEL, 'media', 'main.js'), 'utf8');
  const i = js.indexOf("cmd === 'apiKeySave' || cmd === 'apiKeyCheck' || cmd === 'apiKeyRemove'");
  assert.ok(i > 0);
  const branch = js.slice(i, js.indexOf("} else if (cmd === 'openAdvice')", i));
  assert.ok(branch.indexOf("box.value = ''") < branch.indexOf('vscode.postMessage({ cmd, provider, key })'), 'the box is cleared before the post');
  assert.doesNotMatch(branch, /setState|state\.|localStorage|console\./);
  assert.doesNotMatch(js, /setState\([^)]*key/);
  const ext = fs.readFileSync(path.join(PANEL, 'extension.js'), 'utf8');
  assert.match(ext, /apiKeySave: 'apikeys', apiKeyCheck: 'apikeys', apiKeyRemove: 'apikeys'/);
  assert.match(ext, /return this\.answer\(await A\.apiKey\(paths, m\)\)/);
});

// ---- the review's N3: each row of the card has its own feedback line, under that row's controls ----
test('each key row has its own feedback line, inside the row and under its controls', () => {
  const page = R.renderPage({ nonce: 'n', cspSource: 'c', scriptUri: 's' });
  for (const p of ['gemini', 'claude']) {
    const start = page.lastIndexOf('<div class="apikey-row">', page.indexOf(`id="apikey-${p}"`));
    const end = page.indexOf('<div class="apikey-row">', start + 1) > 0 && p === 'gemini'
      ? page.indexOf('<div class="apikey-row">', start + 1) : page.indexOf('data-slot="apikeysFoot"', start);
    const row = page.slice(start, end);
    const fb = row.indexOf(`<p class="feedback" id="feedback-apikeys-${p}" aria-live="polite"></p>`);
    assert.ok(fb > 0, `${p}: the feedback line is inside its row`);
    for (const c of ['apiKeySave', 'apiKeyCheck', 'apiKeyRemove']) assert.ok(row.indexOf(`data-cmd="${c}" data-provider="${p}"`) < fb, `${p}: under ${c}`);
    assert.ok(row.indexOf(`id="apikey-status-${p}"`) < fb, `${p}: under the status line`);
    assert.equal((page.match(new RegExp(`id="feedback-apikeys-${p}"`, 'g')) || []).length, 1);
  }
  assert.ok(page.includes('id="feedback-apikeys"'), 'the card keeps one line for answers that name no provider');
});

test('every key answer for a known provider names it, errors too, so the webview can place it under that row', async () => {
  const paths = { pluginPath: ROOT };
  for (const p of ['gemini', 'claude']) {
    const bad = await A.apiKey(paths, { cmd: 'apiKeySave', provider: p, key: 'two words' });
    assert.equal(bad.ok, false); assert.equal(bad.extra.provider, p);
    const old = await A.apiKey({ pluginPath: path.join(TMP, 'nowhere') }, { cmd: 'apiKeyCheck', provider: p });
    assert.equal(old.ok, false); assert.equal(old.extra.provider, p);
    const odd = await A.apiKey(paths, { cmd: 'apiKeyFrobnicate', provider: p });
    assert.equal(odd.text, 'Unknown action.'); assert.equal(odd.extra.provider, p);
    for (const r of [bad, old, odd]) { assert.equal(r.where, 'apikeys'); assert.ok(!leaks(r)); }
  }
  const none = await A.apiKey(paths, { cmd: 'apiKeyCheck', provider: 'openai' });
  assert.equal(none.text, 'Pick Gemini or Claude.'); assert.ok(!(none.extra && none.extra.provider), 'an unknown provider goes to the card line');
});

test('the webview routes a key answer to its own row and the empty-box warning too', () => {
  const js = fs.readFileSync(path.join(PANEL, 'media', 'main.js'), 'utf8');
  assert.match(js, /m\.where === 'apikeys' && \(m\.provider === 'gemini' \|\| m\.provider === 'claude'\)\) \? 'apikeys-' \+ m\.provider/);
  assert.ok(js.includes("say('Paste the key first.', false, 'apikeys-' + provider)"));
  assert.doesNotMatch(js, /say\([^)]*'apikeys'\)/, 'no key message goes to the shared card line by name');
});
