// P2-272: `wk-handoff install --statusline-only` adds only Watchkeeper's status line to Claude Code's
// settings.json; every hook (the owner's and the two wk-handoff hooks) stays exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchSettings } from '../bin/wk-handoff.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wk-handoff.mjs');
const theirs = () => ({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 their-hook.py', timeout: 90 }] }] });

test('statusline-only install adds the status line and leaves every hook alone', () => {
  const next = patchSettings({ model: 'opus', hooks: theirs() }, true, { hooks: false });
  assert.deepEqual(next.hooks, theirs());
  assert.equal(next.model, 'opus');
  assert.match(next.statusLine.command, /wk-handoff\.mjs" statusline/);
  assert.equal(next.hooks.Stop, undefined);
  assert.equal(next.hooks.SessionStart, undefined);
});

test('statusline-only install keeps a status line the owner already has', () => {
  const mine = { type: 'command', command: 'my-line.sh' };
  assert.deepEqual(patchSettings({ statusLine: mine }, true, { hooks: false }).statusLine, mine);
});

test('statusline-only uninstall removes only our status line, never the owner\'s', () => {
  const ours = patchSettings({ hooks: theirs() }, true, { hooks: false });
  assert.deepEqual(patchSettings(ours, false, { hooks: false }), { hooks: theirs() });
  const mine = { statusLine: { type: 'command', command: 'my-line.sh' } };
  assert.deepEqual(patchSettings(mine, false, { hooks: false }), mine);
});

test('without the option, install still adds the two wk-handoff hooks and the status line', () => {
  const next = patchSettings({}, true);
  assert.ok(next.hooks.Stop && next.hooks.SessionStart && next.statusLine);
  assert.deepEqual(patchSettings(next, false), {});
});

test('the command in a temp HOME: dry run changes nothing, --apply backs up, uninstall gives back the same bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-sl-install-'));
  try {
    const claude = path.join(tmp, 'claude'), wk = path.join(tmp, 'wk'); fs.mkdirSync(claude);
    const f = path.join(claude, 'settings.json');
    const before = JSON.stringify({ model: 'opus', hooks: theirs() }, null, 2) + '\n';
    fs.writeFileSync(f, before);
    const env = { ...process.env, HOME: tmp, WK_CLAUDE_HOME: claude, WK_HOME: wk };
    const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { env, encoding: 'utf8' });
    let r = run('install', '--statusline-only');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Would add the Watchkeeper status line \(no hooks\)/);
    assert.equal(fs.readFileSync(f, 'utf8'), before);
    r = run('install', '--statusline-only', '--apply');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Added the Watchkeeper status line/);
    const now = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(now.hooks, theirs());
    assert.match(now.statusLine.command, /wk-handoff\.mjs" statusline/);
    assert.equal(fs.readdirSync(path.join(wk, 'backups')).filter((n) => n.startsWith('settings.json.')).length, 1);
    r = run('install', '--statusline-only', '--apply');
    assert.match(r.stdout, /already in place/);
    r = run('uninstall', '--statusline-only', '--apply');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Removed the Watchkeeper status line/);
    assert.equal(fs.readFileSync(f, 'utf8'), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });   // only the temp folder this test made
  }
});
