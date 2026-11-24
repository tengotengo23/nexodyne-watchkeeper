// P2-272 P1-A: all usage windows kept, one shared status line. Temporary HOME and WK_HOME (new mkdtemp folders); never the live state.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), BIN = path.join(here, '..', 'bin', 'wk-handoff.mjs'), STATUS = path.join(here, '..', 'bin', 'wk-status.mjs');
const { meterFromEvents } = await import('../bin/steward-lib.mjs');
const H = await import(BIN);
const w = (u, r = 2e9, s = 'allowed') => ({ utilization: u, resetsAt: r, status: s });
function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-272-meter-'));
  const env = { ...process.env, HOME: t, WK_HOME: path.join(t, 'wk'), WK_STEWARD_DIR: path.join(t, 'wk', 'steward'), REPROMPT_DATA_DIR: path.join(t, 'rp'), REPROMPT_SKILL_VAULT_DIR: path.join(t, 'vault') };
  delete env.WK_METER; for (const d of [env.WK_STEWARD_DIR, env.REPROMPT_DATA_DIR, env.REPROMPT_SKILL_VAULT_DIR]) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, { HOME: t, WK_HOME: env.WK_HOME, WK_STEWARD_DIR: env.WK_STEWARD_DIR, REPROMPT_DATA_DIR: env.REPROMPT_DATA_DIR, REPROMPT_SKILL_VAULT_DIR: env.REPROMPT_SKILL_VAULT_DIR }); delete process.env.WK_METER;
  return { t, env };
}

test('meterFromEvents keeps every unified window and leaves the old top-level fields as they were', () => {
  const ev = { rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.02, resetsAt: 2e9, status: 'allowed', unifiedWindows: { seven_day: w(0.02), seven_day_fable: w(0.03), seven_day_opus: w(0.01), seven_day_sonnet: w(0.005), five_hour: w(0.4), overage: w(0.1) } } };
  const m = meterFromEvents([ev], 1e12, 'call');
  assert.deepEqual(Object.keys(m.windows).sort(), ['five_hour', 'overage', 'seven_day', 'seven_day_fable', 'seven_day_opus', 'seven_day_sonnet']);
  assert.deepEqual(m.windows.seven_day_fable, { utilization: 0.03, resetsAt: 2e9, status: 'allowed' });
  assert.equal(m.utilization, 0.03); assert.equal(m.fiveHour.utilization, 0.4);   // pace still follows the highest weekly window
  assert.equal(meterFromEvents([{ rate_limit_info: { unifiedWindows: { overage: w(0.5) } } }], 1e12, 'x'), null);   // a non-weekly window alone is no pace reading
});

test('statusline: stores every window atomically, prints one short line, merges a headless-only window, is fast', () => {
  const { t, env } = sandbox(), now = Date.now(), f = path.join(env.WK_STEWARD_DIR, 'meter.json');
  fs.writeFileSync(f, JSON.stringify({ fetchedAt: new Date(now).toISOString(), utilization: 0.1, windows: { seven_day_fable: w(0.03, now / 1000 + 9999) } }));
  fs.writeFileSync(path.join(env.REPROMPT_SKILL_VAULT_DIR, 'index.json'), JSON.stringify({ skill_count: 22 }));
  fs.writeFileSync(path.join(env.REPROMPT_SKILL_VAULT_DIR, 'sources.json'), JSON.stringify({ repos: [{ approved: true }, { approved: false, status: 'pending' }, { status: 'rejected' }, {}] }));
  fs.mkdirSync(path.join(t, 'proj', 'graphify-out'), { recursive: true }); fs.writeFileSync(path.join(t, 'proj', 'graphify-out', 'graph.json'), '{}');
  const ev = { cwd: path.join(t, 'proj'), rate_limits: { five_hour: { used_percentage: 40, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 2, resets_at: now / 1000 + 86400 } } };
  const t0 = Date.now(), r = spawnSync('node', [BIN, 'statusline'], { input: JSON.stringify(ev), encoding: 'utf8', env }); const ms = Date.now() - t0;
  assert.equal(r.status, 0); assert.equal(r.stdout.trim().split('\n').length, 1); assert.ok(r.stdout.trim().length <= 100, r.stdout);
  assert.equal(r.stdout.trim(), 'W on · rp: >30 words · graph <1m · library 22 (2 to review) · 5h 40% · 7d 2% · Fable 3%');
  const m = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(m.windows.five_hour.utilization, 0.4); assert.equal(m.windows.seven_day.utilization, 0.02); assert.equal(m.windows.seven_day_fable.utilization, 0.03); assert.equal(m.utilization, 0.02);
  assert.ok(!fs.readdirSync(env.WK_STEWARD_DIR).some((n) => n.endsWith('.tmp')));
  assert.ok(ms < 1500, `took ${ms} ms (process start included)`);
});

test('statusline: stop switch, rp all, coverage file, garbage stdin all give a line; exit 0', () => {
  const { t, env } = sandbox();
  fs.writeFileSync(path.join(env.WK_HOME, 'KILL'), ''); fs.writeFileSync(path.join(env.REPROMPT_DATA_DIR, 'settings.json'), JSON.stringify({ settingsVersion: 2, hookAutoAll: true, claudeCodeRewrite: 'always' }));
  fs.mkdirSync(path.join(t, 'p', 'graphify-out'), { recursive: true }); fs.writeFileSync(path.join(t, 'p', 'graphify-out', 'graph.json'), '{}'); fs.writeFileSync(path.join(t, 'p', 'graphify-out', 'wk-coverage.json'), JSON.stringify({ files_indexed: 5, files_total: 7 }));
  let r = spawnSync('node', [BIN, 'statusline'], { input: JSON.stringify({ cwd: path.join(t, 'p') }), encoding: 'utf8', env });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), 'W off · rp: all · graph <1m, 5/7');
  r = spawnSync('node', [BIN, 'statusline'], { input: '{not json', encoding: 'utf8', env }); assert.equal(r.status, 0); assert.match(r.stdout, /^W /);
  assert.equal(H.statusLine({ cwd: path.join(t, 'none'), meter: null }), 'W off · rp: all');
});

test('wk-status --json: line, meter.windows, gemini null without records and read-only cooldown with them', () => {
  const { env } = sandbox(), now = Date.now();
  fs.writeFileSync(path.join(env.WK_STEWARD_DIR, 'meter.json'), JSON.stringify({ fetchedAt: new Date(now).toISOString(), utilization: 0.02, resetsAt: now / 1000 + 5e5, windows: { seven_day: w(0.02, now / 1000 + 5e5), seven_day_fable: w(0.03, now / 1000 + 5e5) }, source: 'statusline' }));
  const run = () => { const r = spawnSync('node', [STATUS, '--json'], { encoding: 'utf8', env, cwd: env.HOME, timeout: 60000 }); return JSON.parse(r.stdout); };
  let j = run(); assert.equal(j.gemini, null); assert.match(j.line, /^W on · rp: >30 words/); assert.match(j.line, /7d 2% · Fable 3%$/);
  assert.equal(j.watchkeeper.pace.windows.seven_day_fable.utilization, 0.03);
  fs.writeFileSync(path.join(env.REPROMPT_DATA_DIR, 'orchestrator_usage.json'), JSON.stringify({ providers: { gemini: { requests: 4, spend_usd: 0.5, cooldown_until: now / 1000 + 600, cooldown_reason: 'rate limit' } } }));
  j = run(); assert.equal(j.gemini.in_cooldown, true); assert.equal(j.gemini.requests, 4); assert.equal(j.gemini.cooldown_reason, 'rate limit');
});
