#!/usr/bin/env node
// wk-suggest (P2-223): suggestions for you, answered with one press in the panel.
//   wk-suggest add --title "<t>" [--detail "<t>" | stdin] [--from claude|gemini|watchkeeper|owner]   -> prints the new id
//   wk-suggest decide <id> ok|later|no [--text "<t>"]
//       writes the event to suggestions.jsonl and a decision row to owner-inbox.jsonl. For a merge suggestion, ok merges
//       the task (wk-task merge) and no discards it (wk-task discard). later hides it for 24 hours. ok on a task that is no
//       longer verified (merged or discarded elsewhere) is recorded and replies "Already <status>." with exit 0.
//   wk-suggest list [--open|--decided] [--json]       (default: open)
// Exit: 0 done, 1 failed or refused (one plain line on stderr), 2 bad input. Files under ~/.wk or $WK_HOME (docs/DATA-CONTRACT.md).
import fs from 'node:fs';
import path from 'node:path';
import { wkHome, suggestionsFile, readSuggestions, addSuggestion, appendDecision, appendLine, withLock, oneLine, multiLine, readTask,
  SUGGESTION_ID, CHOICES, FROM_SUGGESTION, MAX_DETAIL, MAX_TITLE } from './gemini-lib.mjs';
import { mergeTask, discardTask } from './wk-task.mjs';

class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => { throw new Stop(2, m); };

export function parseArgs(argv) {
  const o = { cmd: argv[0] || '', pos: [], json: false, filter: 'open' };
  const VAL = { '--title': 'title', '--detail': 'detail', '--from': 'from', '--text': 'text' };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--json') o.json = true;
    else if (x === '--open') o.filter = 'open';
    else if (x === '--decided') o.filter = 'decided';
    else if (x === '--all') o.filter = 'all';
    else if (VAL[x]) { const v = a.shift(); if (v === undefined) bad(`${x} needs a value`); o[VAL[x]] = v; }
    else if (!x.startsWith('--')) o.pos.push(x);
    else bad(`unknown option ${x.slice(0, 40)}`);
  }
  return o;
}

export function add(o, now = new Date()) {
  const from = o.from || 'claude';
  if (!FROM_SUGGESTION.includes(from)) bad(`--from must be one of ${FROM_SUGGESTION.join(', ')}`);
  const title = oneLine(o.title);
  if (!title) bad('--title is needed');
  if (title.length > MAX_TITLE) bad(`the title is longer than ${MAX_TITLE} characters`);
  const detail = multiLine(o.detail !== undefined ? o.detail : (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : ''));
  if (detail.length > MAX_DETAIL) bad(`the detail is longer than ${MAX_DETAIL} characters`);
  return addSuggestion({ from, title, detail }, now);   // only Watchkeeper itself makes merge suggestions (wk-task done)
}

export function decide(id, choice, text, now = new Date()) {
  if (!SUGGESTION_ID.test(String(id || ''))) bad('give a suggestion id (see wk-suggest list)');
  if (!CHOICES.includes(choice)) bad(`the choice must be one of ${CHOICES.join(', ')}`);
  const t = oneLine(text);
  if (t.length > MAX_DETAIL) bad(`the text is longer than ${MAX_DETAIL} characters`);
  return withLock(path.join(wkHome(), '.suggest.lock'), () => {
    const s = readSuggestions(now.getTime()).find(x => x.id === id);
    if (!s) bad(`no suggestion ${id}`);
    if (s.state === 'ok' || s.state === 'no') throw new Stop(1, `suggestion ${id} was already answered (${s.state})`);
    let note = t, msg = `Recorded: ${choice}.`, code = 0, extra = null;
    if (s.action.type === 'task-merge' && choice !== 'later') {
      const ref = s.action.ref;
      try {
        const cur = choice === 'ok' ? readTask(ref) : null;
        if (choice === 'ok' && (!cur || cur.status !== 'verified')) {
          // merged or discarded elsewhere (the command line): the answer is recorded, so the suggestion clears
          msg = `Already ${cur ? cur.status : 'removed'}.`;
        } else if (choice === 'ok') {
          const r = mergeTask({ id: ref }, now);
          msg = r.msg;
          if (r.code) {   // a conflict: the merge was undone; this suggestion is answered and a new plain one explains it
            code = 1; note = [t, 'merge conflict: nothing was merged'].filter(Boolean).join('; ');
            extra = addSuggestion({ from: 'watchkeeper', title: `Merging "${s.title.slice(0, 100)}" hit a conflict`, detail: `${r.msg}\nAsk Gemini to redo the task on the current code, or discard it.`.slice(0, MAX_DETAIL) }, now);
          }
        } else {
          const m = readTask(ref);
          if (m && !['merged', 'discarded'].includes(m.status)) msg = discardTask({ id: ref }).msg;
          else msg = `Recorded: no. The task is ${m ? m.status : 'gone'}.`;
        }
      } catch (e) { throw new Stop(1, String(e.message || e).split('\n')[0]); }
    }
    appendLine(suggestionsFile(), { id, at: now.toISOString(), status: choice, ...(note ? { text: note } : {}) });
    appendDecision({ ref: id, choice, title: s.title, text: note }, now);
    if (code) throw new Stop(code, msg.split('\n')[0]);
    return { msg: msg.split('\n')[0], extra };
  });
}

function list(o) {
  const all = readSuggestions().reverse();
  const rows = o.filter === 'all' ? all : o.filter === 'open' ? all.filter(s => s.state === 'open') : all.filter(s => s.state !== 'open');
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(o.filter === 'open' ? 'Nothing waits for you.' : 'No suggestions.');
  for (const s of rows.slice(0, 50)) console.log(`${s.id}  ${s.state.padEnd(5)} from ${s.from}: ${s.title}${s.action.type === 'task-merge' ? ` [merge ${s.action.ref}]` : ''}`);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  let code = 0;
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'add') console.log(add(o).id);
    else if (o.cmd === 'decide') console.log(decide(o.pos[0], o.pos[1], o.text).msg);
    else if (o.cmd === 'list') list(o);
    else bad('usage: wk-suggest add|decide|list (see the top of bin/wk-suggest.mjs)');
  } catch (e) {
    code = e instanceof Stop ? e.code : 1;
    console.error(`wk-suggest: ${oneLine(e.message || e).slice(0, 300)}`);
  }
  process.exitCode = code;
}
