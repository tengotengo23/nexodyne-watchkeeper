#!/usr/bin/env node
// wk-task (P2-223): the queue of work for Gemini in Antigravity. Watchkeeper never runs Gemini: Gemini takes a task through
// the plugin skill /wk-take-task (typed by the owner, or an automation the owner set up once), works in its own git worktree,
// and finishes with `done`. Watchkeeper then checks the result (allowed files, the task's test) before anything reaches the owner.
//   wk-task add --repo <abs> --title "<t>" [--kind <k>] [--model <m>] [--allow <glob>]... [--test "<cmd>"] [--from claude|owner|gemini]
//               [--text "<t>" | stdin]                              -> prints the new id
//   wk-task take [--id <id>] [--model-used <m>]                     -> claims the next task, makes its worktree, prints the brief
//   wk-task done <id> [--attempt <n>] [--note "<t>"] [--model-used <m>] -> diff, scope check, test, commit in the worktree, a suggestion
//   wk-task merge <id>                                              -> merges a verified task into its repo (never pushes)
//   wk-task discard <id>                                            -> removes the worktree, keeps change.diff
//   wk-task sweep [--recover] [--json]                              -> scans or recovers hung tasks via watchdog
//   wk-task list [--json] · wk-task show <id> [--json]
// Exit: 0 done, 1 failed or refused, 2 bad input, 3 the Stop switch is on, 4 today's cap is reached, 5 nothing is queued.
// Files: ~/.wk/tasks/<id>/ and ~/.wk/worktrees/<id>/ (or $WK_HOME); see docs/DATA-CONTRACT.md. Every git call uses execFile
// with an argument array; nothing here pushes or uses the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gates, killOn, killFile, glob2re, globBody, earlierWorkLines } from './lib.mjs';
import { wkHome, tasksDir, worktreesDir, config, kinds, guessKind, oneLine, multiLine, stamp, slug, ensureDir, writeFile, readJSON,
  withLock, git, readTask, listTasks, addSuggestion, TASK_ID, FROM_TASK, MAX_TITLE, MAX_NOTE, MAX_TEXT } from './gemini-lib.mjs';
import { runDetachedCommandSync, runWatchdogCli } from './wk-watchdog.mjs';

const BIN = path.dirname(new URL(import.meta.url).pathname);
class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => { throw new Stop(2, m); };
const fail = m => { throw new Stop(1, m); };

export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help', id: null, allow: [], json: false, recover: false };
  const o = { cmd: argv[0] || '', id: null, allow: [], json: false, recover: false };
  const VAL = { '--repo': 'repo', '--title': 'title', '--kind': 'kind', '--model': 'model', '--test': 'test', '--from': 'from', '--text': 'text', '--id': 'id', '--model-used': 'modelUsed', '--note': 'note', '--base': 'base', '--attempt': 'attempt' };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--allow') { const v = a.shift(); if (v === undefined) bad('--allow needs a glob'); o.allow.push(v); }
    else if (x === '--json') o.json = true;
    else if (x === '--recover') o.recover = true;
    else if (VAL[x]) { const v = a.shift(); if (v === undefined) bad(`${x} needs a value`); o[VAL[x]] = v; }
    else if (!x.startsWith('--') && !o.id) o.id = x;
    else bad(`unknown option ${x.slice(0, 40)}`);
  }
  return o;
}

const taskDir = id => path.join(tasksDir(), id);
const saveMeta = m => writeFile(path.join(taskDir(m.id), 'meta.json'), JSON.stringify(m, null, 2) + '\n');
const metaOf = id => { if (!id || !TASK_ID.test(id)) bad('give a task id (see wk-task list)'); const m = readTask(id); if (!m) bad(`no task ${id}`); return m; };
const shortTitle = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
function killed() {
  if (fs.existsSync(path.join(wkHome(), 'KILL'))) return true;
  let g; try { g = gates({ allowMismatch: true }); } catch (e) { fail(`the policy does not load (${e.message.slice(0, 120)}); nothing runs until the owner fixes it`); }
  return killOn(g);
}
const KILL_MSG = () => 'The Stop switch is on (the kill switch, ~/.wk/KILL), so Watchkeeper does no work. The owner removes the file to resume. Stop here.';
const allowRe = g => new RegExp('^' + globBody(g) + '$');
const zsplit = s => String(s || '').split('\0').filter(Boolean);
const literal = f => `:(literal)${f}`;
// Every diff Watchkeeper reads or shows: no rename detection (a rename would hide the deletion of its old path), and no
// external diff, text conversion or relative setting (the repository's config never changes what the owner sees).
const DIFF = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color'];
// The worktree is always <data folder>/worktrees/<id> (attempt 1) or <id>.a<n> (attempt n >= 2, P2-276 review: a requeued
// task starts in a fresh folder, so an earlier attempt's agent can never hand its work in as the new one). meta.json is a
// plain file Gemini could rewrite, so its "worktree" field is written for readers but never used for git or file work;
// only the attempt number is read, and only as a small whole number. A symlink in its place is never followed.
export const attemptOf = m => { const n = Number(m && m.attempt); return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : 1; };
const wtName = m => (attemptOf(m) >= 2 ? `${m.id}.a${attemptOf(m)}` : m.id);
const wtOf = m => path.join(worktreesDir(), wtName(m));
function liveWt(m) { const wt = wtOf(m); try { return fs.lstatSync(wt).isDirectory() ? wt : null; } catch { return null; } }
// P2-276 review: take and done hold <data folder>/watchdog/task_<id>.lock, the same lock the watchdog holds while it backs
// up and removes a dead task's worktree, so a removal never runs in the middle of a take or a done. Same protocol as
// core/watchdog.py _TaskLock: O_EXCL file with a "pid ms hex" token, taken over when older than 15 minutes or its pid is
// gone, removed on release only while it still holds our token.
const TASK_LOCK_STALE_MS = 15 * 60 * 1000;
const pidGone = pid => { if (!(pid > 1)) return false; try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
export function withTaskLock(id, fn, { waitMs = 15000 } = {}) {
  const dir = path.join(wkHome(), 'watchdog'); ensureDir(dir);
  const file = path.join(dir, `task_${id}.lock`);
  const token = `${process.pid} ${Date.now()} ${crypto.randomBytes(4).toString('hex')}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, token + '\n'); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const st = fs.lstatSync(file);
        stale = Date.now() - st.mtimeMs > TASK_LOCK_STALE_MS || pidGone(parseInt(fs.readFileSync(file, 'utf8').split(/\s+/)[0], 10));
      } catch (e2) { if (e2.code === 'ENOENT') continue; }
      if (stale) { try { fs.rmSync(file, { force: true }); } catch {} continue; }
      if (Date.now() > until) fail(`task ${id} is busy (the watchdog or another command is working on it); try again in a minute`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { return fn(); } finally {
    try { if (fs.readFileSync(file, 'utf8').trim() === token) fs.rmSync(file, { force: true }); } catch {}
  }
}
// The backup of the newest earlier attempt (removal_backups, non-empty entries), for the "requeued" refusal.
const lastBackup = m => {
  const l = (Array.isArray(m.removal_backups) ? m.removal_backups : []).filter(b => typeof b === 'string' && b);
  return l.length ? l[l.length - 1] : (typeof m.removal_backup === 'string' && m.removal_backup ? m.removal_backup : null);
};
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// Git hook folders run code at merge time, outside Antigravity: .husky/, .githooks/ and the configured core.hooksPath are out
// of scope unless an allow glob names that folder (".husky/**", not "**"). A hooksPath at the top of the repository: hook names.
const HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction',
  'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change'];
// The real path of p, resolved through its nearest folder that exists: git prints /private/var where a config may say
// /var (macOS), and a hooks folder named in the config often does not exist yet, so realpathSync on p alone would throw.
function realPath(p) {
  const rest = [];
  for (let cur = path.resolve(p); ; ) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}
export function hookDirs(...cwds) {
  const dirs = new Set(['.husky', '.githooks']);
  for (const cwd of cwds.filter(Boolean)) {
    const hp = (git(cwd, ['config', '--get', 'core.hooksPath'], { allowFail: true }) || '').trim();
    if (!hp) continue;
    const top = (git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true }) || cwd).trim();
    const abs = path.resolve(top, hp.replace(/^~(?=\/|$)/, os.homedir()));
    const rel = path.relative(realPath(top), realPath(abs));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) dirs.add(rel.split(path.sep).join('/'));   // '' is the top of the repository
  }
  return [...dirs];
}
export function outOfScope(files, allow, hooks = []) {
  let deny = []; try { deny = gates({ allowMismatch: true }).denyPathGlobs.map(g => new RegExp(glob2re(g).source, 'i')); } catch {} // N8: case-insensitive
  const globs = allow.map(g => [g, allowRe(g)]);
  return files.filter(f => {
    if (deny.some(r => r.test(f)) || !globs.some(([, r]) => r.test(f))) return true;
    const h = hooks.find(d => (d ? f.startsWith(d + '/') : !f.includes('/') && HOOK_NAMES.includes(f)));
    if (h === undefined) return false;
    return !globs.some(([g, r]) => r.test(f) && (h ? g.startsWith(h + '/') : g === f));
  });
}

// ---------------------------------------------------------------- add
export function addTask(o, now = new Date()) {
  const c = config();
  const from = o.from || 'claude';
  if (!FROM_TASK.includes(from)) bad(`--from must be one of ${FROM_TASK.join(', ')}`);
  if (!o.repo || !path.isAbsolute(o.repo)) bad('--repo needs an absolute path to a git repository');
  if (!fs.existsSync(o.repo)) bad(`${o.repo} does not exist`);
  const top = git(o.repo, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) bad(`${o.repo} is not a git repository`);
  if (!git(o.repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })) bad(`${o.repo} has no commit yet`);
  // P2-272 review S5: --base names the commit a dependent step starts from (the run's integration commit); take uses it instead of HEAD
  let startBase = null;
  if (o.base !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(String(o.base))) bad('--base must be a full 40-character commit id');
    if (git(o.repo, ['cat-file', '-e', `${o.base}^{commit}`], { allowFail: true }) === null) bad(`--base ${o.base.slice(0, 12)} is not a commit in ${o.repo}`);
    startBase = o.base;
  }
  const title = oneLine(o.title);
  if (!title) bad('--title is needed');
  if (title.length > MAX_TITLE) bad(`the title is longer than ${MAX_TITLE} characters`);
  let text = o.text !== undefined ? o.text : (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
  text = multiLine(text) || title;
  if (text.length > MAX_TEXT) bad(`the text is longer than ${MAX_TEXT} characters`);
  if (o.kind !== undefined && !kinds(c).includes(o.kind)) bad(`--kind must be one of ${kinds(c).join(', ')}`);
  const kind = o.kind || guessKind(title, text, c), route = c.routes[kind];
  const model = o.model !== undefined ? oneLine(o.model).slice(0, 80) : route.model;
  if (!model) bad('--model is empty');
  const allow = o.allow.length ? o.allow.map(g => oneLine(g)) : ['**'];
  for (const g of allow) if (!g || g.length > 200 || path.isAbsolute(g) || g.split('/').includes('..')) bad(`--allow ${g.slice(0, 60)} must be a relative glob without ".."`);
  let test = null;
  if (o.test !== undefined) {
    // the test runs with /bin/sh in the worktree. --from is self-declared, so this only stops a task that says it is Gemini's;
    // any test still passes wk-guard first, and it runs inside the done call of whoever does the task
    if (from === 'gemini') bad('a task from Gemini cannot set --test; the owner or Claude sets the test');
    test = oneLine(o.test);
    if (!test || test.length > 1000) bad('--test must be one line of up to 1000 characters');
  }
  ensureDir(wkHome()); ensureDir(tasksDir());
  let id = `${stamp(now)}-${slug(title)}`;
  for (let i = 2; ; i++) {
    try { fs.mkdirSync(taskDir(id), { mode: 0o700 }); break; }
    catch (e) { if (e.code !== 'EEXIST' || i > 99) throw e; const s = slug(title).slice(0, 40 - String(i).length - 1).replace(/-+$/, ''); id = `${stamp(now)}-${s}-${i}`; }
  }
  const meta = { id, created_at: now.toISOString(), from, title, kind, model, fallback: route.fallback || null, repo: fs.realpathSync(top.trim()), allow, test,
    status: 'queued', taken_at: null, model_used: null, worktree: null, base: null, commit: null, done_at: null, note: null,
    ...(startBase ? { start_base: startBase } : {}) };
  writeFile(path.join(taskDir(id), 'task.md'), `# ${title}\n\n${text}\n`);
  saveMeta(meta);
  return meta;
}

// ---------------------------------------------------------------- take
const sameDay = (iso, now) => { const d = new Date(iso); return !isNaN(d) && stamp(d).slice(0, 8) === stamp(now).slice(0, 8); };
export function takeTask(o, now = new Date()) {
  if (killed()) throw new Stop(3, KILL_MSG());
  const c = config();
  ensureDir(wkHome()); ensureDir(tasksDir());
  return withLock(path.join(tasksDir(), '.take.lock'), () => {
    const all = listTasks();
    const today = all.filter(t => t.taken_at && sameDay(t.taken_at, now)).length;
    if (today >= c.max_tasks_per_day) throw new Stop(4, `Today's cap of ${c.max_tasks_per_day} tasks is reached (config/gemini.json max_tasks_per_day). Stop here; the queue waits for tomorrow.`);
    let m;
    if (o.id) { m = metaOf(o.id); if (m.status !== 'queued') fail(`task ${m.id} is ${m.status}, not queued`); }
    else { m = all.find(t => t.status === 'queued'); if (!m) throw new Stop(5, 'Nothing is queued. Stop here.'); }
    // the claim file is made once ('wx'): two sessions can never take the same task, even with the lock taken over
    return withTaskLock(m.id, () => {
    m = metaOf(m.id);   // read again under the task lock: the watchdog may have changed it meanwhile
    if (m.status !== 'queued') fail(`task ${m.id} is ${m.status}, not queued`);
    const claim = path.join(taskDir(m.id), 'claim');
    const nonce = crypto.randomBytes(8).toString('hex');
    try { const fd = fs.openSync(claim, 'wx', 0o600); fs.writeSync(fd, `${process.pid} ${now.toISOString()} ${nonce}\n`); fs.closeSync(fd); }
    catch (e) { if (e.code === 'EEXIST') fail(`task ${m.id} was already taken`); throw e; }
    const attempt = attemptOf(m);
    const wt = wtOf(m);
    let wtAdded = false;
    try {
      let pre = null; try { pre = fs.lstatSync(wt); } catch {}
      if (pre) fail(`the folder for attempt ${attempt} of ${m.id} already exists (${wt}); nothing was taken`);
      if (!fs.existsSync(m.repo)) fail(`the repository ${m.repo} is gone`);
      let base = git(m.repo, ['rev-parse', '--verify', 'HEAD']).trim();
      if (m.start_base !== undefined && m.start_base !== null) {
        // checked again from git: meta.json is a plain file
        if (!/^[0-9a-f]{40}$/.test(String(m.start_base)) || git(m.repo, ['cat-file', '-e', `${m.start_base}^{commit}`], { allowFail: true }) === null) fail(`task ${m.id} names a start commit that is not in ${m.repo}`);
        base = m.start_base;
      }
      ensureDir(worktreesDir());
      git(m.repo, ['worktree', 'add', '--detach', wt, base]);
      wtAdded = true;
      Object.assign(m, { status: 'taken', taken_at: now.toISOString(), worktree: wt, base, attempt, claim_nonce: nonce, ...(o.modelUsed ? { model_used: oneLine(o.modelUsed).slice(0, 80) } : {}) });
      saveMeta(m);
      return m;
    } catch (e) {
      if (wtAdded) {
        try { git(m.repo, ['worktree', 'remove', '--force', wt], { allowFail: true }); } catch {}
        try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
      }
      fs.rmSync(claim, { force: true });
      throw e;
    }
    });
  });
}

export function brief(m) {
  const node = JSON.stringify(process.execPath), bin = JSON.stringify(path.join(BIN, 'wk-task.mjs'));
  const text = (() => { try { return fs.readFileSync(path.join(taskDir(m.id), 'task.md'), 'utf8').trimEnd(); } catch { return `# ${m.title}`; } })();
  return [
    `Took task ${m.id}: ${m.title}`,
    `Worktree: ${wtOf(m)}`,
    `Kind: ${m.kind}. Suggested model: ${m.model}${m.fallback ? ` (fallback ${m.fallback})` : ''}. Antigravity's model menu sets the model; if yours differs, say so with --model-used on done.`,
    `Allowed files: ${m.allow.join(', ')}`,
    `Test: ${m.test || 'none set'}`,
    ...earlierWorkLines(m, wkHome()),
    '',
    'Rules:',
    '- Work only inside the worktree above. Never touch the main folder of the repository.',
    '- Change only the allowed files. Never read or write keys, tokens, passwords or .env files.',
    '- Never push, deploy, publish, send mail or buy anything. Never skip permissions.',
    '- Run the test yourself before you finish. Do not commit; done does that after its checks.',
    '- If you need the owner, post a suggestion (/wk-suggest) instead of asking in chat.',
    `- When you are finished: ${node} ${bin} done ${m.id}${attemptOf(m) >= 2 ? ` --attempt ${attemptOf(m)}` : ''} --model-used "<the model you used>" --note "<what you did, in two or three lines>"`,
    '',
    '--- the task ---',
    text,
  ].join('\n');
}

// ---------------------------------------------------------------- done
// Gemini may have committed on its own: the work becomes one staged change on base again, as merge needs one commit on base.
function stageAll(wt, m) {
  if ((git(wt, ['rev-parse', 'HEAD'], { allowFail: true }) || '').trim() !== m.base) git(wt, ['reset', '-q', '--soft', m.base]);
  git(wt, ['add', '-A']);
  return zsplit(git(wt, ['diff', '--cached', ...DIFF, '--name-only', '-z', m.base]));
}
// change.diff holds the bytes of `git diff --binary <DIFF> base commit` once there is a commit (staged until then): merge compares its hash
const diffFile = m => path.join(taskDir(m.id), 'change.diff');
function writeDiff(wt, m, commit = null) {
  const d = commit ? git(wt, ['diff', '--binary', ...DIFF, m.base, commit], { raw: true }) : git(wt, ['diff', '--cached', '--binary', ...DIFF, m.base], { raw: true });
  writeFile(diffFile(m), d); return d;
}
function removeWorktree(m) {
  const wt = wtOf(m);
  let st = null; try { st = fs.lstatSync(wt); } catch {}
  if (st && !st.isDirectory()) fs.rmSync(wt, { force: true });   // a symlink or a file in its place: removed, never followed
  else if (st && fs.existsSync(m.repo) && git(m.repo, ['worktree', 'remove', '--force', wt], { allowFail: true }) !== null) { git(m.repo, ['worktree', 'prune'], { allowFail: true }); return; }
  else if (st) fs.rmSync(wt, { recursive: true, force: true });
  if (fs.existsSync(m.repo)) git(m.repo, ['worktree', 'prune'], { allowFail: true });
}
// The test string is checked by the same guard as any command before /bin/sh runs it.
function guardSays(cmd, cwd) {
  const r = spawnSync(process.execPath, [path.join(BIN, 'wk-guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd }), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: path.dirname(wkHome()), CLAUDE_PLUGIN_ROOT: path.resolve(BIN, '..') } });
  return r.status === 0 ? null : (String(r.stderr || '').trim() || 'the guard refused it');
}
const tail = (s, n) => String(s || '').replace(/\s+$/, '').split('\n').slice(-n).join('\n');

export function doneTask(o, now = new Date()) {
  metaOf(o.id);
  return withTaskLock(o.id, () => doneLocked(o, now));
}
// P2-276 review: an agent from an earlier attempt (its task was requeued after it went quiet) must not hand in its work as
// the new attempt's: from attempt 2 on, done needs --attempt with the current number.
function requeuedRefusal(m, o) {
  const cur = attemptOf(m);
  const given = o.attempt === undefined ? null : (/^\d{1,4}$/.test(String(o.attempt)) ? Number(o.attempt) : NaN);
  if (given !== null && Number.isNaN(given)) bad('--attempt needs a whole number');
  const stale = given !== null ? given !== cur : cur >= 2;
  const gone = m.status === 'queued' && Number(m.requeue_count || 0) > 0;
  if (!stale && !gone) return null;
  const bk = lastBackup(m);
  const saved = bk || `${diffFile(m)} (if any; no worktree backup was needed)`;
  // No --attempt on a taken task at attempt 2+: it may be the current attempt's own worker.
  if (given === null && m.status === 'taken' && cur >= 2) {
    return `this task is on attempt ${cur}. If your brief named attempt ${cur}, run done again with --attempt ${cur}. If your brief named an earlier attempt, stop: the task was requeued and your earlier work is saved at ${saved}.`;
  }
  return `this task was requeued; your earlier work is saved at ${bk || `${diffFile(m)} (if any; no worktree backup was needed)`}. Stop here: the task is ${m.status === 'taken' ? `now attempt ${cur}` : 'back in the queue'}.`;
}
function doneLocked(o, now) {
  const m = metaOf(o.id);
  const rq = requeuedRefusal(m, o);
  if (rq) fail(rq);
  if (!['taken', 'failed', 'out-of-scope'].includes(m.status)) fail(`task ${m.id} is ${m.status}; done needs a taken task`);
  const wt = liveWt(m);
  if (!wt) fail(`the worktree of ${m.id} is gone`);
  if (killed()) throw new Stop(3, KILL_MSG());
  const c = config();
  if (o.modelUsed) m.model_used = oneLine(o.modelUsed).slice(0, 80);
  if (o.note !== undefined) { const n = multiLine(o.note); if (n.length > MAX_NOTE) bad(`the note is longer than ${MAX_NOTE} characters`); m.note = n || null; }
  m.done_at = now.toISOString(); m.worktree = wt;
  const files = stageAll(wt, m);
  const t = shortTitle(m.title, 120);
  const models = `Suggested model: ${m.model}. Model used: ${m.model_used || 'not given'}.`;
  const say = (title, lines, action) => addSuggestion({ from: 'watchkeeper', title, detail: [...lines, models, ...(m.note ? [`Gemini's note: ${m.note}`] : [])].join('\n').slice(0, 4000), action }, now);
  if (!files.length) {
    m.status = 'no-change'; removeWorktree(m); saveMeta(m);
    say(`Gemini finished "${t}" with no change`, ['Nothing was changed, so there is nothing to merge.']);
    return { m, code: 0, msg: `No change in ${m.id}. The worktree is removed.` };
  }
  writeDiff(wt, m);
  const out = outOfScope(files, m.allow, hookDirs(m.repo, wt));
  const verify = { files, out_of_scope: out, test: null };
  if (out.length) {
    m.status = 'out-of-scope'; writeFile(path.join(taskDir(m.id), 'verify.json'), JSON.stringify(verify, null, 2) + '\n'); saveMeta(m);
    say(`Gemini changed files outside "${t}"`, [`Files outside the allowed list (${m.allow.join(', ')}): ${out.slice(0, 20).join(', ')}${out.length > 20 ? ', …' : ''}.`, 'Nothing was merged. The change is kept: discard it, or Gemini can fix it and run done again.']);
    return { m, code: 1, msg: `Out of scope: ${out.slice(0, 10).join(', ')}. Change only the allowed files (${m.allow.join(', ')}), then run done again.` };
  }
  if (m.test) {
    const refused = guardSays(m.test, wt);
    if (refused) verify.test = { cmd: m.test, code: null, tail: tail(refused, 40) };
    else {
      const timeoutMs = c.test_timeout_min * 60e3;
      const idleMs = Number(process.env.WK_TASK_TEST_IDLE_MS) || Math.min(timeoutMs, 5 * 60 * 1000);
      const r = runDetachedCommandSync(m.test, {
        cwd: wt,
        env: { ...process.env, WK_TASK_ID: m.id },
        timeoutMs,
        idleMs,
      });
      const timedOut = Boolean(r.timedOut);
      const stopNote = r.stalled
        ? `\n(stopped: test stalled with no output after ${Math.round(idleMs / 1000)}s)`
        : `\n(stopped after ${c.test_timeout_min} minutes)`;
      verify.test = {
        cmd: m.test,
        code: typeof r.status === 'number' ? r.status : null,
        tail: tail(`${r.stdout || ''}${r.stderr || ''}${timedOut ? stopNote : r.errorMessage ? `\n(${r.errorMessage})` : ''}`, 40),
      };
    }
  }
  writeFile(path.join(taskDir(m.id), 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
  if (verify.test && verify.test.code !== 0) {
    m.status = 'failed'; saveMeta(m);
    const why = verify.test.code === null ? 'did not run to the end' : `exited ${verify.test.code}`;
    say(`Gemini's work on "${t}" failed its test`, [`Test: ${m.test} (${why}).`, `Last lines:\n${tail(verify.test.tail, 10)}`, 'Nothing was merged. Gemini can fix it and run done again, or you discard it.']);
    return { m, code: 1, msg: `The test ${why}. Last lines:\n${tail(verify.test.tail, 15)}\nFix it in the worktree and run done again.` };
  }
  // passed (or no test set): commit inside the worktree; the repository's own hooks run as usual
  if (git(wt, ['diff', '--cached', '--quiet'], { allowFail: true }) === null) {
    const who = (git(wt, ['config', 'user.email'], { allowFail: true }) || '').trim() ? [] : ['-c', 'user.name=Watchkeeper', '-c', 'user.email=watchkeeper@localhost'];
    try { git(wt, [...who, 'commit', '-q', '-m', `Gemini: ${shortTitle(m.title, 150)}`, '-m', `Watchkeeper task ${m.id}. ${models}`]); }
    catch (e) { m.status = 'failed'; saveMeta(m); say(`Watchkeeper could not commit "${t}"`, [e.message, 'Nothing was merged.']); return { m, code: 1, msg: `The commit failed: ${e.message}` }; }
  }
  m.commit = git(wt, ['rev-parse', 'HEAD']).trim();
  writeDiff(wt, m, m.commit);   // exactly what merge checks: the committed change (a commit hook may have changed it)
  m.status = 'verified'; saveMeta(m);
  const s = say(`Gemini finished "${t}". ${m.test ? 'Tests pass' : 'No test was set'}. Merge it?`,
    [`Files: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', …' : ''}.`, m.test ? `Test: ${m.test} (passed).` : 'No test was set for this task, so only the file check ran.'], { type: 'task-merge', ref: m.id });
  return { m, code: 0, msg: `Verified ${m.id}${m.test ? ': the test passes' : ' (no test set)'}. The owner sees it in the W panel as suggestion ${s.id}.` };
}

// ---------------------------------------------------------------- merge, discard
export function mergeTask(o, now = new Date()) {
  const m = metaOf(o.id);
  if (m.status !== 'verified') fail(`task ${m.id} is ${m.status}; only a verified task can be merged`);
  if (killed()) throw new Stop(3, KILL_MSG());
  if (!fs.existsSync(m.repo)) fail(`the repository ${m.repo} is gone`);
  // meta.json is a plain file Gemini could rewrite: everything is checked again from git, and only the change the owner
  // can view (change.diff) merges
  const refuse = why => fail(`Watchkeeper did not merge this task: ${why} Nothing was changed.`);
  if (!SHA.test(String(m.base)) || !SHA.test(String(m.commit)) || !Array.isArray(m.allow) || !m.allow.length || !m.allow.every(g => typeof g === 'string')) refuse('its record is damaged.');
  const parent = (git(m.repo, ['rev-parse', '-q', '--verify', `${m.commit}^`], { allowFail: true }) || '').trim();
  const count = (git(m.repo, ['rev-list', '--count', `${m.base}..${m.commit}`], { allowFail: true }) || '').trim();
  if (parent !== m.base || count !== '1') refuse('the change is not one commit on the version Gemini started from.');
  if (git(m.repo, ['merge-base', '--is-ancestor', m.base, 'HEAD'], { allowFail: true }) === null) refuse('the version Gemini started from is not in your branch.');
  const touched = zsplit(git(m.repo, ['diff', ...DIFF, '--name-only', '-z', m.base, m.commit]));
  const out = outOfScope(touched, m.allow, hookDirs(m.repo, liveWt(m)));
  if (out.length) refuse(`it changes files outside the task (${out.slice(0, 5).join(', ')}${out.length > 5 ? ', …' : ''}).`);
  let saw = null; try { if (fs.lstatSync(diffFile(m)).isFile()) saw = fs.readFileSync(diffFile(m)); } catch {}
  if (!saw) refuse('the change you can view (change.diff) is missing.');
  if (sha256(git(m.repo, ['diff', '--binary', ...DIFF, m.base, m.commit], { raw: true })) !== sha256(saw)) refuse('the commit is not the change you can view.');
  if (git(m.repo, ['diff', '--cached', '--quiet'], { allowFail: true }) === null) fail('You have staged changes in the repository. Commit or unstage them, then press OK again.');
  const dirty = zsplit(git(m.repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...touched.map(literal)])).map(x => x.slice(3)).filter(Boolean);
  if (dirty.length) fail(`your repository has uncommitted changes to ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}. Commit or stash them, then merge again.`);
  if (git(m.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })) fail('a merge is already in progress in your repository; finish or abort it first');
  try { git(m.repo, ['merge', '--no-edit', m.commit]); }
  catch (e) {
    if (git(m.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })) {
      git(m.repo, ['merge', '--abort'], { allowFail: true });
      m.status = 'conflict'; m.note = [m.note, `Merge conflict on ${now.toISOString()}: nothing was merged.`].filter(Boolean).join('\n').slice(0, MAX_NOTE); saveMeta(m);
      return { m, code: 1, msg: `The change conflicts with your repository, so the merge was undone and nothing changed. The change stays in ${wtOf(m)}.` };
    }
    fail(`the merge did not start: ${e.message.replace(/^git merge: /, '')}`);
  }
  m.status = 'merged'; removeWorktree(m); saveMeta(m);
  return { m, code: 0, msg: `Merged ${m.id} into ${m.repo} (${m.commit.slice(0, 12)}). Nothing was pushed.` };
}

export function discardTask(o) {
  const m = metaOf(o.id);
  if (['merged', 'discarded'].includes(m.status)) fail(`task ${m.id} is already ${m.status}`);
  const wt = liveWt(m);
  if (wt && m.base && !fs.existsSync(diffFile(m))) { try { stageAll(wt, m); writeDiff(wt, m); } catch {} }
  removeWorktree(m);
  m.status = 'discarded'; saveMeta(m);
  return { m, code: 0, msg: `Discarded ${m.id}. ${fs.existsSync(path.join(taskDir(m.id), 'change.diff')) ? 'The change is kept in its change.diff.' : 'There was no change to keep.'}` };
}

// ---------------------------------------------------------------- list, show
const ago = iso => { const s = Math.max(0, (Date.now() - (Date.parse(iso) || Date.now())) / 1000); return s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
function list(o) {
  const all = listTasks().reverse();
  if (o.json) return console.log(JSON.stringify(all, null, 2));
  if (!all.length) return console.log('No tasks yet.');
  for (const t of all.slice(0, 30)) console.log(`${t.id}  ${t.status.padEnd(12)} ${t.kind.padEnd(6)} ${t.model}${t.model_used ? ` (used ${t.model_used})` : ''}  ${ago(t.created_at)} ago  ${shortTitle(t.title, 80)}`);
}
function show(o) {
  const m = metaOf(o.id);
  const v = readJSON(path.join(taskDir(m.id), 'verify.json'));
  if (o.json) return console.log(JSON.stringify({ ...m, verify: v }, null, 2));
  console.log([`${m.id}: ${m.title}`, `Status: ${m.status}. Kind: ${m.kind}. Suggested model: ${m.model}. Model used: ${m.model_used || 'not given'}.`, `Repository: ${m.repo}`,
    m.worktree ? `Worktree: ${wtOf(m)}` : null, `Allowed files: ${m.allow.join(', ')}. Test: ${m.test || 'none set'}.`,
    v ? `Changed: ${v.files.join(', ') || 'nothing'}${v.out_of_scope.length ? `; outside the task: ${v.out_of_scope.join(', ')}` : ''}${v.test ? `; test exit ${v.test.code}` : ''}.` : null,
    m.note ? `Note: ${m.note}` : null].filter(Boolean).join('\n'));
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname); } catch { return false; } })();
if (isMain) {
  const USAGE = 'usage: wk-task add|take|done|merge|discard|sweep|list|show (see the top of bin/wk-task.mjs)';
  let code = 0;
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'help') console.log(USAGE);
    else if (o.cmd === 'add') console.log(addTask(o).id);
    else if (o.cmd === 'take') { const m = takeTask(o); console.log(o.json ? JSON.stringify(m) : brief(m)); }
    else if (['done', 'merge', 'discard'].includes(o.cmd)) {
      const r = { done: doneTask, merge: mergeTask, discard: discardTask }[o.cmd](o);
      (r.code ? console.error : console.log)(r.msg); code = r.code;
    }
    else if (o.cmd === 'sweep') code = runWatchdogCli([o.recover ? 'recover' : 'scan', ...(o.json ? ['--json'] : [])]);
    else if (o.cmd === 'list') list(o);
    else if (o.cmd === 'show') show(o);
    else throw new Stop(2, USAGE);
  } catch (e) {
    code = e instanceof Stop ? e.code : 1;
    const msg = String(e.message || e).split('\n')[0];
    (code === 5 || code === 4 || code === 3 ? console.log : console.error)(code >= 3 ? msg : `wk-task: ${msg}`);
  }
  process.exitCode = code;
}
