#!/usr/bin/env node
// wk-carbon-fallback (v0.8.0; P2-272): when Claude Code hits plan, rate, or quota limits, it queues the task
// for Antigravity in the wk-task file queue. It never runs agy or Gemini (canon: the owner's Google login).
// Enforces Watchkeeper's kill switch and secret scanning, never passes unsafe flags.
// Since P2-272 Phase 4 (Q163) it no longer runs Gemini: it queues the task for Antigravity with wk-task.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGY_CANON_MESSAGE, agyBlockedForClaude, gates, homeWk, killOn, scanPII } from './lib.mjs';
import { createDynamicStallGuard } from './wk-watchdog.mjs';

export const CARBON_HIGH_MODEL = 'gemini-4-carbon-high';
export const CARBON_FALLBACK_CHAIN = Object.freeze([
  'gemini-4-carbon-high',
  'gemini-4-argon-high',
  'gemini-4-neon-high',
]);

const LIMIT_RE = /(?:429|rate[_\s-]*limit|usage\s+limit|limit\s+reached|hit\s+your\s+limit|out\s+of\s+extra\s+usage|quota\s+exceeded|resource[_\s-]*exhausted|too\s+many\s+requests|credit\s+balance\s+is\s+too\s+low|overloaded)/i;
const UNAVAIL_RE = /(?:model.*not\s+(?:found|available|supported)|invalid\s+model|unsupported\s+model|not\s+entitled|entitlement|permission\s+denied.*model)/i;

const isExecutable = p => {
  try {
    if (!p) return false;
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findAgyBin(env = process.env) {
  if (env.WK_AGY_BIN) {
    const p = path.resolve(env.WK_AGY_BIN);
    return isExecutable(p) ? p : null;
  }
  const home = env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'bin', 'agy'),
    path.join(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];
  if (!env.WK_ISOLATE_PATH && env.PATH) {
    for (const d of String(env.PATH).split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(d, 'agy'));
    }
  }
  return candidates.find(isExecutable) || null;
}

// P2-272 Phase 4B (A8): is Antigravity on this Mac? Presence only: stat calls, nothing is run or opened.
// The IDE counts when its folder ~/.antigravity-ide or its app is there. WK_APPLICATIONS_DIR names the apps folder for tests;
// with WK_ISOLATE_PATH set (a test), only HOME/Applications is looked at, never the system /Applications.
const ANTIGRAVITY_APPS = ['Antigravity IDE.app', 'Antigravity.app'];
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export function antigravityIdePresent(env = process.env) {
  const home = env.HOME || os.homedir();
  if (isDir(path.join(home, '.antigravity-ide'))) return true;
  const dirs = env.WK_APPLICATIONS_DIR ? [path.resolve(env.WK_APPLICATIONS_DIR)]
    : env.WK_ISOLATE_PATH ? [path.join(home, 'Applications')] : ['/Applications', path.join(home, 'Applications')];
  return dirs.some(d => ANTIGRAVITY_APPS.some(a => isDir(path.join(d, a))));
}

// P2-272 Phase 4B (A8): this gate stands in front of the queue only. Every caller (wk-job start/reply/runJob, the steward)
// goes on to runCarbonHigh, which only queues a wk-task and never runs agy or Gemini, so it is allowed under Claude too
// (Q163); the agyBlockedForClaude step is gone from here. Off switch and the fake-claude test guard stay.
export function canCarbonFallback({ env = process.env, hasFakeClaude = false } = {}) {
  if (env.WK_CARBON_FALLBACK === '0') return false;
  if (hasFakeClaude && env.WK_CARBON_FALLBACK !== '1' && !env.WK_AGY_BIN) return false;
  return Boolean(findAgyBin(env)) || antigravityIdePresent(env);
}

export function isClaudeLimitError(val) {
  if (!val) return false;
  if (typeof val === 'string') return LIMIT_RE.test(val);
  if (Array.isArray(val)) return val.some(isClaudeLimitError);
  if (typeof val === 'object') {
    if (val.api_error_status === 429) return true;
    if (val.rate_limit_info && val.rate_limit_info.status === 'rejected') return true;
    for (const k of ['result', 'error', 'stderr', 'text', 'subtype', 'cooldown_reason']) {
      if (typeof val[k] === 'string' && LIMIT_RE.test(val[k])) return true;
    }
    if (val.message) return isClaudeLimitError(val.message);
  }
  return false;
}

export function extractJsonFromText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch { /* try fenced */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* try brace slice */ }
  }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch { /* not json */ }
  }
  return null;
}

function mapAgyMode(mode) {
  if (!mode) return null;
  if (mode === 'acceptEdits' || mode === 'accept-edits') return 'accept-edits';
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'auto';
  return null;
}

function readCarbonGraphHint(cwd, prompt, env = process.env) {
  if (!cwd || env.WK_GRAPHIFY_DEFAULT === '0') return '';
  try {
    const graphFile = path.join(cwd, 'graphify-out', 'graph.json');
    if (!fs.existsSync(graphFile)) return '';
    const raw = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) return '';
    const toks = new Set(String(prompt || '').toLowerCase().split(/[^a-z0-9_./-]+/).filter(t => t.length >= 3));
    const scored = [];
    for (const n of raw.nodes) {
      if (!n || !n.id) continue;
      const nfile = String(n.source_file || n.file || '');
      const lbl = String(n.label || n.id);
      const hay = `${n.id} ${lbl} ${nfile}`.toLowerCase();
      let score = 0;
      for (const t of toks) if (hay.includes(t)) score += 1;
      if (score > 0 || scored.length < 6) scored.push({ score, lbl, nfile });
    }
    scored.sort((a, b) => b.score - a.score);
    const files = [];
    for (const s of scored) {
      if (s.nfile && !files.includes(s.nfile)) files.push(s.nfile);
      if (files.length >= 8) break;
    }
    if (!files.length) return '';
    const edgeCount = Array.isArray(raw.links) ? raw.links.length : Array.isArray(raw.edges) ? raw.edges.length : 0;
    return `[Graphify Token-Saving Context: ${raw.nodes.length} nodes, ${edgeCount} edges | Focus files first: ${files.join(', ')}]`;
  } catch {
    return '';
  }
}

function buildCarbonPrompt({ prompt, system = '', schema = null, graphHint = '' }) {
  const parts = [];
  if (system && system.trim()) {
    parts.push(`[System Instructions]\n${system.trim()}`);
  }
  if (graphHint) parts.push(graphHint);
  parts.push(String(prompt || '').trim());
  if (schema && typeof schema === 'object') {
    parts.push(
      '[Output Format Requirement]\nReturn ONLY a single valid JSON object (no markdown fences, no commentary outside JSON) conforming strictly to this JSON Schema:\n' +
      JSON.stringify(schema)
    );
  }
  return parts.filter(Boolean).join('\n\n---\n\n');
}

function recordAuditAndLedger({ item, model, ok, inputChars, outputText, reason = null, env = process.env }) {
  try {
    const wk = env.WK_HOME ? path.resolve(env.WK_HOME) : homeWk();
    fs.mkdirSync(wk, { recursive: true, mode: 0o700 });
    const nowIso = new Date().toISOString();
    const auditRow = {
      at: nowIso,
      kind: 'carbon_high_failover',
      item: String(item || 'carbon-fallback').slice(0, 80),
      provider: 'orchestrator-carbon-high',
      model,
      effort: 'high',
      ok: !!ok,
      ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
    };
    fs.appendFileSync(path.join(wk, 'model-audit.jsonl'), JSON.stringify(auditRow) + '\n');

    const ledgerFile = env.WK_LEDGER || path.join(wk, 'ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const ledgerRow = {
      at: nowIso,
      item: `${item || 'carbon-fallback'} (orchestrator:${model})`,
      model,
      cost_usd: 0,
      turns: 1,
      in: Math.ceil(inputChars / 3.8),
      cache_read: 0,
      out: Math.ceil(String(outputText || '').length / 3.8),
      error: !ok,
      p80_estimate: null,
      provider: 'orchestrator-carbon-high',
    };
    fs.appendFileSync(ledgerFile, JSON.stringify(ledgerRow) + '\n');
  } catch { /* best-effort telemetry */ }
}

function insideTmpdir(bin) {
  try {
    const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(String(bin || '')));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

function execOneModel({ agyBin, model, fullPrompt, cwd, mode, sandbox, timeoutMs, killCheck, env }) {
  return new Promise(resolve => {
    const mappedMode = sandbox ? null : mapAgyMode(mode);
    const args = [
      '--disable-slash-commands',
      '--model', model,
      '--effort', 'high',
      '--output-format', 'text',
    ];
    if (sandbox) args.push('--sandbox');
    if (mappedMode) args.push('--mode', mappedMode);
    if (cwd) args.push('--add-dir', cwd);
    args.push(`-p=${fullPrompt}`);

    // P2-272 Phase 4A fixes (A2): this runner only ever starts a stub inside the temporary folder (tests); any other binary,
    // the owner's agy included, is refused before spawn. Real paths, since /var is a link to /private/var on macOS.
    if (!insideTmpdir(agyBin)) {
      resolve({ ok: false, code: -1, out: '', err: AGY_CANON_MESSAGE, stderr: AGY_CANON_MESSAGE, reason: 'canon_blocked', killed: false, timedOut: false, stalled: false });
      return;
    }
    const childEnv = { ...env, NO_COLOR: '1', REPROMPT_INTERNAL_CALL: '1' };
    let child;
    try {
      child = spawn(agyBin, args, {
        cwd: cwd || os.homedir(),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (e) {
      resolve({ ok: false, code: -1, out: '', err: String(e.message || e), killed: false, timedOut: false, stalled: false });
      return;
    }

    let out = '', err = '', killed = false, timedOut = false, stalled = false, settled = false;
    let stallGuard = null;
    const finish = res => {
      if (settled) return;
      settled = true;
      clearTimeout(tTimer);
      if (kPoll) clearInterval(kPoll);
      if (stallGuard) stallGuard.stop();
      resolve(res);
    };
    const terminate = sig => {
      if (process.platform !== 'win32' && child.pid > 1) {
        try { process.kill(-child.pid, sig); } catch { /* gone */ }
      }
      try { child.kill(sig); } catch { /* gone */ }
    };
    const tTimer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 5000).unref();
    }, Math.max(2000, timeoutMs));
    if (tTimer && typeof tTimer.unref === 'function') tTimer.unref();
    const kPoll = typeof killCheck === 'function'
      ? setInterval(() => {
          try {
            if (killCheck()) {
              killed = true;
              terminate('SIGTERM');
              setTimeout(() => terminate('SIGKILL'), 3000).unref();
            }
          } catch { /* ignore */ }
        }, 500)
      : null;
    if (kPoll && typeof kPoll.unref === 'function') kPoll.unref();

    const idleMs = Number(env.WK_CARBON_IDLE_MS || process.env.WK_CARBON_IDLE_MS) || Math.min(timeoutMs, 5 * 60 * 1000);
    stallGuard = createDynamicStallGuard({
      pid: child.pid,
      pgid: child.pid,
      stallMs: idleMs,
      maxWallMs: Math.max(2000, timeoutMs),
      onStall: () => {
        stalled = true;
        terminate('SIGTERM');
        setTimeout(() => terminate('SIGKILL'), 3000).unref();
      },
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { stallGuard.touch(); out = (out + d).slice(-256000); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stallGuard.touch(); err = (err + d).slice(-16000); });
    child.on('error', e => finish({ ok: false, code: -1, out, err: String(e.message || e), killed, timedOut, stalled }));
    child.on('close', code => finish({ ok: code === 0, code, out, err, killed, timedOut, stalled }));
  });
}

export async function runCarbonHigh({
  prompt,
  system = '',
  cwd = process.cwd(),
  mode = 'auto',
  sandbox = false,
  schema = null,
  timeoutMs = 15 * 60 * 1000,
  killCheck = null,
  item = 'carbon-fallback',
  env = process.env,
  allow = [],
  editCwd = false,
} = {}) {
  let g = null;
  try { g = gates({ allowMismatch: true }); } catch { /* optional when gates absent */ }
  if (g && killOn(g)) {
    return { ok: false, killed: true, reason: 'kill_switch', model: CARBON_HIGH_MODEL, text: '', structured: null };
  }
  if (typeof killCheck === 'function' && killCheck()) {
    return { ok: false, killed: true, reason: 'kill_switch', model: CARBON_HIGH_MODEL, text: '', structured: null };
  }

  let pii = [];
  try {
    pii = scanPII(String(prompt || ''));
  } catch (e) {
    return {
      ok: false,
      reason: 'policy_unavailable',
      model: CARBON_HIGH_MODEL,
      text: '',
      structured: null,
      stderr: `Watchkeeper PII/policy unavailable (${String(e && e.message ? e.message : e).slice(0, 120)}).`,
    };
  }
  const secretHit = g && Array.isArray(g.secretPatterns)
    ? g.secretPatterns.some(pat => { try { return new RegExp(pat).test(String(prompt || '')); } catch { return false; } })
    : false;
  if (pii.length || secretHit) {
    return { ok: false, reason: 'pii_or_secret_blocked', model: CARBON_HIGH_MODEL, text: '', structured: null, stderr: 'Blocked by Watchkeeper PII/secret guard.' };
  }

  // P2-272 Phase 4A fixes (A1): no agy lookup and no canon refusal here. Queueing runs nothing, so it is the allowed lane
  // even when Claude calls this or agy is missing; findAgyBin and agyBlockedForClaude stay for canCarbonFallback (presence) and the legacy runner.

  // Q163 (P2-272 Phase 4): Watchkeeper never runs agy or Gemini itself (canon line 65). The task goes to the wk-task file
  // queue for Antigravity, which takes it when the owner runs it. The old agy chain stays below, unused, as legacyAgyChain.
  if ((g && killOn(g)) || (typeof killCheck === 'function' && killCheck())) {
    return { ok: false, killed: true, reason: 'kill_switch', model: CARBON_HIGH_MODEL, text: '', structured: null };
  }
  return queueForAntigravity({ prompt, system, schema, cwd, item, env, allow, editCwd });
}

export const CARBON_QUEUE_PROVIDER = 'antigravity-queue';
// A7: a wk-task added without --allow may change any file ('**'). An answer-only task gets this one glob instead, which names
// no real file, so wk-task done marks any change out of scope and merges nothing; an unchanged worktree ends as no-change.
export const ANSWER_ONLY_GLOB = '.watchkeeper-answer-only/no-file-may-change';
// allow: globs (relative to the repository top) the task may change; editCwd: the task may change files under cwd only.
// With neither, the task is answer-only: wk-task add without --allow would let it change any file (its default is '**').
export function queueForAntigravity({ prompt, system = '', schema = null, cwd = process.cwd(), item = 'carbon-fallback', env = process.env, allow = [], editCwd = false } = {}) {
  const fail = (reason, stderr) => ({ ok: false, reason, model: CARBON_HIGH_MODEL, text: '', structured: null, stderr });
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', env, timeout: 15000 });
  const repo = top.status === 0 ? String(top.stdout || '').trim() : '';
  if (!repo) return fail('queue_failed', 'The work folder is not a git repository, so the task could not be queued for Antigravity.');
  const ask = String(prompt || '').trim();
  const title = (ask.split(/\r?\n/).find(l => l.trim()) || 'Task from Watchkeeper').replace(/\s+/g, ' ').trim().slice(0, 190) || 'Task from Watchkeeper';
  let text = ask;
  if (system) text = `${String(system).trim()}\n\n${text}`;
  if (schema) text += `\n\nAnswer as JSON that fits this schema: ${JSON.stringify(schema).slice(0, 2000)}`;
  let globs = (Array.isArray(allow) ? allow : []).map(x => String(x || '').trim()).filter(Boolean);
  if (!globs.length && editCwd) {
    let rel = '';
    try { rel = path.relative(fs.realpathSync(repo), fs.realpathSync(cwd)).split(path.sep).join('/'); } catch { rel = '..'; }
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) globs = [rel ? `${rel}/**` : '**'];
  }
  const scopeNote = globs.length ? `Change only files matching: ${globs.join(', ')}.` : 'Answer only; change no files.';
  const note = `\n\n(${scopeNote} Queued by Watchkeeper for Antigravity because Claude's limits were tight; ${SOURCE_NOTE(item)}`;
  text = text.slice(0, Math.max(0, 19000 - note.length)) + note;   // A5: cut the prompt first, so the note is never cut off
  // S8 (P2-272 review): one open fallback task per item. While a task from the same source is still queued or taken, nothing new is queued.
  // The generic item ('carbon-fallback') names no source, so two such requests are never merged.
  const open = item && item !== 'carbon-fallback' ? openTaskFor(item, repo, env) : '';
  if (open) {
    return {
      ok: true, queued: true, reused: true, taskId: open, provider: CARBON_QUEUE_PROVIDER, model: CARBON_HIGH_MODEL, effort: 'high', reason: 'queued_for_antigravity',
      text: `Task ${open} is still waiting for Antigravity, so nothing new was queued. ${answerWhere(open)}`, structured: null,
    };
  }
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wk-task.mjs');
  const r = spawnSync(process.execPath, [bin, 'add', '--repo', repo, '--title', title, '--from', 'claude', ...(globs.length ? globs : [ANSWER_ONLY_GLOB]).flatMap(x => ['--allow', x])],
    { input: text, encoding: 'utf8', env, timeout: 30000 });
  if (r.status === 3) return { ok: false, killed: true, reason: 'kill_switch', model: CARBON_HIGH_MODEL, text: '', structured: null };
  const taskId = r.status === 0 ? String(r.stdout || '').trim().split(/\r?\n/).pop() : '';
  if (!taskId) return fail('queue_failed', String(r.stderr || r.stdout || (r.error && r.error.message) || `exit ${r.status}`).trim().slice(0, 500));
  return {
    ok: true,
    queued: true,
    taskId,
    provider: CARBON_QUEUE_PROVIDER,
    model: CARBON_HIGH_MODEL,
    effort: 'high',
    reason: 'queued_for_antigravity',
    text: `Queued for Antigravity as task ${taskId}; Antigravity takes it when the owner runs /wk-take-task there. ${answerWhere(taskId)}`,
    structured: null,
  };
}

// S8: where the owner finds the answer. wk-task done adds a suggestion with Gemini's note; the task itself keeps it too.
export const answerWhere = id => `The answer will appear under Suggestions in the Watchkeeper panel when Antigravity finishes (or: wk-task show ${id}).`;
const SOURCE_NOTE = item => `source: ${String(item).slice(0, 80)}.)`;
// S8: the id of a queued or taken task from the same source item in the same repo, or ''. It reads the queue only.
export function openTaskFor(item, repo, env = process.env) {
  const dir = path.join(path.resolve(env.WK_HOME || path.join(os.homedir(), '.wk')), 'tasks');
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return ''; }
  let realRepo = repo;
  try { realRepo = fs.realpathSync(repo); } catch { /* keep as given */ }
  const want = SOURCE_NOTE(item);
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name, 'meta.json'), 'utf8'));
      if (!m || m.id !== name || !['queued', 'taken'].includes(m.status) || m.repo !== realRepo) continue;
      const body = fs.readFileSync(path.join(dir, name, 'task.md'), 'utf8');
      if (body.trimEnd().endsWith(want)) return name;
    } catch { /* skip a broken task folder */ }
  }
  return '';
}

// The stall-guarded runner, exported only so tests can prove stall detection with a stub in a temporary HOME (it works in any
// folder, git or not). Nothing in Watchkeeper calls it on the owner's agy (Q163, canon line 65).
export function execWithStallGuard(opts) { return execOneModel(opts); }

// The agy model chain from v0.8.0, kept (not cut) but never called: Watchkeeper does not run agy (Q163, canon line 65).
// S11 (P2-272 review): it throws before anything else, so a future caller cannot start agy by accident. Exported only for that test.
export const NEVER_AGY = 'Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.';
export async function legacyAgyChain({ agyBin, g, prompt, system, schema, cwd, mode, sandbox, timeoutMs, killCheck, item, env }) {
  throw new Error(NEVER_AGY);
  // eslint-disable-next-line no-unreachable
  const graphHint = readCarbonGraphHint(cwd, prompt, env);
  const fullPrompt = buildCarbonPrompt({ prompt, system, schema, graphHint });
  const models = env.WK_CARBON_MODEL ? [env.WK_CARBON_MODEL] : [...CARBON_FALLBACK_CHAIN];
  let lastErr = '';

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    if ((g && killOn(g)) || (typeof killCheck === 'function' && killCheck())) {
      return { ok: false, killed: true, reason: 'kill_switch', model, text: '', structured: null };
    }
    const r = await execOneModel({ agyBin, model, fullPrompt, cwd, mode, sandbox, timeoutMs, killCheck, env });
    if (r.killed) {
      recordAuditAndLedger({ item, model, ok: false, inputChars: fullPrompt.length, outputText: '', reason: 'killed', env });
      return { ok: false, killed: true, reason: 'kill_switch', model, text: '', structured: null };
    }
    const text = String(r.out || '').trim();
    if (r.ok && text) {
      const structured = schema ? extractJsonFromText(text) : null;
      if (schema && !structured) {
        lastErr = `${model} returned non-JSON output for structured schema request`;
        recordAuditAndLedger({ item, model, ok: false, inputChars: fullPrompt.length, outputText: text, reason: 'invalid_json', env });
        if (i + 1 < models.length) continue;
        return { ok: false, reason: 'invalid_json', model, text, structured: null, stderr: lastErr };
      }
      recordAuditAndLedger({ item, model, ok: true, inputChars: fullPrompt.length, outputText: text, env });
      return {
        ok: true,
        provider: 'orchestrator-carbon-high',
        model,
        effort: 'high',
        text,
        structured,
        stderr: String(r.err || '').trim(),
      };
    }

    lastErr = String(r.err || r.out || (r.stalled ? 'stalled without output or CPU activity' : r.timedOut ? 'timed out' : `exit ${r.code}`)).trim();
    recordAuditAndLedger({ item, model, ok: false, inputChars: fullPrompt.length, outputText: text, reason: r.stalled ? 'stalled' : lastErr, env });
    if (r.stalled) {
      if (i + 1 < models.length) continue;
      return { ok: false, timedOut: true, stalled: true, reason: 'stall', model, text: '', structured: null, stderr: lastErr };
    }
    if (r.timedOut) {
      return { ok: false, timedOut: true, reason: 'timeout', model, text: '', structured: null, stderr: lastErr };
    }
    if (UNAVAIL_RE.test(lastErr) && i + 1 < models.length) {
      continue;
    }
    if (i + 1 < models.length && LIMIT_RE.test(lastErr)) {
      continue;
    }
    break;
  }

  return {
    ok: false,
    reason: 'execution_failed',
    model: models[models.length - 1],
    text: '',
    structured: null,
    stderr: lastErr.slice(0, 500),
  };
}
