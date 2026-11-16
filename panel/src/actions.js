'use strict';
// The W panel's actions (P2-227: moved out of extension.js, behaviour unchanged). Plain Node, no vscode: the Antigravity panel
// and wk-bridge (the phone, after the Mac checked its signature) call the same code. Each returns
// { ok, text, cleared, where, extra, refresh }: what to say, under which section, and whether to read the data again.
const path = require('path');
const fs = require('fs');
const D = require('./data');

const MONEY_NOTE = 'About money, legal wording or an account. Press OK again to confirm.';
const res = (ok, text, { cleared = false, where, extra = {}, refresh = true } = {}) => ({ ok, text, cleared, where, extra, refresh });

// Answer through nx (re-read first: the question must still be open), or hide it for 24 hours.
// The folder is only ever "orchestration" in <dataDir>/remote.json (D.questionsDir), never one from a workspace.
// m: { cmd: 'answerQuestion' | 'laterQuestion', n, text?, useRecommended?, confirmed?, expect?(q), changedText? }
async function question(paths, m) {
  const orch = D.questionsDir(paths.dataDir, paths.home), n = m.n, w = { n };
  const q = D.findOpenQuestion(orch, n);
  if (!q) return res(false, `Q${n} is no longer open. Nothing was sent.`, { where: 'waiting', extra: w });
  // the phone's bridge passes expect: the question read here, the one nx answers, must still be the one the phone showed
  if (typeof m.expect === 'function' && !m.expect(q)) return res(false, m.changedText || `Q${n} has changed. Nothing was sent.`, { where: 'waiting', extra: w });
  if (m.cmd === 'laterQuestion') {
    D.setLater(paths.dataDir, n);
    try { D.appendInbox(paths.dataDir, 'decision', { ref: `Q${n}`, choice: 'later', title: q.text }); } catch { /* the hide still holds */ }
    return res(true, `Q${n} is hidden for 24 hours.`, { where: 'waiting', extra: w });
  }
  let text = m.text;
  if (m.useRecommended) {
    if (!q.rec) return res(false, `Q${n} has no recommended answer. Use Answer… to write one.`, { where: 'waiting', extra: w, refresh: false });
    if (q.money && !m.confirmed) return res(false, MONEY_NOTE, { where: 'waiting', extra: w, refresh: false });
    text = D.okAnswer(q.rec);
  }
  const r = await D.answerQuestion(orch, n, text);
  if (!r.ok) return res(false, `Q${n} was not answered: ${r.out || r.err || 'the answer script did not record it'}.`, { where: 'waiting', extra: w });
  let saved = true;
  try { D.appendInbox(paths.dataDir, 'decision', { ref: `Q${n}`, choice: m.useRecommended ? 'ok' : 'answer', title: q.text, text }); } catch { saved = false; }
  return res(true, `Answered Q${n}.${saved ? '' : ' The copy for the inbox could not be saved.'}`, { cleared: true, where: 'waiting', extra: w });
}

// The plugin's wk-suggest records the choice (and runs a merge or discard for a task-merge item); nothing in the suggestion runs.
// m: { id, choice, text?, confirmed? }; merging: a Set shared by the caller; onMerging(id, on) shows "Merging…".
async function suggestion(paths, m, { merging = new Set(), onMerging = () => {} } = {}) {
  const s = D.findOpenSuggestion(paths.dataDir, m.id);
  if (!s) return res(false, 'That suggestion is already decided or gone.', { where: 'waiting' });
  if (m.choice === 'ok' && s.money && !m.confirmed) return res(false, MONEY_NOTE, { where: 'waiting', refresh: false });
  if (merging.has(m.id)) return res(false, 'That is still being merged. Please wait.', { where: 'waiting', refresh: false });
  // the merge can take minutes: the page shows "Merging…" and disabled buttons until the answer comes
  merging.add(m.id);
  onMerging(m.id, true);
  let r;
  try { r = await D.decideSuggestion(paths.pluginPath, paths.dataDir, m.id, m.choice, m.text); } finally {
    merging.delete(m.id);
    onMerging(m.id, false);
  }
  // wk-suggest says "Already merged." when the task was settled somewhere else: the item is cleared and the reply shown under it
  if (r.ok && /^Already\b/.test(r.out)) return res(true, r.out, { where: 'waiting' });
  if (!r.ok) return res(false, `That did not work: ${r.err || r.out || 'the suggestion command failed'}. Nothing else was changed.`, { where: 'waiting' });
  const said = { ok: s.action === 'task-merge' ? 'Going ahead with the merge.' : 'Going ahead.', later: 'Hidden for 24 hours.', no: s.action === 'task-merge' ? 'Declined: the change is set aside.' : 'Declined.' }[m.choice];
  return res(true, r.out ? `${said} ${r.out}` : said, { where: 'waiting' });
}

// m: { kind: 'recommendation' | 'rule', text }
function send(paths, m) {
  D.appendInbox(paths.dataDir, m.kind, m.text);
  return res(true, m.kind === 'rule'
    ? 'Saved as a proposed rule change in ~/.wk/owner-inbox.jsonl. No session reads it by itself: ask Claude Code to read that file, make the change, and approve it in that chat.'
    : 'Saved as a recommendation.', { cleared: true });
}

// m: { title, text, kind, test? }; repo: the folder the task is for.
async function task(paths, m, repo) {
  const r = await D.addTask(paths.pluginPath, paths.dataDir, { repo, title: m.title, text: m.text, kind: m.kind, test: m.test });
  if (!r.ok) return res(false, `The task was not added: ${r.err || 'the task command did not work'}.`, { where: 'task', refresh: false });
  return res(true, 'Added to Gemini\'s queue. Gemini takes it when you type /wk-take-task in Antigravity, or at the next automation run.', { cleared: true, where: 'task' });
}

// The stop switch (the kill file). Asking first is the host's job (a modal in the panel, a fresh passkey on the phone).
function stopSwitch(paths, on) {
  D.setKill(D.killFilePath(paths.pluginPath, paths.home), on);
  return res(true, on ? 'Wake-ups stopped. The kill switch is on.' : 'Wake-ups are allowed again.');
}

async function installAsk(paths) {
  const r = await D.installAsk(paths.pluginPath);
  return res(r.ok, r.ok ? `${r.text} Gemini can ask from its next conversation.` : r.text);
}

// ---------------------------------------------------------------- P2-227: jobs and the phone, through the plugin's own scripts
const script = (paths, name) => path.join(paths.pluginPath, 'bin', name);
const hasScript = (paths, name) => { try { return fs.statSync(script(paths, name)).isFile(); } catch { return false; } };
// The scripts' own settings pass through when set (the claude binary, the job limits); nothing else of this process's environment does.
const PASS = ['WK_CLAUDE_BIN', 'WK_JOB_FREE_MB', 'WK_JOB_PACE_PCT', 'WK_JOB_WALL_MS', 'WK_JOB_KILL_MS', 'WK_SSH_KEYGEN', 'WK_LAUNCHCTL'];
function runScript(paths, name, args, { timeoutMs = 20000 } = {}) {
  if (!hasScript(paths, name)) return Promise.resolve({ ok: false, out: '', err: `the plugin has no bin/${name} yet` });
  const pass = {}; for (const k of PASS) if (typeof process.env[k] === 'string' && process.env[k]) pass[k] = process.env[k];
  return D.run(process.execPath, [script(paths, name), ...args], { cwd: paths.pluginPath, env: D.childEnv({ ...pass, WK_HOME: paths.dataDir }), timeoutMs });
}
const said = (r, fallback) => r.ok ? (r.out || fallback) : (r.err || r.out || fallback);

// m: { project, prompt, model, mode, max_turns? }
async function jobStart(paths, m, from = 'panel') {
  const args = ['start', '--project', m.project, '--model', m.model, '--mode', m.mode, '--from', from, '--prompt', m.prompt, ...(m.max_turns ? ['--max-turns', String(m.max_turns)] : [])];
  const r = await runScript(paths, 'wk-job.mjs', args);
  return res(r.ok, said(r, r.ok ? 'Started.' : 'The job did not start.'), { cleared: r.ok, where: 'jobs' });
}
async function jobReply(paths, m) {
  const r = await runScript(paths, 'wk-job.mjs', ['reply', m.job, '--prompt', m.prompt]);
  return res(r.ok, said(r, r.ok ? 'Sent.' : 'The reply was not sent.'), { cleared: r.ok, where: 'jobs', extra: { job: m.job } });
}
async function jobStop(paths, m) {
  const r = await runScript(paths, 'wk-job.mjs', ['stop', m.job]);
  return res(r.ok, said(r, r.ok ? 'Stopping.' : 'The job was not stopped.'), { where: 'jobs', extra: { job: m.job } });
}
async function phoneKey(paths, id, trust) {
  const r = await runScript(paths, 'wk-bridge.mjs', [trust ? 'trust' : 'reject', id]);
  return res(r.ok, said(r, r.ok ? 'Done.' : 'That did not work.'), { where: 'phone' });
}
async function phoneControl(paths, on) {
  const r = await runScript(paths, 'wk-bridge.mjs', [on ? 'enable' : 'disable']);
  return res(r.ok, said(r, r.ok ? 'Done.' : 'That did not work.'), { where: 'phone' });
}

module.exports = { MONEY_NOTE, question, suggestion, send, task, stopSwitch, installAsk, jobStart, jobReply, jobStop, phoneKey, phoneControl };
