// P2-272 (B): one exposure for both IDEs. Every case runs in a fresh temp HOME (mkdtemp);
// the owner's real ~/.claude, ~/.gemini and ~/.wk are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as ex from '../bin/skill-expose.mjs';

const require = createRequire(import.meta.url);
const gate = require('../panel/src/skill-gate.js');
const vectors = require('./fixtures/skill-gate-vectors.json');
// The head of an Apache 2.0 LICENSE.txt, as in Anthropic's open skills (pdf, docx, pptx, xlsx, skill-creator).
const APACHE = '\n                                 Apache License\n                           Version 2.0, January 2004\n';

function skill(dir, name, body = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does one thing.\n---\n# ${name}\n## Use\nPlain words.\n${body}`);
  return path.join(dir, 'SKILL.md');
}

function makeHome() {
  const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-expose-')));
  const vault = path.join(HOME, '.gemini', 'skill-vault');
  const outside = path.join(HOME, 'outside-skill');
  const entries = [];
  const add = (id, name, p, slug, repo) => entries.push({ id, name, description: `${name} skill`, path: p, slug, repo });
  add('local-installed/own-a', 'own-a', skill(path.join(HOME, '.claude', 'skills', 'own-a'), 'own-a'), 'local-installed', 'local/claude-skills');
  add('local-installed/own-b', 'own-b', skill(path.join(HOME, '.claude', 'skills', 'synced', 'u1', 'own-b'), 'own-b'), 'local-installed', 'local/claude-skills');
  add('local-installed/own-c', 'own-c', skill(path.join(HOME, '.claude', 'skills', 'synced', 'u2', 'own-c'), 'own-c'), 'local-installed', 'local/claude-skills');
  // Skills synced from the owner's Claude account reach Antigravity only with an open licence (P2-272).
  for (const u of ['u1/own-b', 'u2/own-c']) fs.writeFileSync(path.join(HOME, '.claude', 'skills', 'synced', u, 'LICENSE.txt'), APACHE);
  add('good/g1', 'g1', skill(path.join(vault, 'repos', 'good', 'skills', 'g1'), 'g1'), 'good', 'o/good');
  add('staged/s1', 's1', skill(path.join(vault, 'repos', 'staged', 'skills', 's1'), 's1'), 'staged', 'o/staged');
  add('good/bad', 'bad', skill(path.join(vault, 'repos', 'good', 'skills', 'bad'), 'bad', `key: sk-ant-${'Q'.repeat(40)}\n`), 'good', 'o/good');
  skill(outside, 'esc');
  fs.symlinkSync(outside, path.join(vault, 'repos', 'good', 'skills', 'esc'));
  add('good/esc', 'esc', path.join(vault, 'repos', 'good', 'skills', 'esc', 'SKILL.md'), 'good', 'o/good');
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ skills: entries }));
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', approved: true, status: 'approved' },
    { slug: 'staged', repo: 'o/staged', approved: false, status: 'staged' },
  ] }));
  // An installed plugin already provides own-c.
  const plug = path.join(HOME, 'plugin-cache', 'p1');
  skill(path.join(plug, 'skills', 'own-c'), 'own-c');
  fs.mkdirSync(path.join(HOME, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p1@m': [{ scope: 'user', installPath: plug }] } }));
  // The owner's own skills.txt (no final newline) and an existing ~/.wk.
  fs.mkdirSync(path.join(HOME, '.gemini', 'config'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gemini', 'config', 'skills.txt'), '/owner/own/path');
  fs.mkdirSync(path.join(HOME, '.wk'), { recursive: true });
  const env = { ...process.env, HOME, WK_HOME: path.join(HOME, '.wk'), REPROMPT_SKILL_VAULT_DIR: vault };
  return { HOME, vault, env };
}

// Path -> kind and content (file bytes hash, link target), skipping ~/.wk/backups.
function snapshot(HOME) {
  const out = {};
  const skip = path.join(HOME, '.wk', 'backups');
  (function walk(d) {
    for (const k of fs.readdirSync(d).sort()) {
      const p = path.join(d, k);
      if (p === skip) continue;
      const st = fs.lstatSync(p);
      const rel = path.relative(HOME, p);
      if (st.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(p);
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = 'file:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  })(HOME);
  return out;
}

test('JS gate agrees with the shared vectors', () => {
  for (const c of vectors.cases) assert.equal(gate.isApproved(c.entry), c.approved, JSON.stringify(c.entry));
});

test('JS index gate agrees with the shared skill vectors (slug only, should-fix 4)', () => {
  for (const c of vectors.skill_cases) {
    assert.equal(gate.skillAllowed(c.skill, vectors.skill_sources), c.approved, JSON.stringify(c.skill));
  }
});

test('JS cap agrees with the shared cap vectors: at most 20, own first, synced last (P2-273)', () => {
  assert.equal(gate.MAX_SKILLS, 20);
  for (const c of vectors.cap_cases) {
    const r = gate.capSkills(c.skills, c.max);
    assert.deepEqual(r.kept.map(s => s.id), c.kept);
    assert.deepEqual(r.over.map(s => s.id), c.over);
  }
});

test('exposure keeps at most 20 skills, lists the rest, and expose refuses a 21st (P2-273)', () => {
  const { HOME, vault, env } = makeHome();
  const idx = JSON.parse(fs.readFileSync(path.join(vault, 'index.json'), 'utf8'));
  for (let i = 1; i <= 19; i++) {
    const name = `mine-${String(i).padStart(2, '0')}`;
    idx.skills.push({ id: `local-installed/${name}`, name, description: `${name} skill`, path: skill(path.join(HOME, '.claude', 'skills', name), name), slug: 'local-installed', repo: 'local/claude-skills' });
  }
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify(idx));
  const l = ex.listExposed(env);
  assert.equal(l.count, 20);
  assert.equal(l.max, 20);
  // 20 own (own-a + 19 mine) keep their places; the two synced skills are left out by the cap
  assert.deepEqual(l.capped.map(c => c.id).sort(), ['local-installed/own-b', 'local-installed/own-c']);
  assert.match(l.message, /2 left out by the 20-skill cap \(unexpose one to make room\): own-b, own-c/);
  const r = ex.exposeSkill('g1', env);
  assert.equal(r.ok, false);
  assert.match(r.message, /20 skills are exposed already \(the cap\); unexpose one first/);
  // a freed place goes to the next skill in rank (own-b), so g1 is still over the cap
  assert.equal(ex.unexposeSkill('mine-01', env).ok, true);
  assert.ok(ex.listExposed(env).exposed.some(s => s.id === 'local-installed/own-b'));
  assert.equal(ex.exposeSkill('g1', env).ok, false);
  for (const id of ['own-b', 'own-c']) assert.equal(ex.unexposeSkill(id, env).ok, true);
  assert.equal(ex.listExposed(env).count, 19);
  assert.equal(ex.exposeSkill('g1', env).ok, true);
  const after = ex.listExposed(env);
  assert.equal(after.count, 20);
  assert.ok(after.exposed.some(s => s.id === 'good/g1'));
});

test('the Stop switch: neutral output, code 0, nothing changes', () => {
  const { HOME, env } = makeHome();
  const before = snapshot(HOME);
  const r = ex.cli('install-links', null, { stopped: true, env });
  assert.equal(r.ok, true); assert.equal(r.code, 0); assert.equal(r.stopped, true);
  assert.match(r.message, /Stop switch/);
  assert.deepEqual(snapshot(HOME), before);
});

test('expose refuses a staged source, a bad skill and a link escape; exposes one approved skill', () => {
  const { env } = makeHome();
  const st = ex.exposeSkill('s1', env);
  assert.equal(st.ok, false); assert.match(st.message, /not approved/);
  const bad = ex.exposeSkill('good/bad', env);
  assert.equal(bad.ok, false); assert.match(bad.message, /sanitizer refused/);
  const esc = ex.exposeSkill('good/esc', env);
  assert.equal(esc.ok, false); assert.match(esc.message, /outside/);
  const g = ex.exposeSkill('g1', env);
  assert.equal(g.ok, true, g.message);
  const ids = ex.listExposed(env).exposed.map(s => s.id).sort();
  assert.deepEqual(ids, ['good/g1', 'local-installed/own-a', 'local-installed/own-b', 'local-installed/own-c']);
  assert.equal(ex.unexposeSkill('own-b', env).ok, true);
  assert.equal(ex.unexposeSkill('g1', env).ok, true);
  assert.deepEqual(ex.listExposed(env).exposed.map(s => s.id).sort(), ['local-installed/own-a', 'local-installed/own-c']);
  assert.equal(ex.exposeSkill('own-b', env).ok, true);
  assert.equal(ex.listExposed(env).count, 3);
});

test('install links, skips taken and plugin names, then uninstall leaves HOME byte-identical (backups aside)', () => {
  const { HOME, env } = makeHome();
  ex.exposeSkill('g1', env);
  const before = snapshot(HOME);
  const r = ex.installLinks(env);
  assert.equal(r.ok, true, r.message);
  const exposed = path.join(HOME, '.wk', 'skills-exposed');
  assert.deepEqual(fs.readdirSync(exposed).sort(), ['g1', 'own-a', 'own-b', 'own-c']);
  for (const k of fs.readdirSync(exposed)) assert.ok(fs.lstatSync(path.join(exposed, k)).isSymbolicLink());
  const txt = fs.readFileSync(path.join(HOME, '.gemini', 'config', 'skills.txt'), 'utf8');
  assert.equal(txt, `/owner/own/path\n${exposed}\n`);
  const managed = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'skills', '.wk-managed.json'), 'utf8')).managed;
  // own-b is synced from the owner's Claude account, which Claude Code already loads: no second link.
  // (P2-272: this expectation was ['g1', 'own-b'], which encoded a duplicate of an account skill.)
  assert.deepEqual(managed, ['g1']);
  const skipped = Object.fromEntries(r.claude.skipped.map(s => [s.name, s.reason]));
  assert.match(skipped['own-a'], /already sees it/);
  assert.match(skipped['own-b'], /already loads it \(synced from your Claude account\)/);
  assert.match(skipped['own-c'], /plugin p1@m/);
  assert.throws(() => fs.lstatSync(path.join(HOME, '.claude', 'skills', 'own-b')), { code: 'ENOENT' });
  assert.ok(fs.lstatSync(path.join(HOME, '.claude', 'skills', 'own-a')).isDirectory(), 'the owner folder stays a folder');
  // A live unexpose removes the links in both places.
  ex.unexposeSkill('g1', env);
  assert.ok(!fs.existsSync(path.join(exposed, 'g1')));
  assert.ok(!fs.existsSync(path.join(HOME, '.claude', 'skills', 'g1')));
  ex.exposeSkill('g1', env);
  assert.ok(fs.lstatSync(path.join(HOME, '.claude', 'skills', 'g1')).isSymbolicLink());
  // A second install only refreshes.
  assert.equal(ex.installLinks(env).already, true);
  const u = ex.uninstallLinks(env);
  assert.equal(u.ok, true, u.message);
  assert.deepEqual(snapshot(HOME), before);
  assert.ok(fs.readdirSync(path.join(HOME, '.wk', 'backups', 'skill-links')).length === 1);
  assert.equal(ex.uninstallLinks(env).already, true);
});

test('install into an empty HOME then uninstall leaves it byte-identical too', () => {
  const { HOME, env } = makeHome();
  fs.unlinkSync(path.join(HOME, '.gemini', 'config', 'skills.txt'));
  fs.rmdirSync(path.join(HOME, '.gemini', 'config'));
  const before = snapshot(HOME);
  assert.equal(ex.installLinks(env).ok, true);
  assert.equal(fs.readFileSync(path.join(HOME, '.gemini', 'config', 'skills.txt'), 'utf8'), path.join(HOME, '.wk', 'skills-exposed') + '\n');
  ex.uninstallLinks(env);
  assert.deepEqual(snapshot(HOME), before);
});

test('a link swapped to point outside after expose is refused at install', () => {
  const { HOME, vault, env } = makeHome();
  ex.exposeSkill('g1', env);
  const g1 = path.join(vault, 'repos', 'good', 'skills', 'g1');
  fs.renameSync(g1, g1 + '-moved');
  fs.symlinkSync(path.join(HOME, 'outside-skill'), g1);
  const r = ex.installLinks(env);
  assert.ok(r.refused.some(x => x.id === 'good/g1' && /outside/.test(x.reason)));
  assert.ok(!fs.existsSync(path.join(HOME, '.wk', 'skills-exposed', 'g1')));
  ex.uninstallLinks(env);
});

test('synced skills without an open licence are withheld: not exposed, not linked, expose refuses them (P2-272)', () => {
  const { HOME, vault, env } = makeHome();
  const syn = path.join(HOME, '.claude', 'skills', 'synced', 'u3');
  const idx = JSON.parse(fs.readFileSync(path.join(vault, 'index.json'), 'utf8'));
  for (const name of ['own-r', 'own-n', 'own-m']) {
    idx.skills.push({ id: `local-installed/${name}`, name, description: `${name} skill`, path: skill(path.join(syn, name), name), slug: 'local-installed', repo: 'local/claude-skills' });
  }
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify(idx));
  // Anthropic's own licence (as on a synced computer-use skill), no licence file at all, and MIT.
  fs.writeFileSync(path.join(syn, 'own-r', 'LICENSE.txt'), '© 2025 Anthropic, PBC. All rights reserved.\n\nLICENSE: Use of these materials is governed by your agreement with Anthropic.\nUsers may not: Extract these materials from the Services or retain copies outside the Services.\n');
  fs.writeFileSync(path.join(syn, 'own-m', 'LICENSE'), 'The MIT License (MIT)\n\nCopyright (c) 2025 Someone\n');
  assert.equal(ex.licenceOf(path.join(syn, 'own-r')), 'restricted');
  assert.equal(ex.licenceOf(path.join(syn, 'own-n')), 'none');
  assert.equal(ex.licenceOf(path.join(syn, 'own-m')), 'open');
  assert.equal(ex.licenceOf(path.join(HOME, '.claude', 'skills', 'synced', 'u1', 'own-b')), 'open');

  const l = ex.listExposed(env);
  assert.deepEqual(l.exposed.map(s => s.id).sort(), ['local-installed/own-a', 'local-installed/own-b', 'local-installed/own-c', 'local-installed/own-m']);
  assert.deepEqual(l.withheld.map(w => `${w.id}:${w.licence}`).sort(), ['local-installed/own-n:none', 'local-installed/own-r:restricted']);
  assert.match(l.message, /2 withheld \(synced from your Claude account, no open licence\): .*own-r/);
  assert.match(l.message, /own-n/);
  assert.match(ex.exposeSkill('own-r', env).message, /not exposed: .*synced from your Claude account and Anthropic's own licence/);
  assert.match(ex.exposeSkill('own-n', env).message, /not exposed: .*synced from your Claude account and it has no licence file/);
  assert.equal(ex.exposeSkill('own-r', env).ok, false);

  const before = snapshot(HOME);
  const r = ex.installLinks(env);
  assert.equal(r.ok, true, r.message);
  const exposedDir = path.join(HOME, '.wk', 'skills-exposed');
  assert.deepEqual(fs.readdirSync(exposedDir).sort(), ['own-a', 'own-b', 'own-c', 'own-m']);
  const claude = path.join(HOME, '.claude', 'skills');
  for (const name of ['own-b', 'own-m', 'own-n', 'own-r']) {
    assert.throws(() => fs.lstatSync(path.join(claude, name)), { code: 'ENOENT' }, `no Claude link for ${name}`);
  }
  // A Claude link to a synced skill left by an older version goes at the next refresh.
  fs.symlinkSync(path.join(exposedDir, 'own-b'), path.join(claude, 'own-b'));
  const mf = path.join(claude, '.wk-managed.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  fs.writeFileSync(mf, JSON.stringify({ ...m, managed: [...m.managed, 'own-b'].sort() }));
  assert.equal(ex.installLinks(env).already, true);
  assert.throws(() => fs.lstatSync(path.join(claude, 'own-b')), { code: 'ENOENT' });
  assert.ok(!JSON.parse(fs.readFileSync(mf, 'utf8')).managed.includes('own-b'));
  assert.equal(ex.uninstallLinks(env).ok, true);
  assert.deepEqual(snapshot(HOME), before);
});
