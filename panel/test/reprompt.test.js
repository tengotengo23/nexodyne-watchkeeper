'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createdViews = [];
const registeredProviders = {};
const registeredCommands = {};
const errorMessages = [];
const openedDocs = [];

const fakeVscode = {
  Uri: {
    file: f => ({ fsPath: f }),
    joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString: () => 'vscode-resource:' + path.join(u.fsPath, ...p) }),
  },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Active: 1, Beside: 2 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: () => '' }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    asRelativePath: (u) => path.basename(u?.fsPath || ''),
    openTextDocument: async (d) => { openedDocs.push(d); return d; },
  },
  window: {
    registerWebviewViewProvider: (id, p) => { registeredProviders[id] = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async (msg) => { errorMessages.push(msg); return undefined; },
    showTextDocument: async () => ({}),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    terminals: [],
  },
  commands: {
    registerCommand: (id, fn) => { registeredCommands[id] = fn; return { dispose() {} }; },
    executeCommand: async () => undefined,
    getCommands: async () => [],
  },
  env: { clipboard: { writeText: async () => {} } },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? fakeVscode : origLoad.call(this, req, ...rest);
};
const ext = require('../extension.js');

function fakeWebviewView() {
  const posted = [];
  let onMsg = null;
  const webview = {
    cspSource: 'vscode-resource:',
    options: null,
    html: '',
    postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
  };
  const view = {
    webview,
    posted,
    onDidDispose: () => ({ dispose() {} }),
    request: async (id, method, params = {}) => {
      await onMsg({ type: 'request', id, method, params });
      return posted.find((m) => m.type === 'response' && m.id === id);
    },
  };
  createdViews.push(view);
  return view;
}

test('Re-Prompt module activates alongside Watchkeeper panel, registers views/commands, and guards untrusted folders', async () => {
  const hookTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-hook-sync-'));
  const syncedSettingsPath = path.join(hookTmpDir, 'settings.json');
  const prevSyncPaths = process.env.REPROMPT_HOOK_SETTINGS_PATHS;
  process.env.REPROMPT_HOOK_SETTINGS_PATHS = syncedSettingsPath;

  const ctx = { extensionPath: path.join(__dirname, '..'), subscriptions: [] };
  ext.activate(ctx);

  assert.ok(registeredProviders['watchkeeper.panel'], 'Watchkeeper panel registered');
  assert.ok(registeredProviders['reprompt.sidebarView'], 'Re-Prompt sidebar view registered');
  assert.ok(registeredProviders['reprompt.composerView'], 'Re-Prompt composer view registered');
  for (const cmd of [
    'watchkeeper.refresh',
    'watchkeeper.openWorkspace',
    'watchkeeper.maximizeWorkspace',
    'reprompt.openOverlay',
    'reprompt.openWindow',
    'reprompt.popOutWindow',
    'reprompt.orchestrateTask',
    'reprompt.orchestratorStatus',
    'reprompt.quickOverlay',
    'reprompt.focusView',
    'reprompt.rewriteSelection',
  ]) {
    assert.equal(typeof registeredCommands[cmd], 'function', `command ${cmd} registered`);
  }

  const wv = fakeWebviewView();
  registeredProviders['reprompt.composerView'].resolveWebviewView(wv);
  assert.match(wv.webview.html, /default-src 'none'/);

  // Switch provider to offline_template for deterministic test and verify hook disk sync
  const saveRes = await wv.request(1, 'saveSettings', { provider: 'offline_template', hookAutoAll: true });
  assert.equal(saveRes.error, null);
  assert.equal(saveRes.result.settings.provider, 'offline_template');
  assert.equal(saveRes.result.settings.hookAutoAll, true);
  assert.equal(fs.existsSync(syncedSettingsPath), true, 'saveSettings syncs hook settings to disk');
  const syncedDisk = JSON.parse(fs.readFileSync(syncedSettingsPath, 'utf8'));
  assert.equal(syncedDisk.hookAutoAll, true);
  assert.equal(syncedDisk.provider, 'offline_template');

  const rewriteRes = await wv.request(2, 'rewrite', { prompt: 'harden login endpoint', target: 'claude_code', mode: 'balanced' });
  assert.equal(rewriteRes.error, null);
  assert.match(rewriteRes.result.rewritten_prompt, /## Goal/i);

  const previewRes = await wv.request(3, 'orchestratorPreview', { task: 'summarize logs' });
  assert.equal(previewRes.error, null);
  assert.ok('provider' in previewRes.result);

  const vaultRes = await wv.request(31, 'vaultList', { query: '', limit: 10 });
  assert.equal(vaultRes.error, null);
  assert.ok('total' in vaultRes.result);
  assert.ok(Array.isArray(vaultRes.result.items));

  const { decideRoute } = require('../src/reprompt-orchestrator');
  const dualInteg = {
    overall_status: 'dual_ready',
    gemini: { available: true, primary_channel: 'agy_gemini', channels: [{ id: 'agy_gemini', available: true }] },
    claude: { available: true, primary_channel: 'agy_claude', channels: [{ id: 'agy_claude', available: true }] },
  };
  const carbonDec = decideRoute({
    task: 'Architect a distributed lock-free concurrency engine and verify safety proofs across partitions',
    role: 'execution',
    integrations: dualInteg,
    watchkeeperPace: { available: true, seven_day_utilization: 0.99, claude_limit_exhausted: true, status: 'rejected' },
  });
  assert.equal(carbonDec.provider, 'gemini');
  assert.equal(carbonDec.model, 'gemini-4-carbon-high');
  assert.equal(carbonDec.effort, 'high');
  assert.equal(carbonDec.carbon_high_failover, true);

  const forcedDec = decideRoute({
    task: 'Simple rename helper',
    integrations: dualInteg,
    forceCarbon: true,
  });
  assert.equal(forcedDec.provider, 'gemini');
  assert.equal(forcedDec.model, 'gemini-4-carbon-high');
  assert.equal(forcedDec.effort, 'high');

  const routineDec = decideRoute({
    task: 'Simple rename helper',
    integrations: dualInteg,
  });
  assert.equal(routineDec.provider, 'gemini');
  assert.equal(routineDec.model, 'gemini-pro-orchestrator');
  assert.equal(routineDec.effort, null);

  // Untrusted workspace blocks provider/CLI execution cleanly
  fakeVscode.workspace.isTrusted = false;
  try {
    const blockedRewrite = await wv.request(4, 'rewrite', { prompt: 'should refuse' });
    assert.match(blockedRewrite.error, /not trusted/i);

    const blockedModels = await wv.request(5, 'listModels', {});
    assert.match(blockedModels.error, /not trusted/i);

    const blockedRun = await wv.request(6, 'orchestratorRun', { task: 'run external', dry_run: false });
    assert.match(blockedRun.error, /not trusted/i);

    // dry_run preview still permitted (no external execution)
    const dryOk = await wv.request(7, 'orchestratorRun', { task: 'preview only', dry_run: true });
    assert.equal(dryOk.error, null);

    await registeredCommands['reprompt.orchestrateTask']();
    assert.ok(errorMessages.some((m) => /not trusted/i.test(m)), 'orchestrateTask command refuses when untrusted');
  } finally {
    fakeVscode.workspace.isTrusted = true;
    for (const d of ctx.subscriptions) d.dispose && d.dispose();
    if (prevSyncPaths === undefined) delete process.env.REPROMPT_HOOK_SETTINGS_PATHS;
    else process.env.REPROMPT_HOOK_SETTINGS_PATHS = prevSyncPaths;
    fs.rmSync(hookTmpDir, { recursive: true, force: true });
  }
});
