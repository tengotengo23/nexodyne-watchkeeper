'use strict';
// Watchkeeper W panel (P2-205): one webview view on the Activity Bar. Reads files; writes only the owner inbox line and the Stop switch,
// and (P2-208, on the owner's click) installs the ask-claude skill for Gemini through wk-ask-claude.
// P2-223, on the owner's press: answers a question through nx, decides a suggestion and adds a task through the plugin's scripts.
// P2-227: the handlers live in src/actions.js (wk-remote uses the same ones for the phone); jobs, phone keys and phone control too.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
// P2-272: loaded first, so its child-process tracking is in place before any module takes execFile/spawn
const { attachWatchdogToExtension, runWatchdogCli, readPendingRemovals, runRemovalDecision, killTrackedChildren } = require('./src/watchdog-bridge');
const D = require('./src/data');
const R = require('./src/render');
const C = require('./src/channel');
const A = require('./src/actions');
const engine = require('./src/reprompt-engine');
const { activateRePrompt, collectWorkspaceContext } = require('./src/reprompt-controller');
const { getGraphifyContext, readGraphifyStats } = require('./src/graphify-layer');
const { attachLearningToExtension } = require('./src/learning-bridge');
const {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessionSummaries,
  makeTurnId,
  upsertTurn,
  archiveChatSession,
  purgeArchivedChatSession,
  sessionBusy,
  reopenChatSession,
  archiveStaleHookSessions,
  autoArchiveCandidates,
  hookSessionsDir,
  loadChatSessions,
  promptModeOf,
} = require('./src/chat-sessions');
const { classify, wantsAutoRewrite } = require('./src/prompt-prefix');
// P2-273 review: a turn the panel pastes into Antigravity is final (typed raw, or already re-prompted here); this loop marker
// tells the Antigravity hook not to re-prompt it again (prompt-prefix.js LOOP_MARKERS).
const PANEL_AS_IS_MARK = '[Re-Prompt · W panel] Sent as is.';
function ideTaskFor(task, rp) {
  const s = rp || {};
  return s.hookAutoAll === true || wantsAutoRewrite(task, s.autoRewriteOverWords) ? `${task}\n\n${PANEL_AS_IS_MARK}` : task;
}
const { DagRunner } = require('./src/dag-runner');
const {
  parseTakeTaskCommand,
  parseHandoffClaudeCommand,
  collectWorkspaceSnapshot,
  takeQueuedTask,
  finishTakenTask,
  buildTakeTaskExecutionPrompt,
  buildClaudeTakeoverPrompt,
  publishSharedHandoff,
} = require('./src/task-handover');
const {
  detectIntegrations,
  inferAutoMode,
  inferAutoTarget,
  readWatchkeeperPace,
} = require('./src/reprompt-orchestrator');

const VIEW = 'watchkeeper.panel';
const WORKSPACE_VIEW = 'watchkeeper.workspacePanel';
const EVERY_MS = 30 * 1000;
// P2-223: where a command's result shows (under the section it came from)
const WHERE = {
  answerQuestion: 'waiting', laterQuestion: 'waiting', decideSuggestion: 'waiting', openTaskDiff: 'gemini', addTask: 'task', copyAutomation: 'copy',
  // P2-227
  jobStart: 'jobs', jobReply: 'jobs', jobStop: 'jobs', removal: 'waiting', watchdogScan: 'jobs', watchdogRecover: 'jobs', trustKey: 'phone', rejectKey: 'phone', remoteOn: 'phone', remoteOff: 'phone',
  // v0.8.0 + v2.1.0
  repromptRewrite: 'reprompt', repromptSend: 'reprompt', repromptCopy: 'reprompt', repromptToggleAuto: 'reprompt', orchestrateRun: 'orchestrator', skillsSync: 'skills', skillApprove: 'skills', skillReject: 'skills',
  chatDraft: 'reprompt', chatConfirm: 'reprompt', chatCancel: 'reprompt', chatSendToIde: 'reprompt', chatContinueFromClaude: 'reprompt', chatTakeTask: 'reprompt', chatHandoffToClaude: 'reprompt',
  // P2-272 4B: the task splitter's plan card
  // P2-277 Bridge
  bridgeOpenClaude: 'bridge', bridgeOpenAntigravity: 'bridge',
  // P2-278 API drive: the keys card
  apiKeySave: 'apikeys', apiKeyCheck: 'apikeys', apiKeyRemove: 'apikeys',
  dagRun: 'reprompt', dagNotNow: 'reprompt', dagStop: 'reprompt', dagMerge: 'reprompt', dagMergeNo: 'reprompt', dagCheck: 'reprompt',
};

// The commands that run a program (the plugin's scripts, nx, or Re-Prompt/Orchestrator CLI execution). While the window's folder is not trusted, none of them runs:
// the panel says why, and the page shows these buttons as off.
const RUNS = new Set(['bridgeOpenClaude', 'bridgeOpenAntigravity', 'answerQuestion', 'decideSuggestion', 'addTask', 'installAsk', 'jobStart', 'jobReply', 'jobStop', 'removal', 'watchdogScan', 'watchdogRecover', 'trustKey', 'rejectKey', 'remoteOn', 'remoteOff',
  'repromptRewrite', 'repromptSend', 'orchestrateRun', 'skillsSync', 'skillApprove', 'skillReject', 'graphRefresh', 'chatDraft', 'chatConfirm', 'chatSendToIde', 'chatContinueFromClaude', 'chatTakeTask', 'chatHandoffToClaude', 'dagRun', 'dagStop', 'dagMerge', 'dagCheck',
  'apiKeySave', 'apiKeyCheck', 'apiKeyRemove']);
const UNTRUSTED = 'This folder is not trusted, so Watchkeeper runs nothing from this window. Trust the folder (Manage Workspace Trust), then try again. Nothing was run.';
const trusted = () => vscode.workspace.isTrusted === true;
// P2-277: the folder watch.json names for the first handoff waiting for Claude (an absolute folder that exists), or ''.
function safeBridgeRepo(dataDir) {
  try { const r = D.readBridge(dataDir).claudeRepo; return r && fs.statSync(r).isDirectory() ? r : ''; } catch { return ''; }
}
// P2-272 4B: a task taken from the queue, with no Gemini API key set, is not queued again; it says so in plain words.
const TAKEN_TASK_NO_KEY = "This task is already in Antigravity's queue; only a Gemini API key can run it here. Add one in Settings, or take it in Antigravity with /wk-take-task.";

// With no orchestrationDir set: an `orchestration` folder with `locks/` in one of the open workspace folders, if there is one.
// Only its locks are read from there; nothing in a workspace folder is ever run.
function workspaceOrchestration() {
  for (const f of vscode.workspace.workspaceFolders || []) {
    const dir = f && f.uri && f.uri.fsPath && path.join(f.uri.fsPath, 'orchestration');
    try { if (dir && fs.statSync(path.join(dir, 'locks')).isDirectory()) return dir; } catch { /* not here */ }
  }
  return '';
}

class Panel {
  constructor(ctx, reprompt = null) {
    this.ctx = ctx;
    this.reprompt = reprompt;
    this.view = null;
    this.workspacePanel = null;
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.merging = new Set();
    this.activeChatSessionId = null;
    this.inspectedClaudeSession = null;
    const gGet = (k, d) => (ctx && ctx.globalState && typeof ctx.globalState.get === 'function' ? ctx.globalState.get(k, d) : d);
    this.confirmBeforeGo = gGet('watchkeeper.confirmBeforeGo', false) === true;
    this.syncToIde = gGet('watchkeeper.syncToIde', true) !== false;
    const wkCfg = vscode.workspace && typeof vscode.workspace.getConfiguration === 'function'
      ? vscode.workspace.getConfiguration('watchkeeper')
      : null;
    this.autoTakeTasks = !!wkCfg && wkCfg.get('autoTakeTasks') === true;
    this.takingTaskBusy = false;
    // P2-272 4B: the task splitter (plan card, run, merge offer, archive); every step goes through the 4A engine.
    this.dag = new DagRunner({
      paths: () => D.resolvePaths(this.cfg()),
      post: () => { try { this.postChatState(D.resolvePaths(this.cfg()), !trusted()); } catch { /* the view is closed */ } },
      viewing: () => this.activeChatSessionId || '',
    });
    // M4: at start-up, every stored run that was running or waiting is checked against the engine (status only).
    if (trusted()) this.dag.reconcileAll().catch(() => {});
  }

  cfg() {
    const c = vscode.workspace.getConfiguration('watchkeeper');
    return { pluginPath: c.get('pluginPath'), dataDir: c.get('dataDir'), claudeDir: c.get('claudeDir'), orchestrationDir: String(c.get('orchestrationDir') || '').trim() || workspaceOrchestration(), geminiLabel: String(c.get('geminiAccountLabel') || '') };
  }

  htmlFor(webview, fullIde = false) {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    return R.renderPage({
      nonce: crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, ''),
      cspSource: webview.cspSource,
      styleUris: [webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString()],
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      fullIde,
    });
  }

  activeWebviews() {
    const out = [];
    if (this.view && this.view.visible) out.push(this.view.webview);
    if (this.workspacePanel && this.workspacePanel.visible !== false) out.push(this.workspacePanel.webview);
    return out;
  }

  postAll(msg) {
    for (const wv of this.activeWebviews()) {
      try { wv.postMessage(msg); } catch { /* disposed */ }
    }
    if (this.workspacePanel && !this.activeWebviews().includes(this.workspacePanel.webview)) {
      try { this.workspacePanel.webview.postMessage(msg); } catch { /* disposed */ }
    }
  }

  async getCommandsSet() {
    if (vscode.commands && typeof vscode.commands.getCommands === 'function') {
      return new Set(await vscode.commands.getCommands(true));
    }
    return new Set();
  }

  async toggleMaximize() {
    const cmds = await this.getCommandsSet();
    for (const c of ['workbench.action.maximizeEditorHideSidebar', 'workbench.action.toggleMaximizeEditorGroup']) {
      if (cmds.has(c)) {
        try { await vscode.commands.executeCommand(c); return true; } catch { /* ignore */ }
      }
    }
    return false;
  }

  async popOutWorkspace() {
    await this.openWorkspace({ maximize: false });
    const cmds = await this.getCommandsSet();
    if (cmds.has('workbench.action.moveEditorToNewWindow')) {
      try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); return true; } catch { /* ignore */ }
    }
    return false;
  }

  async openWorkspace({ maximize = false, initialTab = null } = {}) {
    if (!vscode.window || typeof vscode.window.createWebviewPanel !== 'function') return null;
    if (this.workspacePanel) {
      this.workspacePanel.reveal(vscode.ViewColumn?.One ?? 1, false);
      if (initialTab) this.postAll({ type: 'switchTab', tab: initialTab });
      if (maximize) await this.toggleMaximize();
      this.refresh();
      return this.workspacePanel;
    }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      WORKSPACE_VIEW,
      'Watchkeeper Workspace',
      vscode.ViewColumn?.One ?? 1,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    if (vscode.Uri && typeof vscode.Uri.file === 'function' && this.ctx.extensionUri) {
      panel.iconPath = vscode.Uri.file(path.join(this.ctx.extensionUri.fsPath, 'media', 'icon.png'));
    }
    this.workspacePanel = panel;
    panel.webview.html = this.htmlFor(panel.webview, true);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.ctx.subscriptions);
    panel.onDidChangeViewState?.(() => { if (panel.visible !== false) this.start(); }, null, this.ctx.subscriptions);
    panel.onDidDispose(() => {
      if (this.workspacePanel === panel) this.workspacePanel = null;
      if (!this.view && !this.workspacePanel) this.stop();
    }, null, this.ctx.subscriptions);
    if (initialTab) panel.webview.postMessage({ type: 'switchTab', tab: initialTab });
    this.start();
    if (maximize) await this.toggleMaximize();
    return panel;
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.htmlFor(view.webview, false);
    view.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.ctx.subscriptions);
    const maybeOpenFull = () => {
      const loc = vscode.workspace.getConfiguration('watchkeeper').get('preferredLocation');
      if (loc !== 'sidebar' && !this.workspacePanel && vscode.window && typeof vscode.window.createWebviewPanel === 'function') {
        this.openWorkspace({ maximize: loc !== 'editor' }).catch(() => { });
      }
    };
    view.onDidChangeVisibility(() => {
      if (view.visible || this.workspacePanel) this.start();
      else this.stop();
      if (view.visible) maybeOpenFull();
    }, null, this.ctx.subscriptions);
    view.onDidDispose(() => {
      this.view = null;
      if (!this.workspacePanel) this.stop();
    }, null, this.ctx.subscriptions);
    if (view.visible) {
      this.start();
      maybeOpenFull();
    }
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.refresh(), EVERY_MS);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    this.refresh();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.dag) this.dag.dispose(); }

  // Spec 3.6: archive finished sessions (moves files, never deletes) and move stale hook_sessions
  // files aside. Errors are swallowed: archiving must never break the panel's refresh.
  // P2-272 (P3 fixes, S4): no reliable "Claude finished" signal exists (readClaudeTranscript never sets one), so
  // that trigger is gone; a Claude-tied session leaves by the quiet rule. The transcript on screen is never cleared.
  // P2-272 (P3 fixes, S5): refresh() calls this only when the folder is trusted, the plugin is there and Stop is off.
  autoArchive(paths, now = Date.now()) {
    try {
      if (fs.existsSync(path.join(paths.dataDir, 'KILL'))) return [];
      const insp = this.inspectedClaudeSession;
      const done = [];
      for (const c of autoArchiveCandidates(loadChatSessions(paths.dataDir), { activeId: this.activeChatSessionId || '' })) {
        try { if (archiveChatSession(paths.dataDir, c.id, c.reason, now)) done.push(c.id); } catch { /* keep it in the list */ }
      }
      if (!this.lastHookPrune || now - this.lastHookPrune > 60 * 60 * 1000) {
        this.lastHookPrune = now;
        const openIds = [this.activeChatSessionId, insp && insp.id].filter(Boolean);
        try { archiveStaleHookSessions(hookSessionsDir(process.env, os.homedir()), { now, openIds }); } catch { /* next hour */ }
      }
      return done;
    } catch { return []; }
  }

  mayWrite(model) {
    return trusted() && !!(model && model.pluginOk) && !(model && model.kill && model.kill.on);
  }

  // P2-272 (P3 fixes, M1/M2/N2): a line under one rail row (or under the composer), never over content.
  rowNote(sessionId, text, where = 'row') {
    this.postAll({ type: 'rowNote', sessionId: String(sessionId || ''), where, text: String(text || '') });
  }

  // Archives one session; a busy one is refused with the "Still running" line. Returns true when it moved.
  archiveFromPanel(paths, sid, reason, where) {
    if (!sid) return false;
    try {
      if (!archiveChatSession(paths.dataDir, sid, reason)) return false;
    } catch (e) {
      this.rowNote(sid, e && e.code === 'SESSION_BUSY' ? 'Still running. Stop it first, or wait.' : `Could not archive the session (${(e && e.code) || 'error'}).`, where);
      return false;
    }
    if (this.activeChatSessionId === sid) {
      const rest = listChatSessionSummaries(paths.dataDir);
      this.activeChatSessionId = rest.length ? rest[0].id : null;
    }
    return true;
  }

  readChannel(paths, model) {
    const killOn = !!(model.kill && model.kill.on);
    const key = `${paths.dataDir}\n${(model.update && model.update.version) || ''}\n${killOn}`;
    if (!this.channel || this.channelKey !== key) {
      this.channelKey = key;
      this.channel = C.createChannel({ wkHome: paths.dataDir, currentVersion: (model.update && model.update.version) || null, ...(killOn ? { minIntervalMs: Infinity } : {}) });
    }
    return this.channel.check();
  }

  async refresh() {
    const targets = this.activeWebviews();
    if (!targets.length) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const paths = D.resolvePaths(this.cfg());
      const model = await D.collect({ ...this.cfg(), workspace: this.repo() }, Date.now(), { account: true });
      model.host = 'antigravity';
      model.untrusted = !trusted();
      // P2-272 (P3 fixes, S5): the panel's own writes (archive moves, the hourly hook_sessions move) need trust, the plugin and Stop off.
      if (this.mayWrite(model) && this.autoArchive(paths).length) {
        model.chatSessions = listChatSessionSummaries(paths.dataDir);
        model.archivedChatSessions = D.listArchivedChatSessions ? D.listArchivedChatSessions(paths.dataDir) : model.archivedChatSessions;
      }
      model.removals = this.removalRows(paths);
      // P2-272 (P3-C): the developer's signed channel. No pinned key means no network call; online at most once an hour;
      // while the Stop switch is on, only the verified copies already on disk are read.
      model.channel = await this.readChannel(paths, model).catch(() => null);
      const activeSession = this.activeChatSessionId ? getChatSession(paths.dataDir, this.activeChatSessionId) : null;
      model.activeChatSessionId = activeSession ? activeSession.id : null;
      model.activeClaudeSessionId = this.inspectedClaudeSession ? this.inspectedClaudeSession.id : null;
      const sections = R.renderSections(model);
      sections.chat = sections.mode === 'sessions'
        ? ''
        : R.renderChatThread({
          activeSession,
          claudeTranscript: this.inspectedClaudeSession,
          confirmBeforeGo: this.confirmBeforeGo,
          untrusted: model.untrusted,
        });
      for (const wv of this.activeWebviews()) {
        try { wv.postMessage({ type: 'data', sections }); } catch { /* disposed */ }
      }
      this.postChatState(paths, model.untrusted);
      if (
        this.autoTakeTasks &&
        trusted() &&
        model.pluginOk &&
        !model.kill.on &&
        !this.takingTaskBusy &&
        this.reprompt &&
        this.reprompt.orchestrator &&
        Array.isArray(model.tasks && model.tasks.items) &&
        model.tasks.items.some(t => t.status === 'queued')
      ) {
        void this.takeWatchkeeperTaskIntoSession(paths, { source: 'auto' }).catch(() => { });
      }
    } catch (e) {
      this.postAll({ type: 'result', ok: false, text: `Could not read the data (${e && e.code ? e.code : 'error'}).` });
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(); }
    }
  }

  postChatState(paths = D.resolvePaths(this.cfg()), isUntrusted = !trusted()) {
    const activeSession = this.activeChatSessionId ? getChatSession(paths.dataDir, this.activeChatSessionId) : null;
    const chatHtml = R.renderChatThread({
      activeSession,
      claudeTranscript: this.inspectedClaudeSession,
      confirmBeforeGo: this.confirmBeforeGo,
      untrusted: isUntrusted,
    });
    this.postAll({
      type: 'chatState',
      activeSessionId: activeSession ? activeSession.id : null,
      activeClaudeSessionId: this.inspectedClaudeSession ? this.inspectedClaudeSession.id : null,
      chatHtml,
      confirmBeforeGo: this.confirmBeforeGo,
      syncToIde: this.syncToIde,
      autoTakeTasks: this.autoTakeTasks,
      chatSessions: listChatSessionSummaries(paths.dataDir),
      graphify: readGraphifyStats(this.repo()),
    });
  }

  async takeWatchkeeperTaskIntoSession(paths, { taskId = '', source = 'manual' } = {}) {
    if (!trusted()) {
      if (source === 'manual') this.reply(false, UNTRUSTED, false, 'reprompt');
      return { taken: false };
    }
    if (!D.pluginInstalled(paths.pluginPath)) {
      if (source === 'manual') this.reply(false, 'This needs the Watchkeeper plugin. Nothing was changed.', false, 'reprompt');
      return { taken: false };
    }
    if (this.takingTaskBusy) {
      if (source === 'manual') this.reply(false, 'Watchkeeper is already running a queued task.', false, 'reprompt');
      return { taken: false };
    }
    if (D.killState(D.killFilePath(paths.pluginPath, paths.home)).on) {
      if (source === 'manual') this.reply(false, 'Wake-ups are stopped (the Stop switch is on).', false, 'reprompt');
      return { taken: false };
    }
    if (!this.reprompt || !this.reprompt.orchestrator) {
      if (source === 'manual') this.reply(false, 'Orchestrator is not ready.', false, 'reprompt');
      return { taken: false };
    }

    this.takingTaskBusy = true;
    try {
      const claimed = await takeQueuedTask(paths.pluginPath, paths.dataDir, {
        taskId,
        modelUsed: 'gemini-pro-orchestrator',
      });
      if (!claimed.ok || !claimed.meta) {
        if (source === 'manual') {
          if (claimed.code === 5) this.reply(true, 'No queued Watchkeeper tasks right now.', false, 'reprompt');
          else this.reply(false, claimed.error || 'Could not claim Watchkeeper task.', false, 'reprompt');
        }
        return { taken: false };
      }

      const meta = claimed.meta;
      const workCwd = meta.worktree || meta.repo;
      const sess = createChatSession(paths.dataDir, {
        title: `/wk-take-task: ${meta.title || meta.id}`,
        workspace: meta.repo,
        taskId: meta.id,
        worktree: meta.worktree || '',
        engine: 'antigravity',
      });
      const gf = getGraphifyContext(workCwd, claimed.taskMarkdown || meta.title, { autoBootstrap: false, allowWrite: false });
      const snap = await collectWorkspaceSnapshot(meta.repo);
      const specPrompt = buildTakeTaskExecutionPrompt(meta, claimed.taskMarkdown, snap);
      const turn = {
        id: makeTurnId(),
        createdAt: Date.now(),
        rawPrompt: `/wk-take-task ${meta.id}`,
        status: 'preparing',
        autoTarget: 'antigravity',
        explicitTarget: true,
        autoMode: 'balanced',
        chosenTarget: 'antigravity',
        chosenMode: 'balanced',
        chosenRoute: 'gemini',
        repromptedText: specPrompt,
        repromptProvider: 'watchkeeper',
        repromptModel: 'wk-take-task',
        routeReason: `Claimed queued task ${meta.id} (${meta.kind || 'code'}) in worktree ${meta.worktree}`,
        plannedProvider: 'gemini',
        plannedModel: meta.model || 'gemini-pro-orchestrator',
        carbonFailover: false,
        skills: [{ name: 'wk-take-task', domain: 'watchkeeper', path: '', reason: 'Queued task execution' }],
        graphify: {
          available: gf.available,
          totalNodes: gf.totalNodes,
          totalEdges: gf.totalEdges,
          matchedNodes: gf.matchedNodes,
          matchedEdges: gf.matchedEdges,
          topFiles: gf.topFiles,
          savedTokens: gf.savedTokens,
          savedPct: gf.savedPct,
          mode: gf.mode,
          contextBlock: gf.contextBlock,
        },
        steps: [{
          id: 'wk_task_take',
          phase: 'wk_task_take',
          label: 'Claimed Queued Task',
          provider: 'watchkeeper',
          model: meta.id,
          status: 'done',
          detail: `Worktree: ${meta.worktree || meta.repo}`,
          thinking: `Claimed ${meta.id} (${meta.kind || 'code'}) via wk-task take.\nRepository: ${meta.repo}\nWorktree: ${meta.worktree || ''}`,
          tools: ['wk_task_take'],
          tokens: 0,
        }],
        answer: '',
        answerModel: '',
        answerProvider: '',
        error: '',
      };

      this.inspectedClaudeSession = null;
      this.activeChatSessionId = sess.id;
      upsertTurn(paths.dataDir, sess.id, turn);
      this.postChatState(paths, !trusted());

      try {
        publishSharedHandoff(paths.dataDir, {
          fromEngine: 'antigravity',
          toEngine: 'any',
          workspace: meta.repo,
          title: `/wk-take-task: ${meta.title || meta.id}`,
          summary: `Claimed task ${meta.id} inside worktree ${meta.worktree || ''}.`,
          wkSessionId: sess.id,
          taskId: meta.id,
          worktree: meta.worktree || '',
          gitSnapshot: snap,
        });
      } catch { /* best-effort */ }

      await this.executeChatTurn(paths, sess.id, turn.id, {
        executionCwd: workCwd,
        forceGemini: true,
        fromTakenTask: true,
        suppressIdeSync: source === 'auto',
      });

      const afterSess = getChatSession(paths.dataDir, sess.id);
      const updatedTurn = afterSess && (afterSess.turns || []).find(t => t && t.id === turn.id);
      if (updatedTurn && updatedTurn.status === 'done' && !updatedTurn.error) {
        const doneRes = await finishTakenTask(paths.pluginPath, paths.dataDir, {
          taskId: meta.id,
          modelUsed: updatedTurn.answerModel || 'gemini-pro-orchestrator',
          note: (updatedTurn.answer || 'Completed via Watchkeeper Antigravity simulated session.').slice(0, 600),
        });
        updatedTurn.steps = Array.isArray(updatedTurn.steps) ? [...updatedTurn.steps] : [];
        updatedTurn.steps.push({
          id: 'wk_task_done',
          phase: 'wk_task_done',
          label: doneRes.ok ? 'Verified & Submitted (`wk-task done`)' : 'Task Verification Failed (`wk-task done`)',
          provider: 'watchkeeper',
          model: meta.id,
          status: doneRes.ok ? 'done' : 'failover',
          detail: (doneRes.out || doneRes.err || `exit ${doneRes.code}`).slice(0, 260),
          thinking: [doneRes.out, doneRes.err].filter(Boolean).join('\n').slice(0, 2000),
          tools: ['wk_task_done'],
          tokens: 0,
        });
        upsertTurn(paths.dataDir, sess.id, updatedTurn);
        try {
          publishSharedHandoff(paths.dataDir, {
            fromEngine: 'antigravity',
            toEngine: 'any',
            workspace: meta.repo,
            title: `Finished ${meta.id}: ${meta.title || ''}`,
            summary: `${doneRes.ok ? 'Verified via wk-task done.' : 'wk-task done reported issues.'}\n${String(updatedTurn.answer || '').slice(0, 900)}`,
            wkSessionId: sess.id,
            agyConversationId: afterSess.agyConversationId || '',
            taskId: meta.id,
            worktree: meta.worktree || '',
            gitSnapshot: snap,
          });
        } catch { /* best-effort */ }
        this.postChatState(paths, !trusted());
        await this.refresh();
      } else {
        if (source === 'manual') {
          this.reply(false, (updatedTurn && updatedTurn.error) || 'Task execution did not complete.', false, 'reprompt');
        }
        this.postChatState(paths, !trusted());
        await this.refresh();
      }
      return { taken: true, taskId: meta.id, sessionId: sess.id };
    } finally {
      this.takingTaskBusy = false;
    }
  }

  async handoffWatchkeeperSessionToClaude(paths, sessionId, note = '') {
    if (!this.reprompt) { this.reply(false, 'Re-Prompt controller is not ready.', false, 'reprompt'); return; }
    const sess = getChatSession(paths.dataDir, sessionId);
    if (!sess) { this.reply(false, 'Session not found.', false, 'reprompt'); return; }
    const sharedWs = sess.workspace || this.repo();
    if (!sharedWs) { this.reply(false, 'Open a workspace folder first to share state with Claude Code.', false, 'reprompt'); return; }
    const snap = await collectWorkspaceSnapshot(sharedWs);
    const turns = Array.isArray(sess.turns) ? sess.turns : [];
    const lastDone = [...turns].reverse().find(t => t && (t.answer || t.repromptedText || t.rawPrompt));
    const summaryParts = [];
    if (note) summaryParts.push(`Owner note: ${note}`);
    if (lastDone && lastDone.answer) summaryParts.push(lastDone.answer.slice(0, 1200));
    else if (lastDone && lastDone.rawPrompt) summaryParts.push(`Latest request: ${lastDone.rawPrompt}`);
    const recentTurns = turns.slice(-4).map(t => `${t.rawPrompt || ''}${t.answer ? ` => ${String(t.answer).slice(0, 260)}` : ''}`);

    const handoff = publishSharedHandoff(paths.dataDir, {
      fromEngine: 'antigravity',
      toEngine: 'claude',
      workspace: sharedWs,
      title: sess.title || 'Antigravity Session Handoff',
      summary: summaryParts.join('\n\n'),
      nextSteps: note || '',
      wkSessionId: sess.id,
      agyConversationId: sess.agyConversationId || '',
      claudeSessionId: sess.claudeSessionId || '',
      taskId: sess.taskId || '',
      worktree: sess.worktree || '',
      gitSnapshot: snap,
      recentTurns,
    });

    const ideRes = typeof this.reprompt.sendToClaudeCode === 'function'
      ? await this.reprompt.sendToClaudeCode(handoff.claudePrompt)
      : { message: 'Handoff published to shared workspace.' };

    const handoffTurn = {
      id: makeTurnId(),
      createdAt: Date.now(),
      rawPrompt: note ? `/wk-handoff-claude ${note}` : '/wk-handoff-claude',
      status: 'done',
      autoTarget: 'claude',
      explicitTarget: true,
      autoMode: 'balanced',
      chosenTarget: 'claude',
      chosenMode: 'balanced',
      chosenRoute: 'claude',
      repromptedText: handoff.claudePrompt,
      repromptProvider: 'watchkeeper',
      repromptModel: 'wk-takeover',
      skills: [],
      graphify: readGraphifyStats(sharedWs),
      steps: [{
        id: 'claude_handoff',
        phase: 'claude_handoff',
        label: 'Shared Workspace Handed Off to Claude Code',
        provider: 'claude',
        model: 'Claude Code',
        status: 'done',
        detail: `Workspace: ${sharedWs} · File: ${handoff.handoffFile}`,
        thinking: `Published shared workspace handoff at ${handoff.sharedFile} and continue file at ${handoff.handoffFile}.`,
        tools: ['wk_takeover_publish'],
        tokens: 0,
      }],
      answer: `${(ideRes && ideRes.message) || 'Handoff ready.'}\nShared Workspace: ${sharedWs}\nHandoff File: ${handoff.handoffFile}\nRun /wk-take-task in Claude Code (or simply send your next prompt in that workspace) to continue seamlessly.`,
      answerModel: 'Claude Handoff',
      answerProvider: 'watchkeeper',
      error: '',
    };
    this.activeChatSessionId = sess.id;
    upsertTurn(paths.dataDir, sess.id, handoffTurn, Date.now(), { handoffFile: handoff.handoffFile });
    this.postChatState(paths, !trusted());
    this.reply(true, `Handed off to Claude Code (${sharedWs}). Copied /wk-take-task brief.`, false, 'reprompt');
    await this.refresh();
  }

  async executeChatTurn(paths, sessionId, turnId, opts = {}) {
    const sess0 = getChatSession(paths.dataDir, sessionId);
    if (!sess0) return;
    const turn0 = (sess0.turns || []).find(t => t && t.id === turnId);
    if (!turn0) return;

    const turn = {
      ...turn0,
      status: 'running',
      error: '',
      steps: Array.isArray(turn0.steps) ? [...turn0.steps] : [],
    };
    const wsRoot = opts.executionCwd || sess0.worktree || sess0.workspace || this.repo();
    const saveAndPush = (sessionPatch = null) => {
      upsertTurn(paths.dataDir, sessionId, turn, Date.now(), sessionPatch);
      this.postChatState(paths, !trusted());
    };
    saveAndPush();

    if (!this.reprompt || !this.reprompt.orchestrator) {
      turn.status = 'error';
      turn.error = 'Orchestrator is not ready.';
      saveAndPush();
      return;
    }

    const activeIdxMap = new Map();
    const upsertStep = (entry) => {
      const key = `${entry.phase || entry.step}:${entry.model || ''}`;
      if (activeIdxMap.has(key)) {
        const idx = activeIdxMap.get(key);
        const prev = turn.steps[idx];
        turn.steps[idx] = {
          ...prev,
          ...entry,
          thinking: entry.thinking
            ? (prev.thinking && !entry.thinking.startsWith(prev.thinking) ? `${prev.thinking}\n${entry.thinking}` : entry.thinking).slice(0, 6000)
            : prev.thinking,
          tools: [...new Set([...(prev.tools || []), ...(entry.tools || [])])].slice(0, 20),
        };
      } else {
        activeIdxMap.set(key, turn.steps.length);
        turn.steps.push(entry);
      }
      saveAndPush();
    };

    let ideSyncPromise = Promise.resolve(null);
    try {
      const skillLine = (turn.skills || []).map(s => `+skill:${s.name || s}`).filter(Boolean).join(' ');
      const baseTask = turn.repromptedText || turn.rawPrompt;
      const finalTask = skillLine && !baseTask.includes('+skill:') ? `${skillLine}\n\n${baseTask}` : baseTask;
      const route = turn.chosenRoute || 'auto';
      let routeOpts = {};
      if (opts.forceGemini) {
        routeOpts = { override_provider: 'gemini' };
        // P2-272 4B: a task taken from the wk-task queue is never queued again (no loop); only a Gemini API key runs it here.
        if (opts.fromTakenTask) routeOpts.no_queue = true;
      } else if (route === 'carbon') {
        routeOpts = { force_carbon: true, override_provider: 'gemini', strict_override: true };
      } else if (route === 'claude' || route === 'gemini') {
        routeOpts = { override_provider: route };
      } else if (turn.chosenTarget === 'antigravity') {
        routeOpts = { override_provider: 'gemini' };
      } else if (turn.chosenTarget === 'claude') {
        routeOpts = { override_provider: 'claude' };
      }

      let ideStepAdded = false;
      const recordIdeSyncStep = (ideRes) => {
        if (ideStepAdded || !ideRes || !ideRes.focused || !ideRes.message) return;
        ideStepAdded = true;
        upsertStep({
          id: 'ide_sync',
          phase: 'ide_sync',
          label: 'Antigravity IDE Sync',
          provider: 'antigravity',
          model: 'Antigravity IDE Chat',
          status: 'done',
          detail: ideRes.message,
          thinking: 'Copied compiled prompt to clipboard and focused Antigravity IDE Chat in parallel.',
          tools: ['antigravity_ide_sync'],
          tokens: 0,
        });
      };

      if (!opts.suppressIdeSync && this.syncToIde && turn.chosenTarget !== 'claude' && this.reprompt && typeof this.reprompt.sendToAntigravity === 'function') {
        ideSyncPromise = this.reprompt
          .sendToAntigravity(ideTaskFor(finalTask, this.reprompt ? this.reprompt.getSettings() : engine.DEFAULT_SETTINGS))
          .then((ideRes) => {
            recordIdeSyncStep(ideRes);
            return ideRes;
          })
          .catch(() => null);
      }

      const res = await this.reprompt.orchestrator.orchestrateWorkflow({
        task: finalTask,
        context: (turn.graphify && turn.graphify.contextBlock) || '',
        workspaceDir: wsRoot,
        conversationId: sess0.agyConversationId || '',
        trustedWorkspace: trusted(),
        use_graphify: !(turn.graphify && turn.graphify.contextBlock),
        auto_skills: false,
        session_id: sessionId,
        pinned_skills: (turn.skills || []).map(s => s.name || s).filter(Boolean),
        ...routeOpts,
        onProgress: (evt) => {
          if (!evt) return;
          if (evt.phase === 'trace' && evt.entry) {
            const e = evt.entry;
            if (e.step === 'graphify_token_saver') return;
            upsertStep({
              id: `${e.step}`,
              phase: e.step,
              label: e.step === 'context_compression' ? 'Context Compression' : e.step === 'aggregation' ? 'Synthesis' : 'Execution',
              provider: e.provider || '',
              model: e.model || e.provider || 'model',
              status: 'done',
              detail: e.reason_summary || '',
              thinking: e.thinking || '',
              tools: e.tools || [],
              tokens: e.tokens || 0,
              durationMs: e.duration_ms || 0,
            });
          } else if (evt.phase === 'start' || evt.phase === 'thinking' || evt.phase === 'failover') {
            if (evt.phase === 'failover') {
              const stepPhase = evt.step || 'main_task';
              for (const s of turn.steps) {
                if (s && s.phase === stepPhase && s.status === 'running') {
                  s.status = 'failover';
                }
              }
            }
            upsertStep({
              id: evt.step || 'main_task',
              phase: evt.step || 'main_task',
              label: evt.phase === 'failover' ? 'Gemini lane: Claude limits reached' : (evt.step === 'context_compression' ? 'Context Compression' : 'Execution'),
              provider: evt.provider || '',
              model: evt.model || evt.provider || 'model',
              status: evt.phase === 'failover' ? 'failover' : 'running',
              detail: evt.reason_summary || '',
              thinking: evt.thinking || '',
              tools: evt.tools || [],
            });
          }
        },
      });

      const ideRes = await ideSyncPromise;
      recordIdeSyncStep(ideRes);
      turn.answer = res.output || '';
      turn.answerModel = res.model || '';
      turn.answerProvider = res.provider || '';
      turn.carbonFailover = Boolean(res.fallback_from || res.model === 'gemini-4-carbon-high');
      if (!turn.answer && res.queue_skipped && opts.fromTakenTask) {
        turn.status = 'error';
        turn.error = TAKEN_TASK_NO_KEY;
      } else if (!turn.answer) {
        turn.status = 'error';
        const why = String(res.empty_reason || '').trim();
        turn.error = why
          ? `${why} Prompt is copied to clipboard for Antigravity IDE Chat.`
          : 'No response text was returned by the model. Prompt is copied to clipboard for Antigravity IDE Chat.';
      } else {
        turn.status = 'done';
      }
      const sessionPatch = res.provider === 'gemini' && res.conversation_id
        ? { agyConversationId: res.conversation_id }
        : null;
      saveAndPush(sessionPatch);
      const pubWs = sess0.workspace || this.repo();
      if (turn.status === 'done' && pubWs && !sess0.taskId) {
        try {
          publishSharedHandoff(paths.dataDir, {
            fromEngine: turn.answerProvider === 'claude' ? 'claude' : 'antigravity',
            toEngine: 'any',
            workspace: pubWs,
            title: sess0.title || turn.rawPrompt,
            summary: String(turn.answer || '').slice(0, 1200),
            wkSessionId: sess0.id,
            agyConversationId: (res.provider === 'gemini' && res.conversation_id) || sess0.agyConversationId || '',
            claudeSessionId: sess0.claudeSessionId || '',
            taskId: sess0.taskId || '',
            worktree: sess0.worktree || '',
          });
        } catch { /* best-effort */ }
      }
      await this.refresh();
    } catch (err) {
      await ideSyncPromise.catch(() => null);
      turn.status = 'error';
      turn.error = String((err && err.message) || err || 'Execution failed.').slice(0, 600);
      saveAndPush();
    }
  }

  reply(ok, text, cleared = false, where, extra = {}) {
    this.postAll({ type: 'result', ok, text, cleared, ...(where ? { where } : {}), ...extra });
  }

  // The first folder open in this window: where a task for Gemini goes.
  repo() { const f = (vscode.workspace.workspaceFolders || [])[0]; return f && f.uri && f.uri.fsPath ? f.uri.fsPath : ''; }

  // Show an action's result (panel/src/actions.js) under its section, then read the data again when it says so.
  answer(r) {
    this.reply(r.ok, r.text, r.cleared, r.where, r.extra);
    if (r.refresh) return this.refresh();
  }

  // P2-223: answer through nx, or hide it for 24 hours (actions.question).
  async onQuestion(m, paths) { return this.answer(await A.question(paths, m)); }

  // P2-223: the plugin's wk-suggest records the choice (actions.suggestion); "Merging…" shows while it runs.
  async onSuggestion(m, paths) {
    const onMerging = (id, on) => { this.postAll({ type: 'merging', id, on }); };
    return this.answer(await A.suggestion(paths, m, { merging: this.merging, onMerging }));
  }

  // P2-272: worktrees waiting for the owner's say-so. Rows come from the watchdog's pending-removals.json; a decision runs wk_cli.
  removalRows(paths) {
    const notes = this.removalNotes || (this.removalNotes = new Map());
    const now = Date.now();
    const rows = readPendingRemovals(paths.dataDir, now).map(r => ({ ...r, message: notes.has(r.task_id) ? notes.get(r.task_id).message : '', ok: notes.has(r.task_id) ? notes.get(r.task_id).ok : true }));
    const open = new Set(rows.map(r => r.task_id));
    for (const [id, n] of Array.from(notes)) {
      if (now - n.at > 120000) { notes.delete(id); continue; }
      if (!open.has(id)) rows.push({ task_id: id, worktree: n.worktree, done: true, message: n.message, ok: n.ok, reason: '', dirty: false });
    }
    return rows;
  }

  async onRemoval(raw, paths) {
    if (!trusted()) { this.reply(false, UNTRUSTED, false, 'waiting'); return; }
    const decision = { ok: 'approve', later: 'later', no: 'keep' }[raw.choice];
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!decision || !id || id.length > 120) { this.reply(false, 'That choice is not allowed. Nothing was changed.', false, 'waiting'); return; }
    if (!D.pluginInstalled(paths.pluginPath)) { this.reply(false, 'This needs the Watchkeeper plugin. Nothing was changed.', false, 'waiting'); return; }
    const row = readPendingRemovals(paths.dataDir).find(x => x.task_id === id);
    const r = await runRemovalDecision(paths.dataDir, paths.pluginPath, decision, id, { trusted: trusted() });
    (this.removalNotes || (this.removalNotes = new Map())).set(id, { message: r.message, ok: r.ok, at: Date.now(), worktree: row ? row.worktree : id });
    this.reply(r.ok, r.message, false, 'waiting', { removal: id });
    return this.refresh();
  }

  // P2-272: the Refresh button. Runs the same locked, AST-only update the Stop hook runs, through the Python runner (killed with the panel).
  async graphRefresh(paths) {
    const ws = this.repo();
    const script = path.join(paths.pluginPath ? path.dirname(path.dirname(paths.pluginPath)) : '', 'bin', 'wk-graph-hook.py');
    const hook = [process.env.WK_BIN_DIR && path.join(process.env.WK_BIN_DIR, 'wk-graph-hook.py'), path.join(__dirname, '..', 'bin', 'wk-graph-hook.py'), script].filter(Boolean).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!ws || !hook) { this.reply(false, 'The graph updater was not found. Nothing was changed.'); return; }
    const r = await D.run('/usr/bin/python3', [hook, 'worker', ws, 'update'], { cwd: ws, timeoutMs: 240000 });
    if (!r.ok) this.reply(false, 'The graph update did not finish. Nothing was lost.');
  }

  async onMessage(raw) {
    if (raw && raw.cmd === 'removal') {
      try { return await this.onRemoval(raw, D.resolvePaths(this.cfg())); } catch { this.reply(false, 'That did not work. Nothing was changed.', false, 'waiting'); return; }
    }
    const v = D.validateMessage(raw);
    if (!v.ok) {
      if (raw && raw.cmd === 'send') this.reply(false, v.error);
      else if (raw && WHERE[raw.cmd]) this.reply(false, v.error, false, WHERE[raw.cmd]);
      return;
    }
    const m = v.msg, paths = D.resolvePaths(this.cfg());
    try {
      // P2-272 (P3 fixes, S7): the Refresh button reads the account again (the cache keeps 'ok' 10 minutes, other states 30 seconds).
      if (m.cmd === 'refresh' && typeof D.clearAccountCache === 'function') D.clearAccountCache();
      if (m.cmd === 'ready' || m.cmd === 'refresh') return this.refresh();
      // Everything below writes or runs the plugin's code: only with the plugin, so "writes nothing" holds by code, not by hidden buttons.
      if (!D.pluginInstalled(paths.pluginPath)) { this.reply(false, 'This needs the Watchkeeper plugin. Nothing was changed.'); return; }
      if (RUNS.has(m.cmd) && !trusted()) { this.reply(false, UNTRUSTED, false, WHERE[m.cmd]); return; }
      if (m.cmd === 'send') return this.answer(A.send(paths, m));
      // P2-278: the key goes from the box to the key store and nowhere else; the answer carries only provider, saved and the last four characters
      if (m.cmd === 'apiKeySave' || m.cmd === 'apiKeyCheck' || m.cmd === 'apiKeyRemove') return this.answer(await A.apiKey(paths, m));
      if (m.cmd === 'openAdvice') {
        const f = D.adviceFile(paths.dataDir, m.id, m.which);
        if (!f) { this.reply(false, 'That file is not there any more.'); return; }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      if (m.cmd === 'installAsk') return this.answer(await A.installAsk(paths));
      if (m.cmd === 'answerQuestion' || m.cmd === 'laterQuestion') return await this.onQuestion(m, paths);
      if (m.cmd === 'decideSuggestion') return await this.onSuggestion(m, paths);
      if (m.cmd === 'openTaskDiff') {
        const f = D.taskDiffFile(paths.dataDir, m.id);
        if (!f) { this.reply(false, 'That change is not there any more.', false, 'gemini'); return; }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      if (m.cmd === 'addTask') {
        const r = await A.task(paths, m, this.repo());
        this.answer(r);
        if (
          r.ok &&
          this.autoTakeTasks &&
          trusted() &&
          !this.takingTaskBusy &&
          this.reprompt &&
          this.reprompt.orchestrator &&
          D.readTasks(paths.dataDir).items.some(t => t.status === 'queued')
        ) {
          void this.takeWatchkeeperTaskIntoSession(paths, { source: 'auto' }).catch(() => { });
        }
        return;
      }
      if (m.cmd === 'copyAutomation') {
        const g = D.readGeminiConfig(paths.pluginPath);
        if (!g.prompt) { this.reply(false, 'No automation prompt found in the plugin\'s config/gemini.json.', false, 'copy'); return; }
        await vscode.env.clipboard.writeText(g.prompt);
        this.reply(true, 'Copied. In Antigravity, make a new automation and paste this as its prompt.', false, 'copy');
        return;
      }
      const file = D.killFilePath(paths.pluginPath, paths.home);
      if (m.cmd === 'kill') return this.answer(A.stopSwitch(paths, true));
      if (m.cmd === 'unkill') {
        const go = await vscode.window.showWarningMessage('Allow Watchkeeper wake-ups again?',
          { modal: true, detail: `This removes ${file}. Wake-ups and writing tools in Watchkeeper sessions can run again.` }, 'Allow wake-ups');
        if (go !== 'Allow wake-ups') { this.reply(true, 'Nothing changed: wake-ups stay stopped.'); return; }
        return this.answer(A.stopSwitch(paths, false));
      }
      // P2-227: jobs and the phone, through the plugin's wk-job and wk-remote
      if (m.cmd === 'jobStart') return this.answer(await A.jobStart(paths, m, 'panel'));
      if (m.cmd === 'jobReply') return this.answer(await A.jobReply(paths, m));
      if (m.cmd === 'jobStop') return this.answer(await A.jobStop(paths, m));
      if (m.cmd === 'rejectKey') return this.answer(await A.phoneKey(paths, m.id, false));
      if (m.cmd === 'remoteOff') return this.answer(await A.phoneControl(paths, false));
      if (m.cmd === 'trustKey') {
        const k = D.readPhone(paths.dataDir).pending.find(x => x.id === m.id);
        if (!k) { this.reply(false, 'That phone key is not waiting any more.', false, 'phone'); return this.refresh(); }
        const go = await vscode.window.showWarningMessage(`Trust the phone key "${k.label}"?`,
          { modal: true, detail: `It was set up ${R.when(k.registered_at, Date.now())}. Trust it only if you set up your phone just now. A trusted key can answer, decide and start jobs on this Mac while phone control is on.` }, 'Trust');
        if (go !== 'Trust') { this.reply(true, 'Nothing changed: the key is not trusted.', false, 'phone'); return; }
        return this.answer(await A.phoneKey(paths, m.id, true));
      }
      if (m.cmd === 'remoteOn') {
        const go = await vscode.window.showWarningMessage('Switch phone control on?',
          { modal: true, detail: 'Your trusted phone keys can then answer, decide and start jobs on this Mac. Each command is checked here first. Switch it off here or from the phone at any time.' }, 'Switch on');
        if (go !== 'Switch on') { this.reply(true, 'Nothing changed: phone control stays off.', false, 'phone'); return; }
        return this.answer(await A.phoneControl(paths, true));
      }
      // v0.8.0: Full-IDE workspace controls, active Re-Prompt, Orchestrator Carbon High, Skills Library sync
      if (m.cmd === 'openWorkspace') { await this.openWorkspace({ maximize: false }); return; }
      if (m.cmd === 'toggleMaximize') { await this.toggleMaximize(); return; }
      if (m.cmd === 'popOutWorkspace') { await this.popOutWorkspace(); return; }
      if (m.cmd === 'repromptStudio') {
        await vscode.commands?.executeCommand?.('reprompt.openOverlay');
        return;
      }
      if (m.cmd === 'repromptCopy') {
        await vscode.env?.clipboard?.writeText?.(m.text);
        this.reply(true, 'Copied prompt to clipboard.', false, 'reprompt');
        return;
      }
      if (m.cmd === 'repromptToggleAuto') {
        if (this.reprompt) await this.reprompt.saveSettings({ hookAutoAll: m.enabled });
        this.reply(true, `Auto re-prompt is ${m.enabled ? 'on' : 'off'}.`, false, 'reprompt');
        return;
      }
      if (m.cmd === 'repromptRewrite') {
        if (!this.reprompt) { this.reply(false, 'Re-Prompt controller is not ready.', false, 'reprompt'); return; }
        const settings = this.reprompt.getSettings();
        const secrets = await this.reprompt.getSecrets();
        const ws = settings.includeWorkspaceContext !== false ? collectWorkspaceContext() : { workspaceContext: '' };
        const target = m.target === 'claude' ? 'claude_code' : m.target;
        const modeMap = { spec: 'deep_spec', bugfix: 'bug_fix' };
        const mode = modeMap[m.mode] || m.mode;
        const fullPrompt = m.skills ? `${m.skills}\n\n${m.draft}` : m.draft;
        const out = await engine.rewriteWithProvider({ settings, secrets, prompt: fullPrompt, target, mode, workspaceContext: ws.workspaceContext, workspaceDir: this.repo() });
        await this.reprompt.addHistory(out);
        this.postAll({ type: 'repromptResult', ok: true, rewritten: out.rewritten_prompt, text: `Normalized (${out.provider} · ${out.model}).` });
        return;
      }
      if (m.cmd === 'repromptSend') {
        if (!this.reprompt) { this.reply(false, 'Re-Prompt controller is not ready.', false, 'reprompt'); return; }
        const r = m.target === 'claude' ? await this.reprompt.sendToClaudeCode(m.text) : await this.reprompt.sendToAntigravity(m.text);
        this.reply(true, (r && r.message) || 'Sent.', false, 'reprompt');
        return;
      }
      if (m.cmd === 'orchestrateRun') {
        if (!this.reprompt) { this.reply(false, 'Orchestrator is not ready.', false, 'orchestrator'); return; }
        const ws = collectWorkspaceContext();
        const params = {
          task: m.prompt,
          context: ws.workspaceContext || '',
          workspaceDir: this.repo(),
          trustedWorkspace: trusted(),
          ...(m.prefer === 'carbon' ? { force_carbon: true, override_provider: 'gemini', strict_override: true }
            : m.prefer === 'claude' || m.prefer === 'gemini' ? { override_provider: m.prefer }
              : {}),
        };
        const r = await this.reprompt.orchestrator.orchestrateWorkflow(params);
        this.postAll({
          type: 'orchestrateResult',
          ok: true,
          output: r.output || '',
          text: `${r.provider} · ${r.model}: ${r.reason_summary}`,
        });
        return this.refresh();
      }
      if (m.cmd === 'skillsSync') return this.answer(await A.skillsSync(paths));
      if (m.cmd === 'skillApprove') return this.answer(await A.skillApprove(paths, m.slug));
      if (m.cmd === 'skillReject') return this.answer(await A.skillReject(paths, m.slug));
      if (m.cmd === 'graphRefresh') { await this.graphRefresh(paths); return this.refresh(); }
      if (m.cmd === 'watchdogScan' || m.cmd === 'watchdogRecover') {
        const action = m.cmd === 'watchdogRecover' ? 'recover' : 'scan';
        const r = await runWatchdogCli(paths.dataDir, paths.pluginPath, action, { trusted: trusted() });
        if (r && r.ok) {
          const msg = action === 'recover'
            ? `Watchdog recovered ${r.recoveredCount || 0} hanging item(s).`
            : `Watchdog scan: ${r.hungCount || 0} hung, ${r.warningCount || 0} warning, ${r.activeCount || 0} active.`;
          this.reply(true, msg, false, 'jobs');
        } else {
          this.reply(false, `Watchdog ${action} failed: ${(r && (r.reason || r.error)) || 'unknown error'}`, false, 'jobs');
        }
        return this.refresh();
      }

      // v2.1.0 Conversational Watchkeeper Sessions + Auto Confirmation ("Go")
      if (m.cmd === 'chatToggleConfirm') {
        this.confirmBeforeGo = m.enabled === true;
        if (this.ctx && this.ctx.globalState && typeof this.ctx.globalState.update === 'function') {
          Promise.resolve(this.ctx.globalState.update('watchkeeper.confirmBeforeGo', this.confirmBeforeGo)).catch(() => { });
        }
        this.postChatState(paths, !trusted());
        return;
      }
      if (m.cmd === 'chatToggleSyncIde') {
        this.syncToIde = m.enabled !== false;
        if (this.ctx && this.ctx.globalState && typeof this.ctx.globalState.update === 'function') {
          Promise.resolve(this.ctx.globalState.update('watchkeeper.syncToIde', this.syncToIde)).catch(() => { });
        }
        this.postChatState(paths, !trusted());
        return;
      }
      if (m.cmd === 'chatToggleAutoTake') {
        this.autoTakeTasks = m.enabled === true;
        this.postChatState(paths, !trusted());
        return;
      }
      // P2-277 Bridge: the owner's click is the only thing that starts claude, in a terminal they can see.
      if (m.cmd === 'bridgeOpenClaude') {
        const named = safeBridgeRepo(paths.dataDir);
        const want = m.repo && m.repo === named ? named : '';
        // Handoff only (review must-fix 2): never --claim, which could take a queued task for Gemini instead.
        // The repo goes inside double quotes inside single quotes, so a path with ", $, `, \\ or a newline is refused.
        if (!want || /["$`\\\n']/.test(want)) return this.reply(false, 'No unread handoff for Claude with a plain folder path; run /wk-take-task --handoff --cwd <repo> in Claude yourself.', false, 'bridge');
        const line = `claude '/wk-take-task --handoff --cwd "${want}"'`;
        const term = vscode.window.createTerminal({ name: 'Watchkeeper Bridge', cwd: want });
        term.show();
        term.sendText(line);
        return this.reply(true, `A terminal opened in ${want} with ${line}.`, false, 'bridge');
      }
      if (m.cmd === 'bridgeOpenAntigravity') return this.answer(await A.bridgeOpen(paths, m.taskId));
      if (m.cmd === 'chatTakeTask') {
        await this.takeWatchkeeperTaskIntoSession(paths, { taskId: m.taskId || '', source: 'manual' });
        return;
      }
      if (m.cmd === 'chatHandoffToClaude') {
        await this.handoffWatchkeeperSessionToClaude(paths, m.sessionId, m.note || '');
        return;
      }
      if (m.cmd === 'chatNew') {
        this.inspectedClaudeSession = null;
        const sess = createChatSession(paths.dataDir, { title: m.title || 'New session', workspace: this.repo() });
        const left = this.activeChatSessionId;
        this.activeChatSessionId = sess.id;
        if (this.dag) this.dag.onLeave(left);
        this.postChatState(paths, !trusted());
        return this.refresh();
      }
      if (m.cmd === 'chatSelect') {
        this.inspectedClaudeSession = null;
        const left = this.activeChatSessionId;
        this.activeChatSessionId = m.sessionId;
        if (this.dag && left !== m.sessionId) this.dag.onLeave(left);
        this.postChatState(paths, !trusted());
        return;
      }
      if (m.cmd === 'chatDone') {
        if (!this.archiveFromPanel(paths, m.sessionId || this.activeChatSessionId, 'done', 'row')) return;
        this.postChatState(paths, !trusted());
        return this.refresh();
      }
      if (m.cmd === 'chatReopen') {
        let back = null;
        try { back = reopenChatSession(paths.dataDir, m.sessionId); } catch (e) {
          this.rowNote(m.sessionId, `Could not reopen the session (${(e && e.code) || 'error'}). It stays in Archived.`);
          return this.refresh();
        }
        if (!back) { this.rowNote(m.sessionId, 'Could not reopen the session: its archive file was not found.'); return this.refresh(); }
        this.inspectedClaudeSession = null; this.activeChatSessionId = back.id;
        this.postChatState(paths, !trusted());
        return this.refresh();
      }
      // P2-272 (P3 fixes, M1): × on an active row archives (reason 'deleted'); nothing is erased here.
      if (m.cmd === 'chatDelete') {
        if (!this.archiveFromPanel(paths, m.sessionId, 'deleted', 'row')) return;
        this.postChatState(paths, !trusted());
        return this.refresh();
      }
      // "Delete for good": only after [Delete] on the confirm line under an Archived row (media/main.js).
      if (m.cmd === 'chatPurge') {
        if (m.confirmed !== true) return;
        let gone = false;
        try { gone = purgeArchivedChatSession(paths.dataDir, m.sessionId); } catch { gone = false; }
        if (!gone) this.rowNote(m.sessionId, 'Could not delete the archived session.');
        return this.refresh();
      }
      if (m.cmd === 'chatInspectClaude') {
        const transcript = D.readClaudeTranscript(paths.claudeDir, m.sessionId);
        this.inspectedClaudeSession = transcript;
        this.postChatState(paths, !trusted());
        return;
      }
      if (m.cmd === 'chatContinueFromClaude') {
        const transcript = D.readClaudeTranscript(paths.claudeDir, m.sessionId);
        if (!transcript) { this.reply(false, 'Claude session not found.', false, 'reprompt'); return; }
        const sharedWs = transcript.cwd || this.repo();
        const title = `Takeover: ${transcript.title || 'Claude session'}`;
        const sess = createChatSession(paths.dataDir, {
          title,
          workspace: sharedWs,
          claudeSessionId: transcript.id,
          engine: 'antigravity',
        });
        const snap = await collectWorkspaceSnapshot(sharedWs);
        const gf = getGraphifyContext(sharedWs, transcript.title || '', { autoBootstrap: false, allowWrite: false });
        if (Array.isArray(transcript.turns) && transcript.turns.length) {
          const contextTurn = {
            id: makeTurnId(),
            createdAt: Date.now(),
            rawPrompt: `Imported context from Claude session (${transcript.model || 'Claude'}): ${transcript.title}`,
            status: 'done',
            autoTarget: 'claude',
            autoMode: 'balanced',
            chosenTarget: 'claude',
            chosenMode: 'balanced',
            chosenRoute: 'auto',
            repromptedText: '',
            repromptModel: 'Claude Transcript',
            plannedModel: transcript.model || 'Claude',
            skills: [],
            graphify: { available: gf.available, totalNodes: gf.totalNodes, totalEdges: gf.totalEdges, matchedNodes: gf.matchedNodes, matchedEdges: gf.matchedEdges, topFiles: gf.topFiles, savedTokens: gf.savedTokens, savedPct: gf.savedPct, mode: gf.mode, contextBlock: gf.contextBlock },
            steps: [],
            answer: transcript.turns.slice(-4).map(t => `${t.role === 'user' ? 'User' : (t.model || 'Assistant')}: ${t.text}`).join('\n\n'),
            answerModel: transcript.model || 'Claude',
            answerProvider: 'claude',
            error: '',
          };
          upsertTurn(paths.dataDir, sess.id, contextTurn);
        }
        const takeoverPrompt = buildClaudeTakeoverPrompt(transcript, snap, sharedWs);
        const takeoverTurn = {
          id: makeTurnId(),
          createdAt: Date.now() + 1,
          rawPrompt: `/wk-take-task (from Claude session ${transcript.id.slice(0, 8)})`,
          status: 'preparing',
          autoTarget: 'antigravity',
          explicitTarget: true,
          autoMode: 'balanced',
          chosenTarget: 'antigravity',
          chosenMode: 'balanced',
          chosenRoute: 'gemini',
          repromptedText: takeoverPrompt,
          repromptProvider: 'watchkeeper',
          repromptModel: 'wk-takeover',
          routeReason: `Claude Code work continued in Antigravity, same folder (${sharedWs})`,
          plannedProvider: 'gemini',
          plannedModel: 'gemini-pro-orchestrator',
          carbonFailover: false,
          skills: [],
          graphify: { available: gf.available, totalNodes: gf.totalNodes, totalEdges: gf.totalEdges, matchedNodes: gf.matchedNodes, matchedEdges: gf.matchedEdges, topFiles: gf.topFiles, savedTokens: gf.savedTokens, savedPct: gf.savedPct, mode: gf.mode, contextBlock: gf.contextBlock },
          steps: [{
            id: 'claude_takeover',
            phase: 'claude_takeover',
            label: 'Shared Workspace Takeover (Claude → Antigravity)',
            provider: 'watchkeeper',
            model: transcript.model || 'Claude',
            status: 'done',
            detail: `Workspace: ${sharedWs}`,
            thinking: `Loaded Claude transcript ${transcript.id} and workspace git state (${snap.branch || 'workspace'}).`,
            tools: ['wk_takeover'],
            tokens: 0,
          }],
          answer: '',
          answerModel: '',
          answerProvider: '',
          error: '',
        };
        this.inspectedClaudeSession = null;
        this.activeChatSessionId = sess.id;
        upsertTurn(paths.dataDir, sess.id, takeoverTurn);
        this.postChatState(paths, !trusted());
        try {
          publishSharedHandoff(paths.dataDir, {
            fromEngine: 'claude',
            toEngine: 'antigravity',
            workspace: sharedWs,
            title,
            summary: `Taking over Claude session ${transcript.id} directly in ${sharedWs}.`,
            wkSessionId: sess.id,
            claudeSessionId: transcript.id,
            gitSnapshot: snap,
          });
        } catch { /* best-effort */ }
        await this.executeChatTurn(paths, sess.id, takeoverTurn.id, { executionCwd: sharedWs, forceGemini: true });
        return;
      }
      if (m.cmd === 'chatDraft' && /^\s*\/done\s*$/i.test(String(m.prompt || ''))) {
        const sid = this.activeChatSessionId || m.sessionId;
        if (sid && !this.archiveFromPanel(paths, sid, 'done', 'composer')) return;
        this.postChatState(paths, !trusted());
        return this.refresh();
      }
      if (m.cmd === 'chatDraft') {
        const parsedTake = parseTakeTaskCommand(m.prompt);
        if (parsedTake) {
          await this.takeWatchkeeperTaskIntoSession(paths, { taskId: parsedTake.taskId, source: 'manual' });
          return;
        }
        const parsedHandoff = parseHandoffClaudeCommand(m.prompt);
        if (parsedHandoff) {
          const targetSid = this.activeChatSessionId || m.sessionId;
          if (!targetSid) {
            this.reply(false, 'No active Watchkeeper chat session to hand off.', false, 'reprompt');
            return;
          }
          await this.handoffWatchkeeperSessionToClaude(paths, targetSid, parsedHandoff.note);
          return;
        }
        this.inspectedClaudeSession = null;
        this.confirmBeforeGo = m.confirmBeforeGo === true;
        if (typeof m.syncToIde === 'boolean') this.syncToIde = m.syncToIde;
        const wsRoot = this.repo();
        let sess = m.sessionId ? getChatSession(paths.dataDir, m.sessionId) : null;
        if (!sess && this.activeChatSessionId) sess = getChatSession(paths.dataDir, this.activeChatSessionId);
        if (!sess) sess = createChatSession(paths.dataDir, { title: m.prompt, workspace: wsRoot });
        this.activeChatSessionId = sess.id;

        const cls = classify(m.prompt);
        const isRawBypass = cls.kind === 'raw';
        // P2-273: rp: prefixes always; plain prompts only above the 30-word rule while Auto Re-Prompt is on.
        const rpSettingsNow = this.reprompt ? this.reprompt.getSettings() : engine.DEFAULT_SETTINGS;
        const turnMode = promptModeOf(m.prompt, { autoReprompt: m.autoReprompt !== false, overWords: rpSettingsNow.autoRewriteOverWords });
        const turn = {
          id: makeTurnId(),
          createdAt: Date.now(),
          rawPrompt: m.prompt,
          promptMode: turnMode,
          repromptMs: 0,
          status: 'preparing',
          autoTarget: 'antigravity',
          explicitTarget: m.target !== 'auto',
          autoMode: m.mode !== 'auto' ? m.mode : inferAutoMode(m.prompt),
          chosenTarget: m.target,
          chosenMode: m.mode,
          chosenRoute: m.route || 'auto',
          repromptedText: '',
          repromptProvider: '',
          repromptModel: '',
          routeReason: '',
          plannedProvider: '',
          plannedModel: '',
          carbonFailover: false,
          skills: [],
          graphify: { available: false, totalNodes: 0, totalEdges: 0, matchedNodes: 0, matchedEdges: 0, topFiles: [], savedTokens: 0, savedPct: 0, contextBlock: '' },
          steps: [],
          answer: '',
          answerModel: '',
          answerProvider: '',
          error: '',
        };
        upsertTurn(paths.dataDir, sess.id, turn);
        this.postChatState(paths, !trusted());

        // P2-272 4B: route "auto" and triage says "plan": a plan card waits for one click; a single route goes on at once.
        if (this.dag && await this.dag.maybePlan(sess.id, turn, { prompt: m.prompt, repo: wsRoot, route: turn.chosenRoute, raw: isRawBypass })) {
          this.postChatState(paths, !trusted());
          return;
        }

        // Step 1: Graphify Default Fundamental Token-Saving Layer
        const gf = getGraphifyContext(wsRoot, m.prompt, { autoBootstrap: true, allowWrite: trusted() });
        turn.graphify = {
          available: gf.available,
          totalNodes: gf.totalNodes,
          totalEdges: gf.totalEdges,
          matchedNodes: gf.matchedNodes,
          matchedEdges: gf.matchedEdges,
          topFiles: gf.topFiles,
          savedTokens: gf.savedTokens,
          savedPct: gf.savedPct,
          mode: gf.mode,
          contextBlock: gf.contextBlock,
        };
        if (gf.available) {
          turn.steps.push({
            id: 'graphify_token_saver',
            phase: 'graphify_token_saver',
            label: 'Graphify Token-Saving Layer',
            provider: 'graphify',
            model: 'Graphify AST · 2-Hop',
            status: 'done',
            detail: `Matched ${gf.matchedNodes}/${gf.totalNodes} nodes · ~${gf.savedPct}% saved`,
            thinking: `2-hop traversal across ${gf.matchedEdges} edges in ${gf.queryMs}ms.\nFocus files: ${(gf.topFiles || []).join(', ') || 'index'}`,
            tools: ['graphify_ast'],
            tokens: gf.subgraphEstTokens,
          });
        }
        upsertTurn(paths.dataDir, sess.id, turn);
        this.postChatState(paths, !trusted());

        // Step 2: Auto Target, Mode, Model Route & Multi-Skill Selection
        const secrets = this.reprompt ? await this.reprompt.getSecrets() : {};
        const integ = detectIntegrations(secrets);
        const paceObj = readWatchkeeperPace();
        const preview = this.reprompt && this.reprompt.orchestrator
          ? await this.reprompt.orchestrator.previewRoute({
            task: m.prompt,
            context: gf.contextBlock || '',
            watchkeeper_pace: paceObj,
            auto_skills: true,
            session_id: sess.id,
            ...(m.route === 'carbon' ? { force_carbon: true, override_provider: 'gemini', strict_override: true }
              : (m.route === 'claude' || m.route === 'gemini' ? { override_provider: m.route } : {})),
          })
          : { provider: 'gemini', model: 'gemini-pro-orchestrator', reason_summary: 'Default route', skill_judgment: null };

        const autoTarget = m.target !== 'auto' ? m.target : inferAutoTarget({ prompt: m.prompt, decision: preview, integrations: integ });
        const autoMode = m.mode !== 'auto' ? m.mode : inferAutoMode(m.prompt);
        const pinnedTokens = [];
        const droppedNames = new Set();
        for (const tok of `${m.skills || ''} ${m.prompt}`.match(/(?:^|\s)[+-@]skill:([A-Za-z0-9_.:-]+)/g) || []) {
          const clean = tok.trim();
          const sname = clean.replace(/^[+-@]skill:/, '');
          if (clean.startsWith('-')) droppedNames.add(sname.toLowerCase());
          else pinnedTokens.push({ name: sname, domain: 'pinned', path: '', reason: 'Pinned inline' });
        }
        const judgedSkills = ((preview.skill_judgment && preview.skill_judgment.load_skills) || [])
          .concat((preview.skill_judgment && preview.skill_judgment.keep_skills) || []);
        const mergedSkills = [...pinnedTokens];
        for (const sk of judgedSkills) {
          if (!sk || !sk.name || droppedNames.has(String(sk.name).toLowerCase())) continue;
          if (!mergedSkills.some(x => x.name.toLowerCase() === String(sk.name).toLowerCase())) {
            mergedSkills.push({ name: sk.name, domain: sk.domain || 'general', path: sk.path || '', reason: (preview.skill_judgment && preview.skill_judgment.reason) || 'Auto-selected' });
          }
        }
        turn.autoTarget = autoTarget;
        turn.autoMode = autoMode;
        turn.chosenTarget = m.target !== 'auto' ? m.target : autoTarget;
        turn.chosenMode = m.mode !== 'auto' ? m.mode : autoMode;
        turn.plannedProvider = preview.provider || 'gemini';
        turn.plannedModel = preview.model || 'gemini-pro-orchestrator';
        turn.carbonFailover = Boolean(preview.carbon_high_failover);
        turn.routeReason = preview.reason_summary || '';
        turn.skills = mergedSkills;
        turn.steps.push({
          id: 'auto_router',
          phase: 'auto_router',
          label: 'Auto Routing & Skill Match',
          provider: 'watchkeeper',
          model: `${turn.plannedModel} · ${autoTarget}`,
          status: 'done',
          detail: preview.reason_summary || `Target=${autoTarget}, Mode=${autoMode}`,
          thinking: `Target=${autoTarget} | Mode=${autoMode} | Planned=${turn.plannedModel}\nSkills=${mergedSkills.map(s => s.name).join(', ') || 'none'}\n${preview.reason_summary || ''}`,
          tools: ['orchestrator_router', 'skill_vault'],
          tokens: 0,
        });
        upsertTurn(paths.dataDir, sess.id, turn);
        this.postChatState(paths, !trusted());

        // Step 3: Re-Prompt Compilation (only when turnMode is 'reprompt': an rp: prefix, or the 30-word rule)
        const modeMap = { spec: 'deep_spec', bugfix: 'bug_fix' };
        const settings = this.reprompt ? this.reprompt.getSettings() : engine.DEFAULT_SETTINGS;
        const compileSettings =
          settings.provider === 'agy' &&
            (!settings.agyModel || (settings.agyModel === 'gemini-3.8-flash-low' && !settings.agyModelExplicit))
            ? { ...settings, agyModel: engine.AGY_ORCHESTRATOR_MODEL }
            : settings;
        const wsCtx = compileSettings.includeWorkspaceContext !== false ? collectWorkspaceContext(m.prompt, { trusted: trusted() }) : { workspaceContext: '' };
        const skillHeader = mergedSkills.length ? mergedSkills.map(s => `+skill:${s.name}`).join(' ') : '';
        const promptForRewrite = skillHeader ? `${skillHeader}\n\n${m.prompt}` : m.prompt;
        const engineTarget = turn.chosenTarget === 'claude' ? 'claude_code' : (turn.chosenTarget === 'antigravity' ? 'antigravity' : 'general');
        const engineMode = modeMap[autoMode] || autoMode;

        if (turnMode === 'reprompt') {
          let rpOut;
          const rpStart = Date.now();
          try {
            rpOut = await engine.rewriteWithProvider({
              settings: compileSettings,
              secrets,
              prompt: promptForRewrite,
              target: engineTarget,
              mode: engineMode,
              workspaceContext: wsCtx.workspaceContext || gf.contextBlock || '',
              workspaceDir: wsRoot,
            });
          } catch {
            rpOut = {
              ...engine.offlineRewrite({
                roughPrompt: promptForRewrite,
                target: engineTarget,
                mode: engineMode,
                workspaceContext: wsCtx.workspaceContext || gf.contextBlock || '',
              }),
              provider: 'offline-local',
              model: 'watchkeeper-local',
            };
          }
          turn.repromptMs = Math.max(0, Date.now() - rpStart);
          turn.repromptedText = rpOut.rewritten_prompt || promptForRewrite;
          turn.repromptProvider = rpOut.provider || 'local';
          turn.repromptModel = rpOut.model || 'watchkeeper-local';
          if (this.reprompt && typeof this.reprompt.addHistory === 'function') {
            try { await this.reprompt.addHistory(rpOut); } catch { /* ignore */ }
          }
          turn.steps.push({
            id: 'reprompt_compiler',
            phase: 'reprompt_compiler',
            label: 'Re-Prompt Normalization',
            provider: turn.repromptProvider,
            model: turn.repromptModel,
            status: 'done',
            detail: `Target: ${autoTarget} · Mode: ${autoMode}`,
            thinking: rpOut.summary || 'Structured goal, grounded Graphify files, composed matching skills and verification gates.',
            tools: ['reprompt_engine'],
            tokens: 0,
          });
        } else {
          turn.repromptedText = isRawBypass ? cls.body : m.prompt;
          turn.repromptProvider = 'raw';
          turn.repromptModel = 'passthrough';
        }

        if (m.confirmBeforeGo === true && !isRawBypass) {
          turn.status = 'awaiting_confirm';
          upsertTurn(paths.dataDir, sess.id, turn);
          this.postChatState(paths, !trusted());
          return this.refresh();
        }
        upsertTurn(paths.dataDir, sess.id, turn);
        await this.executeChatTurn(paths, sess.id, turn.id);
        return;
      }
      if (m.cmd === 'chatConfirm') {
        const sess = getChatSession(paths.dataDir, m.sessionId);
        if (!sess) { this.reply(false, 'Session not found.', false, 'reprompt'); return; }
        const turn = (sess.turns || []).find(t => t && t.id === m.turnId);
        if (!turn) { this.reply(false, 'Turn not found.', false, 'reprompt'); return; }
        if (['running', 'done', 'cancelled'].includes(turn.status)) {
          this.reply(false, `This turn is already ${turn.status}.`, false, 'reprompt');
          return;
        }
        if (m.repromptedText) turn.repromptedText = m.repromptedText;
        if (m.target && m.target !== 'auto') {
          if (m.target !== turn.chosenTarget) turn.explicitTarget = true;
          turn.chosenTarget = m.target;
        }
        if (m.mode && m.mode !== 'auto') turn.chosenMode = m.mode;
        if (m.route) turn.chosenRoute = m.route;
        if (Array.isArray(m.skills)) {
          turn.skills = m.skills.map(s => {
            const name = String(s).replace(/^[+-@]skill:/, '').trim();
            const prev = (turn.skills || []).find(x => String(x.name || x).toLowerCase() === name.toLowerCase());
            return prev || { name, domain: 'user', path: '', reason: 'Confirmed' };
          }).filter(x => x.name);
        }
        upsertTurn(paths.dataDir, sess.id, turn);
        this.activeChatSessionId = sess.id;
        await this.executeChatTurn(paths, sess.id, turn.id);
        return;
      }
      if (m.cmd === 'dagRun') { this.dag.run(m.sessionId, m.turnId).catch(() => {}); return; }
      if (m.cmd === 'dagNotNow') { this.dag.notNow(m.sessionId, m.turnId); return; }
      if (m.cmd === 'dagStop') { await this.dag.stop(m.sessionId, m.turnId); return; }
      if (m.cmd === 'dagMerge') { await this.dag.merge(m.sessionId, m.turnId); return; }
      if (m.cmd === 'dagMergeNo') { this.dag.mergeNo(m.sessionId, m.turnId); return; }
      if (m.cmd === 'dagCheck') { this.dag.checkAgain(m.sessionId, m.turnId).catch(() => {}); return; }
      if (m.cmd === 'chatCancel') {
        const sess = getChatSession(paths.dataDir, m.sessionId);
        const turn = sess && (sess.turns || []).find(t => t && t.id === m.turnId);
        if (turn) {
          turn.status = 'cancelled';
          upsertTurn(paths.dataDir, sess.id, turn);
          this.postChatState(paths, !trusted());
        }
        return;
      }
      if (m.cmd === 'chatSendToIde') {
        if (!this.reprompt) { this.reply(false, 'Re-Prompt controller is not ready.', false, 'reprompt'); return; }
        const sess = getChatSession(paths.dataDir, m.sessionId);
        const turn = sess && (sess.turns || []).find(t => t && t.id === m.turnId);
        if (!turn) { this.reply(false, 'Turn not found.', false, 'reprompt'); return; }
        const finalText = m.repromptedText || turn.repromptedText || turn.rawPrompt;
        const chosenTarget = m.target && m.target !== 'auto' ? m.target : (turn.chosenTarget || turn.autoTarget || 'antigravity');
        if (Array.isArray(m.skills)) {
          turn.skills = m.skills.map(s => {
            const name = String(s).replace(/^[+-@]skill:/, '').trim();
            const prev = (turn.skills || []).find(x => String(x.name || x).toLowerCase() === name.toLowerCase());
            return prev || { name, domain: 'user', path: '', reason: 'IDE Sync' };
          }).filter(x => x.name);
        }
        turn.repromptedText = finalText;
        turn.chosenTarget = chosenTarget;
        const r = chosenTarget === 'claude'
          ? await this.reprompt.sendToClaudeCode(finalText)
          : await this.reprompt.sendToAntigravity(finalText);
        const ideMsg = (r && r.message) || `Sent to ${chosenTarget}.`;
        if (String(turn.answer || '').trim()) {
          turn.steps = Array.isArray(turn.steps) ? [...turn.steps] : [];
          turn.steps.push({
            id: 'ide_sync',
            phase: 'ide_sync',
            label: 'Sent to IDE',
            provider: chosenTarget,
            model: chosenTarget === 'claude' ? 'Claude Code IDE' : 'Antigravity IDE',
            status: 'done',
            detail: ideMsg,
            thinking: 'Dispatched prompt manually via Send to IDE.',
            tools: ['ide_sync'],
            tokens: 0,
          });
        } else {
          turn.status = 'done';
          turn.answer = ideMsg;
          turn.answerModel = chosenTarget === 'claude' ? 'Claude Code IDE' : 'Antigravity IDE';
          turn.answerProvider = chosenTarget;
        }
        upsertTurn(paths.dataDir, sess.id, turn);
        this.postChatState(paths, !trusted());
        this.reply(true, ideMsg, false, 'reprompt');
        return;
      }
    } catch (e) {
      const errDetail = e && e.message ? String(e.message).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      this.reply(false, `That did not work (${e && e.code ? e.code : 'error'}${errDetail ? `: ${errDetail}` : ''}). Nothing was changed.`, false, WHERE[m.cmd]);
    }
  }
}

function activate(ctx) {
  const rp = activateRePrompt(ctx);
  const panel = new Panel(ctx, rp);
  ACTIVE_PANEL = panel;
  attachLearningToExtension(ctx, panel);
  attachWatchdogToExtension(ctx, panel);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW, panel),
    vscode.commands.registerCommand('watchkeeper.refresh', () => panel.refresh()),
    vscode.commands.registerCommand('watchkeeper.openWorkspace', () => panel.openWorkspace({ maximize: false })),
    vscode.commands.registerCommand('watchkeeper.maximizeWorkspace', () => panel.openWorkspace({ maximize: true })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('watchkeeper')) {
        const wk = vscode.workspace.getConfiguration('watchkeeper');
        panel.autoTakeTasks = wk.get('autoTakeTasks') === true;
        panel.refresh();
      }
    }),
    ...(typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function' ? [vscode.workspace.onDidGrantWorkspaceTrust(() => panel.refresh())] : []),
    { dispose: () => panel.stop() },
  );
  if (vscode.window && typeof vscode.window.registerWebviewPanelSerializer === 'function') {
    ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer(WORKSPACE_VIEW, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.workspacePanel = webviewPanel;
        const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [media] };
        webviewPanel.webview.html = panel.htmlFor(webviewPanel.webview, true);
        webviewPanel.webview.onDidReceiveMessage(m => panel.onMessage(m), null, ctx.subscriptions);
        webviewPanel.onDidChangeViewState?.(() => { if (webviewPanel.visible !== false) panel.start(); }, null, ctx.subscriptions);
        webviewPanel.onDidDispose(() => {
          if (panel.workspacePanel === webviewPanel) panel.workspacePanel = null;
          if (!panel.view && !panel.workspacePanel) panel.stop();
        }, null, ctx.subscriptions);
        panel.start();
      },
    }));
  }
  if (vscode.window && typeof vscode.window.createStatusBarItem === 'function') {
    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Right ?? 2, 101);
    sb.text = '$(shield) Watchkeeper';
    sb.tooltip = 'Open Full-IDE Watchkeeper Workspace (Cmd+Alt+W / Ctrl+Alt+W)';
    sb.command = 'watchkeeper.openWorkspace';
    sb.show();
    ctx.subscriptions.push(sb);
  }
  const c = vscode.workspace.getConfiguration('watchkeeper');
  const loc = c.get('preferredLocation');
  const openStart = c.get('openOnStartup');
  if (vscode.window && typeof vscode.window.createWebviewPanel === 'function' && openStart !== false && loc !== 'sidebar') {
    Promise.resolve().then(() => { if (!panel.workspacePanel) return panel.openWorkspace({ maximize: loc !== 'editor' }); }).catch(() => { });
  }
}
// P2-272: end everything this panel started. Detached children lead their own process group (signalled by negative pid); never the IDE's own group.
let ACTIVE_PANEL = null;
function deactivate() {
  try { if (ACTIVE_PANEL) ACTIVE_PANEL.stop(); } catch { /* shutting down */ }
  try { killTrackedChildren('SIGTERM'); } catch { /* shutting down */ }
  ACTIVE_PANEL = null;
}

module.exports = { activate, deactivate, Panel, RUNS, UNTRUSTED, TAKEN_TASK_NO_KEY, activateRePrompt, ideTaskFor, PANEL_AS_IS_MARK };
