import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wk-skill-sync.mjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2272-'));
  const vault = path.join(dir, 'vault');
  const wk = path.join(dir, 'wk');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(wk, { recursive: true });
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 1, repos: [
    { slug: 'a-a', repo: 'a/a', approved: true, status: 'approved' },
    { slug: 'b-b', repo: 'b/b', approved: false, status: 'staged' },
  ] }));
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ repo_count: 2, skill_count: 1, skills: [{ slug: 'a-a' }] }));
  const env = { ...process.env, REPROMPT_SKILL_VAULT_DIR: vault, WK_HOME: wk, WK_LAUNCH_AGENTS: path.join(dir, 'la') };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  return { dir, vault, wk, run };
}

test('sources lists status and counts; status reports staged', () => {
  const f = fixture();
  const rows = JSON.parse(f.run('sources', '--json').stdout);
  assert.deepEqual(rows.map(r => [r.repo, r.status, r.skills]), [['a/a', 'approved', 1], ['b/b', 'staged', 0]]);
  const st = JSON.parse(f.run('status', '--json').stdout);
  assert.equal(st.staged, 1);
  assert.equal(st.last_error, null);
});

test('approve and reject change flags and never delete files', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.vault, 'repos', 'b-b'), { recursive: true });
  assert.equal(f.run('approve', 'b/b').status, 0);
  let src = JSON.parse(fs.readFileSync(path.join(f.vault, 'sources.json'), 'utf8'));
  assert.equal(src.repos[1].approved, true);
  assert.equal(f.run('reject', 'b/b').status, 0);
  src = JSON.parse(fs.readFileSync(path.join(f.vault, 'sources.json'), 'utf8'));
  assert.equal(src.repos[1].status, 'rejected');
  assert.equal(src.repos[1].approved, false);
  assert.ok(fs.existsSync(path.join(f.vault, 'repos', 'b-b')));
  assert.notEqual(f.run('approve', 'no/such').status, 0);
});

test('a held lock stops a second run; a stale lock is taken over', () => {
  const f = fixture();
  const lock = path.join(f.wk, 'skill-sync.lock');
  fs.writeFileSync(lock, '{}');
  const r = f.run('run', '--no-clone', '--json');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lock/);
  assert.ok(fs.existsSync(lock));
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(lock, old, old);
  f.run('run', '--no-clone', '--json'); // takes over; result depends on python, lock must be gone after
  assert.ok(!fs.existsSync(lock));
});
