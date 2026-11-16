'use strict';
// Watchkeeper W panel (P2-205): one webview view on the Activity Bar. Reads files; writes only the owner inbox line and the kill switch,
// and (P2-208, on the owner's click) installs the ask-claude skill for Gemini through wk-ask-claude.
// P2-223, on the owner's press: answers a question through nx, decides a suggestion and adds a task through the plugin's scripts.
// P2-227: the handlers live in src/actions.js (wk-bridge uses the same ones for the phone); jobs, phone keys and phone control too.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const D = require('./src/data');
const R = require('./src/render');
const A = require('./src/actions');

const VIEW = 'watchkeeper.panel';
const EVERY_MS = 30 * 1000;
// P2-223: where a command's result shows (under the section it came from)
const WHERE = { answerQuestion: 'waiting', laterQuestion: 'waiting', decideSuggestion: 'waiting', openTaskDiff: 'gemini', addTask: 'task', copyAutomation: 'copy',
  // P2-227
  jobStart: 'jobs', jobReply: 'jobs', jobStop: 'jobs', trustKey: 'phone', rejectKey: 'phone', remoteOn: 'phone', remoteOff: 'phone' };

// The commands that run a program (the plugin's scripts or an nx). While the window's folder is not trusted, none of them runs:
// the panel says why, and the page shows these buttons as off.
const RUNS = new Set(['answerQuestion', 'decideSuggestion', 'addTask', 'installAsk', 'jobStart', 'jobReply', 'jobStop', 'trustKey', 'rejectKey', 'remoteOn', 'remoteOff']);
const UNTRUSTED = 'This folder is not trusted, so Watchkeeper runs nothing from this window. Trust the folder (Manage Workspace Trust), then try again. Nothing was run.';
const trusted = () => vscode.workspace.isTrusted === true;

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
  constructor(ctx) { this.ctx = ctx; this.view = null; this.timer = null; this.busy = false; this.again = false; this.merging = new Set(); }

  cfg() {
    const c = vscode.workspace.getConfiguration('watchkeeper');
    return { pluginPath: c.get('pluginPath'), dataDir: c.get('dataDir'), claudeDir: c.get('claudeDir'), orchestrationDir: String(c.get('orchestrationDir') || '').trim() || workspaceOrchestration() };
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = R.renderPage({
      nonce: crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, ''),
      cspSource: view.webview.cspSource,
      styleUris: [view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString()],
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
    });
    view.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.ctx.subscriptions);
    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()), null, this.ctx.subscriptions);
    view.onDidDispose(() => { this.stop(); this.view = null; }, null, this.ctx.subscriptions);
    if (view.visible) this.start();
  }

  start() { this.stop(); this.timer = setInterval(() => this.refresh(), EVERY_MS); this.refresh(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async refresh() {
    if (!this.view || !this.view.visible) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const model = await D.collect(this.cfg(), Date.now());
      model.host = 'antigravity';
      model.untrusted = !trusted();
      if (this.view) this.view.webview.postMessage({ type: 'data', sections: R.renderSections(model) });
    } catch (e) {
      if (this.view) this.view.webview.postMessage({ type: 'result', ok: false, text: `Could not read the data (${e && e.code ? e.code : 'error'}).` });
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(); }
    }
  }

  reply(ok, text, cleared = false, where, extra = {}) {
    if (this.view) this.view.webview.postMessage({ type: 'result', ok, text, cleared, ...(where ? { where } : {}), ...extra });
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
    const onMerging = (id, on) => { if (this.view) this.view.webview.postMessage({ type: 'merging', id, on }); };
    return this.answer(await A.suggestion(paths, m, { merging: this.merging, onMerging }));
  }

  async onMessage(raw) {
    const v = D.validateMessage(raw);
    if (!v.ok) {
      if (raw && raw.cmd === 'send') this.reply(false, v.error);
      else if (raw && WHERE[raw.cmd]) this.reply(false, v.error, false, WHERE[raw.cmd]);
      return;
    }
    const m = v.msg, paths = D.resolvePaths(this.cfg());
    try {
      if (m.cmd === 'ready' || m.cmd === 'refresh') return this.refresh();
      // Everything below writes or runs the plugin's code: only with the plugin, so "writes nothing" holds by code, not by hidden buttons.
      if (!D.pluginInstalled(paths.pluginPath)) { this.reply(false, 'This needs the Watchkeeper plugin. Nothing was changed.'); return; }
      if (RUNS.has(m.cmd) && !trusted()) { this.reply(false, UNTRUSTED, false, WHERE[m.cmd]); return; }
      if (m.cmd === 'send') return this.answer(A.send(paths, m));
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
      if (m.cmd === 'addTask') return this.answer(await A.task(paths, m, this.repo()));
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
      // P2-227: jobs and the phone, through the plugin's wk-job and wk-bridge
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
    } catch (e) {
      this.reply(false, `That did not work (${e && e.code ? e.code : 'error'}). Nothing was changed.`);
    }
  }
}

function activate(ctx) {
  const panel = new Panel(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW, panel),
    vscode.commands.registerCommand('watchkeeper.refresh', () => panel.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('watchkeeper')) panel.refresh(); }),
    ...(typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function' ? [vscode.workspace.onDidGrantWorkspaceTrust(() => panel.refresh())] : []),
    { dispose: () => panel.stop() },
  );
}
function deactivate() {}

module.exports = { activate, deactivate, Panel, RUNS, UNTRUSTED };
