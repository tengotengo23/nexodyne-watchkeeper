// P2-272 package A: the watchkeeper-graph hook block, the install placeholders, the panel graph badge and status,
// wk-status graph coverage, and wk-handoff graphSummary. Temp HOME / WK_HOME / workspaces only.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const require = createRequire(import.meta.url);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const hooksSrc = JSON.parse(fs.readFileSync(path.join(root, 'antigravity', 'plugins', 'watchkeeper', 'hooks.json'), 'utf8'));

test('hooks.json: block watchkeeper-graph has the four events, in the right order, with placeholders', () => {
  const g = hooksSrc.hooks ? hooksSrc.hooks['watchkeeper-graph'] || hooksSrc['watchkeeper-graph'] : hooksSrc['watchkeeper-graph'];
  const blocks = hooksSrc.hooks && hooksSrc.hooks['watchkeeper-graph'] ? hooksSrc.hooks : hooksSrc;
  assert.ok(g, 'block exists');
  const names = Object.keys(blocks);
  assert.ok(names.indexOf('reprompt-skill-router') < names.indexOf('watchkeeper-graph'), 'runs after the router');
  assert.ok(names.indexOf('watchkeeper-graph') < names.indexOf('watchkeeper-learning'), 'runs before learning');
  const text = JSON.stringify(g);
  for (const ev of ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop']) assert.ok(g[ev], ev);
  assert.match(text, /\{\{PYTHON\}\}/); assert.match(text, /\{\{WK_BIN_DIR\}\}\/wk-graph-hook\.py/);
  assert.ok(!/continue/.test(text), 'never blocks a stop');
});

test('install fills the graph block placeholders in a temp home', () => {
  const base = tmp('wk-graph-'), home = path.join(base, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_NODE: process.execPath }; delete env.CLAUDE_PLUGIN_ROOT;
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'wk-antigravity.mjs'), 'install', '--json'], { cwd: base, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const f = path.join(home, '.gemini', 'config', 'plugins', 'watchkeeper', 'hooks.json');
  const s = fs.readFileSync(f, 'utf8');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(s), 'no placeholder left');
  assert.match(s, /wk-graph-hook\.py/);
  assert.ok(fs.existsSync(path.join(root, 'bin', 'wk-graph-hook.py')));
});

test('panel badge text: real coverage, age, changes; honest fallbacks', () => {
  const { graphBadgeText } = require('../panel/src/render.js');
  const t = graphBadgeText({ status: { known: true, indexed: 1754, total: 1754, truncated: false, ageMs: 2 * 60000 + 5000, changed: 4 } });
  assert.equal(t, 'Graph: 1754/1754 files · 2m old · 4 changed');
  assert.match(graphBadgeText({ status: { known: true, indexed: 20000, total: 30000, truncated: true, ageMs: 5000, changed: 0 } }), /20000\/30000 files \(truncated\) · just now$/);
  assert.match(graphBadgeText({ status: { known: true, indexed: 1, total: 1, truncated: false, ageMs: 3 * 3600000, changed: 0 } }), /3h old/);
  assert.match(graphBadgeText({ available: true, totalNodes: 12 }), /^Graph: 12 nodes$/);
  assert.match(graphBadgeText({}), /^Graph: not built yet$/);
});

test('readGraphStatus reads wk-coverage.json and the changed-files state', () => {
  const { readGraphStatus } = require('../panel/src/graphify-layer.js');
  const ws = tmp('wk-gws-'), wkHome = tmp('wk-ghome-'); process.env.WK_HOME = wkHome;
  try {
    assert.equal(readGraphStatus(ws).known, false);
    fs.mkdirSync(path.join(ws, 'graphify-out'));
    const built = new Date(Date.now() - 120000).toISOString();
    fs.writeFileSync(path.join(ws, 'graphify-out', 'wk-coverage.json'), JSON.stringify({ files_indexed: 7, files_total: 9, built_at: built, dirty_count: 0, mode: 'build', truncated: true }));
    const h = crypto.createHash('sha1').update(fs.realpathSync(ws)).digest('hex').slice(0, 12);
    fs.mkdirSync(path.join(wkHome, 'graph-hook', h), { recursive: true });
    fs.writeFileSync(path.join(wkHome, 'graph-hook', h, 'changed.json'), JSON.stringify({ files: ['a.py', 'b.py', 'c.py', 'd.py'] }));
    const s = readGraphStatus(ws);
    assert.deepEqual([s.known, s.indexed, s.total, s.truncated, s.changed], [true, 7, 9, true, 4]);
    assert.ok(s.ageMs >= 119000 && s.ageMs < 180000);
  } finally { delete process.env.WK_HOME; }
});

test('wk-status --json and text report graph coverage and age', () => {
  const ws = tmp('wk-gst-'), home = tmp('wk-gsth-');
  fs.mkdirSync(path.join(ws, 'graphify-out'));
  fs.writeFileSync(path.join(ws, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}');
  fs.writeFileSync(path.join(ws, 'graphify-out', 'wk-coverage.json'), JSON.stringify({ files_indexed: 1754, files_total: 1754, built_at: new Date(Date.now() - 125000).toISOString(), dirty_count: 4, mode: 'update', truncated: false }));
  const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk') };
  const j = JSON.parse(spawnSync(process.execPath, [path.join(root, 'bin', 'wk-status.mjs'), '--json'], { cwd: ws, env, encoding: 'utf8' }).stdout);
  const c = j.graphify.workspace_graph.coverage;
  assert.equal(c.files_indexed, 1754); assert.equal(c.files_total, 1754); assert.equal(c.dirty_count, 4);
  assert.ok(c.age_seconds >= 124 && c.age_seconds < 200);
  assert.match(spawnSync(process.execPath, [path.join(root, 'bin', 'wk-status.mjs')], { cwd: ws, env, encoding: 'utf8' }).stdout, /1754\/1754 files, 2m old, 4 changed/);
});

test('wk-handoff graphSummary: age, indexed/total, and "truncated" from wk-coverage.json', async () => {
  const H = await import(path.join(root, 'bin', 'wk-handoff.mjs'));
  const ws = tmp('wk-gh-'); fs.mkdirSync(path.join(ws, 'graphify-out'));
  assert.equal(H.graphSummary(ws), null);
  fs.writeFileSync(path.join(ws, 'graphify-out', 'graph.json'), '{}');
  assert.match(H.graphSummary(ws), /^<1m$/, 'no coverage file: age only');
  fs.writeFileSync(path.join(ws, 'graphify-out', 'wk-coverage.json'), JSON.stringify({ files_indexed: 1754, files_total: 1754, truncated: false }));
  assert.equal(H.graphSummary(ws), '<1m, 1754/1754');
  fs.writeFileSync(path.join(ws, 'graphify-out', 'wk-coverage.json'), JSON.stringify({ files_indexed: 20000, files_total: 31000, truncated: true }));
  assert.equal(H.graphSummary(ws), '<1m, 20000/31000 truncated');
});
