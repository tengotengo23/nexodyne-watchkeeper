// Tests bin/wk-skill-sync.mjs: 24h launchd plist generation, status reporting, KILL switch gating, and install/uninstall.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('.');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-skillsync-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('skillSyncPlist formats 24h StartInterval and com.nexodyne.watchkeeper-skill-sync label', async () => {
  const { skillSyncPlist, LABEL } = await import('../bin/wk-skill-sync.mjs');
  assert.equal(LABEL, 'com.nexodyne.watchkeeper-skill-sync');
  const plist = skillSyncPlist({ node: '/usr/local/bin/node', script: '/opt/wk/bin/wk-skill-sync.mjs', logFile: '/tmp/wk-sync.log' });
  assert.match(plist, /<string>com\.nexodyne\.watchkeeper-skill-sync<\/string>/);
  assert.match(plist, /<integer>86400<\/integer>/);
  assert.match(plist, /<string>--daily<\/string>/);
});

test('wk-skill-sync status, KILL refusal, and install/uninstall lifecycle', () => {
  const dir = path.join(TMP, 'env1');
  const wk = path.join(dir, '.wk');
  const vault = path.join(dir, 'vault');
  const agents = path.join(dir, 'LaunchAgents');
  fs.mkdirSync(wk, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ skill_count: 14, repo_count: 3 }));
  fs.writeFileSync(path.join(wk, 'skill-sync.json'), JSON.stringify({
    last_sync_at: '2026-11-22T09:00:00Z',
    discovered_total: 12,
    added_repos: ['example/skills'],
    top_trending: [{ repo: 'example/skills', stars: 400, forks: 45, domain: 'ai-agents' }],
  }));

  const fakeLaunchctl = path.join(dir, 'launchctl');
  fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: dir,
    WK_HOME: wk,
    REPROMPT_SKILL_VAULT_DIR: vault,
    WK_LAUNCH_AGENTS: agents,
    WK_LAUNCHCTL: fakeLaunchctl,
  };
  const bin = path.join(ROOT, 'bin', 'wk-skill-sync.mjs');

  const st = spawnSync(process.execPath, [bin, 'status', '--json'], { encoding: 'utf8', env });
  assert.equal(st.status, 0, st.stderr);
  const stJson = JSON.parse(st.stdout);
  assert.equal(stJson.skill_count, 14);
  assert.equal(stJson.discovered_total, 12);
  assert.deepEqual(stJson.added_repos, ['example/skills']);

  const inst = spawnSync(process.execPath, [bin, 'install'], { encoding: 'utf8', env });
  assert.equal(inst.status, 0, inst.stderr);
  const plistPath = path.join(agents, 'com.nexodyne.watchkeeper-skill-sync.plist');
  assert.equal(fs.existsSync(plistPath), true);

  const uninst = spawnSync(process.execPath, [bin, 'uninstall'], { encoding: 'utf8', env });
  assert.equal(uninst.status, 0, uninst.stderr);
  assert.equal(fs.existsSync(plistPath), false);
  assert.equal(fs.readdirSync(path.join(wk, 'backups')).length, 1);

  fs.writeFileSync(path.join(wk, 'KILL'), 'stop\n');
  const killedRun = spawnSync(process.execPath, [bin, 'run', '--json'], { encoding: 'utf8', env });
  assert.equal(killedRun.status, 3, killedRun.stdout);
  assert.equal(JSON.parse(killedRun.stdout).killed, true);
  // P2-272 review B: exit 3 must come from the Stop switch in this temp HOME (~/.wk/KILL), not from another failure.
  assert.equal(JSON.parse(killedRun.stdout).reason, 'kill_switch');
});
