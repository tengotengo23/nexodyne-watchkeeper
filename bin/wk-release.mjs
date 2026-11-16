#!/usr/bin/env node
// wk-release (P2-209): makes a release that other computers pick up through wk-update.
//   wk-release <X.Y.Z> [--notes "text"] [--no-push] [--dry-run]
// Checks the folder (on main, no uncommitted changes to tracked files, not behind GitHub), writes the version into the
// places that carry it (.claude-plugin/plugin.json, .claude-plugin/marketplace.json, panel/package.json, antigravity/plugins/watchkeeper/plugin.json, the README
// title, and, when the folder has them, public/README.md's title and the kit's INSTALL.html; the public copy has neither),
// runs every test suite, scans the staged files for secrets (claude-notes secret-scan.py, when it is there),
// commits "Watchkeeper vX.Y.Z", tags vX.Y.Z and pushes main and the tag. If a test fails, the version files go back to
// what they were and nothing is committed.
// While it works it holds the update lock (~/.wk/update.lock, so no update check builds the half-made version) and a hold
// file in the git folder (syncprojects.hold, so claude-notes' hourly sync does not commit the bumped files).
// Exit: 0 released, 1 refused or failed, 2 bad input.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVersion, cmpVersion, localVersion, takeLock, lockFile } from './wk-update.mjs';

const repo = path.resolve(process.env.WK_UPDATE_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCAN = process.env.WK_SECRET_SCAN ?? path.join(os.homedir(), 'Developer', 'claude-notes', 'bin', 'secret-scan.py');
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const say = s => console.log(s), stop = (s, code = 1) => { console.error(`wk-release: ${s}`); process.exit(code); };

const args = process.argv.slice(2);
const want = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--notes');
const notes = args.includes('--notes') ? args[args.indexOf('--notes') + 1] || '' : '';
const dryRun = args.includes('--dry-run'), push = !args.includes('--no-push') && !dryRun;
if (!want || !parseVersion(want) || want.startsWith('v')) stop('usage: wk-release <X.Y.Z> [--notes "text"] [--no-push] [--dry-run]', 2);

// 1. the folder
const cur = localVersion(repo);
if (!cur) stop('no readable .claude-plugin/plugin.json');
if (cmpVersion(want, cur) <= 0) stop(`${want} is not newer than the current ${cur}`);
if (git('rev-parse', '-q', '--verify', `refs/tags/v${want}`).status === 0) stop(`tag v${want} exists already`);
if (git('symbolic-ref', '--short', 'HEAD').stdout.trim() !== 'main') stop('not on main');
if (git('status', '--porcelain', '--untracked-files=no').stdout.trim()) stop('commit or put aside the changes to tracked files first (git status)');
if (push) {
  const f = git('fetch', '--quiet', 'origin', 'main');
  if (f.status !== 0) stop(`could not reach GitHub (${(f.stderr || '').trim().split('\n')[0]})`);
  if (git('merge-base', '--is-ancestor', 'origin/main', 'HEAD').status !== 0) stop('GitHub has commits this folder lacks; pull first (git pull --rebase)');
}

// 2. the version places (P2-223 added the Antigravity plugin; P2-243 public/README.md, and INSTALL.html only where it exists)
// The JSON files keep their layout: exactly one "version": "X.Y.Z" each is replaced, then the result must parse and say it.
const bumpJson = (s, f) => {
  const re = /("version"\s*:\s*")\d+\.\d+\.\d+(")/g;
  if ((s.match(re) || []).length !== 1) throw new Error(`${f} should hold exactly one "version"`);
  const t = s.replace(re, `$1${want}$2`), j = JSON.parse(t);
  if ((j.version || (j.plugins || []).find(p => p.name === 'watchkeeper')?.version) !== want) throw new Error(`${f}: the version is not where it should be`);
  return t;
};
const bumpTitle = (s, f) => { const t = s.replace(/^(# .*· v)\d+\.\d+\.\d+/, `$1${want}`); if (t === s) throw new Error(`${f} title has no "· vX.Y.Z"`); return t; };
const OPTIONAL = new Set(['public/README.md', 'panel/install/INSTALL.html']);   // bumped and checked only when the folder has them
const ALL = {
  '.claude-plugin/plugin.json': s => bumpJson(s, 'plugin.json'),
  '.claude-plugin/marketplace.json': s => bumpJson(s, 'marketplace.json'),
  'panel/package.json': s => bumpJson(s, 'panel/package.json'),
  'antigravity/plugins/watchkeeper/plugin.json': s => bumpJson(s, 'antigravity plugin.json'),
  'README.md': s => bumpTitle(s, 'README'),
  'public/README.md': s => bumpTitle(s, 'public/README.md'),
  'panel/install/INSTALL.html': s => {
    if (!s.includes(cur)) throw new Error(`INSTALL.html does not mention ${cur}`);
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return s.split(cur).join(want).replace(/(Version \d+\.\d+\.\d+ · )\d{1,2} [A-Z][a-z]+ \d{4}/, `$1${today}`);
  },
};
const FILES = Object.fromEntries(Object.entries(ALL).filter(([f]) => !OPTIONAL.has(f) || fs.existsSync(path.join(repo, f))));
const before = {};
for (const f of Object.keys(FILES)) before[f] = fs.readFileSync(path.join(repo, f), 'utf8');
const after = {};
try { for (const [f, fn] of Object.entries(FILES)) after[f] = fn(before[f]); } catch (e) { stop(e.message); }
if (dryRun) { say(`Would release ${want} (now ${cur}): ${Object.keys(FILES).join(', ')}; tests; commit; tag v${want}; push.`); process.exit(0); }

// the update lock and the sync hold, released however this ends
const lock = lockFile();
if (!takeLock(lock)) stop('an update check is running right now; try again in a minute');
const gitDir = git('rev-parse', '--absolute-git-dir').stdout.trim(), hold = gitDir && path.join(gitDir, 'syncprojects.hold');
if (hold) fs.writeFileSync(hold, `${process.pid} ${Date.now()} wk-release ${want}\n`);
process.on('exit', () => {
  for (const f of [lock, hold]) {
    try { if (f && String(fs.readFileSync(f, 'utf8')).split(/\s+/)[0] === String(process.pid)) fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  }
});
const restore = () => { for (const [f, s] of Object.entries(before)) fs.writeFileSync(path.join(repo, f), s); };
for (const [f, s] of Object.entries(after)) fs.writeFileSync(path.join(repo, f), s);

// 3. the tests (all of them; a release never skips one)
const suites = [
  ['node', ['test/run.mjs'], repo],
  ['node', ['--test', ...fs.readdirSync(path.join(repo, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => path.join('test', f))], repo],
  ['node', ['--test', ...fs.readdirSync(path.join(repo, 'panel', 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f))], path.join(repo, 'panel')],
];
for (const [cmd, a, cwd] of suites) {
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  if (r.status !== 0) {
    restore();
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    stop(`tests failed in ${path.relative(repo, cwd) || '.'} (${a.slice(0, 2).join(' ')}); the version files are back to ${cur}. Last lines:\n${tail}`);
  }
  say(`tests pass: ${path.relative(repo, cwd) || '.'} ${a[0] === '--test' ? 'node --test' : a[0]}`);
}

// 4. secret scan, commit, tag, push
if (git('add', '--', ...Object.keys(FILES)).status !== 0) { restore(); stop('git add failed'); }
if (SCAN && fs.existsSync(SCAN)) {
  const s = spawnSync('python3', [SCAN, repo, '--staged'], { encoding: 'utf8' });
  if (s.status !== 0) { git('restore', '--staged', '--', ...Object.keys(FILES)); restore(); stop(`the secret scan blocked the release:\n${(s.stdout || '').trim().split('\n').slice(-8).join('\n')}`); }
  say('secret scan: clean');
} else say('secret scan: not on this computer (claude-notes/bin/secret-scan.py), skipped');
const msg = `Watchkeeper v${want}${notes ? `\n\n${notes}` : ''}`;
const c = git('commit', '-q', '-m', msg);
if (c.status !== 0) {
  git('restore', '--staged', '--', ...Object.keys(FILES)); restore();
  stop(`commit failed: ${(c.stderr || c.stdout).trim().split('\n')[0]}; the version files are back to ${cur}`);
}
const t = git('tag', '-a', `v${want}`, '-m', `Watchkeeper v${want}`);
if (t.status !== 0) stop(`tag failed: ${(t.stderr || '').trim().split('\n')[0]} (the commit is made; tag it by hand)`);
say(`committed and tagged v${want}`);
if (!push) { say('not pushed (--no-push): git push origin main && git push origin v' + want); process.exit(0); }
for (const ref of ['main', `v${want}`]) {
  const p = git('push', '-q', 'origin', ref);
  if (p.status !== 0) stop(`push of ${ref} failed: ${(p.stderr || '').trim().split('\n')[0]}`);
}
say(`pushed main and v${want}; other computers move to it at their next check (every 3 hours, or: node bin/wk-update.mjs check)`);
