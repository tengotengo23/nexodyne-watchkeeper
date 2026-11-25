// P2-287: the bedrock rule ships with the Antigravity plugin: always on, compact, built from negative constraints,
// free of machine paths and placeholders, named where the other rules are, and deployed by the installer.
// A temp HOME for the install; the real ~/.gemini and ~/.wk are never touched; nothing runs agy.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const RULE = path.join(root, 'antigravity', 'plugins', 'watchkeeper', 'rules', 'bedrock.md');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('bedrock.md: always on, compact, negative constraints, no machine paths or placeholders', () => {
  const text = fs.readFileSync(RULE, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'front matter');
  assert.match(m[1], /^trigger: always_on$/m, 'loads in every conversation');
  assert.match(m[1], /^description: .{20,}/m, 'has a description');
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 900, `compact: ${words} words (at most 900, well under the shared always-on budget)`);
  assert.ok((text.match(/\bnever\b/gi) || []).length >= 8, 'negative constraints carry the rule');
  for (const must of ['exit code', 'only checks syntax', 'weaken a test', '"unknown"', 'unverified', 'three failed tries',
    'wk-suggest', 'licence', 'untrusted', 'graphify query', 'graphify update .', 'grep -n', 'last 20 lines', 'at most three',
    'wk-take-task', 'At most two skills', 'Result first']) assert.ok(text.includes(must), `the rule says: ${must}`);
  assert.doesNotMatch(text, /\{\{|\/Users\/|\/home\/[a-z]|C:\\/, 'no placeholders or machine paths (the bundle refuses them)');
  assert.match(text, /stop switch/, 'it yields to the Watchkeeper rules');
});

test('bedrock.md is named where the other rules are: ledger, README, bundle README', () => {
  const ledger = JSON.parse(read('core/CAPABILITY_LEDGER.json'));
  const entry = ledger.capabilities.find(c => c.id === 'agy-antigravity/plugins/watchkeeper/rules/bedrock.md');
  assert.ok(entry, 'a ledger entry');
  assert.equal(entry.lifecycle_trigger, 'AntigravityPluginInstall');
  assert.equal(entry.verification_assertion, "file_exists('antigravity/plugins/watchkeeper/rules/bedrock.md')");
  assert.equal(ledger.summary.total_capabilities, ledger.capabilities.length, 'the summary counts its entries');
  assert.equal(ledger.summary.watchkeeper_counts.antigravity, ledger.capabilities.filter(c => String(c.id).startsWith('agy-')).length);
  assert.match(read('README.md'), /bedrock/i, 'the README names the rule');
  assert.match(read('antigravity/bundle/README.md'), /\*\*Bedrock rules\.\*\*/, 'the zip README names the rule');
});

test('the installer deploys bedrock.md unchanged, next to the other rules', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-bedrock-')), home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_NODE: process.execPath };
  delete env.CLAUDE_PLUGIN_ROOT;
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-antigravity.mjs'), 'install', '--json'], { cwd: base, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'installed');
  const target = out.target;
  assert.deepEqual(fs.readdirSync(path.join(target, 'rules')).sort(), ['bedrock.md', 'graphify.md', 're-prompt.md', 'watchkeeper.md']);
  assert.equal(fs.readFileSync(path.join(target, 'rules', 'bedrock.md'), 'utf8'), fs.readFileSync(RULE, 'utf8'), 'the rule has no placeholders, so the deployed copy is the source');
  const st = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-antigravity.mjs'), 'status'], { cwd: base, env, encoding: 'utf8' });
  assert.match(st.stdout, /Rules: bedrock\.md, graphify\.md, re-prompt\.md, watchkeeper\.md\./);
  fs.rmSync(base, { recursive: true, force: true });
});
