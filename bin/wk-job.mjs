#!/usr/bin/env node
// wk-job (P2-227): a Claude Code job on this Mac, started from the owner's phone (through wk-bridge) or from the W panel.
//   wk-job start --project <key> [--model sonnet|opus|fable|haiku] [--mode auto|acceptEdits|plan] [--max-turns 1-400]
//                [--from phone|panel|cli] (--prompt "<t>" | stdin)      -> prints "Started <id> ..."
//       A prompt with legal wording (panel/src/legal-words.js) runs on the newest top model in config/models.json "legal" at xhigh
//       effort, whatever --model says; "not available" moves to the next model, a busy answer waits and tries the same one again.
//   wk-job reply <id> (--prompt "<t>" | stdin)                          -> only while the job waits: --resume, same model and mode
//   wk-job stop <id>                                                    -> SIGTERM to the job's process group, SIGKILL after 10 s
//   wk-job list [--json] · wk-job show <id> [--json] [--after <n>]
//   wk-job _run <id>                                                    -> (internal) the runner, started detached by start and reply
// Exit: 0 done, 1 refused or failed, 2 bad input, 3 the stop switch is on.
// Each job is ~/.wk/jobs/<id>/ (0700): meta.json, prompt-<n>.txt, events.jsonl (or $WK_HOME). docs/REMOTE.md has the whole story.
// The claude argv is fixed here and nowhere else; the forbidden flags below can never be part of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { gates, killOn } from './lib.mjs';
import { wkHome, readRemote, JOB_ID, PROJECT_KEY, MODELS, MODES, scrub, cleanCut, readJsonFile, writePrivate } from './remote-lib.mjs';
import { findProject } from './wk-projects.mjs';
import { isLegal, legalLabel, inOrder, order, runPicked, config as modelConfig, EFFORTS } from './model-pick.mjs';

const SELF = new URL(import.meta.url).pathname;
export const FORBIDDEN = ['bypassPermissions', 'dontAsk', '--dangerously-skip-permissions', '--add-dir', '--mcp-config', '--settings', '--allowedTools'];
export const STATES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped'];
export const MODE_WORDS = { auto: 'Edit and run commands (auto mode)', acceptEdits: 'Edit files, no commands', plan: 'Look and plan only' };
const MAX_PROMPT = 8000, MIN_FREE_MB = 1500, WAITING_MS = 24 * 3600 * 1000;
const KILL_MS = () => Number(process.env.WK_JOB_KILL_MS) || 10000;
const LIMITS = { text: 4000, short: 200, result: 8000, last: 2000 };
class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => { throw new Stop(2, m); };
const refuse = m => { throw new Stop(1, m); };

export const jobsDir = () => path.join(wkHome(), 'jobs');
const dirOf = id => path.join(jobsDir(), id);
const metaFile = id => path.join(dirOf(id), 'meta.json');
const eventsFile = id => path.join(dirOf(id), 'events.jsonl');
const stopFlag = id => path.join(dirOf(id), 'stop');
const pad = n => String(n).padStart(2, '0');
export const newJobId = (d = new Date()) => `J-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
const claudeBin = () => process.env.WK_CLAUDE_BIN || 'claude';
export const systemLine = id => `Started from the owner's phone through Watchkeeper (job ${id}). The owner is not at the Mac: work on your own, follow CLAUDE.md, and end with a short plain summary of what you did and what needs the owner. Never print .env files, keys or tokens: name them instead.`;

// ---------------------------------------------------------------- the one argv
// A legal job (legal: true) may also run a model from the legal order in config/models.json, with --effort.
export function claudeArgv({ id, model, mode, max_turns, session_id, effort = null, legal = false }) {
  if (!MODELS.includes(model) && !(legal && inOrder('legal', model))) bad('unknown model');
  if (effort !== null && !EFFORTS.includes(effort)) bad('unknown effort');
  if (!MODES.includes(mode)) bad('unknown mode');
  if (!(Number.isInteger(max_turns) && max_turns >= 1 && max_turns <= 400)) bad('turns must be 1 to 400');
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, '--permission-prompts', 'none', '--model', model,
    ...(effort ? ['--effort', effort] : []), '--max-turns', String(max_turns), '--append-system-prompt', systemLine(id)];
  if (session_id) a.push('--resume', session_id);
  if (a.some(x => FORBIDDEN.includes(x))) throw new Error('a forbidden flag reached the argv');   // never: the sets above are closed
  return a;
}

// ---------------------------------------------------------------- files
export function readMeta(id) { if (!JOB_ID.test(id)) return null; const m = readJsonFile(metaFile(id), null); return m && m.id === id ? m : null; }
function saveMeta(m) { writePrivate(metaFile(m.id), JSON.stringify(m, null, 2) + '\n'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch { /* best effort */ } }
function lastN(id) { const m = readMeta(id); return m && Number.isInteger(m.events) ? m.events : 0; }
// Events: one JSON line each, numbered from 1, everything cut and through the secret scan before it is written
function appendEvents(m, evs) {
  if (!evs.length) return;
  const fd = fs.openSync(eventsFile(m.id), 'a', 0o600);
  try {
    for (const e of evs) { m.events = (m.events || 0) + 1; fs.writeSync(fd, JSON.stringify({ n: m.events, at: Date.now(), ...scrub(e) }) + '\n'); }
  } finally { fs.closeSync(fd); }
}
export function readEvents(id, after = 0, max = 500) {
  let s; try { s = fs.readFileSync(eventsFile(id), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of s.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e && Number.isInteger(e.n) && e.n > after) { out.push(e); if (out.length >= max) break; } } catch { /* a partial last line */ }
  }
  return out;
}
const alive = pid => { if (!Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The runner's pid. meta.json carries it once the runner has started claude; before that, start and reply leave it in runner.pid
// (not in meta.json, so they never undo the runner's own writes). Without it, a stop in that gap took the runner for gone.
const runnerPidFile = id => path.join(dirOf(id), 'runner.pid');
const runnerPid = m => { if (Number.isInteger(m.runner_pid)) return m.runner_pid; try { const n = Number(fs.readFileSync(runnerPidFile(m.id), 'utf8').trim()); return Number.isInteger(n) ? n : null; } catch { return null; } };

// A runner that died leaves "running": it shows as failed. A job that waited 24 hours for a reply is done.
export function sweep(now = Date.now()) {
  let names; try { names = fs.readdirSync(jobsDir()).filter(x => JOB_ID.test(x)); } catch { return []; }
  const out = [];
  for (const id of names) {
    const m = readMeta(id); if (!m) continue;
    if ((m.state === 'running' || m.state === 'queued') && !alive(runnerPid(m)) && now - (m.queued_at || m.started_at || 0) > 15000) {
      m.state = 'failed'; m.ended_at = now; m.last_text = 'The job stopped unexpectedly (its runner is gone).';
      appendEvents(m, [{ type: 'note', text: m.last_text }]); saveMeta(m);
    } else if (m.state === 'waiting' && now - (m.ended_at || 0) > WAITING_MS) { m.state = 'done'; saveMeta(m); }
    out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

// ---------------------------------------------------------------- the checks before a start
export function freeMb() {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 3000 });
      const size = Number((/page size of (\d+) bytes/.exec(r.stdout) || [])[1]) || 4096;
      const get = k => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(r.stdout) || [])[1]) || 0;
      const pages = get('Pages free') + get('Pages inactive') + get('Pages speculative') + get('Pages purgeable');
      if (pages) return Math.round(pages * size / 1048576);
    } else if (process.platform === 'linux') {
      const kb = Number((/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')) || [])[1]);
      if (kb) return Math.round(kb / 1024);
    }
  } catch { /* the plain figure below */ }
  return Math.round(os.freemem() / 1048576);
}
// This week's use in per cent, from the plugin's own ledger (null when there is no reading: a start is then allowed)
export function pacePct() {
  const r = spawnSync(process.execPath, [path.join(path.dirname(SELF), 'wk-ledger.mjs'), 'pace', '--json'], { encoding: 'utf8', timeout: 8000,
    env: { ...process.env, WK_STEWARD_DIR: path.join(wkHome(), 'steward'), WK_LEDGER: path.join(wkHome(), 'ledger.jsonl') } });
  try { const lines = String(r.stdout || '').trim().split('\n'); const j = JSON.parse(lines[lines.length - 1]); return Number.isFinite(j.used) ? j.used * 100 : null; } catch { return null; }
}
function orchestrationDir(remote) {
  // Only remote.json "orchestration" names it; unset means none
  return remote.orchestration ? path.resolve(remote.orchestration.replace(/^~(?=\/|$)/, os.homedir())) : null;
}
function stopSwitchOn() {
  try { return killOn(gates({ allowMismatch: true })); } catch { return fs.existsSync(path.join(os.homedir(), '.wk', 'KILL')); }
}
const envNum = k => (process.env[k] != null && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : undefined);
const defaults = () => ({
  freeMb: envNum('WK_JOB_FREE_MB') !== undefined ? () => envNum('WK_JOB_FREE_MB') : freeMb,
  pacePct: process.env.WK_JOB_PACE_PCT === 'none' ? () => null : envNum('WK_JOB_PACE_PCT') !== undefined ? () => envNum('WK_JOB_PACE_PCT') : pacePct,
  spawnRunner,
});

// Why a job may not start now, or null. The order: stop switch, LOW_RAM, free RAM, running jobs, pace, project.
export function whyNot({ project, remote = readRemote(), deps = defaults(), now = Date.now() }) {
  if (stopSwitchOn()) return { code: 3, text: 'The stop switch is on: no job starts until it is off.' };
  const p = findProject(project);
  const repo = p ? (p.kind === 'folder' && p.repo ? p.repo : p.path) : null;
  const orch = orchestrationDir(remote);
  for (const f of [orch && path.join(orch, 'LOW_RAM'), repo && path.join(repo, 'orchestration', 'LOW_RAM')].filter(Boolean)) {
    if (fs.existsSync(f)) return { code: 1, text: 'The Mac is low on memory (LOW_RAM is set): no job starts until it clears.' };
  }
  const mb = deps.freeMb();
  if (Number.isFinite(mb) && mb < MIN_FREE_MB) return { code: 1, text: `The Mac has ${Math.round(mb)} MB free, under ${MIN_FREE_MB} MB: no job starts until more is free.` };
  const running = sweep(now).filter(m => m.state === 'running' || m.state === 'queued').length;
  if (running >= remote.max_jobs) return { code: 1, text: `${running} jobs are running, the most at once is ${remote.max_jobs}. Wait for one to finish or stop one.` };
  const pct = deps.pacePct();
  if (Number.isFinite(pct) && pct >= remote.pace_stop_pct) return { code: 1, text: `This week's use is at ${Math.round(pct)}%, at or over the ${remote.pace_stop_pct}% line: no new job this week.` };
  if (!p) return { code: 1, text: `"${String(project).slice(0, 64)}" is not in the projects list. Run wk-projects scan on the Mac.` };
  if (!fs.existsSync(repo)) return { code: 1, text: `The folder for "${p.key}" is not there any more.` };
  return null;
}

// ---------------------------------------------------------------- start, reply, stop
const legalNote = word => `Legal wording ("${word}"): this job runs on the newest top model the plan has, at ${modelConfig().legal_effort_job} effort, whatever model was picked. The wording waits for the owner's approval before use.`;
export function start({ project, prompt, model = 'sonnet', mode = 'auto', max_turns = 150, from = 'cli' }, { deps = defaults(), now = new Date() } = {}) {
  if (typeof project !== 'string' || !PROJECT_KEY.test(project)) bad('unknown project');
  prompt = String(prompt ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) bad('the prompt is empty');
  if (prompt.length > MAX_PROMPT) bad('the prompt is over 8,000 characters');
  if (!['phone', 'panel', 'cli'].includes(from)) bad('unknown --from');
  claudeArgv({ id: 'J-00000000-0000-0000', model, mode, max_turns });   // checks the model, mode and turns
  const remote = readRemote();
  const no = whyNot({ project, remote, deps, now: now.getTime() });
  if (no) throw new Stop(no.code, no.text);
  const p = findProject(project);
  const cwd = p.kind === 'folder' && p.repo ? p.repo : p.path;
  const text = p.kind === 'folder' && p.repo ? `Work in ${path.relative(p.repo, p.path)}/ (project ${p.name}).\n${prompt}` : prompt;
  ensureDir(jobsDir());
  let id;
  for (let i = 0; ; i++) {
    id = newJobId(now);
    try { fs.mkdirSync(dirOf(id), { mode: 0o700 }); break; } catch (e) { if (e.code !== 'EEXIST' || i > 20) throw e; }
  }
  fs.chmodSync(dirOf(id), 0o700);
  writePrivate(path.join(dirOf(id), 'prompt-1.txt'), text);
  const legal = isLegal(prompt);
  const m = { id, project: p.key, cwd, model, mode, max_turns, from, state: 'queued', legal: !!legal, model_id: null, effort: null, session_id: null, started_at: now.getTime(), queued_at: now.getTime(), ended_at: null,
    cost_usd: 0, turns: 0, last_text: '', prompts: 1, events: 0, runner_pid: null, pgid: null, wall_ms: Number(process.env.WK_JOB_WALL_MS) || remote.job_hours * 3600000 };
  appendEvents(m, [{ type: 'prompt', text: cleanCut(prompt, LIMITS.text) }]);
  if (legal) appendEvents(m, [{ type: 'note', text: legalNote(legal) }]);
  saveMeta(m);
  m.runner_pid = deps.spawnRunner(id);   // the runner writes its own pid into meta.json (a write here could undo the runner's)
  if (Number.isInteger(m.runner_pid)) writePrivate(runnerPidFile(id), String(m.runner_pid));
  return m;
}

export function reply(id, prompt, { deps = defaults(), now = Date.now() } = {}) {
  if (!JOB_ID.test(String(id))) bad('unknown job');
  prompt = String(prompt ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) bad('the reply is empty');
  if (prompt.length > MAX_PROMPT) bad('the reply is over 8,000 characters');
  sweep(now);
  const m = readMeta(id);
  if (!m) refuse(`There is no job ${id}.`);
  if (m.state !== 'waiting') refuse(`Job ${id} is ${m.state}, not waiting for a reply.`);
  if (!m.session_id) refuse(`Job ${id} has no session to continue.`);
  if (alive(m.runner_pid)) refuse(`Job ${id} is still running.`);   // never two runs on one session
  if (stopSwitchOn()) throw new Stop(3, 'The stop switch is on: no job runs until it is off.');
  m.prompts = (m.prompts || 1) + 1;
  writePrivate(path.join(dirOf(id), `prompt-${m.prompts}.txt`), prompt);
  m.state = 'queued'; m.queued_at = now; m.ended_at = null;
  appendEvents(m, [{ type: 'prompt', text: cleanCut(prompt, LIMITS.text) }]);
  const legal = !m.legal && isLegal(prompt);   // once legal, the job stays legal
  if (legal) { m.legal = true; appendEvents(m, [{ type: 'note', text: legalNote(legal) }]); }
  try { fs.rmSync(stopFlag(id), { force: true }); } catch { /* none */ }
  m.runner_pid = null; m.pgid = null;   // the last run's: never signal a group that may belong to someone else now
  saveMeta(m);
  m.runner_pid = deps.spawnRunner(id);
  if (Number.isInteger(m.runner_pid)) writePrivate(runnerPidFile(id), String(m.runner_pid));
  return m;
}

export function stop(id, { now = Date.now() } = {}) {
  if (!JOB_ID.test(String(id))) bad('unknown job');
  const m = readMeta(id);
  if (!m) refuse(`There is no job ${id}.`);
  if (m.state !== 'running' && m.state !== 'queued') return { m, text: `Job ${id} is already ${m.state}.` };
  writePrivate(stopFlag(id), String(now));
  if (Number.isInteger(m.pgid) && m.pgid > 1) { try { process.kill(-m.pgid, 'SIGTERM'); } catch { /* already gone */ } }
  // the runner sees the flag, waits up to 10 s, then SIGKILLs the group and writes "stopped"; a runner that is gone cannot, so do it here
  if (!alive(runnerPid(m))) {
    if (Number.isInteger(m.pgid) && m.pgid > 1) { try { process.kill(-m.pgid, 'SIGKILL'); } catch { /* gone */ } }
    m.state = 'stopped'; m.ended_at = now; m.last_text = m.last_text || 'Stopped by the owner.';
    appendEvents(m, [{ type: 'note', text: 'Stopped by the owner.' }]); saveMeta(m);
  }
  return { m, text: `Stopping job ${id}.` };
}

// The runner is its own process (detached, output to nowhere), so start returns at once and the job outlives the panel or the bridge.
export function spawnRunner(id) {
  const c = spawn(process.execPath, [SELF, '_run', id], { detached: true, stdio: 'ignore', env: process.env, cwd: os.homedir() });
  c.unref();
  return c.pid;
}

// ---------------------------------------------------------------- the runner
// What a stream-json line becomes: init, text, tool, permission_denied, result. Everything else is dropped.
const SHORT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
export function eventsFrom(o) {
  if (!o || typeof o !== 'object') return [];
  if (o.type === 'system' && o.subtype === 'init') return [{ type: 'init', session_id: cleanCut(o.session_id, 100), model: cleanCut(o.model, 80), permissionMode: cleanCut(o.permissionMode, 40) }];
  if (o.type === 'permission_denied' || o.subtype === 'permission_denied') return [{ type: 'permission_denied', tool: cleanCut(o.tool_name || o.tool || '', 80) }];
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const out = [];
    for (const c of o.message.content) {
      if (c && c.type === 'text' && c.text) out.push({ type: 'text', text: cleanCut(c.text, LIMITS.text) });
      else if (c && c.type === 'tool_use') {
        const i = c.input && typeof c.input === 'object' ? c.input : {};
        const k = SHORT_KEYS.find(x => typeof i[x] === 'string');
        out.push({ type: 'tool', name: cleanCut(c.name, 80), short: cleanCut(k ? i[k].replace(/\s+/g, ' ') : '', LIMITS.short) });
      }
    }
    return out;
  }
  if (o.type === 'result') {
    const out = (Array.isArray(o.permission_denials) ? o.permission_denials : []).slice(0, 20).map(d => ({ type: 'permission_denied', tool: cleanCut(d && (d.tool_name || d.tool), 80) }));
    out.push({ type: 'result', subtype: cleanCut(o.subtype, 40), cost_usd: Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null,
      turns: Number.isInteger(o.num_turns) ? o.num_turns : null, text: cleanCut(o.result, LIMITS.result) });
    return out;
  }
  return [];
}

// One run of claude for a job: it returns how the run ended and leaves the final state to finishRun. A legal job may run
// several times (the next model in the legal order after "not available", the same model again after a busy answer).
let haltNow = null;
process.on('SIGTERM', () => { if (haltNow) haltNow('stop'); });   // the group signal from `stop` reaches the runner only if it shares the group; it does not, but be safe
async function runOnce(m, id, prompt, { model, effort = null, resume = null, wallMs }) {
  const argv = claudeArgv({ id, model, mode: m.mode, max_turns: m.max_turns, session_id: resume, effort, legal: !!m.legal });
  // a stop that came while the runner was getting ready: claude never starts
  if (fs.existsSync(stopFlag(id))) return { why: 'stop', end: {}, result: null, raw: [], errTail: '' };
  let child;
  try { child = spawn(claudeBin(), argv, { cwd: m.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env }); }
  catch (e) { return { spawnError: e, why: null, end: {}, result: null, raw: [], errTail: '' }; }
  m.state = 'running'; m.pgid = child.pid; m.runner_pid = process.pid; m.run_started_at = m.run_started_at || Date.now();
  saveMeta(m);
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: null, error: e }));
    child.on('close', (code, signal) => resolve({ code, signal }));
    // a grandchild can keep the pipes open after claude exits: then wait two seconds for the last lines, no longer
    child.on('exit', (code, signal) => setTimeout(() => resolve({ code, signal }), 2000).unref());
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  let buf = '', errTail = '', result = null, why = null, killTimer = null;
  const raw = [];   // what the model picker reads: the result line, a "<synthetic>" message, a rate limit that was not allowed
  const pending = [];
  const flush = () => { if (!pending.length) return; const cur = readMeta(id) || m; m.events = cur.events; appendEvents(m, pending.splice(0)); saveMeta(m); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && (o.type === 'result' || (o.type === 'assistant' && o.message && o.message.model === '<synthetic>')
        || (o.type === 'rate_limit_event' && o.rate_limit_info && !/^allowed/.test(String(o.rate_limit_info.status || ''))))) {
        raw.push({ type: o.type, is_error: o.is_error, api_error_status: o.api_error_status, subtype: o.subtype, result: typeof o.result === 'string' ? o.result.slice(0, 500) : undefined,
          message: o.message ? { model: o.message.model, content: Array.isArray(o.message.content) ? o.message.content.filter(c => c && c.type === 'text').slice(0, 3) : [] } : undefined,
          rate_limit_info: o.rate_limit_info ? { status: String(o.rate_limit_info.status || '') } : undefined });
        if (raw.length > 20) raw.shift();
      }
      for (const e of eventsFrom(o)) {
        if (e.type === 'init' && e.session_id) m.session_id = e.session_id;
        if (e.type === 'result') result = e;
        if (e.type === 'text') m.last_text = cleanCut(e.text, LIMITS.last);
        pending.push(e);
      }
      if (pending.length) flush();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
  const halt = reason => {
    if (why) return; why = reason;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_MS());
  };
  haltNow = halt;
  const poll = setInterval(() => { if (fs.existsSync(stopFlag(id))) halt('stop'); }, 200);
  if (fs.existsSync(stopFlag(id))) halt('stop');   // a stop between the check above and the spawn: now, not at the next poll
  const wall = setTimeout(() => halt('wall'), Math.max(1000, wallMs));
  const end = await done;
  clearInterval(poll); clearTimeout(wall); haltNow = null;
  if (!why && fs.existsSync(stopFlag(id))) why = 'stop';   // `stop` signals the group itself: claude can end before the next poll
  // the group may still hold children of claude: they go too
  killGroup('SIGKILL'); if (killTimer) clearTimeout(killTimer);
  flush();
  const cur = readMeta(id) || m; m.events = cur.events;
  // every run counts, the ones that fell back or were busy too
  if (result) { m.cost_usd = Math.round(((m.cost_usd || 0) + (result.cost_usd || 0)) * 1e6) / 1e6; m.turns = (m.turns || 0) + (result.turns || 0); if (result.text) m.last_text = cleanCut(result.text, LIMITS.last); }
  const resultLine = raw.filter(o => o.type === 'result').at(-1);
  return { why, end, result, raw, errTail, isError: !!(resultLine && resultLine.is_error === true) };
}

// The final state of a job from its last run.
function finishRun(m, id, o, extra = null) {
  m.ended_at = Date.now();
  if (o.spawnError) { m.state = 'failed'; m.last_text = `Claude Code could not start: ${cleanCut(o.spawnError.message, 200)}`; appendEvents(m, [{ type: 'note', text: m.last_text }]); }
  else if (o.why === 'stop') { m.state = 'stopped'; m.last_text = 'Stopped by the owner.'; appendEvents(m, [{ type: 'note', text: m.last_text }]); }
  else if (o.why === 'wall') { m.state = 'failed'; m.last_text = `Stopped: the ${Math.round((m.wall_ms || 0) / 60000)}-minute limit was reached.`; appendEvents(m, [{ type: 'note', text: m.last_text }]); }
  else if (extra) { m.state = 'failed'; m.last_text = extra; appendEvents(m, [{ type: 'note', text: m.last_text }]); }
  else if (o.end.code === 0 && o.result && o.result.subtype === 'success' && !o.isError) m.state = 'waiting';
  else {
    m.state = 'failed';
    if (!o.result) { m.last_text = cleanCut(`Claude Code ended without a result (exit ${o.end.code ?? o.end.signal ?? 'unknown'})${o.errTail.trim() ? ': ' + o.errTail.trim().split('\n').pop() : ''}.`, LIMITS.last); appendEvents(m, [{ type: 'note', text: m.last_text }]); }
  }
  m.last_text = scrub(m.last_text);
  try { fs.rmSync(stopFlag(id), { force: true }); } catch { /* none */ }
  saveMeta(m);
  return 0;
}

// A wait that ends early when the owner presses Stop.
const stoppableSleep = id => ms => new Promise(resolve => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (fs.existsSync(stopFlag(id)) || Date.now() - t0 >= ms) { clearInterval(iv); resolve(); } }, Math.min(200, Math.max(10, ms)));
});

export async function runJob(id) {
  let m = readMeta(id);
  if (!m || m.state !== 'queued') return 1;
  const prompt = fs.readFileSync(path.join(dirOf(id), `prompt-${m.prompts}.txt`), 'utf8');
  const resume = m.prompts > 1 ? m.session_id : null;
  const t0 = Date.now(), wallLeft = () => (m.wall_ms || 3 * 3600000) - (Date.now() - t0);
  if (!m.legal) return finishRun(m, id, await runOnce(m, id, prompt, { model: m.model, resume, wallMs: wallLeft() }));

  // Legal wording: the newest top model the plan has (config/models.json "legal"), at xhigh effort, whatever model was picked.
  const c = modelConfig(), effort = c.legal_effort_job;
  const deps = defaults(), remote = readRemote();
  const paceOk = () => { const pct = deps.pacePct(); return !(Number.isFinite(pct) && pct >= remote.pace_stop_pct); };
  const note = text => { const cur = readMeta(id) || m; m.events = cur.events; appendEvents(m, [{ type: 'note', text }]); saveMeta(m); };
  const res = await runPicked('legal', async model => {
    if (fs.existsSync(stopFlag(id)) || wallLeft() <= 0) return { stopped: true, o: { why: fs.existsSync(stopFlag(id)) ? 'stop' : 'wall', end: {}, result: null, raw: [], errTail: '' } };
    m.model_id = model; m.effort = effort;
    const cur = readMeta(id) || m; m.events = cur.events;
    appendEvents(m, [{ type: 'model', model, effort, text: legalLabel(model) }]); saveMeta(m);
    const o = await runOnce(m, id, prompt, { model, effort, resume, wallMs: wallLeft() });
    return { out: o.raw, o, stopped: !!(o.why || o.spawnError) };
  }, {
    from: `job ${id}`, retries: Number.isInteger(Number(process.env.WK_JOB_RETRIES)) && process.env.WK_JOB_RETRIES !== '' ? Number(process.env.WK_JOB_RETRIES) : 3,
    waitMs: Number(process.env.WK_JOB_RETRY_MS) || 60000, paceOk, sleep: stoppableSleep(id), c,
    onFallback: (was, next) => note(next ? `${was} is not available on this plan: trying ${next}.` : `${was} is not available on this plan, and no other model in the legal order is.`),
    onBusy: (model, n, ms) => note(`Claude is busy (a rate limit or overload). Waiting ${Math.round(ms / 1000)} s, then trying ${model} again (try ${n + 1}); the model stays the same.`),
  });
  const o = res.r.o;
  if (res.exhausted) return finishRun(m, id, o, `No model in the legal order (${order('legal', c).join(', ')}) is available on this plan.`);
  if (res.busy) return finishRun(m, id, o, `Claude stayed busy (a rate limit or overload) and the job stopped without changing the model (${res.model}). Reply later to try again.`);
  return finishRun(m, id, o);
}

// ---------------------------------------------------------------- the command line
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
export function parseArgs(argv) {
  const o = { cmd: argv[0] || '', id: null, json: false };
  const VAL = { '--project': 'project', '--model': 'model', '--mode': 'mode', '--max-turns': 'max_turns', '--from': 'from', '--prompt': 'prompt', '--after': 'after' };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--json') o.json = true;
    else if (VAL[x]) { const v = a.shift(); if (v === undefined) bad(`${x} needs a value`); o[VAL[x]] = v; }
    else if (!x.startsWith('--') && !o.id) o.id = x;
    else bad(`unknown option ${String(x).slice(0, 40)}`);
  }
  if (o.max_turns !== undefined) { if (!/^\d{1,3}$/.test(o.max_turns)) bad('--max-turns must be 1 to 400'); o.max_turns = Number(o.max_turns); }
  return o;
}
const summary = m => ({ id: m.id, project: m.project, model: m.model, ...(m.legal ? { legal: true, model_id: m.model_id || null, effort: m.effort || null } : {}), mode: m.mode, from: m.from, state: m.state, started_at: m.started_at, ended_at: m.ended_at,
  cost_usd: m.cost_usd, turns: m.turns, last_text: String(m.last_text || '').slice(0, 300) });

export async function main(argv, out = s => process.stdout.write(s + '\n')) {
  const o = parseArgs(argv);
  if (o.cmd === 'start') {
    const m = start({ project: o.project, prompt: o.prompt ?? readStdin(), model: o.model || 'sonnet', mode: o.mode || 'auto', max_turns: o.max_turns ?? 150, from: o.from || 'cli' });
    out(o.json ? JSON.stringify(summary(m)) : `Started ${m.id} in ${m.project} (${m.legal ? legalLabel() : m.model}, ${MODE_WORDS[m.mode].toLowerCase()}).`);
    return 0;
  }
  if (o.cmd === 'reply') { const m = reply(o.id, o.prompt ?? readStdin()); out(o.json ? JSON.stringify(summary(m)) : `Sent the reply to ${m.id}.`); return 0; }
  if (o.cmd === 'stop') { const r = stop(o.id); out(r.text); return 0; }
  if (o.cmd === 'list') {
    const ms = sweep();
    if (o.json) out(JSON.stringify(ms.map(summary)));
    else if (!ms.length) out('No jobs yet.');
    else for (const m of ms) out(`${m.id}  ${m.state.padEnd(8)} ${m.project}  ${String(m.last_text || '').slice(0, 80)}`);
    return 0;
  }
  if (o.cmd === 'show') {
    sweep();
    const m = readMeta(String(o.id)); if (!m) refuse(`There is no job ${o.id}.`);
    const after = Number(o.after) || 0, events = readEvents(m.id, after);
    if (o.json) out(JSON.stringify({ ...summary(m), events, next: events.length ? events[events.length - 1].n : after }));
    else { out(`${m.id}  ${m.state}  ${m.project}`); for (const e of events) out(`${e.n}. ${e.type}: ${e.text || e.name || e.tool || e.subtype || ''}`.slice(0, 300)); }
    return 0;
  }
  if (o.cmd === '_run') return runJob(String(o.id));
  bad('usage: wk-job start|reply|stop|list|show (see the top of bin/wk-job.mjs)');
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
if (isMain) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    e => { process.stderr.write(`${e instanceof Stop ? e.message : `wk-job: ${e.message}`}\n`); process.exitCode = e instanceof Stop ? e.code : 1; });
}
