// P2-273: the owner's "keep on by default" and "lean and opt-in" lists, pinned in one place.
// If a default here changes, docs/DEFAULTS.md changes in the same commit (its test: p2-273-defaults-docs.test.mjs, private like the page).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- on by default ----
test('safety guards: config/gates.json parses and names the stop switch file', () => {
  const g = readJson('config/gates.json');
  assert.equal(g.kill_switch.file, '~/.wk/KILL');
  assert.ok(Array.isArray(g.kill_switch.allowTools) && g.kill_switch.allowTools.includes('Read'));
});

test('stop switch: the KILL file is honoured as soon as it exists', async () => {
  const { killOn } = await import('../bin/lib.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-defaults-'));
  try {
    const g = { kill_switch: { file: path.join(dir, 'KILL') } };
    assert.equal(killOn(g), false);
    fs.writeFileSync(g.kill_switch.file, '');
    assert.equal(killOn(g), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('evidence gate: the Stop path of the hook bus runs wk-evidence gate', () => {
  assert.match(read('core/hook_bus.py'), /_run_node_script\("wk-evidence\.mjs", \["gate"\]/);
});

test('weekly + Fable meter: the week budget is set', () => {
  const s = readJson('config/steward.json');
  assert.ok(s.week.weeklyUsd > 0);
  assert.match(s.week.anchor, /^\d{4}-\d{2}-\d{2}T/);
});

test('task queue: wk-task takes each task in its own git worktree (run for real in test/gemini.test.mjs)', () => {
  assert.match(read('bin/wk-task.mjs'), /git\(m\.repo, \['worktree', 'add', '--detach', wt, base\]\)/);
  assert.match(read('test/gemini.test.mjs'), /task\(\['take'/);
});

test('phone approvals: off in code until a server is set up (wk-remote enable needs one)', async () => {
  const { REMOTE_DEFAULTS } = await import('../bin/remote-lib.mjs');
  assert.equal(REMOTE_DEFAULTS.enabled, false);
  assert.match(read('bin/wk-remote.mjs'), /needServer\(\); writeRemote\(\{ enabled: true \}\)/);
});

// ---- lean and opt-in ----
test('Re-Prompt (panel): rewrite every prompt is off; the 30-word rule is on', () => {
  const { DEFAULT_SETTINGS } = require('../panel/src/reprompt-engine.js');
  assert.equal(DEFAULT_SETTINGS.hookAutoAll, false);
  assert.equal(DEFAULT_SETTINGS.autoRewriteOverWords, 30);
});

test('Re-Prompt (hooks, Python): the same defaults, Claude Code on "words", turn graph context off', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-defaults-rp-'));
  try {
    const code = 'import json, sys; sys.path.insert(0, "reprompt/server"); import reprompt_engine as e; '
      + 'print(json.dumps({k: e.DEFAULT_SETTINGS.get(k) for k in ["hookAutoAll", "autoRewriteOverWords", "claudeCodeRewrite", "graphTurnContext"]}))';
    const r = spawnSync('python3', ['-c', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, REPROMPT_DATA_DIR: data } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()),
      { hookAutoAll: false, autoRewriteOverWords: 30, claudeCodeRewrite: 'words', graphTurnContext: false });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('skills: at most 20 exposed', () => {
  assert.equal(require('../panel/src/skill-gate.js').MAX_SKILLS, 20);
});

test('upkeep: Watchkeeper maintenance capped at 10% of the week', () => {
  const m = readJson('config/steward.json').maintenance;
  assert.equal(m.maxWeekShare, 0.1);
  assert.ok(m.projects.includes('watchkeeper'));
});
