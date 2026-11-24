// P2-272 (B-fix): tests for the security review's fixes on the skills library (JavaScript side).
// Every case runs in a fresh mkdtemp HOME; the owner's real ~/.claude, ~/.gemini and ~/.wk are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as ex from '../bin/skill-expose.mjs';
import * as sync from '../bin/wk-skill-sync.mjs';
import { expandHome, resolveDataDir } from '../bin/rp-dir.mjs';

const require = createRequire(import.meta.url);
const D = require('../panel/src/data.js');
const R = require('../panel/src/render.js');

function skill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does one thing.\n---\n# ${name}\n## Use\nPlain words.\n`);
  return path.join(dir, 'SKILL.md');
}

function makeHome() {
  const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-fixes-')));
  const vault = path.join(HOME, '.gemini', 'skill-vault');
  const entries = [];
  const add = (id, name, p, slug, repo) => entries.push({ id, name, description: `${name} skill`, path: p, slug, repo });
  add('local-installed/own-a', 'own-a', skill(path.join(HOME, '.claude', 'skills', 'own-a'), 'own-a'), 'local-installed', 'local/claude-skills');
  add('good/g1', 'g1', skill(path.join(vault, 'repos', 'good', 'skills', 'g1'), 'g1'), 'good', 'o/good');
  // g2 is approved, but a file inside it links to the owner's private file.
  const g2 = path.join(vault, 'repos', 'good', 'skills', 'g2');
  add('good/g2', 'g2', skill(g2, 'g2'), 'good', 'o/good');
  fs.writeFileSync(path.join(HOME, 'private.txt'), 'not for skills\n');
  fs.symlinkSync(path.join(HOME, 'private.txt'), path.join(g2, 'notes.md'));
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ skills: entries }));
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', url: 'https://github.com/o/good', approved: true, status: 'approved' },
  ] }));
  fs.mkdirSync(path.join(HOME, '.wk'), { recursive: true });
  const env = { ...process.env, HOME, WK_HOME: path.join(HOME, '.wk'), REPROMPT_SKILL_VAULT_DIR: vault,
    REPROMPT_DATA_DIR: path.join(HOME, 'rp'), REPROMPT_INCLUDE_LOCAL_SKILLS: '0' };
  return { HOME, vault, env };
}

const lexists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };

test('rejecting a source removes its links from both places at once; approving brings them back', () => {
  const { HOME, env } = makeHome();
  assert.equal(ex.exposeSkill('g1', env).ok, true);
  assert.equal(ex.installLinks(env).ok, true);
  const claudeLink = path.join(HOME, '.claude', 'skills', 'g1');
  const exposedLink = path.join(HOME, '.wk', 'skills-exposed', 'g1');
  assert.ok(fs.lstatSync(claudeLink).isSymbolicLink());
  assert.ok(fs.lstatSync(exposedLink).isSymbolicLink());

  const r = sync.rejectSource('good', { env });
  assert.equal(r.ok, true, r.message);
  assert.ok(!lexists(claudeLink), 'the Claude Code link is gone');
  assert.ok(!lexists(exposedLink), 'the Antigravity link is gone');
  assert.ok(fs.lstatSync(path.join(HOME, '.claude', 'skills', 'own-a')).isDirectory(), 'the owner skill stays');

  const a = sync.approveAndIndex('good', { env });
  assert.equal(a.ok, true, a.message);
  const ids = ex.listExposed(env).exposed.map(s => s.id);
  const g1 = ids.find(id => /g1$/.test(id));
  assert.ok(g1, `g1 is exposed again after approve: ${ids.join(', ')}`);
  assert.ok(fs.lstatSync(exposedLink).isSymbolicLink(), 'the refresh after approve put the link back');
  ex.uninstallLinks(env);
});

test('a link inside an approved skill folder that leads outside is refused by vet and expose', () => {
  const { vault, env } = makeHome();
  const v = ex.vetSkill(path.join(vault, 'repos', 'good', 'skills', 'g2'), env);
  assert.equal(v.ok, false);
  assert.match(v.reason, /notes\.md leads outside the skill folder/);
  const e = ex.exposeSkill('g2', env);
  assert.equal(e.ok, false);
  assert.match(e.message, /leads outside/);
  assert.equal(ex.vetSkill(path.join(vault, 'repos', 'good', 'skills', 'g1'), env).ok, true, 'a clean approved skill passes');
});

test('a link the owner replaced under a managed name survives the next refresh', () => {
  const { HOME, env } = makeHome();
  ex.exposeSkill('g1', env);
  ex.installLinks(env);
  const at = path.join(HOME, '.claude', 'skills', 'g1');
  const mine = path.join(HOME, 'my-own-g1');
  skill(mine, 'g1');
  fs.unlinkSync(at);
  fs.symlinkSync(mine, at);
  const r = ex.refresh(env);
  assert.ok(r && !r.error, JSON.stringify(r));
  assert.equal(fs.readlinkSync(at), mine, 'the owner link is kept');
  const managed = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'skills', '.wk-managed.json'), 'utf8')).managed;
  assert.ok(!managed.includes('g1'), 'the name is no longer managed');
  // A second refresh (and a reject) still leaves it alone.
  sync.rejectSource('good', { env });
  assert.equal(fs.readlinkSync(at), mine);
  ex.uninstallLinks(env);
  assert.equal(fs.readlinkSync(at), mine, 'uninstall leaves the owner link too');
});

test('rp-dir expands ~ the same way Python does', () => {
  const home = os.homedir();
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('~/x/y'), path.join(home, 'x', 'y'));
  assert.equal(expandHome('/abs/~x'), '/abs/~x');
  assert.equal(expandHome('~other/x'), '~other/x');
  const old = process.env.REPROMPT_DATA_DIR;
  process.env.REPROMPT_DATA_DIR = '~/rp-store';
  try { assert.equal(resolveDataDir(), path.join(home, 'rp-store')); } finally {
    if (old === undefined) delete process.env.REPROMPT_DATA_DIR; else process.env.REPROMPT_DATA_DIR = old;
  }
});

test('the review list shows no Approve or Reject buttons for a source without a valid slug', () => {
  const lib = { ready: true, total: 0, repos: 0, domains: [], items: [], sync: null, reviewCount: 2, review: [
    { slug: 'fine-one', repo: 'o/fine-one', url: 'https://github.com/o/fine-one' },
    { slug: '../bad slug', repo: 'o/bad', url: 'https://github.com/o/bad' },
  ] };
  const html = R.renderSkills({ skillLibrary: lib, now: Date.now() });
  assert.equal((html.match(/data-cmd="skillApprove"/g) || []).length, 1);
  assert.equal((html.match(/data-cmd="skillReject"/g) || []).length, 1);
  assert.match(html, /data-slug="fine-one"/);
  assert.ok(!html.includes('data-slug="../bad slug"'));
  assert.match(html, /cannot be approved here/);
});

test('the panel library fails closed: missing, too big or broken sources.json shows local skills only', () => {
  const { HOME, vault } = makeHome();
  const sources = path.join(vault, 'sources.json');
  const old = process.env.REPROMPT_SKILL_VAULT_DIR;
  process.env.REPROMPT_SKILL_VAULT_DIR = vault;
  const names = () => D.readSkillLibrary(HOME, path.join(HOME, 'data')).items.map(s => s.name).sort();
  try {
    assert.deepEqual(names(), ['g1', 'g2', 'own-a'], 'with a good sources.json the approved source counts');
    fs.unlinkSync(sources);
    assert.deepEqual(names(), ['own-a'], 'missing');
    fs.writeFileSync(sources, '{"version": 2, "repos": [');
    assert.deepEqual(names(), ['own-a'], 'does not parse');
    const big = { version: 2, repos: [{ slug: 'good', repo: 'o/good', approved: true, status: 'approved' }], pad: 'x'.repeat(5 * 1024 * 1024) };
    fs.writeFileSync(sources, JSON.stringify(big));
    assert.deepEqual(names(), ['own-a'], 'over the size cap');
  } finally {
    if (old === undefined) delete process.env.REPROMPT_SKILL_VAULT_DIR; else process.env.REPROMPT_SKILL_VAULT_DIR = old;
  }
});
