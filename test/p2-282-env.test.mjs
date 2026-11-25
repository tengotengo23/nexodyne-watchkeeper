// P2-282: Watchkeeper on macOS, Linux and Windows. detectEnv names the computer and fills config/platforms.json;
// `wk env` prints it; wk-watch uses Task Scheduler on Windows; the Antigravity bundle carries .cmd twins of its tools.
// Every reader (os-release, PATH lookup) is passed in, so each platform is tested on any computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectEnv, fillCommand, quote, COMMAND_KEYS, PLATFORMS_FILE, platformTable, findPythonPath, envText } from '../bin/env-lib.mjs';
import { buildBundle, WK_RUN_CMD, toolScriptCmd, TOOLS } from '../bin/antigravity-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const noLookup = () => null;

test('detectEnv on macOS: the version from the Darwin release, the shell from SHELL, ~/.wk under HOME', () => {
  const e = detectEnv({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, home: '/Users/you', release: '24.1.0', argv0: '/opt/node', nodeVersion: 'v22.1.0', lookup: n => (n === 'python3' ? '/usr/bin/python3' : null), pluginRoot: '/w' });
  assert.equal(e.os, 'macos'); assert.equal(e.osWords, 'macOS 15'); assert.equal(e.shell, 'zsh');
  assert.equal(e.python, '/usr/bin/python3'); assert.equal(e.wkHome, '/Users/you/.wk');
  assert.equal(e.antigravityPluginDir, '/Users/you/.gemini/config/plugins');
  assert.equal(detectEnv({ platform: 'darwin', env: {}, home: '/h', release: '27.0.0', lookup: noLookup }).osWords, 'macOS 28');
  assert.match(e.scheduler, /launchd/i);
  assert.ok(!e.commands.stop.includes('<'), e.commands.stop);
});

test('detectEnv on Linux reads os-release through the reader it is given; WSL is named', () => {
  const release = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n';
  const e = detectEnv({ platform: 'linux', env: { SHELL: '/usr/bin/bash', WK_HOME: '/data/wk' }, home: '/home/you', release: '6.8.0-45-generic', readOsRelease: () => release, lookup: noLookup });
  assert.equal(e.os, 'linux'); assert.equal(e.osWords, 'Ubuntu 24.04'); assert.equal(e.shell, 'bash');
  assert.equal(e.wkHome, '/data/wk'); assert.equal(e.python, null);
  assert.match(e.scheduler, /systemd/i);
  assert.match(envText(e).split('\n')[0], /^Your computer: Ubuntu 24\.04, shell bash, node v\d+.*, python not found$/);
  const w = detectEnv({ platform: 'linux', env: {}, home: '/home/you', release: '5.15.153.1-microsoft-standard-WSL2', readOsRelease: () => 'NAME="Debian GNU/Linux"\n', lookup: noLookup });
  assert.equal(w.os, 'wsl'); assert.equal(w.osWords, 'Debian GNU/Linux (WSL)');
  assert.deepEqual(Object.keys(w.commands), COMMAND_KEYS);
  assert.equal(detectEnv({ platform: 'linux', env: {}, home: '/h', release: '6.1', readOsRelease: () => '', lookup: noLookup }).osWords, 'Linux');
});

test('detectEnv on Windows: PowerShell from PSModulePath, cmd from ComSpec, USERPROFILE, python found by the lookup', () => {
  const ps = 'C:\\Users\\Ann\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules';
  const seen = [];
  const lookup = n => { seen.push(n); return n === 'python' ? 'C:\\Python312\\python.exe' : null; };
  const e = detectEnv({ platform: 'win32', env: { PSModulePath: ps, ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\Ann' }, release: '10.0.22631', argv0: 'C:\\Program Files\\nodejs\\node.exe', lookup, pluginRoot: 'C:\\Users\\Ann\\watchkeeper' });
  assert.equal(e.os, 'windows'); assert.equal(e.osWords, 'Windows 11'); assert.equal(e.shell, 'powershell');
  assert.equal(e.home, 'C:\\Users\\Ann'); assert.equal(e.wkHome, 'C:\\Users\\Ann\\.wk');
  assert.equal(e.python, 'C:\\Python312\\python.exe'); assert.equal(seen[0], 'python');
  assert.match(e.scheduler, /Task Scheduler/i);
  // A path with a space is quoted for PowerShell.
  assert.ok(Object.values(e.commands).some(c => c.includes("'C:\\Program Files\\nodejs\\node.exe'")), JSON.stringify(e.commands));
  const cmd = detectEnv({ platform: 'win32', env: { PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', USERPROFILE: 'C:\\U' }, release: '10.0.19045', lookup: noLookup });
  assert.equal(cmd.shell, 'cmd'); assert.equal(cmd.osWords, 'Windows 10'); assert.equal(cmd.python, null);
  // The py launcher is the last choice, as "py -3"; a WindowsApps stub never counts.
  assert.equal(findPythonPath({ platform: 'win32', env: {}, lookup: n => (n === 'py' ? 'C:\\Windows\\py.exe' : n === 'python' ? 'C:\\Users\\A\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe' : null) }), 'C:\\Windows\\py.exe -3');
  assert.equal(findPythonPath({ platform: 'win32', env: { WK_PYTHON: 'D:\\py\\python.exe' }, lookup: noLookup }), 'D:\\py\\python.exe');
});

test('fillCommand quotes a filled word with a space or a quote, for sh and for PowerShell; other words stay as written', () => {
  const v = { NODE: '/opt/my node/node', ABS: "/Users/o'neil/wk", WK_HOME: '/h/.wk', HOME: '/h' };
  assert.equal(fillCommand('<NODE> <ABS>/bin/wk.mjs status', v), `'/opt/my node/node' '/Users/o'\\''neil/wk/bin/wk.mjs' status`);
  assert.equal(fillCommand('<NODE> <ABS>/bin/wk.mjs status', v, { style: 'powershell' }), `'/opt/my node/node' '/Users/o''neil/wk/bin/wk.mjs' status`);
  assert.equal(fillCommand('touch <WK_HOME>/KILL', v), 'touch /h/.wk/KILL');
  assert.equal(fillCommand('wk take <task-id>', v), 'wk take <task-id>');
  assert.equal(fillCommand('rm "<HOME>/x y"', v), 'rm "/h/x y"', 'a word the template quotes is filled as it is');
  assert.equal(fillCommand('<UNKNOWN> ok', v), '<UNKNOWN> ok');
  assert.equal(quote("a'b", 'sh'), `'a'\\''b'`); assert.equal(quote("a'b", 'powershell'), `'a''b'`);
});

test('every platform in config/platforms.json has every command and the shared fields', () => {
  const t = JSON.parse(fs.readFileSync(PLATFORMS_FILE, 'utf8'));
  for (const name of ['macos', 'linux', 'windows', 'wsl']) {
    assert.ok(t[name], `${name} is in the table`);
    const e = platformTable(name);
    for (const k of COMMAND_KEYS) assert.equal(typeof e.commands[k], 'string', `${name}.${k}`), assert.ok(e.commands[k].trim(), `${name}.${k} is not empty`);
    for (const k of ['name', 'shell', 'scheduler', 'stop_file_display']) assert.ok(e[k], `${name}.${k}`);
  }
  assert.throws(() => platformTable('amiga'), /no entry for amiga/);
});

test('`wk env` prints this computer; `wk env --json` has every key and every command', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'wk.mjs'), 'env', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  for (const k of ['os', 'osWords', 'shell', 'node', 'python', 'home', 'wkHome', 'pluginRoot', 'antigravityPluginDir', 'scheduler', 'stopFileDisplay', 'commands']) assert.ok(k in e, k);
  assert.deepEqual(Object.keys(e.commands), COMMAND_KEYS);
  assert.equal(e.node.version, process.version);
  const t = spawnSync(process.execPath, [path.join(root, 'bin', 'wk.mjs'), 'env'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^Your computer: .+, shell \w+, node v\d/);
  assert.match(t.stdout, /Commands for this computer:/);
});

test('wk-watch on Windows: install --print composes the schtasks line and changes nothing', () => {
  const base = tmp('wk-p2-282-');
  const wk = path.join(base, 'my data', '.wk');
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-watch.mjs'), 'install', '--print'], { encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: base, USERPROFILE: base, WK_HOME: wk, WK_WATCH_PLATFORM: 'win32', WK_SCHTASKS: path.join(base, 'no-such-schtasks') } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const line = r.stdout.trim().split('\n').pop();
  assert.match(line, /^schtasks \/Create \/SC MINUTE \/MO 1 \/TN WatchkeeperWatch \/TR ".+" \/F$/);
  assert.ok(line.includes(`\\"${path.join(root, 'bin', 'wk-watch.mjs')}\\" check --wk-home \\"${wk}\\"`), line);
  assert.ok(!fs.existsSync(path.join(base, 'no-such-schtasks')));
});

test('wk-watch on Windows: install runs schtasks /Create and says the checker is on every 60 s', { skip: process.platform === 'win32' && 'uses a sh stub for schtasks' }, () => {
  const base = tmp('wk-p2-282-'), log = path.join(base, 'schtasks.log'), fake = path.join(base, 'schtasks');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-watch.mjs'), 'install'], { encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: base, WK_HOME: path.join(base, '.wk'), WK_WATCH_PLATFORM: 'win32', WK_SCHTASKS: fake } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Checker on: every 60 s \(Task Scheduler task WatchkeeperWatch\)/);
  assert.match(fs.readFileSync(log, 'utf8'), /^\/Create \/SC MINUTE \/MO 1 \/TN WatchkeeperWatch \/TR .* \/F$/m);
});

test('the Antigravity bundle carries wk-run.cmd and a .cmd twin of every tool, with CRLF; the sh tools stay', () => {
  const out = tmp('wk-p2-282-bundle-');
  buildBundle({ src: root, out });
  const dest = path.join(out, 'watchkeeper');
  const run = fs.readFileSync(path.join(dest, 'libexec', 'wk-run.cmd'), 'utf8');
  assert.equal(run, WK_RUN_CMD);
  assert.ok(run.startsWith('@echo off\r\n'));
  assert.ok(!/[^\r]\n/.test(run), 'every line of wk-run.cmd ends in CRLF');
  assert.ok(fs.existsSync(path.join(dest, 'libexec', 'wk-run')), 'the sh runner is still there');
  for (const name of Object.keys(TOOLS)) {
    const twin = fs.readFileSync(path.join(dest, 'bin', `${name}.cmd`), 'utf8');
    assert.ok(!/[^\r]\n/.test(twin), `${name}.cmd ends its lines in CRLF`);
    assert.match(twin, /call "%~dp0\.\.\\libexec\\wk-run\.cmd" --find (node|python)/);
    assert.match(twin, /"%~dp0\.\.\\runtime\\[^"/]+" %\*/);
    assert.ok(fs.existsSync(path.join(dest, 'bin', name)), `${name} (sh) is still there`);
  }
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'wk-task.cmd')));
  assert.equal(toolScriptCmd('node', 'bin/wk-task.mjs').includes('runtime\\bin\\wk-task.mjs'), true);
});
