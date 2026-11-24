#!/usr/bin/env node
// wk-ask-claude (P2-208): another agent (Gemini in Antigravity) asks Claude, and Claude answers the way the owner would.
//   wk-ask-claude [ask] [--from gemini] [--project <dir>] [--file <question.md>] ["question" | stdin]
//       Claude Code runs headless (the newest top model of config/models.json "legal", effort max), read-only (Read, Grep, Glob behind the
//       Watchkeeper guard), in the main project folder so its CLAUDE.md files and memory load, with the voice file
//       appended to its system prompt: ~/.wk/voice.md (your own) if there is one, else antigravity/owner-voice.md if this clone has it,
//       else antigravity/voice.example.md. Prints the answer and saves it to
//       ~/.wk/advice/<id>/answer.md. One question at a time (later ones wait), a daily cap, and the kill switch stops it.
//   wk-ask-claude list [--json]                -> the last 10 questions, newest first
//   wk-ask-claude show <id>                    -> the saved answer (or its state)
//   wk-ask-claude install-antigravity [--dest <plugins dir>] [--dry-run]
//       copies antigravity/plugins/watchkeeper (skills, agents, rules, hooks) into ~/.gemini/config/plugins/ (an older copy is backed up to ~/.wk/backups/); same as wk-antigravity install
// Exit: 0 answered, 1 failed, 2 bad input, 3 stopped by the kill switch, 4 daily cap reached.
// Env (tests and tuning): WK_HOME (default ~/.wk), WK_ASK_CLAUDE_BIN, WK_ASK_CWD (the main project folder; without it: "main_project" in
//   ~/.wk/ask.json, then the --project folder when it exists, then the current folder), WK_ASK_MODEL (a fixed model instead of the picker),
//   WK_ASK_EFFORT (max), WK_ASK_RETRY_MS (60000, the wait after a busy answer; the model stays), WK_ASK_DAILY_MAX (8), WK_ASK_TIMEOUT_MIN (30), WK_ASK_WAIT_MIN (40), WK_LEDGER (passed to wk-ledger).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, gates, killOn, killFile } from './lib.mjs';
import { pick, runPicked, config as modelConfig } from './model-pick.mjs';
import { config as geminiConfig } from './gemini-lib.mjs';
import { isClaudeLimitError } from './wk-carbon-fallback.mjs';

const HOME = os.homedir();
const tilde = p => (p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const wkHome = () => path.resolve(process.env.WK_HOME || path.join(HOME, '.wk'));
export const adviceDir = () => path.join(wkHome(), 'advice');
export const ID_RE = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;
const MIN_Q = 10, MAX_Q = 20000;
const ASKERS = /^[a-z][a-z0-9 ._-]{0,30}$/i;

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export const slug = t => (t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'question');
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeFile = (p, s) => { fs.writeFileSync(p + '.tmp', s, { mode: 0o600 }); fs.renameSync(p + '.tmp', p); };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { cmd: 'ask', from: 'gemini', project: process.cwd(), file: null, text: [], json: false, dryRun: false, dest: null };
  const a = [...argv];
  if (['ask', 'list', 'show', 'install-antigravity'].includes(a[0])) o.cmd = a.shift();
  while (a.length) {
    const x = a.shift();
    if (x === '--from') o.from = a.shift() || '';
    else if (x === '--project') o.project = a.shift() || '';
    else if (x === '--file') o.file = a.shift() || '';
    else if (x === '--dest') o.dest = a.shift() || '';
    else if (x === '--json') o.json = true;
    else if (x === '--dry-run') o.dryRun = true;
    else o.text.push(x);
  }
  return o;
}

// ---------------------------------------------------------------- records
export function listAdvice(dir = adviceDir(), n = 10) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(x => ID_RE.test(x)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const id of names) {
    const m = readJSON(path.join(dir, id, 'meta.json'));
    if (!m || m.id !== id) continue;
    if (m.status === 'asking' && !alive(m.pid)) m.status = 'stopped';
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

export function askedToday(dir = adviceDir(), now = new Date()) {
  const day = stamp(now).slice(0, 8);
  try { return fs.readdirSync(dir).filter(x => ID_RE.test(x) && x.startsWith(day)).filter(id => { const m = readJSON(path.join(dir, id, 'meta.json')); return m && m.status !== 'refused'; }).length; }
  catch { return 0; }
}

// One question at a time: a lock file made with 'wx' (never follows or overwrites), holding "pid time". A stale lock is taken
// over: its pid is gone, or it is older than one question can run (a reused pid would otherwise look alive).
async function takeLock(dir, waitMin, say, staleMs = Infinity) {
  const lock = path.join(dir, '.busy');
  const until = Date.now() + waitMin * 60e3;
  let told = false;
  for (;;) {
    try { fs.writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: 'wx', mode: 0o600 }); return lock; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid = 0, t = 0; try { [pid, t] = String(fs.readFileSync(lock, 'utf8')).trim().split(/\s+/).map(Number); } catch { continue; }
    if (!alive(pid) || (t > 0 && Date.now() - t > staleMs)) { try { fs.unlinkSync(lock); } catch {} continue; }
    if (Date.now() > until) return null;
    if (!told) { say(`Claude is answering another question; this one waits its turn (up to ${waitMin} minutes).`); told = true; }
    await sleep(5000);
  }
}

// A key or token in the question or the answer: the question is refused, the answer held back (gates.json secretPatterns).
export const looksSecret = (text, patterns) => patterns.some(p => { try { return new RegExp(p).test(text); } catch { return false; } });

// ---------------------------------------------------------------- the main project folder and the voice (P2-243)
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// The folder Claude answers from: WK_ASK_CWD; "main_project" in ~/.wk/ask.json (missing or broken: skipped; "~/" is the home folder);
// the --project folder when it exists; else the current folder.
// projectChoice also says where the folder came from: "WK_ASK_CWD", "ask.json", "--project" or "the current folder".
export function projectChoice(project, { env = process.env, home = HOME } = {}) {
  if (env.WK_ASK_CWD) return { dir: path.resolve(env.WK_ASK_CWD), from: 'WK_ASK_CWD' };
  const j = readJSON(path.join(wkHome(), 'ask.json'));
  const m = j && typeof j === 'object' && !Array.isArray(j) && typeof j.main_project === 'string' ? j.main_project.trim() : '';
  if (m) return { dir: path.resolve(m === '~' ? home : m.startsWith('~/') ? path.join(home, m.slice(2)) : m), from: 'ask.json' };
  if (project) return { dir: path.resolve(project), from: '--project' };
  return { dir: process.cwd(), from: 'the current folder' };
}
export const mainProject = (project, opts) => projectChoice(project, opts).dir;
// Neither WK_ASK_CWD nor ask.json set: the folder Claude read is a fallback, so the answer says which one it was.
const fallbackNote = c => (c.from === '--project' || c.from === 'the current folder')
  ? `Claude read ${tilde(c.dir)} (${c.from === '--project' ? 'the --project folder' : 'the current folder'}), because neither main_project in ~/.wk/ask.json nor WK_ASK_CWD is set.` : '';
// The voice appended to Claude's system prompt: the user's own ~/.wk/voice.md, else the owner's file when this clone has it, else the example.
export function voiceFile({ wk = wkHome(), dir = root() } = {}) {
  for (const f of [path.join(wk, 'voice.md'), path.join(dir, 'antigravity', 'owner-voice.md')]) if (isFile(f)) return f;
  return path.join(dir, 'antigravity', 'voice.example.md');
}

// ---------------------------------------------------------------- the headless Claude call
export function claudeArgs({ model, effort, project, voiceFile, guardFile, node = process.execPath }) {
  // the guard runs with an absolute node: a hook that cannot start exits 127, which Claude Code treats as non-blocking (fail open)
  const hook = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${JSON.stringify(node)} ${JSON.stringify(guardFile)}` }] }] } };
  const args = ['-p', '--model', model, '--effort', effort, '--output-format', 'json',
    '--append-system-prompt-file', voiceFile,
    '--settings', JSON.stringify(hook),
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];
  if (project) args.push('--add-dir', project);
  return args;
}

export function promptFor({ question, from, project, at }) {
  return [
    `A question from ${from} (an AI agent in Antigravity working for the owner), asked ${at}.`,
    project ? `It is working in: ${tilde(project)}` : '',
    'Answer it as the owner would, following the instructions appended to your system prompt.',
    '',
    '<question>',
    question.replace(/<\/?\s*question\s*>/gi, ''),
    '</question>',
  ].filter(x => x !== '').join('\n');
}

// Antigravity's agent shell may not have ~/.local/bin on PATH, where Claude Code's installer puts `claude`.
export function findClaude(env = process.env) {
  const dirs = [...String(env.PATH || '').split(path.delimiter).filter(Boolean), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) { const p = path.join(d, 'claude'); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  return 'claude';
}

function runClaude(bin, args, input, { cwd, timeoutMs, nodeDir }) {
  return new Promise(resolve => {
    const PATH = [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH, WK_ASK: '1' } });
    let out = '', err = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message), timedOut }); });
    child.on('close', code => { clearTimeout(t); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve({ code, out, err, timedOut }); });
    child.stdin.end(input);
  });
}

async function ask(o) {
  let question = '';
  if (o.file) { try { question = fs.readFileSync(path.resolve(o.file), 'utf8'); } catch { console.error(`wk-ask-claude: cannot read ${o.file}`); return 2; } }
  else if (o.text.length) question = o.text.join(' ');
  else if (!process.stdin.isTTY) question = fs.readFileSync(0, 'utf8');
  question = question.trim();
  if (question.length < MIN_Q) { console.error('wk-ask-claude: write the question (at least a sentence) as an argument, with --file, or on stdin.'); return 2; }
  if (question.length > MAX_Q) { console.error(`wk-ask-claude: the question is over ${MAX_Q.toLocaleString('en-GB')} characters; shorten it or point to files by path.`); return 2; }
  if (!ASKERS.test(o.from)) { console.error('wk-ask-claude: --from takes a short name such as gemini.'); return 2; }
  const project = o.project && fs.existsSync(o.project) ? path.resolve(o.project) : null;

  // the owner's stop button wins over everything
  let g; try { g = gates({ allowMismatch: true }); } catch (e) { console.error(`wk-ask-claude: Watchkeeper's policy cannot be read (${e.message}); not asking.`); return 1; }
  if (killOn(g)) {
    console.log(`Not asked: the owner has stopped Watchkeeper (kill switch ${tilde(killFile(g))} is on).\nDo not wait for Claude. Carry on with the choice that best fits the owner's rules, note it for the owner, or ask the owner directly.`);
    return 3;
  }
  if (looksSecret(question, g.secretPatterns)) { console.error('wk-ask-claude: the question looks like it holds a key or token. Take it out and ask again; it was not saved.'); return 2; }
  const dir = adviceDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cap = Number(process.env.WK_ASK_DAILY_MAX) || 8;
  const capped = () => { console.log(`Not asked: ${cap} questions today is the owner's daily limit for Claude's answers. Decide from the owner's rules (CLAUDE.md, memory, DECISIONS.md) and note the question for the owner.`); return 4; };
  if (askedToday(dir) >= cap) return capped();
  const say = s => console.log(s);
  const timeoutMin = Number(process.env.WK_ASK_TIMEOUT_MIN) || 30;
  const lock = await takeLock(dir, Number(process.env.WK_ASK_WAIT_MIN) || 40, say, (timeoutMin + 5) * 60e3);
  if (!lock) { console.log('Not asked: Claude was busy with other questions for too long. Try again later.'); return 1; }
  // questions that waited in the queue count too
  if (askedToday(dir) >= cap) { try { fs.unlinkSync(lock); } catch {} return capped(); }

  const now = new Date();
  let id = `${stamp(now)}-${slug(question.split('\n')[0])}`;
  for (let i = 2; fs.existsSync(path.join(dir, id)); i++) id = `${stamp(now)}-${slug(question.split('\n')[0]).slice(0, 28)}-${i}`;
  const d = path.join(dir, id); fs.mkdirSync(d, { mode: 0o700 });
  // the owner's rule (16 Nov 2026): the newest top model the plan has (config/models.json "legal"), at max effort; WK_ASK_MODEL pins one
  const fixed = process.env.WK_ASK_MODEL || null, mc = modelConfig();
  let model = fixed || pick('legal', { c: mc }).model;
  const effort = process.env.WK_ASK_EFFORT || mc.legal_effort_ask;
  const choice = projectChoice(project), cwd = choice.dir, folderNote = fallbackNote(choice);
  const meta = { id, from: o.from, project: project ? tilde(project) : null, folder: tilde(cwd), folder_from: choice.from, asked_at: now.toISOString(), status: 'asking', pid: process.pid, model, effort,
    preview: question.replace(/\s+/g, ' ').slice(0, 300) };
  writeFile(path.join(d, 'question.md'), question + '\n');
  writeFile(path.join(d, 'meta.json'), JSON.stringify(meta, null, 2));
  const answerFile = path.join(d, 'answer.md');
  say(`Asking Claude (${model}, ${effort} effort, read-only) to answer as the owner. This usually takes 3 to 10 minutes.\nThe answer will also be saved to ${tilde(answerFile)}`);

  const bin = process.env.WK_ASK_CLAUDE_BIN || findClaude();
  const nodeBin = (n => (path.isAbsolute(n) ? n : process.execPath))(findNode());
  const started = Date.now();
  const ledger = j => {   // every call shows in the W panel and in wk-ledger summary, a fallen-back one too
    if (j && typeof j === 'object') spawnSync(process.execPath, [path.join(root(), 'bin', 'wk-ledger.mjs'), 'add', `ask-claude ${id}`], { input: JSON.stringify(j), encoding: 'utf8', env: process.env });
  };
  const once = async mdl => {
    const args = claudeArgs({ model: mdl, effort, project: project && project !== cwd ? project : null, node: nodeBin,
      voiceFile: voiceFile(), guardFile: path.join(root(), 'bin', 'wk-guard.mjs') });
    const rr = await runClaude(bin, args, promptFor({ question, from: o.from, project, at: now.toISOString() }), { cwd, timeoutMs: timeoutMin * 60e3, nodeDir: path.dirname(nodeBin) });
    let jj = null; try { jj = JSON.parse(rr.out.trim().split('\n').pop()); } catch {}
    ledger(jj);
    return { out: jj || rr.out, rr };
  };
  let r, fallbacks = [];
  try {
    if (!fs.existsSync(cwd)) r = { code: -1, out: '', err: `the main project folder ${tilde(cwd)} is not on this computer (set main_project in ~/.wk/ask.json, or WK_ASK_CWD)`, timedOut: false };
    else if (fixed) r = (await once(model)).rr;
    else {
      const res = await runPicked('legal', once, { from: `ask ${id}`, retries: 2, waitMs: Number(process.env.WK_ASK_RETRY_MS) || 60000, c: mc,
        onFallback: (was, next) => say(next ? `${was} is not available on this plan; asking ${next} instead.` : `${was} is not available on this plan, nor any other model in the legal order.`),
        onBusy: (mdl, n, ms) => say(`Claude is busy (a rate limit or overload); trying ${mdl} again in ${Math.round(ms / 1000)} s. The model stays the same.`) });
      model = res.model; r = res.r.rr; fallbacks = res.fallbacks.map(x => x.model);
    }
  } finally { try { fs.unlinkSync(lock); } catch {} }
  meta.model = model; if (fallbacks.length) meta.unavailable = fallbacks;

  let j = null; try { j = JSON.parse(r.out.trim().split('\n').pop()); } catch {}
  const raw = j && typeof j.result === 'string' ? j.result.trim() : '';
  const at = raw.search(/^Answer:/m), answer = at > 0 ? raw.slice(at) : raw;
  const held = answer.length > 0 && looksSecret(answer, g.secretPatterns);
  let ok = r.code === 0 && j && !j.is_error && answer.length > 0 && !held;
  let finalAnswer = answer;
  const hitLimit = !ok && (
    isClaudeLimitError(r.err) ||
    isClaudeLimitError(j) ||
    isClaudeLimitError(r.out) ||
    (r.code === -1 && /ENOENT/.test(String(r.err)))
  );
  // P2-272 Phase 4A fixes (A3): the asker waits on this answer, so its question is never queued for Antigravity (it would
  // queue the asker's own question). At Claude's usage limit the question fails in plain words and the asker carries on.
  // An overload is Claude being busy, not a usage limit: its own error text is kept (test/ask.test.mjs 'model overloaded').
  const noOverload = v => String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v))).replace(/overloaded/gi, '');
  const usageLimit = isClaudeLimitError(noOverload(r.err)) || isClaudeLimitError(noOverload(j)) || isClaudeLimitError(noOverload(r.out));
  const limitNote = hitLimit && usageLimit && !(r.code === -1 && /ENOENT/.test(String(r.err))) ? 'Claude Code reached its usage limit; not answered' : '';
  Object.assign(meta, { status: ok ? 'answered' : 'failed', pid: null, finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
    cost_usd: (meta.provider === 'orchestrator-carbon-high' || meta.provider === 'antigravity-queue') ? 0 : (j && typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null),
    session_id: j && typeof j.session_id === 'string' ? j.session_id : null,
    error: ok ? null : limitNote ? limitNote : meta.queued_note ? String(meta.queued_note).slice(0, 200) : held ? 'answer held back: it looks like it holds a key or token' : (r.timedOut ? 'timed out' : (j && j.is_error ? String(j.result || j.subtype || 'error').slice(0, 200) : `exit ${r.code}${r.err ? ': ' + r.err.trim().split('\n').pop().slice(0, 300) : ''}`)) });
  if (ok) writeFile(answerFile, finalAnswer + '\n');
  writeFile(path.join(d, 'meta.json'), JSON.stringify(meta, null, 2));
  if (!ok && r.code === -1 && /ENOENT/.test(String(r.err))) {   // Gemini only: no Claude Code on this computer
    const lane = (geminiConfig().routes || {}).legal;
    console.log(`Claude Code is not on this computer, so Claude could not answer.${lane ? ` For legal wording, do the work as a task of kind "legal" (${lane.model}, or ${lane.fallback} if your plan lacks it), the strongest Gemini model,` : ' Choose what best fits the owner\'s rules'} and note it for the owner: legal wording waits for the owner's approval before use.`);
    return 1;
  }
  if (!ok && meta.queued_note) { console.log(`Claude Code reached its usage limit. ${meta.queued_note} Carry on with the choice that best fits the owner's rules and note the question for the owner.${folderNote ? ' ' + folderNote : ''}`); return 1; }
  if (!ok) { console.log(`Claude could not answer (${meta.error}). Carry on with the choice that best fits the owner's rules and note the question for the owner.${folderNote ? ' ' + folderNote : ''}`); return 1; }
  console.log('\n' + finalAnswer + `\n\n(Saved to ${tilde(answerFile)}${folderNote ? '. ' + folderNote : ''})`);
  return 0;
}

function list(o) {
  const rows = listAdvice();
  if (o.json) { console.log(JSON.stringify(rows)); return 0; }
  if (!rows.length) { console.log('No questions yet.'); return 0; }
  for (const m of rows) console.log(`${m.id}  ${m.status}  ${m.from}: ${String(m.preview || '').slice(0, 90)}`);
  return 0;
}

function show(o) {
  const id = o.text[0];
  if (!id || !ID_RE.test(id)) { console.error('usage: wk-ask-claude show <id>   (ids come from wk-ask-claude list)'); return 2; }
  const m = readJSON(path.join(adviceDir(), id, 'meta.json'));
  if (!m) { console.error(`wk-ask-claude: no question ${id}`); return 2; }
  try { console.log(fs.readFileSync(path.join(adviceDir(), id, 'answer.md'), 'utf8').trimEnd()); return 0; }
  catch { console.log(`No answer saved: ${m.status === 'asking' && !alive(m.pid) ? 'stopped' : m.status}${m.error ? ` (${m.error})` : ''}.`); return m.status === 'asking' ? 0 : 1; }
}

// ---------------------------------------------------------------- Antigravity plugin install
// The installer lives in antigravity-lib.mjs (P2-223: the whole plugin, skills, agents, rules and hooks); wk-antigravity.mjs uses it too.
export { findNode, installAntigravity } from './antigravity-lib.mjs';
import { findNode, installAntigravity } from './antigravity-lib.mjs';

function install(o) {
  const r = installAntigravity({ dest: o.dest ? path.resolve(o.dest.replace(/^~(?=\/|$)/, HOME)) : undefined, dryRun: o.dryRun });
  const words = { current: 'already up to date', installed: 'installed', updated: 'updated', 'would-install': 'would be installed', 'would-update': 'would be updated' };
  console.log(`Antigravity plugin ${words[r.state]}: ${tilde(r.target)} (${r.files.length} files)${r.backup ? `; the old copy is in ${tilde(r.backup)}` : ''}.`);
  if (r.state === 'installed' || r.state === 'updated') console.log('Gemini sees the ask-claude skill and the Watchkeeper skills in its next conversation.');
  return 0;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  const run = { ask, list, show, 'install-antigravity': install }[o.cmd];
  Promise.resolve(run(o)).then(code => process.exit(code), e => { console.error(`wk-ask-claude: ${e.message}`); process.exit(1); });
}
