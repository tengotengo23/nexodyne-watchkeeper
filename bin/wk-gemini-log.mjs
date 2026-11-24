#!/usr/bin/env node
// Antigravity Stop hook (P2-223): one line per finished Gemini turn in ~/.wk/gemini/sessions.jsonl (or $WK_HOME),
// {at, conversation_id, model, workspace, reason}; the last 500 lines are kept. It never asks Gemini to go on:
// it prints {} (P2-272: the verified Antigravity Stop contract; {"decision":"continue"} would block the stop) and always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { sessionsFile, appendLine, writeFile, oneLine, config } from './gemini-lib.mjs';

export function log(raw, now = new Date()) {
  let ev = {};
  try { ev = JSON.parse(raw || '{}') || {}; } catch {}
  const s = (v, n) => (typeof v === 'string' ? oneLine(v).slice(0, n) : null);
  const ws = Array.isArray(ev.workspacePaths) ? ev.workspacePaths.find(p => typeof p === 'string') : null;
  const row = { at: now.toISOString(), conversation_id: s(ev.conversationId, 80), model: s(ev.modelName, 80), workspace: ws ? oneLine(ws).slice(0, 500) : s(ev.cwd, 500), reason: s(ev.terminationReason, 60) };
  const f = sessionsFile();
  appendLine(f, row);
  const keep = config().sessions_keep;
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length > keep) writeFile(f, lines.slice(-keep).join('\n') + '\n');
  } catch {}
  return row;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  try { log(fs.readFileSync(0, 'utf8')); } catch {}
  process.stdout.write('{}\n');
  process.exitCode = 0;
}
