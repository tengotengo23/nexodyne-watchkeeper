'use strict';
// P2-279 Gemini Desk: the copy-button text (Desk rules, setup lines, the plugin path quoted, the time zone) and the
// Bridge card's chain line. Pure functions and a temporary folder; nothing is run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data');
const R = require('../src/render');

const root = path.resolve(__dirname, '..', '..');
const real = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gemini.json'), 'utf8'));

test('automationText: an older config without Desk rules copies exactly as before', () => {
  const g = { prompt: 'Run node <ABS>/bin/wk-task.mjs list.' };
  assert.equal(D.automationText(g, '/opt/wk', 'Europe/Berlin'), 'Run node /opt/wk/bin/wk-task.mjs list.');
  assert.equal(D.automationText(g, '', 'UTC'), 'Run node <ABS>/bin/wk-task.mjs list.');
  assert.equal(D.automationText({ prompt: '' }, '/opt/wk'), '');
  assert.equal(D.automationText(null, '/opt/wk'), '');
});

test('automationText: the shipped prompt carries the Desk rules, inbox --brief and the setup lines', () => {
  const t = D.automationText({ prompt: real.automation_prompt, desk_rules: real.desk_rules }, '/opt/wk', 'Asia/Tbilisi');
  assert.ok(t.startsWith('Watchkeeper Gemini Desk. First run `node /opt/wk/bin/wk-task.mjs inbox --brief`.'));
  assert.ok(t.includes(real.desk_rules + ' If /wk-take-task is not available here, use the commands instead: `node /opt/wk/bin/wk-task.mjs take` to take the task and read its brief, and `node /opt/wk/bin/wk-task.mjs done <id> --note "<one line>"` when finished. Take at most one task in this run.'), 'rules inserted once, no double full stop, then the fallback commands');
  assert.equal(t.split(real.desk_rules).length, 2, 'the Desk rules appear exactly once');
  assert.ok(!t.includes('<desk_rules>') && !t.includes('<ABS>'));
  assert.match(t, /Custom cron schedule: CRON_TZ=Asia\/Tbilisi 0 8-23 \* \* \*/);
  assert.match(t, /Model: Pro/);
});

test('automationText: a path with a space or a quote is shell-quoted; a bad zone falls back to UTC', () => {
  const g = { prompt: real.automation_prompt, desk_rules: real.desk_rules };
  assert.ok(D.automationText(g, '/Users/x/My Plugins/wk', 'UTC').includes("`node '/Users/x/My Plugins/wk'/bin/wk-task.mjs inbox --brief`"));
  assert.ok(D.automationText(g, "/tmp/it's", 'UTC').includes(`'/tmp/it'\\''s'/bin`));
  assert.match(D.automationText(g, '/opt/wk', 'Bad Zone; rm -rf'), /CRON_TZ=UTC /);
  assert.match(D.automationText(g, '/opt/wk'), /CRON_TZ=UTC /);
});

test('readGeminiConfig reads desk_rules from the plugin folder', () => {
  const c = D.readGeminiConfig(root);
  assert.equal(c.found, true);
  assert.equal(c.desk_rules, real.desk_rules);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-desk-panel-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'gemini.json'), JSON.stringify({ automation_prompt: 'x' }));
  assert.equal(D.readGeminiConfig(dir).desk_rules, '');
});

test('Bridge card: the chain line says off by default and on with the hour count', () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  const base = { ...D.EMPTY_BRIDGE, found: true, on: true };
  assert.match(R.renderBridge({ now, bridge: base }), /Gemini chain: off · <code>wk-bridge gemini-chain on<\/code>/);
  const on = { ...base, routes: { ...base.routes, gemini_chain: { on: true, offered_1h: 2 } } };
  assert.match(R.renderBridge({ now, bridge: on }), /Gemini chain: on \(2 offers in the last hour, all conversations\) · <code>wk-bridge gemini-chain off<\/code>/);
});
