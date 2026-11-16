#!/usr/bin/env node
// wk-state (P2-223): one object for any tool built on these files, from the same files the panel reads.
//   wk-state --json [--orchestration <dir>]   -> {version, generated_at, questions[], suggestions[] (open), tasks[], gemini_sessions[] (last 20)}
//   wk-state                                  -> the same, as a few plain lines
// Questions come from <orchestration>/QUESTIONS.md: --orchestration, else $WK_ORCHESTRATION, else the nearest orchestration/
// folder above the current one. Read only; nothing here writes. The format is in docs/DATA-CONTRACT.md.
import fs from 'node:fs';
import path from 'node:path';
import { version, readQuestions, readSuggestions, listTasks, readSessions, findOrchestration } from './gemini-lib.mjs';

export function state({ orchestration, now = new Date() } = {}) {
  const orch = orchestration ? path.resolve(orchestration) : findOrchestration();
  const tasks = listTasks().reverse().map(t => ({ id: t.id, created_at: t.created_at, from: t.from, title: t.title, kind: t.kind, model: t.model, fallback: t.fallback,
    model_used: t.model_used, repo: t.repo, status: t.status, taken_at: t.taken_at, done_at: t.done_at, note: t.note }));
  return {
    version: version(),
    generated_at: now.toISOString(),
    questions: readQuestions(orch),
    suggestions: readSuggestions(now.getTime()).filter(s => s.state === 'open').reverse().map(({ decision, state, ...s }) => s),
    tasks,
    gemini_sessions: readSessions(20),
  };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--orchestration');
  const s = state({ orchestration: i >= 0 ? a[i + 1] : undefined });
  if (a.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else {
    const waiting = s.tasks.filter(t => ['queued', 'taken'].includes(t.status)).length;
    console.log([`Watchkeeper ${s.version || '?'}`,
      `Open questions: ${s.questions.length}. Suggestions waiting for you: ${s.suggestions.length}.`,
      `Gemini tasks: ${s.tasks.length} (${waiting} queued or in progress). Gemini sessions logged: ${s.gemini_sessions.length} shown.`].join('\n'));
  }
}
