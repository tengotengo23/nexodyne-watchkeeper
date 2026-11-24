'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const D = require('../src/data');
const R = require('../src/render');
const repromptEngine = require('../src/reprompt-engine');
const { Orchestrator } = require('../src/reprompt-orchestrator');
const handover = require('../src/task-handover');
const learningBridge = require('../src/learning-bridge');
const watchdogBridge = require('../src/watchdog-bridge');

function withFakeVscode(run) {
  const origLoad = Module._load;
  const gMap = new Map();
  const fakeVscode = {
    ViewColumn: { One: 1 },
    Uri: { file: p => ({ fsPath: p }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath || ROOT, ...p) }) },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {}, getCommands: async () => [] },
    window: {
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showWarningMessage: async () => 'Allow wake-ups',
      showInformationMessage: async () => {},
    },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return fakeVscode;
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    return run({ fakeVscode, gMap });
  } finally {
    Module._load = origLoad;
  }
}

function mkTmp(prefix = 'wk-panel-audit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('panel package.json preferredLocation includes studio', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const locs = pkg.contributes.configuration.properties['watchkeeper.preferredLocation'].enum;
  assert.ok(locs.includes('studio'));
});

// Canon: agy is never run from Claude. These tests use a stub agy inside a temporary HOME and a PATH without the real one.
function agyStubEnv() {
  const home = fs.realpathSync(mkTmp('wk-agy-home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(home, 'agy-calls.log');
  fs.writeFileSync(path.join(bin, 'agy'),
    '#!/bin/sh\necho "call" >> "' + log + '"\nprintf "## Goal\\nFix the validation handler cleanly.\\n## Verification\\nRun the tests.\\n"\n', { mode: 0o755 });
  const saved = {};
  const set = { HOME: home, PATH: bin + path.delimiter + '/usr/bin' + path.delimiter + '/bin', WK_HOME: path.join(home, 'wk') };
  for (const k of Object.keys(set)) saved[k] = process.env[k];
  Object.assign(process.env, set);
  return { home, bin, log, restore() { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}
const callLines = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

test('reprompt-engine exposes auto provider and resolves without throwing Unsupported provider; a stub agy in a temporary HOME (IDE context) is never run (S14)', async () => {
  const env = agyStubEnv();
  const keys = ['CLAUDECODE', 'WK_CALLER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    assert.equal(repromptEngine.findAgyBinary(), null, 'agy is never handed out, even outside Claude Code');
    const statuses = repromptEngine.getProviderStatuses();
    assert.equal(statuses[0].id, 'auto');
    assert.equal(statuses[0].available, true);
    assert.notEqual(repromptEngine.resolveAutoProvider({}), 'agy');

    const res = await repromptEngine.rewriteWithProvider({
      settings: { provider: 'auto', defaultTarget: 'antigravity', defaultMode: 'balanced' },
      secrets: {},
      prompt: 'Fix the failing validation handler cleanly.',
    });
    assert.ok(res && typeof res.rewritten_prompt === 'string' && res.rewritten_prompt.length > 0);
    assert.notEqual(res.provider, 'auto');
    assert.notEqual(res.provider, 'agy');
    assert.equal(callLines(env.log).length, 0, 'the stub never ran');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    env.restore();
  }
});

test('canon: with CLAUDECODE=1 and the real HOME, a stub agy on PATH is refused and auto never picks agy', async () => {
  const stubDir = fs.realpathSync(mkTmp('wk-agy-realhome-'));
  const log = path.join(stubDir, 'agy-calls.log');
  fs.writeFileSync(path.join(stubDir, 'agy'), '#!/bin/sh\necho call >> "' + log + '"\necho hi\n', { mode: 0o755 });
  const keys = ['CLAUDECODE', 'WK_CALLER', 'PATH'], saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.CLAUDECODE = '1'; delete process.env.WK_CALLER;
  process.env.PATH = stubDir + path.delimiter + '/usr/bin' + path.delimiter + '/bin';
  try {
    assert.equal(repromptEngine.agyBlockedForClaude(path.join(stubDir, 'agy')), true);
    assert.equal(repromptEngine.findAgyBinary(), null);
    assert.notEqual(repromptEngine.getProviderStatuses().find(s => s.id === 'agy').available, true);
    assert.match(repromptEngine.getProviderStatuses().find(s => s.id === 'agy').detail, /does not run Antigravity's agent/);
    assert.notEqual(repromptEngine.resolveAutoProvider({}), 'agy');
    assert.deepEqual(await repromptEngine.listAgyModels(), []);
    await assert.rejects(repromptEngine.rewriteWithProvider({ settings: { provider: 'agy' }, secrets: {}, prompt: 'x' }), /does not run Antigravity's agent/);
    process.env.WK_CALLER = 'claude_code';
    assert.equal(repromptEngine.agyBlockedForClaude(null), true);
    assert.equal(callLines(log).length, 0, 'the stub never ran');
  } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test('bridges expand tilde in resolveWkHome cleanly', () => {
  const expected = path.join(os.homedir(), 'custom-wk-audit');
  assert.equal(learningBridge.resolveWkHome('~/custom-wk-audit'), expected);
  assert.equal(watchdogBridge.resolveWkHome('~/custom-wk-audit'), expected);
});

test('reprompt-controller manages real session skills and exposes normalized vault fields', async () => {
  const dir = mkTmp('wk-ctrl-');
  const savedHome = process.env.WK_HOME;
  const savedVault = process.env.REPROMPT_SKILL_VAULT_DIR;
  await withFakeVscode(async ({ gMap }) => {
    delete require.cache[require.resolve('../src/reprompt-controller')];
    const { RePromptController } = require('../src/reprompt-controller');
    try {
      process.env.WK_HOME = path.join(dir, 'wk');
      process.env.REPROMPT_SKILL_VAULT_DIR = path.join(dir, 'vault');
      fs.mkdirSync(process.env.REPROMPT_SKILL_VAULT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.REPROMPT_SKILL_VAULT_DIR, 'index.json'),
        JSON.stringify({
          skill_count: 1,
          repo_count: 1,
          cloned_repo_count: 1,
          skills: [{ id: 'sk-1', name: 'debug-skill', domain: 'engineering', repo: 'ex/r', slug: 'r', tier: 1, stars: 50 }],
        }),
      );
      // P2-272 B-fix (should-fix 3): the library fails closed, so the source must be approved in sources.json.
      fs.writeFileSync(
        path.join(process.env.REPROMPT_SKILL_VAULT_DIR, 'sources.json'),
        JSON.stringify({ version: 2, repos: [{ slug: 'r', repo: 'ex/r', url: 'https://github.com/ex/r', approved: true, status: 'approved' }] }),
      );

      const fakeState = { get: (k, d) => (gMap.has(k) ? gMap.get(k) : d), update: async (k, v) => gMap.set(k, v) };
      const fakeSecrets = { get: async () => '', store: async () => {}, delete: async () => {} };
      const ctrl = new RePromptController({ globalState: fakeState, secrets: fakeSecrets, extensionUri: { fsPath: ROOT } });

      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const webview = {
          postMessage: (m) => {
            if (m && m.type === 'response' && m.id === id) {
              if (m.error) reject(new Error(m.error));
              else resolve(m.result);
            }
          },
        };
        ctrl.handleWebviewMessage(webview, { type: 'request', id, method, params });
      });

      const loaded = await rpc('loadSkill', { session_id: 's1', skill_id: 'sk-1' });
      assert.equal(loaded.session.loaded_skills.length, 1);

      const removed = await rpc('removeSkill', { session_id: 's1', skill_id: 'sk-1' });
      assert.equal(removed.session.loaded_skills.length, 0);

      await rpc('loadSkill', { session_id: 's1', skill: { id: 'sk-2', name: 'sec', domain: 'security' } });
      const reset = await rpc('newSession', { session_id: 's1' });
      assert.equal(reset.session.loaded_skills.length, 0);

      const lib = D.readSkillLibrary(dir, process.env.WK_HOME, 50);
      assert.equal(lib.total, 1);
      assert.equal(lib.skill_count, 1);
      assert.equal(lib.repo_count, 1);
      assert.equal(lib.cloned_repo_count, 1);
    } finally {
      delete require.cache[require.resolve('../src/reprompt-controller')];
      if (savedHome === undefined) delete process.env.WK_HOME; else process.env.WK_HOME = savedHome;
      if (savedVault === undefined) delete process.env.REPROMPT_SKILL_VAULT_DIR; else process.env.REPROMPT_SKILL_VAULT_DIR = savedVault;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('reprompt-orchestrator preserves sessions on rollover & resetUsage and ignores empty compression', async () => {
  let stored = {
    date: '2020-01-01',
    providers: {},
    sessions: {
      'sess-x': { turn_count: 3, tokens_used: 4200, calls: 2, loaded_skills: [{ id: 's1' }] },
    },
  };
  const orch = new Orchestrator({
    dataDir: os.tmpdir(),
    loadState: () => stored,
    saveState: async (next) => { stored = next; },
  });
  const rolled = orch.loadLedger();
  assert.ok(rolled.sessions['sess-x']);
  assert.equal(rolled.sessions['sess-x'].tokens_used, 0);
  assert.equal(rolled.sessions['sess-x'].calls, 0);
  assert.equal(rolled.sessions['sess-x'].turn_count, 3);

  await orch.resetUsage();
  assert.ok(stored.sessions['sess-x']);
  assert.equal(stored.sessions['sess-x'].turn_count, 3);
});

test('data.js & render.js support >8k repromptCopy and local-only watchdog alert buttons', () => {
  const big = 'x'.repeat(12000);
  assert.equal(D.validateMessage({ cmd: 'repromptCopy', text: big }).ok, true);
  assert.equal(D.validateMessage({ cmd: 'repromptSend', text: big, target: 'antigravity' }).ok, false);
  assert.equal(D.validateMessage({ cmd: 'watchdogScan' }).ok, true);
  assert.equal(D.validateMessage({ cmd: 'watchdogRecover' }).ok, true);

  const model = {
    host: 'antigravity',
    now: Date.now(),
    jobs: [],
    watchdog: { hungCount: 1, warningCount: 0, items: [{ surface: 'task', id: 'T1', title: 'Stuck', classification: 'hung', reason: 'stale' }] },
  };
  const localHtml = R.renderJobs(model);
  assert.match(localHtml, /data-cmd="watchdogScan"/);
  assert.match(localHtml, /data-cmd="watchdogRecover"/);

  const remoteHtml = R.renderJobs({ ...model, host: 'remote' });
  assert.doesNotMatch(remoteHtml, /data-cmd="watchdogScan"/);
  assert.doesNotMatch(remoteHtml, /data-cmd="watchdogRecover"/);
});

test('task-handover publishSharedHandoff writes asked_at/why and leaves no stale lock', () => {
  const dir = mkTmp('wk-handover-panel-');
  const ws = path.join(dir, 'repo');
  const wk = path.join(dir, 'wk');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(wk, { recursive: true });
  try {
    const r = handover.publishSharedHandoff(wk, { workspace: ws, title: 'Panel Handoff', summary: 'Next step' });
    assert.ok(fs.existsSync(r.handoffFile));
    assert.ok(!fs.existsSync(path.join(wk, 'shared-workspace.lock')));
    const ptrDir = path.join(wk, 'handoff', 'sessions');
    const files = fs.readdirSync(ptrDir);
    assert.equal(files.length, 1);
    const ptr = JSON.parse(fs.readFileSync(path.join(ptrDir, files[0]), 'utf8'));
    assert.ok(ptr.asked_at);
    assert.equal(ptr.why, 'shared workspace handoff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension.js guards /wk-handoff-claude without session, double chatConfirm, and preserves chatSendToIde answer', async () => {
  const dir = mkTmp('wk-ext-audit-');
  const origLoad = Module._load;
  const gMap = new Map();
  const posted = [];
  const fakeVscode = {
    ViewColumn: { One: 1 },
    Uri: { file: p => ({ fsPath: p }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath || ROOT, ...p) }) },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: dir } }],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {}, getCommands: async () => [] },
    window: {
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showWarningMessage: async () => 'Allow wake-ups',
      showInformationMessage: async () => {},
    },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return fakeVscode;
    return origLoad.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    const ext = require('../extension');
    assert.ok(ext.RUNS.has('watchdogScan'));
    assert.ok(ext.RUNS.has('watchdogRecover'));

    const plugin = path.join(dir, 'plugin'), wk = path.join(dir, 'wk');
    fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'config'), { recursive: true });
    fs.mkdirSync(wk, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
    fs.writeFileSync(path.join(plugin, 'config', 'gates.json'), '{}');

    fakeVscode.workspace.getConfiguration = () => ({ get: k => ({ pluginPath: plugin, dataDir: wk }[k]) });
    const ctx = {
      extensionUri: { fsPath: ROOT },
      globalState: { get: (k, d) => (gMap.has(k) ? gMap.get(k) : d), update: async (k, v) => gMap.set(k, v) },
      secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
      subscriptions: [],
    };
    const panel = new ext.Panel(ctx, {
      sendToAntigravity: async () => ({ message: 'Dispatched cleanly' }),
      sendToClaudeCode: async () => ({ message: 'Sent to Claude' }),
    });
    panel.view = { visible: true, webview: { postMessage: m => posted.push(m) } };

    // 1. /wk-handoff-claude with no active session replies cleanly with error
    await panel.onMessage({ cmd: 'chatDraft', prompt: '/wk-handoff-claude' });
    const errHandoff = posted.filter(m => m.type === 'result' && !m.ok).at(-1);
    assert.match(errHandoff.text, /No active Watchkeeper chat session/);

    // 2. chatConfirm refuses already done turns & chatSendToIde preserves existing answer
    const { createChatSession, upsertTurn, getChatSession, makeTurnId } = require('../src/chat-sessions');
    const sess = createChatSession(wk, { title: 'Test', workspace: dir });
    const tidDone = makeTurnId();
    upsertTurn(wk, sess.id, {
      id: tidDone,
      createdAt: Date.now(),
      rawPrompt: 'hello',
      repromptedText: 'Compiled prompt',
      status: 'done',
      answer: 'Original computed answer',
      answerModel: 'gemini-4-carbon-high',
      answerProvider: 'gemini',
      chosenTarget: 'antigravity',
      steps: [],
    });

    await panel.onMessage({ cmd: 'chatConfirm', sessionId: sess.id, turnId: tidDone });
    const errDup = posted.filter(m => m.type === 'result' && !m.ok).at(-1);
    assert.match(errDup.text, /already done/);

    await panel.onMessage({ cmd: 'chatSendToIde', sessionId: sess.id, turnId: tidDone });
    const after = getChatSession(wk, sess.id).turns.find(t => t.id === tidDone);
    assert.equal(after.answer, 'Original computed answer');
    assert.equal(after.steps.some(s => s.id === 'ide_sync'), true);
  } finally {
    delete require.cache[require.resolve('../extension')];
    Module._load = origLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reprompt-orchestrator parses agy denied_actions/tool_errors, passes scoped MCP settings, recovers on --conversation, and migrates stale fastModel', async () => {
  const {
    AGY_HEADLESS_SETTINGS_JSON,
    defaultExecuteChannel,
    parseStreamJsonLines,
  } = require('../src/reprompt-orchestrator');

  // 1. parseStreamJsonLines captures denied_actions and tool_errors
  const deniedNdjson = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-denied-1234', init: { model: 'gemini-pro-orchestrator' } }),
    JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-denied-1234',
        step_index: 2,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: {
          name: 'call_mcp_tool',
          error: { type: 'TOOL_ERROR', message: 'permission check failed for mcp\nsecond line ignored' },
        },
      },
    }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-denied-1234',
        status: 'SUCCESS',
        response: '',
        denied_actions: [{ action: 'mcp', display_name: 'McpTool' }],
      },
    }),
  ].join('\n');
  const parsed = parseStreamJsonLines(deniedNdjson, 'gemini-pro-orchestrator');
  assert.equal(parsed.text, '');
  assert.equal(parsed.conversation_id, 'conv-denied-1234');
  assert.deepEqual(parsed.tools, ['call_mcp_tool']);
  assert.deepEqual(parsed.denied_actions, [{ action: 'mcp', display_name: 'McpTool' }]);
  assert.deepEqual(parsed.tool_errors, ['call_mcp_tool: permission check failed for mcp']);

  // 2. defaultExecuteChannel passes --settings (never --dangerously-skip-permissions) and recovers denied turns
  const tmpDir = fs.realpathSync(mkTmp('wk-agy-recover-'));
  const binDir = path.join(tmpDir, 'bin');
  const logFile = path.join(tmpDir, 'agy-calls.jsonl');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeAgy = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  fs.writeFileSync(
    fakeAgy,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
const convIdx = args.indexOf('--conversation');
const convId = convIdx !== -1 ? args[convIdx + 1] : '';
if (process.env.WK_TEST_AGY_MODE === 'unrecoverable') {
  console.log(JSON.stringify({ event: 'init', init: { model: 'gemini-pro-orchestrator' } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'run_command', display_name: 'RunCommand' }] } }));
  process.exit(0);
}
if (!convId) {
  console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-recover-1234', init: { model: 'gemini-pro-orchestrator' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-recover-1234', step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', error: { type: 'TOOL_ERROR', message: 'permission check failed' } } } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-recover-1234', status: 'SUCCESS', response: '', usage: { input_tokens: 100, output_tokens: 20 }, denied_actions: [{ action: 'mcp', display_name: 'McpTool' }] } }));
} else {
  console.log(JSON.stringify({ event: 'init', conversation_id: convId, init: { model: 'gemini-pro-orchestrator' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: convId, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Recovered full summary.' } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'Recovered full summary.', usage: { input_tokens: 150, output_tokens: 45 } } }));
}
`,
    { mode: 0o755 }
  );
  fs.chmodSync(fakeAgy, 0o755);

  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  const prevMode = process.env.WK_TEST_AGY_MODE;
  // canon: agy only as a stub inside a temporary HOME, on a restricted PATH
  process.env.HOME = tmpDir;
  process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    // S14 (P2-272): Watchkeeper never runs agy. The Gemini lane refuses, in the IDE and in Claude Code alike,
    // and the fake agy above never runs (its call log is never written).
    const prevCC = process.env.CLAUDECODE, prevCaller = process.env.WK_CALLER;
    try {
      for (const ctx of [{ CLAUDECODE: undefined, WK_CALLER: undefined }, { CLAUDECODE: '1', WK_CALLER: undefined }]) {
        for (const k of Object.keys(ctx)) { if (ctx[k] === undefined) delete process.env[k]; else process.env[k] = ctx[k]; }
        for (const mode of [undefined, 'unrecoverable']) {
          if (mode === undefined) delete process.env.WK_TEST_AGY_MODE; else process.env.WK_TEST_AGY_MODE = mode;
          for (const channel of ['agy_gemini', 'agy_claude']) {
            // P2-272 4B: the lane now queues a wk-task instead of refusing; tmpDir is not a git repo, so it queues nothing and says so.
            const res = await defaultExecuteChannel({
              channel,
              model: 'gemini-pro-orchestrator',
              prompt: 'Audit status',
              workspaceDir: tmpDir,
              onProgress: () => {},
            });
            assert.equal(res.queued_task, null);
            assert.match(res.text, /is not a git repository, so Antigravity has nothing to take\. Nothing was run\./);
          }
        }
      }
    } finally {
      if (prevCC === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prevCC;
      if (prevCaller === undefined) delete process.env.WK_CALLER; else process.env.WK_CALLER = prevCaller;
    }
    assert.equal(fs.existsSync(logFile), false, 'the fake agy never ran');
    assert.equal(typeof AGY_HEADLESS_SETTINGS_JSON, 'string', 'the settings constant stays exported for compatibility');
  } finally {
    process.env.PATH = prevPath;
    process.env.HOME = prevHome;
    if (prevMode === undefined) delete process.env.WK_TEST_AGY_MODE;
    else process.env.WK_TEST_AGY_MODE = prevMode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Orchestrator.loadLedger() migrates stale gemini-3.8-flash-low unless explicit
  const today = new Date().toISOString().slice(0, 10);
  let stored = {
    date: today,
    config: { gemini: { fastModel: 'gemini-3.8-flash-low' } },
  };
  const orch = new Orchestrator({
    loadState: () => stored,
    saveState: st => { stored = st; },
  });
  assert.equal(orch.loadLedger().config.gemini.fastModel, 'gemini-pro-orchestrator');
  await orch.updateConfig({ gemini: { fastModel: 'gemini-3.8-flash-low' } });
  assert.equal(stored.config.gemini.fastModelExplicit, true);
  assert.equal(orch.loadLedger().config.gemini.fastModel, 'gemini-3.8-flash-low');
});

test('extension.js executeChatTurn surfaces empty_reason in turn.error when model returns empty output', async () => {
  const dir = mkTmp('wk-ext-empty-reason-');
  const origLoad = Module._load;
  const gMap = new Map();
  const fakeVscode = {
    ViewColumn: { One: 1 },
    Uri: { file: p => ({ fsPath: p }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath || ROOT, ...p) }) },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: dir } }],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {}, getCommands: async () => [] },
    window: {
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showWarningMessage: async () => 'Allow wake-ups',
      showInformationMessage: async () => {},
    },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return fakeVscode;
    return origLoad.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve('../extension')];
  try {
    const ext = require('../extension');
    const plugin = path.join(dir, 'plugin'), wk = path.join(dir, 'wk');
    fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'config'), { recursive: true });
    fs.mkdirSync(wk, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
    fs.writeFileSync(path.join(plugin, 'config', 'gates.json'), '{}');
    fakeVscode.workspace.getConfiguration = () => ({ get: k => ({ pluginPath: plugin, dataDir: wk }[k]) });
    const ctx = {
      extensionUri: { fsPath: ROOT },
      globalState: { get: (k, d) => (gMap.has(k) ? gMap.get(k) : d), update: async (k, v) => gMap.set(k, v) },
      secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
      subscriptions: [],
    };
    const rp = {
      getSecrets: async () => ({}),
      getSettings: () => ({ includeWorkspaceContext: false }),
      orchestrator: {
        previewRoute: async () => ({
          provider: 'gemini',
          model: 'gemini-pro-orchestrator',
          reason_summary: 'Mock route',
          skill_judgment: null,
        }),
        orchestrateWorkflow: async () => ({
          output: '',
          model: 'gemini-pro-orchestrator',
          provider: 'gemini',
          empty_reason: 'Headless Antigravity CLI auto-denied permission (mcp) and returned no final text.',
        }),
      },
      sendToAntigravity: async () => ({ focused: false, message: '' }),
    };
    const panel = new ext.Panel(ctx, rp);
    panel.view = { visible: true, webview: { postMessage: () => {} } };
    const { listChatSessionSummaries, getChatSession } = require('../src/chat-sessions');
    await panel.onMessage({
      cmd: 'chatDraft',
      prompt: 'Check status',
      confirmBeforeGo: false,
      autoReprompt: false,
      syncToIde: false,
    });
    const sum = listChatSessionSummaries(wk);
    const sess = getChatSession(wk, sum[0].id);
    assert.equal(sess.turns[0].status, 'error');
    assert.equal(
      sess.turns[0].error,
      'Headless Antigravity CLI auto-denied permission (mcp) and returned no final text. Prompt is copied to clipboard for Antigravity IDE Chat.'
    );
  } finally {
    delete require.cache[require.resolve('../extension')];
    Module._load = origLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
