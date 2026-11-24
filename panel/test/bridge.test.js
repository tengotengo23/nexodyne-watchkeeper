'use strict';
// P2-277 Bridge: the panel reads watch.json only; the render in both motion modes; the two buttons; the message check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data');
const R = require('../src/render');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-bridge-panel-'));
const now = Date.parse('2026-11-24T20:30:00Z');
function watch(bridge, ids = {}, held) { fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify({ at: '2026-11-24T20:29:50Z', ids, bridge, ...(held ? { held } : {}) })); }
const crossing = (event, from, to, title, at = '2026-11-24T20:20:00Z') => ({ at, kind: 'task', id: '20261124-202000-x', from, to, event, title });

test('readBridge: no file, no bridge section, then a full one with bad values cleaned', () => {
  assert.equal(D.readBridge(dir).found, false);
  fs.writeFileSync(path.join(dir, 'watch.json'), '{"at":"x"}');
  assert.equal(D.readBridge(dir).found, false);
  watch({ on: true, counts: { queued_for_gemini: 2, waiting_for_claude: -1, in_flight: 'x', done_24h: 3, stalled: 1 }, stalled_ids: ['a', 5], routes: { claude_wait: { alive: true, pid: 4242 }, hooks: 'on' },
    last_crossings: [crossing('queued', 'claude', 'gemini', 'Fix <b>login</b>' + String.fromCharCode(0x2028) + 'now'), crossing('bogus', 'gemini', 'claude', 'odd')] },
  { tasks_for_gemini: ['../evil', '20261124-202000-fix-login'], handoffs_for_claude: ['relative@2026-11-24T20:00:00Z'] });
  const b = D.readBridge(dir);
  assert.equal(b.found, true); assert.equal(b.on, true);
  assert.deepEqual(b.counts, { queued_for_gemini: 2, waiting_for_claude: 0, in_flight: 0, done_24h: 3, stalled: 1 });
  assert.deepEqual(b.stalledIds, ['a']);
  assert.equal(b.routes.claude_wait, 'a Claude tab (pid 4242)', 'the real wk-watch shape {alive, pid}, not "none"');
  assert.equal(b.taskId, '20261124-202000-fix-login', 'only a real task id');
  assert.equal(b.claudeRepo, '', 'only an absolute folder');
  assert.equal(b.crossings[1].event, 'unknown');
  assert.ok(!b.crossings[0].title.includes(String.fromCharCode(0x2028)));
});

test('renderBridge: towers, counts, dots by event and direction, the last 5 crossings, buttons only in the IDE', () => {
  // the same from/to the writers use: wk-task (queued, taken, done), the watchdog (requeued), wk-takeover (written, consumed)
  const list = [crossing('queued', 'claude', 'gemini', 'one'), crossing('taken', 'claude', 'gemini', 'two'), crossing('done', 'gemini', 'claude', 'three'),
    crossing('requeued', 'gemini', 'gemini', 'four'), crossing('written', 'antigravity', 'claude', 'five'), crossing('queued', 'claude', 'gemini', 'six <script>')];
  watch({ on: true, counts: { queued_for_gemini: 1, waiting_for_claude: 1, in_flight: 1, done_24h: 2, stalled: 1 }, stalled_ids: [], routes: { claude_wait: { alive: false, pid: null }, hooks: 'on' }, last_crossings: list },
    { tasks_for_gemini: ['20261124-202000-fix-login'], handoffs_for_claude: ['/tmp@2026-11-24T20:00:00Z'] });
  const m = { now, host: 'antigravity', bridge: D.readBridge(dir) };
  const html = R.renderBridge(m);
  assert.match(html, /<svg class="bridge-svg"[^>]*role="img"/);
  assert.match(html, />Claude<\/text>[\s\S]*>Gemini<\/text>/, 'Claude left, Gemini right');
  assert.equal((html.match(/class="bridge-dot /g) || []).length, 5, 'the last 5 crossings');
  assert.ok(!/>one</.test(html), 'the oldest of six is left out');
  assert.match(html, /bridge-dot tone-blue ltr d0/, 'taken: blue');
  assert.match(html, /bridge-dot tone-green rtl d1/, 'done from Gemini: green, right to left');
  assert.match(html, /bridge-dot tone-red rtl d2/, 'requeued: red');
  assert.match(html, /bridge-dot tone-amber rtl d3/, 'handoff written: amber');
  assert.match(html, /bridge-dot tone-amber ltr d4/, 'queued: amber, left to right');
  assert.match(html, /class="bridge-arrow" d="M150 66/, 'the arrow follows the last crossing (Claude to the right)');
  assert.match(html, /1 waiting[\s\S]*1 in flight[\s\S]*2 done in 24 h[\s\S]*1 stalled[\s\S]*1 queued/);
  assert.equal((html.match(/<li>/g) || []).length, 5);
  assert.ok(html.includes('six &lt;script&gt;') && !html.includes('<script>'), 'titles are escaped');
  assert.match(html, /Waiting in Claude: <strong>nobody<\/strong>/, 'claude_wait {alive:false} reads "nobody"');
  assert.match(html, /data-cmd="bridgeOpenClaude" data-repo="\/tmp"/);
  assert.match(html, /data-cmd="bridgeOpenAntigravity" data-task-id="20261124-202000-fix-login"/);
  assert.ok(!/style=/.test(html), 'no inline style (the CSP allows none)');
  const web = R.renderBridge({ ...m, host: 'web' });
  assert.ok(!/data-cmd="bridge/.test(web), 'the phone page gets no buttons');
  assert.match(R.renderBridge({ now, bridge: D.EMPTY_BRIDGE }), /no news yet/);
});

test('the page: Bridge has its own drawer group, before the Gemini queue', () => {
  const page = R.renderPage({ nonce: 'n', cspSource: 'c', scriptUri: 's' });
  assert.match(page, /id="ops-bridge"[\s\S]*data-needs="bridge"[\s\S]*data-slot="bridge"[\s\S]*id="ops-gemini"/);
});

test('both motion modes: dots animate by keyframes; reduced motion stops them and shows the arrow', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.css'), 'utf8');
  assert.match(css, /\.bridge-dot\.ltr \{ animation: wk-bridge-ltr/);
  assert.match(css, /@keyframes wk-bridge-ltr/);
  assert.match(css, /\.bridge-arrow \{[^}]*display: none;/, 'no arrow while the dots move');
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.bridge-dot\.ltr, \.bridge-dot\.rtl \{ animation: none; opacity: 1; transform: none; \}/);
  assert.match(reduced, /\.bridge-arrow \{ display: inline; \}/);
  const block = css.slice(css.indexOf('/* P2-277 Bridge'));
  assert.ok(!/\d+px/.test(block.replace(/1px solid/g, '')), 'sizes in rem');
});

test('messages: bad task ids and control characters are refused or cleaned', () => {
  assert.equal(D.validateMessage({ cmd: 'bridgeOpenAntigravity', taskId: '../x' }).ok, false);
  assert.deepEqual(D.validateMessage({ cmd: 'bridgeOpenAntigravity', taskId: '20261124-202000-fix-login' }).msg, { cmd: 'bridgeOpenAntigravity', taskId: '20261124-202000-fix-login' });
  assert.equal(D.validateMessage({ cmd: 'bridgeOpenClaude', repo: '/a\nb' }).msg.repo, '');
  assert.equal(D.validateMessage({ cmd: 'bridgeOpenClaude', repo: '/a' }).msg.repo, '/a');
});

// Review must-fix 3 and 4: claude_wait in the shape wk-watch writes; held over every state, on the task row and in the Bridge card.
test('waitWords: the {alive, pid} shape from bin/wk-bridge.mjs waitRoute, anything else is "nobody"', () => {
  assert.equal(D.waitWords({ alive: true, pid: 77 }), 'a Claude tab (pid 77)');
  assert.equal(D.waitWords({ alive: true, pid: null }), 'a Claude tab');
  assert.equal(D.waitWords({ alive: false, pid: 77 }), 'nobody');
  assert.equal(D.waitWords('stop-hook'), 'nobody');
  assert.equal(D.waitWords(undefined), 'nobody');
});
test('held: a held taken task shows a "held" chip on its row, and the Bridge card lists held ids from watch.json', () => {
  const id = '20261124-210000-held-one', id2 = '20261124-210100-free-one', id3 = '20261124-210200-old-hold';
  for (const [i, st] of [[id, 'taken'], [id2, 'queued'], [id3, 'taken']]) {
    fs.mkdirSync(path.join(dir, 'tasks', i), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks', i, 'meta.json'), JSON.stringify({ id: i, title: i, status: st, created_at: '2026-11-24T21:00:00Z' }));
  }
  fs.writeFileSync(path.join(dir, 'tasks', id, 'hold'), JSON.stringify({ at: '2026-11-24T21:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'tasks', id3, 'hold'), JSON.stringify({ at: '2026-11-24T20:00:00Z', until: '2000-01-01T00:00:00Z' }));
  const t = D.readTasks(dir);
  const by = Object.fromEntries(t.items.map(x => [x.id, x]));
  assert.equal(by[id].held, true, 'a held taken task counts');
  assert.equal(by[id2].held, false);
  assert.equal(by[id3].held, false, 'an expired hold counts as released');
  const html = R.renderGemini ? R.renderGemini({ now, host: 'antigravity', tasks: t }) : '';
  if (R.renderGemini) {
    const rowOf = x => (html.split('<li>').find(li => li.includes(x)) || '');
    assert.match(rowOf(id), /held-chip[^>]*>held</);
    assert.ok(!/held-chip/.test(rowOf(id2)));
  }
  watch({ on: true, counts: {}, routes: { claude_wait: { alive: false, pid: null } }, last_crossings: [] }, { tasks_for_gemini: [], handoffs_for_claude: [] }, [id, '../bad']);
  const b = D.readBridge(dir);
  assert.deepEqual(b.held, [id], 'only real task ids');
  const card = R.renderBridge({ now, host: 'antigravity', bridge: b });
  assert.match(card, /held-chip">held<\/span> 1 task on hold: <code>20261124-210000-held-one<\/code>/);
  for (const i of [id, id2, id3]) fs.rmSync(path.join(dir, 'tasks', i), { recursive: true, force: true });
});
