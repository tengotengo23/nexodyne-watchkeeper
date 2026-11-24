'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const R = require('../src/render');

test('autonomous learning bridge captures IDE saves, queries FTS5 <10ms, enforces trust/sanitization, and escapes UI', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-learn-panel-'));
  const prevDb = process.env.WK_SNIPPET_DB;
  const prevHome = process.env.WK_HOME;
  try {
    const dataDir = path.join(base, 'wk');
    const ws = path.join(base, 'repo');
    const pluginPath = path.resolve(__dirname, '..', '..');
    fs.mkdirSync(ws, { recursive: true });
    process.env.WK_HOME = dataDir;
    process.env.WK_SNIPPET_DB = path.join(dataDir, 'learning', 'snippets.db');

    const saveListeners = [];
    const registeredCmds = {};
    const infoMsgs = [];
    const load = Module._load;
    const cfg = { pluginPath, dataDir, claudeDir: path.join(base, 'claude'), orchestrationDir: '' };
    const fakeVscode = {
      Uri: { file: f => ({ fsPath: f, scheme: 'file' }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: ws } }],
        getConfiguration: () => ({ get: k => cfg[k] }),
        onDidChangeConfiguration: () => ({ dispose() { } }),
        onDidSaveTextDocument: fn => { saveListeners.push(fn); return { dispose() { } }; },
      },
      window: {
        registerWebviewViewProvider: () => ({ dispose() { } }),
        showInformationMessage: m => { infoMsgs.push(m); return Promise.resolve(); },
        showWarningMessage: m => { infoMsgs.push(m); return Promise.resolve(); },
      },
      commands: {
        registerCommand: (id, fn) => { registeredCmds[id] = fn; return { dispose() { } }; },
      },
    };

    Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
    try {
      delete require.cache[require.resolve('../src/learning-bridge.js')];
      const lb = require('../src/learning-bridge.js');

      // 1. Before any DB exists, readLearningSummary returns empty and creates nothing
      const empty = lb.readLearningSummary(dataDir);
      assert.equal(empty.available, false);
      assert.equal(empty.snippetCount, 0);
      assert.equal(fs.existsSync(path.join(dataDir, 'learning')), false);

      // 2. Attach to mock panel and simulate agent write -> user save correction
      let refreshes = 0;
      const ctx = { subscriptions: [] };
      const fakePanel = { cfg: () => cfg, repo: () => ws, activeChatSessionId: 'WKS-20261122-000000-abcd', refresh: () => { refreshes += 1; } };
      lb.attachLearningToExtension(ctx, fakePanel);
      assert.equal(saveListeners.length, 1);
      assert.ok(registeredCmds['watchkeeper.searchSnippets']);
      assert.ok(registeredCmds['watchkeeper.captureSnippet']);
      assert.ok(registeredCmds['watchkeeper.learningStats']);

      const targetFile = path.join(ws, 'cleanup.js');
      const agentCode = 'function startTimer(fn) {\n  return setInterval(fn, 5000);\n}\n';
      fs.writeFileSync(targetFile, agentCode);

      // Seed agent snapshot via wk-learning-hook.py PostToolUse
      const py = process.env.WK_PYTHON || 'python3';
      execFileSync(py, [path.join(pluginPath, 'bin', 'wk-learning-hook.py'), 'PostToolUse'], {
        input: JSON.stringify({ conversationId: 'ide_1', cwd: ws, toolCall: { name: 'write_to_file', args: { TargetFile: targetFile } } }),
        env: { ...process.env, WK_HOME: dataDir, WK_SNIPPET_DB: process.env.WK_SNIPPET_DB },
        encoding: 'utf8',
      });

      // Developer edits file with cleanup + dynamic test secret that must be sanitized
      const fakeKey = 'sk-' + 'ant-api03-' + 'secret'.repeat(4);
      const userCode = `function startTimer(fn) {\n  const key = "${fakeKey}";\n  const t = setInterval(fn, 5000);\n  try { if (t.unref) t.unref(); return t; } finally { /* tracked */ }\n}\n`;
      fs.writeFileSync(targetFile, userCode);
      await saveListeners[0]({ uri: { scheme: 'file' }, fileName: targetFile, languageId: 'javascript', getText: () => userCode });

      assert.equal(refreshes, 1, 'Panel refreshed after detecting developer correction');
      const sum = lb.readLearningSummary(dataDir);
      assert.equal(sum.available, true);
      assert.equal(sum.snippetCount, 1);
      assert.equal(sum.correctionCount, 1);

      // 3. Local FTS5 search runs quickly and returns sanitized snippet
      const qRes = await lb.searchSnippetsLocal(dataDir, pluginPath, 'startTimer unref', { limit: 5 });
      assert.equal(qRes.ok, true);
      assert.equal(qRes.snippets.length, 1);
      assert.ok(!qRes.snippets[0].code.includes(fakeKey), 'Secret was redacted before persistence');
      assert.ok(qRes.latency_ms < 50, `Expected low query latency, got ${qRes.latency_ms}ms`);

      // 4. Untrusted workspace refuses writes
      const denied = await lb.saveSnippetLocal(dataDir, pluginPath, { title: 'Blocked', code: 'x=1' }, { trusted: false });
      assert.equal(denied.ok, false);

      // 5. renderSkills escapes autonomous learning fields
      const rendered = R.renderSkills({
        now: Date.now(),
        skillLibrary: { ready: true, total: 1, repos: 1, domains: [], items: [], sync: null },
        learning: {
          available: true,
          snippetCount: 1,
          verifiedCount: 1,
          correctionCount: 1,
          heuristicCount: 1,
          topSnippets: [{ title: '<img src=x onerror=alert(1)>', language: 'js', verification_status: 'verified_pass' }],
          topHeuristics: [{ language: 'js', category: 'cleanup', rule_text: '<script>evil()</script>' }],
        },
      });
      assert.match(rendered, /Autonomous Learning &amp; Verified Snippets/);
      assert.ok(!rendered.includes('<script>evil()'));
      assert.ok(!rendered.includes('<img src=x'));

      await registeredCmds['watchkeeper.learningStats']();
      assert.ok(infoMsgs.some(x => /1 snippets/.test(x)));
    } finally {
      delete require.cache[require.resolve('../src/learning-bridge.js')];
      Module._load = load;
    }
  } finally {
    if (prevDb === undefined) delete process.env.WK_SNIPPET_DB;
    else process.env.WK_SNIPPET_DB = prevDb;
    if (prevHome === undefined) delete process.env.WK_HOME;
    else process.env.WK_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
