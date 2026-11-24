#!/usr/bin/env node
// record (PostToolUse Bash): append a test line (command, exit, log path) to this session's evidence file .wk/evidence/<session>.jsonl.
// gate (Stop): a message that claims done/tested/LIVE needs that session file, a fresh test line, and no test command whose latest run
// failed. Blocks at most evidence.maxBlocks times per turn (stop_hook_active honoured: a fresh stop resets the count); past the cap the
// stop goes through and .wk/defects.log counts an unverified "done". A broken policy blocks too (fail closed, still capped).
import fs from 'node:fs'; import path from 'node:path';
import { gates, stdin, wkDir } from './lib.mjs';
const mode = process.argv[2], ev = stdin();
let g = null, polErr = ''; try { g = gates(); } catch (e) { polErr = e.message; }
const sid = String(ev.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const edir = () => { const d = path.join(wkDir(), 'evidence'); fs.mkdirSync(d, { recursive: true }); return d; };
const linesFile = () => path.join(edir(), sid + '.jsonl'), stateFile = () => path.join(edir(), sid + '.gate.json');
const norm = c => String(c).replace(/^\s*(\S*\/)?wk-run\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
if (mode === 'record') {
  if (!g) process.exit(0);   // no policy: nothing is recorded, so the gate finds no evidence and blocks
  const cmd = ev.tool_input?.command || ''; if (!g.testCommands.some(t => new RegExp(t).test(cmd))) process.exit(0);
  const r = ev.tool_response || {}; const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = text.match(/WK_EXIT=(\d+)/); const failed = r.is_error === true || r.interrupted === true || (m ? m[1] !== '0' : /\b(\d+) (failed|failing)\b|FAIL\b|✗|AssertionError|Traceback/.test(text) && !/\b0 (failed|failing)\b/.test(text));
  fs.appendFileSync(linesFile(), JSON.stringify({ at: Date.now(), command: norm(cmd), exit: failed ? 1 : 0, log: (text.match(/WK_LOG=(\S+)/) || [])[1] || null }) + '\n');
  process.exit(0);
}
if (mode === 'gate') {
  let st = { blocks: 0 }; try { st = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch {}
  if (ev.stop_hook_active !== true) st.blocks = 0;               // a fresh stop (new turn) resets the nudge count
  const cap = g ? g.evidence.maxBlocks : 1;
  let last = ''; try {
    const lines = fs.readFileSync(ev.transcript_path, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && !last; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o && (o.type === 'assistant' || o.message?.role === 'assistant')) last = [].concat(o.message?.content || []).map(c => c.text || '').join(' ');
      } catch { /* skip corrupt transcript line */ }
    }
  } catch {}
  let why = null;
  if (!g) why = `the policy cannot be read (${polErr}), so no claim can be checked`;
  else if (last && g.claimWords.some(w => new RegExp(w, 'i').test(last)) && !new RegExp(g.evidence.honestGap, 'i').test(last)) {
    let raw = null; try { raw = fs.readFileSync(linesFile(), 'utf8'); } catch {}
    const runs = (raw || '').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && typeof e.command === 'string' && typeof e.at === 'number' && (e.exit === 0 || e.exit === 1));
    const fresh = runs.filter(e => Date.now() - e.at < g.evidence.maxAgeMinutes * 60000);
    const latest = new Map(); for (const e of fresh) latest.set(e.command, e);
    const bad = [...latest.values()].filter(e => e.exit !== 0);
    why = raw === null ? 'there is no session evidence file: no test command has run in this session'
      : !runs.length ? 'the session evidence file has no test line'
      : !fresh.length ? 'the last test run is older than the limit'
      : bad.length ? `a test run failed (${bad.map(e => e.command).join('; ').slice(0, 160)}) and has not passed since` : null;
  }
  const save = () => {
    try {
      const f = stateFile(), tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch {}
  };
  if (!why) { st.blocks = 0; save(); process.exit(0); }
  if (st.blocks >= cap) {                                         // retry cap reached: let the stop through, count the defect
    try { fs.appendFileSync(path.join(wkDir(), 'defects.log'), `${new Date().toISOString()} ${sid} unverified-done: ${why}\n`); } catch {}
    save(); console.error(`watchkeeper: evidence gate gave up after ${cap} nudge(s); unverified done counted in .wk/defects.log`); process.exit(0);
  }
  st.blocks++; save();
  console.log(JSON.stringify({ decision: 'block', reason: `Evidence gate: your last message claims completion, but ${why}. Run the narrowest test and show its output, or restate the claim as unverified and say which checks you skipped.` }));
}
