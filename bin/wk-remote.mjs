#!/usr/bin/env node
// wk-remote (P2-227): the Mac end of phone control. One outbound ssh link to your own server (the server part is not published); the Mac is the judge.
//   wk-remote config --origin <https URL> --host <name or IP> [--port N] [--user NAME] [--rp-id DOMAIN] [--server-command PATH]
//                                   -> your server (there is no built-in one; until it is set, setup, run, install and enable refuse)
//   wk-remote setup                 -> makes ~/.ssh/wk_bridge_ed25519 (once) and prints the public line for the server
//   wk-remote run [--once] [--transport-cmd <exe>]   -> the link (launchd runs this); --transport-cmd replaces ssh (tests: a fake server)
//   wk-remote trust <id> · reject <id> · keys [--json]   -> phone keys (trust happens only here, on the Mac)
//   wk-remote enable · disable      -> phone control on or off (on is never possible from the phone)
//   wk-remote login panel|passkey   -> the panel's own sign-in is the only one (no Face ID), or Face ID on every command (default); only here
//   wk-remote status [--json] · install · uninstall      -> the launchd agent org.nexodyne.wk-remote
// Exit: 0 done, 1 refused or failed, 2 bad input. Files: ~/.wk/remote*.json(l) (or $WK_HOME). docs/REMOTE.md has the whole story.
// Every command from the phone: signature and allowlist checked (remote-lib), then the same code as the Antigravity panel runs it
// (panel/src/actions.js, wk-job). Everything pushed goes through the secret scan, with the home folder as "~".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { wkHome, FILES, readRemote, writeRemote, readKeys, writeKeys, readPending, writePending, logLine, Seen, checkEnvelope,
  CRED_ID, JOB_ID, p256Key, scrub, cleanCut, readJsonFile, writePrivate, INTERRUPTED, questionHash, serverProblem, serverPatch, SET_COMMAND, COMMAND_RE } from './remote-lib.mjs';
import { sshArgv, openLink, keepLinked } from './bridge-link.mjs';
import { freeMb } from './wk-job.mjs';

const SELF = new URL(import.meta.url).pathname;
const ROOT = path.resolve(path.dirname(SELF), '..');
const require = createRequire(import.meta.url);
const D = require(path.join(ROOT, 'panel', 'src', 'data.js'));
const A = require(path.join(ROOT, 'panel', 'src', 'actions.js'));
export const LABEL = 'org.nexodyne.wk-remote';
export const MAX_MODEL = 1.5 * 1024 * 1024;
const RATE = { minute: 30, day: 300 };
const MIN_PUSH = () => Number(process.env.WK_BRIDGE_MIN_PUSH_MS) || 10000;   // tests make it shorter
const HEARTBEAT = () => MIN_PUSH() * 6;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => { throw new Stop(2, m); };
const refuse = m => { throw new Stop(1, m); };
const home = () => os.homedir();
const expand = p => String(p).replace(/^~(?=\/|$)/, home());
const tilde = p => (p.startsWith(home() + '/') ? '~' + p.slice(home().length) : p);
const pad = n => String(n).padStart(2, '0');
const hhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const when = ms => { const d = new Date(ms); return Number.isFinite(ms) ? `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${hhmm(d)}` : 'an unknown time'; };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- where things are
export function orchestrationDir(remote) {
  // Only remote.json "orchestration" names it; unset means none
  return remote.orchestration ? path.resolve(expand(remote.orchestration)) : '';
}
// The Mac's name never leaves it (a hostname often carries the owner's name): hello, state and pong say this instead.
export const MAC_LABEL = 'this Mac';
export const QUESTION_CHANGED = 'That question has changed. Open it again.';
// The question's text as the push sends it (the same scrub), hashed: the push and the check before acting both use this.
export const pushedQuestionHash = (text, home) => questionHash(scrub(String(text ?? ''), { home }));
export const panelPaths = remote => ({ pluginPath: ROOT, dataDir: wkHome(), claudeDir: path.join(home(), '.claude'), orchestrationDir: orchestrationDir(remote), home: home() });
const taskRepo = remote => (remote.task_repo ? path.resolve(expand(remote.task_repo)) : orchestrationDir(remote) ? path.dirname(orchestrationDir(remote)) : '');
export const OLD_LABEL = 'org.nexodyne.wk-bridge';   // P2-277: the phone link's label until 3.3.0 (wk-bridge is now the task Bridge)
const agentsDir = () => process.env.WK_LAUNCH_AGENTS || path.join(home(), 'Library', 'LaunchAgents');
export const plistFile = () => path.join(agentsDir(), `${LABEL}.plist`);
export const oldPlistFile = () => path.join(agentsDir(), `${OLD_LABEL}.plist`);
const launchctl = () => process.env.WK_LAUNCHCTL || '/bin/launchctl';
const keygen = () => process.env.WK_SSH_KEYGEN || 'ssh-keygen';
const status = () => readJsonFile(FILES.status(), {});
const setStatus = patch => { try { writePrivate(FILES.status(), JSON.stringify({ ...status(), ...patch }, null, 2) + '\n'); } catch { /* the status is a convenience */ } };

// ---------------------------------------------------------------- the model the Mac pushes
const lowRam = remote => { const o = orchestrationDir(remote); return !!o && fs.existsSync(path.join(o, 'LOW_RAM')); };
// Over 1.5 MB: the oldest ledger and session detail go first, then the rest of the long lists; each step is logged.
const SHRINK = [
  ['ledger detail', m => { if (m.ledger) { m.ledger.top = []; m.ledger.wakeups = []; } }],
  ['session detail', m => { if (m.sessions && Array.isArray(m.sessions.sessions)) { m.sessions.more = (m.sessions.more || 0) + Math.max(0, m.sessions.sessions.length - 5); m.sessions.sessions = m.sessions.sessions.slice(0, 5); } }],
  ['inbox and advice', m => { m.inbox = []; if (m.advice) m.advice.items = []; }],
  ['Gemini and tasks', m => { if (m.gemini) m.gemini.items = []; if (m.tasks) m.tasks.items = []; }],
  ['questions and suggestions', m => { if (m.questions) m.questions.items = (m.questions.items || []).slice(0, 10); if (m.suggestions) m.suggestions.items = (m.suggestions.items || []).slice(0, 10); }],
  ['everything but jobs and the phone', m => { for (const k of Object.keys(m)) if (!['now', 'mac', 'jobs', 'phone', 'bridge', 'pluginOk', 'remote', 'statusLine', 'statusState'].includes(k)) delete m[k]; m.cut = true; }],
];
export function fitModel(model, max = MAX_MODEL, log = () => {}) {
  let s = JSON.stringify(model);
  for (const [what, fn] of SHRINK) {
    if (Buffer.byteLength(s, 'utf8') <= max) break;
    fn(model); log({ ev: 'model-cut', what, bytes: Buffer.byteLength(s, 'utf8') });
    s = JSON.stringify(model);
  }
  return model;
}
export function modelHash(model) {
  const m = JSON.parse(JSON.stringify(model));
  delete m.now; if (m.bridge) delete m.bridge.pushed_at;
  if (m.mac) m.mac.free_mb = Math.round((m.mac.free_mb || 0) / 100) * 100;
  return hash(JSON.stringify(m));
}
export async function buildModel(remote, now = Date.now(), { freeMbFn = freeMb } = {}) {
  const p = panelPaths(remote);
  const m = await D.collect({ pluginPath: p.pluginPath, dataDir: p.dataDir, claudeDir: p.claudeDir, orchestrationDir: p.orchestrationDir }, now, { home: p.home });
  delete m.host;   // each host sets its own when it renders
  delete m.paths;  // the Mac's folders are not the phone's business
  delete m.apiKeys;  // P2-278: the API keys card (saved or not, last four characters) stays on the Mac
  m.jobs = (Array.isArray(m.jobs) ? m.jobs : []).map(j => { const { tail, ...rest } = j; return rest; });   // the web fetches events itself
  const ph = m.phone || {};
  m.phone = { enabled: remote.enabled, login: remote.login, trusted: ph.trusted || [], pending: ph.pending || [] };
  m.mac = { name: MAC_LABEL, free_mb: Math.round(Number(freeMbFn()) || 0), low_ram: lowRam(remote) };
  m.bridge = { version: VERSION, pushed_at: now };
  const counter = { hidden: 0 };
  const clean = scrub(m, { home: p.home, counter });
  if (counter.hidden) logLine({ ev: 'model-hidden', count: counter.hidden });
  // each question carries the hash of its text exactly as pushed; an answer must send it back (args.q)
  if (clean.questions && Array.isArray(clean.questions.items)) for (const q of clean.questions.items) if (isObj(q) && typeof q.text === 'string') q.h = questionHash(q.text);
  return fitModel(clean, MAX_MODEL, logLine);
}

// ---------------------------------------------------------------- phone keys
const keysMessage = () => { const k = readKeys(); return { t: 'keys', trusted: k.keys.map(x => ({ id: x.id, label: x.label, added_at: x.added_at })), rejected: k.rejected }; };
const cleanLabel = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 40) || 'Phone';
export function takeKey(k, now = Date.now()) {
  if (!isObj(k) || typeof k.id !== 'string' || !CRED_ID.test(k.id)) return { ok: false, why: 'bad id' };
  if (typeof k.spki !== 'string' || k.spki.length > 400 || !p256Key(k.spki) || k.alg !== -7) return { ok: false, why: 'not an ES256 key' };
  const keys = readKeys();
  if (keys.keys.some(x => x.id === k.id) || keys.rejected.includes(k.id)) return { ok: true, answered: true };
  const p = readPending();
  if (!p.keys.some(x => x.id === k.id)) {
    p.keys.push({ id: k.id, spki: k.spki, alg: -7, label: cleanLabel(k.label), registered_at: Number.isInteger(k.registered_at) ? k.registered_at : now, seen_at: now });
    writePending(p);
    logLine({ ev: 'key-pending', key: k.id.slice(0, 8) });
  }
  return { ok: true, answered: false };
}
function findKey(list, id) {
  const hits = list.filter(x => x.id === id || (id.length >= 8 && x.id.startsWith(id)));
  return hits.length === 1 ? hits[0] : null;
}
export function trust(id, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,1400}$/.test(id)) bad('usage: wk-remote trust <id>');
  const p = readPending(), k = findKey(p.keys, id);
  if (!k) refuse('That phone key is not waiting any more.');
  const keys = readKeys();
  keys.keys = keys.keys.filter(x => x.id !== k.id).concat({ id: k.id, spki: k.spki, label: k.label, added_at: now, registered_at: k.registered_at, sign_count: 0 });
  keys.rejected = keys.rejected.filter(x => x !== k.id);
  writeKeys(keys);
  writePending({ keys: p.keys.filter(x => x.id !== k.id) });
  logLine({ ev: 'key-trusted', key: k.id.slice(0, 8) });
  return `Trusted "${k.label}" (set up ${when(k.registered_at)}). Phone control is ${readRemote().enabled ? 'on' : 'off'}.`;
}
export function reject(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,1400}$/.test(id)) bad('usage: wk-remote reject <id>');
  const p = readPending(), keys = readKeys();
  const k = findKey(p.keys, id) || findKey(keys.keys, id);
  if (!k) refuse('That phone key is not waiting any more.');
  keys.keys = keys.keys.filter(x => x.id !== k.id);
  if (!keys.rejected.includes(k.id)) keys.rejected.push(k.id);
  writeKeys(keys);
  writePending({ keys: p.keys.filter(x => x.id !== k.id) });
  logLine({ ev: 'key-rejected', key: k.id.slice(0, 8) });
  return `Rejected "${k.label}". That key can never sign a command.`;
}

// ---------------------------------------------------------------- the protocol
// P2-272: ~/.wk/KILL (or $WK_HOME/KILL, or the file gates.json names) halts every remote action except these
export const STOP_SWITCH_ON = 'Stop switch is on; the Mac did nothing. Turn it off on the Mac or from the phone first.';
const KILL_ALLOWED = new Set(['ping', 'stop-on', 'stop-off', 'job-stop']);
export const stopSwitchOn = p => {
  try { if (fs.existsSync(path.join(wkHome(), 'KILL'))) return true; } catch { return true; }
  try { return fs.existsSync(D.killFilePath(p.pluginPath, p.home)); } catch { return false; }
};
export class Bridge {
  constructor({ send, now = () => Date.now(), freeMbFn = freeMb } = {}) {
    this.send = send; this.now = now; this.freeMbFn = freeMbFn;
    this.seen = new Seen();
    this.lastHash = null; this.lastPushAt = 0; this.pushing = false; this.dirty = false;
    this.keysHash = null; this.queue = Promise.resolve(); this.hits = [];
  }
  start() {
    this.send({ t: 'hello', v: 1, wk: VERSION, mac: MAC_LABEL });
    // commands a crash cut off between "started" and the action: the phone hears they did not run (Seen, remote-lib.mjs)
    for (const id of this.seen.interrupted.splice(0)) { logLine({ ev: 'interrupted', id }); this.result(id, false, INTERRUPTED); }
    this.sendKeys(true);
    return this.pushState(true);
  }
  onLine(o) {
    if (o.t === 'cmd') { this.queue = this.queue.then(() => this.command(o.envelope)).catch(e => logLine({ ev: 'cmd-error', why: cleanCut(e.message, 200) })); return this.queue; }
    if (o.t === 'key') { const r = takeKey(o.key, this.now()); if (r.ok && r.answered) this.sendKeys(true); else if (r.ok) this.dirty = true; else logLine({ ev: 'key-refused', why: r.why }); return null; }
    logLine({ ev: 'unknown-line', t: cleanCut(o.t, 20) });
    return null;
  }
  sendKeys(force = false) {
    const m = keysMessage(), h = hash(JSON.stringify(m));
    if (!force && h === this.keysHash) return;
    if (this.send(m) !== false) this.keysHash = h;
  }
  rateOk(now) {
    this.hits = this.hits.filter(t => now - t < 86400000);
    if (this.hits.length >= RATE.day || this.hits.filter(t => now - t < 60000).length >= RATE.minute) return false;
    this.hits.push(now); return true;
  }
  result(id, ok, text) { if (id) this.send({ t: 'result', id, ok: !!ok, text: cleanCut(scrub(String(text || '')), 2000) }); }
  async command(env) {
    const now = this.now();
    const rawId = isObj(env) && isObj(env.command) && typeof env.command.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(env.command.id) ? env.command.id : null;
    const kind = isObj(env) && isObj(env.command) ? cleanCut(env.command.kind, 20) : '';
    const remote = readRemote(), keys = readKeys();
    const r = checkEnvelope(env, { remote, keys, seen: this.seen, now });
    if (r.bump && r.bump.counter > 0) {
      const k = keys.keys.find(x => x.id === r.bump.cred);
      if (k && r.bump.counter > (k.sign_count || 0)) { k.sign_count = r.bump.counter; k.used_at = now; writeKeys(keys); }
    }
    // unsigned or forged: refused without touching the phone's budget, so a flood of them cannot lock the owner out
    if (!r.verified) { logLine({ ev: 'refused', id: r.id || rawId, kind, reason: r.reason }); return this.result(r.id || rawId, false, r.reason); }
    if (r.stored && r.stored.status === 'started') { logLine({ ev: 'repeat-running', id: r.id }); return null; }   // its result follows
    if (r.stored) { logLine({ ev: 'repeat', id: r.id }); return this.result(r.id, r.stored.ok, r.stored.text); }
    // only a verified command counts against the budget; refused for the rate, it is seen, so it never runs later
    if (!this.rateOk(now)) {
      const why = 'Too many commands from the phone. Wait a minute.';
      logLine({ ev: 'refused', id: r.id || rawId, kind, reason: 'rate' });
      if (r.id) this.seen.add(r.id, { ok: false, text: why }, r.hash, now);
      return this.result(r.id || rawId, false, why);
    }
    if (!r.ok) {
      logLine({ ev: 'refused', id: r.id || rawId, kind, reason: r.reason });
      if (r.verified && r.id) this.seen.add(r.id, { ok: false, text: r.reason }, r.hash, now);
      return this.result(r.id || rawId, false, r.reason);
    }
    // at most once: the id is on disk as "started" before the action, so a crash and a re-delivery never act twice
    if (!this.seen.start(r.id, r.hash, now)) { logLine({ ev: 'refused', id: r.id, kind, reason: 'seen-write' }); return this.result(r.id, false, 'The Mac could not record the command, so it did not act. Send it again.'); }
    if (process.env.WK_BRIDGE_TEST_CRASH === 'after-seen') process.kill(process.pid, 'SIGKILL');   // tests only: a crash between seen and the action
    let out;
    try { out = await this.act(r.command, remote); } catch (e) { out = { ok: false, text: `That did not work on the Mac: ${cleanCut(e.message, 200)}` }; }
    const text = cleanCut(scrub(String(out.text || (out.ok ? 'Done.' : 'That did not work.'))), 2000);
    this.seen.add(r.id, { ok: out.ok, text }, r.hash, now);
    logLine({ ev: 'done', id: r.id, kind: r.command.kind, via: r.via, ok: !!out.ok });
    this.dirty = true;
    return this.result(r.id, out.ok, text);
  }
  // The allowlist, acted on: the same code the Antigravity panel runs.
  async act(c, remote) {
    const a = c.args, p = panelPaths(remote);
    // P2-272: while the Stop switch is on, the phone may only read (ping), turn it on or off, or stop a running job; nothing else runs
    if (stopSwitchOn(p) && !KILL_ALLOWED.has(c.kind)) { logLine({ ev: 'refused', kind: c.kind, reason: 'stop-switch' }); return { ok: false, text: STOP_SWITCH_ON }; }
    switch (c.kind) {
      case 'ping': return { ok: true, text: `pong ${MAC_LABEL} ${hhmm(new Date(this.now()))}` };
      case 'answer': {
        // bound to the question the phone showed: gone, or its text changed since (a late or reordered delivery), means no
        const same = q => !!q && typeof a.q === 'string' && pushedQuestionHash(q.text, p.home) === a.q;
        if (!same(D.findOpenQuestion(p.orchestrationDir, String(a.n)))) return { ok: false, text: QUESTION_CHANGED };
        const base = { cmd: 'answerQuestion', n: String(a.n), confirmed: a.confirmed === true, expect: same, changedText: QUESTION_CHANGED };
        return A.question(p, a.use_recommended === true ? { ...base, useRecommended: true } : { ...base, useRecommended: false, text: a.text });
      }
      case 'later': return A.question(p, { cmd: 'laterQuestion', n: String(a.n) });
      case 'suggestion': return A.suggestion(p, { id: a.id, choice: a.choice, confirmed: a.confirmed === true });
      case 'task': {
        const repo = taskRepo(remote);
        if (!repo) return { ok: false, text: 'The Mac has no folder set for tasks (remote.json "task_repo").' };
        return A.task(p, { title: a.title, text: a.text, kind: a.kind, ...(a.test ? { test: a.test } : {}) }, repo);
      }
      case 'send': return A.send(p, { kind: a.kind, text: a.text });
      case 'stop-on': return A.stopSwitch(p, true);
      case 'stop-off': return A.stopSwitch(p, false);
      case 'remote-off': writeRemote({ enabled: false }); return { ok: true, text: 'Phone control is off. Only the Mac can switch it on again.' };
      case 'job-stop': return A.jobStop(p, { job: a.job });
      case 'job-start': return A.jobStart(p, { project: a.project, prompt: a.prompt, model: a.model, mode: a.mode, ...(a.max_turns ? { max_turns: a.max_turns } : {}) }, 'phone');
      case 'job-reply': return A.jobReply(p, { job: a.job, prompt: a.prompt });
      default: return { ok: false, text: 'Not something the phone can do.' };
    }
  }
  // State: when it changed, at most every 10 s; otherwise every 60 s as a heartbeat.
  async pushState(force = false) {
    if (this.pushing) return false;
    const now = this.now();
    if (!force && now - this.lastPushAt < MIN_PUSH()) return false;
    this.pushing = true;
    try {
      const remote = readRemote();
      const model = await buildModel(remote, now, { freeMbFn: this.freeMbFn });
      const h = modelHash(model);
      if (!force && h === this.lastHash && now - this.lastPushAt < HEARTBEAT()) return false;
      if (this.send({ t: 'state', model }) === false) return false;
      this.lastHash = h; this.lastPushAt = now; this.dirty = false;
      setStatus({ last_push_at: now });
      return true;
    } catch (e) { logLine({ ev: 'push-error', why: cleanCut(e.message, 200) }); return false; } finally { this.pushing = false; }
  }
  // Job events: the new ones since the last push, batched (one message per job per second at most).
  pushJobs() {
    let ids; try { ids = fs.readdirSync(path.join(wkHome(), 'jobs')).filter(x => JOB_ID.test(x)).sort().slice(-50); } catch { return 0; }
    let sent = 0;
    for (const id of ids) {
      const dir = path.join(wkHome(), 'jobs', id);
      const meta = readJsonFile(path.join(dir, 'meta.json'), null);
      if (!meta || !Number.isInteger(meta.events)) continue;
      const pf = path.join(dir, 'pushed.json'), done = (readJsonFile(pf, {}).n) || 0;
      if (meta.events <= done) continue;
      const events = []; let bytes = 0;
      for (const e of readEventsAfter(path.join(dir, 'events.jsonl'), done)) {
        const s = JSON.stringify(e); if (events.length && bytes + s.length > 1024 * 1024) break;
        events.push(scrub(e)); bytes += s.length;
        if (events.length >= 200) break;
      }
      if (!events.length) continue;
      if (this.send({ t: 'job', job: id, events }) === false) break;
      try { writePrivate(pf, JSON.stringify({ n: events[events.length - 1].n }) + '\n'); } catch { /* sent again next time; the n tells the copies apart */ }
      sent++;
      if (meta.state !== 'running') this.dirty = true;
    }
    if (sent) this.dirty = true;
    return sent;
  }
  async tick() {
    this.pushJobs();
    this.sendKeys();
    const now = this.now();
    if ((this.dirty && now - this.lastPushAt >= MIN_PUSH()) || now - this.lastPushAt >= HEARTBEAT()) await this.pushState(true);
    else await this.pushState(false);
  }
}
function readEventsAfter(file, after) {
  let s; try { s = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of s.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (e && Number.isInteger(e.n) && e.n > after) out.push(e); } catch { /* a partial line */ } }
  return out;
}

// ---------------------------------------------------------------- run: keep the link and the bridge going
export async function run({ once = false, transportCmd = null } = {}) {
  let stopping = false, link = null;
  const quit = () => { stopping = true; if (link) link.close(); };
  process.on('SIGTERM', quit); process.on('SIGINT', quit);
  setStatus({ pid: process.pid, started_at: Date.now(), connected: false });
  const connect = async () => {
    const remote = readRemote();
    let file, args;
    const noServer = serverProblem(remote);
    if (noServer) { logLine({ ev: 'link-error', why: 'no server set' }); setStatus({ connected: false, last_error: noServer }); return; }
    if (transportCmd) { file = transportCmd; args = []; }
    else {
      const key = path.resolve(expand(remote.key));
      if (!fs.existsSync(key)) { logLine({ ev: 'link-error', why: 'no key: run wk-remote setup' }); setStatus({ connected: false, last_error: 'No key yet: run wk-remote setup.' }); return; }
      try { args = sshArgv(remote, key); } catch (e) { logLine({ ev: 'link-error', why: e.message }); setStatus({ connected: false, last_error: e.message }); return; }
      file = process.env.WK_SSH_BIN || 'ssh';
    }
    const bridge = new Bridge({ send: o => (link ? link.send(o) : false) });
    link = openLink({ file, args, onLine: o => bridge.onLine(o), log: o => logLine(o) });
    const t0 = Date.now();
    setStatus({ connected: true, connected_at: t0, last_error: null });
    logLine({ ev: 'link-open' });
    let ticking = false;
    const timer = setInterval(async () => { if (ticking || !link.open) return; ticking = true; try { await bridge.tick(); } finally { ticking = false; } }, Number(process.env.WK_BRIDGE_TICK_MS) || 1000);
    bridge.start().catch(() => {});
    const end = await link.closed;
    clearInterval(timer);
    await bridge.queue.catch(() => {});
    link = null;
    const why = end.err || (end.code != null ? `the link ended (exit ${end.code})` : `the link ended (${end.signal || 'closed'})`);
    logLine({ ev: 'link-closed', why: cleanCut(why, 200), up_s: Math.round((Date.now() - t0) / 1000) });
    setStatus({ connected: false, last_close_at: Date.now(), last_error: cleanCut(why, 200) });
  };
  if (once) await connect();
  else {
    const base = Number(process.env.WK_BRIDGE_BACKOFF_MS) || undefined;
    await keepLinked({ connect, stopped: () => stopping, base, max: base ? base * 4 : undefined, onWait: ms => setStatus({ retry_in_s: Math.round(ms / 1000) }) });
  }
  setStatus({ connected: false, pid: null });
  return 0;
}

// ---------------------------------------------------------------- setup, install, the rest of the command line
// The authorized_keys line: the key may only run the server's own command (remote.json "server_command", checked by COMMAND_RE).
const pubLine = (command, b64) => `restrict,command="${command}" ssh-ed25519 ${b64} wk-remote`;
// The commands that reach the server (or start the link) refuse until `wk-remote config` has set one.
const needServer = (r = readRemote()) => { const p = serverProblem(r); if (p) refuse(p); return r; };
export function setup(out) {
  const remote = needServer();
  if (!remote.server_command) refuse(SET_COMMAND);
  if (!COMMAND_RE.test(remote.server_command)) refuse('server_command in remote.json must be an absolute path (letters, digits, dots, underscores, dashes and slashes only): wk-remote config --server-command PATH');
  const key = path.resolve(expand(remote.key));
  if (!fs.existsSync(key)) {
    fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
    const r = spawnSync(keygen(), ['-t', 'ed25519', '-N', '', '-C', 'wk-remote', '-q', '-f', key], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0 || !fs.existsSync(key)) refuse(`ssh-keygen did not make the key: ${cleanCut((r.stderr || r.error?.message || '').trim(), 200)}`);
    out(`Made the key ${tilde(key)}.`);
  } else out(`The key ${tilde(key)} is already there (kept).`);
  fs.chmodSync(key, 0o600);
  const pub = String(fs.readFileSync(key + '.pub', 'utf8')).trim();
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(pub);
  if (!m) refuse(`${tilde(key)}.pub is not an ed25519 public key.`);
  const target = remote.port === 22 ? remote.host : `[${remote.host}]:${remote.port}`;
  const k = spawnSync(keygen(), ['-F', target], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (k.status !== 0) out(`The server's host key is not in ~/.ssh/known_hosts yet. Connect once by hand (ssh ${remote.user}@${remote.host}) and check the fingerprint, or the link will refuse it.`);
  out(`The public line for the server (it is not a secret; add it to ~${remote.user}/.ssh/authorized_keys there):`);
  out(pubLine(remote.server_command, m[1]));
  return 0;
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function plistText() {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home(), ...(process.env.WK_HOME ? { WK_HOME: process.env.WK_HOME } : {}) };
  const log = path.join(wkHome(), 'remote.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(SELF)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
const domain = () => `gui/${process.getuid ? process.getuid() : 501}`;
const lctl = args => spawnSync(launchctl(), args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
function backup(file) {
  const dir = path.join(wkHome(), 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const to = path.join(dir, `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(file, to);
  return to;
}
// Review fix 5: the plist is written to <plist>.tmp-<pid> with mode 0644, then renamed, so launchd never reads half a file.
export function writePlist(f, text = plistText()) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, f);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
// Review should-fix 6: the old agent is the one whose ProgramArguments run <...>/bin/wk-bridge.mjs with the argument run,
// not any plist that merely mentions the file name.
export function programArguments(text) {
  const m = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(text || ''));
  if (!m) return [];
  const unxml = v => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(x => unxml(x[1]).trim());
}
export function isOldPhoneAgent(text) {
  const a = programArguments(text);
  const i = a.findIndex(x => /(^|\/)bin\/wk-bridge\.mjs$/.test(x));
  return i >= 0 && a[i + 1] === 'run';
}
// P2-277: the phone link was wk-bridge until 3.3.0. An old agent that runs wk-bridge.mjs is backed up to ~/.wk/backups, removed
// and stopped. With { start: true } (the old agent itself, waking after an update) the wk-remote agent is written and started
// first, when a server is set. bootout comes last: when the old agent runs this, it stops itself there.
export function migrateOldAgent(out = () => {}, { start = false } = {}) {
  const old = oldPlistFile();
  let text; try { text = fs.readFileSync(old, 'utf8'); } catch { return { migrated: false }; }
  if (!isOldPhoneAgent(text)) return { migrated: false, reason: 'not the old phone link' };
  let started = false;
  if (start && !fs.existsSync(plistFile()) && !serverProblem(readRemote())) {
    writePlist(plistFile());
    started = lctl(['bootstrap', domain(), plistFile()]).status === 0;
  }
  const to = backup(old);
  out(`Moved the old phone link ${path.basename(old)} to ${tilde(to)}${started ? '; phone control now runs as wk-remote' : ''}.`);
  lctl(['bootout', `${domain()}/${OLD_LABEL}`]);
  return { migrated: true, backup: to, started };
}
export function install(out) {
  migrateOldAgent(out);
  needServer();
  const f = plistFile();
  if (fs.existsSync(f)) { lctl(['bootout', `${domain()}/${LABEL}`]); out(`Moved the old ${path.basename(f)} to ${tilde(backup(f))}.`); }
  writePlist(f);
  fs.mkdirSync(wkHome(), { recursive: true, mode: 0o700 });
  const r = lctl(['bootstrap', domain(), f]);
  if (r.status !== 0) refuse(`launchctl did not start phone control (wk-remote): ${cleanCut((r.stderr || r.stdout || '').trim(), 200) || `exit ${r.status}`}. The file is at ${tilde(f)}.`);
  out(`Installed: phone control (wk-remote) runs now and at each login (${tilde(f)}). Phone control is ${readRemote().enabled ? 'on' : 'off'}.`);
  return 0;
}
export function uninstall(out) {
  const f = plistFile();
  if (!fs.existsSync(f)) { out('Phone control (wk-remote) is not installed.'); return 0; }
  lctl(['bootout', `${domain()}/${LABEL}`]);
  out(`Stopped phone control (wk-remote) and moved ${path.basename(f)} to ${tilde(backup(f))}.`);
  return 0;
}
export function statusLines() {
  const r = readRemote(), k = readKeys(), p = readPending(), s = status();
  const key = path.resolve(expand(r.key));
  const alive = Number.isInteger(s.pid) && (() => { try { process.kill(s.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
  const o = { enabled: r.enabled, login: r.login, trusted: k.keys.length, pending: p.keys.length, key: fs.existsSync(key), installed: fs.existsSync(plistFile()),
    running: alive, connected: alive && s.connected === true, connected_at: s.connected_at || null, last_push_at: s.last_push_at || null, last_error: s.last_error || null };
  const noServer = serverProblem(r);
  o.server = !noServer;
  const lines = [
    `Server: ${noServer ? `not set (run wk-remote config --origin https://... --host ...)` : `${r.origin}, ssh ${r.user ? `${r.user}@` : ''}${r.host}${r.port === 22 ? '' : ` port ${r.port}`}`}.`,
    `Phone control: ${o.enabled ? 'on' : 'off'}. Login: ${o.login === 'panel' ? 'the panel\'s own sign-in (no Face ID)' : 'Face ID'}. Trusted phone keys: ${o.trusted}; waiting for Trust: ${o.pending}.`,
    `Key: ${o.key ? tilde(key) : 'none yet (run wk-remote setup)'}. Service: ${o.installed ? 'installed' : 'not installed (run wk-remote install)'}.`,
    `Link: ${o.connected ? `connected since ${when(o.connected_at)}` : o.running ? 'connecting' : 'not running'}${o.last_push_at ? `; last push ${when(o.last_push_at)}` : ''}${o.last_error && !o.connected ? `; last problem: ${o.last_error}` : ''}.`,
  ];
  return { o, lines };
}

export const CONFIG_USAGE = 'wk-remote config --origin <https URL> --host <name or IP> [--port N] [--user NAME] [--rp-id DOMAIN] [--server-command PATH]';
export async function main(argv, out = s => process.stdout.write(s + '\n')) {
  const [cmd, ...rest] = argv;
  const flag = f => { const i = rest.indexOf(f); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
  const opt = f => { const i = rest.indexOf(f); if (i < 0) return null; const v = rest[i + 1]; if (!v) bad(`${f} needs a value`); rest.splice(i, 2); return v; };
  const json = flag('--json');
  const done = (r = 0) => { if (rest.length) bad(`unknown option ${cleanCut(rest[0], 40)}`); return r; };
  switch (cmd) {
    case 'config': {
      const o = { origin: opt('--origin'), host: opt('--host'), port: opt('--port'), user: opt('--user'), rp_id: opt('--rp-id'), server_command: opt('--server-command') }; done();
      if (Object.values(o).every(v => v == null)) bad(`usage: ${CONFIG_USAGE}`);
      let patch; try { patch = serverPatch(readRemote(), o); } catch (e) { bad(e.message); }
      const r = writeRemote(patch);
      out(`Server set in ${tilde(FILES.remote())}:`);
      out(`  origin ${r.origin} (passkeys for ${r.rp_id})`);
      out(`  ssh ${r.user ? `${r.user}@${r.host}` : `${r.host} (no user yet: add --user NAME)`}, port ${r.port}`);
      out(`  server command ${r.server_command || 'not set yet (add --server-command PATH)'}`);
      out(`Phone control is ${r.enabled === true ? 'on' : 'off'}.`);
      return 0;
    }
    case 'setup': done(); return setup(out);
    case 'run': {
      const once = flag('--once'), t = opt('--transport-cmd'); done();
      needServer();
      return run({ once, transportCmd: t ? path.resolve(t) : null });
    }
    case 'trust': { const id = rest.shift(); done(); out(trust(id)); return 0; }
    case 'reject': { const id = rest.shift(); done(); out(reject(id)); return 0; }
    case 'keys': {
      done();
      const k = readKeys(), p = readPending();
      const v = { trusted: k.keys.map(x => ({ id: x.id, label: x.label, added_at: x.added_at })), pending: p.keys.map(x => ({ id: x.id, label: x.label, registered_at: x.registered_at })) };
      if (json) out(JSON.stringify(v));
      else {
        if (!v.trusted.length && !v.pending.length) out('No phone keys yet. Set up the phone on your server first.');
        for (const x of v.trusted) out(`trusted  ${x.id.slice(0, 8)}  ${x.label}  (trusted ${when(x.added_at)})`);
        for (const x of v.pending) out(`waiting  ${x.id.slice(0, 8)}  ${x.label}  (set up ${when(x.registered_at)}): wk-remote trust ${x.id.slice(0, 8)}, only if you set up your phone just now`);
      }
      return 0;
    }
    case 'enable': {
      done(); needServer(); writeRemote({ enabled: true });
      const n = readKeys().keys.length;
      out(`Phone control is on.${n ? '' : ' No phone key is trusted yet: set up the phone on your server, then trust its key with wk-remote trust or the panel\'s Trust button.'}`);
      return 0;
    }
    case 'disable': done(); writeRemote({ enabled: false }); out('Phone control is off. The phone can look but not act.'); return 0;
    case 'login': {
      const w = rest.shift(); done();
      if (w !== 'panel' && w !== 'passkey') bad('usage: wk-remote login panel|passkey');
      writeRemote({ login: w });
      out(w === 'panel'
        ? 'Login is the panel\'s own sign-in: commands from the signed-in panel run without Face ID. The Mac still applies the allowlist, the limits, the replay check, the stop switch and the permission checks of every job. Back to Face ID: wk-remote login passkey.'
        : 'Login is Face ID on every command again (decisions: one Face ID per 10 minutes).');
      return 0;
    }
    case 'status': { done(); const s = statusLines(); if (json) out(JSON.stringify(s.o)); else s.lines.forEach(l => out(l)); return 0; }
    case 'install': done(); return install(out);
    case 'uninstall': done(); return uninstall(out);
    case 'print-argv': { done(); const r = needServer(); out(JSON.stringify([process.env.WK_SSH_BIN || 'ssh', ...sshArgv(r, path.resolve(expand(r.key)))])); return 0; }
    default: bad('usage: wk-remote config|setup|run|trust|reject|keys|enable|disable|login|status|install|uninstall (see the top of bin/wk-remote.mjs)');
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
if (isMain) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; if (process.argv[2] === 'run') process.exit(code); },
    e => { process.stderr.write(`${e instanceof Stop ? e.message : `wk-remote: ${e.message}`}\n`); process.exitCode = e instanceof Stop ? e.code : 1; if (process.argv[2] === 'run') process.exit(process.exitCode); });
}
