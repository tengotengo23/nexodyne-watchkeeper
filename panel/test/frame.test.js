'use strict';
// P2-272 (P3-A): the new frame: status bar, rail, Ops drawer, composer bar, Enter sends, theme-only colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/render');

const EVIL = `<img src=x onerror=alert(1)>"'&</script>`;
const page = () => R.renderPage({ nonce: 'n0nce', cspSource: 'vscode-resource:', scriptUri: 'main.js' });

test('status bar: the pill shows only when something waits', () => {
  const none = R.renderStatusBar({ statusLine: 'All calm.', pace: { state: 'ok' } });
  assert.match(none, /All calm\./);
  assert.doesNotMatch(none, /Waiting for you/);
  const two = R.renderStatusBar({ statusLine: 'x', pace: { state: 'ok' }, questions: { items: [{}] }, suggestions: { items: [{}] } });
  assert.match(two, /data-cmd="toggleWaiting"/);
  assert.match(two, /Waiting for you \(2\)/);
  assert.equal(R.renderStatusBar({ pace: { state: 'no-plugin' } }), '');
});

test('status bar: the line is escaped', () => {
  const html = R.renderStatusBar({ statusLine: EVIL, pace: { state: 'ok' } });
  assert.ok(!html.includes('<img'), 'raw tag rendered');
  assert.ok(!html.includes('</script>'), 'raw script end rendered');
  assert.match(html, /&lt;img/);
});

test('renderSkills: the review queue only with withReview', () => {
  const m = { pace: { state: 'ok' }, skillLibrary: { ready: true, total: 3, repos: 1, domains: [], items: [], review: [{ slug: 'acme/skills', repo: 'acme/skills' }], reviewCount: 1 } };
  const rev = R.renderSkillReview(m.skillLibrary);
  assert.match(rev, /1 to review/);
  assert.match(rev, /data-cmd="skillApprove"/);
  assert.ok(R.renderSkills(m).includes(rev));
  assert.ok(!R.renderSkills(m, { withReview: false }).includes('to review'));
});

test('page landmarks: drawer, waiting panel, rail, composer bar', () => {
  const html = page();
  for (const id of ['wk-ops', 'wk-waiting-panel', 'wk-rail-body', 'wk-limits', 'rp-mode-pill', 'rp-skill-chips', 'rp-route'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /\+ New Session/);
  assert.match(html, /data-cmd="chatNew"/);
  assert.doesNotMatch(html, /class="wk-tab\b/, 'no tab buttons');
  // P2-272 P3 fixes (S9, the brief's ruling): the route list moved into the composer's "Overrides", closed by default;
  // it is in exactly that one <details> and in no drawer group
  const at = html.indexOf('id="rp-route"');
  const before = html.slice(0, at);
  const opened = (before.match(/<details\b/g) || []).length, closed = (before.match(/<\/details>/g) || []).length;
  assert.equal(opened, closed + 1, '#rp-route sits in exactly one open <details>');
  const last = before.slice(before.lastIndexOf('<details'));
  assert.match(last, /^<details class="composer-opts"[^>]*>/, 'that <details> is the composer\'s Overrides');
  assert.doesNotMatch(last.match(/^<details[^>]*>/)[0], /\sopen\b/, 'Overrides is closed by default');
  // the sections that need the plugin are all still there (nothing cut)
  assert.equal((html.match(/data-needs="plugin"/g) || []).length, 7); // P2-272 P3: 6 to 7, the usage card is one more plugin section; nothing cut
  assert.equal((html.match(/data-needs="/g) || []).length, 13); // P2-272 P3: the usage card adds one
  // no inline handlers
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test('rail: archived sessions go to the Archived group', () => {
  const now = Date.UTC(2026, 10, 23);
  const m = {
    now, pace: { state: 'ok' }, sessions: { sessions: [] },
    chatSessions: [
      { id: 'a1', title: 'fresh one', updatedAt: now - 3600e3, lastStatus: 'done' },
      { id: 'b2', title: 'old quiet one', updatedAt: now - 9 * 86400e3, lastStatus: 'done' },
      { id: 'c3', title: 'old but running', updatedAt: now - 9 * 86400e3, lastStatus: 'running' },
      { id: 'd4', title: EVIL, archived: true, updatedAt: now },
    ],
  };
  const html = R.renderRail(m);
  const cut = html.indexOf('data-id="rail-archived"');
  assert.ok(cut > 0);
  const top = html.slice(0, cut), bottom = html.slice(cut);
  assert.match(top, /fresh one/); assert.match(top, /old but running/);
  assert.doesNotMatch(top, /old quiet one/);
  assert.match(bottom, /old quiet one/);
  assert.match(bottom, /Archived \(2\)/);
  assert.ok(!html.includes('<img'), 'title not escaped');
});

test('main.js: Enter sends, Shift+Enter does not, in every composer', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const m = js.match(/function enterSends\(e\) \{\s*return ([^;]+);/);
  assert.ok(m, 'enterSends missing');
  const enterSends = new Function('e', `return ${m[1]};`);
  assert.equal(enterSends({ key: 'Enter' }), true);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }), false);
  assert.equal(enterSends({ key: 'Enter', isComposing: true }), false);
  assert.equal(enterSends({ key: 'a' }), false);
  for (const id of ['note', 'task-text', 'orch-prompt', 'job-prompt', 'ans-text-', 'data-reply']) assert.ok(js.includes(id), id);
});

test('main.css: theme colours only (no hex), sizes in rem', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, 'hex colour');
  const px = css.match(/\b(?!1px)\d*\.?\d+px\b/g) || [];
  assert.deepEqual(px, [], 'px other than 1px');
});
