#!/usr/bin/env node
// wk-watch: the 30-second checker (P2-276). It reads the Watchkeeper home folder, never the network, and starts no agent.
//   check [--json]       one pass: count queued tasks for Gemini and unread handoffs, write watch.json, notify new items once,
//                        and about every 5 minutes run the watchdog's recover pass for tasks only (`recover --surface task`,
//                        at most 10 minutes, then SIGTERM): a task the checker itself saw quiet long enough is requeued.
//   install | uninstall  the scheduler that runs `check` every 30 s: a LaunchAgent on macOS, a systemd user timer on Linux;
//                        on Windows a Task Scheduler task (WatchkeeperWatch) every 60 s, its shortest step. install --print
//                        shows the Windows command without running it.
//   status [--json]      what the last pass saw and whether the scheduler is set up.
// It never starts or drives agy, Antigravity, claude, gemini or any model: the owner (or an automation the owner set up in
// the agent itself) types /wk-take-task. With the Stop switch (KILL) on, `check` does nothing at all.
// Env (tests): WK_HOME, WK_LAUNCH_AGENTS, WK_LAUNCHCTL, WK_SYSTEMD_USER_DIR, WK_SYSTEMCTL, WK_SCHTASKS, WK_WATCH_PLATFORM (darwin|linux|win32),
//   WK_WATCH_RECOVER_S (300; 0 turns the recover pass off), WK_WATCH_NOTIFY=0 (no notifications).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { holdOf, heldTasks, pruneBridge, readCrossings, waitRoute, isOn, geminiChainOn, offered1h } from './wk-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'wk-watch.mjs');
export const LABEL = 'com.tengo.watchkeeper-watch';
export const UNIT = 'watchkeeper-watch';
export const EVERY_S = 30;
export const TASK_NAME = 'WatchkeeperWatch';
export const WIN_EVERY_S = 60;
const TASK_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;

const home = () => process.env.HOME || process.env.USERPROFILE || os.homedir();
export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(home(), '.wk'));
export const watchFile = () => path.join(wkHome(), 'watch.json');
const platform = () => process.env.WK_WATCH_PLATFORM || process.platform;
const recoverEveryMs = () => { const v = Number(process.env.WK_WATCH_RECOVER_S ?? 300); return Number.isFinite(v) ? v * 1000 : 300000; };
const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const short = s => { const t = oneLine(s) || 'untitled'; return t.length > 120 ? t.slice(0, 119) + '…' : t; };
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const backupPath = (name, now, ext = '') => { const b = path.join(wkHome(), 'backups', `${name}-${stamp(now)}`); let p = b + ext; for (let i = 2; fs.existsSync(p); i++) p = `${b}-${i}${ext}`; return p; };
const tilde = p => (p.startsWith(home() + path.sep) ? '~' + p.slice(home().length) : p);
function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }

// ---------------------------------------------------------------- reading
// Queued tasks wait for Gemini in Antigravity (the wk-task queue). Only real task folders with a readable meta count.
export function queuedTasks(dir = path.join(wkHome(), 'tasks')) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const id of names) {
    if (!TASK_ID.test(id)) continue;
    const m = readJson(path.join(dir, id, 'meta.json'), null);
    if (m && m.status === 'queued' && m.id === id) out.push({ id, title: short(m.title), ...(holdOf(id) ? { held: true } : {}) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- Bridge (P2-277)
export const inboxDir = () => path.join(wkHome(), 'bridge', 'inbox');
// Writers touch a marker in the inbox (launchd QueueDirectories runs the check at once); the check empties it, also under the
// kill switch, so launchd never spins on a non-empty queue.
export function clearInbox() {
  let n = 0;
  try { for (const f of fs.readdirSync(inboxDir())) { try { fs.rmSync(path.join(inboxDir(), f), { force: true, recursive: true }); n++; } catch {} } } catch {}
  return n;
}
const taskStaleMs = () => { const v = Number(process.env.WK_TASK_STALE_MS ?? 45 * 60 * 1000); return Number.isFinite(v) && v > 0 ? v : 45 * 60 * 1000; };
function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
// Counts, routes and the last ten crossings for the panel's Bridge card. Reads files only; starts nothing.
export function bridgeState({ now = new Date(), queued = 0, forClaude = 0 } = {}) {
  const dir = path.join(wkHome(), 'tasks');
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  const inFlight = [], stalled = [];
  for (const id of names) {
    if (!TASK_ID.test(id)) continue;
    const m = readJson(path.join(dir, id, 'meta.json'), null);
    if (!m || m.id !== id || m.status !== 'taken') continue;
    inFlight.push(id);
    // Stalled: no heartbeat (guard hooks touch it on each tool call) and no take within the watchdog's stale window.
    const last = Math.max(mtime(path.join(dir, id, 'heartbeat')), Date.parse(m.taken_at || '') || 0, mtime(path.join(dir, id, 'meta.json')));
    if (now.getTime() - last > taskStaleMs()) stalled.push(id);
  }
  const day = now.getTime() - 24 * 3600 * 1000;
  const done24 = readCrossings(MAX_READ).filter(c => c.event === 'done' && Date.parse(c.at) >= day).length;
  const autoMark = mtime(path.join(wkHome(), 'bridge', 'automation-last'));
  return {
    on: isOn(),
    counts: { queued_for_gemini: queued, waiting_for_claude: forClaude, in_flight: inFlight.length, done_24h: done24, stalled: stalled.length },
    stalled_ids: stalled,
    routes: { claude_wait: waitRoute('claude'), hooks: isOn() ? 'on' : 'off', last_automation_run: autoMark ? new Date(autoMark).toISOString() : null,
      gemini_chain: { on: geminiChainOn(), offered_1h: offered1h(now.getTime()) } },
    last_crossings: readCrossings(10),
  };
}
const MAX_READ = 2000;

// Unread handoffs in shared-workspace.json: consumed_by is empty. The key includes updated_at, so a new handoff for the
// same folder counts as a new item.
export function openHandoffs(file = path.join(wkHome(), 'shared-workspace.json')) {
  const raw = readJson(file, null);
  const ws = raw && raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {};
  const claude = [], antigravity = [];
  for (const [key, e] of Object.entries(ws)) {
    if (!e || typeof e !== 'object' || e.consumed_by) continue;
    const to = String(e.to_engine || '').toLowerCase();
    const item = { id: `${oneLine(e.workspace || key)}@${oneLine(e.updated_at || '')}`, title: short(e.title), from: oneLine(e.from_engine), task_id: e.task_id || null };
    if (to === 'claude') claude.push(item);
    else if (to === 'antigravity' || to === 'gemini') antigravity.push(item);
  }
  return { claude, antigravity };
}

// ---------------------------------------------------------------- writing
export function writeWatch(state, file = watchFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- notifications
function onPath(cmd) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try { const p = path.join(d, cmd); fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
// AppleScript gets the words as arguments (argv), never pasted into the script, so a title cannot break out of it.
const OSA = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run'];
export function notify(text, title = 'Watchkeeper') {
  if (process.env.WK_WATCH_NOTIFY === '0') return Promise.resolve('off');
  const body = oneLine(text).slice(0, 300), head = oneLine(title).slice(0, 80);
  let cmd, args;
  if (platform() === 'darwin') {
    // P2-276 review: a fixed path, never one found on PATH; WK_OSASCRIPT is the tests' seam.
    cmd = process.env.WK_OSASCRIPT || '/usr/bin/osascript';
    args = [...OSA, body, head];
  } else {
    cmd = onPath('notify-send');
    if (!cmd) return Promise.resolve('none');
    args = ['--app-name=Watchkeeper', '--', head, body];
  }
  return new Promise(res => execFile(cmd, args, { timeout: 5000, windowsHide: true }, err => res(err ? 'failed' : 'sent')));
}
export const moreWords = n => `And ${n} more waiting item${n === 1 ? '' : 's'}: see wk-watch status or the W panel.`;
export const words = {
  gemini: t => `A task waits for Gemini: ${t}. Type /wk-take-task in Antigravity.`,
  claude: t => `Gemini handed work to Claude: ${t}. Type /wk-take-task in Claude Code.`,
};

// ---------------------------------------------------------------- the recover pass
// The watchdog prints its JSON; it is captured here so `check --json` prints one JSON object only.
export const RECOVER_ARGS = ['recover', '--surface', 'task', '--json'];
export const RECOVER_OPTS = { timeoutMs: 10 * 60 * 1000, killSignal: 'SIGTERM' };
export const NOTIFY_MAX = 3;
async function recover() {
  const { runWatchdogCli } = await import('./wk-watchdog.mjs');
  const w = process.stdout.write, e = process.stderr.write;
  let out = '';
  process.stdout.write = c => { out += c; return true; };
  process.stderr.write = () => true;
  let code;
  // P2-276 review: tasks only (jobs and processes are left to the owner's own commands); up to 10 minutes, as a
  // backup can take a while, then SIGTERM; WK_WATCHDOG_CLI_TIMEOUT_MS overrides the limit.
  try { code = runWatchdogCli(RECOVER_ARGS, RECOVER_OPTS); } finally { process.stdout.write = w; process.stderr.write = e; }
  let parsed = null;
  try { parsed = JSON.parse(out); } catch {}
  const recovered = Array.isArray(parsed?.recovered) ? parsed.recovered : [];
  return { code: typeof code === 'number' ? code : null, actions: recovered.map(r => `${r.action}:${r.id}`).slice(0, 20) };
}

// ---------------------------------------------------------------- check
export async function check({ now = new Date() } = {}) {
  const t0 = process.hrtime.bigint();
  // Markers first: one written after this line runs the check again.
  clearInbox();
  if (fs.existsSync(path.join(wkHome(), 'KILL'))) return { killed: true, took_ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  const prev = readJson(watchFile(), {}) || {};
  const all = queuedTasks();
  const tasks = all.filter(t => !t.held).map(({ held: _h, ...t }) => t);
  const held = heldTasks(now.getTime());   // every state, not only queued (review must-fix 4)
  const pruned = pruneBridge(now.getTime());
  const hand = openHandoffs();
  const forGemini = [...tasks.map(t => ({ ...t, kind: 'gemini', key: `task:${t.id}` })), ...hand.antigravity.map(h => ({ ...h, kind: 'gemini', key: `handoff:${h.id}` }))];
  const forClaude = hand.claude.map(h => ({ ...h, kind: 'claude', key: `handoff:${h.id}` }));
  const seen = new Set(Array.isArray(prev.notified) ? prev.notified : []);
  const fresh = [...forGemini, ...forClaude].filter(i => !seen.has(i.key));
  // Keep only keys still waiting, so the list stays short; ids are unique, so nothing is told twice.
  const live = new Set([...forGemini, ...forClaude].map(i => i.key));
  const notified = [...[...seen].filter(k => live.has(k)), ...fresh.map(i => i.key)];

  let lastRecover = Date.parse(prev.last_recover_at || '') || 0;
  let recovery = prev.last_recover || null;
  const every = recoverEveryMs();
  const due = every > 0 && now.getTime() - lastRecover >= every;
  const state = {
    version: 1,
    checked_at: now.toISOString(),
    counts: { tasks_for_gemini: tasks.length, handoffs_for_antigravity: hand.antigravity.length, handoffs_for_claude: hand.claude.length },
    ids: { tasks_for_gemini: tasks.map(t => t.id), handoffs_for_antigravity: hand.antigravity.map(h => h.id), handoffs_for_claude: hand.claude.map(h => h.id) },
    held,
    bridge: bridgeState({ now, queued: forGemini.length, forClaude: forClaude.length }),
    notified,
    last_recover_at: lastRecover ? new Date(lastRecover).toISOString() : null,
    last_recover: recovery,
  };
  // Written before the notifications, so a crash after it never tells the same item twice.
  writeWatch(state);
  // P2-276 review: at most NOTIFY_MAX notifications per pass; the rest are summed up in one "and N more".
  const shown = fresh.slice(0, NOTIFY_MAX);
  const sent = await Promise.all(shown.map(i => notify(words[i.kind](i.title))));
  if (fresh.length > NOTIFY_MAX) sent.push(await notify(moreWords(fresh.length - NOTIFY_MAX)));
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  if (due) {
    recovery = await recover();
    lastRecover = now.getTime();
    writeWatch({ ...state, last_recover_at: now.toISOString(), last_recover: recovery });
  }
  return { killed: false, ...state, last_recover_at: lastRecover ? new Date(lastRecover).toISOString() : null, last_recover: recovery,
    new_items: fresh.map(i => ({ kind: i.kind, id: i.id, title: i.title })), notifications: sent, recovered_now: due, pruned, took_ms: Math.round(took * 10) / 10 };
}

// ---------------------------------------------------------------- scheduler
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const pathEnv = node => [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
export function plist({ node, script = SCRIPT, logFile, wkHomeEnv = process.env.WK_HOME }) {
  const env = [`<key>PATH</key><string>${xml(pathEnv(node))}</string>`, ...(wkHomeEnv ? [`<key>WK_HOME</key><string>${xml(path.resolve(wkHomeEnv))}</string>`] : [])].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>check</string></array>
  <key>StartInterval</key><integer>${EVERY_S}</integer>
  <key>QueueDirectories</key><array><string>${xml(path.join(wkHomeEnv ? path.resolve(wkHomeEnv) : path.join(home(), '.wk'), 'bridge', 'inbox'))}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>EnvironmentVariables</key><dict>${env}</dict>
</dict>
</plist>
`;
}
// systemd: ExecStart takes no shell, so paths are quoted; % is doubled (systemd's specifier sign) and $ too (P2-276 review:
// systemd expands $VAR in ExecStart, $$ is a literal $).
export const sq = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
// P2-276 review: the plist and the units are written to a temporary file and renamed, so a half-written file is never loaded.
function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try { fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o644 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
export function units({ node, script = SCRIPT, wkHomeEnv = process.env.WK_HOME }) {
  const service = `[Unit]
Description=Watchkeeper 30-second checker (reads ~/.wk, notifies; starts no agent)

[Service]
Type=oneshot
ExecStart=${sq(node)} ${sq(script)} check
Environment=${sq(`PATH=${pathEnv(node)}`)}
${wkHomeEnv ? `Environment=${sq(`WK_HOME=${path.resolve(wkHomeEnv)}`)}\n` : ''}Nice=10
`;
  const timer = `[Unit]
Description=Run the Watchkeeper checker every 30 seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

const agentsDir = () => path.resolve(process.env.WK_LAUNCH_AGENTS || path.join(home(), 'Library', 'LaunchAgents'));
const plistFile = () => path.join(agentsDir(), `${LABEL}.plist`);
const launchctl = args => spawnSync(process.env.WK_LAUNCHCTL || '/bin/launchctl', args, { encoding: 'utf8', timeout: 30000 });
const domain = () => `gui/${process.getuid()}`;
const unitDir = () => path.resolve(process.env.WK_SYSTEMD_USER_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'systemd', 'user'));
const systemctlPath = () => process.env.WK_SYSTEMCTL || onPath('systemctl');
const systemctl = args => spawnSync(systemctlPath(), ['--user', ...args], { encoding: 'utf8', timeout: 30000 });
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const firstLine = s => String(s || '').trim().split('\n')[0] || 'no reason given';

function backupIfChanged(file, body, name, now, ext) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') === body) return null;
  const b = backupPath(name, now, ext);
  fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, b);
  return b;
}

// ---------------------------------------------------------------- Windows: Task Scheduler (P2-282)
const schtasks = args => spawnSync(process.env.WK_SCHTASKS || 'schtasks', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
// The task's command: node and this script quoted, `check`, and the data folder when WK_HOME is set (a task does not inherit it).
export function schtasksCreateArgs({ node, script = SCRIPT, wkHomeEnv = process.env.WK_HOME }) {
  const tr = `"${node}" "${script}" check${wkHomeEnv ? ` --wk-home "${path.resolve(wkHomeEnv)}"` : ''}`;
  return ['/Create', '/SC', 'MINUTE', '/MO', '1', '/TN', TASK_NAME, '/TR', tr, '/F'];
}
// The same command as one line to paste into PowerShell or cmd.
export function schtasksLine(args) {
  return ['schtasks', ...args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ');
}

async function findNodeBin() {
  try { const { findNode } = await import('./antigravity-lib.mjs'); return findNode() || process.execPath; } catch { return process.execPath; }
}

export async function install(now = new Date(), { print = false } = {}) {
  const node = await findNodeBin();
  fs.mkdirSync(wkHome(), { recursive: true, mode: 0o700 });
  // launchd needs the QueueDirectories folder to exist before it loads the agent.
  fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
  if (platform() === 'darwin') {
    const file = plistFile();
    const body = plist({ node, logFile: path.join(wkHome(), 'watch-launchd.log') });
    fs.mkdirSync(agentsDir(), { recursive: true });
    const backup = backupIfChanged(file, body, LABEL, now, '.plist');
    writeAtomic(file, body);
    launchctl(['bootout', `${domain()}/${LABEL}`]);
    let b;
    for (let i = 1; i <= 5; i++) {
      b = launchctl(['bootstrap', domain(), file]);
      if (b.status === 0) break;
      if (i < 5) pause(Number(process.env.WK_LAUNCHCTL_PAUSE_MS ?? 1000));
    }
    if (b.status !== 0) { console.error(`wk-watch: launchd refused the agent five times (${firstLine(b.stderr)}). The file is ${tilde(file)}; log out and in, or run this again.`); return 1; }
    console.log(`Checker on: every ${EVERY_S} s and at login (launchd ${LABEL}, ${tilde(file)})${backup ? `; the old file is in ${tilde(backup)}` : ''}.`);
    console.log(`It reads ${tilde(wkHome())} and notifies; it starts no agent. Turn it off with: wk-watch uninstall`);
    return 0;
  }
  if (platform() === 'linux') {
    if (!systemctlPath()) {
      console.error(`wk-watch: systemd (systemctl) was not found, so the checker cannot be scheduled here. Run "node ${tilde(SCRIPT)} check" every 30 seconds from your own scheduler.`);
      return 2;
    }
    const { service, timer } = units({ node });
    const dir = unitDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = [[path.join(dir, `${UNIT}.service`), service, '.service'], [path.join(dir, `${UNIT}.timer`), timer, '.timer']];
    const backups = files.map(([f, b, ext]) => backupIfChanged(f, b, UNIT, now, ext)).filter(Boolean);
    for (const [f, b] of files) writeAtomic(f, b);
    systemctl(['daemon-reload']);
    const r = systemctl(['enable', '--now', `${UNIT}.timer`]);
    if (r.status !== 0) { console.error(`wk-watch: systemd refused the timer (${firstLine(r.stderr)}). The files are in ${tilde(dir)}.`); return 1; }
    console.log(`Checker on: every ${EVERY_S} s (systemd user timer ${UNIT}.timer in ${tilde(dir)})${backups.length ? `; old files in ${backups.map(tilde).join(', ')}` : ''}.`);
    console.log(`It reads ${tilde(wkHome())} and notifies; it starts no agent. Turn it off with: wk-watch uninstall`);
    return 0;
  }
  if (platform() === 'win32') {
    const args = schtasksCreateArgs({ node });
    const tr = args[args.indexOf('/TR') + 1];
    if (tr.length > 261) console.error(`wk-watch: the task command is ${tr.length} characters; Task Scheduler takes 261 at most. Move Watchkeeper to a shorter folder if the task does not start.`);
    if (print) { console.log(schtasksLine(args)); return 0; }
    const r = schtasks(args);
    if (r.error || r.status !== 0) { console.error(`wk-watch: Task Scheduler refused the task (${firstLine(r.stderr) || r.error?.message || 'no reason given'}). The command was: ${schtasksLine(args)}`); return 1; }
    console.log(`Checker on: every ${WIN_EVERY_S} s (Task Scheduler task ${TASK_NAME})`);
    console.log(`It reads ${tilde(wkHome())} and notifies; it starts no agent. Turn it off with: wk-watch uninstall`);
    return 0;
  }
  console.error(`wk-watch: the scheduler is set up for macOS, Linux and Windows only. Run "node ${tilde(SCRIPT)} check" every 30 seconds from your own scheduler.`);
  return 2;
}

export function uninstall(now = new Date()) {
  if (platform() === 'darwin') {
    const file = plistFile();
    launchctl(['bootout', `${domain()}/${LABEL}`]);
    if (!fs.existsSync(file)) { console.log('The checker was not set up here; nothing to stop.'); return 0; }
    const backup = backupPath(LABEL, now, '.plist');
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.renameSync(file, backup);
    console.log(`Checker off. The agent's file is in ${tilde(backup)}.`);
    return 0;
  }
  if (platform() === 'linux') {
    const dir = unitDir();
    const files = [`${UNIT}.timer`, `${UNIT}.service`].map(n => path.join(dir, n)).filter(f => fs.existsSync(f));
    if (systemctlPath()) systemctl(['disable', '--now', `${UNIT}.timer`]);
    if (!files.length) { console.log('The checker was not set up here; nothing to stop.'); return 0; }
    const moved = files.map(f => { const b = backupPath(UNIT, now, path.extname(f)); fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 }); fs.renameSync(f, b); return b; });
    if (systemctlPath()) systemctl(['daemon-reload']);
    console.log(`Checker off. The unit files are in ${moved.map(tilde).join(', ')}.`);
    return 0;
  }
  if (platform() === 'win32') {
    if (schtasks(['/Query', '/TN', TASK_NAME]).status !== 0) { console.log('The checker was not set up here; nothing to stop.'); return 0; }
    const r = schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    if (r.error || r.status !== 0) { console.error(`wk-watch: Task Scheduler did not delete ${TASK_NAME} (${firstLine(r.stderr) || r.error?.message || 'no reason given'}).`); return 1; }
    console.log(`Checker off. The Task Scheduler task ${TASK_NAME} is deleted.`);
    return 0;
  }
  console.log('The checker is scheduled on macOS, Linux and Windows only; nothing to stop here.');
  return 0;
}

export function status() {
  const w = readJson(watchFile(), null);
  const scheduler = platform() === 'darwin' ? { kind: 'launchd', file: plistFile(), installed: fs.existsSync(plistFile()) }
    : platform() === 'linux' ? { kind: 'systemd', file: path.join(unitDir(), `${UNIT}.timer`), installed: fs.existsSync(path.join(unitDir(), `${UNIT}.timer`)) }
    : platform() === 'win32' ? { kind: 'schtasks', file: `Task Scheduler: ${TASK_NAME}`, installed: schtasks(['/Query', '/TN', TASK_NAME]).status === 0 }
    : { kind: 'none', file: null, installed: false };
  return { watch: w, scheduler, kill: fs.existsSync(path.join(wkHome(), 'KILL')) };
}

// One line for wk-status.
export function statusLine(w = readJson(watchFile(), null)) {
  if (!w || !w.counts) return 'not run yet (wk-watch install sets up the 30 s checker)';
  const c = w.counts;
  return `for Gemini ${c.tasks_for_gemini ?? 0} task(s) + ${c.handoffs_for_antigravity ?? 0} handoff(s) | for Claude ${c.handoffs_for_claude ?? 0} handoff(s) | checked ${w.checked_at || 'never'}`;
}

// ---------------------------------------------------------------- command line
const USAGE = 'usage: wk-watch [check [--json] | install [--print] | uninstall | status [--json]] [--wk-home <dir>]';
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  // --wk-home <dir>: the Windows task passes the data folder this way, since a scheduled task gets no WK_HOME.
  const wi = args.indexOf('--wk-home');
  if (wi >= 0) { if (args[wi + 1]) process.env.WK_HOME = path.resolve(args[wi + 1]); args.splice(wi, 2); }
  const cmd = args.find(a => !a.startsWith('--')) || 'check';
  const json = args.includes('--json');
  let code = 0;
  if (args.includes('--help') || args.includes('-h')) console.log(USAGE);
  else if (cmd === 'check') {
    const r = await check();
    if (json) console.log(JSON.stringify(r));
    else if (r.killed) console.log('The Stop switch is on (KILL); the checker does nothing.');
    else if (r.new_items.length || r.recovered_now) console.log(`${new Date().toISOString()} ${statusLine(r)}${r.new_items.length ? ` | new: ${r.new_items.length}` : ''}${r.recovered_now ? ` | recover: ${(r.last_recover?.actions || []).join(', ') || 'nothing to do'}` : ''}`);
  } else if (cmd === 'status') {
    const s = status();
    if (json) console.log(JSON.stringify(s));
    else console.log(`Checker: ${s.scheduler.installed ? `on (${s.scheduler.kind}, ${tilde(s.scheduler.file)})` : 'not installed'}${s.kill ? ' | Stop switch ON' : ''}\nLast pass: ${statusLine(s.watch)}`);
  } else if (cmd === 'install') code = await install(new Date(), { print: args.includes('--print') });
  else if (cmd === 'uninstall') code = uninstall();
  else { console.error(USAGE); code = 2; }
  process.exit(code);
}
