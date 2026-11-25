'use strict';
// P2-282: the automation prompt with the schedule and the opt-in lines, and the commands for this computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data');
const R = require('../src/render');

const root = path.resolve(__dirname, '..', '..');
const real = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gemini.json'), 'utf8'));
const table = JSON.parse(fs.readFileSync(path.join(root, 'config', 'platforms.json'), 'utf8'));
const g = (extra = {}) => ({ prompt: 'Run `node <ABS>/bin/wk-task.mjs inbox --brief`. Stop switch ~/.wk/KILL. <desk_rules>. Budget about <budget> minutes.', desk_rules: 'Be careful',
  run_budget_minutes: 45, max_tasks_per_run: 5, max_tasks_per_day: 9,
  automation_schedule: { default: '*/30 9-21 * * *', default_words: 'every 30 minutes from 09:00 to 21:30', quiet: '0 8-23 * * *', quiet_words: 'once an hour from 08:00 to 23:00' }, ...extra });

test('automationText fills <budget>, <ABS> and the schedule from the config', () => {
  const t = D.automationText(g(), '/opt/wk', 'Asia/Tbilisi');
  assert.ok(!/<budget>|<ABS>|<desk_rules>/.test(t));
  assert.ok(t.includes('Budget about 45 minutes.') && t.includes('node /opt/wk/bin'));
  assert.ok(t.includes('Schedule (custom cron): CRON_TZ=Asia/Tbilisi */30 9-21 * * *  (every 30 minutes from 09:00 to 21:30). Quieter: 0 8-23 * * *  (once an hour from 08:00 to 23:00).'));
  assert.ok(t.includes('Watchkeeper never installs or switches on an automation: you do, and you can stop it at any time.'));
  assert.ok(t.includes('run /wk-take-task once by hand'));
  assert.ok(t.includes('uses quota even when the queue is empty'));
  assert.ok(t.includes('about 45 minutes: several small ones or one big one, at most 5.'));
  assert.ok(t.includes('What stays: 9 tasks a day (config/gemini.json max_tasks_per_day), the Stop switch (~/.wk/KILL: with it'));
  assert.ok(t.trimEnd().endsWith('and your review and merge in this panel.'));
});

test('automationText with the shipped config keeps no placeholder and the numbers come from the file', () => {
  const c = D.readGeminiConfig(root);
  const t = D.automationText(c, '/opt/wk', 'UTC');
  assert.ok(!/<budget>|<ABS>|<desk_rules>/.test(t));
  assert.ok(t.includes(`${real.max_tasks_per_day} tasks a day`));
  assert.ok(t.includes(real.automation_schedule.default) && t.includes(real.automation_schedule.quiet));
});

test('automationText shows the Windows stop file only for Windows', () => {
  const mac = D.automationText(g(), '/opt/wk', 'UTC', D.envSummary({ platform: 'darwin', home: '/Users/a', pluginPath: '/opt/wk', platforms: table }));
  const win = D.automationText(g(), 'C:\\wk', 'UTC', D.envSummary({ platform: 'win32', home: 'C:\\Users\\a', pluginPath: 'C:\\wk', platforms: table }));
  assert.ok(mac.includes('~/.wk/KILL') && !mac.includes('%USERPROFILE%'));
  assert.ok(win.includes('%USERPROFILE%\\.wk\\KILL') && !win.includes('~/.wk/KILL'));
});

test('automationText without numbers in the config invents none', () => {
  const t = D.automationText({ prompt: 'x <budget>', desk_rules: 'r' }, '/opt/wk', 'UTC');
  assert.ok(!/at most|tasks a day \(/.test(t) && !/Schedule \(custom cron\)/.test(t));
  assert.ok(t.includes('Each run starts a new conversation'));
});

test('envSummary fills every command for macOS, Linux and Windows', () => {
  for (const [platform, os_, home] of [['darwin', 'macos', '/Users/a'], ['linux', 'linux', '/home/user'], ['win32', 'windows', 'C:\\Users\\a']]) {
    const e = D.envSummary({ platform, home, nodePath: '/usr/bin/node', pluginPath: '/opt/wk', platforms: table, wsl: false });
    assert.equal(e.os, os_);
    assert.deepEqual(Object.keys(e.commands), ['stop', 'resume', 'inbox', 'take', 'done', 'watch_install', 'watch_uninstall', 'status', 'logs']);
    for (const c of Object.values(e.commands)) assert.ok(!/<(NODE|ABS|WK_HOME|HOME)>/.test(c), c);
    assert.ok(e.commands.take.includes('<task-id>') && e.commands.done.includes('<task-id>'));
    assert.ok(e.name && e.shell && e.stopFileDisplay);
  }
  const mac = D.envSummary({ platform: 'darwin', home: '/Users/a', nodePath: '/usr/bin/node', pluginPath: '/opt/wk', platforms: table });
  assert.equal(mac.commands.stop, "touch '/Users/a/.wk/KILL'");
  assert.equal(mac.commands.inbox, '/usr/bin/node /opt/wk/bin/wk-task.mjs inbox --brief');
  const wsl = D.envSummary({ platform: 'linux', home: '/home/user', pluginPath: '/opt/wk', platforms: table, wsl: true });
  assert.equal(wsl.os, 'wsl'); assert.equal(wsl.name, 'Windows Subsystem for Linux'); assert.ok(wsl.commands.logs.includes('journalctl'));
});

test('envSummary quotes a plugin path with a space and survives a missing table', () => {
  const e = D.envSummary({ platform: 'darwin', home: '/Users/a', nodePath: '/usr/bin/node', pluginPath: '/Users/a/My Plugins/wk', platforms: table });
  assert.ok(e.commands.status.includes("'/Users/a/My Plugins/wk'/bin/wk.mjs") || e.commands.status.includes("'/Users/a/My Plugins/wk/bin/wk.mjs'"), e.commands.status);
  const empty = D.envSummary({ platform: 'darwin', home: '/h', platforms: {} });
  assert.deepEqual(empty.commands, {});
  assert.deepEqual(D.readPlatforms('relative/path'), {});
  assert.deepEqual(D.readPlatforms(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-plat-'))), {});
});

test('readGeminiConfig ignores bad numbers and long schedule strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gc-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'gemini.json'), JSON.stringify({ automation_prompt: 'x', run_budget_minutes: -3, max_tasks_per_run: '6', max_tasks_per_day: 1.5,
    automation_schedule: { default: 'a'.repeat(81), default_words: 5, quiet: '0 8 * * *' } }));
  const c = D.readGeminiConfig(dir);
  assert.equal(c.run_budget_minutes, 0); assert.equal(c.max_tasks_per_run, 0); assert.equal(c.max_tasks_per_day, 0);
  assert.equal(c.automation_schedule.default, ''); assert.equal(c.automation_schedule.default_words, ''); assert.equal(c.automation_schedule.quiet, '0 8 * * *');
  const ok = D.readGeminiConfig(root);
  assert.equal(ok.max_tasks_per_day, real.max_tasks_per_day);
});

test('render: both blocks are closed, the prompt is escaped, the command lines and the copy button are there', () => {
  const env = D.envSummary({ platform: 'darwin', home: '/Users/a', nodePath: '/usr/bin/node', pluginPath: '/opt/wk', platforms: table, shellEnv: '/bin/zsh' });
  const m = { automation: { text: 'Run <b>this</b> & that', env } };
  const h = R.renderAutomation(m);
  assert.match(h, /<details class="automation-prompt" id="automation-prompt"[^>]*><summary>Show the automation prompt<\/summary>/);
  assert.match(h, /<details class="env-commands" id="env-commands"[^>]*><summary>Commands for this computer \(macOS, zsh\)<\/summary>/);
  assert.ok(!/<details[^>]*\bopen\b/.test(h));
  assert.ok(h.includes('Run &lt;b&gt;this&lt;/b&gt; &amp; that') && !h.includes('<b>this</b>'));
  assert.ok(h.includes("stop:") && h.includes('touch &#39;/Users/a/.wk/KILL&#39;') && h.includes('watch install:') && h.includes('logs:'));
  assert.ok(h.includes('data-cmd="copyEnvCommands"'));
  assert.equal(R.renderAutomation({}), '');
});

// P2-282 (owner, 25 Nov): a /wk-take-task button at the top of the panel, so it is one press away.
test('the top of the panel has the /wk-take-task button first, and its feedback line sits under the header', () => {
  const h = R.renderPage({ nonce: 'n0nce', cspSource: 'vscode-resource:', styleUris: [], scriptUri: 'main.js' });
  const header = h.slice(h.indexOf('<header class="top">'), h.indexOf('</header>'));
  assert.match(header, /<button type="button" class="btn btn-small" data-cmd="chatTakeTask" data-where="top" data-plugin-only="1" hidden[^>]*>\/wk-take-task<\/button>/);
  assert.ok(header.indexOf('data-cmd="chatTakeTask"') < header.indexOf('data-cmd="refresh"'));
  const after = h.slice(h.indexOf('</header>'));
  assert.ok(after.indexOf('id="feedback-top"') >= 0 && after.indexOf('id="feedback-top"') < after.indexOf('data-slot="statusbar"'));
});

test('the take-task message carries where=top only from the top button', () => {
  assert.deepEqual(D.validateMessage({ cmd: 'chatTakeTask', where: 'top' }).msg, { cmd: 'chatTakeTask', taskId: '', where: 'top' });
  assert.deepEqual(D.validateMessage({ cmd: 'chatTakeTask', where: 'elsewhere' }).msg, { cmd: 'chatTakeTask', taskId: '', where: 'reprompt' });
  assert.deepEqual(D.validateMessage({ cmd: 'chatTakeTask', taskId: '20261124-202000-fix-login' }).msg, { cmd: 'chatTakeTask', taskId: '20261124-202000-fix-login', where: 'reprompt' });
});

test('envSummary: inside the IDE the commands say node, not the IDE binary; a custom data folder shows its own Stop file; the shell is the login shell', () => {
  const ide = D.envSummary({ platform: 'darwin', home: '/Users/a', pluginPath: '/opt/wk', platforms: table, electron: true, shellEnv: '/bin/zsh' });
  assert.match(ide.commands.take, /^node /, 'inside Electron the node word is what the user types');
  assert.equal(ide.shell, 'zsh');
  const plain = D.envSummary({ platform: 'darwin', home: '/Users/a', pluginPath: '/opt/wk', platforms: table, electron: false, shellEnv: '' });
  assert.ok(plain.commands.take.startsWith(process.execPath) || plain.commands.take.startsWith(`'${process.execPath}`), 'a plain node process shows its own path');
  assert.equal(plain.shell, table.macos.shell);
  assert.equal(D.envSummary({ platform: 'darwin', home: '/Users/a', wkHome: '/Users/a/.wk', platforms: table }).stopFileDisplay, '~/.wk/KILL');
  assert.equal(D.envSummary({ platform: 'darwin', home: '/Users/a', wkHome: '/Volumes/data/wk', platforms: table }).stopFileDisplay, '/Volumes/data/wk/KILL');
  assert.equal(D.envSummary({ platform: 'win32', home: 'C:\\Users\\a', wkHome: 'D:\\wk', platforms: table }).stopFileDisplay, 'D:\\wk\\KILL');
});
