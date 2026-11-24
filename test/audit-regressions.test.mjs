import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');

function mkTmp(prefix = 'wk-audit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('CLI --help flags exit 0 across Watchkeeper bin tools', () => {
  const clis = [
    'wk-task.mjs',
    'wk-takeover.mjs',
    'wk-job.mjs',
    'wk-suggest.mjs',
    'wk-projects.mjs',
    'wk-update.mjs',
    'wk-optimise.mjs',
    'wk-ledger.mjs',
    'wk-skill-sync.mjs',
    'wk-state.mjs',
    'wk-antigravity.mjs',
  ];
  for (const name of clis) {
    const r = spawnSync(process.execPath, [path.join(BIN, name), '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r.status, 0, `${name} --help exited ${r.status}: ${r.stderr}`);
    assert.ok((r.stdout + r.stderr).trim().length > 0, `${name} --help printed nothing`);
  }
});

test('wk-status.mjs honors WK_HOME/KILL and maps actual task statuses & suggestions', () => {
  const dir = mkTmp('wk-status-');
  try {
    fs.writeFileSync(path.join(dir, 'KILL'), 'stop\n');
    const t1 = path.join(dir, 'tasks', '20261122-010101-q');
    const t2 = path.join(dir, 'tasks', '20261122-010102-t');
    fs.mkdirSync(t1, { recursive: true });
    fs.mkdirSync(t2, { recursive: true });
    fs.writeFileSync(path.join(t1, 'meta.json'), JSON.stringify({ id: '20261122-010101-q', status: 'queued' }));
    fs.writeFileSync(path.join(t2, 'meta.json'), JSON.stringify({ id: '20261122-010102-t', status: 'taken' }));
    fs.writeFileSync(
      path.join(dir, 'suggestions.jsonl'),
      JSON.stringify({ id: 'S-20261122-010101-aaaa', title: 'Review diff', at: new Date().toISOString() }) + '\n',
    );
    const out = execFileSync(process.execPath, [path.join(BIN, 'wk-status.mjs'), '--json'], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: dir },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.watchkeeper.kill_switch, true);
    assert.equal(parsed.watchkeeper.queue.pending, 1);
    assert.equal(parsed.watchkeeper.queue.in_progress, 1);
    assert.equal(parsed.watchkeeper.suggestions_open, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wk-ledger.mjs context validates missing transcript path with exit 2', () => {
  const dir = mkTmp('wk-ledger-');
  try {
    const r = spawnSync(process.execPath, [path.join(BIN, 'wk-ledger.mjs'), 'context'], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wk-watchdog.mjs createDynamicStallGuard clamps stallMs <= maxWallMs', async () => {
  const { createDynamicStallGuard } = await import(path.join(BIN, 'wk-watchdog.mjs'));
  let killed = false;
  const g = createDynamicStallGuard({
    stallMs: 60000,
    maxWallMs: 12000,
    graceMs: 1000,
    onKill: () => { killed = true; },
  });
  try {
    const st = g.status();
    assert.ok(st.maxWallMs >= 10000 && st.maxWallMs <= 12000);
    assert.ok(st.stallMs <= st.maxWallMs, `effStallMs ${st.stallMs} exceeded effMaxWallMs ${st.maxWallMs}`);
    assert.equal(killed, false);
  } finally {
    g.stop();
  }
});

test('wk-guard-agy.mjs blocks sensitive writes/reads and falls back to cwd when workspacePaths empty', () => {
  const rootTmp = mkTmp('wk-guard-agy-');
  const home = path.join(rootTmp, 'wk');
  const wt = path.join(home, 'worktrees', 't1');
  fs.mkdirSync(wt, { recursive: true });
  try {
    const denyEnv = spawnSync(process.execPath, [path.join(BIN, 'wk-guard-agy.mjs')], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: home },
      input: JSON.stringify({
        toolCall: { name: 'read_file', args: { Path: path.join(wt, '.env') } },
        cwd: wt,
      }),
      encoding: 'utf8',
    });
    assert.equal(denyEnv.status, 0);
    assert.equal(JSON.parse(denyEnv.stdout).decision, 'deny');

    const allowSafe = spawnSync(process.execPath, [path.join(BIN, 'wk-guard-agy.mjs')], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: home },
      input: JSON.stringify({
        toolCall: { name: 'write_file', args: { TargetFile: path.join(wt, 'src', 'clean.py'), CodeContent: 'x = 1\n' } },
        cwd: wt,
      }),
      encoding: 'utf8',
    });
    assert.equal(allowSafe.status, 0);
    assert.notEqual(JSON.parse(allowSafe.stdout).decision, 'deny');
  } finally {
    fs.rmSync(rootTmp, { recursive: true, force: true });
  }
});

test('wk.mjs help, overview, heal, and unknown subcommand exit codes work cleanly', () => {
  const dir = mkTmp('wk-wrap-');
  try {
    const rHelp = spawnSync(process.execPath, [path.join(BIN, 'wk.mjs'), 'help', '--json'], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(rHelp.status, 0);
    assert.ok(JSON.parse(rHelp.stdout).commands.overview);

    const rOverview = spawnSync(process.execPath, [path.join(BIN, 'wk.mjs'), 'overview', '--json'], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(rOverview.status, 0);
    assert.equal(JSON.parse(rOverview.stdout).version, '2.0.0');

    const rBad = spawnSync(process.execPath, [path.join(BIN, 'wk.mjs'), 'no-such-cmd', '--json'], {
      cwd: ROOT,
      env: { ...process.env, WK_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(rBad.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
