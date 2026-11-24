#!/usr/bin/env node
// wk-handoff (P2-257): W asks a session for a continue prompt before the session is cleared, and the next session picks it up.
//   Hooks (Claude Code calls these; stdin is the hook event; they never fail a session: any error prints nothing and exits 0):
//     wk-handoff stop    Stop hook: when the context is big, the weekly or five-hour meter is near its limit, or W has asked
//                        (wk-handoff request), the session is asked ONCE to write a continue prompt as a .md file. When the file
//                        is there and complete, the owner is told: "type /clear".
//     wk-handoff start   SessionStart hook (matcher clear): the one ready, unused continue file of this folder is loaded into the
//                        new session. With several ready files in one folder nothing is loaded; their paths are listed.
//     wk-handoff statusline  Claude Code's status line command: Claude Code gives it the plan's real usage (rate_limits: five-hour and
//                        seven-day percent); it writes them as W's meter (steward/meter.json) and prints "5h 42% · week 31%".
//                        Without it the meter is only as fresh as the last headless call, so the usage trigger would never see a limit coming.
//   Commands:
//     wk-handoff status [--json]                    sessions asked, ready, used
//     wk-handoff request --why "<text>" [--hours N]  W's request to every session (default 2 hours); sessions answer at their next Stop
//     wk-handoff request --off                       withdraw it
//     wk-handoff install [--apply] | uninstall [--apply]   add or remove the hooks (and the status line, only when you have none) in ~/.claude/settings.json (dry run without --apply; backup first)
//     wk-handoff install --statusline-only [--apply]       add only the status line (no hooks); uninstall --statusline-only removes only ours
// What W does after the file exists is /clear and nothing else: a hook cannot type /clear into a running Claude Code window, so for the
// owner's own tabs W tells the owner (the Stop message) and the SessionStart hook does the loading afterwards; for jobs W runs itself
// (wk-job) the clear is real: `wk-job clear <id>` ends the job and starts a fresh one from the file, and only when the file is ready.
// Files: ~/.wk/handoff/ (0700): <date>-<session8>.md, sessions/<id>.json, request.json, log.jsonl; settings: ~/.wk/handoff.json (optional).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { wkHome, writePrivate, readJsonFile } from './remote-lib.mjs';
import { resolveDataDir } from './rp-dir.mjs';

export const DEFAULTS = { enabled: true, contextTokens: 150000, fiveHour: 0.85, weekly: 0.92, meterMaxAgeH: 3, maxAgeH: 12, requestHours: 2, minBytes: 300, maxInject: 12000 };
export const END = 'WK-HANDOFF-END';
const SID = /^[A-Za-z0-9_-]{1,80}$/;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

export const dir = () => path.join(wkHome(), 'handoff');
const stateFile = (sid) => path.join(dir(), 'sessions', `${sid}.json`);
const requestFile = () => path.join(dir(), 'request.json');
const logFile = () => path.join(dir(), 'log.jsonl');
const claudeHome = () => process.env.WK_CLAUDE_HOME || path.join(os.homedir(), '.claude');

export function config() {
  const own = readJsonFile(path.join(wkHome(), 'handoff.json'), {}), c = { ...DEFAULTS };
  if (typeof own.enabled === 'boolean') c.enabled = own.enabled;
  for (const k of ['contextTokens', 'fiveHour', 'weekly', 'meterMaxAgeH', 'maxAgeH', 'requestHours', 'minBytes', 'maxInject']) c[k] = num(own[k], DEFAULTS[k]);
  return c;
}

const ensure = (d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); };
const readState = (sid) => readJsonFile(stateFile(sid), null);
const writeState = (sid, st) => { ensure(path.join(dir(), 'sessions')); writePrivate(stateFile(sid), JSON.stringify(st, null, 1)); };
const log = (o) => { try { ensure(dir()); fs.appendFileSync(logFile(), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n', { mode: 0o600 }); } catch {} };
const oneLine = (s, n = 160) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- what is big: the context of the session, the meter of the plan
// The context in tokens = input + cache reads + cache writes of the newest assistant message of the main thread (not a subagent's).
export function contextTokens(transcript) {
  try {
    const st = fs.statSync(transcript); if (!st.isFile()) return null;
    const len = Math.min(st.size, 400 * 1024), fd = fs.openSync(transcript, 'r'), buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.isSidechain || o.type !== 'assistant') continue;
      const u = o.message && o.message.usage; if (!u || typeof u !== 'object') continue;
      const n = (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0) + (+u.cache_creation_input_tokens || 0);
      if (n > 0) return n;
    }
  } catch {}
  return null;
}

// The meter is the one the steward and wk-ledger keep (steward/meter.json); only a fresh reading counts.
export function meterReading(cfg, now = Date.now()) {
  const f = process.env.WK_METER || path.join(process.env.WK_STEWARD_DIR || path.join(wkHome(), 'steward'), 'meter.json');
  const m = readJsonFile(f, null); if (!m) return null;
  const age = now - Date.parse(m.fetchedAt); if (!(age > -60000) || age > cfg.meterMaxAgeH * 36e5) return null;
  const live = (w) => (w && Number.isFinite(w.utilization) && !(Number.isFinite(w.resetsAt) && w.resetsAt * 1000 <= now) ? w.utilization : null);
  return { weekly: Number.isFinite(m.utilization) && !(Number.isFinite(m.resetsAt) && m.resetsAt * 1000 <= now) ? m.utilization : null, fiveHour: live(m.fiveHour) };
}

// Why is it time? Returns a short reason, or null.
export function whyNow({ tokens, meter, request, cfg, now = Date.now() }) {
  if (request && Number.isFinite(request.until) && request.until > now) return `W asked every session for a continue file (${oneLine(request.why, 120) || 'no reason given'})`;
  if (Number.isFinite(tokens) && tokens >= cfg.contextTokens) return `the context holds about ${Math.round(tokens / 1000)}k tokens`;
  if (meter && Number.isFinite(meter.fiveHour) && meter.fiveHour >= cfg.fiveHour) return `the five-hour usage limit is at ${Math.round(meter.fiveHour * 100)}%`;
  if (meter && Number.isFinite(meter.weekly) && meter.weekly >= cfg.weekly) return `the weekly usage limit is at ${Math.round(meter.weekly * 100)}%`;
  return null;
}

// ---------------------------------------------------------------- the file
const SECRET = [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{12,}/, /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}/i];
export function checkFile(file, cfg) {
  let st; try { st = fs.statSync(file); } catch { return { ok: false, why: 'the file does not exist yet' }; }
  if (!st.isFile()) return { ok: false, why: 'the path is not a file' };
  if (st.size > 200 * 1024) return { ok: false, why: 'the file is far too long; keep it under 200 KB' };
  const t = fs.readFileSync(file, 'utf8');
  if (t.length < cfg.minBytes) return { ok: false, why: `the file is shorter than ${cfg.minBytes} characters` };
  if (!t.trimEnd().endsWith(END)) return { ok: false, why: `the last line must be exactly ${END}` };
  if (SECRET.some((re) => re.test(t))) return { ok: false, why: 'it looks like a key or password is in the file; remove it and say where it is kept instead' };
  return { ok: true, bytes: Buffer.byteLength(t) };
}

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
export const askText = (why, file) => [
  `Watchkeeper (W) asks for a continue prompt: ${why}.`,
  `Before this session is cleared, write ONE markdown file at exactly this path (create the folder if needed): ${file}`,
  'Sections, in this order: "# Continue" (the date and the item ID); "## Goal" (the owner\'s words, short); "## Done" (each point with its evidence: the command and its result); "## State" (files changed and not committed, locks held, background jobs or deploys still waiting, with their ids); "## Next" (numbered steps, the first doable at once); "## Decisions and rules" (the owner\'s words that still apply); "## Resume prompt" (one paragraph the next session can start from).',
  `Plain words. No keys, passwords or pasted file contents: say where a thing is kept. The last line of the file is exactly: ${END}`,
  'Then answer with one short line and stop. Do not start new work, and do not touch anything else. W only clears the session after this file exists.',
].join('\n');

// ---------------------------------------------------------------- hooks
function readEvent() { try { const o = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Returns what the Stop hook prints (an object) or null. Pure over the files and the clock, so a test can drive it.
export function onStop(ev, now = Date.now()) {
  const cfg = config(); if (!cfg.enabled) return null;
  const sid = ev.session_id; if (typeof sid !== 'string' || !SID.test(sid)) return null;
  let st = readState(sid);
  if (st && (st.ready_at || st.gave_up)) return null;
  if (st && st.file) {
    const c = checkFile(st.file, cfg);
    if (c.ok) {
      writeState(sid, { ...st, ready_at: new Date(now).toISOString(), bytes: c.bytes }); log({ kind: 'ready', session: sid.slice(0, 8), file: st.file, bytes: c.bytes });
      return { systemMessage: `W: the continue file is ready (${st.file}). Type /clear now: the next session in this folder loads it by itself.` };
    }
    if ((st.tries || 0) >= 2) { writeState(sid, { ...st, gave_up: true, ready_at: null }); log({ kind: 'gave-up', session: sid.slice(0, 8), why: c.why }); return { systemMessage: `W: the continue file is not usable (${c.why}). Write the handoff by hand before you /clear.` }; }
    writeState(sid, { ...st, tries: (st.tries || 0) + 1 });
    return { decision: 'block', reason: `The continue file is not ready: ${c.why}. Fix ${st.file}, then stop.` };
  }
  const tokens = contextTokens(ev.transcript_path), request = readJsonFile(requestFile(), null);
  const why = whyNow({ tokens, meter: meterReading(cfg, now), request, cfg, now });
  if (!why) return null;
  ensure(path.join(dir(), 'sessions'));
  const file = path.join(dir(), `${stamp(new Date(now))}-${sid.slice(0, 8)}.md`);
  writeState(sid, { session: sid, cwd: typeof ev.cwd === 'string' ? ev.cwd : '', asked_at: new Date(now).toISOString(), why, file, tries: 0, tokens: Number.isFinite(tokens) ? tokens : null });
  log({ kind: 'asked', session: sid.slice(0, 8), why, tokens: Number.isFinite(tokens) ? tokens : null });
  return { decision: 'block', reason: askText(why, file) };
}

// SessionStart after /clear: load the one ready, unused file of this folder.
export function onStart(ev, now = Date.now()) {
  const cfg = config(); if (!cfg.enabled || ev.source !== 'clear') return null;
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : ''; if (!cwd) return null;
  let names = []; try { names = fs.readdirSync(path.join(dir(), 'sessions')).filter((n) => n.endsWith('.json')); } catch { return null; }
  const ready = [];
  for (const n of names) {
    const st = readJsonFile(path.join(dir(), 'sessions', n), null);
    if (!st || !st.ready_at || st.used_at || st.cwd !== cwd || st.session === ev.session_id) continue;
    if (now - Date.parse(st.ready_at) > cfg.maxAgeH * 36e5) continue;
    ready.push(st);
  }
  if (!ready.length) return null;
  if (ready.length > 1) return { systemMessage: `W: ${ready.length} continue files wait for this folder; none was loaded because W cannot tell which tab this is. Read the right one: ${ready.map((s) => s.file).join(' · ')}` };
  const st = ready[0];
  const c = checkFile(st.file, cfg); if (!c.ok) return { systemMessage: `W: the continue file ${st.file} is not usable now (${c.why}).` };
  let text = fs.readFileSync(st.file, 'utf8').replace(END, '').trim(); const cut = text.length > cfg.maxInject; if (cut) text = text.slice(0, cfg.maxInject);
  writeState(st.session, { ...st, used_at: new Date(now).toISOString(), used_by: typeof ev.session_id === 'string' ? ev.session_id.slice(0, 8) : '' }); log({ kind: 'used', session: st.session.slice(0, 8), file: st.file });
  return { systemMessage: `W: loaded the continue file ${st.file}.`, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `== Continue prompt from the previous session (written by Claude for W; the owner's words in this chat come first, check state before acting on it) ==\n${text}${cut ? `\n[cut at ${cfg.maxInject} characters; the rest is in ${st.file}]` : ''}` } };
}

// ---------------------------------------------------------------- jobs W runs itself (wk-job): here the clear is real
// askForJob returns the text to send the waiting job as a reply; peekForJob says whether its file is ready; usedForJob marks it used
// once the fresh job has started, so a failed start leaves the file for another try.
export function askForJob(jobId, why = 'the job has grown large', now = Date.now()) {
  const sid = `job-${jobId}`; if (!SID.test(sid)) throw new Error('unknown job');
  const file = path.join(dir(), `${stamp(new Date(now))}-${sid.slice(0, 20)}.md`);
  writeState(sid, { session: sid, cwd: '', job: String(jobId), asked_at: new Date(now).toISOString(), why: oneLine(why, 120), file, tries: 0 });
  log({ kind: 'asked', session: sid.slice(0, 20), why: oneLine(why, 120), job: true });
  return { file, text: askText(oneLine(why, 120), file) };
}
export function peekForJob(jobId, maxChars = 6500) {
  const sid = `job-${jobId}`; if (!SID.test(sid)) return { ok: false, why: 'unknown job' };
  const st = readState(sid); if (!st || !st.file) return { ok: false, why: 'W has not asked this job for a continue file' };
  if (st.used_at) return { ok: false, why: 'its continue file was already used' };
  const c = checkFile(st.file, config()); if (!c.ok) return { ok: false, why: c.why };
  let text = fs.readFileSync(st.file, 'utf8').replace(END, '').trim(); const cut = text.length > maxChars; if (cut) text = text.slice(0, maxChars);
  return { ok: true, file: st.file, text: cut ? `${text}\n[cut; the full file is ${st.file}]` : text };
}
export function usedForJob(jobId, nextId, now = Date.now()) {
  const sid = `job-${jobId}`, st = readState(sid); if (!st) return;
  writeState(sid, { ...st, ready_at: st.ready_at || new Date(now).toISOString(), used_at: new Date(now).toISOString(), used_by: String(nextId) }); log({ kind: 'job-cleared', job: String(jobId), next: String(nextId) });
}

// ---------------------------------------------------------------- the status line (the real usage numbers)
const pct = (w) => (w && typeof w === 'object' && Number.isFinite(+w.used_percentage) && w.used_percentage !== null && +w.used_percentage >= 0 ? +w.used_percentage / 100 : null);
const resets = (w) => (w && Number.isFinite(+w.resets_at) ? +w.resets_at : null);
// Writes steward/meter.json in the steward's own shape from the status line's JSON; returns the line to print. No numbers: no write, empty line.
export const meterPath = () => process.env.WK_METER || path.join(process.env.WK_STEWARD_DIR || path.join(wkHome(), 'steward'), 'meter.json');
export function onStatusLine(ev, now = Date.now()) {
  const rl = ev && ev.rate_limits; if (!rl || typeof rl !== 'object') return '';
  const five = pct(rl.five_hour), week = pct(rl.seven_day);
  if (five === null && week === null) return '';
  const f = meterPath();
  // every window Claude Code reports, merged over the windows kept from earlier readings (headless calls add seven_day_fable and the like) whose reset is still ahead
  const old = readJsonFile(f, null), windows = {};
  if (old && old.windows && typeof old.windows === 'object') for (const [k, v] of Object.entries(old.windows)) if (v && typeof v === 'object' && !(Number.isFinite(+v.resetsAt) && +v.resetsAt * 1000 <= now)) windows[k] = v;
  for (const [k, v] of Object.entries(rl)) { const u = pct(v); if (u !== null) windows[k] = { utilization: u, resetsAt: resets(v), status: windows[k] ? windows[k].status ?? null : null }; }
  const m = { fetchedAt: new Date(now).toISOString(), utilization: week, resetsAt: week === null ? null : resets(rl.seven_day), status: null,
    fiveHour: five === null ? null : { utilization: five, resetsAt: resets(rl.five_hour) }, windows, source: 'statusline' };
  try { ensure(path.dirname(f)); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f); } catch {}
  return [five === null ? '' : `5h ${Math.round(five * 100)}%`, week === null ? '' : `week ${Math.round(week * 100)}%`].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- the one status line (shared with wk-status --json); file reads only, never throws
const rpDir = resolveDataDir;   // one resolver for every reader (bin/rp-dir.mjs)
const vaultDir = () => process.env.REPROMPT_SKILL_VAULT_DIR || path.join(os.homedir(), '.gemini', 'skill-vault');
export function librarySummary() {
  try {
    const idx = readJsonFile(path.join(vaultDir(), 'index.json'), null), src = readJsonFile(path.join(vaultDir(), 'sources.json'), null);
    if (!idx || !Number.isFinite(+idx.skill_count)) return null;
    const repos = src && Array.isArray(src.repos) ? src.repos : [];
    // P2-272 (B): the one approved-only rule (panel/src/skill-gate.js); a listed index counts only skills from approved sources and the owner's own
    const gate = createRequire(import.meta.url)('../panel/src/skill-gate.js');
    const skills = Array.isArray(idx.skills) ? gate.allowedSkills(idx, src).length : +idx.skill_count;
    return { skills, toReview: repos.filter((r) => r && typeof r === 'object' && !gate.isApproved(r) && r.status !== 'rejected').length };
  } catch { return null; }
}
const ageText = (ms) => { const m = Math.floor(Math.max(0, ms) / 6e4); return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
export function graphSummary(cwd) {
  try {
    if (!cwd || typeof cwd !== 'string') return null;
    const g = path.join(cwd, 'graphify-out', 'graph.json'); if (!fs.existsSync(g)) return null;
    let out = ageText(Date.now() - fs.statSync(g).mtimeMs);
    const c = readJsonFile(path.join(cwd, 'graphify-out', 'wk-coverage.json'), null);   // P2-272: { files_indexed, files_total, truncated }
    if (c && Number.isFinite(+c.files_indexed) && Number.isFinite(+c.files_total) && +c.files_total > 0) out += `, ${+c.files_indexed}/${+c.files_total}${c.truncated === true ? ' truncated' : ''}`;
    return out;
  } catch { return null; }
}
const WNAME = { seven_day_fable: 'Fable', seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' };
// host: 'claude' (the Claude Code status line) follows claudeCodeRewrite; anything else (the panel, Antigravity) follows hookAutoAll.
// P2-273: both also follow the 30-word rule (autoRewriteOverWords); the parsing and the settings migration come from the grammar.
const PP = createRequire(import.meta.url)('../panel/src/prompt-prefix.js');
export function rpWords(rp, host) {
  const s = PP.migrateSettings(rp), n = PP.autoOverWords(s.autoRewriteOverWords), byWords = n > 0 ? `rp: >${n} words` : 'rp: on request';
  if (host === 'claude') {
    const mode = String(s.claudeCodeRewrite || 'words').toLowerCase();
    return mode === 'always' ? 'rp: all' : mode === 'never' ? 'rp: off' : mode === 'prefix' ? 'rp: on request' : byWords;
  }
  return s.hookAutoAll ? 'rp: all' : byWords;
}
export function statusLine({ cwd, meter, host } = {}) {
  try {
    const m = meter === undefined ? readJsonFile(meterPath(), null) : meter, now = Date.now(), parts = [];
    parts.push(fs.existsSync(path.join(wkHome(), 'KILL')) ? 'W off' : 'W on');
    parts.push(rpWords(readJsonFile(path.join(rpDir(), 'settings.json'), {}), host));
    const gr = graphSummary(cwd); if (gr) parts.push(`graph ${gr}`);
    const lib = librarySummary(); if (lib) parts.push(`library ${lib.skills}${lib.toReview ? ` (${lib.toReview} to review)` : ''}`);
    // P2-272 (B): skills injected for the latest prompt (runtime/skills-injected/latest.json, written by the skill hooks); shown only when N > 0
    const inj = readJsonFile(path.join(wkHome(), 'runtime', 'skills-injected', 'latest.json'), null), n = inj && Number.isInteger(+inj.count) ? +inj.count : 0;
    if (n > 0) parts.push(`skills ${n}`);
    const live = (v) => v && Number.isFinite(+v.utilization) && !(Number.isFinite(+v.resetsAt) && +v.resetsAt * 1000 <= now);
    const w = (m && m.windows) || {}, five = live(w.five_hour) ? w.five_hour : m && live(m.fiveHour) ? m.fiveHour : null, wk = live(w.seven_day) ? w.seven_day : m && Number.isFinite(+m.utilization) && live({ utilization: m.utilization, resetsAt: m.resetsAt }) ? { utilization: m.utilization } : null;
    const usage = [];
    if (five) usage.push(`5h ${Math.round(five.utilization * 100)}%`);
    if (wk) usage.push(`7d ${Math.round(wk.utilization * 100)}%`);
    for (const [k, n] of Object.entries(WNAME)) if (live(w[k])) usage.push(`${n} ${Math.round(w[k].utilization * 100)}%`);
    let line = [...parts, ...usage].join(' · ');
    // stay near 100 characters: drop the least useful parts first
    const order = [(a) => a.startsWith('5h '), (a) => a.startsWith('graph '), (a) => a.startsWith('skills '), (a) => a.startsWith('library ')];
    let all = [...parts, ...usage];
    for (const t of order) { if (line.length <= 100) break; all = all.filter((a) => !t(a)); line = all.join(' · '); }
    return line.slice(0, 120) || 'W';
  } catch { return 'W'; }
}

// ---------------------------------------------------------------- commands
export function status() {
  let names = []; try { names = fs.readdirSync(path.join(dir(), 'sessions')).filter((n) => n.endsWith('.json')); } catch {}
  const rows = names.map((n) => readJsonFile(path.join(dir(), 'sessions', n), null)).filter(Boolean)
    .map((s) => ({ session: String(s.session).slice(0, 8), cwd: s.cwd, asked_at: s.asked_at, why: s.why, file: s.file, state: s.used_at ? 'used' : s.ready_at ? 'ready' : s.gave_up ? 'gave up' : 'asked' }))
    .sort((a, b) => String(b.asked_at).localeCompare(String(a.asked_at)));
  const rq = readJsonFile(requestFile(), null);
  return { enabled: config().enabled, request: rq && rq.until > Date.now() ? rq : null, rows };
}

const HOOKS = { Stop: { matcher: undefined, cmd: 'stop' }, SessionStart: { matcher: 'clear', cmd: 'start' } };
const SELF = fileURLToPath(import.meta.url);
const hookCommand = (cmd) => `node "${SELF}" ${cmd} 2>/dev/null; exit 0`;
const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes('wk-handoff.mjs');
// { hooks: false } (P2-272, `--statusline-only`): touch only the status line; every hook stays exactly as it is.
export function patchSettings(s, add, { hooks = true } = {}) {
  const out = JSON.parse(JSON.stringify(s || {}));
  if (hooks) {
    out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
    for (const [ev, def] of Object.entries(HOOKS)) {
      let list = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
      list = list.map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length);
      if (add) list.push({ ...(def.matcher ? { matcher: def.matcher } : {}), hooks: [{ type: 'command', command: hookCommand(def.cmd), timeout: 15 }] });
      if (list.length) out.hooks[ev] = list; else delete out.hooks[ev];
    }
    if (!Object.keys(out.hooks).length) delete out.hooks;
  }
  const sl = out.statusLine, ours = sl && typeof sl.command === 'string' && sl.command.includes('wk-handoff.mjs');
  if (add && !sl) out.statusLine = { type: 'command', command: `node "${SELF}" statusline 2>/dev/null; exit 0` };
  else if (!add && ours) delete out.statusLine;
  return out;
}
function settingsCmd(add, apply, hooks = true) {
  const f = path.join(claudeHome(), 'settings.json'); let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error(`${f} is not valid JSON; nothing changed.`); return 1; } }
  const next = patchSettings(cur, add, { hooks });
  const theirLine = !!(cur.statusLine && !String(cur.statusLine.command || '').includes('wk-handoff.mjs'));
  if (JSON.stringify(next) === JSON.stringify(cur)) {
    if (hooks) console.log(add ? 'The two hooks are already in place.' : 'No wk-handoff hooks are installed.');
    else console.log(add ? (theirLine ? 'You already have your own status line, so nothing changed.' : 'The Watchkeeper status line is already in place.') : 'No Watchkeeper status line is installed.');
    return 0;
  }
  const what = hooks ? 'the Stop and SessionStart (clear) hooks of wk-handoff' : 'the Watchkeeper status line (no hooks)';
  if (!apply) { console.log(`${add ? 'Would add' : 'Would remove'} ${what} in ${f}. Run again with --apply; the old file is backed up first.`); return 0; }
  const bk = path.join(wkHome(), 'backups', `settings.json.${stamp()}-before-handoff`); ensure(path.dirname(bk)); if (fs.existsSync(f)) fs.copyFileSync(f, bk);
  ensure(path.dirname(f));
  const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
  if (!hooks) { console.log(`${add ? 'Added' : 'Removed'} the Watchkeeper status line in ${f}. Backup: ${bk}. New Claude Code sessions ${add ? 'show' : 'no longer show'} it.`); return 0; }
  console.log(`${add ? 'Installed' : 'Removed'} the wk-handoff hooks in ${f}. Backup: ${bk}. New Claude Code sessions use them.${add && cur.statusLine && !String(cur.statusLine.command || '').includes('wk-handoff.mjs') ? ' You already have a status line, so it was left alone: without wk-handoff statusline the usage limits are not seen.' : ''}`); return 0;
}

export function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: wk-handoff stop | start | statusline | status [--json] | request --why "<text>" [--hours N] | request --off | install [--apply] [--statusline-only] | uninstall [--apply] [--statusline-only]');
    return 0;
  }
  const [cmd, ...a] = argv; const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    if (cmd === 'stop') { const r = onStop(readEvent()); if (r) emit(r); return 0; }
    if (cmd === 'start') { const r = onStart(readEvent()); if (r) emit(r); return 0; }
    if (cmd === 'statusline') { const ev = readEvent(); try { onStatusLine(ev); } catch {} process.stdout.write(statusLine({ cwd: ev.cwd || (ev.workspace && ev.workspace.current_dir) || process.cwd(), host: 'claude' }) + '\n'); return 0; }
  } catch { if (cmd === 'statusline') process.stdout.write('W\n'); return 0; }   // a hook never breaks a session
  if (cmd === 'status') {
    const s = status(); if (a.includes('--json')) { console.log(JSON.stringify(s, null, 1)); return 0; }
    console.log(`Handoff: ${s.enabled ? 'on' : 'off'}${s.request ? `; W's request to every session runs until ${new Date(s.request.until).toISOString()} (${oneLine(s.request.why, 80)})` : ''}`);
    for (const r of s.rows.slice(0, 20)) console.log(`${r.state.padEnd(8)} ${r.session} ${r.asked_at} ${oneLine(r.why, 70)} ${r.file}`);
    if (!s.rows.length) console.log('No session has been asked yet.'); return 0;
  }
  if (cmd === 'request') {
    if (a.includes('--off')) { try { fs.rmSync(requestFile()); } catch {} console.log('W\'s request is withdrawn.'); return 0; }
    const why = oneLine(flag('--why'), 200); if (!why) { console.error('usage: wk-handoff request --why "<text>" [--hours N] | --off'); return 2; }
    const h = Number(flag('--hours')) > 0 ? Math.min(24, Number(flag('--hours'))) : config().requestHours;
    ensure(dir()); writePrivate(requestFile(), JSON.stringify({ at: new Date().toISOString(), why, until: Date.now() + h * 36e5 })); log({ kind: 'request', why, hours: h });
    console.log(`Every session is asked for a continue file at its next Stop, for ${h} hour(s).`); return 0;
  }
  if (cmd === 'install' || cmd === 'uninstall') return settingsCmd(cmd === 'install', a.includes('--apply'), !a.includes('--statusline-only'));
  console.error('usage: wk-handoff stop | start | statusline | status [--json] | request --why "<text>" [--hours N] | request --off | install [--apply] [--statusline-only] | uninstall [--apply] [--statusline-only]'); return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) process.exit(main(process.argv.slice(2)));
