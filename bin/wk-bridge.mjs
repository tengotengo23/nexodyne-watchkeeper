#!/usr/bin/env node
// wk-bridge: the task Bridge between Claude Code and Gemini in Antigravity (P2-277).
// It moves nothing by itself and starts no agent. It tells each side, as soon as the allowed routes permit, that work waits:
//   status [--json]                      what waits for each side, the routes, the switch
//   wait --for claude|gemini [--max M]   sleep on file events (no model turns) until something waits for that side; print one
//                                        JSON line {kind,id,title,repo} and exit 0; exit 2 on the kill switch or `off`; 1 at --max
//   on | off                             Bridge on or off (marker ~/.wk/bridge/off); the kill switch (~/.wk/KILL) beats both
//   crossings [--json]                   the last 20 crossings (~/.wk/bridge/crossings.jsonl)
//   open --task <id> | --handoff <ws> [--json]
//                                        Claude side: print the exact command for a terminal in the repo; Antigravity side:
//                                        `open -a Antigravity <repo>` and `/wk-take-task` on the clipboard. Never types into an app.
// The old phone-control subcommands moved to wk-remote (3.3.0) and answer "moved to wk-remote" with exit 2.
// Nothing here starts agy, claude or gemini, and nothing reads their logins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export const bridgeDir = () => path.join(wkHome(), 'bridge');
export const crossingsFile = () => path.join(bridgeDir(), 'crossings.jsonl');
export const inboxDir = () => path.join(bridgeDir(), 'inbox');
export const claimsDir = () => path.join(bridgeDir(), 'claims');
export const chainsDir = () => path.join(bridgeDir(), 'chains');
export const offFile = () => path.join(bridgeDir(), 'off');
export const waitPidFile = side => path.join(bridgeDir(), `wait-${side}.pid`);
export const killed = () => fs.existsSync(path.join(wkHome(), 'KILL'));
export const isOn = () => !fs.existsSync(offFile());
export const MAX_CROSSINGS = 2000;
export const CLAIM_TTL_MS = 15 * 60 * 1000;
export const CHAIN_CAP = 3;            // chained tasks an hour per Claude session (Stop hook)
const TASK_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;
const PHONE = ['config', 'setup', 'run', 'trust', 'reject', 'keys', 'enable', 'disable', 'login', 'install', 'uninstall'];

const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const short = (s, n = 120) => { const t = oneLine(s) || 'untitled'; return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }
function mkdirPrivate(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }

// ---------------------------------------------------------------- crossings
// One line per crossing: {at, kind, id, from, to, event, title}. Never throws: a log must not break the work it logs.
export function touchInbox(home = wkHome()) {
  try {
    const inbox = mkdirPrivate(path.join(home, 'bridge', 'inbox'));
    fs.writeFileSync(path.join(inbox, `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`), '', { mode: 0o600 });
  } catch {}
}
export function recordCrossing({ kind = 'task', id = '', from = '', to = '', event = '', title = '' } = {}, now = new Date(), home = wkHome()) {
  try {
    mkdirPrivate(path.join(home, 'bridge'));
    const f = path.join(home, 'bridge', 'crossings.jsonl');
    const line = JSON.stringify({ at: now.toISOString(), kind: oneLine(kind), id: oneLine(id), from: oneLine(from), to: oneLine(to), event: oneLine(event), title: short(title) }) + '\n';
    fs.appendFileSync(f, line, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch {}
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > MAX_CROSSINGS) {
      const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, lines.slice(-MAX_CROSSINGS).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
  } catch {}
  touchInbox(home);
}
export function readCrossings(n = 20) {
  let lines = [];
  try { lines = fs.readFileSync(crossingsFile(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines.slice(-n)) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// ---------------------------------------------------------------- what waits
function tasks() {
  const dir = path.join(wkHome(), 'tasks');
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const id of names) {
    if (!TASK_ID.test(id)) continue;
    const m = readJson(path.join(dir, id, 'meta.json'), null);
    if (m && m.id === id) out.push(m);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
export function holdOf(id, now = Date.now()) {
  const h = readJson(path.join(wkHome(), 'tasks', id, 'hold'), null);
  if (!h || typeof h !== 'object') return null;
  if (h.until && Date.parse(h.until) <= now) return null;   // an expired hold counts as released
  return h;
}
// Held task ids over every task state (queued, taken, done...): a held taken task is the case a hold exists for.
export function heldTasks(now = Date.now()) { return tasks().filter(m => holdOf(m.id, now)).map(m => m.id); }
// Upkeep (review should-fix 2): claims and their tombstones older than a day, chain files with no stamp in the last hour.
export const PRUNE_CLAIM_MS = 24 * 3600 * 1000;
export function pruneBridge(now = Date.now(), home = wkHome()) {
  const out = { claims: 0, chains: 0 };
  const cdir = path.join(home, 'bridge', 'claims');
  let names = []; try { names = fs.readdirSync(cdir); } catch {}
  for (const n of names) {
    const f = path.join(cdir, n);
    const limit = n.endsWith('.steal') ? 3600 * 1000 : PRUNE_CLAIM_MS;   // a steal lock lives milliseconds; one an hour old is a crash's
    try { if (now - fs.statSync(f).mtimeMs > limit) { fs.rmSync(f, { force: true }); out.claims++; } } catch {}
  }
  const hdir = path.join(home, 'bridge', 'chains');
  names = []; try { names = fs.readdirSync(hdir); } catch {}
  for (const n of names) {
    const f = path.join(hdir, n);
    try {
      if (n.endsWith('.json')) {
        const at = readJson(f, {})?.at;
        const live = Array.isArray(at) && at.some(t => typeof t === 'number' && now / 1000 - t < 3600);
        if (!live) { fs.rmSync(f, { force: true }); out.chains++; }
      } else if (n.endsWith('.json.lock') && now - fs.statSync(f).mtimeMs > 3600 * 1000 && !fs.existsSync(f.slice(0, -5))) {
        fs.rmSync(f, { force: true });
      }
    } catch {}
  }
  return out;
}
function handoffs() {
  const raw = readJson(path.join(wkHome(), 'shared-workspace.json'), null);
  const ws = raw && raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {};
  const out = [];
  for (const [key, e] of Object.entries(ws)) {
    if (!e || typeof e !== 'object' || e.consumed_by) continue;
    const to = String(e.to_engine || '').toLowerCase();
    const side = to === 'claude' ? 'claude' : (to === 'antigravity' || to === 'gemini') ? 'gemini' : null;
    if (!side) continue;
    const repo = oneLine(e.workspace || key);
    out.push({ side, kind: 'handoff', id: `${repo}@${oneLine(e.updated_at || '')}`, title: short(e.title), repo, from: oneLine(e.from_engine), at: e.updated_at || null, task_id: e.task_id || null });
  }
  return out;
}
// Claude: unread handoffs addressed to Claude. Gemini: queued tasks that are not held, then unread handoffs to Antigravity.
export function waitingFor(side, now = Date.now()) {
  const hs = handoffs().filter(h => h.side === side).map(({ side: _s, ...h }) => h);
  if (side !== 'gemini') return hs;
  const ts = tasks().filter(m => m.status === 'queued' && !holdOf(m.id, now))
    .map(m => ({ kind: 'task', id: m.id, title: short(m.title), repo: oneLine(m.repo), from: oneLine(m.from), at: m.created_at || null }));
  return [...ts, ...hs];
}

// ---------------------------------------------------------------- claims and chains
// A claim is an O_EXCL file named after the item, so two Claude tabs (or a tab and the background wait) never chase one
// handoff. A claim older than 15 minutes is stale and may be taken again. hook_bus.py uses the same names.
export const claimName = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
export function claimHandoff(id, by = 'wait', now = Date.now()) {
  mkdirPrivate(claimsDir());
  const f = path.join(claimsDir(), claimName(id));
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ id, by: oneLine(by), at: new Date(now).toISOString() }) + '\n');
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let age = 0; try { age = now - fs.statSync(f).mtimeMs; } catch { continue; }
      if (age < CLAIM_TTL_MS) return false;
      // Stale: only the holder of <claim>.steal (O_EXCL) may remove it, after checking again under that lock. Nobody
      // else ever removes a claim, so a fresh claim cannot be lost; the new claim is then taken with O_EXCL like any
      // other, so exactly one claimer wins. A steal lock left by a crash is cleared by pruneBridge after an hour.
      const steal = `${f}.steal`;
      let sfd; try { sfd = fs.openSync(steal, 'wx', 0o600); } catch { return false; }
      try {
        let stale = false; try { stale = now - fs.statSync(f).mtimeMs >= CLAIM_TTL_MS; } catch { stale = true; }
        if (!stale) return false;
        try { fs.unlinkSync(f); } catch (e2) { if (e2.code !== 'ENOENT') return false; }
        try {
          const fd = fs.openSync(f, 'wx', 0o600);
          fs.writeSync(fd, JSON.stringify({ id, by: oneLine(by), at: new Date(now).toISOString() }) + '\n');
          fs.closeSync(fd);
          return true;
        } catch { return false; }
      } finally { try { fs.closeSync(sfd); } catch {} try { fs.unlinkSync(steal); } catch {} }
    }
  }
  return false;
}
export function claimedFresh(id, now = Date.now()) {
  try { return now - fs.statSync(path.join(claimsDir(), claimName(id))).mtimeMs < CLAIM_TTL_MS; } catch { return false; }
}

// ---------------------------------------------------------------- status
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function waitRoute(side = 'claude') {
  const pid = Number.parseInt(String(readJson(waitPidFile(side), {})?.pid ?? ''), 10);
  return { alive: pidAlive(pid), pid: pidAlive(pid) ? pid : null };
}
export function status(now = Date.now()) {
  const all = tasks();
  return {
    on: isOn(), killed: killed(),
    waiting: { claude: waitingFor('claude', now), gemini: waitingFor('gemini', now) },
    in_flight: all.filter(m => m.status === 'taken').map(m => ({ id: m.id, title: short(m.title) })),
    held: all.filter(m => holdOf(m.id, now)).map(m => m.id),   // any state: a held taken task is the case a hold exists for
    routes: { claude_wait: waitRoute('claude'), gemini_wait: waitRoute('gemini') },
    last_crossings: readCrossings(5),
  };
}

// ---------------------------------------------------------------- wait
// Sleeps on fs.watch (no polling, no model turns) with one safety check a minute (WK_BRIDGE_SAFETY_MS for tests).
export function wait({ side, maxMin = 0, out = s => process.stdout.write(s + '\n') }) {
  return new Promise(resolve => {
    const watchers = []; let timer = null, safety = null, deadline = null, done = false, debounce = null;
    const pidFile = waitPidFile(side);
    const finish = code => {
      if (done) return; done = true;
      for (const w of watchers) { try { w.close(); } catch {} }
      clearInterval(safety); clearTimeout(deadline); clearTimeout(debounce); clearTimeout(timer);
      try { if (readJson(pidFile, {})?.pid === process.pid) fs.unlinkSync(pidFile); } catch {}
      resolve(code);
    };
    const check = () => {
      if (done) return;
      if (killed()) { process.stderr.write('wk-bridge: the kill switch is on (~/.wk/KILL); the wait ends.\n'); return finish(2); }
      if (!isOn()) { process.stderr.write('wk-bridge: Bridge is off (wk-bridge on turns it on); the wait ends.\n'); return finish(2); }
      for (const item of waitingFor(side)) {
        if (side === 'claude' && !claimHandoff(item.id, `wait:${process.pid}`)) continue;   // another tab has it
        out(JSON.stringify({ kind: item.kind, id: item.id, title: item.title, repo: item.repo }));
        return finish(0);
      }
    };
    const soon = () => { clearTimeout(debounce); debounce = setTimeout(check, 150); };
    try {
      mkdirPrivate(bridgeDir());
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, side, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch {}
    // One watcher per folder. A watcher that errors (its folder removed, on some systems) is closed and re-added by
    // the safety check; the check runs at once so nothing is missed meanwhile.
    const dirs = [wkHome(), path.join(wkHome(), 'tasks'), bridgeDir()];
    const watching = new Map();
    const arm = () => {
      for (const d of dirs) {
        if (done || watching.has(d)) continue;
        try {
          mkdirPrivate(d);
          const w = fs.watch(d, { persistent: true }, soon);
          w.on('error', () => { try { w.close(); } catch {} watching.delete(d); const i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); soon(); });
          watching.set(d, w); watchers.push(w);
        } catch {}
      }
    };
    arm();
    const safetyMs = Math.max(50, Number(process.env.WK_BRIDGE_SAFETY_MS) || 60000);
    safety = setInterval(() => { arm(); check(); }, safetyMs);
    if (maxMin > 0) deadline = setTimeout(() => { if (!done) { process.stderr.write('wk-bridge: nothing waited within --max.\n'); finish(1); } }, maxMin * 60000);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => finish(130));
    check();
  });
}

// ---------------------------------------------------------------- open
function which(cmd) { for (const d of String(process.env.PATH || '').split(path.delimiter)) { const f = path.join(d, cmd); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} } return null; }
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function openItem({ task = '', handoff = '' }) {
  if (killed()) return { ok: false, code: 2, error: 'the kill switch is on (~/.wk/KILL); nothing opens.' };
  let side, repo, title, id;
  if (task) {
    if (!TASK_ID.test(task)) return { ok: false, code: 2, error: `not a task id: ${task}` };
    const m = readJson(path.join(wkHome(), 'tasks', task, 'meta.json'), null);
    if (!m || m.id !== task) return { ok: false, code: 2, error: `no task ${task}` };
    side = 'gemini'; repo = oneLine(m.repo); title = short(m.title); id = task;
  } else if (handoff) {
    const h = handoffs().find(x => x.repo === path.resolve(handoff) || x.repo === handoff);
    if (!h) return { ok: false, code: 2, error: `no unread handoff for ${handoff}` };
    side = h.side; repo = h.repo; title = h.title; id = h.id;
  } else return { ok: false, code: 2, error: 'usage: wk-bridge open --task <id> | --handoff <workspace>' };
  if (side === 'claude') {
    // Handoff mode with the repo named: the click takes this handoff, never a queued task (P2-277 review, must-fix 2).
    // The repo goes in double quotes inside the slash command (the command's text is pasted into a shell line), so a
    // repo path with a quote, $, backtick or backslash in it is refused rather than quoted wrongly.
    if (/["$`\\\n]/.test(repo)) return { ok: false, code: 2, error: 'the repo path has a quote, $, backtick or backslash; open it by hand' };
    const command = `claude ${shq(`/wk-take-task --handoff --cwd "${repo}"`)}`;
    return { ok: true, code: 0, side, id, title, cwd: repo, command, line: `cd ${shq(repo)} && ${command}` };
  }
  // Antigravity side: open the repo in the app and put the command on the clipboard. The owner pastes it.
  const opener = which('open'), clip = which('pbcopy');
  if (!opener) return { ok: false, code: 1, error: 'the open command is missing (macOS only)' };
  const o = spawnSync(opener, ['-a', 'Antigravity', repo], { encoding: 'utf8', timeout: 20000 });
  if (o.status !== 0) return { ok: false, code: 1, error: `open -a Antigravity failed: ${oneLine(o.stderr) || o.status}` };
  let copied = false;
  if (clip) copied = spawnSync(clip, [], { input: '/wk-take-task', encoding: 'utf8', timeout: 10000 }).status === 0;
  return { ok: true, code: 0, side: 'gemini', id, title, cwd: repo, opened: true, copied, line: `Opened ${repo} in Antigravity${copied ? '; /wk-take-task is on the clipboard: paste it into the agent chat' : ''}.` };
}

// ---------------------------------------------------------------- CLI
const USAGE = 'usage: wk-bridge status [--json] | wait --for claude|gemini [--max <minutes>] | on | off | crossings [--json] | open --task <id>|--handoff <workspace> [--json]';
function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? '') : null; }
function age(at, now = Date.now()) {
  const ms = now - Date.parse(at || ''); if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
export async function main(argv, out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n')) {
  const cmd = argv[0] || 'status';
  const json = argv.includes('--json');
  if (PHONE.includes(cmd)) {
    // One line, exit 2. Moving an old phone-control LaunchAgent is left to `wk-remote install` (review should-fix 8).
    err(`wk-bridge ${cmd}: phone control moved to wk-remote. Run: wk-remote ${cmd}`);
    return 2;
  }
  if (cmd === 'status') {
    const s = status();
    if (json) { out(JSON.stringify(s)); return 0; }
    out(`Bridge is ${s.killed ? 'stopped by the kill switch' : s.on ? 'on' : 'off'}.`);
    out(`For Claude: ${s.waiting.claude.length} waiting${s.waiting.claude.map(h => `\n  - ${h.title} (${age(h.at)})`).join('')}`);
    out(`For Gemini: ${s.waiting.gemini.length} waiting${s.waiting.gemini.map(h => `\n  - ${h.kind} ${h.kind === 'task' ? h.id + ': ' : ''}${h.title}`).join('')}`);
    out(`In flight: ${s.in_flight.length}; held: ${s.held.length}; Claude wait: ${s.routes.claude_wait.alive ? `running (pid ${s.routes.claude_wait.pid})` : 'not running'}.`);
    return 0;
  }
  if (cmd === 'on' || cmd === 'off') {
    mkdirPrivate(bridgeDir());
    if (cmd === 'off') fs.writeFileSync(offFile(), new Date().toISOString() + '\n', { mode: 0o600 });
    else { try { fs.unlinkSync(offFile()); } catch {} }
    touchInbox();
    out(`Bridge is ${cmd}.${killed() ? ' The kill switch is on, so nothing moves until it is off.' : ''}`);
    return 0;
  }
  if (cmd === 'crossings') {
    const c = readCrossings(20);
    if (json) { out(JSON.stringify(c)); return 0; }
    if (!c.length) out('No crossings yet.');
    for (const x of c) out(`${x.at}  ${x.from || '?'} -> ${x.to || '?'}  ${x.event}  ${x.kind} ${x.id}  ${x.title}`);
    return 0;
  }
  if (cmd === 'wait') {
    const side = flag(argv, '--for');
    if (side !== 'claude' && side !== 'gemini') { err(USAGE); return 2; }
    const maxRaw = flag(argv, '--max');
    const maxMin = maxRaw === null ? 0 : Number(maxRaw);
    if (!Number.isFinite(maxMin) || maxMin < 0) { err(USAGE); return 2; }
    return wait({ side, maxMin, out });
  }
  if (cmd === 'open') {
    const r = openItem({ task: flag(argv, '--task') || '', handoff: flag(argv, '--handoff') || '' });
    if (!r.ok) { err(`wk-bridge open: ${r.error}`); return r.code; }
    out(json ? JSON.stringify(r) : r.line);
    return 0;
  }
  err(USAGE);
  return 2;
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`wk-bridge: ${e.message}\n`); process.exit(1); });
