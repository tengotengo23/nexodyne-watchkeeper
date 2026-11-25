#!/usr/bin/env node
// The /wk command family (P2-272). One set of words in the terminal, Claude Code and Antigravity.
//   /wk  /wk status  /wk graph  /wk sync  /wk stop  /wk go  /wk task "..."  /wk take-task
// Old names stay as aliases. Everything else goes to core/wk_cli.py as before.
// Nothing here starts agy or calls Gemini: `task` only writes a queue file, `sync` only indexes approved sources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython, findNode } from './antigravity-lib.mjs';
import { detectEnv, envText } from './env-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const SCRIPT = path.join(ROOT, 'core', 'wk_cli.py');

const wkHome = () => process.env.WK_HOME || path.join(process.env.HOME || os.homedir(), '.wk');
const stopFile = () => path.join(wkHome(), 'KILL');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, PYTHONPATH: ROOT }, ...opts });
  if (r.error) { console.error(`wk: failed to launch ${cmd}: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}
const script = (name, args) => run(process.execPath, [path.join(BIN, name), ...args]);
const cli = (args) => {
  const py = (process.env.WK_PYTHON && fs.existsSync(process.env.WK_PYTHON) ? process.env.WK_PYTHON : findPython()) || 'python3';
  return run(py, [SCRIPT, ...args]);
};

const HELP = `Watchkeeper /wk command family

  /wk                       overview (one screen, read-only)
  /wk status                runtime status
  /wk graph [sync|inspect <symbol>|open]   the code graph (default: sync)
  /wk sync                  one skill index sync (approved sources only) and a graph refresh
  /wk stop [reason]         turn the Stop switch on (writes ~/.wk/KILL)
  /wk go                    turn the Stop switch off
  /wk task "<text>"         queue a task as a file; starts nothing
  /wk take-task [id]        take the next queued task or the latest handoff
  /wk take-task --handoff --cwd <repo>   take only that repo's unread handoff (Bridge uses this)
  /wk take-task --run new|<run id>      automation run: about 60 min, at most 6 tasks; exit 6 when it is used
  /wk watch [check|install|uninstall|status]   the 30 s checker: notifies, starts no agent
  /wk env [--json]          this computer (system, shell, node, python, folders) and the commands that suit it

Old names still work: /wk-status, /wk-take-task, /wk-add-task, /wk-suggest, and the
subcommands overview, heal, tasks, handoff, watchdog, learn, mode, brain, skills, doctor.
The Stop switch is the file KILL in the Watchkeeper home folder. While it is on, sync and task refuse.
`;

// P2-282: what computer this is and the commands that suit it (Linux, Windows, macOS). Read-only.
function env(rest) {
  const e = detectEnv({ argv0: findNode() });
  process.stdout.write(rest.includes('--json') ? JSON.stringify(e, null, 2) + '\n' : envText(e) + '\n');
  return 0;
}

function stop(rest) {
  const reason = rest.join(' ').replace(/\s+/g, ' ').trim() || 'stopped with /wk stop';
  const file = stopFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${reason} (${new Date().toISOString()})\n`);
  console.log(`Stop switch is on: ${reason}`);
  console.log(`File: ${file}. Run /wk go to turn it off.`);
  return 0;
}

function go() {
  const file = stopFile();
  if (!fs.existsSync(file)) { console.log(`Stop switch is already off (no ${file}).`); return 0; }
  fs.rmSync(file);
  console.log(`Stop switch is off: removed ${file}.`);
  return 0;
}

function sync() {
  if (fs.existsSync(stopFile())) {
    console.error(`wk sync: the Stop switch is on (${stopFile()}). Run /wk go first.`);
    return 3;
  }
  // One manual pass. --max-new 0 adds no new sources; only sources already approved are indexed.
  // install/uninstall (the daily job) are never called here.
  console.log('wk sync: skill index, approved sources only');
  const a = script('wk-skill-sync.mjs', ['run', '--force', '--max-new', '0']);
  if (a !== 0) return a;
  console.log('wk sync: graph refresh');
  return cli(['graph', 'sync']);
}

function task(rest) {
  const text = rest.join(' ').trim();
  if (!text) { console.error('usage: /wk task "<what to do>"'); return 2; }
  const g = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  const repo = g.status === 0 ? g.stdout.trim() : '';
  if (!repo) { console.error('wk task: run it inside a git repository (the task works in a copy of it).'); return 2; }
  const title = text.split('\n')[0].slice(0, 80);
  return script('wk-task.mjs', ['add', '--from', 'owner', '--repo', repo, '--title', title, '--text', text]);
}

function takeTask(rest) {
  const engine = process.env.WK_ENGINE === 'antigravity' ? 'antigravity' : 'claude';
  // P2-277: `--cwd <dir>` takes the handoff for that repo (Bridge wakes name it); the default stays the current folder.
  // `--handoff` takes only that repo's unread handoff, never a queued task (every Bridge route uses it; exit 5 if gone).
  let cwd = process.cwd(); let handoff = false; let run = ''; const left = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--cwd' && rest[i + 1]) cwd = rest[++i];
    else if (rest[i] === '--handoff') handoff = true;
    else if (rest[i] === '--run' && rest[i + 1]) run = rest[++i];  // P2-282: --run new | <run id>
    else left.push(rest[i]);
  }
  if (handoff) return script('wk-takeover.mjs', ['brief', '--cwd', cwd, '--engine', engine, '--handoff', '--consume', '--model-used', engine]);
  const args = ['brief', '--cwd', cwd, '--engine', engine, '--claim', '--consume', '--model-used', engine];
  if (left[0]) args.push('--id', left[0]);
  if (run) args.push('--run', run);
  return script('wk-takeover.mjs', args);
}

const argv = process.argv.slice(2);
const sub = (argv[0] || '').replace(/^\//, '').toLowerCase();
const rest = argv.slice(1);
const table = {
  stop: () => stop(rest),
  go: () => go(),
  sync: () => sync(),
  task: () => task(rest),
  'add-task': () => task(rest),
  'wk-add-task': () => task(rest),
  'take-task': () => takeTask(rest),
  'wk-take-task': () => takeTask(rest),
  env: () => env(rest),
  'wk-env': () => env(rest),
  watch: () => script('wk-watch.mjs', rest),
  'wk-watch': () => script('wk-watch.mjs', rest),
  status: () => script('wk-status.mjs', rest),
  'wk-status': () => script('wk-status.mjs', rest),
  suggest: () => script('wk-suggest.mjs', rest),
  'wk-suggest': () => script('wk-suggest.mjs', rest),
  help: () => (rest.includes('--json') ? cli(['help', ...rest]) : (process.stdout.write(HELP), 0)),
  '--help': () => { process.stdout.write(HELP); return 0; },
  '-h': () => { process.stdout.write(HELP); return 0; },
};
const code = table[sub] ? table[sub]() : cli(argv.length ? [sub, ...rest] : ['overview']);
process.exit(code);
