// The Antigravity plugin (P2-223): its parts, the install into a temp home, status, the dry run and the backup.
// A temp HOME and WK_HOME for every test; the real ~/.gemini and ~/.wk are never touched; nothing runs agy.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const SRC = path.join(root, 'antigravity', 'plugins', 'watchkeeper');
const front = s => { const m = /^---\n([\s\S]*?)\n---\n/.exec(s); assert.ok(m, 'front matter'); return Object.fromEntries(m[1].split('\n').filter(l => /^[a-zA-Z]+:/.test(l)).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim().replace(/^"(.*)"$/, '$1')])); };
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]).sort();

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-agy-')), home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_NODE: process.execPath };
  delete env.CLAUDE_PLUGIN_ROOT;
  const run = (bin, args) => spawnSync(process.execPath, [path.join(root, 'bin', bin), ...args], { cwd: base, env, encoding: 'utf8' });
  return { base, home, run, target: path.join(home, '.gemini', 'config', 'plugins', 'watchkeeper') };
}

test('the plugin source: one version, the named parts, valid front matter', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8'));
  assert.equal(pj.name, 'watchkeeper');
  assert.equal(pj.version, JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version, 'the plugin version follows Watchkeeper');
  assert.deepEqual(walk(SRC), [
    'agents/wk-builder.md', 'agents/wk-reviewer.md', 'agents/wk-scout.md',
    'assets/logo.svg',
    'hooks.json', 'mcp_config.json', 'plugin.json',
    'rules/graphify.md', 'rules/re-prompt.md', 'rules/watchkeeper.md',
    'skills/ask-claude/SKILL.md', 'skills/duo-orchestrator/SKILL.md',
    'skills/graphify/SKILL.md',
    'skills/graphify/references/add-watch.md', 'skills/graphify/references/exports.md',
    'skills/graphify/references/extraction-spec.md', 'skills/graphify/references/github-and-merge.md',
    'skills/graphify/references/hooks.md', 'skills/graphify/references/query.md',
    'skills/graphify/references/transcribe.md', 'skills/graphify/references/update.md',
    'skills/profession-skill-vault/SKILL.md', 'skills/re-prompt/SKILL.md',
    'skills/wk-add-task/SKILL.md', 'skills/wk-status/SKILL.md',
    'skills/wk-suggest/SKILL.md', 'skills/wk-take-task/SKILL.md', 'skills/wk/SKILL.md',
  ]);
  assert.equal(pj.logo, 'assets/logo.svg');
  assert.ok(Array.isArray(pj.suggestedPrompts) && pj.suggestedPrompts.length >= 3);
  for (const s of ['ask-claude', 'duo-orchestrator', 'graphify', 'profession-skill-vault', 're-prompt', 'wk', 'wk-add-task', 'wk-status', 'wk-suggest', 'wk-take-task']) {
    const f = front(fs.readFileSync(path.join(SRC, 'skills', s, 'SKILL.md'), 'utf8'));
    assert.equal(f.name, s, 'a skill name matches its folder'); assert.ok(f.description, `${s} has a description`);
  }
  const models = { 'wk-scout': 'flash', 'wk-builder': 'pro', 'wk-reviewer': 'pro' };
  for (const [a, m] of Object.entries(models)) {
    const f = front(fs.readFileSync(path.join(SRC, 'agents', `${a}.md`), 'utf8'));
    assert.equal(f.name, a); assert.equal(f.model, m); assert.ok(['off', 'auto', 'eager', 'sandbox'].includes(f.commandExecutionPolicy), a);
  }
  assert.equal(front(fs.readFileSync(path.join(SRC, 'agents', 'wk-scout.md'), 'utf8')).commandExecutionPolicy, 'off', 'the scout runs no commands');
  assert.equal(front(fs.readFileSync(path.join(SRC, 'agents', 'wk-reviewer.md'), 'utf8')).commandExecutionPolicy, 'off', 'the reviewer runs no commands');
  assert.equal(front(fs.readFileSync(path.join(SRC, 'rules', 'watchkeeper.md'), 'utf8')).trigger, 'always_on');
  assert.equal(front(fs.readFileSync(path.join(SRC, 'rules', 'graphify.md'), 'utf8')).trigger, 'always_on');
  assert.equal(front(fs.readFileSync(path.join(SRC, 'rules', 're-prompt.md'), 'utf8')).trigger, 'always_on');
  const rules = fs.readFileSync(path.join(SRC, 'rules', 'watchkeeper.md'), 'utf8');
  assert.match(rules, /[Nn]ever push/);
  const hooks = JSON.parse(fs.readFileSync(path.join(SRC, 'hooks.json'), 'utf8'));
  assert.equal(hooks.watchkeeper.enabled, true);
  assert.equal(hooks.watchkeeper.PreToolUse[0].matcher, '', 'every tool reaches the guard (hooks.md: "" matches all tools)');
  assert.equal(hooks.watchkeeper.PreToolUse[0].hooks[0].timeout, 30, 'the hook may take 30 s');
  assert.equal(hooks['reprompt-inline-prefix'].PreInvocation[0].type, 'command');
  assert.equal(hooks['reprompt-skill-router'].PreInvocation[0].type, 'command');
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(SRC, 'mcp_config.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers['re-prompt'].command, '{{PYTHON}}');
  assert.equal(mcpCfg.mcpServers['re-prompt'].args[0], '{{WK_REPROMPT_DIR}}/server/reprompt_mcp_server.py');
  assert.match(fs.readFileSync(path.join(root, 'bin', 'wk-guard-agy.mjs'), 'utf8'), /timeout: 8000,/, "the guard's own limit is well inside it, so a slow guard is a deny");
  assert.match(fs.readFileSync(path.join(SRC, 'skills', 'wk-add-task', 'SKILL.md'), 'utf8'), /cannot set a test|can't set a test|no --test/i);
  for (const f of walk(SRC)) for (const line of fs.readFileSync(path.join(SRC, f), 'utf8').split('\n')) assert.ok(!/\bagy (run|chat|exec)\b/.test(line) && (!line.includes('--dangerously-skip-permissions') || /\b[Nn]ever\b/.test(line)), `${f} never runs agy or skips permissions: ${line}`);   // only a "never" line may name the flag
});

test('install into a temp home: every part, absolute paths, no placeholder left, hooks.json valid', () => {
  const s = sandbox();
  const dry = s.run('wk-antigravity.mjs', ['install', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /would be installed: ~\/\.gemini\/config\/plugins\/watchkeeper \(28 files\)/);
  assert.ok(!fs.existsSync(s.target), 'a dry run writes nothing');
  const st0 = JSON.parse(s.run('wk-antigravity.mjs', ['status', '--json']).stdout); assert.equal(st0.installed, false);
  assert.match(s.run('wk-antigravity.mjs', ['status']).stdout, /Not installed/);
  const r = s.run('wk-antigravity.mjs', ['install']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /installed: ~\/\.gemini\/config\/plugins\/watchkeeper \(28 files\)\./); assert.match(r.stdout, /next conversation/);
  assert.deepEqual(walk(s.target), walk(SRC));
  for (const f of walk(s.target)) assert.ok(!fs.readFileSync(path.join(s.target, f), 'utf8').includes('{{'), `${f} has a placeholder left`);
  const bin = path.join(root, 'bin');
  const hooks = JSON.parse(fs.readFileSync(path.join(s.target, 'hooks.json'), 'utf8'));
  const cmds = [hooks.watchkeeper.PreToolUse[0].hooks[0].command, hooks.watchkeeper.Stop[0].command];
  const scripts = ['wk-guard-agy.mjs', 'wk-gemini-log.mjs'];
  cmds.forEach((c, i) => {
    const parts = [...c.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.equal(parts.length, 2, c); assert.equal(parts[0], process.execPath); assert.equal(parts[1], path.join(bin, scripts[i]));
    assert.ok(path.isAbsolute(parts[1]) && fs.existsSync(parts[1]), 'the hook script exists');
  });
  for (const [hookKey, expectedRel] of [
    ['reprompt-inline-prefix', path.join('reprompt', 'scripts', 'reprompt_inline_hook.py')],
    ['reprompt-skill-router', path.join('reprompt', 'scripts', 'reprompt_skill_hook.py')],
  ]) {
    const cmd = hooks[hookKey].PreInvocation[0].command;
    const parts = [...cmd.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.equal(parts.length, 2, cmd);
    assert.equal(parts[1], path.join(root, expectedRel));
    assert.ok(fs.existsSync(parts[1]), `${expectedRel} exists`);
  }
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(s.target, 'mcp_config.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers['re-prompt'].args[0], path.join(root, 'reprompt', 'server', 'reprompt_mcp_server.py'));
  assert.ok(fs.existsSync(mcpCfg.mcpServers['re-prompt'].args[0]), 'mcp server exists');
  // the hook command really runs and answers as Antigravity expects
  const hookRun = spawnSync(cmds[0].match(/"([^"]+)"/g).map(x => x.slice(1, -1))[0], [cmds[0].match(/"([^"]+)"/g)[1].slice(1, -1)], { cwd: s.target, env: { ...process.env, HOME: s.home, WK_HOME: path.join(s.home, '.wk') }, input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } }, workspacePaths: [s.base], cwd: path.join(s.home, '.wk', 'worktrees', 't') }), encoding: 'utf8' });   // Watchkeeper work: a cwd in a worktree
  assert.equal(hookRun.status, 0); assert.equal(JSON.parse(hookRun.stdout).decision, 'deny');
  const take = fs.readFileSync(path.join(s.target, 'skills', 'wk-take-task', 'SKILL.md'), 'utf8');
  assert.ok(take.includes(`"${process.execPath}" "${path.join(bin, 'wk-task.mjs')}" take`), 'the skill names the absolute command');
  assert.ok(fs.readFileSync(path.join(s.target, 'skills', 'ask-claude', 'SKILL.md'), 'utf8').includes(path.join(bin, 'wk-ask-claude.mjs')), 'ask-claude still points at wk-ask-claude');
  assert.equal(fs.readFileSync(path.join(s.target, 'skills', 'ask-claude', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(SRC, 'skills', 'ask-claude', 'SKILL.md'), 'utf8').split('{{NODE}}').join(process.execPath).split('{{WK_BIN}}').join(path.join(bin, 'wk-ask-claude.mjs')), 'ask-claude unchanged apart from its paths');
  const st = JSON.parse(s.run('wk-antigravity.mjs', ['status', '--json']).stdout);
  assert.deepEqual({ ...st, target: 'x' }, { target: 'x', installed: true, current: true, self_contained: false, version: st.source_version, source_version: st.source_version,
    skills: ['ask-claude', 'duo-orchestrator', 'graphify', 'profession-skill-vault', 're-prompt', 'wk', 'wk-add-task', 'wk-status', 'wk-suggest', 'wk-take-task'], agents: ['wk-builder', 'wk-reviewer', 'wk-scout'], rules: ['graphify.md', 're-prompt.md', 'watchkeeper.md'], hooks: true, mcp: true, pass: st.pass });
  assert.equal(st.pass.pass, 'ask', 'no Antigravity settings in this home: ask'); assert.equal(st.pass.source, 'detected');
  assert.match(s.run('wk-antigravity.mjs', ['status']).stdout, /up to date/);
  assert.match(s.run('wk-antigravity.mjs', ['install']).stdout, /already up to date/);
  assert.ok(!fs.existsSync(path.join(s.home, '.wk', 'backups')), 'no backup when nothing changes');
});

test('an older copy is backed up before an update; the old install command does the same', () => {
  const s = sandbox();
  assert.equal(s.run('wk-ask-claude.mjs', ['install-antigravity']).status, 0, 'the ask-claude install command installs the whole plugin');
  assert.deepEqual(walk(s.target), walk(SRC));
  fs.writeFileSync(path.join(s.target, 'skills', 'wk-suggest', 'SKILL.md'), 'edited by hand\n');
  fs.writeFileSync(path.join(s.target, 'extra.txt'), 'mine\n');
  const st = JSON.parse(s.run('wk-antigravity.mjs', ['status', '--json']).stdout); assert.equal(st.current, false);
  assert.match(s.run('wk-antigravity.mjs', ['status']).stdout, /differs: run install to update/);
  assert.match(s.run('wk-antigravity.mjs', ['install', '--dry-run']).stdout, /would be updated/);
  assert.equal(fs.readFileSync(path.join(s.target, 'skills', 'wk-suggest', 'SKILL.md'), 'utf8'), 'edited by hand\n', 'the dry run changes nothing');
  const up = s.run('wk-antigravity.mjs', ['install', '--json']); const r = JSON.parse(up.stdout);
  assert.equal(r.state, 'updated'); assert.ok(r.backup.startsWith(path.join(s.home, '.wk', 'backups', 'antigravity-plugin-')));
  assert.equal(fs.readFileSync(path.join(r.backup, 'skills', 'wk-suggest', 'SKILL.md'), 'utf8'), 'edited by hand\n');
  assert.equal(fs.readFileSync(path.join(r.backup, 'extra.txt'), 'utf8'), 'mine\n');
  assert.ok(!fs.existsSync(path.join(s.target, 'extra.txt')));
  assert.equal(JSON.parse(s.run('wk-antigravity.mjs', ['status', '--json']).stdout).current, true);
  // --dest is honoured; bad options are refused plainly
  const dest = path.join(s.base, 'plugins');
  assert.equal(s.run('wk-antigravity.mjs', ['install', '--dest', dest]).status, 0); assert.ok(fs.existsSync(path.join(dest, 'watchkeeper', 'hooks.json')));
  const bad = s.run('wk-antigravity.mjs', ['install', '--force']); assert.equal(bad.status, 1); assert.match(bad.stderr, /unknown option --force/);
  assert.equal(s.run('wk-antigravity.mjs', []).status, 2);
});

test('S1: install detects the pass decision from three Antigravity keys only, per machine, in a temp home', () => {
  const s = sandbox();
  const cfg = path.join(s.home, '.gemini', 'config', 'config.json'), hookFile = path.join(s.home, '.wk', 'antigravity-hook.json');
  const setCfg = text => { fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, text); };
  const install = (...more) => { const r = s.run('wk-antigravity.mjs', ['install', ...more]); assert.equal(r.status, 0, r.stderr); return { out: r.stdout, row: JSON.parse(fs.readFileSync(hookFile, 'utf8')) }; };
  const TURBO = 'AGENT_PERMISSION_PRESET_TURBO', EAGER = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER', BROWSER = 'BROWSER_JS_EXECUTION_POLICY_TURBO';
  // a dry run writes no decision
  assert.equal(s.run('wk-antigravity.mjs', ['install', '--dry-run']).status, 0); assert.ok(!fs.existsSync(hookFile));
  // missing settings file: ask
  let r = install(); assert.equal(r.row.pass, 'ask'); assert.equal(r.row.source, 'detected'); assert.equal(r.row.preset, null);
  assert.match(r.out, /Pass decision: ask/);
  assert.equal((fs.statSync(hookFile).mode & 0o777).toString(8), '600');
  // the Turbo preset, eager commands and Turbo browser scripts: allow; only the three keys are kept, nothing else of the file
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER, browserJsExecutionPolicy: BROWSER, accountEmail: 'owner@example.com', token: 'not-for-us' }, auth: { refresh: 'secret-refresh-value' } }));
  r = install();
  assert.deepEqual(Object.keys(r.row), ['pass', 'preset', 'policy', 'browser_policy', 'detected_at', 'source']);
  assert.deepEqual([r.row.pass, r.row.preset, r.row.policy, r.row.browser_policy, r.row.source], ['allow', TURBO, EAGER, BROWSER, 'detected']); assert.ok(!isNaN(Date.parse(r.row.detected_at)));
  const raw = fs.readFileSync(hookFile, 'utf8'); for (const x of ['owner@example.com', 'not-for-us', 'secret-refresh-value']) assert.ok(!raw.includes(x), `${x} is not kept`);
  assert.ok(!r.out.includes('owner@example.com') && !r.out.includes('secret-refresh-value'), 'nothing else is printed');
  assert.match(r.out, /Pass decision: allow: Antigravity runs Gemini's steps without asking you \(your Antigravity uses the Turbo preset, eager commands and Turbo browser scripts\)/);
  // another preset, eager alone, the third key missing or different, bad JSON: ask
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER } })); r = install(); assert.equal(r.row.pass, 'ask', 'the browser key missing'); assert.equal(r.row.browser_policy, null);
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER, browserJsExecutionPolicy: 'BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK' } })); assert.equal(install().row.pass, 'ask');
  setCfg(JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_DEFAULT', autoExecutionPolicy: EAGER, browserJsExecutionPolicy: BROWSER } })); assert.equal(install().row.pass, 'ask');
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF', browserJsExecutionPolicy: BROWSER } })); assert.equal(install().row.pass, 'ask');
  setCfg('{ not json'); r = install(); assert.equal(r.row.pass, 'ask'); assert.equal(r.row.preset, null);
  // the flag wins, and stays until --pass detect
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER, browserJsExecutionPolicy: BROWSER } }));
  r = install('--pass', 'ask'); assert.deepEqual([r.row.pass, r.row.source], ['ask', 'flag']); assert.match(r.out, /you set it with --pass/);
  assert.equal(install().row.pass, 'ask', 'an update keeps a choice made by hand');
  assert.equal(s.run('wk-ask-claude.mjs', ['install-antigravity']).status, 0); assert.equal(JSON.parse(fs.readFileSync(hookFile, 'utf8')).pass, 'ask');
  r = install('--pass', 'detect'); assert.deepEqual([r.row.pass, r.row.source], ['allow', 'detected']);
  setCfg(JSON.stringify({ userSettings: {} })); r = install('--pass', 'allow'); assert.deepEqual([r.row.pass, r.row.source], ['allow', 'flag']);
  const bad = s.run('wk-antigravity.mjs', ['install', '--pass', 'yes']); assert.equal(bad.status, 1); assert.match(bad.stderr, /--pass must be allow, ask or detect/);
  // status says it in plain words; the JSON carries the row
  assert.match(s.run('wk-antigravity.mjs', ['status']).stdout, /Pass decision: allow: .*\(you set it with --pass\)\. In the conversations that do Watchkeeper work, Watchkeeper still blocks secrets, pushes, and every step while the kill switch.*Your own chats get only this decision\./);
  assert.equal(JSON.parse(s.run('wk-antigravity.mjs', ['status', '--json']).stdout).pass.pass, 'allow');
  fs.rmSync(hookFile); assert.match(s.run('wk-antigravity.mjs', ['status']).stdout, /Pass decision: not set on this machine yet/);
  // the hook follows the file
  const hook = (name, args) => JSON.parse(spawnSync(process.execPath, [path.join(root, 'bin', 'wk-guard-agy.mjs')], { env: { ...process.env, HOME: s.home, WK_HOME: path.join(s.home, '.wk'), CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8',
    input: JSON.stringify({ toolCall: { name, args }, workspacePaths: [s.base], cwd: s.base }) }).stdout).decision;
  assert.equal(hook('view_file', { AbsolutePath: path.join(s.base, 'x.js') }), 'ask', 'no file: config/gemini.json says ask');
  // no file (the self-contained marketplace plugin has no install step): your own chats follow the three settings at each call
  const TURBO_CFG = JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER, browserJsExecutionPolicy: BROWSER } });
  assert.equal(hook('read_url_content', { Url: 'example.com' }), 'ask', 'no file, no Turbo: ask');
  setCfg(TURBO_CFG); assert.ok(!fs.existsSync(hookFile));
  assert.equal(hook('read_url_content', { Url: 'example.com' }), 'allow', 'no file, Turbo: allow in your own chat');
  assert.equal(hook('read_url_content', { Url: 'example.com', Cwd: path.join(s.home, '.wk', 'worktrees', 't') }), 'ask', 'no file, Turbo: Watchkeeper work still gets ask for an unknown tool');
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER } })); assert.equal(hook('read_url_content', { Url: 'example.com' }), 'ask', 'no file, two of three keys: ask');
  setCfg(JSON.stringify({ userSettings: {} }));
  setCfg(JSON.stringify({ userSettings: { permissionPreset: TURBO, autoExecutionPolicy: EAGER, browserJsExecutionPolicy: BROWSER } })); install();
  assert.equal(hook('view_file', { AbsolutePath: path.join(s.base, 'x.js') }), 'allow');
  assert.equal(hook('read_url_content', { Url: 'example.com' }), 'allow', 'the user\'s own chat: every tool gets the pass decision');
  assert.equal(hook('read_url_content', { Url: 'example.com', Cwd: path.join(s.home, '.wk', 'worktrees', 't') }), 'ask', 'Watchkeeper work: an unknown tool gets ask');
});

test('standalone ~/.gemini/config/skills/graphify and rules/graphify.md are backed up and removed on install', () => {
  const s = sandbox();
  const looseSkill = path.join(s.home, '.gemini', 'config', 'skills', 'graphify');
  const looseRule = path.join(s.home, '.gemini', 'config', 'rules', 'graphify.md');
  fs.mkdirSync(looseSkill, { recursive: true });
  fs.writeFileSync(path.join(looseSkill, 'SKILL.md'), 'old loose skill\n');
  fs.mkdirSync(path.dirname(looseRule), { recursive: true });
  fs.writeFileSync(looseRule, 'old loose rule\n');
  const r = s.run('wk-antigravity.mjs', ['install', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.state, 'installed');
  assert.equal(res.removedDuplicates.length, 2);
  assert.ok(!fs.existsSync(looseSkill), 'loose standalone graphify skill removed');
  assert.ok(!fs.existsSync(looseRule), 'loose standalone graphify rule removed');
  const backups = fs.readdirSync(path.join(s.home, '.wk', 'backups')).filter(f => f.startsWith('antigravity-graphify-'));
  assert.equal(backups.length, 1);
  const bk = path.join(s.home, '.wk', 'backups', backups[0]);
  assert.equal(fs.readFileSync(path.join(bk, 'skills', 'graphify', 'SKILL.md'), 'utf8'), 'old loose skill\n');
  assert.equal(fs.readFileSync(path.join(bk, 'rules', 'graphify.md'), 'utf8'), 'old loose rule\n');
});

test('standalone ~/.gemini/config/plugins/re-prompt and loose re-prompt skills are backed up and removed on install', () => {
  const s = sandbox();
  const cfgRoot = path.join(s.home, '.gemini', 'config');
  const oldPlugin = path.join(cfgRoot, 'plugins', 're-prompt');
  const oldSkill = path.join(cfgRoot, 'skills', 're-prompt');
  const oldOrch = path.join(cfgRoot, 'skills', 'duo-orchestrator');
  fs.mkdirSync(oldPlugin, { recursive: true });
  fs.writeFileSync(path.join(oldPlugin, 'plugin.json'), '{"name":"re-prompt"}\n');
  fs.mkdirSync(oldSkill, { recursive: true });
  fs.writeFileSync(path.join(oldSkill, 'SKILL.md'), 'old loose reprompt skill\n');
  fs.mkdirSync(oldOrch, { recursive: true });
  fs.writeFileSync(path.join(oldOrch, 'SKILL.md'), 'old loose orch skill\n');
  const r = s.run('wk-antigravity.mjs', ['install', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.removedDuplicates.length, 3);
  assert.ok(!fs.existsSync(oldPlugin), 'standalone re-prompt plugin removed');
  assert.ok(!fs.existsSync(oldSkill), 'loose re-prompt skill removed');
  assert.ok(!fs.existsSync(oldOrch), 'loose duo-orchestrator skill removed');
  const backups = fs.readdirSync(path.join(s.home, '.wk', 'backups')).filter(f => f.startsWith('antigravity-reprompt-'));
  assert.equal(backups.length, 1);
  const bk = path.join(s.home, '.wk', 'backups', backups[0]);
  assert.equal(fs.readFileSync(path.join(bk, 'plugins', 're-prompt', 'plugin.json'), 'utf8'), '{"name":"re-prompt"}\n');
  assert.equal(fs.readFileSync(path.join(bk, 'skills', 're-prompt', 'SKILL.md'), 'utf8'), 'old loose reprompt skill\n');
});
