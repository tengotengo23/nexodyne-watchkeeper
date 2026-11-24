// P2-272 4B (B2, canon line 65): every Gemini lane (agy_gemini, agy_claude, gemini_cli) in the panel and IDE
// orchestrators only queues a wk-task for Antigravity, in the IDE context and in the Claude Code context.
// Stub `agy` and `gemini` binaries on PATH write a marker if they are ever started; the marker must never appear.
// No network: everything runs in a temp HOME, WK_HOME and git repo made with mkdtemp.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('.');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gemq-'));
function removeOwnTmp(dir) {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`not inside the temporary folder: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => removeOwnTmp(TMP));

const BIN = path.join(TMP, 'bin');
const MARK = path.join(TMP, 'marker.txt');
fs.mkdirSync(BIN, { recursive: true });
for (const name of ['agy', 'gemini']) {
  const p = path.join(BIN, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(MARK)}\nexit 0\n`);
  fs.chmodSync(p, 0o755);
}
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(REPO, { recursive: true });
const gitEnv = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' };
for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) {
  assert.equal(spawnSync('git', ['-C', REPO, ...args], { env: gitEnv }).status, 0);
}
fs.writeFileSync(path.join(REPO, 'a.txt'), 'a\n');
assert.equal(spawnSync('git', ['-C', REPO, 'add', 'a.txt'], { env: gitEnv }).status, 0);
assert.equal(spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', 'init'], { env: gitEnv }).status, 0);
const PLAIN = path.join(TMP, 'plain-folder');
fs.mkdirSync(PLAIN, { recursive: true });

const MODULES = {
  panel: path.join(ROOT, 'panel', 'src', 'reprompt-orchestrator.js'),
  ide: path.join(ROOT, 'reprompt', 'ide-extension', 'orchestrator.js'),
};
const CHANNELS = ['agy_gemini', 'agy_claude', 'gemini_cli'];

// Runs defaultExecuteChannel in a child process with the given env, so process.env (the caller check) is real.
function runLane(kind, channel, workspace, extraEnv, wkHome) {
  const script = `
    const m = require(${JSON.stringify(MODULES[kind])});
    const args = { channel: ${JSON.stringify(channel)}, model: 'x', prompt: 'Fix the footer\\nsecond line', secrets: {} };
    args[${JSON.stringify(kind === 'panel' ? 'workspaceDir' : 'workspace')}] = ${JSON.stringify(workspace)};
    m.defaultExecuteChannel(args).then((r) => { process.stdout.write(JSON.stringify(r)); }, (e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })); });
  `;
  const env = {
    PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME, WK_HOME: wkHome, WK_PLUGIN_ROOT: ROOT, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60000, cwd: TMP });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout || '{}');
}

function taskMeta(wkHome, id) {
  const dir = path.join(wkHome, 'tasks', id);
  assert.ok(fs.existsSync(dir), `task folder ${dir}`);
  const files = fs.readdirSync(dir);
  const metaName = files.find((f) => f.endsWith('.json')) || '';
  return { files, meta: metaName ? JSON.parse(fs.readFileSync(path.join(dir, metaName), 'utf8')) : {} };
}

const CONTEXTS = [
  { name: 'IDE context', env: {}, from: 'owner' },
  { name: 'Claude Code context', env: { CLAUDECODE: '1' }, from: 'claude' },
];

for (const kind of Object.keys(MODULES)) {
  for (const ctx of CONTEXTS) {
    for (const channel of CHANNELS) {
      test(`${kind} ${channel} queues a wk-task in the ${ctx.name}, and never starts agy or gemini`, () => {
        const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
        const r = runLane(kind, channel, REPO, ctx.env, wkHome);
        assert.ok(!r.error, r.error);
        assert.match(r.queued_task || '', /^[A-Za-z0-9._-]+$/, JSON.stringify(r));
        const text = r.text || r.output || '';
        assert.match(text, new RegExp(`Queued for Antigravity as task ${r.queued_task}\\. Antigravity takes it when you run /wk-take-task there\\.`));
        const { meta } = taskMeta(wkHome, r.queued_task);
        const blob = JSON.stringify(meta);
        assert.ok(blob.includes(ctx.from), `from ${ctx.from} in ${blob}`);
        if (ctx.from === 'owner') assert.ok(!/"from":\s*"claude"/.test(blob), 'never claude when Claude is not the caller');
        assert.ok(blob.includes('**'), 'allow ** passed');
        assert.ok(blob.includes('Fix the footer'), 'title from the first line');
        assert.equal(fs.existsSync(MARK), false, 'the stub agy or gemini was started');
      });
    }
  }
  test(`${kind}: a folder that is not a git repo queues nothing and says so`, () => {
    const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
    const r = runLane(kind, 'gemini_cli', PLAIN, {}, wkHome);
    assert.equal(r.queued_task, null);
    assert.match(r.text || r.output || '', /is not a git repository/);
    assert.equal(fs.existsSync(path.join(wkHome, 'tasks')) && fs.readdirSync(path.join(wkHome, 'tasks')).length > 0, false);
    assert.equal(fs.existsSync(MARK), false);
  });
  test(`${kind}: internal steps (noQueue) queue nothing`, () => {
    const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
    const script = `
      const m = require(${JSON.stringify(MODULES[kind])});
      m.defaultExecuteChannel({ channel: 'agy_gemini', model: 'x', prompt: 'p', secrets: {}, noQueue: true, ${kind === 'panel' ? 'workspaceDir' : 'workspace'}: ${JSON.stringify(REPO)} })
        .then((r) => process.stdout.write(JSON.stringify(r)));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { env: { PATH: `${BIN}:/usr/bin:/bin`, HOME, WK_HOME: wkHome, WK_PLUGIN_ROOT: ROOT }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.queue_skipped, true);
    assert.equal(fs.existsSync(path.join(wkHome, 'tasks')) && fs.readdirSync(path.join(wkHome, 'tasks')).length > 0, false);
    assert.equal(fs.existsSync(MARK), false);
  });
  test(`${kind}: the queue lanes stay listed with the plain detail`, () => {
    const m = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(MODULES[kind])});process.stdout.write(JSON.stringify({d:m.QUEUE_DETAIL,c:[...m.QUEUE_CHANNELS]}))`], { env: { PATH: `${BIN}:/usr/bin:/bin`, HOME }, encoding: 'utf8' });
    const o = JSON.parse(m.stdout);
    assert.equal(o.d, 'Not run by Watchkeeper; queued for Antigravity');
    assert.deepEqual(o.c.sort(), [...CHANNELS].sort());
  });
}

// S10 (P2-272 review): gemini_api under Claude Code (CLAUDECODE=1 or WK_CALLER=claude_code) queues a wk-task and
// never sends the prompt to Gemini. A preload makes every http/https request write a marker and throw, and a fake
// key is set, so an unguarded REST call would show up as the marker (and nothing ever leaves the machine).
const NET_MARK = path.join(TMP, 'net-marker.txt');
const NO_NET = path.join(TMP, 'no-net.cjs');
fs.writeFileSync(NO_NET, `
const fs = require('fs');
for (const mod of ['http', 'https']) {
  const m = require(mod);
  const block = () => { fs.appendFileSync(${JSON.stringify(NET_MARK)}, mod + '\\n'); throw new Error('network blocked in test'); };
  m.request = block; m.get = block;
}
`);
const CLAUDE_FLAGS = [{ CLAUDECODE: '1' }, { WK_CALLER: 'claude_code' }];
for (const kind of Object.keys(MODULES)) {
  for (const flag of CLAUDE_FLAGS) {
    test(`${kind} gemini_api with ${Object.keys(flag)[0]} queues a wk-task and never calls Gemini`, () => {
      const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
      const r = runLane(kind, 'gemini_api', REPO, { ...flag, GEMINI_API_KEY: 'test-not-a-key', NODE_OPTIONS: `--require ${NO_NET}` }, wkHome);
      assert.ok(!r.error, r.error);
      assert.match(r.queued_task || '', /^[A-Za-z0-9._-]+$/, JSON.stringify(r));
      assert.match(r.text || '', /Queued for Antigravity as task /);
      const { meta } = taskMeta(wkHome, r.queued_task);
      assert.ok(JSON.stringify(meta).includes('claude'), 'the task says Claude queued it');
      assert.equal(fs.existsSync(NET_MARK), false, 'a network request was made');
      assert.equal(fs.existsSync(MARK), false, 'the stub agy or gemini was started');
    });
  }
  test(`${kind} gemini_api outside Claude Code is not queued (the owner's own key path is unchanged)`, () => {
    const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
    const r = runLane(kind, 'gemini_api', REPO, { NODE_OPTIONS: `--require ${NO_NET}` }, wkHome);
    assert.match(r.error || '', /Missing Gemini API key/);
    assert.equal(fs.existsSync(path.join(wkHome, 'tasks')) && fs.readdirSync(path.join(wkHome, 'tasks')).length > 0, false);
    assert.equal(fs.existsSync(NET_MARK), false);
    assert.equal(fs.existsSync(MARK), false);
  });
}

test('S11: the IDE engine refuses agy with the canon line; S12: provider agy rewrites on the template under Claude Code', () => {
  const engine = path.join(ROOT, 'reprompt', 'ide-extension', 'repromptEngine.js');
  const script = `
    const m = require(${JSON.stringify(engine)});
    const e = m.agyRefusal();
    m.rewriteWithProvider({ settings: { provider: 'agy' }, prompt: 'fix the login bug', target: 'antigravity', mode: 'balanced' })
      .then((r) => process.stdout.write(JSON.stringify({ msg: e.message, never: m.NEVER_AGY, r })),
            (err) => process.stdout.write(JSON.stringify({ msg: e.message, never: m.NEVER_AGY, error: String(err && err.message || err) })));
  `;
  for (const extra of [{ CLAUDECODE: '1' }, { WK_CALLER: 'claude_code' }, {}]) {
    try { fs.unlinkSync(MARK); } catch {}
    const r = spawnSync(process.execPath, ['--require', NO_NET, '-e', script], {
      env: { PATH: `${BIN}:/usr/bin:/bin`, HOME, NO_COLOR: '1', ...extra }, encoding: 'utf8', timeout: 30000,
    });
    const out = JSON.parse(r.stdout || '{}');
    assert.equal(out.msg, 'Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.');
    assert.equal(out.never, out.msg);
    assert.equal(out.error, undefined, JSON.stringify(extra) + ' ' + out.error);
    assert.ok(String(out.r.rewrittenPrompt || out.r.rewritten_prompt || '').trim(), 'template rewrote the prompt');
    assert.match(JSON.stringify(out.r), /does not run Antigravity/);
    assert.equal(fs.existsSync(MARK), false, 'no stub binary ran');
    assert.equal(fs.existsSync(NET_MARK), false, 'no network call');
  }
});

// P2-272 open point 5: the routing words follow the real channel. Only gemini_api outside Claude Code sends the
// prompt to Gemini, with the owner's own key; under Claude Code, and on the Antigravity queue channel, the words say
// it is queued for Antigravity. decideRoute runs in a child process with a clean env (the caller check reads
// process.env, and this test itself may run under Claude Code), with every network request blocked.
function runDecide(kind, gChannel, extraEnv, { claudeReady = true, pace = null } = {}) {
  const integrations = {
    gemini: { available: true, channels: [{ id: gChannel, available: true }], setup_hint: 'g' },
    claude: { available: claudeReady, channels: claudeReady ? [{ id: 'claude_cli', available: true }] : [], setup_hint: 'c' },
  };
  const args = { task: 'Fix the footer typo', integrations };
  if (pace) args.watchkeeperPace = pace;
  const script = `
    const m = require(${JSON.stringify(MODULES[kind])});
    const d = m.decideRoute(${JSON.stringify(args)});
    process.stdout.write(JSON.stringify({ provider: d.provider, channel: d.channel, code: d.reason_code, words: d.reason_summary }));
  `;
  const wkHome = fs.mkdtempSync(path.join(TMP, 'wkhome-'));
  const env = {
    PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME, WK_HOME: wkHome, WK_PLUGIN_ROOT: ROOT, NO_COLOR: '1', NODE_OPTIONS: `--require ${NO_NET}`,
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60000, cwd: TMP });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(NET_MARK), false, 'a network request was made');
  assert.equal(fs.existsSync(MARK), false, 'the stub agy or gemini was started');
  return JSON.parse(r.stdout);
}
const OWN_KEY_ROUTINE = {
  panel: 'Sent this lighter task to Gemini with your own API key to save Claude limits.',
  ide: 'Sent this routine task to Gemini with your own API key to keep Claude limits in reserve.',
};
for (const kind of Object.keys(MODULES)) {
  test(`${kind}: with the owner's own Gemini key outside Claude Code, the routing words say it is sent to Gemini`, () => {
    const off = runDecide(kind, 'gemini_api', {}, { claudeReady: false });
    assert.deepEqual([off.provider, off.channel, off.code], ['gemini', 'gemini_api', 'fallback_unavailable']);
    assert.equal(off.words, 'Sent to Gemini with your own API key because Claude is not configured.');
    const routine = runDecide(kind, 'gemini_api', {});
    assert.equal(routine.provider, 'gemini');
    assert.equal(routine.words, OWN_KEY_ROUTINE[kind]);
  });
  for (const flag of CLAUDE_FLAGS) {
    test(`${kind}: the owner's Gemini key under ${Object.keys(flag)[0]}: the routing words say queued for Antigravity`, () => {
      const off = runDecide(kind, 'gemini_api', flag, { claudeReady: false });
      assert.equal(off.words, 'Queued for Antigravity because Claude is not configured.');
      const routine = runDecide(kind, 'gemini_api', flag);
      assert.match(routine.words, /for Antigravity \(wk-task\)/);
      assert.doesNotMatch(routine.words, /API key/);
    });
  }
  test(`${kind}: the Antigravity queue channel keeps the queue words outside Claude Code`, () => {
    const off = runDecide(kind, 'agy_gemini', {}, { claudeReady: false });
    assert.equal(off.words, 'Queued for Antigravity because Claude is not configured.');
    assert.doesNotMatch(runDecide(kind, 'agy_gemini', {}).words, /API key/);
  });
}
test('panel: "Claude Code limits reached (Watchkeeper meter)" names the real route', () => {
  const pace = { available: true, claude_limit_exhausted: true };
  assert.equal(runDecide('panel', 'gemini_api', {}, { pace }).words, 'Claude Code limits reached (Watchkeeper meter); sent to Gemini with your own API key.');
  assert.equal(runDecide('panel', 'gemini_api', { CLAUDECODE: '1' }, { pace }).words, 'Claude Code limits reached (Watchkeeper meter); queued for Antigravity (wk-task).');
});
