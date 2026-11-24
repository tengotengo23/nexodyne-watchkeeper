// P2-272 P1-D: one data folder resolver and a status line that follows the host. Temporary HOME only (new mkdtemp folders).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), BIN = path.join(here, '..', 'bin', 'wk-handoff.mjs');
const R = await import('../bin/rp-dir.mjs');
const H = await import(BIN);
function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-272-store-'));
  const env = { ...process.env, HOME: t, WK_HOME: path.join(t, 'wk'), WK_STEWARD_DIR: path.join(t, 'wk', 'steward'), REPROMPT_DATA_DIR: path.join(t, 'rp'), REPROMPT_SKILL_VAULT_DIR: path.join(t, 'vault') };
  delete env.PLUGIN_DATA; fs.mkdirSync(env.REPROMPT_DATA_DIR, { recursive: true });
  return { t, env };
}
const withEnv = (env, fn) => { const keep = { ...process.env }; for (const k of ['HOME', 'REPROMPT_DATA_DIR', 'PLUGIN_DATA', 'WK_HOME', 'REPROMPT_SKILL_VAULT_DIR']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of ['HOME', 'REPROMPT_DATA_DIR', 'PLUGIN_DATA', 'WK_HOME', 'REPROMPT_SKILL_VAULT_DIR']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } } };

test('resolveDataDir: env first, then the Watchkeeper folder when it exists, then the old platform default', () => {
  const { t, env } = sandbox();
  assert.equal(withEnv(env, () => R.resolveDataDir()), env.REPROMPT_DATA_DIR);
  const noEnv = { ...env }; delete noEnv.REPROMPT_DATA_DIR;
  assert.equal(withEnv(noEnv, () => R.resolveDataDir()), withEnv(noEnv, () => R.platformDataDir()), 'no Watchkeeper folder yet');
  const wk = path.join(t, '.gemini', 'antigravity', 'plugin_data', 'watchkeeper'); fs.mkdirSync(wk, { recursive: true });
  assert.equal(withEnv(noEnv, () => R.resolveDataDir()), wk);
  assert.equal(withEnv({ ...noEnv, PLUGIN_DATA: path.join(t, 'pd') }, () => R.resolveDataDir()), path.join(t, 'pd'));
});

// A current settings file (settingsVersion 2, P2-273); oldLine writes one from before P2-273, which moves to the new defaults once.
function line(env, host, settings) {
  fs.writeFileSync(path.join(env.REPROMPT_DATA_DIR, 'settings.json'), JSON.stringify({ settingsVersion: 2, ...settings }));
  return withEnv(env, () => H.statusLine({ cwd: path.join(env.HOME, 'none'), meter: null, host }));
}
function oldLine(env, host, settings) {
  fs.writeFileSync(path.join(env.REPROMPT_DATA_DIR, 'settings.json'), JSON.stringify(settings));
  return withEnv(env, () => H.statusLine({ cwd: path.join(env.HOME, 'none'), meter: null, host }));
}
test('status line rp part: Claude Code follows claudeCodeRewrite, the panel follows hookAutoAll', () => {
  const { env } = sandbox();
  // P2-273: the default is the owner's 30-word rule in both hosts.
  assert.match(line(env, 'claude', {}), /rp: >30 words/);
  assert.match(line(env, 'claude', { claudeCodeRewrite: 'words', autoRewriteOverWords: 45 }), /rp: >45 words/);
  assert.match(line(env, 'claude', { claudeCodeRewrite: 'words', autoRewriteOverWords: 0 }), /rp: on request/);
  assert.match(line(env, 'claude', { claudeCodeRewrite: 'prefix' }), /rp: on request/);
  assert.match(line(env, 'claude', { claudeCodeRewrite: 'always' }), /rp: all/);
  assert.match(line(env, 'claude', { claudeCodeRewrite: 'never' }), /rp: off/);
  assert.match(line(env, 'claude', { hookAutoAll: true }), /rp: >30 words/, 'hookAutoAll is Antigravity only');
  assert.match(line(env, undefined, { hookAutoAll: true, claudeCodeRewrite: 'never' }), /rp: all/);
  assert.match(oldLine(env, 'claude', { claudeCodeRewrite: 'prefix' }), /rp: >30 words/, 'an old file moves to the 30-word rule');
  assert.match(oldLine(env, undefined, { hookAutoAll: true }), /rp: >30 words/, 'an old rewrite-everything setting is switched off once');
  assert.match(line(env, undefined, { claudeCodeRewrite: 'always' }), /rp: >30 words/);
  assert.match(line(env, undefined, { autoRewriteOverWords: 0 }), /rp: on request/);
});
test('wk-handoff statusline command uses the Claude Code host', () => {
  const { env } = sandbox();
  fs.writeFileSync(path.join(env.REPROMPT_DATA_DIR, 'settings.json'), JSON.stringify({ hookAutoAll: true, claudeCodeRewrite: 'never' }));
  const r = spawnSync('node', [BIN, 'statusline'], { input: '{}', encoding: 'utf8', env });
  assert.equal(r.status, 0); assert.match(r.stdout, /rp: off/);
});
