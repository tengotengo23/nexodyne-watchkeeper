// P2-275: the self-contained Antigravity plugin for the marketplace (bin/antigravity-bundle.mjs, `wk-antigravity bundle`).
// Built into a temp folder from this checkout, then run the way Antigravity runs it: hooks through `sh -c` in the plugin
// folder with PLUGIN_ROOT and PLUGIN_DATA set, the MCP server through sh, the bin/ tools by path and through a symlink.
// A temp HOME and WK_HOME for every run; the real ~/.gemini and ~/.wk are never touched; nothing here runs agy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hookCommand, renderMcp, renderMarkdown, checkBundle, TOOLS } from '../bin/antigravity-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-agy-bundle-'));
const out = path.join(base, 'out'), home = path.join(base, 'home'), proj = path.join(base, 'proj'), data = path.join(base, 'data');
for (const d of [out, home, proj, data]) fs.mkdirSync(d, { recursive: true });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WK_|CLAUDE_|PLUGIN_|REPROMPT_|NODE_TEST|NODE_OPTIONS$)/.test(k)));
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'bin', 'wk-antigravity.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...cleanEnv(), HOME: home, ...env } });

const built = cli(['bundle', '--out', out, '--zip', '--json']);
const res = built.status === 0 ? JSON.parse(built.stdout) : null;
const dest = path.join(out, 'watchkeeper');
const hookEnv = (more = {}) => ({ ...cleanEnv(), HOME: home, WK_HOME: path.join(home, '.wk'), PLUGIN_ROOT: dest, PLUGIN_DATA: data, ...more });
const sh = (cmd, input, more) => spawnSync('sh', ['-c', cmd], { cwd: dest, input, encoding: 'utf8', timeout: 60000, env: hookEnv(more) });
const decision = r => JSON.parse(r.stdout).decision;

test('the renderers: hooks become relative wk-run commands, MCP runs through sh, skills name the bin/ tools', () => {
  assert.equal(hookCommand('"{{NODE}}" "{{WK_BIN_DIR}}/wk-guard-agy.mjs"'), './libexec/wk-run node runtime/bin/wk-guard-agy.mjs');
  assert.equal(hookCommand('"{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/x.py" PostToolUse'), './libexec/wk-run python runtime/reprompt/scripts/x.py PostToolUse');
  assert.throws(() => hookCommand('/usr/bin/env node /abs/x.mjs'), /no self-contained form/);
  const m = renderMcp({ mcpServers: { r: { command: '{{PYTHON}}', args: ['{{WK_REPROMPT_DIR}}/server/s.py', '--data-dir', '${PLUGIN_DATA}'] } } });
  assert.deepEqual(m.mcpServers.r, { command: 'sh', args: ['${PLUGIN_ROOT}/libexec/wk-run', 'python', '${PLUGIN_ROOT}/runtime/reprompt/server/s.py', '--data-dir', '${PLUGIN_DATA}'] });
  assert.throws(() => renderMcp({ mcpServers: { r: { command: '/usr/bin/python3', args: [] } } }), /no self-contained form/);
  assert.equal(renderMarkdown('Run `"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" list`.'), 'Run `wk-task list`.');
  assert.throws(() => renderMarkdown('"{{NODE}}" "{{WK_BIN_DIR}}/wk-pin.mjs"', 'x.md'), /x\.md: no bin\/ tool for bin\/wk-pin\.mjs/);
  assert.throws(() => renderMarkdown('see {{WK_HOME}}', 'y.md'), /y\.md: a placeholder is left: \{\{WK_HOME\}\}/);
});

test('bundle: builds, passes its own check, carries the manifest, README, licence and zip', () => {
  assert.equal(built.status, 0, built.stderr);
  const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(res.version, version);
  assert.deepEqual(checkBundle(dest), []);
  const m = JSON.parse(fs.readFileSync(path.join(dest, 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'watchkeeper'); assert.equal(m.version, version);
  for (const k of ['displayName', 'description', 'logo', 'author', 'homepage', 'repository', 'license']) assert.ok(m[k], `plugin.json has ${k}`);
  assert.ok(m.suggestedPrompts.length >= 1);
  assert.ok(fs.existsSync(path.join(dest, m.logo)));
  const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
  assert.ok(readme.includes(`Version ${version}`) && readme.includes(`watchkeeper-antigravity-${version}.zip`));
  assert.ok(fs.existsSync(path.join(dest, 'LICENSE')));
  assert.match(fs.readFileSync(path.join(dest, 'rules', 'watchkeeper.md'), 'utf8'), /~\/\.gemini\/config\/plugins\/watchkeeper\/bin\/<name>/);
  // nothing the owner keeps out of a plugin: tests, docs, the panel's build files, the plugin source with its placeholders
  for (const rel of ['runtime/test', 'runtime/tests', 'runtime/docs', 'runtime/panel/package.json', 'runtime/antigravity', 'runtime/release', 'runtime/scripts', 'runtime/bin/wk-sign.mjs'])
    assert.ok(!fs.existsSync(path.join(dest, rel)), `${rel} is not in the bundle`);
  assert.ok(fs.existsSync(path.join(dest, 'runtime', 'panel', 'src', 'legal-words.js')), 'the shared lists the bin/ scripts load are in');
  assert.equal(res.zip, path.join(out, `watchkeeper-antigravity-${version}.zip`));
  const z = spawnSync('unzip', ['-l', res.zip], { encoding: 'utf8' });
  assert.equal(z.status, 0, z.stderr); assert.match(z.stdout, /watchkeeper\/plugin\.json/); assert.match(z.stdout, /watchkeeper\/libexec\/wk-run/);
  // a second build into the same folder is refused; --out is required
  const again = cli(['bundle', '--out', out]); assert.equal(again.status, 1); assert.match(again.stderr, /exists: build into a folder without it/);
  const none = cli(['bundle']); assert.equal(none.status, 1); assert.match(none.stderr, /bundle needs --out/);
});

test('checkBundle finds what the marketplace would refuse', () => {
  const bad = path.join(base, 'bad');
  fs.cpSync(dest, bad, { recursive: true });
  const hooks = JSON.parse(fs.readFileSync(path.join(bad, 'hooks.json'), 'utf8'));
  hooks.extra = { Stop: [{ type: 'command', command: 'node ${PLUGIN_ROOT}/runtime/bin/x.mjs' }] };
  fs.writeFileSync(path.join(bad, 'hooks.json'), JSON.stringify(hooks));
  fs.rmSync(path.join(bad, 'runtime', 'panel', 'src', 'legal-words.js'));
  fs.writeFileSync(path.join(bad, 'rules', 'extra.md'), 'Run /Users/someone/x and {{WK_BIN_DIR}}.\n');
  fs.chmodSync(path.join(bad, 'bin', 'wk-status'), 0o644);
  fs.symlinkSync('/etc/hosts', path.join(bad, 'assets', 'link'));
  const p = checkBundle(bad).join('\n');
  for (const re of [/names PLUGIN_ROOT/, /is not a relative wk-run command/, /legal-words\.js is not in the bundle/, /rules\/extra\.md: placeholder/, /rules\/extra\.md: names a home folder/, /bin\/wk-status is not executable/, /assets\/link is a symlink/])
    assert.match(p, re);
});

test('every hook runs the way Antigravity runs it: sh -c in the plugin folder, exit 0, JSON out', () => {
  const cmds = [];
  (function walk(v, ev) {
    if (Array.isArray(v)) v.forEach(x => walk(x, ev));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'command' ? cmds.push([ev, x]) : walk(x, /^[A-Z]/.test(k) ? k : ev);
  })(JSON.parse(fs.readFileSync(path.join(dest, 'hooks.json'), 'utf8')));
  assert.ok(cmds.length >= 10, `${cmds.length} hooks`);
  const payload = ev => JSON.stringify({
    conversationId: 'own-chat', cwd: proj, workspacePaths: [proj], prompt: 'hello there', userPrompt: 'hello there',
    ...(ev === 'PreToolUse' ? { toolCall: { name: 'view_file', args: { AbsolutePath: path.join(proj, 'a.txt') } } } : {}),
    ...(ev === 'PostToolUse' ? { toolCall: { name: 'write_to_file', args: { TargetFile: path.join(proj, 'a.py'), CodeContent: 'x = 1\n' } } } : {}),
  });
  const pythons = [null];
  const sys = '/usr/bin/python3';
  if (fs.existsSync(sys) && spawnSync(sys, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0) pythons.push(sys);
  for (const py of pythons) for (const [ev, cmd] of cmds) {
    if (py && !/ python /.test(cmd)) continue;
    const r = sh(cmd, payload(ev), py ? { WK_PYTHON: py } : {});
    assert.equal(r.status, 0, `${ev} ${cmd}${py ? ` (${py})` : ''}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${ev} ${cmd} prints JSON: ${r.stdout.slice(0, 200)}`);
  }
});

test('the guard in the bundle: your own chat gets the pass decision, Watchkeeper work meets the rules', () => {
  const guard = './libexec/wk-run node runtime/bin/wk-guard-agy.mjs';
  const own = sh(guard, JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: path.join(proj, 'a.txt') } }, conversationId: 'own-2', workspacePaths: [proj] }));
  assert.equal(own.status, 0, own.stderr); assert.equal(decision(own), 'ask', 'no install step, no Turbo settings: ask');
  const work = sh(guard, JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main', Cwd: path.join(home, '.wk', 'worktrees', 't') } }, conversationId: 'wk-2', workspacePaths: [proj] }));
  assert.equal(work.status, 0, work.stderr); assert.equal(decision(work), 'deny');
});

test('the bin/ tools run by path and through a symlink; the MCP server answers initialize', () => {
  for (const name of Object.keys(TOOLS)) assert.ok(fs.statSync(path.join(dest, 'bin', name)).mode & 0o111, `bin/${name} is executable`);
  const st = spawnSync(path.join(dest, 'bin', 'wk-status'), ['--json'], { cwd: proj, encoding: 'utf8', env: hookEnv() });
  assert.equal(st.status, 0, st.stderr);
  const agy = JSON.parse(st.stdout).watchkeeper.antigravity;
  assert.equal(agy.self_contained, true); assert.equal(agy.installed, false, 'not in this temp home\'s plugins folder');
  const link = path.join(base, 'wk-task');
  fs.symlinkSync(path.join(dest, 'bin', 'wk-task'), link);
  const t = spawnSync(link, ['list'], { cwd: proj, encoding: 'utf8', env: hookEnv() });
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /No tasks yet/);
  const bad = spawnSync('sh', [path.join(dest, 'libexec', 'wk-run'), 'ruby', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 64); assert.match(bad.stderr, /use node or python/);
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n';
  const mcp = JSON.parse(fs.readFileSync(path.join(dest, 'mcp_config.json'), 'utf8')).mcpServers['re-prompt'];
  const args = mcp.args.map(a => a.split('${PLUGIN_ROOT}').join(dest).split('${PLUGIN_DATA}').join(data));
  const r = spawnSync(mcp.command, args, { input: init, encoding: 'utf8', timeout: 30000, env: hookEnv() });
  const first = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{')));
  assert.equal(first.id, 1); assert.ok(first.result && first.result.capabilities, r.stdout.slice(0, 300));
});

test('installed where Antigravity puts it, status calls the copy current', () => {
  const h = path.join(base, 'home-installed'), plug = path.join(h, '.gemini', 'config', 'plugins');
  fs.mkdirSync(plug, { recursive: true }); fs.cpSync(dest, path.join(plug, 'watchkeeper'), { recursive: true });
  const st = spawnSync(path.join(plug, 'watchkeeper', 'bin', 'wk-status'), ['--json'], { cwd: proj, encoding: 'utf8', env: { ...cleanEnv(), HOME: h, WK_HOME: path.join(h, '.wk') } });
  assert.equal(st.status, 0, st.stderr);
  const agy = JSON.parse(st.stdout).watchkeeper.antigravity;
  assert.deepEqual([agy.installed, agy.current, agy.self_contained, agy.version], [true, true, true, res.version]);
  assert.ok(agy.skills.length >= 10 && agy.hooks && agy.mcp);
});

test('P2-279 review M1: the bundled gemini-chain Stop entry offers the queued task with the Desk rules, and {} when the chain is off', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(dest, 'hooks.json'), 'utf8'));
  const entries = hooks['watchkeeper-gemini-chain'].Stop;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, './libexec/wk-run python runtime/bin/wk-gemini-chain-hook.py');
  assert.ok(fs.existsSync(path.join(dest, 'runtime', 'bin', 'wk-gemini-chain-hook.py')));
  const wk = path.join(base, 'chain-wk'), id = '20261125-090000-bundle-job';
  fs.mkdirSync(path.join(wk, 'bridge'), { recursive: true }); fs.mkdirSync(path.join(wk, 'tasks', id), { recursive: true });
  fs.writeFileSync(path.join(wk, 'tasks', id, 'meta.json'), JSON.stringify({ id, status: 'queued', title: 'Bundle job' }));
  const stop = JSON.stringify({ conversationId: 'chain-1', terminationReason: 'model_stop', fullyIdle: true, continuationActive: false, workspace: proj });
  const off = sh(entries[0].command, stop, { WK_HOME: wk });
  assert.equal(off.status, 0, off.stderr); assert.deepEqual(JSON.parse(off.stdout), {}, 'chain off: {}');
  fs.writeFileSync(path.join(wk, 'bridge', 'gemini-chain-on'), 'on\n');
  const t0 = Date.now(), on = sh(entries[0].command, stop, { WK_HOME: wk }), took = Date.now() - t0;
  assert.equal(on.status, 0, on.stderr);
  const o = JSON.parse(on.stdout);
  assert.equal(o.decision, 'continue');
  assert.match(o.reason, new RegExp(`Begin with /wk-take-task ${id}\\.$`));
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gemini.json'), 'utf8')).desk_rules;
  assert.ok(o.reason.startsWith(rules), 'the Desk rules ride along word for word');
  assert.ok(took < 3000, `ran in ${took} ms`);
});
