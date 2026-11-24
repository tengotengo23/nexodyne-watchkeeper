#!/usr/bin/env node
// wk-skill-sync (v0.8.0): Daily automatic discovery & sync of trending, highest-used, and
// highest-rated GitHub AI agent skill libraries into ~/.gemini/skill-vault/ and ~/.wk/skill-sync.json.
//   wk-skill-sync run [--force] [--daily] [--no-clone] [--max-new N] [--min-stars N] [--json]
//   wk-skill-sync status [--json]
//   wk-skill-sync sources [--json]   -> every source with status and skill count
//   wk-skill-sync approve|reject <owner/repo>   -> owner decision (reject never deletes files)
//   wk-skill-sync pending [--json]   -> staged sources waiting for the owner's OK (never indexed)
//   wk-skill-sync approve <slug>     -> approve, then index that one source only
//   wk-skill-sync expose|unexpose <skill>, exposed [--json]   -> single skills both IDEs may see
//   wk-skill-sync install-links|uninstall-links   -> links for Claude Code + Antigravity (backed up, undone exactly)
//   wk-skill-sync install        -> sets up macOS launchd daily job (every 24h + login)
//   wk-skill-sync uninstall      -> disables the daily launchd job (backs up plist)
// Exit: 0 ok, 1 error, 2 bad usage, 3 `run` while the Stop switch (~/.wk/KILL) is on. Other commands: neutral, exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gates, homeWk, killOn, root } from './lib.mjs';
import { findPython } from './antigravity-lib.mjs';
import { findNode } from './wk-ask-claude.mjs';
import { runDetachedCommandSync } from './wk-watchdog.mjs';
import * as expose from './skill-expose.mjs';

export const LABEL = 'com.nexodyne.watchkeeper-skill-sync';
const EVERY_S = 86400; // once per day
const SELF = fileURLToPath(import.meta.url);
const HOME = os.homedir();
const tilde = p => (p && p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const firstLine = s => String(s || '').trim().split('\n')[0].slice(0, 240);
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// The owner's own skills carry this slug in the index; no source may use it.
const LOCAL_SLUG = 'local-installed';
const RESERVED_SLUG_MESSAGE = "The source name 'local-installed' is reserved for skills installed on this computer; give that source another slug in sources.json.";
// After any change to which sources count, the exposed links follow the gate at once.
const refreshLinks = env => expose.refresh(env);

const agentsDir = () => path.resolve(process.env.WK_LAUNCH_AGENTS || path.join(HOME, 'Library', 'LaunchAgents'));
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Every child goes through the process-group runner (wk-watchdog), never a bare spawn.
export function runGrouped(bin, args, { env = process.env, timeoutMs = 30000, cwd } = {}) {
  const r = runDetachedCommandSync([bin, ...args].map(shq).join(' '), { env, timeoutMs, idleMs: timeoutMs, cwd: cwd || root() });
  return { status: r.timedOut ? null : r.status, signal: r.timedOut ? 'SIGKILL' : null, stdout: r.stdout || '', stderr: r.stderr || '', error: r.errorMessage ? new Error(r.errorMessage) : null };
}
const launchctl = args => runGrouped(process.env.WK_LAUNCHCTL || '/bin/launchctl', args, { timeoutMs: 30000 });
const domain = () => `gui/${process.getuid()}`;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const syncStatusFile = (wk = homeWk()) => path.join(wk, 'skill-sync.json');
export const syncLockFile = (wk = homeWk()) => path.join(wk, 'skill-sync.lock');
export const syncLogFile = (wk = homeWk()) => path.join(wk, 'skill-sync.log');
const LOCK_STALE_MS = 2 * 3600 * 1000;
const DETAIL_MAX = 8192;

const vaultDirOf = (env = process.env) => (env.REPROMPT_SKILL_VAULT_DIR
  ? path.resolve(env.REPROMPT_SKILL_VAULT_DIR)
  : path.join(env.HOME || HOME, '.gemini', 'skill-vault'));
const sourcesFileOf = env => path.join(vaultDirOf(env), 'sources.json');

function readJson(f, fallback = null) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const tail = (s, n = DETAIL_MAX) => { const t = String(s || ''); return t.length > n ? t.slice(t.length - n) : t; };

// Exclusive-create lock; a lock older than 2 h is stale and is taken over.
export function acquireSyncLock({ env = process.env, now = Date.now() } = {}) {
  const wk = path.resolve(env.WK_HOME || homeWk());
  const lf = syncLockFile(wk);
  fs.mkdirSync(wk, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lf, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      fs.closeSync(fd);
      return { ok: true, file: lf, release: () => { try { fs.unlinkSync(lf); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, file: lf, error: e.message };
      let age = 0;
      try { age = now - fs.statSync(lf).mtimeMs; } catch { continue; }
      if (age <= LOCK_STALE_MS) return { ok: false, file: lf, held: true, age_ms: age };
      try { fs.unlinkSync(lf); } catch { /* raced */ }
    }
  }
  return { ok: false, file: lf, held: true };
}

function logSync(wk, text) {
  try {
    fs.mkdirSync(wk, { recursive: true, mode: 0o700 });
    fs.appendFileSync(syncLogFile(wk), `[${new Date().toISOString()}] ${text}\n`);
  } catch { /* log is best effort */ }
}

function recordSyncError(wk, message, detail) {
  const at = new Date().toISOString();
  const d = tail(detail);
  logSync(wk, `ERROR ${message}\n${d}`);
  const sf = syncStatusFile(wk);
  const cur = readJson(sf, {}) || {};
  cur.last_error = { at, message, detail: d };
  try { writeJsonAtomic(sf, cur); } catch { /* best effort */ }
}

function clearSyncError(wk) {
  const sf = syncStatusFile(wk);
  const cur = readJson(sf, null);
  if (cur && cur.last_error) { delete cur.last_error; try { writeJsonAtomic(sf, cur); } catch { /* best effort */ } }
}

export function listSources({ env = process.env } = {}) {
  const vault = vaultDirOf(env);
  const src = readJson(sourcesFileOf(env), { repos: [] }) || { repos: [] };
  const idx = readJson(path.join(vault, 'index.json'), {}) || {};
  const counts = {};
  for (const k of Array.isArray(idx.skills) ? idx.skills : []) counts[k.slug] = (counts[k.slug] || 0) + 1;
  return (src.repos || []).filter(r => r && r.repo).map(r => ({
    repo: r.repo,
    slug: r.slug,
    status: r.status || (r.approved === true ? 'approved' : 'staged'),
    approved: r.approved === true,
    skills: counts[r.slug] || 0,
  }));
}

export function setSourceDecision(repo, decision, { env = process.env, now = new Date() } = {}) {
  const f = sourcesFileOf(env);
  const data = readJson(f, null);
  if (!data || !Array.isArray(data.repos)) return { ok: false, code: 1, message: `sources.json not readable at ${tilde(f)}` };
  const want = String(repo).toLowerCase();
  if (want === LOCAL_SLUG) return { ok: false, code: 1, message: RESERVED_SLUG_MESSAGE };
  // The slug first, the same as the gate; the repo name only when no slug matches.
  const hit = data.repos.find(r => r && String(r.slug || '').toLowerCase() === want)
    || data.repos.find(r => r && String(r.repo).toLowerCase() === want);
  if (!hit) return { ok: false, code: 1, message: `unknown source ${repo}` };
  if (String(hit.slug || '').toLowerCase() === LOCAL_SLUG) return { ok: false, code: 1, message: RESERVED_SLUG_MESSAGE };
  const iso = now.toISOString();
  if (decision === 'approve') Object.assign(hit, { approved: true, status: 'approved', approved_at: iso });
  else Object.assign(hit, { approved: false, status: 'rejected', rejected_at: iso });
  writeJsonAtomic(f, data);
  const clone = path.join(vaultDirOf(env), 'repos', String(hit.slug || ''));
  return { ok: true, code: 0, repo: hit.repo, slug: hit.slug, status: hit.status,
    ...(decision === 'reject' ? { clone_path: clone, cloned: fs.existsSync(clone) } : {}),
    message: decision === 'approve'
      ? `${hit.repo} approved: it is indexed at the next sync or index rebuild.`
      : `${hit.repo} rejected: never indexed or loaded (files stay on disk${fs.existsSync(clone) ? ` at ${clone}` : ''}).` };
}

function vaultPy(args, { env = process.env, timeoutMs = 120000 } = {}) {
  const py = findPython({ env });
  const script = path.join(root(), 'reprompt', 'scripts', 'skill_vault.py');
  if (!py || !fs.existsSync(script)) return { ok: false, code: 1, error: 'skill_vault.py or python3 missing' };
  const r = runGrouped(py, [script, ...args], { env, timeoutMs });
  let data = null;
  try { data = JSON.parse(String(r.stdout || '').trim()); } catch { data = null; }
  return { ok: r.status === 0 && Boolean(data), code: r.status ?? 1, data, error: data ? null : firstLine(r.stderr || r.stdout || `exit ${r.status}`) };
}

// Staged sources waiting for the owner's OK (approved-only gate: skill_vault.is_approved).
export function pendingSources({ env = process.env } = {}) {
  if (stopSwitchOn()) return { ok: true, code: 0, stopped: true, reason: 'stop_switch', count: 0, pending: [], message: STOPPED };
  const r = vaultPy(['pending', '--json'], { env, timeoutMs: 60000 });
  if (!r.ok) return { ok: false, code: 1, error: r.error };
  return { ok: true, code: 0, count: Number(r.data.count || 0), pending: r.data.pending || [] };
}

// Approve one source, then index that source only (never a full rebuild, never a clone).
export function approveAndIndex(ref, { env = process.env, now = new Date() } = {}) {
  if (stopSwitchOn()) return { ok: true, code: 0, stopped: true, reason: 'stop_switch', message: STOPPED };
  const d = setSourceDecision(ref, 'approve', { env, now });
  if (!d.ok) return d;
  const r = vaultPy(['index-source', d.slug || d.repo, '--json'], { env });
  const links = refreshLinks(env);
  if (!r.ok) return { ...d, ok: false, code: 1, indexed: 0, links, message: `${d.repo} approved, but indexing failed: ${r.error || r.data?.error || 'unknown'}` };
  const n = Number(r.data.indexed || 0);
  return { ...d, indexed: n, skill_count: r.data.skill_count, cloned: r.data.cloned, links,
    message: r.data.cloned ? `${d.repo} approved: ${n} skills indexed.` : `${d.repo} approved: not cloned yet, so 0 skills indexed (the next sync clones it).` };
}

export function rejectSource(ref, { env = process.env, now = new Date() } = {}) {
  if (stopSwitchOn()) return { ok: true, code: 0, stopped: true, reason: 'stop_switch', message: STOPPED };
  const d = setSourceDecision(ref, 'reject', { env, now });
  if (!d.ok) return d;
  // Drop any skills of this source that an older index still lists (index-source refuses unapproved; rebuild-free removal).
  vaultPy(['drop-source', d.slug || d.repo, '--json'], { env, timeoutMs: 60000 });
  // Take its skills out of Claude Code and Antigravity now, not at the next install.
  const links = refreshLinks(env);
  return { ...d, links };
}

export function skillSyncPlist({ node, script, every = EVERY_S, logFile }) {
  const pathEnv = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>run</string><string>--daily</string></array>
  <key>StartInterval</key><integer>${Math.max(3600, Math.floor(every))}</integer>
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

const STOPPED = 'Skill library stopped: the Stop switch (~/.wk/KILL) is on. Nothing was changed.';
function stopSwitchOn() {
  try {
    return killOn(gates({ allowMismatch: true }));
  } catch {
    return fs.existsSync(path.join(homeWk(), 'KILL'));
  }
}

export function readSyncStatus({ env = process.env } = {}) {
  const wk = path.resolve(env.WK_HOME || homeWk());
  const sf = syncStatusFile(wk);
  let last = null;
  try {
    last = JSON.parse(fs.readFileSync(sf, 'utf8'));
  } catch { last = null; }
  const vaultDir = env.REPROMPT_SKILL_VAULT_DIR
    ? path.resolve(env.REPROMPT_SKILL_VAULT_DIR)
    : path.join(env.HOME || HOME, '.gemini', 'skill-vault');
  let skillCount = 0;
  let repoCount = 0;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(vaultDir, 'index.json'), 'utf8'));
    skillCount = Number(idx.skill_count || 0);
    repoCount = Number(idx.repo_count || 0);
  } catch { /* unindexed */ }
  const plistFile = path.join(agentsDir(), `${LABEL}.plist`);
  return {
    scheduled_daily: fs.existsSync(plistFile),
    plist: plistFile,
    kill_switch: stopSwitchOn(), // kept for older readers; same value as stop_switch
    stop_switch: stopSwitchOn(),
    last_sync_at: last && typeof last.last_sync_at === 'string' ? last.last_sync_at : null,
    discovered_total: Number(last?.discovered_total || 0),
    added_repos: Array.isArray(last?.added_repos) ? last.added_repos : [],
    updated_repos: Number(last?.updated_repos || 0),
    total_repos: Number(last?.total_repos || repoCount),
    skill_count: Number(skillCount || last?.skill_count || 0),
    top_trending: Array.isArray(last?.top_trending) ? last.top_trending : [],
    staged: listSources({ env }).filter(x => x.status === 'staged').length,
    last_error: last && last.last_error ? last.last_error : null,
  };
}

export function runSkillSync({
  force = false,
  daily = true,
  noClone = false,
  maxNew = 6,
  minStars = 20,
  env = process.env,
} = {}) {
  if (stopSwitchOn()) {
    return { ok: false, code: 3, killed: true, stopped: true, reason: 'kill_switch', message: 'Skill sync stopped: the Stop switch (~/.wk/KILL) is on.' };
  }
  const wkHome = path.resolve(env.WK_HOME || homeWk());
  const lock = acquireSyncLock({ env });
  if (!lock.ok) {
    return { ok: false, code: 1, locked: true, error: lock.held ? 'another skill sync is running (lock held)' : `lock failed: ${lock.error}` };
  }
  try {
    return runSkillSyncLocked({ force, daily, noClone, maxNew, minStars, env, wkHome });
  } finally {
    lock.release();
  }
}

function runSkillSyncLocked({ force, daily, noClone, maxNew, minStars, env, wkHome }) {
  const py = findPython({ env });
  const script = path.join(root(), 'reprompt', 'scripts', 'skill_vault.py');
  if (!py || !fs.existsSync(script)) {
    const msg = 'skill_vault.py or python3 missing';
    recordSyncError(wkHome, msg, `python=${py || 'none'} script=${script}`);
    return { ok: false, code: 1, error: msg };
  }
  const args = [script, 'discover-trending', '--sync', '--json', '--max-new', String(maxNew), '--min-stars', String(minStars)];
  if (force || !daily) args.push('--force');
  else args.push('--daily');
  if (noClone) args.push('--no-clone');

  const r = runGrouped(py, args, { env, timeoutMs: noClone ? 45000 : 180000 });
  let data = null;
  try {
    data = JSON.parse((r.stdout || '').trim());
  } catch { data = null; }
  if (r.status === 3 || (data && data.killed)) {
    return { ok: false, code: 3, killed: true, stopped: true, reason: 'kill_switch', message: 'Skill sync stopped: the Stop switch (~/.wk/KILL) is on.' };
  }
  if (r.status !== 0 && !data) {
    const msg = firstLine(r.stderr || r.stdout || `exit ${r.status}`);
    const detail = `exit=${r.status} signal=${r.signal || ''}${r.error ? ` spawn_error=${r.error.stack || r.error.message}` : ''}\n--- stderr ---\n${tail(r.stderr, 6000)}\n--- stdout ---\n${tail(r.stdout, 1500)}`;
    recordSyncError(wkHome, msg, detail);
    return { ok: false, code: 1, error: msg };
  }
  const ok = Boolean(data ? data.ok !== false : r.status === 0);
  const code = typeof data?.exit_code === 'number' ? data.exit_code : (r.status || (ok ? 0 : 1));
  if (ok) { clearSyncError(wkHome); refreshLinks(env); }
  else recordSyncError(wkHome, firstLine(data?.error || r.stderr || 'sync reported not ok'), `exit=${r.status}\n${tail(r.stderr)}`);
  return { ok, code, ...(data || {}) };
}

export function installSkillSync({ now = new Date(), env = process.env } = {}) {
  if (process.platform !== 'darwin' && !env.WK_LAUNCH_AGENTS) {
    return {
      ok: false,
      code: 2,
      state: 'unsupported-os',
      message: `Daily skill sync launchd agent is macOS-only; run "node ${tilde(SELF)} run --daily" from cron.`,
    };
  }
  const node = findNode();
  const wk = path.resolve(env.WK_HOME || homeWk());
  const dir = path.resolve(env.WK_LAUNCH_AGENTS || path.join(HOME, 'Library', 'LaunchAgents'));
  const file = path.join(dir, `${LABEL}.plist`);
  const body = skillSyncPlist({
    node,
    script: SELF,
    every: Number(env.WK_SKILL_SYNC_EVERY_S) || EVERY_S,
    logFile: path.join(wk, 'skill-sync-launchd.log'),
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(wk, { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== body) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backup = path.join(wk, 'backups', `${LABEL}-${stamp}.plist`);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, body);
  launchctl(['bootout', `${domain()}/${LABEL}`]);
  let b;
  for (let i = 1; i <= 5; i++) {
    b = launchctl(['bootstrap', domain(), file]);
    if (b.status === 0) break;
    if (i < 5) pause(Number(env.WK_LAUNCHCTL_PAUSE_MS ?? 500));
  }
  if (!b || b.status !== 0) {
    return {
      ok: false,
      code: 1,
      state: 'launchd-refused',
      plist: file,
      message: `wk-skill-sync: launchd refused agent (${firstLine(b && b.stderr)}).`,
    };
  }
  return { ok: true, code: 0, state: 'installed', plist: file, backup };
}

export function uninstallSkillSync({ now = new Date(), env = process.env } = {}) {
  const dir = path.resolve(env.WK_LAUNCH_AGENTS || path.join(HOME, 'Library', 'LaunchAgents'));
  const file = path.join(dir, `${LABEL}.plist`);
  launchctl(['bootout', `${domain()}/${LABEL}`]);
  if (!fs.existsSync(file)) return { ok: true, code: 0, state: 'absent', message: 'Daily skill sync was not installed.' };
  const wk = path.resolve(env.WK_HOME || homeWk());
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = path.join(wk, 'backups', `${LABEL}-${stamp}.plist`);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.renameSync(file, backup);
  return { ok: true, code: 0, state: 'removed', backup, message: `Daily skill sync off (plist backed up to ${tilde(backup)}).` };
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help' };
  const o = { cmd: argv[0] || 'status', force: false, daily: true, noClone: false, json: false, maxNew: 6, minStars: 20 };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--force') { o.force = true; o.daily = false; }
    else if (x === '--daily') o.daily = true;
    else if (x === '--no-clone') o.noClone = true;
    else if (x === '--json') o.json = true;
    else if (x === '--max-new') { const v = Number(a.shift()); o.maxNew = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 6; }
    else if (x === '--min-stars') { const v = Number(a.shift()); o.minStars = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 20; }
    else if (!x.startsWith('-') && ['approve', 'reject', 'expose', 'unexpose'].includes(o.cmd) && !o.repo) o.repo = x;
    else throw new Error(`unknown option ${String(x).slice(0, 40)}`);
  }
  return o;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'help') {
      console.log('usage: wk-skill-sync run|status|sources|pending|approve|reject|expose|unexpose|exposed|install|uninstall|install-links|uninstall-links [--force] [--daily] [--no-clone] [--max-new N] [--min-stars N] [--json]');
      process.exitCode = 0;
    } else if (o.cmd === 'run') {
      const r = runSkillSync({ force: o.force, daily: o.daily, noClone: o.noClone, maxNew: o.maxNew, minStars: o.minStars });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else if (r.killed) console.log(r.message);
      else if (!r.ok) console.error(`wk-skill-sync: ${r.error || r.message || 'sync failed'}`);
      else if (r.skipped) console.log(`Skill sync: already updated today (${r.last_sync_at}); ${r.skill_count} skills indexed.`);
      else console.log(`Skill sync complete: ${r.skill_count} skills across ${r.total_repos} repos (+${(r.added_repos || []).length} trending).`);
      process.exitCode = r.code ?? (r.ok ? 0 : 1);
    } else if (o.cmd === 'status') {
      const st = readSyncStatus();
      if (o.json) console.log(JSON.stringify(st, null, 2));
      else console.log(`Daily Trending Sync: scheduled=${st.scheduled_daily} | last=${st.last_sync_at || 'never'} | skills=${st.skill_count} | repos=${st.total_repos} (+${st.added_repos.length} latest trending)`);
      process.exitCode = 0;
    } else if (o.cmd === 'sources') {
      const rows = listSources();
      if (o.json) console.log(JSON.stringify(rows, null, 2));
      else for (const x of rows) console.log(`${x.status.padEnd(9)} ${String(x.skills).padStart(5)}  ${x.repo}`);
      process.exitCode = 0;
    } else if (o.cmd === 'pending') {
      const r = pendingSources();
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else if (r.stopped) console.log(r.message);
      else if (!r.ok) console.error(`wk-skill-sync: ${r.error}`);
      else {
        console.log(`${r.count} to review`);
        for (const x of r.pending) console.log(`  ${x.slug}  ${x.repo}  (${x.stars} stars)  ${x.description || ''}\n    ${x.url}`);
      }
      process.exitCode = r.code;
    } else if (['expose', 'unexpose', 'exposed', 'install-links', 'uninstall-links'].includes(o.cmd)) {
      const r = expose.cli(o.cmd, o.repo, { stopped: stopSwitchOn() });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else (r.ok ? console.log : console.error)(r.message);
      process.exitCode = r.code;
    } else if (o.cmd === 'approve' || o.cmd === 'reject') {
      if (!o.repo) { console.error(`usage: wk-skill-sync ${o.cmd} <slug or owner/repo>`); process.exitCode = 2; }
      else {
        const r = o.cmd === 'approve' ? approveAndIndex(o.repo) : rejectSource(o.repo);
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else (r.ok ? console.log : console.error)(r.message);
        process.exitCode = r.code;
      }
    } else if (o.cmd === 'install') {
      const r = installSkillSync();
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else if (r.ok) console.log(`Daily GitHub trending skill sync on: once every 24h and at login (${tilde(r.plist)}).`);
      else console.error(r.message);
      process.exitCode = r.code;
    } else if (o.cmd === 'uninstall') {
      const r = uninstallSkillSync();
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else console.log(r.message);
      process.exitCode = r.code;
    } else {
      console.error('usage: wk-skill-sync run|status|sources|pending|approve|reject|expose|unexpose|exposed|install|uninstall|install-links|uninstall-links [--force] [--daily] [--no-clone] [--json]');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`wk-skill-sync: ${e.message}`);
    process.exitCode = 2;
  }
}
