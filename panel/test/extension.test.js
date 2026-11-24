'use strict';
// Host glue test: extension.js with a stand-in `vscode` module and temp folders. Checks the view HTML, refresh, the inbox write and the kill switch flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ext-'));
// The panel only follows a kill path inside the home folder, so this test's home is its temp folder; the real one is never touched.
const realKill = path.join(os.homedir(), '.wk', 'KILL'), realKillBefore = fs.existsSync(realKill);
process.env.HOME = base;
const cfg = { pluginPath: path.join(base, 'plugin'), dataDir: path.join(base, 'wk'), claudeDir: path.join(base, 'claude'), orchestrationDir: path.join(base, 'orch') };
fs.mkdirSync(path.join(cfg.pluginPath, 'bin'), { recursive: true });
fs.mkdirSync(path.join(cfg.pluginPath, 'config'), { recursive: true });
fs.writeFileSync(path.join(cfg.pluginPath, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
fs.writeFileSync(path.join(cfg.pluginPath, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(cfg.dataDir, 'KILL') } }));

let answer = 'Allow wake-ups';
const opened = [];
const registered = {};
const fakeVscode = {
  Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
  workspace: { isTrusted: true, getConfiguration: () => ({ get: k => cfg[k] }), onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async u => { opened.push(u.fsPath); return { uri: u }; } },
  window: {
    registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; },
    showWarningMessage: async () => answer,
    showTextDocument: async () => ({}),
  },
  commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
const ext = require('../extension.js');

function fakeView() {
  const posted = [], handlers = {};
  const view = {
    visible: true, posted,
    webview: { cspSource: 'vscode-resource:', options: null, html: '', asWebviewUri: u => u,
      postMessage: m => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: fn => { handlers.msg = fn; return { dispose() {} }; } },
    onDidChangeVisibility: fn => { handlers.vis = fn; return { dispose() {} }; },
    onDidDispose: fn => { handlers.dispose = fn; return { dispose() {} }; },
    send: m => handlers.msg(m), hide: () => { view.visible = false; handlers.vis(); }, handlers,
  };
  return view;
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('the view: strict CSP, data on ready, inbox and kill switch', async t => {
  const ctx = { extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] };
  t.after(() => { for (const p of Object.values(registered)) if (p && p.stop) p.stop(); });
  ext.activate(ctx);
  const provider = registered['watchkeeper.panel'];
  assert.ok(provider, 'view provider registered');
  assert.equal(typeof registered['watchkeeper.refresh'], 'function');
  const view = fakeView();
  provider.resolveWebviewView(view);
  assert.match(view.webview.html, /default-src 'none'/);
  assert.match(view.webview.html, /script-src 'nonce-[A-Za-z0-9]{16,}'/);
  assert.equal(view.webview.options.enableScripts, true);
  await until(() => view.posted.some(m => m.type === 'data'));
  const first = view.posted.find(m => m.type === 'data');
  assert.match(first.sections.pace, /No meter reading yet/);
  assert.match(first.sections.sessions, /No Claude sessions folder found/);

  await view.send({ cmd: 'send', kind: 'rule', text: 'Use Haiku for log reading' });
  const inbox = path.join(cfg.dataDir, 'owner-inbox.jsonl');
  assert.equal(fs.statSync(inbox).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(inbox, 'utf8').trim()).kind, 'rule');
  assert.ok(view.posted.some(m => m.type === 'result' && m.ok && m.cleared));
  assert.ok(view.posted.some(m => m.type === 'result' && m.text === 'Saved as a proposed rule change in ~/.wk/owner-inbox.jsonl. No session reads it by itself: ask Claude Code to read that file, make the change, and approve it in that chat.'));

  await view.send({ cmd: 'send', kind: 'rule', text: 'x'.repeat(4001) });
  assert.ok(view.posted.some(m => m.type === 'result' && !m.ok && /4,000/.test(m.text)));
  await view.send({ cmd: 'evil', path: '/etc/passwd' });
  assert.equal(fs.readFileSync(inbox, 'utf8').trim().split('\n').length, 1, 'nothing else written');

  const kill = path.join(cfg.dataDir, 'KILL');
  await view.send({ cmd: 'kill' });
  assert.ok(fs.existsSync(kill));
  answer = undefined;
  await view.send({ cmd: 'unkill' });
  assert.ok(fs.existsSync(kill), 'a cancelled confirm keeps the switch on');
  answer = 'Allow wake-ups';
  await view.send({ cmd: 'unkill' });
  assert.ok(!fs.existsSync(kill));

  view.hide();
  const n = view.posted.length;
  await provider.refresh();
  assert.equal(view.posted.length, n, 'no work while hidden');
  assert.equal(provider.timer, null);
  for (const d of ctx.subscriptions) d.dispose && d.dispose();
  assert.equal(fs.existsSync(realKill), realKillBefore, 'the real kill switch is untouched');
});

// P2-208: the two new buttons. The real plugin folder installs the skill into this test's temp home, never the real ~/.gemini.
test('the view: open an answer, and let Gemini ask (installs into the temp home only)', async t => {
  const realSkill = path.join(os.userInfo().homedir, '.gemini', 'config', 'plugins', 'watchkeeper');
  const realSkillBefore = fs.existsSync(realSkill) ? fs.readdirSync(realSkill).join() : null;
  cfg.pluginPath = path.join(__dirname, '..', '..');
  const id = '20261111-101500-which-app-next';
  fs.mkdirSync(path.join(cfg.dataDir, 'advice', id), { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, 'advice', id, 'meta.json'), JSON.stringify({ id, from: 'gemini', status: 'answered', asked_at: '2026-11-11T06:15:00Z', preview: 'Which app next?' }));
  fs.writeFileSync(path.join(cfg.dataDir, 'advice', id, 'answer.md'), 'Answer: the timer.');
  const ctx = { extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] };
  ext.activate(ctx);
  const provider = registered['watchkeeper.panel'];
  t.after(() => { provider.stop(); for (const d of ctx.subscriptions) d.dispose && d.dispose(); });
  const view = fakeView();
  provider.resolveWebviewView(view);
  await until(() => view.posted.some(m => m.type === 'data'));
  const first = view.posted.find(m => m.type === 'data');
  assert.match(first.sections.advice, /Which app next\?/);
  assert.match(first.sections.advice, /data-cmd="installAsk"/);
  await view.send({ cmd: 'openAdvice', id, which: 'answer' });
  assert.deepEqual(opened, [path.join(cfg.dataDir, 'advice', id, 'answer.md')]);
  await view.send({ cmd: 'openAdvice', id: '../../../etc/passwd' });
  assert.equal(opened.length, 1, 'a bad id opens nothing');
  await view.send({ cmd: 'installAsk' });
  const skill = path.join(base, '.gemini', 'config', 'plugins', 'watchkeeper', 'skills', 'ask-claude', 'SKILL.md');
  assert.ok(fs.existsSync(skill), 'installed into the temp home');
  assert.ok(view.posted.some(m => m.type === 'result' && m.ok && /installed/.test(m.text)));
  await until(() => view.posted.filter(m => m.type === 'data').some(m => /it asks Claude, who answers as you would/.test(m.sections.advice)));
  assert.equal(fs.existsSync(realSkill) ? fs.readdirSync(realSkill).join() : null, realSkillBefore, 'the real Antigravity folder is untouched');
});

// P2-212: with orchestrationDir empty, the panel uses the open workspace's `orchestration` folder when it has `locks/`.
test('orchestration folder: empty setting falls back to the open workspace, else none', () => {
  const provider = registered['watchkeeper.panel'];
  const saved = cfg.orchestrationDir, ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ws-')), other = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ws-'));
  try {
    cfg.orchestrationDir = '';
    fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: other } }];
    assert.equal(provider.cfg().orchestrationDir, '', 'no orchestration/locks in the workspace: none');
    fs.mkdirSync(path.join(ws, 'orchestration', 'locks'), { recursive: true });
    fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: other } }, { uri: { fsPath: ws } }];
    assert.equal(provider.cfg().orchestrationDir, path.join(ws, 'orchestration'));
    cfg.orchestrationDir = '   ';
    assert.equal(provider.cfg().orchestrationDir, path.join(ws, 'orchestration'), 'spaces count as empty');
    cfg.orchestrationDir = '/set/by/hand';
    assert.equal(provider.cfg().orchestrationDir, '/set/by/hand', 'a set folder wins');
  } finally { cfg.orchestrationDir = saved; delete fakeVscode.workspace.workspaceFolders; }
});

// P2-212 review: without the plugin the commands that write or run the plugin's code refuse, and nothing is written.
test('without the plugin: send, kill, unkill and installAsk refuse and write nothing', async () => {
  const provider = registered['watchkeeper.panel'];
  const saved = { ...cfg }, none = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-none-'));
  try {
    cfg.pluginPath = path.join(none, 'plugin'); cfg.dataDir = path.join(none, 'wk');
    const view = fakeView();
    provider.resolveWebviewView(view);
    for (const m of [{ cmd: 'send', kind: 'recommendation', text: 'hello' }, { cmd: 'kill' }, { cmd: 'unkill' }, { cmd: 'installAsk' }]) await view.send(m);
    const refused = view.posted.filter(m => m.type === 'result' && !m.ok && /needs the Watchkeeper plugin/.test(m.text));
    assert.equal(refused.length, 4);
    assert.deepEqual(fs.readdirSync(none), [], 'nothing written');
    await until(() => view.posted.some(m => m.type === 'data'));
    assert.equal(view.posted.find(m => m.type === 'data').sections.mode, 'sessions');
  } finally { provider.stop(); Object.assign(cfg, saved); }
});

// P2-223: the host side of "Waiting for you" and Gemini, with a fake nx, fake plugin scripts and a fake clipboard (all in temp folders).
test('host: answer through the answer script, Later, money needs a second press, suggestions, tasks and the automation prompt', async () => {
  const provider = registered['watchkeeper.panel'];
  const saved = { ...cfg }, w = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-223-')), clip = [];
  const orch = path.join(w, 'orchestration'), plugin = path.join(w, 'plugin'), data = path.join(w, 'wk'), repo = path.join(w, 'repo');
  for (const d of [orch, path.join(plugin, 'bin'), path.join(plugin, 'config'), repo]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(orch, 'QUESTIONS.md'), '# Questions\n\n- [ ] Q7 (2026-11-14 09:00, tab ?): T-1 Show the pace bar first? Recommended: yes.\n- [ ] Q8 (2026-11-14 10:00, tab ?): T-2 Buy the domain? Recommended: buy it.\n- [x] Q6 (2026-11-13 10:00, tab ?): Old. Recommended: no.\n');
  fs.writeFileSync(path.join(orch, 'nx'), "#!/usr/bin/env node\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2);fs.appendFileSync(p.join(__dirname,'argv.jsonl'),JSON.stringify(a)+'\\n');\nconst q=p.join(__dirname,'QUESTIONS.md');fs.writeFileSync(q,fs.readFileSync(q,'utf8').replace('- [ ] Q'+a[1]+' ','- [x] Q'+a[1]+' '));console.log('RECORDED');\n", { mode: 0o755 });
  const script = "import fs from 'node:fs';import p from 'node:path';import {fileURLToPath} from 'node:url';const f=fileURLToPath(import.meta.url);fs.appendFileSync(p.join(p.dirname(f),'calls.jsonl'),JSON.stringify({s:p.basename(f),a:process.argv.slice(2),wk:process.env.WK_HOME})+'\\n');console.log(process.argv[2]==='add'?'20261114-120000-t':'');\n";
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-suggest.mjs'), script);
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-task.mjs'), script);
  fs.writeFileSync(path.join(plugin, 'config', 'gemini.json'), JSON.stringify({ automation_prompt: 'Take the next Watchkeeper task.', routes: {} }));
  const sid = 'S-20261114-100000-abcd';
  fs.mkdirSync(data, { recursive: true });
  // the questions' folder is the one remote.json names, never one found in a workspace
  fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ orchestration: orch }));
  fs.writeFileSync(path.join(data, 'suggestions.jsonl'), JSON.stringify({ id: sid, at: new Date().toISOString(), from: 'claude', title: 'Turn on the weekly report?', action: { type: 'none' } }) + '\n');
  const nxCalls = () => fs.existsSync(path.join(orch, 'argv.jsonl')) ? fs.readFileSync(path.join(orch, 'argv.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const calls = () => fs.existsSync(path.join(plugin, 'bin', 'calls.jsonl')) ? fs.readFileSync(path.join(plugin, 'bin', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const decisions = () => fs.readFileSync(path.join(data, 'owner-inbox.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  fakeVscode.env = { clipboard: { writeText: async t => { clip.push(t); } } };
  fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: repo } }];
  try {
    Object.assign(cfg, { pluginPath: plugin, dataDir: data, orchestrationDir: orch });
    const view = fakeView();
    provider.resolveWebviewView(view);
    await until(() => view.posted.some(m => m.type === 'data'));
    const d = view.posted.find(m => m.type === 'data').sections;
    assert.deepEqual([d.show.waiting, d.show.gemini], [true, true]);
    assert.match(d.waiting, /Q8[\s\S]*Q7/, 'newest first');
    const results = () => view.posted.filter(m => m.type === 'result');
    const lastResult = () => results().at(-1);
    // money: the first OK is refused by the host too (the page's second press is not trusted alone), nx never runs
    await view.send({ cmd: 'answerQuestion', n: '8', useRecommended: true });
    assert.deepEqual([lastResult().ok, lastResult().where, lastResult().text], [false, 'waiting', 'About money, legal wording or an account. Press OK again to confirm.']);
    assert.deepEqual(nxCalls(), []);
    await view.send({ cmd: 'answerQuestion', n: '8', useRecommended: true, confirmed: true });
    await view.send({ cmd: 'answerQuestion', n: '7', text: 'Yes, but\nbelow the status line.' });
    assert.deepEqual(nxCalls(), [['answer', '8', 'OK: buy it.'], ['answer', '7', 'Yes, but below the status line.']]);
    assert.deepEqual(results().slice(-2).map(r => [r.ok, r.text, r.cleared, r.n]), [[true, 'Answered Q8.', true, '8'], [true, 'Answered Q7.', true, '7']]);
    // answered (ticked) or never there: refused before nx runs
    for (const n of ['7', '6', '99']) await view.send({ cmd: 'answerQuestion', n, text: 'again' });
    assert.equal(nxCalls().length, 2);
    assert.ok(results().slice(-3).every(r => !r.ok && /is no longer open\. Nothing was sent\./.test(r.text)));
    // bad numbers: refused by validation, under the section
    await view.send({ cmd: 'answerQuestion', n: '7; rm -rf /', text: 'x' });
    assert.deepEqual([lastResult().ok, lastResult().where], [false, 'waiting']);
    // Later on a fresh question
    fs.appendFileSync(path.join(orch, 'QUESTIONS.md'), '- [ ] Q9 (2026-11-14 11:00, tab ?): Which colour? Recommended: green.\n');
    await view.send({ cmd: 'laterQuestion', n: '9' });
    assert.equal(lastResult().text, 'Q9 is hidden for 24 hours.');
    assert.ok(D2().readPanelState(data).later.Q9 > Date.now());
    assert.equal(nxCalls().length, 2, 'Later never runs nx');
    assert.deepEqual(decisions().map(r => [r.kind, r.ref, r.choice]), [['decision', 'Q8', 'ok'], ['decision', 'Q7', 'answer'], ['decision', 'Q9', 'later']]);
    // suggestions through wk-suggest
    await view.send({ cmd: 'decideSuggestion', id: sid, choice: 'ok' });
    assert.deepEqual(calls()[0], { s: 'wk-suggest.mjs', a: ['decide', sid, 'ok'], wk: data });
    assert.equal(lastResult().text, 'Going ahead.');
    await view.send({ cmd: 'decideSuggestion', id: 'S-20261114-100000-ffff', choice: 'ok' });
    assert.equal(lastResult().text, 'That suggestion is already decided or gone.');
    assert.equal(calls().length, 1);
    // a task for Gemini goes to the first workspace folder
    await view.send({ cmd: 'addTask', title: 'Fix the timer', text: 'It skips a second.', kind: 'auto' });
    assert.deepEqual(calls()[1].a, ['add', '--repo', repo, '--title', 'Fix the timer', '--text', 'It skips a second.', '--from', 'owner']);
    assert.deepEqual([lastResult().ok, lastResult().where, lastResult().cleared], [true, 'task', true]);
    // S7/S8: the page is told a merge is running, and an "Already ..." reply clears the item and is shown as it is
    const sid2 = 'S-20261114-130000-aaaa';
    fs.appendFileSync(path.join(data, 'suggestions.jsonl'), JSON.stringify({ id: sid2, at: new Date().toISOString(), from: 'watchkeeper', title: 'Merge it?', action: { type: 'task-merge', ref: '20261114-100000-fix-timer' } }) + '\n');
    fs.writeFileSync(path.join(plugin, 'bin', 'wk-suggest.mjs'), script + "\nconsole.log('Already merged.');");
    const before = view.posted.length;
    await view.send({ cmd: 'decideSuggestion', id: sid2, choice: 'ok' });
    const after = view.posted.slice(before);
    const seq = after.filter(m => m.type === 'merging' || m.type === 'result').map(m => m.type === 'merging' ? `merging:${m.on}` : `result:${m.ok}`);
    assert.deepEqual(seq, ['merging:true', 'merging:false', 'result:true']);
    assert.equal(lastResult().text, 'Already merged.');
    assert.equal(lastResult().where, 'waiting');
    // the automation prompt goes to the clipboard, nowhere else
    await view.send({ cmd: 'copyAutomation' });
    assert.deepEqual(clip, ['Take the next Watchkeeper task.']);
    assert.deepEqual([lastResult().ok, lastResult().where], [true, 'copy']);
    fs.rmSync(path.join(plugin, 'config', 'gemini.json'));
    await view.send({ cmd: 'copyAutomation' });
    assert.deepEqual([lastResult().ok, clip.length], [false, 1]);
    await view.send({ cmd: 'openTaskDiff', id: '20261114-120000-t' });
    assert.deepEqual([lastResult().ok, lastResult().text], [false, 'That change is not there any more.']);
    provider.stop();
    // without the plugin: all six refuse and nothing runs or is written
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-none-'));
    Object.assign(cfg, { pluginPath: path.join(none, 'plugin'), dataDir: path.join(none, 'wk') });
    const v2 = fakeView();
    provider.resolveWebviewView(v2);
    fs.appendFileSync(path.join(orch, 'QUESTIONS.md'), '- [ ] Q10 (2026-11-14 11:30, tab ?): Another? Recommended: yes.\n');
    for (const m of [{ cmd: 'answerQuestion', n: '10', useRecommended: true }, { cmd: 'laterQuestion', n: '10' }, { cmd: 'decideSuggestion', id: sid, choice: 'no' }, { cmd: 'openTaskDiff', id: '20261114-120000-t' }, { cmd: 'addTask', title: 'x' }, { cmd: 'copyAutomation' }]) await v2.send(m);
    assert.equal(v2.posted.filter(m => m.type === 'result' && !m.ok && /needs the Watchkeeper plugin/.test(m.text)).length, 6);
    assert.deepEqual(fs.readdirSync(none), []);
    assert.equal(nxCalls().length, 2);
    assert.equal(clip.length, 1);
  } finally { provider.stop(); Object.assign(cfg, saved); delete fakeVscode.env; delete fakeVscode.workspace.workspaceFolders; }
});
function D2() { return require('../src/data'); }

// A fixture for the two tests below: a plugin whose scripts log their calls, and a workspace that ships its own orchestration/nx.
function hostileFixture(prefix) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const ws = path.join(w, 'repo'), orch = path.join(ws, 'orchestration'), plugin = path.join(w, 'plugin'), data = path.join(w, 'wk');
  for (const d of [path.join(orch, 'locks'), path.join(plugin, 'bin'), path.join(plugin, 'config'), data]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(orch, 'QUESTIONS.md'), '# Questions\n\n- [ ] Q3 (2026-11-14 09:00): Ship it? Recommended: yes.\n');
  const ran = path.join(w, 'ran.jsonl');
  const logger = `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(ran)}, JSON.stringify(process.argv.slice(1)) + '\\n');\n`;
  fs.writeFileSync(path.join(orch, 'nx'), logger, { mode: 0o755 });
  for (const f of ['wk-suggest.mjs', 'wk-task.mjs', 'wk-job.mjs', 'wk-remote.mjs', 'wk-ask-claude.mjs', 'wk-skill-sync.mjs']) fs.writeFileSync(path.join(plugin, 'bin', f), logger.replace('#!/usr/bin/env node\n', ''));
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
  fs.writeFileSync(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(data, 'KILL') } }));
  fs.writeFileSync(path.join(data, 'suggestions.jsonl'), JSON.stringify({ id: 'S-20261114-100000-abcd', at: new Date().toISOString(), from: 'claude', title: 'Go?', action: { type: 'none' } }) + '\n');
  const runs = () => fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n').length : 0;
  return { w, ws, orch, plugin, data, runs };
}
const RUN_MESSAGES = [{ cmd: 'answerQuestion', n: '3', useRecommended: true }, { cmd: 'answerQuestion', n: '3', text: 'yes' }, { cmd: 'decideSuggestion', id: 'S-20261114-100000-abcd', choice: 'ok' },
  { cmd: 'addTask', title: 'Fix it', text: 'x', kind: 'auto' }, { cmd: 'installAsk' }, { cmd: 'jobStart', project: 'site', prompt: 'hi', model: 'sonnet', mode: 'plan' },
  { cmd: 'jobReply', job: 'J-20261114-1000-abcd', prompt: 'hi' }, { cmd: 'jobStop', job: 'J-20261114-1000-abcd' }, { cmd: 'trustKey', id: 'AAAAAAAAAAAAAAAA' }, { cmd: 'rejectKey', id: 'AAAAAAAAAAAAAAAA' }, { cmd: 'remoteOn' }, { cmd: 'remoteOff' },
  { cmd: 'repromptRewrite', draft: 'fix bug', target: 'antigravity', mode: 'balanced', skills: '' }, { cmd: 'repromptSend', text: 'fix bug', target: 'antigravity' }, { cmd: 'orchestrateRun', prompt: 'check logs', prefer: 'auto' }, { cmd: 'skillsSync' },
  { cmd: 'chatDraft', prompt: 'fix bug', confirmBeforeGo: true }, { cmd: 'chatConfirm', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456', repromptedText: 'fix' }, { cmd: 'chatSendToIde', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456', repromptedText: 'fix' },
  { cmd: 'chatContinueFromClaude', sessionId: 'sess_1234' }, { cmd: 'chatTakeTask' }, { cmd: 'chatHandoffToClaude', sessionId: 'WKS-20261122-120000-abcd', note: 'next' },
  { cmd: 'watchdogScan' }, { cmd: 'watchdogRecover' }, { cmd: 'bridgeOpenClaude', repo: '/tmp' }, { cmd: 'bridgeOpenAntigravity', taskId: '20261124-202000-fix-login' }, { cmd: 'graphRefresh' }, { cmd: 'removal', id: 'wt-1', choice: 'ok' },
  { cmd: 'skillApprove', slug: 'some-source' }, { cmd: 'skillReject', slug: 'owner/repo' },
  { cmd: 'dagRun', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456' }, { cmd: 'dagStop', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456' },
  { cmd: 'dagMerge', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456' }, { cmd: 'dagCheck', sessionId: 'WKS-20261122-120000-abcd', turnId: 'T-123456' }];

// Copy review must 7: a workspace's own orchestration/nx is never run, and its questions are not listed; only remote.json names that folder.
test('a workspace that ships orchestration/nx: its questions are not listed and its nx never runs', async () => {
  const provider = registered['watchkeeper.panel'];
  const saved = { ...cfg }, f = hostileFixture('wk-ws-nx-');
  fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: f.ws } }];
  try {
    for (const orchestrationDir of ['', f.orch]) {   // found in the workspace, or even set by hand: locks only
      Object.assign(cfg, { pluginPath: f.plugin, dataDir: f.data, orchestrationDir });
      const view = fakeView();
      provider.resolveWebviewView(view);
      await until(() => view.posted.some(m => m.type === 'data'));
      assert.doesNotMatch(view.posted.find(m => m.type === 'data').sections.waiting, /Q3/, 'not listed');
      await view.send({ cmd: 'answerQuestion', n: '3', useRecommended: true });
      await view.send({ cmd: 'answerQuestion', n: '3', text: 'yes' });
      const r = view.posted.filter(m => m.type === 'result');
      assert.deepEqual(r.slice(-2).map(x => [x.ok, /no longer open\. Nothing was sent\./.test(x.text)]), [[false, true], [false, true]]);
      provider.stop();
    }
    assert.equal(f.runs(), 0, 'nothing ran');
    // the same folder named in remote.json: now it is the user's own choice, and nx runs
    fs.writeFileSync(path.join(f.data, 'remote.json'), JSON.stringify({ orchestration: f.orch }));
    const view = fakeView();
    provider.resolveWebviewView(view);
    await view.send({ cmd: 'answerQuestion', n: '3', text: 'yes' });
    assert.equal(f.runs(), 1);
  } finally { provider.stop(); Object.assign(cfg, saved); delete fakeVscode.workspace.workspaceFolders; }
});

test('an untrusted folder: every command that runs something refuses and nothing runs; the panel says why', async () => {
  const provider = registered['watchkeeper.panel'];
  const saved = { ...cfg }, f = hostileFixture('wk-untrusted-');
  fs.writeFileSync(path.join(f.data, 'remote.json'), JSON.stringify({ orchestration: f.orch }));
  fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: f.ws } }];
  fakeVscode.workspace.isTrusted = false;
  try {
    Object.assign(cfg, { pluginPath: f.plugin, dataDir: f.data, orchestrationDir: '' });
    const view = fakeView();
    provider.resolveWebviewView(view);
    await until(() => view.posted.some(m => m.type === 'data'));
    const sec = view.posted.find(m => m.type === 'data').sections;
    assert.equal(sec.untrusted, true);
    assert.match(sec.status, /This folder is not trusted, so the buttons that run something are off here/);
    assert.equal(RUN_MESSAGES.length, ext.RUNS.size + 1, 'every command that runs something is tried (answer twice)');
    for (const m of RUN_MESSAGES) await view.send(m);
    const refused = view.posted.filter(m => m.type === 'result' && !m.ok && m.text === ext.UNTRUSTED);
    assert.equal(refused.length, RUN_MESSAGES.length);
    assert.equal(f.runs(), 0, 'nothing ran');
    // what runs nothing still works: Later and a note
    await view.send({ cmd: 'laterQuestion', n: '3' });
    assert.equal(view.posted.filter(m => m.type === 'result').at(-1).text, 'Q3 is hidden for 24 hours.');
    // trusted again: the same press runs
    fakeVscode.workspace.isTrusted = true;
    await view.send({ cmd: 'answerQuestion', n: '3', text: 'yes' });
    assert.equal(f.runs(), 1);
  } finally { provider.stop(); fakeVscode.workspace.isTrusted = true; Object.assign(cfg, saved); delete fakeVscode.workspace.workspaceFolders; }
});

test('package.json: limited support in untrusted folders, with a reason', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.match(pkg.capabilities.untrustedWorkspaces.description, /runs nothing/);
});

test('the vsix carries every file the extension requires (scripts/package.mjs FILES)', () => {
  const root = path.join(__dirname, '..');
  const files = JSON.parse(/const FILES = (\[[^\]]*\]);/.exec(fs.readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8'))[1].replace(/'/g, '"'));
  const todo = ['extension.js'], seen = new Set();
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    assert.ok(files.includes(f), `${f} is loaded by the extension but not packaged`);
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      let r = path.relative(root, path.resolve(path.dirname(path.join(root, f)), m[1])); if (!r.endsWith('.js')) r += '.js';
      todo.push(r.split(path.sep).join('/'));
    }
  }
  for (const f of ['src/actions.js', 'src/legal-words.js']) assert.ok(seen.has(f), f);
});

test('full-IDE workspace: openWorkspace renders wk-full-ide tabs and skillsSync triggers wk-skill-sync.mjs', async () => {
  const provider = registered['watchkeeper.panel'];
  const saved = { ...cfg }, f = hostileFixture('wk-fullide-');
  const origCreatePanel = fakeVscode.window.createWebviewPanel;
  const origExec = fakeVscode.commands.executeCommand;
  const origViewColumn = fakeVscode.ViewColumn;
  const panels = [];
  fakeVscode.ViewColumn = { ...(origViewColumn || {}), One: 1 };
  fakeVscode.commands.executeCommand = async () => {};
  fakeVscode.window.createWebviewPanel = (id, title) => {
    const view = fakeView();
    const p = { id, title, webview: view.webview, posted: view.posted, send: view.send, reveal() {}, onDidDispose: () => ({ dispose() {} }) };
    panels.push(p);
    return p;
  };
  try {
    const ranSync = path.join(f.w, 'ran-sync.jsonl');
    fs.writeFileSync(
      path.join(f.plugin, 'bin', 'wk-skill-sync.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ranSync)}, JSON.stringify(process.argv.slice(1)) + '\\n');\n`,
    );
    Object.assign(cfg, { pluginPath: f.plugin, dataDir: f.data, orchestrationDir: '' });
    fakeVscode.workspace.isTrusted = true;
    await provider.openWorkspace({ maximize: false });
    assert.equal(panels.length, 1);
    const wp = panels[0];
    assert.match(wp.webview.html, /class="wk-full-ide"/);
    // P2-272 (P3-A): the five tabs became one frame (rail, status bar, Ops drawer, stream, composer); each former
    // tab's content must still be in the full-IDE page: Re-Prompt, Running Tasks, Skills Library, Guard & Pace.
    assert.doesNotMatch(wp.webview.html, /class="wk-tab\b/, 'no tab buttons left');
    for (const [tab, mark] of [['Re-Prompt', 'id="sec-reprompt"'], ['Running Tasks', 'id="h-jobs"'], ['Skills Library', 'id="sec-review"'],
      ['Guard & Pace', 'id="wk-ops"'], ['Guard & Pace', 'id="h-controls"'], ['Guard & Pace', 'id="h-pace"'], ['rail', '+ New Session']]) {
      assert.ok(wp.webview.html.includes(mark), `full-IDE HTML keeps ${tab} (${mark})`);
    }
    assert.match(wp.webview.html, /id="sec-orchestrator"/);
    assert.match(wp.webview.html, /id="sec-skills"/);
    await wp.send({ cmd: 'skillsSync' });
    assert.equal(fs.existsSync(ranSync), true, `skillsSync invoked wk-skill-sync.mjs; posted=${JSON.stringify(wp.posted)}`);
    const syncArgv = JSON.parse(fs.readFileSync(ranSync, 'utf8').trim().split('\n')[0]);
    assert.deepEqual(syncArgv.slice(1), ['run', '--force', '--no-clone']);
  } finally {
    provider.stop();
    provider.workspacePanel = null;
    fakeVscode.window.createWebviewPanel = origCreatePanel;
    fakeVscode.commands.executeCommand = origExec;
    fakeVscode.ViewColumn = origViewColumn;
    Object.assign(cfg, saved);
  }
});

test('P2-273: a panel paste over 30 words is marked so the Antigravity hook sends it as is', () => {
  const pp = require('../src/prompt-prefix.js');
  const long = Array(31).fill('word').join(' ');
  const short = 'fix the login page';
  assert.equal(ext.ideTaskFor(short, {}), short);
  assert.equal(ext.ideTaskFor(long, { autoRewriteOverWords: 0 }), long, 'word rule off: nothing to mark');
  const marked = ext.ideTaskFor(long, {});
  assert.ok(marked.startsWith(long) && marked.endsWith(ext.PANEL_AS_IS_MARK));
  assert.equal(pp.wantsAutoRewrite(marked, 30), false, 'the hook does not rewrite it again');
  assert.ok(ext.ideTaskFor(short, { hookAutoAll: true }).endsWith(ext.PANEL_AS_IS_MARK), 'rewrite-everything mode marks short text too');
  assert.equal(ext.ideTaskFor(long, null).endsWith(ext.PANEL_AS_IS_MARK), true, 'no settings: the default rule');
});

test('P2-277 Bridge: Open in Claude opens a terminal that takes the handoff (--handoff --cwd, never --claim) in the named folder only; a forged folder opens nothing', async t => {
  const ctx = { extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] };
  t.after(() => { for (const p of Object.values(registered)) if (p && p.stop) p.stop(); delete fakeVscode.window.createTerminal; });
  const terms = [];
  fakeVscode.window.createTerminal = o => { const term = { o, shown: false, sent: [], show() { term.shown = true; }, sendText(s) { term.sent.push(s); } }; terms.push(term); return term; };
  const repo = fs.mkdtempSync(path.join(base, 'repo-'));
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, 'watch.json'), JSON.stringify({ at: new Date().toISOString(), ids: { tasks_for_gemini: [], handoffs_for_claude: [`${repo}@2026-11-24T20:00:00Z`] },
    bridge: { on: true, counts: { queued_for_gemini: 0, waiting_for_claude: 1, in_flight: 0, done_24h: 0, stalled: 0 }, stalled_ids: [], routes: { claude_wait: { alive: false, pid: null }, hooks: 'on' }, last_crossings: [] } }));
  ext.activate(ctx);
  const view = fakeView();
  registered['watchkeeper.panel'].resolveWebviewView(view);
  await until(() => view.posted.some(m => m.type === 'data'));
  await view.send({ cmd: 'bridgeOpenClaude', repo });
  assert.equal(terms.length, 1);
  assert.equal(terms[0].o.cwd, repo);
  assert.equal(terms[0].shown, true);
  assert.deepEqual(terms[0].sent, [`claude '/wk-take-task --handoff --cwd "${repo}"'`]);
  assert.ok(!terms[0].sent[0].includes('--claim'), 'a handoff is taken as a handoff, never through the queue');
  await view.send({ cmd: 'bridgeOpenClaude', repo: '/etc' });
  assert.equal(terms.length, 1, 'a folder watch.json does not name opens no terminal at all');
  await view.send({ cmd: 'bridgeOpenAntigravity', taskId: '../../x' });
  assert.equal(terms.length, 1, 'a bad task id runs nothing');
  fs.rmSync(path.join(cfg.dataDir, 'watch.json'));
});
