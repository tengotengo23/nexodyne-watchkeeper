#!/usr/bin/env node
// wk-dag-lane (P2-272 Phase 4): the task splitter's Claude lane. It starts Claude Code exactly as wk-job does (claudeArgv:
// the same fixed flags, never a forbidden one; WK_CLAUDE_BIN or `claude`), reads the stream-json lines with wk-job's eventsFrom,
// keeps every rate-limit window in the meter (steward-lib meterFromEvents, like wk-ledger pace --event) and prints one JSON
// line at the end. It runs in the caller's process group (no detach), so the caller's Stop switch stops Claude with it.
//   wk-dag-lane claude --cwd <worktree> --model <m> --effort <e> --prompt-file <f> [--id <x>]  -> {"ok":true,"result":"..."}
//   wk-dag-lane plan   --cwd <repo> --prompt-file <f> [--id <x>]                             -> {"ok":true,"nodes":[...]}
// Gemini work never comes here: the planner's Gemini steps are queued with wk-task for Antigravity (canon: never run agy).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeArgv, eventsFrom } from './wk-job.mjs';
import { meterFile, meterFromEvents, writeAtomic, nowMs } from './steward-lib.mjs';
import { extractJsonFromText } from './wk-carbon-fallback.mjs';

export const STEP_LINE = id => `A step of a Watchkeeper task plan (${id}). Work only in this folder and only on the files the step names. `
  + 'Do not commit, push or merge: Watchkeeper checks and merges the step itself. Never print .env files, keys or tokens. '
  + 'End with a short plain summary of what you changed.';
export const PLAN_LINE = id => `Watchkeeper's task planner (${id}). Look only; change nothing. Answer with JSON only.`;
export const PLAN_ASK = `

Split the task above into at most 20 steps that can be checked on their own. Answer with one JSON object and nothing else:
{"nodes":[{"id":"lower-case-id","title":"...","dependsOn":["other-id"],"provider":"claude","model":"sonnet|opus|fable|haiku",
"effort":"low|medium|high|xhigh|max","ownedGlobs":["path/or/glob/**"],"interfaceContract":"what this step promises the others",
"verifyCmd":"one shell line that proves the step works"}]}
Rules: each step owns its files (ownedGlobs); two steps that may touch the same file must depend on each other. provider "gemini"
(model "gemini-3-pro" or similar) only for light, well-bounded work: Watchkeeper queues such a step for Antigravity, which takes it
when the owner runs it. A small task is one step.`;

const flag = (argv, k) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };

// the meter: every window from this run's rate_limit_event lines, on top of the windows meter.json already keeps
export function keepMeter(rateEvents, now = nowMs()) {
  const m = meterFromEvents(rateEvents, now, 'dag');
  if (!m) return null;
  let old = null; try { old = JSON.parse(fs.readFileSync(meterFile(), 'utf8')); } catch {}
  if (old && old.windows && typeof old.windows === 'object') m.windows = { ...old.windows, ...m.windows };
  writeAtomic(meterFile(), JSON.stringify(m));
  return m;
}

export function runClaude(argv, { cwd, prompt, bin = process.env.WK_CLAUDE_BIN || 'claude' }) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(bin, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env }); }
    catch (e) { resolve({ code: null, error: e, events: [], rate: [], errTail: '' }); return; }
    const events = [], rate = [];
    let buf = '', errTail = '';
    const take = line => {
      if (!line.trim()) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o && o.type === 'rate_limit_event') rate.push(o);
      events.push(...eventsFrom(o));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('error', e => resolve({ code: null, error: e, events, rate, errTail }));
    child.on('close', code => { take(buf); resolve({ code, events, rate, errTail }); });
  });
}

export async function main(argv, out = s => process.stdout.write(s + '\n')) {
  const mode = argv[0];
  const say = o => { out(JSON.stringify(o)); return o.ok ? 0 : 1; };
  if (!['claude', 'plan'].includes(mode)) return say({ ok: false, reason: 'usage: wk-dag-lane claude|plan --cwd <dir> --prompt-file <f>' });
  const cwd = flag(argv, '--cwd'), pf = flag(argv, '--prompt-file'), id = (flag(argv, '--id') || 'dag').replace(/[^A-Za-z0-9-]/g, '').slice(0, 80) || 'dag';
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return say({ ok: false, reason: 'The work folder is missing.' });
  let prompt; try { prompt = fs.readFileSync(pf, 'utf8'); } catch { return say({ ok: false, reason: 'The step text is missing.' }); }
  if (!process.env.WK_STEWARD_DIR && process.env.WK_HOME) process.env.WK_STEWARD_DIR = path.join(process.env.WK_HOME, 'steward');
  let args;
  try {
    args = mode === 'plan'
      ? claudeArgv({ id, model: 'opus', mode: 'plan', max_turns: 30, effort: 'high', system: PLAN_LINE(id) })
      : claudeArgv({ id, model: flag(argv, '--model') || 'sonnet', mode: 'auto', max_turns: 150, effort: flag(argv, '--effort'), system: STEP_LINE(id) });
  } catch (e) { return say({ ok: false, reason: `Claude Code could not start: ${e.message}` }); }
  const r = await runClaude(args, { cwd, prompt: mode === 'plan' ? prompt + PLAN_ASK : prompt });
  let meter = null; try { meter = keepMeter(r.rate); } catch {}
  const res = [...r.events].reverse().find(e => e.type === 'result');
  const windows = meter ? Object.keys(meter.windows || {}) : [];
  if (r.error) return say({ ok: false, reason: `Claude Code could not start (${r.error.code || r.error.message}).` });
  if (r.code !== 0 || !res || (res.subtype && res.subtype !== 'success')) {
    return say({ ok: false, reason: `Claude Code stopped (exit ${r.code}${res && res.subtype ? `, ${res.subtype}` : ''}).`, windows });
  }
  if (mode === 'plan') {
    const j = extractJsonFromText(res.text || '');
    const nodes = Array.isArray(j) ? j : j && Array.isArray(j.nodes) ? j.nodes : null;
    return say(nodes ? { ok: true, nodes, windows } : { ok: false, reason: 'The planner answered without a plan.', windows });
  }
  return say({ ok: true, result: String(res.text || '').slice(0, 2000), cost_usd: res.cost_usd, windows });
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n'); process.exitCode = 1; });
}
