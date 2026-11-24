'use strict';
// P2-272 4B (brief-P4.md decision 11, brief-P4B.md B1): the panel side of the task splitter.
// It never runs a step itself: every action goes through the 4A engine (core/wk_cli.py dag …, which uses
// core/dag_orchestrator.py, bin/dag-lib.mjs and bin/wk-dag-lane.mjs). No second runner.
// Flow: the composer's route is "auto" and triage says "plan" -> `dag plan` -> a plan card in the session stream
// that waits for one click ("Run these steps" / "Not now") -> `dag run` with progress from `dag status` ->
// after the last wave passes, "Merge into <branch>" waits for its click (never a push) -> archive with the reason
// 'task-done' (now, or when the owner leaves the session). A failure or a stop keeps the session, with the reason.
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { isKillOn, findPython, pluginRoot, resolveWkHome } = require('./watchdog-bridge');
const CS = require('./chat-sessions');

const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const ARCHIVE_REASON = 'task-done';
const MAX_NODES = 24;
const WAIT_POLL_MS = 60000;      // M3: the waiting card checks the queue at most once a minute (status only)
const PLANNING_SHOW_MS = 1500;   // S7: "Still planning…" shows only after this, so it never flashes
const TASK_DONE = new Set(['verified', 'merged']);

// S7: one time limit for the planner, in core/dag-limits.json, read by the engine and the panel alike.
function plannerTimeoutMs(root) {
  let s = 300;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root || '', 'core', 'dag-limits.json'), 'utf8'));
    const n = Number(j && j.plannerTimeoutS);
    if (Number.isFinite(n) && n >= 10 && n <= 3600) s = n;
  } catch { /* the default */ }
  return (s + 60) * 1000;  // the engine's own limit plus a minute, so the engine always answers first
}
const STATES = new Set(['pending', 'running', 'passed', 'failed', 'stopped', 'skipped', 'queued']);

function str(v, max = 400) { return String(v == null ? '' : v).slice(0, max); }
function strList(v, maxItems = 20, max = 300) { return Array.isArray(v) ? v.slice(0, maxItems).map(x => str(x, max)) : []; }

// The card's view of a manifest: only the fields the card shows, cut to size. Text stays raw here and is
// escaped by render.js (B4).
function cardFromManifest(man) {
  const m = man && typeof man === 'object' ? man : {};
  const nodes = (Array.isArray(m.nodes) ? m.nodes : []).slice(0, MAX_NODES).map(n => ({
    id: str(n && n.id, 40),
    title: str(n && n.title, 300),
    lane: n && n.provider === 'gemini' ? 'Antigravity queue' : 'Claude Code',
    provider: n && n.provider === 'gemini' ? 'gemini' : 'claude',
    model: str(n && n.model, 60),
    effort: str(n && n.effort, 20),
    dependsOn: strList(n && n.dependsOn, 12, 40),
    ownedGlobs: strList(n && n.ownedGlobs, 20, 200),
    verifyCmd: str(n && n.verifyCmd, 300),
  }));
  const ids = new Set(nodes.map(n => n.id));
  const waves = (Array.isArray(m.waves) ? m.waves : []).slice(0, MAX_NODES)
    .map(w => (Array.isArray(w) ? w : []).map(x => str(x, 40)).filter(x => ids.has(x)));
  const steps = {};
  const src = m.steps && typeof m.steps === 'object' ? m.steps : {};
  for (const n of nodes) {
    const s = src[n.id] || {};
    const state = STATES.has(s.state) ? s.state : 'pending';
    steps[n.id] = { state, reason: str(s.reason, 600), taskId: /^[A-Za-z0-9._-]{1,80}$/.test(String(s.taskId || '')) ? s.taskId : '',
      taskStatus: /^[a-z_-]{1,20}$/.test(String(s.taskStatus || '')) ? s.taskStatus : '' };
  }
  return {
    runId: str(m.id, 40),
    runStatus: str(m.status, 20),
    task: str(m.task, 600),
    branch: str(m.branch, 200),
    integration: str(m.integration, 600),
    nodes, waves, steps,
    engineMessage: str(m.message, 1200),
  };
}

function parseJsonOut(stdout) {
  const s = String(stdout || '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

// Default CLI: python3 <root>/core/wk_cli.py dag <action> --json …, with the panel acting for the owner.
// --json goes right after the action, so it is never behind a "--" (N5: words after "--" are the prompt).
function cliArgv(root, args) {
  const a = Array.isArray(args) ? args : [];
  return [path.join(root, 'core', 'wk_cli.py'), 'dag', ...a.slice(0, 1), '--json', ...a.slice(1)];
}
function makeCli(getCtx) {
  return (args, { timeout = 240000 } = {}) => new Promise((resolve) => {
    const { root, dataDir } = getCtx();
    if (!root) { resolve({ ok: false, error: 'This needs the Watchkeeper plugin. Nothing was changed.' }); return; }
    execFile(findPython(), cliArgv(root, args), {
      cwd: root, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: root, WK_HOME: resolveWkHome(dataDir), WK_DAG_FROM: 'owner' },
    }, (err, stdout) => {
      const j = parseJsonOut(stdout);
      if (j) resolve(j);
      else resolve({ ok: false, error: err ? 'The task splitter did not answer.' : 'The task splitter gave no answer.' });
    });
  });
}

function makeSpawnRun(getCtx) {
  return (runId) => {
    const { root, dataDir } = getCtx();
    const child = spawn(findPython(), [path.join(root, 'core', 'wk_cli.py'), 'dag', 'run', runId, '--json'], {
      cwd: root, stdio: 'ignore',
      env: { ...process.env, PYTHONPATH: root, WK_HOME: resolveWkHome(dataDir), WK_DAG_FROM: 'owner' },
    });
    return new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('exit', (code) => resolve(code));
    });
  };
}

// Triage is the engine's pure function (bin/dag-lib.mjs), loaded from the plugin root; without it, one route.
const triageFns = new Map();
async function defaultTriage(root, prompt) {
  if (!root) return { route: 'single', reason: 'no plugin' };
  if (!triageFns.has(root)) {
    let fn;
    try { fn = (await import(pathToFileURL(path.join(root, 'bin', 'dag-lib.mjs')).href)).triage; } catch { fn = null; }
    triageFns.set(root, typeof fn === 'function' ? fn : () => ({ route: 'single', reason: 'triage not found' }));
  }
  return triageFns.get(root)(prompt);
}

class DagRunner {
  constructor(opts = {}) {
    this.paths = opts.paths || (() => ({}));
    const ctx = () => { const p = this.paths() || {}; return { root: opts.root || pluginRoot(p.pluginPath), dataDir: p.dataDir || '' }; };
    this.cli = opts.cli || makeCli(ctx);
    this.spawnRun = opts.spawnRun || makeSpawnRun(ctx);
    this.archive = opts.archive || CS.archiveChatSession;
    this.isKill = opts.isKill || (() => isKillOn((this.paths() || {}).dataDir || ''));
    this.getSession = opts.getSession || CS.getChatSession;
    this.upsertTurn = opts.upsertTurn || CS.upsertTurn;
    this.post = opts.post || (() => {});
    this.viewing = opts.viewing || (() => '');
    this.triage = opts.triage || ((prompt) => defaultTriage(ctx().root, prompt));
    this.now = opts.now || (() => Date.now());
    this.pollMs = opts.pollMs || 1500;
    this.waitPollMs = Math.max(WAIT_POLL_MS, Number(opts.waitPollMs) || 0);  // never more often than once a minute
    this.planningShowMs = opts.planningShowMs == null ? PLANNING_SHOW_MS : opts.planningShowMs;
    this.plannerTimeoutMs = opts.plannerTimeoutMs || (() => plannerTimeoutMs(ctx().root));
    this.listSessions = opts.listSessions || ((dir) => CS.loadChatSessions(dir));
    this.waitTimers = new Map();      // runId -> { sid, tid, timer, sig } (M3: at most one status call a minute)
    this.runs = new Map();            // runId -> { sid, tid, timer, done }
    this.archiveOnLeave = new Set();  // session ids to archive when the owner leaves them
  }

  dataDir() { return (this.paths() || {}).dataDir || ''; }

  turnOf(sid, tid) {
    const sess = this.getSession(this.dataDir(), sid);
    const turn = sess && Array.isArray(sess.turns) ? sess.turns.find(t => t && t.id === tid) : null;
    return turn && turn.dag ? turn : null;
  }

  save(sid, turn) { this.upsertTurn(this.dataDir(), sid, turn, this.now()); this.post(); }

  // Returns true when the turn became a plan card (the caller then stops); false lets the single route go on.
  async maybePlan(sid, turn, { prompt = '', repo = '', route = 'auto', raw = false } = {}) {
    if (route !== 'auto' || raw || !repo || !turn) return false;
    let t;
    try { t = await this.triage(prompt); } catch { return false; }
    if (!t || t.route !== 'plan') return false;
    // S7: after a short wait the turn says "Still planning…"; it never shows for a quick answer, so nothing flashes.
    let shown = false;
    const showTimer = setTimeout(() => { shown = true; turn.planning = true; try { this.save(sid, turn); } catch { /* the view is closed */ } }, this.planningShowMs);
    let r;
    try {
      // N5: the prompt goes after "--"; --only-split: one-step answers save no run folder (N4).
      r = await this.cli(['plan', '--repo', repo, '--only-split', '--', prompt], { timeout: this.plannerTimeoutMs() });
    } finally {
      clearTimeout(showTimer);
      if (shown) { delete turn.planning; }
    }
    const done = (v) => { if (shown) { try { this.save(sid, turn); } catch { /* the view is closed */ } } return v; };
    if (!r || !r.ok || !r.run) return done(false);
    const card = cardFromManifest(r.run);
    if (!RUN_ID.test(card.runId) || card.nodes.length < 2) return done(false);
    turn.dag = { ...card, phase: 'plan', message: '', triage: str(t.reason, 60) };
    turn.status = 'awaiting_confirm';
    turn.routeReason = 'Split into steps: ' + str(t.reason, 60);
    this.save(sid, turn);
    return true;
  }

  // "Not now": nothing runs, the run stays planned, and the session stays in the list.
  notNow(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || turn.dag.phase !== 'plan') return false;
    turn.dag.phase = 'declined-plan';
    turn.dag.message = 'Not run. Nothing was changed.';
    turn.status = 'done';
    this.save(sid, turn);
    return true;
  }

  // "Run these steps".
  async run(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || turn.dag.phase !== 'plan' || this.runs.has(turn.dag.runId)) return false;
    return this.start(sid, tid, turn);
  }

  // Starts (or, from the waiting card, continues) the engine's run. The engine clears this run's own Stop (M4).
  async start(sid, tid, turn) {
    if (this.isKill()) {
      turn.dag.message = 'The Stop switch is on, so nothing was run.';
      this.save(sid, turn);
      return false;
    }
    const runId = turn.dag.runId;
    this.stopWaitPoll(runId);
    delete turn.dag.hint;
    turn.dag.phase = 'running';
    turn.dag.message = 'Running.';
    turn.status = 'running';
    this.save(sid, turn);
    const rec = { sid, tid, timer: null, done: false };
    this.runs.set(runId, rec);
    rec.timer = setInterval(() => { this.poll(runId).catch(() => {}); }, this.pollMs);
    let code = -1;
    try { code = await this.spawnRun(runId); } catch { code = -1; }
    if (rec.timer) clearInterval(rec.timer);
    rec.timer = null;
    await this.poll(runId, true, code);
    this.runs.delete(runId);
    const t3 = this.turnOf(sid, tid);
    if (t3 && t3.dag && t3.dag.phase === 'waiting') this.startWaitPoll(sid, tid, runId);
    return true;
  }

  async poll(runId, final = false, code = 0) {
    const rec = this.runs.get(runId);
    if (!rec || rec.done) return;
    const r = await this.cli(['status', runId], { timeout: 30000 });
    const turn = this.turnOf(rec.sid, rec.tid);
    if (!turn) return;
    if (r && r.ok && r.run) {
      const card = cardFromManifest(r.run);
      turn.dag.steps = card.steps;
      turn.dag.runStatus = card.runStatus;
      turn.dag.engineMessage = card.engineMessage;
      if (!this.applyEnd(turn, card)) { if (!final) { this.save(rec.sid, turn); return; } }
      else rec.done = true;
    }
    if (final && turn.dag.phase === 'running') {
      // The engine ended without a final state the card knows: keep everything and say so.
      turn.dag.phase = 'failed';
      turn.dag.message = `The run ended without a result (exit ${code}). Everything is kept; see the run's manifest.`;
      turn.status = 'error';
      rec.done = true;
    }
    this.save(rec.sid, turn);
  }

  // Maps the engine's end state onto the card. Returns true when the run has ended.
  applyEnd(turn, card) {
    const d = turn.dag;
    if (card.integration) d.integration = card.integration; // N6: where the work is
    switch (card.runStatus) {
      case 'passed':
        d.phase = 'merge-offer';
        d.message = `Every step passed. Nothing is in ${d.branch || 'your branch'} yet.`;
        turn.status = 'awaiting_confirm';
        return true;
      case 'waiting': {
        d.phase = 'waiting';
        const q = Object.values(d.steps).filter(s => s.state === 'queued').map(s => s.taskId).filter(Boolean);
        d.queued = q;
        d.message = q.length
          ? `Queued for Antigravity as task ${q.join(', ')}. Antigravity takes it when you run /wk-take-task there.`
          : 'Some steps are queued for Antigravity.';
        // M3: the card says what to do next; "Check again" sits beside Stop.
        d.hint = 'Waits for you: run /wk-take-task in Antigravity, then press Check again.';
        turn.status = 'queued';
        return true;
      }
      case 'failed':
        d.phase = 'failed';
        d.message = 'A step failed, so the run stopped there. Everything is kept. ' + str(card.engineMessage, 900);
        turn.status = 'error';
        return true;
      case 'stopped': {
        d.phase = 'stopped';
        delete d.hint;
        // M4: a run whose window closed or whose process ended says so, with the folder that keeps the work.
        d.message = /^Stopped: the window closed/.test(card.engineMessage || '')
          ? str(card.engineMessage, 900)
          : 'Stopped. Nothing was deleted; the work folders are kept.';
        // S4: a queued Antigravity task is not deleted by Stop; the card says it stays in the queue.
        const q = Object.values(d.steps || {}).map(s => s && s.taskId).filter(Boolean);
        if (q.length) d.message += ` The Antigravity task ${q.join(', ')} stays in the queue; Watchkeeper never deletes it.`;
        turn.status = 'cancelled';
        return true;
      }
      default:
        return false;
    }
  }

  // "Stop": the engine writes the run's STOP file and stops its process groups; nothing is deleted.
  async stop(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || !['running', 'waiting'].includes(turn.dag.phase)) return false;
    const r = await this.cli(['stop', turn.dag.runId], { timeout: 30000 });
    const t2 = this.turnOf(sid, tid) || turn;
    if (r && r.ok && r.run && cardFromManifest(r.run).runStatus === 'stopped') {
      this.applyEnd(t2, cardFromManifest(r.run));
    } else {
      t2.dag.message = r && r.ok ? 'Stopping. The running steps end at their next check.' : 'Could not stop the run: ' + str(r && (r.error || r.message), 300);
    }
    if (t2.dag.phase === 'stopped') this.stopWaitPoll(t2.dag.runId);
    this.save(sid, t2);
    return !!(r && r.ok);
  }

  // "Merge into <branch>": the engine's merge (git merge --no-edit; never a push).
  async merge(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || turn.dag.phase !== 'merge-offer') return false;
    if (this.isKill()) {
      turn.dag.message = 'The Stop switch is on, so nothing is merged.';
      this.save(sid, turn);
      return false;
    }
    const r = await this.cli(['merge', turn.dag.runId], { timeout: 120000 });
    const t2 = this.turnOf(sid, tid) || turn;
    if (r && r.ok) {
      t2.dag.phase = 'merged';
      t2.dag.message = str(r.message, 400) || `Merged into ${t2.dag.branch}. Nothing was pushed.`;
      t2.status = 'done';
      this.save(sid, t2);
      this.tryArchive(sid);
      return true;
    }
    t2.dag.message = str((r && (r.message || r.error)) || 'The merge did not go through.', 600);
    this.save(sid, t2);
    return false;
  }

  // "Not now" on the merge offer: the run's branch stays as it is; the task is finished.
  mergeNo(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || turn.dag.phase !== 'merge-offer') return false;
    turn.dag.phase = 'merge-declined';
    turn.dag.message = `Not merged. The steps' work stays on the run's branch dag/${turn.dag.runId}/…; ${turn.dag.branch || 'your branch'} is unchanged.`
      // N6: how to merge later, and where the work is.
      + ` To merge later, run: wk dag merge ${turn.dag.runId}.`
      + (turn.dag.integration ? ` The work is in ${turn.dag.integration}.` : '');
    turn.status = 'done';
    this.save(sid, turn);
    this.tryArchive(sid);
    return true;
  }

  // Archives a finished session, never while a turn is busy; waits while the owner is viewing it.
  tryArchive(sid) {
    if (this.viewing() === sid) { this.archiveOnLeave.add(sid); return 'deferred'; }
    const sess = this.getSession(this.dataDir(), sid);
    if (!sess) { this.archiveOnLeave.delete(sid); return 'gone'; }
    if (CS.sessionBusy(sess)) { this.archiveOnLeave.add(sid); return 'busy'; }
    try {
      this.archive(this.dataDir(), sid, ARCHIVE_REASON, this.now());
      this.archiveOnLeave.delete(sid);
      this.post();
      return 'archived';
    } catch (e) {
      if (e && e.code === 'SESSION_BUSY') { this.archiveOnLeave.add(sid); return 'busy'; }
      return 'error';
    }
  }

  // The owner left a session (selected another one, started a new one, or closed the panel).
  onLeave(sid) {
    if (!sid || !this.archiveOnLeave.has(sid)) return '';
    if (this.viewing() === sid) return 'deferred';
    return this.tryArchive(sid);
  }

  // M3 "Check again" on the waiting card: `dag status` first; once Antigravity has finished a queued task
  // (verified, or ended otherwise), `dag run` continues the run, which takes or refuses the task's work.
  async checkAgain(sid, tid) {
    const turn = this.turnOf(sid, tid);
    if (!turn || turn.dag.phase !== 'waiting' || this.runs.has(turn.dag.runId)) return false;
    const r = await this.cli(['status', turn.dag.runId], { timeout: 30000 });
    const t2 = this.turnOf(sid, tid) || turn;
    if (!r || !r.ok || !r.run) {
      t2.dag.message = 'Could not read the run: ' + str(r && (r.error || r.message), 300);
      this.save(sid, t2);
      return false;
    }
    const card = cardFromManifest(r.run);
    t2.dag.steps = card.steps;
    t2.dag.runStatus = card.runStatus;
    t2.dag.engineMessage = card.engineMessage;
    if (card.runStatus !== 'waiting') { this.applyEnd(t2, card); this.save(sid, t2); return false; }
    const ready = Object.values(card.steps).some(s => s.state === 'queued' && s.taskStatus && !['queued', 'taken'].includes(s.taskStatus));
    if (!ready) {
      this.applyEnd(t2, card);
      t2.dag.message = 'Antigravity has not finished yet. ' + t2.dag.message;
      this.save(sid, t2);
      return false;
    }
    return this.start(sid, tid, t2);
  }

  // M4: at start-up, every stored turn whose run was running or waiting is checked against the engine; a run whose
  // window closed is shown as stopped, with the folder that keeps the work.
  async reconcileAll() {
    let list = [];
    try { list = this.listSessions(this.dataDir()) || []; } catch { list = []; }
    let n = 0;
    for (const sess of list) {
      for (const t of (sess && Array.isArray(sess.turns) ? sess.turns : [])) {
        if (!t || !t.dag || !['running', 'waiting'].includes(t.dag.phase) || !RUN_ID.test(String(t.dag.runId || ''))) continue;
        if (this.runs.has(t.dag.runId)) continue;
        const r = await this.cli(['status', t.dag.runId], { timeout: 30000 });
        const turn = this.turnOf(sess.id, t.id);
        if (!turn) continue;
        if (r && r.ok && r.run) {
          const card = cardFromManifest(r.run);
          turn.dag.steps = card.steps;
          turn.dag.runStatus = card.runStatus;
          turn.dag.engineMessage = card.engineMessage;
          if (card.runStatus === 'running') {
            // The engine still runs it (another window): show it as running; Stop works from here.
            turn.dag.phase = 'running';
            turn.dag.message = 'Running in another window.';
            turn.status = 'running';
          } else if (!this.applyEnd(turn, card)) {
            continue;
          }
        } else {
          continue;
        }
        this.save(sess.id, turn);
        if (turn.dag.phase === 'waiting') this.startWaitPoll(sess.id, turn.id, turn.dag.runId);
        n += 1;
      }
    }
    return n;
  }

  // M3: an optional check while a card waits for Antigravity: at most once a minute, `dag status` only, and the
  // card is saved only when something changed. It never runs, merges or deletes anything.
  startWaitPoll(sid, tid, runId) {
    if (!runId || this.waitTimers.has(runId)) return;
    const rec = { sid, tid, timer: null, sig: '' };
    rec.timer = setInterval(() => { this.waitPoll(runId).catch(() => {}); }, this.waitPollMs);
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
    this.waitTimers.set(runId, rec);
  }

  stopWaitPoll(runId) {
    const rec = this.waitTimers.get(runId);
    if (rec && rec.timer) clearInterval(rec.timer);
    this.waitTimers.delete(runId);
  }

  async waitPoll(runId) {
    const rec = this.waitTimers.get(runId);
    if (!rec) return false;
    const turn = this.turnOf(rec.sid, rec.tid);
    if (!turn || turn.dag.phase !== 'waiting' || this.runs.has(runId)) { this.stopWaitPoll(runId); return false; }
    const r = await this.cli(['status', runId], { timeout: 30000 });
    if (!r || !r.ok || !r.run) return false;
    const card = cardFromManifest(r.run);
    const sig = JSON.stringify([card.runStatus, card.steps]);
    if (!rec.sig) rec.sig = JSON.stringify([turn.dag.runStatus, turn.dag.steps]);
    if (sig === rec.sig) return false;
    rec.sig = sig;
    turn.dag.steps = card.steps;
    turn.dag.runStatus = card.runStatus;
    turn.dag.engineMessage = card.engineMessage;
    if (card.runStatus === 'waiting') {
      this.applyEnd(turn, card);
      const ready = Object.values(card.steps).filter(s => s.state === 'queued' && TASK_DONE.has(s.taskStatus)).map(s => s.taskId);
      if (ready.length) turn.dag.hint = `Antigravity has finished task ${ready.join(', ')}. Press Check again to take its work.`;
    } else {
      this.applyEnd(turn, card);
      this.stopWaitPoll(runId);
    }
    this.save(rec.sid, turn);
    return true;
  }

  dispose() {
    for (const rec of this.runs.values()) { if (rec.timer) clearInterval(rec.timer); rec.timer = null; }
    for (const id of [...this.waitTimers.keys()]) this.stopWaitPoll(id);
  }
}

module.exports = { DagRunner, cardFromManifest, cliArgv, plannerTimeoutMs, ARCHIVE_REASON, RUN_ID, WAIT_POLL_MS };
