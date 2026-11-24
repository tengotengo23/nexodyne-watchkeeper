// P2-273: Watchkeeper's own upkeep may use at most 10% of the week; the steward skips upkeep projects over the cap and `wk status` shows it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkWorld, env, cleanup, NOW0, WEEK_START, HOUR, DAY, iso, ROOT } from './fixtures/world.mjs';

const w0 = mkWorld({ projects: ['watchkeeper', 'alpha'] });
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) || /^CLAUDE_CODE_USE_/.test(k) || k === 'CLAUDE_PLUGIN_ROOT') delete process.env[k];
Object.assign(process.env, env(w0));
const S = await import('../bin/steward-lib.mjs');
after(cleanup);

const WEEKLY = 20.94, CAP = 0.1 * WEEKLY;
const put = rows => fs.writeFileSync(w0.ledger, rows.map(r => JSON.stringify({ model: 'x', turns: 1, ...r })).join('\n') + '\n');
const at = h => iso(WEEK_START + h * HOUR);
const st = { held: [], finished: [], counted: [], started: new Map() };
const read = () => { const cfg = S.loadConfig(), pj = S.loadProjects(); return { cfg, pj, up: S.upkeepReading(cfg, NOW0, null, pj.projects) }; };

test('under the cap the Watchkeeper project stays eligible', () => {
  put([{ at: at(10), item: 'steward:watchkeeper', cost_usd: 0.5 }, { at: at(11), item: 'steward:alpha', cost_usd: 9 }]);
  const { cfg, pj, up } = read();
  assert.equal(up.over, false); assert.ok(Math.abs(up.spentUsd - 0.5) < 1e-9); assert.ok(Math.abs(up.capUsd - CAP) < 1e-9);
  const r = S.applyUpkeepCap(S.eligibleProjects(pj.projects, st, NOW0), cfg, NOW0, null, pj.projects);
  assert.deepEqual(r.el.list.map(p => p.id).sort(), ['alpha', 'watchkeeper']);
});

test('over the cap the Watchkeeper project is skipped with the reason and the other stays', () => {
  put([{ at: at(10), item: 'steward:watchkeeper', cost_usd: 1.5 }, { at: at(11), item: 'steward:probe', cost_usd: 0.7 }]);
  const { cfg, pj, up } = read();
  assert.equal(up.over, true); assert.ok(up.share > 0.1);
  const r = S.applyUpkeepCap(S.eligibleProjects(pj.projects, st, NOW0), cfg, NOW0, null, pj.projects);
  assert.deepEqual(r.el.list.map(p => p.id), ['alpha']);
  const sk = r.el.skipped.find(x => x.id === 'watchkeeper'); assert.match(sk.why, /^upkeep cap: 11% of the week used \(max 10%\)$/);
});

test('a project inside the plugin folder counts as upkeep, even under another id', () => {
  put([{ at: at(10), item: 'steward:ownself', cost_usd: 2.5 }]);
  const cfg = S.loadConfig(), projects = [{ id: 'ownself', path: path.join(ROOT, 'bin'), weight: 1 }, { id: 'alpha', path: w0.specs[1].path, weight: 1 }];
  assert.equal(S.isUpkeepProject(cfg, projects[0]), true); assert.equal(S.isUpkeepProject(cfg, projects[1]), false);
  const up = S.upkeepReading(cfg, NOW0, null, projects); assert.equal(up.over, true);
  const r = S.applyUpkeepCap({ list: projects, skipped: [] }, cfg, NOW0, null, projects);
  assert.deepEqual(r.el.list.map(p => p.id), ['alpha']);
});

test('rows outside the week window do not count', () => {
  put([{ at: iso(WEEK_START - DAY), item: 'steward:watchkeeper', cost_usd: 5 }, { at: iso(WEEK_START + 8 * DAY), item: 'steward:probe', cost_usd: 5 }, { at: at(12), item: 'steward:probe', cost_usd: 0.2 }]);
  const { up } = read(); assert.ok(Math.abs(up.spentUsd - 0.2) < 1e-9); assert.equal(up.over, false);
});

test('validateConfig refuses maxWeekShare 0.9 and a non-list', () => {
  const ok = S.loadConfig();
  const bad = m => { const c = JSON.parse(JSON.stringify(ok)); Object.assign(c.maintenance, m); try { S.validateConfig(c); return null; } catch (e) { return String(e.message); } };
  assert.match(bad({ maxWeekShare: 0.9 }), /maintenance\.maxWeekShare/);
  assert.match(bad({ projects: 'watchkeeper' }), /maintenance\.projects/);
  assert.match(bad({ items: 5 }), /maintenance\.items/);
  assert.equal(bad({}), null);
});

test('wk status prints the Upkeep line and the upkeep JSON field', () => {
  put([{ at: at(10), item: 'steward:watchkeeper', cost_usd: 0.42 }]);
  const e = env(w0), run = a => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk-status.mjs'), ...a], { env: e, encoding: 'utf8', timeout: 90000 });
  const t = run([]); assert.match(t.stdout, /Upkeep {6}: US\$0\.42 of US\$2\.09 this week \(2% of the week; cap 10%\)/, t.stdout + t.stderr);
  const j = JSON.parse(run(['--json']).stdout); assert.equal(j.watchkeeper.upkeep.maxShare, 0.1); assert.ok(Math.abs(j.watchkeeper.upkeep.spentUsd - 0.42) < 1e-9);
});

test('a named visit (--project) to an upkeep project is held when the cap is over; other projects still run', async () => {
  // P2-273 review: naming the project must not step around the cap
  put([{ at: at(10), item: 'steward:watchkeeper', cost_usd: 1.5 }, { at: at(11), item: 'steward:probe', cost_usd: 0.7 }]);
  const held = await S.tick({ force: true, dryRun: true, project: 'watchkeeper' });
  assert.equal(held.held, 'pace', JSON.stringify(held));
  assert.match(held.detail, /^upkeep cap: 11% of the week used \(max 10%\)$/);
  assert.equal(held.project, 'watchkeeper');
  const other = await S.tick({ force: true, dryRun: true, project: 'alpha' });
  assert.notEqual(other.held, 'pace', JSON.stringify(other));
  put([{ at: at(10), item: 'steward:watchkeeper', cost_usd: 0.5 }]);
  const under = await S.tick({ force: true, dryRun: true, project: 'watchkeeper' });
  assert.notEqual(under.held, 'pace', JSON.stringify(under));
});
