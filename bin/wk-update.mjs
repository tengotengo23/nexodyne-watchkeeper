#!/usr/bin/env node
// wk-update (P2-209): keeps Watchkeeper current on every computer that has a clone of the Watchkeeper repository.
//   wk-update [check] [--dry-run]  fetch the release tags; if a vX.Y.Z tag is newer than this folder's version, move to it
//                                  (fast-forward only, after checking the release), then make the installed copies match:
//                                  Gemini's ask-claude skill (only if it is installed) and the W panel (only in editors
//                                  where it is installed). Writes ~/.wk/update.json (the W panel shows it) and ~/.wk/update.log.
//   wk-update install [--maker]    macOS: launchd agent com.tengo.watchkeeper-update, every 3 hours and at login; runs one check.
//                                  The clone gets a role (git config wk.role). A follower (the default) sits on its own branch
//                                  `release`, and claude-notes' hourly sync leaves it alone (git config syncprojects.mode releases),
//                                  so only releases move it. The maker (--maker: the computer that runs wk-release) stays on main.
//   wk-update uninstall            stops the agent; its plist moves to ~/.wk/backups/
//   wk-update status               the last check in words
// A release is a tag: plain commits on main never move another computer (bin/wk-release.mjs makes releases).
// P2-272: a tag alone moves nothing either. A follower moves only to the release the developer signed off
// (node bin/wk-sign.mjs release vX.Y.Z writes release/channel/update.json + .sig): the signature must verify with the
// pinned key (~/.wk/release-key.pub.pem, pinned on first use) and the tag must point at the signed commit. Otherwise
// the folder stays as it is and the record's `waiting` says "waiting for an update signed by the developer" (result
// stays 'up to date'); a bad signature or a mismatched tag is a problem. The maker never moves by itself.
// The installed copies (Gemini's skill, the W panel) are made only from a folder that sits exactly on the newest release
// with nothing changed; otherwise the record says why they were left as they are.
// Never resets, stashes or cleans: with local changes, a merge in progress or its own commits, the folder stays as it is
// and the record says why. The kill switch pauses it. wk-release holds the same lock (~/.wk/update.lock) while it works.
// Exit: 0 up to date or updated, 1 a problem (recorded), 2 bad input.
// Env (tests): WK_HOME, WK_UPDATE_REPO (default: this folder), WK_IDE_CLIS (editor command lines, split by ':'),
//   WK_GEMINI_PLUGINS (default ~/.gemini/config/plugins), WK_LAUNCH_AGENTS, WK_LAUNCHCTL, WK_LAUNCHCTL_PAUSE_MS (1000),
//   WK_UPDATE_EVERY_S (10800).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinnedKey, pinProblem, pinnedKeyPath, gitChannelFile, httpsChannelFile, DEFAULT_URL, checkFile, cacheWrite, cacheRead } from './channel-lib.mjs';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABEL = 'com.tengo.watchkeeper-update';
const PANEL_ID = 'nexodyne.watchkeeper-panel';
const wkHome = () => path.resolve(process.env.WK_HOME || path.join(HOME, '.wk'));
const repoDir = () => path.resolve(process.env.WK_UPDATE_REPO || path.join(HERE, '..'));
const tilde = p => (p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
// A backup never replaces an older backup: a second one in the same second gets -2, -3, ...
const backupPath = (name, now, ext = '') => { const b = path.join(wkHome(), 'backups', `${name}-${stamp(now)}`); let p = b + ext; for (let i = 2; fs.existsSync(p); i++) p = `${b}-${i}${ext}`; return p; };

export const DEFAULT_CLIS = [
  '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
  '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
].flatMap(p => [p, path.join(HOME, p)]);
export const ideClis = (env = process.env) => (env.WK_IDE_CLIS !== undefined ? env.WK_IDE_CLIS.split(':').filter(Boolean) : DEFAULT_CLIS);

// ---------------------------------------------------------------- versions
export function parseVersion(s) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(s).trim());
  return m ? m.slice(1).map(Number) : null;
}
// A side that is not X.Y.Z counts as older than any version (two such sides are equal), so an odd value never throws.
export function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return !x && !y ? 0 : x ? 1 : -1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function newestTag(tags) {
  return tags.filter(t => /^v/.test(t) && parseVersion(t)).sort(cmpVersion).pop() || null;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const localVersion = repo => (readJson(path.join(repo, '.claude-plugin', 'plugin.json')) || {}).version || null;
const panelVersion = repo => (readJson(path.join(repo, 'panel', 'package.json')) || {}).version || null;

// ---------------------------------------------------------------- git
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' };
function git(repo, args, timeout = 60000) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || (r.error ? r.error.message : '')).trim() };
}
export const role = repo => git(repo, ['config', '--get', 'wk.role']).out || null;

// Why a fetch failed, in words that point the right way: a moved release tag is not "offline".
export function fetchProblem(err) {
  const e = String(err || ''), rej = /\[rejected\]\s+(v\d+\.\d+\.\d+)\s.*clobber/.exec(e);
  if (rej) return `release tag ${rej[1]} on GitHub is not the one this computer has (it was changed after it was made), so nothing moved; if GitHub's is right, run \`git tag -d ${rej[1]}\` in the folder and check again`;
  const line = firstLine(e);
  if (/could not resolve host|unable to access|failed to connect|could not read from remote|repository not found|authentication failed|could not read username|terminal prompts disabled|permission denied|timed out|ETIMEDOUT/i.test(e))
    return `could not reach GitHub (${line}); offline, or \`gh auth login\` is needed`;
  return `git fetch failed (${line})`;
}

// What stops a fast-forward here, in plain words; null when nothing does.
export function blocker(repo) {
  const gd = git(repo, ['rev-parse', '--absolute-git-dir']);
  if (!gd.ok) return 'this folder is not a git clone, so it cannot update itself (clone it from GitHub, or install it through Claude Code: see the README)';
  const d = gd.out, il = path.join(d, 'index.lock');
  if (fs.existsSync(il)) {
    let age = 0; try { age = Date.now() - fs.statSync(il).mtimeMs; } catch { /* gone meanwhile */ }
    return age > 3600 * 1000 ? `git has looked busy here for over an hour (${tilde(il)}); if no git command is running, delete that file by hand`
      : 'busy: git is in use by another job (next check retries)';
  }
  if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some(f => fs.existsSync(path.join(d, f)))) return 'a merge or rebase is in progress here; finish it by hand';
  if (!git(repo, ['symbolic-ref', '-q', 'HEAD']).ok) return 'the folder is not on a branch; run `git switch main` in it';
  const st = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (!st.ok) return `git status failed (${st.err.split('\n')[0].slice(0, 120)})`;
  if (st.out) return `the folder has changes that are not committed (${st.out.split('\n').length} file(s)), so it was left as it is; see \`git status\` in it`;
  return null;
}

// Unpack the release into a temp folder and check it before anything moves: its version matches the tag, and every
// script parses.
// ref: what to unpack (the signed commit id when there is one); the version inside is compared with the tag name.
export function verifyRelease(repo, tag, node = process.execPath, ref = tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-release-'));
  try {
    const arc = spawnSync('git', ['-C', repo, 'archive', '--format=tar', ref], { env: GIT_ENV, maxBuffer: 200 * 1024 * 1024 });
    if (arc.status !== 0) return `could not read release ${tag}`;
    const x = spawnSync('tar', ['-x', '-C', tmp], { input: arc.stdout });
    if (x.status !== 0) return `could not unpack release ${tag}`;
    const v = localVersion(tmp);
    if (!v || cmpVersion(v, tag) !== 0) return `release ${tag} says version ${v || 'none'} inside, so it was not installed`;
    const files = [];
    const walk = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const r = path.join(rel, e.name);
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (/\.(mjs|cjs|js)$/.test(e.name)) files.push(r);
      }
    };
    walk(tmp);
    for (const f of files) {
      const c = spawnSync(node, ['--check', path.join(tmp, f)], { encoding: 'utf8', timeout: 20000 });
      if (c.status !== 0) return `release ${tag} has a broken file (${f}), so it was not installed`;
    }
    return null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- the installed copies
function geminiStep(repo, { dryRun, node }) {
  const dest = path.resolve(process.env.WK_GEMINI_PLUGINS || path.join(HOME, '.gemini', 'config', 'plugins'));
  if (!fs.existsSync(path.join(dest, 'watchkeeper'))) return { what: 'gemini', state: 'not installed' };
  const args = [path.join(repo, 'bin', 'wk-ask-claude.mjs'), 'install-antigravity', '--dest', dest];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(node, args, { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return { what: 'gemini', state: 'failed', error: firstLine(r.stderr || r.stdout) };
  const out = r.stdout || '';
  return { what: 'gemini', state: /already up to date/.test(out) ? 'current' : dryRun ? 'would update' : 'updated' };
}
const firstLine = s => String(s || '').trim().split('\n')[0].slice(0, 160) || 'no message';
const runCli = (cli, args, timeout = 120000) => spawnSync(cli, args, { encoding: 'utf8', timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
export function installedPanel(cli) {
  const r = runCli(cli, ['--list-extensions', '--show-versions']);
  if (r.status !== 0) return { error: firstLine(r.stderr || r.error?.message) };
  const m = new RegExp(`^${PANEL_ID.replace('.', '\\.')}@(\\S+)$`, 'mi').exec(r.stdout || '');
  return { version: m ? m[1] : null };
}
function panelSteps(repo, { dryRun, node }) {
  const want = panelVersion(repo), steps = [];
  let vsix = null;
  for (const cli of ideClis()) {
    if (!fs.existsSync(cli)) continue;
    const name = path.basename(cli);
    const have = installedPanel(cli);
    if (have.error) { steps.push({ what: 'panel', ide: name, state: 'failed', error: `could not list extensions: ${have.error}` }); continue; }
    if (!have.version) continue;                                          // not installed in this editor: leave it alone
    if (have.version === want) { steps.push({ what: 'panel', ide: name, state: 'current', version: want }); continue; }
    if (dryRun) { steps.push({ what: 'panel', ide: name, state: 'would update', from: have.version, version: want }); continue; }
    if (!vsix) {
      const b = spawnSync(node, [path.join(repo, 'panel', 'scripts', 'package.mjs')], { encoding: 'utf8', timeout: 120000 });
      const f = path.join(repo, 'dist', `watchkeeper-panel-${want}.vsix`);
      if (b.status !== 0 || !fs.existsSync(f)) { steps.push({ what: 'panel', ide: name, state: 'failed', error: `could not build the panel: ${firstLine(b.stderr)}` }); break; }
      vsix = f;
    }
    const i = runCli(cli, ['--install-extension', vsix, '--force']);
    const now = installedPanel(cli).version;
    if (i.status !== 0 || now !== want) steps.push({ what: 'panel', ide: name, state: 'failed', from: have.version, error: firstLine(i.stderr || i.stdout) });
    else steps.push({ what: 'panel', ide: name, state: 'updated', from: have.version, version: want });
  }
  return steps;
}

// ---------------------------------------------------------------- one check
// One lock for a check and for wk-release: "pid time". A lock whose process is gone is cleared at once; one whose process
// still runs is cleared after two hours (a release runs every test suite, which takes minutes).
export const lockFile = () => path.join(wkHome(), 'update.lock');
export function takeLock(file = lockFile(), staleMs = 2 * 60 * 60 * 1000) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, `${process.pid} ${Date.now()}\n`, { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const [pid, t] = String(fs.readFileSync(file, 'utf8')).split(/\s+/).map(Number);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (er) { alive = er.code === 'EPERM'; }
      }
      if (alive && Date.now() - t < staleMs) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function killIsOn(repo) {
  try {
    const g = readJson(path.join(repo, 'config', 'gates.json'));
    const f = g && g.kill_switch && g.kill_switch.file;
    return !!f && fs.existsSync(f.replace(/^~(?=\/|$)/, HOME));
  } catch { return false; }
}

// The installed copies are made only from a folder that sits exactly on the newest release with nothing changed.
// Returns why they are left as they are, or null when they may follow the folder.
function holdCopies(repo, rec) {
  const rel = rec.release || rec.newest;   // P2-272: on a follower, the release the developer signed off
  if (rec.result === 'would update') return `they follow once the folder is at ${rel}`;
  if (!rel) return 'there is no release yet';
  const head = git(repo, ['rev-parse', 'HEAD']).out, at = git(repo, ['rev-parse', `${rel}^{commit}`]).out;
  if (!head || head !== at) {
    if (head && git(repo, ['merge-base', '--is-ancestor', rel, 'HEAD']).ok)
      return rec.role === 'follower'
        ? `this copy is ahead of release ${rel} (it came from main); run \`node bin/wk-update.mjs install\` once to put it on the release`
        : `this is a developer's copy, ahead of release ${rel}`;
    return `the folder is not at release ${rel}`;
  }
  return blocker(repo);
}

// P2-272: the tag this computer may move to, or null (then rec.waiting or rec.problem says why nothing moved).
// Only a release named in a manifest signed by the developer's pinned key, whose tag points at the signed commit.
// S7: the manifest comes from git (origin/main's release/channel/) and, when it is not there (a copy cloned from the
// public mirror), from the https channel (WK_CHANNEL_URL or DEFAULT_URL), verified with the same pinned key. The tag
// must match what was signed: its commit equals `commit` (a private clone), or its tree equals `public_tree` (a public
// clone, whose tags point at other commits holding the published tree). rec.signed.commit stays the commit the developer signed; rec.signed.local is the local commit checked.
export async function signedTarget(repo, rec, home = wkHome(), { fetchImpl, url = process.env.WK_CHANNEL_URL || DEFAULT_URL } = {}) {
  const exists = t => git(repo, ['rev-parse', '-q', '--verify', `refs/tags/${t}`]).ok;
  const unsigned = rec.newest && cmpVersion(rec.newest, rec.version) > 0 ? ` (tag ${rec.newest} is newer but not signed off by the developer)` : '';
  if (rec.role === 'maker') {
    if (unsigned) rec.waiting = `this computer makes releases; it does not move by itself${unsigned}`;
    return null;
  }
  const keep = () => { if (!rec.release && exists(`v${rec.version}`)) rec.release = `v${rec.version}`; };
  const key = pinnedKey({ home, repo, log: s => { rec.keyNote = s; } });
  let got = key && gitChannelFile(repo, 'update.json');
  if (key && !got) {
    const h = await httpsChannelFile(url, 'update.json', fetchImpl ? { fetchImpl } : {});
    if (h.bytes) got = h; else if (h.error) rec.channelNote = `the update channel could not be read (${h.error})`;
  }
  if (!key) {
    const bad = pinProblem(home);
    if (bad) { rec.result = 'problem'; rec.problem = `${bad}, so nothing moved`; keep(); return null; }
  }
  if (!key || !got) { rec.waiting = `waiting for an update signed by the developer${unsigned}`; keep(); return null; }
  rec.key = key.fingerprint;
  const r = checkFile('update.json', got, key.pem);
  if (r.problem) { rec.result = 'problem'; rec.problem = `${r.problem}, so nothing moved`; keep(); return null; }
  const m = r.value;
  rec.signed = { version: m.version, tag: m.tag, commit: m.commit, ...(m.public_tree ? { public_tree: m.public_tree } : {}), released_at: m.released_at };
  const at = git(repo, ['rev-parse', '-q', '--verify', `refs/tags/${m.tag}^{commit}`]).out;
  if (!at) { rec.result = 'problem'; rec.problem = `the signed release ${m.tag} has no tag here, so nothing moved`; keep(); return null; }
  let binding = null;
  if (at === m.commit) binding = 'commit';
  else if (m.public_tree && git(repo, ['rev-parse', '-q', '--verify', `${at}^{tree}`]).out === m.public_tree) binding = 'tree';   // the tree of the commit just resolved, never the tag looked up again
  if (!binding) {
    rec.result = 'problem';
    rec.problem = m.public_tree ? `tag ${m.tag} does not hold the release the developer signed (neither its commit nor its files match), so nothing moved`
      : `tag ${m.tag} does not point at the commit the developer signed, so nothing moved`;
    keep(); return null;
  }
  rec.signed.local = at; rec.signed.binding = binding;   // the local commit just checked: the one verified and merged (commit stays the one signed)
  try { cacheWrite(home, 'update.json', got.bytes, got.sig, key.pem); } catch { /* the cache is a convenience */ }
  if (cmpVersion(m.tag, rec.version) > 0) return m.tag;
  rec.release = m.tag === `v${rec.version}` || !exists(`v${rec.version}`) ? m.tag : `v${rec.version}`;
  if (rec.newest && cmpVersion(rec.newest, m.tag) > 0) rec.waiting = `waiting for an update signed by the developer (tag ${rec.newest} is newer but not signed off by the developer)`;
  return null;
}

export async function check({ dryRun = false, now = new Date(), node = process.execPath, fetchImpl } = {}) {
  const repo = repoDir(), dir = wkHome();
  const rec = { at: now.toISOString(), repo: tilde(repo), role: role(repo), version: localVersion(repo), newest: null, result: 'up to date', problem: null, held: null, moved: null, steps: [], dryRun };
  const lock = lockFile();
  if (!takeLock(lock)) return { rec: { ...rec, result: 'skipped', problem: 'another check or a release is running' }, code: 0, wrote: false };
  try {
    if (killIsOn(repo)) { rec.result = 'paused'; rec.problem = 'the kill switch is on, so nothing was checked'; return finish(rec, dir, dryRun); }
    if (!rec.version) { rec.result = 'problem'; rec.problem = 'this folder has no readable .claude-plugin/plugin.json'; return finish(rec, dir, dryRun); }
    if (!parseVersion(rec.version)) {
      rec.result = 'problem'; rec.problem = `.claude-plugin/plugin.json says version "${String(rec.version).slice(0, 40)}", which is not X.Y.Z, so nothing was checked`;
      return finish(rec, dir, dryRun);
    }
    const f = git(repo, ['fetch', '--tags', 'origin'], 90000);   // not --quiet: on a refusal git names the tag only without it
    if (!f.ok) { rec.result = 'problem'; rec.problem = fetchProblem(f.err); }
    rec.newest = newestTag(git(repo, ['tag', '-l', 'v*']).out.split('\n').filter(Boolean));   // after a failed fetch: the tags it has
    // P2-272: a follower moves only to the release the developer signed off (release/channel/update.json + .sig on
    // refs/remotes/origin/main, verified with the pinned key, its tag's commit equal to the one signed). The maker never moves by itself.
    const target = f.ok ? await signedTarget(repo, rec, undefined, { fetchImpl }) : null;
    if (target) {
      rec.release = target;
      const why = blocker(repo)
        || (git(repo, ['merge-base', '--is-ancestor', 'HEAD', rec.signed.local]).ok ? null
          : `this computer has its own commits, so it cannot simply move to ${target}; it needs a hand`)
        || verifyRelease(repo, target, node, rec.signed.local);
      if (why) { rec.result = why.startsWith('busy') ? 'skipped' : 'problem'; rec.problem = why; }
      else if (dryRun) { rec.result = 'would update'; rec.moved = { from: rec.version, to: target.slice(1) }; }
      else {
        // S6: merge the commit the developer signed (verified above), not the tag name, which could move meanwhile.
        const c = rec.signed.local;
        const m = git(repo, ['merge', '--ff-only', '--quiet', c], 15 * 60 * 1000);
        if (!m.ok) { rec.result = 'problem'; rec.problem = `the move to ${target} failed (${firstLine(m.err)}); if git status shows changes, finish it by hand: git merge --ff-only ${c}`; }
        else { rec.moved = { from: rec.version, to: localVersion(repo) }; rec.version = rec.moved.to; rec.result = 'updated'; }
      }
    }
    // The installed copies follow a released folder every time (cheap, and it heals a copy that drifted).
    rec.held = holdCopies(repo, rec);
    if (!rec.held) rec.steps.push(geminiStep(repo, { dryRun, node }), ...panelSteps(repo, { dryRun, node }));
    const bad = rec.steps.filter(s => s.state === 'failed');
    if (bad.length) {
      const t = bad.map(s => `${s.what === 'panel' ? `W panel in ${s.ide}` : "Gemini's skill"}: ${s.error}`).join('; ');
      if (rec.result === 'problem') rec.problem = `${rec.problem}; also ${t}`; else { rec.result = 'problem'; rec.problem = t; }
    }
    if (rec.result === 'up to date' && rec.steps.some(s => s.state === 'updated')) rec.result = 'updated';
    return finish(rec, dir, dryRun);
  } finally { fs.rmSync(lock, { force: true }); }
}

function finish(rec, dir, dryRun) {
  const code = rec.result === 'problem' ? 1 : 0;
  if (dryRun) return { rec, code, wrote: false };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'update.json'), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.appendFileSync(path.join(dir, 'update.log'), `${rec.at} ${rec.result} v${rec.version || '?'}${rec.moved ? ` (from ${rec.moved.from})` : ''}${rec.problem ? `: ${rec.problem}` : ''}\n`, { mode: 0o600 });
  return { rec, code, wrote: true };
}

export function words(rec) {
  if (!rec) return 'No check has run on this computer yet.';
  const when = rec.at ? new Date(rec.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'at an unknown time';
  const head = { 'up to date': `Watchkeeper ${rec.version} is up to date`, updated: rec.moved ? `Updated to ${rec.version} (was ${rec.moved.from})` : `Watchkeeper ${rec.version}: installed copies brought up to date`,
    'would update': `Would update to ${rec.moved ? rec.moved.to : rec.newest}`, skipped: `Check skipped`, paused: 'Update checks are paused', problem: `Watchkeeper ${rec.version} was not updated` }[rec.result] || rec.result;
  const steps = (rec.steps || []).filter(s => s.state !== 'not installed').map(s => (s.what === 'panel' ? `W panel in ${s.ide}: ${s.state}` : `Gemini's skill: ${s.state}`));
  const held = rec.held && rec.result !== 'paused' ? ` The W panel and Gemini's skill were left as they are: ${rec.held}.` : '';
  const waiting = rec.waiting && rec.result !== 'paused' ? ` ${rec.waiting[0].toUpperCase()}${rec.waiting.slice(1)}.` : '';
  return `${head} (checked ${when}).${rec.problem ? ` ${rec.problem[0].toUpperCase()}${rec.problem.slice(1)}.` : ''}${waiting}${held}${steps.length ? ` ${steps.join('; ')}.` : ''}`;
}

// ---------------------------------------------------------------- launchd
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function plist({ node, script, every = 10800, logFile }) {
  const pathEnv = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>check</string></array>
  <key>StartInterval</key><integer>${Math.max(600, Math.floor(every))}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
</dict>
</plist>
`;
}
const agentsDir = () => path.resolve(process.env.WK_LAUNCH_AGENTS || path.join(HOME, 'Library', 'LaunchAgents'));
const launchctl = args => spawnSync(process.env.WK_LAUNCHCTL || '/bin/launchctl', args, { encoding: 'utf8', timeout: 30000 });
const domain = () => `gui/${process.getuid()}`;

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The clone's role. A follower sits on its own branch `release` (main is kept as it was), so a copy taken from main is
// put on the newest release without moving anything back; claude-notes' sync leaves it alone. The maker stays on main.
export async function setRole(repo, want) {
  if (!git(repo, ['rev-parse', '--git-dir']).ok) return 'This folder is not a git clone, so it cannot update itself. Clone it from GitHub, or install it through Claude Code; see the README, "Install".';
  git(repo, ['config', 'wk.role', want]);
  if (want === 'maker') {
    git(repo, ['config', '--unset', 'syncprojects.mode']);
    return 'This computer makes releases: the folder stays on main and the hourly sync keeps it as before.';
  }
  git(repo, ['config', 'syncprojects.mode', 'releases']);
  const left = 'the hourly sync leaves the folder alone';
  if (git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).out === 'release') return `This computer follows releases (branch release); ${left}.`;
  git(repo, ['fetch', '--quiet', '--tags', 'origin'], 90000);
  const newest = newestTag(git(repo, ['tag', '-l', 'v*']).out.split('\n').filter(Boolean));
  if (!newest) return `This computer follows releases; there is none yet, so the folder stays where it is until the first one. ${left[0].toUpperCase()}${left.slice(1)}.`;
  const b = blocker(repo);
  if (b) return `This computer follows releases, but the folder could not be put on ${newest}: ${b}. Then run this again.`;
  const behind = git(repo, ['merge-base', '--is-ancestor', 'HEAD', newest]).ok;
  const ahead = !behind && git(repo, ['merge-base', '--is-ancestor', newest, 'HEAD']).ok;
  const known = behind || (ahead && git(repo, ['branch', '-r', '--contains', 'HEAD']).out !== '');
  if (!known) return `This folder has its own commits, so it was left on its branch. If this is the computer that makes releases, run "node bin/wk-update.mjs install --maker" instead.`;
  const exists = git(repo, ['rev-parse', '-q', '--verify', 'refs/heads/release']).ok;
  // P2-272: a copy that came from main goes back only to the release the developer signed off (the same check that
  // moves a follower later), never to a bare tag. Without a signed release the folder stays where it is.
  let at = null, commit = null;
  if (!exists && ahead) {
    // S5: the floor is the newest signed release this computer has already verified (its cache), never a bare tag.
    const home = wkHome(), k = pinnedKey({ home, repo, log: () => {} });
    const seen = k ? cacheRead(home, 'update.json', k.pem) : null;
    const rec = { role: 'follower', version: '0.0.0', newest };   // version 0.0.0: any signed release counts here, down to the floor
    at = await signedTarget(repo, rec, home);
    if (at && seen && cmpVersion(at, seen.version) < 0) return `This computer follows releases, but this computer has already seen signed release v${seen.version}; it will not go back to ${at}. The folder stays where it is.`;
    if (!at && rec.problem) return `This computer follows releases, but ${rec.problem}. ${left[0].toUpperCase()}${left.slice(1)}.`;
    if (!at) return `This computer follows releases; it is ${rec.waiting || 'waiting for an update signed by the developer'}, so the folder stays where it is. ${left[0].toUpperCase()}${left.slice(1)}.`;
    if (!git(repo, ['merge-base', '--is-ancestor', rec.signed.local, 'HEAD']).ok) return `This computer follows releases, but the signed release ${at} is not in this folder's history, so the folder stays where it is.`;
    commit = at && rec.signed.local;
    const bad = verifyRelease(repo, at, process.execPath, commit); if (bad) return `This computer follows releases, but ${bad}.`;
  }
  const s = exists ? git(repo, ['switch', '-q', 'release']) : git(repo, ['switch', '-q', '-c', 'release', ...(commit ? [commit] : [])]);
  if (!s.ok) return `This computer follows releases, but git could not switch to the branch release (${firstLine(s.err)}).`;
  return `This computer follows releases: the folder is on its own branch "release"${at ? ` at ${at}` : ''} (main is kept as it was), and ${left}.`;
}

async function install(args = [], now = new Date()) {
  if (process.platform !== 'darwin' && !process.env.WK_LAUNCH_AGENTS) {
    console.error(`wk-update: automatic checks are set up for macOS only. Here, run "node ${tilde(path.join(repoDir(), 'bin', 'wk-update.mjs'))} check" from your scheduler.`);
    return 2;
  }
  const want = args.includes('--maker') ? 'maker' : args.includes('--follower') ? 'follower' : role(repoDir()) || 'follower';
  console.log(await setRole(repoDir(), want));
  const key = pinnedKey({ home: wkHome(), repo: repoDir(), log: () => {} });
  console.log(key ? `Release key: ${key.fingerprint} (pinned in ${tilde(pinnedKeyPath(wkHome()))})` : 'No release key in this folder yet; updates wait until a release carries one.');
  const { findNode } = await import('./wk-ask-claude.mjs');
  const node = findNode();
  const file = path.join(agentsDir(), `${LABEL}.plist`);
  const body = plist({ node, script: path.join(repoDir(), 'bin', 'wk-update.mjs'), every: Number(process.env.WK_UPDATE_EVERY_S) || 10800, logFile: path.join(wkHome(), 'update-launchd.log') });
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(wkHome(), { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== body) {
      backup = backupPath(LABEL, now, '.plist');
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, backup);
    }
  }
  fs.writeFileSync(file, body);
  launchctl(['bootout', `${domain()}/${LABEL}`]);
  // bootout returns before the old job is gone, so the first bootstrap can fail ("5: Input/output error"): try again.
  let b;
  for (let i = 1; i <= 5; i++) {
    b = launchctl(['bootstrap', domain(), file]);
    if (b.status === 0) break;
    if (i < 5) pause(Number(process.env.WK_LAUNCHCTL_PAUSE_MS ?? 1000));
  }
  if (b.status !== 0) { console.error(`wk-update: launchd refused the agent five times (${firstLine(b.stderr)}). The file is ${tilde(file)}; log out and in, or run this again.`); return 1; }
  console.log(`Update checks on: every ${Math.round((Number(process.env.WK_UPDATE_EVERY_S) || 10800) / 3600)} hours and at login (launchd ${LABEL}, ${tilde(file)})${backup ? `; the old file is in ${tilde(backup)}` : ''}.`);
  console.log('The first check runs now; see it with: node ' + tilde(path.join(repoDir(), 'bin', 'wk-update.mjs')) + ' status');
  if (!args.includes('--no-graphify') && (!process.env.WK_LAUNCHCTL || process.env.WK_GRAPHIFY_ON_INSTALL === '1')) {
    const { installGraphify, graphifyWords } = await import('./wk-graphify.mjs');
    const gr = installGraphify({ now, skipCli: args.includes('--skip-graphify-cli') });
    console.log(graphifyWords(gr));
  }
  return 0;
}

function uninstall(now = new Date()) {
  const file = path.join(agentsDir(), `${LABEL}.plist`);
  launchctl(['bootout', `${domain()}/${LABEL}`]);
  if (!fs.existsSync(file)) { console.log('Update checks were not set up here; nothing to stop.'); return 0; }
  const backup = backupPath(LABEL, now, '.plist');
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.renameSync(file, backup);
  console.log(`Update checks off. The agent's file is in ${tilde(backup)}.`);
  if (role(repoDir()) === 'follower') console.log('The hourly sync still leaves this folder alone (it follows releases). To sync it again: git switch main && git config --unset syncprojects.mode');
  return 0;
}

// ---------------------------------------------------------------- command line
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: wk-update [check [--dry-run] | install [--maker] | uninstall | status]');
    process.exit(0);
  }
  const cmd = args.find(a => !a.startsWith('--')) || 'check';
  const dryRun = args.includes('--dry-run');
  let code = 2;
  if (cmd === 'check') {
    const r = await check({ dryRun });
    console.log(words(r.rec));
    code = r.code;
  } else if (cmd === 'status') { console.log(words(readJson(path.join(wkHome(), 'update.json')))); code = 0; }
  else if (cmd === 'install') code = await install(args);
  else if (cmd === 'uninstall') code = uninstall();
  else console.error('usage: wk-update [check [--dry-run] | install [--maker] | uninstall | status]');
  process.exit(code);
}
