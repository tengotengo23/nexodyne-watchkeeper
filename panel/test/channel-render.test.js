'use strict';
// P2-272 phase 3 stage C: Updates and Messages from the signed channel, the graph status once per visible area,
// and the phone page's status line. A news.json and update.json signed with a test key; nothing goes on the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/channel');
const R = require('../src/render');
const D = require('../src/data');

const EVIL = '<img src=x onerror="window.__xss=1">Fix the "quotes" & <b>tags</b>';
const URL_BASE = 'https://channel.example.test/watchkeeper/channel/';

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}
const sign = (bytes, privateKey) => crypto.sign(null, bytes, privateKey).toString('base64');

function home(pem) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-channel-render-'));
  if (pem) fs.writeFileSync(path.join(h, 'release-key.pub.pem'), pem);
  return h;
}
const news = (over = {}) => Buffer.from(JSON.stringify({ schema: 1, type: 'news', issued_at: '2026-11-24T00:00:00Z', contact: 'dev@example.test',
  items: [{ id: 'n1', date: '2026-11-24', kind: 'news', title: EVIL, body: EVIL + '\nSecond line.', link: 'https://example.test/notes' },
    { id: 'n2', date: '2026-11-20', kind: 'tip', title: 'Short tip', body: 'Plain text.' }], ...over }));
const update = () => Buffer.from(JSON.stringify({ schema: 1, type: 'update', product: 'watchkeeper', version: '9.9.9', tag: 'v9.9.9', commit: 'a'.repeat(40), notes: EVIL }));

// A full panel model (plugin present), as p3-data.test.js builds it, in a temp HOME.
async function full(over = {}) {
  const now = Date.now();
  const base = await D.collect({}, now, { home: fs.mkdtempSync(path.join(os.tmpdir(), 'wk-channel-home-')) });
  return { ...base, now, pace: { state: 'ok', pace: { decision: 'run' } }, ...over };
}

// Serves files by name; `sigs` overrides a signature (a forged one, for example).
function served(files, privateKey, sigs = {}) {
  const seen = [];
  const fetchImpl = async u => {
    seen.push(u);
    const name = u.slice(URL_BASE.length);
    if (name.endsWith('.sig')) { const f = name.slice(0, -4); if (!files[f]) return { missing: true }; return { body: Buffer.from(sigs[f] || sign(files[f], privateKey)) }; }
    return files[name] ? { body: files[name] } : { missing: true };
  };
  return { fetchImpl, seen };
}

test('signed news and a signed update show as escaped text, with the contact address from the signed news', async () => {
  const k = keys();
  const { fetchImpl } = served({ 'news.json': news(), 'update.json': update() }, k.privateKey);
  const res = await C.createChannel({ url: URL_BASE, wkHome: home(k.pem), currentVersion: '1.0.0', fetchImpl }).check();
  assert.equal(res.ok, true, res.error);
  assert.equal(res.contact, 'dev@example.test');
  const model = { channel: res };
  const html = R.renderChannel(model), up = R.renderChannelUpdate(model);
  assert.ok(!html.includes('<img') && !html.includes('<b>') && !up.includes('<img'), 'nothing from the channel renders as HTML');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'));
  assert.ok(html.includes('Short tip') && html.includes('Plain text.'));
  assert.match(html, /Contact the developer: <a href="mailto:dev@example\.test">dev@example\.test<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.test\/notes"[^>]*rel="noopener noreferrer"/);
  assert.match(up, /A signed update is out: Watchkeeper 9\.9\.9\./);
  // In the panel's sections: Updates carries the signed update line, Messages the news
  const s = R.renderSections(await full(model));
  assert.ok(s.messages.includes('Contact the developer'));
});

test('an unsigned or forged news.json shows no items and no contact', async () => {
  const k = keys(), other = keys();
  for (const sigs of [{ 'news.json': sign(news(), other.privateKey) }, { 'news.json': 'AAAA' }]) {
    const { fetchImpl } = served({ 'news.json': news({ contact: 'evil@example.test' }), 'update.json': update() }, k.privateKey, sigs);
    const res = await C.createChannel({ url: URL_BASE, wkHome: home(k.pem), currentVersion: '1.0.0', fetchImpl }).check();
    assert.deepEqual(res.items, []); assert.equal(res.contact, null); assert.match(res.error, /news\.json is not signed/);
    const html = R.renderChannel({ channel: res });
    assert.ok(!html.includes('evil@example.test') && !html.includes('mailto:'));
  }
  // With no pinned key the panel makes no network call at all
  const { fetchImpl, seen } = served({ 'news.json': news() }, k.privateKey);
  const res = await C.createChannel({ url: URL_BASE, wkHome: home(null), fetchImpl }).check();
  assert.equal(seen.length, 0); assert.deepEqual(res.items, []);
  assert.match(R.renderChannel({ channel: res }), /No messages yet\./);
});

test('the panel code never names the developer address itself (the public mirror bans it)', () => {
  for (const f of ['../src/render.js', '../src/channel.js', '../extension.js', '../media/main.js']) {
    assert.ok(!fs.readFileSync(path.join(__dirname, f), 'utf8').includes('info@' + 'nexodyne.org'), f);
  }
});

test('the graph status shows once in the status bar and once in the drawer, with its id, data attribute and Refresh graph', async () => {
  const model = await full({ graphify: { available: true, totalNodes: 812 }, statusLine: 'All quiet.', statusState: 'ok' });
  const s = R.renderSections(model);
  const page = R.renderPage ? String(R.renderPage({ nonce: 'n', cspSource: 'x', scriptUri: 's', styleUris: ['c'] }) || '') : '';
  const all = Object.values(s).join('\n') + page;
  assert.equal((all.match(/id="graph-badge"/g) || []).length, 1, 'one #graph-badge');
  assert.equal((s.graph.match(/data-cmd="graphRefresh"/g) || []).length, 1, 'Refresh graph in the drawer');
  assert.equal((s.statusbar.match(/data-graph-copy/g) || []).length, 1, 'one copy in the status bar');
  const copies = Object.entries(s).filter(([k, v]) => k !== 'statusbar' && /data-graph-copy/.test(v)).map(([k]) => k);
  assert.deepEqual(copies, [], 'no other slot carries a graph copy');
  if (page) assert.ok(!/data-graph-copy/.test(page), 'the page frame carries no fixed graph copy');
});

test('the phone page shows the same status line as the panel, escaped', async () => {
  const model = await full({ statusLine: EVIL, statusState: 'ok' });
  const bar = R.renderSections(model).statusbar;
  const web = R.renderSections({ ...model, host: 'web' });
  const all = Object.values(web).join('\n');
  const line = `<p class="wk-status-line">${C.escapeHtml(EVIL)}</p>`;
  assert.ok(all.includes(line), 'web status carries the line');
  assert.ok(bar.includes(C.escapeHtml(EVIL)), 'panel status bar carries the same text');
  assert.ok(!all.includes('<img'));
  assert.equal(R.statusLineText({ statusState: 'stopped' }), 'Stopped: the Stop switch is on.');
});
