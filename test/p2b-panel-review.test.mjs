// P2-272 (B): the panel's "N to review" list for staged skill sources, and the Approve / Reject messages.
// Every fixture is a fresh mkdtemp vault; the owner's real ~/.gemini is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../panel/src/data.js');
const R = require('../panel/src/render.js');

function vault() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-panel-'));
  const v = path.join(home, '.gemini', 'skill-vault');
  fs.mkdirSync(v, { recursive: true });
  fs.writeFileSync(path.join(v, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', approved: true, status: 'approved', stars: 10 },
    { slug: 'new-one', repo: 'o/new-one', url: 'https://github.com/o/new-one', approved: false, status: 'staged', stars: 1234,
      description: 'First line.\nSecond line <b>bold</b>' },
    { slug: 'bad-url', repo: 'o/bad-url', url: 'javascript:alert(1)', approved: false, status: 'staged' },
    { slug: 'gone', repo: 'o/gone', approved: false, status: 'rejected' },
  ] }));
  fs.writeFileSync(path.join(v, 'index.json'), JSON.stringify({ skill_count: 3, repo_count: 3, skills: [
    { id: 'good/a', name: 'a', slug: 'good', repo: 'o/good', description: 'a' },
    { id: 'new-one/b', name: 'b', slug: 'new-one', repo: 'o/new-one', description: 'b' },
    { id: 'gone/c', name: 'c', slug: 'gone', repo: 'o/gone', description: 'c' },
  ] }));
  return { home, v };
}

function withVault(fn) {
  const { home, v } = vault();
  const old = process.env.REPROMPT_SKILL_VAULT_DIR;
  process.env.REPROMPT_SKILL_VAULT_DIR = v;
  try { return fn(home); } finally {
    if (old === undefined) delete process.env.REPROMPT_SKILL_VAULT_DIR; else process.env.REPROMPT_SKILL_VAULT_DIR = old;
  }
}

test('the library counts approved sources only and lists the staged ones for review', () => withVault(home => {
  const lib = D.readSkillLibrary(home, path.join(home, 'data'));
  assert.equal(lib.total, 1, 'staged and rejected skills are not counted');
  assert.deepEqual(lib.items.map(s => s.name), ['a']);
  assert.equal(lib.reviewCount, 2);
  assert.equal(lib.approvedCount, 1);
  const one = lib.review.find(r => r.slug === 'new-one');
  assert.equal(one.stars, 1234);
  assert.equal(one.url, 'https://github.com/o/new-one');
  assert.ok(!one.description.includes('\n'), 'one line');
  assert.equal(lib.review.find(r => r.slug === 'bad-url').url, 'https://github.com/o/bad-url', 'a bad url falls back to the repo');
  assert.ok(!lib.review.some(r => r.slug === 'gone'), 'rejected sources do not come back');
}));

test('the Library row shows "N to review" with name, stars, a link and Approve / Reject buttons', () => withVault(home => {
  const lib = D.readSkillLibrary(home, path.join(home, 'data'));
  const html = R.renderSkills({ skillLibrary: lib, now: Date.now() });
  assert.match(html, /2 to review/);
  assert.match(html, /o\/new-one/);
  assert.match(html, /1234★/);
  assert.match(html, /href="https:\/\/github\.com\/o\/new-one"/);
  assert.match(html, /data-cmd="skillApprove" data-slug="new-one"/);
  assert.match(html, /data-cmd="skillReject" data-slug="new-one"/);
  assert.ok(!html.includes('<b>bold</b>'), 'the description is escaped');
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /across 1 approved libraries/);
}));

test('no review list when nothing waits', () => {
  const html = R.renderSkills({ skillLibrary: { ready: true, total: 0, repos: 0, domains: [], items: [], sync: null, review: [], reviewCount: 0 }, now: Date.now() });
  assert.ok(!html.includes('to review'));
});

test('Approve / Reject messages: a slug or owner/repo passes, anything else is refused', () => {
  for (const cmd of ['skillApprove', 'skillReject']) {
    for (const slug of ['new-one', 'o/new-one', 'a.b_c-d']) assert.deepEqual(D.validateMessage({ cmd, slug }), { ok: true, msg: { cmd, slug } });
    for (const slug of ['', '-rf', '../x', 'a/b/c', 'a b', 'x;y', 5, undefined, 'a'.repeat(101)]) assert.equal(D.validateMessage({ cmd, slug }).ok, false, String(slug));
  }
});
