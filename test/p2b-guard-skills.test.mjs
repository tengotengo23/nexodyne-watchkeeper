// P2-272 (B): in the lane, read-only tools may read the exposed skills (~/.wk/skills-exposed) and the skill vault
// (~/.gemini/skill-vault); writes there stay blocked; a link inside them that points elsewhere counts as elsewhere.
// Every case runs in a fresh mkdtemp HOME; the owner's real folders are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'config', 'gates.json'))).digest('hex');

function setup() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-guard-'));
  const snap = path.join(HOME, 'snap'); fs.mkdirSync(snap);
  const wk = path.join(HOME, '.wk'); const exposed = path.join(wk, 'skills-exposed');
  const vault = path.join(HOME, '.gemini', 'skill-vault');
  const sk = path.join(vault, 'repos', 'good', 'skills', 'g1');
  fs.mkdirSync(sk, { recursive: true }); fs.mkdirSync(exposed, { recursive: true });
  fs.writeFileSync(path.join(sk, 'SKILL.md'), '# g1\n## Use\nPlain words.\n');
  fs.symlinkSync(sk, path.join(exposed, 'g1'));
  const outside = path.join(HOME, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '# esc\n');
  fs.symlinkSync(outside, path.join(exposed, 'esc'));
  fs.symlinkSync(outside, path.join(sk, 'esc'));
  // P2-272 B-fix, should-fix 6: the lane reads only approved repos, so the fixture approves 'good' as the panel would.
  // A staged repo sits beside it with a link in the exposed folder, as a stale link would after a reject.
  const staged = path.join(vault, 'repos', 'staged', 'skills', 's1'); fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'SKILL.md'), '# s1\n');
  fs.symlinkSync(staged, path.join(exposed, 's1'));
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', url: 'https://github.com/o/good.git', approved: true },
    { slug: 'staged', repo: 'o/staged', url: 'https://github.com/o/staged.git', approved: false, staged: true }] }));
  const env = { ...process.env, HOME, WK_HOME: wk, REPROMPT_SKILL_VAULT_DIR: vault, WK_LANE: '1', WK_LANE_ROOTS: snap,
    WK_POLICY_SHA256: PIN, CLAUDE_PROJECT_DIR: snap, CLAUDE_PLUGIN_ROOT: ROOT };
  delete env.WK_LANE_PIN_OVERRIDE;
  return { HOME, snap, wk, exposed, vault, sk, staged, outside, env };
}

const guard = (env, tool_name, tool_input) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-guard.mjs')],
  { cwd: env.CLAUDE_PROJECT_DIR, env, input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8', timeout: 15000 });
const agy = (env, name, args, cwd) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-guard-agy.mjs')],
    { cwd: ROOT, env, input: JSON.stringify({ toolCall: { name, args }, cwd }), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).decision;
};
// A pass is the machine's own pass decision (allow or ask, from config); what matters here is "not deny".
const passes = d => ['allow', 'ask'].includes(d);

test('Claude lane: read allowed in both skill folders, write denied, link escape denied', () => {
  const t = setup();
  const exposedSkill = path.join(t.exposed, 'g1', 'SKILL.md');
  const vaultSkill = path.join(t.sk, 'SKILL.md');
  assert.equal(guard(t.env, 'Read', { file_path: exposedSkill }).status, 0, 'read through the exposed link');
  assert.equal(guard(t.env, 'Read', { file_path: vaultSkill }).status, 0, 'read in the vault');
  assert.equal(guard(t.env, 'Grep', { pattern: 'Use', path: t.sk }).status, 0, 'search in the vault');
  assert.equal(guard(t.env, 'Bash', { command: `cat ${vaultSkill}` }).status, 0, 'cat in the vault');
  for (const [tool, input] of [['Write', { file_path: vaultSkill, content: 'x' }], ['Edit', { file_path: exposedSkill, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: vaultSkill, edits: [{ old_string: 'a', new_string: 'b' }] }]]) {
    const r = guard(t.env, tool, input);
    assert.equal(r.status, 2, `${tool} must be blocked`);
    assert.match(r.stderr, /read-only/);
  }
  for (const p of [path.join(t.exposed, 'esc', 'SKILL.md'), path.join(t.sk, 'esc', 'SKILL.md'), path.join(t.outside, 'SKILL.md')]) {
    assert.equal(guard(t.env, 'Read', { file_path: p }).status, 2, `escape ${p}`);
  }
  assert.equal(guard(t.env, 'Bash', { command: `cat ${path.join(t.exposed, 'esc', 'SKILL.md')}` }).status, 2, 'cat through an escape link');
  assert.equal(fs.readFileSync(vaultSkill, 'utf8'), '# g1\n## Use\nPlain words.\n');
});

test('Outside the lane the skill folders get no new allowance (the guard is unchanged there)', () => {
  const t = setup();
  const env = { ...t.env }; delete env.WK_LANE; delete env.WK_LANE_ROOTS;
  // No lane: the ordinary rules apply; a read of a skill is allowed as before.
  assert.equal(guard(env, 'Read', { file_path: path.join(t.sk, 'SKILL.md') }).status, 0);
});

test('Antigravity: view allowed, write denied in the vault and the exposed folder, link escape denied (lane)', () => {
  const t = setup();
  const wt = path.join(t.wk, 'worktrees', 't1'); fs.mkdirSync(wt, { recursive: true });
  const vaultSkill = path.join(t.sk, 'SKILL.md');
  assert.ok(passes(agy(t.env, 'view_file', { AbsolutePath: vaultSkill }, wt)));
  assert.ok(passes(agy(t.env, 'view_file', { AbsolutePath: path.join(t.exposed, 'g1', 'SKILL.md') }, wt)));
  assert.ok(passes(agy(t.env, 'list_dir', { DirectoryPath: t.sk }, wt)));
  assert.equal(agy(t.env, 'write_to_file', { TargetFile: vaultSkill, CodeContent: 'x' }, wt), 'deny');
  assert.equal(agy(t.env, 'replace_file_content', { TargetFile: path.join(t.exposed, 'g1', 'SKILL.md'), ReplacementContent: 'x' }, wt), 'deny');
  assert.equal(agy(t.env, 'view_file', { AbsolutePath: path.join(t.exposed, 'esc', 'SKILL.md') }, wt), 'deny');
  assert.equal(agy(t.env, 'view_file', { AbsolutePath: path.join(t.sk, 'esc', 'SKILL.md') }, wt), 'deny');
  // A guarded conversation outside the lane still never writes into the vault.
  const env = { ...t.env }; delete env.WK_LANE; delete env.WK_LANE_ROOTS;
  assert.equal(agy(env, 'write_to_file', { TargetFile: vaultSkill, CodeContent: 'x' }, wt), 'deny');
  assert.equal(fs.readFileSync(vaultSkill, 'utf8'), '# g1\n## Use\nPlain words.\n');
});

test('Lane: staged repos stay closed, also through an exposed link; approved repos and local skills\' real roots are readable (should-fix 6)', () => {
  const t = setup();
  const stagedSkill = path.join(t.staged, 'SKILL.md');
  assert.equal(guard(t.env, 'Read', { file_path: stagedSkill }).status, 2, 'read in a staged repo');
  assert.equal(guard(t.env, 'Read', { file_path: path.join(t.exposed, 's1', 'SKILL.md') }).status, 2, 'read through a stale exposed link');
  assert.equal(guard(t.env, 'Bash', { command: `cat ${stagedSkill}` }).status, 2, 'cat in a staged repo');
  assert.equal(guard(t.env, 'Grep', { pattern: 's1', path: path.join(t.vault, 'repos', 'staged') }).status, 2, 'search a staged repo');
  assert.equal(guard(t.env, 'Read', { file_path: path.join(t.sk, 'SKILL.md') }).status, 0, 'approved repo stays readable');
  // A local skill under ~/.claude/skills that is a link to the owner's own checkout: its real folder is readable.
  const real = path.join(t.HOME, 'checkout', 'my-skill'); fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'SKILL.md'), '# mine\n');
  const own = path.join(t.HOME, '.claude', 'skills'); fs.mkdirSync(own, { recursive: true });
  fs.symlinkSync(real, path.join(own, 'my-skill'));
  assert.equal(guard(t.env, 'Read', { file_path: path.join(own, 'my-skill', 'SKILL.md') }).status, 0, 'local skill through its link');
  assert.equal(guard(t.env, 'Read', { file_path: path.join(real, 'SKILL.md') }).status, 0, 'local skill at its real root');
  assert.equal(guard(t.env, 'Write', { file_path: path.join(real, 'SKILL.md'), content: 'x' }).status, 2, 'local real root stays read-only');
  // Unapproving 'good' closes it at once (the gate reads sources.json on every call).
  fs.writeFileSync(path.join(t.vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', url: 'https://github.com/o/good.git', approved: false }] }));
  assert.equal(guard(t.env, 'Read', { file_path: path.join(t.sk, 'SKILL.md') }).status, 2, 'rejected repo closes');
  assert.equal(agy(t.env, 'view_file', { AbsolutePath: stagedSkill }, path.join(t.wk, 'worktrees', 't1')), 'deny');
});
