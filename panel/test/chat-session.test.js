'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getGraphifyContext, readGraphifyStats } = require('../src/graphify-layer');
const { inferAutoMode, inferAutoTarget, parseStreamJsonLines, decideRoute, detectIntegrations, Orchestrator } = require('../src/reprompt-orchestrator');
const engine = require('../src/reprompt-engine');
const { createChatSession, getChatSession, listChatSessionSummaries, deleteChatSession } = require('../src/chat-sessions');
const D = require('../src/data');
const R = require('../src/render');

const prevSkipHookSync = process.env.REPROMPT_SKIP_HOOK_SYNC;
process.env.REPROMPT_SKIP_HOOK_SYNC = '1';
test.after(() => {
  if (prevSkipHookSync === undefined) delete process.env.REPROMPT_SKIP_HOOK_SYNC;
  else process.env.REPROMPT_SKIP_HOOK_SYNC = prevSkipHookSync;
});

test('graphify default layer bootstraps AST, computes 2-hop savings, and respects WK_GRAPHIFY_DEFAULT=0', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gf-'));
  const prevEnv = process.env.WK_GRAPHIFY_DEFAULT;
  try {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'auth.js'), 'export function verifyJwt(t) { return !!t; }\nexport function signJwt(u) { return u; }\n');
    fs.writeFileSync(path.join(ws, 'src', 'routes.js'), "import { verifyJwt } from './auth';\nexport function handleLogin(req) { return verifyJwt(req.tok); }\n");
    fs.writeFileSync(path.join(ws, 'src', 'billing.js'), '// unrelated module\n' + 'const pad = 1;\n'.repeat(200));
    fs.writeFileSync(path.join(ws, 'src', 'reports.js'), '// another unrelated module\n' + 'const r = 2;\n'.repeat(200));

    const gf = getGraphifyContext(ws, 'Fix verifyJwt in auth route', { autoBootstrap: true, allowWrite: true });
    assert.equal(gf.available, true);
    assert.ok(gf.totalNodes >= 4);
    assert.ok(gf.savedTokens > 0);
    assert.ok(gf.savedPct > 0);
    assert.match(gf.contextBlock, /Graphify 2-Hop Context/);
    assert.equal(fs.existsSync(path.join(ws, 'graphify-out', 'graph.json')), true);

    const st = readGraphifyStats(ws);
    assert.equal(st.available, true);

    process.env.WK_GRAPHIFY_DEFAULT = '0';
    const disabled = getGraphifyContext(ws, 'Fix verifyJwt', { autoBootstrap: true, allowWrite: false });
    assert.equal(disabled.available, false);
    assert.equal(disabled.mode, 'disabled');
  } finally {
    if (prevEnv === undefined) delete process.env.WK_GRAPHIFY_DEFAULT;
    else process.env.WK_GRAPHIFY_DEFAULT = prevEnv;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('auto mode, auto target, and mixed-model thinking stream parsing work seamlessly', async () => {
  assert.equal(inferAutoMode('Fix crash in auth handler'), 'bugfix');
  assert.equal(inferAutoMode('Refactor and clean up the parser module'), 'refactor');
  assert.equal(inferAutoMode('Architect a distributed zero-trust PostgreSQL migration pipeline from scratch'), 'spec');
  assert.equal(inferAutoMode('Give a concise summary of status'), 'concise');
  assert.equal(inferAutoMode('Update button color'), 'balanced');

  assert.equal(inferAutoTarget({ prompt: 'Run Claude Code /plugin check' }), 'claude');
  assert.equal(inferAutoTarget({ prompt: 'Open inside Antigravity sidecar' }), 'antigravity');
  assert.equal(inferAutoTarget({ prompt: 'Write tests', decision: { provider: 'claude' } }), 'claude');
  assert.equal(inferAutoTarget({ prompt: 'Write tests', decision: { provider: 'gemini' } }), 'antigravity');

  const ndjson = [
    JSON.stringify({ message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'Checking auth callers...' }, { type: 'tool_use', name: 'Read' }] } }),
    JSON.stringify({ type: 'result', result: 'Verified auth.js cleanly.' }),
  ].join('\n');
  const parsed = parseStreamJsonLines(ndjson, 'claude-default');
  assert.equal(parsed.model, 'claude-opus-5-5');
  assert.match(parsed.thinking, /Checking auth callers/);
  assert.deepEqual(parsed.tools, ['Read']);
  assert.equal(parsed.text, 'Verified auth.js cleanly.');

  const plain = parseStreamJsonLines('Plain text answer without JSON', 'gemini-4-hydrogen');
  assert.equal(plain.text, 'Plain text answer without JSON');
  assert.equal(plain.thinking, '');

  const agyNdjson = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-agy-123456', init: { model: 'gemini-pro-orchestrator', cwd: '/tmp/ws' } }),
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-agy-123456', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Part 1 ' } }),
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-agy-123456', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } } }),
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-agy-123456', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Part 2', usage: { input_tokens: 120, output_tokens: 45, thinking_tokens: 30, total_tokens: 165 } } }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'conv-agy-123456', status: 'SUCCESS', response: 'Part 1 Part 2', usage: { input_tokens: 120, output_tokens: 45, thinking_tokens: 30, total_tokens: 165 } } }),
  ].join('\n');
  const parsedAgy = parseStreamJsonLines(agyNdjson, 'gemini-pro-orchestrator');
  assert.equal(parsedAgy.model, 'gemini-pro-orchestrator');
  assert.equal(parsedAgy.conversation_id, 'conv-agy-123456');
  assert.equal(parsedAgy.text, 'Part 1 Part 2');
  assert.deepEqual(parsedAgy.tools, ['run_command']);
  assert.equal(parsedAgy.is_error, false);
  assert.equal(parsedAgy.usage.thinking_tokens, 30);

  const agyErrNdjson = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-err-1', init: { model: 'gemini-pro-orchestrator' } }),
    JSON.stringify({ event: 'result', result: { conversation_id: 'conv-err-1', status: 'ERROR', response: '', error: 'rate limit exceeded' } }),
  ].join('\n');
  const parsedAgyErr = parseStreamJsonLines(agyErrNdjson, 'gemini-pro-orchestrator');
  assert.equal(parsedAgyErr.is_error, true);
  assert.equal(parsedAgyErr.error, 'rate limit exceeded');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-orch-gf-'));
  try {
    fs.writeFileSync(path.join(ws, 'app.py'), 'def main():\n    return 1\n');
    let saved = null;
    const orch = new Orchestrator({
      loadState: () => saved,
      saveState: s => { saved = s; },
      executor: async ({ channel, model, onProgress }) => {
        if (onProgress) onProgress({ phase: 'thinking', provider: 'claude', model, thinking: 'Step thinking...', tools: ['Bash'] });
        return { text: `Done on ${channel}`, thinking: `Model ${model} reasoned carefully.`, tools: ['Bash'], input_tokens: 100, output_tokens: 50 };
      },
    });
    const events = [];
    const out = await orch.orchestrateWorkflow({
      task: 'Refactor app.py cleanly',
      workspaceDir: ws,
      trustedWorkspace: false,
      override_provider: 'claude',
      auto_skills: false,
      onProgress: e => events.push(e),
    });
    assert.ok(out.trace.some(t => t.step === 'graphify_token_saver'));
    assert.ok(out.trace.some(t => t.step === 'main_task' && /reasoned carefully/.test(t.thinking)));
    assert.ok(events.some(e => e.phase === 'thinking'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('readClaudeTranscript parses mixed models, thinking blocks, tools, workers, and rejects path traversal', () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-claude-'));
  try {
    const proj = path.join(claudeDir, 'projects', '-Users-x-proj');
    const subDir = path.join(proj, 'sess_abc123', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'Inspect Graphify hook' }, timestamp: '2026-11-22T10:00:00Z' }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-22T10:00:05Z',
        message: {
          model: 'claude-opus-5-5',
          content: [
            { type: 'thinking', thinking: 'Tracing hook execution path...' },
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'Found root cause in hook_bus.' },
          ],
        },
      }),
    ];
    fs.writeFileSync(path.join(proj, 'sess_abc123.jsonl'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(subDir, 'agent-scout1.meta.json'), JSON.stringify({ description: 'Scout files', model: 'gemini-4-hydrogen', effort: 'high', finished: true }));

    const tr = D.readClaudeTranscript(claudeDir, 'sess_abc123');
    assert.ok(tr);
    assert.equal(tr.turns.length, 2);
    assert.match(tr.turns[1].model, /Opus 5\.5/);
    assert.match(tr.turns[1].thinking, /Tracing hook execution/);
    assert.deepEqual(tr.turns[1].tools, ['Read']);
    assert.equal(tr.members.length, 1);
    assert.equal(D.readClaudeTranscript(claudeDir, '../etc/passwd'), null);
  } finally {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('watchkeeper chat session persistence and two-step Go confirmation render cleanly in Panel', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-chat-panel-'));
  const prevEnv = process.env.WK_GRAPHIFY_DEFAULT;
  try {
    const dataDir = path.join(base, 'wk');
    const claudeDir = path.join(base, 'claude');
    const pluginPath = path.join(base, 'plugin');
    const ws = path.join(base, 'repo');
    fs.mkdirSync(path.join(pluginPath, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pluginPath, 'config'), { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
    fs.writeFileSync(path.join(pluginPath, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(dataDir, 'KILL') } }));
    fs.writeFileSync(path.join(ws, 'index.js'), 'export function boot() { return true; }\n');

    const s = createChatSession(dataDir, { title: 'Test session', workspace: ws });
    assert.equal(listChatSessionSummaries(dataDir).length, 1);
    assert.equal(getChatSession(dataDir, s.id).id, s.id);
    assert.equal(deleteChatSession(dataDir, s.id), true);
    assert.equal(listChatSessionSummaries(dataDir).length, 0);

    // Test extension Panel chatDraft -> awaiting_confirm -> chatConfirm ("Go") with fake vscode
    const load = Module._load;
    const posted = [];
    const cfg = { pluginPath, dataDir, claudeDir, orchestrationDir: '' };
    const fakeVscode = {
      Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: ws } }],
        getConfiguration: () => ({ get: k => cfg[k] }),
        onDidChangeConfiguration: () => ({ dispose() { } }),
      },
      window: {
        registerWebviewViewProvider: () => ({ dispose() { } }),
        createWebviewPanel: (_id, _title) => ({
          visible: true,
          webview: { cspSource: 'vscode-resource:', options: {}, html: '', asWebviewUri: u => u, postMessage: m => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: fn => { fakeVscode._msg = fn; return { dispose() { } }; } },
          onDidDispose: () => ({ dispose() { } }),
          onDidChangeViewState: () => ({ dispose() { } }),
          reveal() { },
        }),
      },
      commands: { registerCommand: () => ({ dispose() { } }), getCommands: async () => [], executeCommand: async () => { } },
    };
    Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
    let panel = null;
    let rp = null;
    try {
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      const ext = require('../extension.js');
      rp = ext.activateRePrompt({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
      rp.orchestrator._executor = async ({ model }) => ({
        text: 'Executed cleanly!',
        thinking: `Simulated thinking on ${model}`,
        tools: ['Read'],
        input_tokens: 80,
        output_tokens: 40,
      });
      panel = new ext.Panel({ extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] }, rp);
      await panel.openWorkspace({ maximize: false });
      await panel.onMessage({
        cmd: 'chatDraft',
        prompt: 'Fix boot error in index.js',
        target: 'auto',
        mode: 'auto',
        route: 'auto',
        confirmBeforeGo: true,
        autoReprompt: true,
      });

      const summaries = listChatSessionSummaries(dataDir);
      assert.equal(summaries.length, 1);
      const sess = getChatSession(dataDir, summaries[0].id);
      assert.equal(sess.turns[0].status, 'awaiting_confirm');
      assert.equal(sess.turns[0].autoMode, 'bugfix');
      assert.equal(sess.turns[0].graphify.available, true);

      const confirmMsg = [...posted].reverse().find(m => m.type === 'chatState' && /Go →/.test(m.chatHtml));
      assert.ok(confirmMsg, 'Confirmation card renders Go button before running');

      await panel.onMessage({
        cmd: 'chatConfirm',
        sessionId: sess.id,
        turnId: sess.turns[0].id,
        repromptedText: 'Confirmed specification for boot fix',
        target: 'claude',
        mode: 'bugfix',
        route: 'claude',
      });

      const updated = getChatSession(dataDir, sess.id);
      assert.equal(updated.turns[0].status, 'done');
      assert.match(updated.turns[0].answer, /Executed cleanly/);
      assert.ok(updated.turns[0].steps.some(st => st.phase === 'main_task' && /Simulated thinking/.test(st.thinking)));

      const rendered = R.renderChatThread({ activeSession: updated, confirmBeforeGo: true, untrusted: false });
      assert.match(rendered, /Thinking process/);
      assert.match(rendered, /Graphify/);

      fakeVscode.workspace.isTrusted = false;
      await panel.onMessage({ cmd: 'chatDraft', prompt: 'Should refuse when untrusted', confirmBeforeGo: true });
      assert.ok(posted.some(m => m.type === 'result' && !m.ok && /not trusted/.test(m.text)));
    } finally {
      if (panel) panel.stop();
      if (rp && typeof rp.dispose === 'function') rp.dispose();
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      Module._load = load;
    }
  } finally {
    if (prevEnv === undefined) delete process.env.WK_GRAPHIFY_DEFAULT;
    else process.env.WK_GRAPHIFY_DEFAULT = prevEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Orchestrator Carbon priority, parallel Antigravity IDE sync, workspaceDir, and conversation persistence', async () => {
  assert.equal(engine.DEFAULT_SETTINGS.agyModel, 'gemini-pro-orchestrator');
  const integDetected = detectIntegrations({});
  assert.equal(integDetected.gemini.channels[0].id, 'agy_gemini');

  const dualInteg = {
    overall_status: 'dual_ready',
    gemini: { available: true, primary_channel: 'agy_gemini', channels: [{ id: 'agy_gemini', available: true }] },
    claude: { available: true, primary_channel: 'agy_claude', channels: [{ id: 'agy_claude', available: true }] },
  };
  const lightDec = decideRoute({
    task: 'Rename helper variable and add a unit test',
    integrations: dualInteg,
    ledgerState: {
      date: new Date().toISOString().slice(0, 10),
      providers: {
        gemini: { tokens_used: 2000000, spend_usd: 5.0, requests: 10, rate_limit_hits: 0, cooldown_until: 0, recent_window: [] },
        claude: { tokens_used: 1000, spend_usd: 0.01, requests: 1, rate_limit_hits: 0, cooldown_until: 0, recent_window: [] },
      },
    },
  });
  assert.equal(lightDec.provider, 'gemini');
  assert.equal(lightDec.model, 'gemini-pro-orchestrator');
  assert.equal(lightDec.effort, null);
  assert.equal(lightDec.reason_code, 'orchestrator_carbon_priority');
  assert.equal(inferAutoTarget({ prompt: 'Run quick check', integrations: dualInteg }), 'antigravity');

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-agy-sync-')));
  const prevEnv = process.env.WK_GRAPHIFY_DEFAULT;
  // canon: agy only as a stub inside a temporary HOME, on a restricted PATH
  const prevHome = process.env.HOME;
  const prevPathEnv = process.env.PATH;
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'bin', 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // S14 (P2-272): agy is never a channel now, so the Gemini lane is made available by a stub `gemini` CLI.
  // The executor below is stubbed, so neither stub runs.
  fs.writeFileSync(path.join(base, 'bin', 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.HOME = base;
  process.env.PATH = `${path.join(base, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const dataDir = path.join(base, 'wk');
    const claudeDir = path.join(base, 'claude');
    const pluginPath = path.join(base, 'plugin');
    const ws = path.join(base, 'repo');
    fs.mkdirSync(path.join(pluginPath, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pluginPath, 'config'), { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
    fs.writeFileSync(path.join(pluginPath, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(dataDir, 'KILL') } }));
    fs.writeFileSync(path.join(ws, 'app.js'), 'export const ok = true;\n');

    const load = Module._load;
    const posted = [];
    const executedCmds = [];
    const clipboardWrites = [];
    const cfg = { pluginPath, dataDir, claudeDir, orchestrationDir: '' };
    const fakeVscode = {
      Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: ws } }],
        getConfiguration: () => ({ get: k => cfg[k] }),
        onDidChangeConfiguration: () => ({ dispose() { } }),
      },
      window: {
        registerWebviewViewProvider: () => ({ dispose() { } }),
        setStatusBarMessage: () => ({ dispose() { } }),
        createWebviewPanel: (_id, _title) => ({
          visible: true,
          webview: { cspSource: 'vscode-resource:', options: {}, html: '', asWebviewUri: u => u, postMessage: m => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() { } }) },
          onDidDispose: () => ({ dispose() { } }),
          onDidChangeViewState: () => ({ dispose() { } }),
          reveal() { },
        }),
      },
      commands: {
        registerCommand: () => ({ dispose() { } }),
        getCommands: async () => ['antigravity.panel.focus', 'antigravity.toggleChatFocus', 'antigravity.startNewConversation'],
        executeCommand: async (cmd, ...args) => { executedCmds.push([cmd, ...args]); },
      },
      env: { clipboard: { writeText: async (txt) => { clipboardWrites.push(txt); } } },
    };
    Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
    let panel = null;
    let rp = null;
    try {
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      const ext = require('../extension.js');
      rp = ext.activateRePrompt({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
      const execCalls = [];
      rp.orchestrator._executor = async ({ provider, model, workspaceDir, conversationId }) => {
        execCalls.push({ provider, model, workspaceDir, conversationId });
        return {
          text: `Executed on ${model}`,
          thinking: 'Analyzed workspace files.',
          tools: [],
          model,
          conversation_id: 'agy-conv-abc12345',
          input_tokens: 60,
          output_tokens: 20,
        };
      };
      panel = new ext.Panel({ extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] }, rp);
      await panel.openWorkspace({ maximize: false });

      await panel.onMessage({
        cmd: 'chatDraft',
        prompt: 'raw: Check app.js health',
        target: 'auto',
        mode: 'auto',
        route: 'auto',
        confirmBeforeGo: false,
        syncToIde: true,
        autoReprompt: false,
      });

      const summaries = listChatSessionSummaries(dataDir);
      assert.equal(summaries.length, 1);
      const sess = getChatSession(dataDir, summaries[0].id);
      assert.equal(sess.agyConversationId, 'agy-conv-abc12345');
      assert.equal(sess.turns[0].autoTarget, 'antigravity');
      assert.equal(sess.turns[0].status, 'done');
      assert.equal(execCalls[0].workspaceDir, ws);
      assert.equal(execCalls[0].conversationId, '');
      assert.ok(clipboardWrites.some(t => /Check app\.js health/.test(t)));
      assert.ok(executedCmds.some(([c]) => c === 'antigravity.panel.focus'));
      assert.ok(executedCmds.some(([c, a]) => c === 'antigravity.toggleChatFocus' && a === 'focus'));
      assert.ok(sess.turns[0].steps.some(st => st.phase === 'ide_sync' && st.status === 'done'));

      // Second turn with confirmBeforeGo: true + chatConfirm reuses agyConversationId and runs parallel IDE sync
      const cmdsBefore = executedCmds.length;
      await panel.onMessage({
        cmd: 'chatDraft',
        sessionId: sess.id,
        prompt: 'Follow up on app.js',
        target: 'auto',
        mode: 'auto',
        route: 'auto',
        confirmBeforeGo: true,
        syncToIde: true,
        autoReprompt: false,
      });
      const sessMid = getChatSession(dataDir, sess.id);
      assert.equal(sessMid.turns[1].status, 'awaiting_confirm');
      assert.equal(sessMid.turns[1].autoTarget, 'antigravity');
      assert.equal(sessMid.turns[1].chosenTarget, 'antigravity');
      await panel.onMessage({
        cmd: 'chatConfirm',
        sessionId: sess.id,
        turnId: sessMid.turns[1].id,
        repromptedText: 'Confirmed follow up on app.js',
        target: 'auto',
        mode: 'auto',
        route: 'auto',
      });
      assert.equal(execCalls[1].conversationId, 'agy-conv-abc12345');
      assert.ok(executedCmds.slice(cmdsBefore).some(([c]) => c === 'antigravity.panel.focus'));
      assert.ok(executedCmds.slice(cmdsBefore).some(([c, a]) => c === 'antigravity.toggleChatFocus' && a === 'focus'));

      const newSessRes = await rp.sendToAntigravityNewSession('Fresh prompt');
      assert.equal(newSessRes.focused, true);
      assert.equal(newSessRes.newSession, true);
      assert.ok(executedCmds.some(([c]) => c === 'antigravity.startNewConversation'));
    } finally {
      if (panel) panel.stop();
      if (rp && typeof rp.dispose === 'function') rp.dispose();
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      Module._load = load;
    }
  } finally {
    process.env.HOME = prevHome; process.env.PATH = prevPathEnv;
    if (prevEnv === undefined) delete process.env.WK_GRAPHIFY_DEFAULT;
    else process.env.WK_GRAPHIFY_DEFAULT = prevEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('/wk-take-task in simulated session, auto-take on refresh, bidirectional Claude <-> Antigravity handover, and wk-takeover CLI', async () => {
  const { execFileSync } = require('child_process');
  const { readSharedWorkspace } = require('../src/task-handover');
  const pluginSrc = path.resolve(__dirname, '..', '..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-takeover-e2e-'));
  const prevWkHome = process.env.WK_HOME;
  try {
    const repo = path.join(base, 'repo');
    const dataDir = path.join(base, 'wk');
    const claudeDir = path.join(base, 'claude');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'projects', '-tmp-repo'), { recursive: true });

    const gitCmd = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    gitCmd(repo, ['init']);
    gitCmd(repo, ['config', 'user.name', 'Test']);
    gitCmd(repo, ['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(repo, 'app.js'), 'exports.val = 1;\n');
    gitCmd(repo, ['add', 'app.js']);
    gitCmd(repo, ['commit', '-m', 'init']);

    process.env.WK_HOME = dataDir;
    const wkTaskBin = path.join(pluginSrc, 'bin', 'wk-task.mjs');
    const task1Id = execFileSync(
      process.execPath,
      [wkTaskBin, 'add', '--repo', repo, '--title', 'Update app val', '--text', 'Change app.js val from 1 to 2', '--test', 'node -e "process.exit(require(\'./app.js\').val === 2 ? 0 : 1)"', '--from', 'claude'],
      { env: { ...process.env, WK_HOME: dataDir }, encoding: 'utf8' }
    ).trim();

    // Seed a Claude session for seamless Claude -> Antigravity takeover
    const claudeSessFile = path.join(claudeDir, 'projects', '-tmp-repo', 'sess_shared_01.jsonl');
    fs.writeFileSync(claudeSessFile, [
      JSON.stringify({ type: 'user', cwd: repo, timestamp: new Date().toISOString(), message: { content: 'Add feature X in shared repo' } }),
      JSON.stringify({ type: 'assistant', cwd: repo, timestamp: new Date().toISOString(), message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Reviewed app.js in shared repo.' }] } }),
    ].join('\n') + '\n');

    const load = Module._load;
    const posted = [];
    const cfg = { pluginPath: pluginSrc, dataDir, claudeDir, orchestrationDir: '' };
    const fakeVscode = {
      Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: repo } }],
        getConfiguration: () => ({ get: k => cfg[k] }),
        onDidChangeConfiguration: () => ({ dispose() { } }),
      },
      window: {
        registerWebviewViewProvider: () => ({ dispose() { } }),
        createWebviewPanel: () => ({
          visible: true,
          webview: { cspSource: 'vscode-resource:', options: {}, html: '', asWebviewUri: u => u, postMessage: m => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() { } }) },
          onDidDispose: () => ({ dispose() { } }),
          onDidChangeViewState: () => ({ dispose() { } }),
          reveal() { },
        }),
      },
      commands: { registerCommand: () => ({ dispose() { } }), getCommands: async () => [], executeCommand: async () => { } },
      env: { clipboard: { writeText: async () => { } } },
    };
    Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
    let panel = null;
    let rp = null;
    try {
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      const ext = require('../extension.js');
      rp = ext.activateRePrompt({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
      rp.orchestrator._executor = async ({ model, workspaceDir, prompt }) => {
        if (/Update app val/.test(prompt) && workspaceDir && fs.existsSync(path.join(workspaceDir, 'app.js'))) {
          fs.writeFileSync(path.join(workspaceDir, 'app.js'), 'exports.val = 2;\n');
        }
        return { text: `Done cleanly in ${workspaceDir}`, model, input_tokens: 40, output_tokens: 20 };
      };
      panel = new ext.Panel({ extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] }, rp);
      panel.autoTakeTasks = false;
      await panel.openWorkspace({ maximize: false });

      // 1. Typing /wk-take-task in simulated session claims task1, edits worktree, and runs wk-task done automatically
      await panel.onMessage({ cmd: 'chatDraft', prompt: '/wk-take-task' });
      const taskMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks', task1Id, 'meta.json'), 'utf8'));
      assert.equal(taskMeta.status, 'verified');
      const taskSess = getChatSession(dataDir, listChatSessionSummaries(dataDir)[0].id);
      assert.equal(taskSess.taskId, task1Id);
      assert.ok(taskSess.turns[0].steps.some(st => st.phase === 'wk_task_done' && st.status === 'done'));

      // 2. Add task2 and verify auto-take triggers on refresh()
      const task2Id = execFileSync(
        process.execPath,
        [wkTaskBin, 'add', '--repo', repo, '--title', 'Update app val auto', '--text', 'Update val to 2 automatically', '--test', 'node -e "process.exit(require(\'./app.js\').val === 2 ? 0 : 1)"', '--from', 'claude'],
        { env: { ...process.env, WK_HOME: dataDir }, encoding: 'utf8' }
      ).trim();
      // Note executor checks /Update app val/, which matches 'Update app val auto' too
      panel.autoTakeTasks = true;
      await panel.refresh();
      for (let i = 0; i < 40; i += 1) {
        const m2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks', task2Id, 'meta.json'), 'utf8'));
        if (m2.status === 'verified') break;
        await new Promise(r => setTimeout(r, 50));
      }
      const task2Meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks', task2Id, 'meta.json'), 'utf8'));
      assert.equal(task2Meta.status, 'verified');

      // 3. Claude -> Antigravity seamless shared-workspace takeover
      panel.autoTakeTasks = false;
      await panel.onMessage({ cmd: 'chatContinueFromClaude', sessionId: 'sess_shared_01' });
      const sumAfterTakeover = listChatSessionSummaries(dataDir);
      const claudeTakeSess = getChatSession(dataDir, sumAfterTakeover.find(s => s.claudeSessionId === 'sess_shared_01').id);
      assert.equal(fs.realpathSync(claudeTakeSess.workspace), fs.realpathSync(repo));
      assert.equal(claudeTakeSess.turns[1].status, 'done');

      // 4. Antigravity -> Claude handoff writes shared-workspace.json + handoff/*.md
      await panel.onMessage({ cmd: 'chatHandoffToClaude', sessionId: claudeTakeSess.id, note: 'Verify final endpoints' });
      const shared = readSharedWorkspace(dataDir, repo);
      assert.ok(shared);
      assert.equal(shared.from_engine, 'antigravity');
      assert.equal(shared.to_engine, 'claude');
      assert.ok(fs.existsSync(shared.handoff_file));
      assert.match(fs.readFileSync(shared.handoff_file, 'utf8'), /WK-HANDOFF-END\s*$/);

      // 5. wk-takeover.mjs CLI reads & consumes the handoff for Claude Code seamlessly
      const cliOut = execFileSync(
        process.execPath,
        [path.join(pluginSrc, 'bin', 'wk-takeover.mjs'), 'brief', '--cwd', repo, '--engine', 'claude', '--consume', '--json'],
        { env: { ...process.env, WK_HOME: dataDir, WK_CLAUDE_DIR: claudeDir }, encoding: 'utf8' }
      );
      const parsedCli = JSON.parse(cliOut.trim());
      assert.equal(parsedCli.ok, true);
      assert.equal(parsedCli.kind, 'handoff');
      assert.match(parsedCli.brief, /Verify final endpoints/);
      const sharedConsumed = readSharedWorkspace(dataDir, repo);
      assert.equal(sharedConsumed.consumed_by, 'claude');
    } finally {
      if (panel) panel.stop();
      if (rp && typeof rp.dispose === 'function') rp.dispose();
      delete require.cache[require.resolve('../src/reprompt-controller.js')];
      delete require.cache[require.resolve('../extension.js')];
      Module._load = load;
    }
  } finally {
    if (prevWkHome === undefined) delete process.env.WK_HOME;
    else process.env.WK_HOME = prevWkHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
