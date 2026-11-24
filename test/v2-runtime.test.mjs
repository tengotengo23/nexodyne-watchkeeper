import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.WK_PYTHON || 'python3';

function makeTempEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-v2-node-'));
  const ws = path.join(tmp, 'ws');
  const rt = path.join(tmp, 'rt');
  const wkHome = path.join(tmp, 'wk_home');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(rt, { recursive: true });
  fs.mkdirSync(wkHome, { recursive: true });
  return {
    tmp,
    ws,
    rt,
    wkHome,
    env: {
      ...process.env,
      HOME: tmp,
      WK_HOME: wkHome,
      WK_RUNTIME_DIR: rt,
      WK_GATE_FILE: path.join(ROOT, 'config', 'gates.json'),
      GEMINI_API_KEY: '',
      WATCHKEEPER_GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
    },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('hooks/hooks.json routes all lifecycle events through core/hook_bus.py', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const hooks = cfg.hooks || {};
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolBatch', 'SubagentStart', 'SubagentStop', 'Stop']) {
    assert.ok(Array.isArray(hooks[ev]) && hooks[ev].length > 0, `Missing hook event ${ev}`);
    const flatCmds = hooks[ev].flatMap((entry) => (entry.hooks || []).map((h) => String(h.command || '')));
    assert.ok(flatCmds.some((c) => c.includes('core/hook_bus.py') && c.includes(ev)), `${ev} must execute core/hook_bus.py ${ev}`);
  }
  assert.equal(hooks.PreToolUse[0].matcher, '*');
});

test('bin/wk.mjs CLI exposes doctor, status, mode, brain, skills, and graph subcommands', () => {
  const ctx = makeTempEnv();
  try {
    fs.writeFileSync(path.join(ctx.ws, 'server.py'), 'def ping():\n    return "pong"\n');

    const docRaw = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'wk.mjs'), 'doctor', '--workspace', ctx.ws, '--json'], {
      env: ctx.env,
      encoding: 'utf8',
    });
    const doc = JSON.parse(docRaw);
    assert.equal(doc.ok, true);
    assert.ok(Array.isArray(doc.checks) && doc.checks.length >= 7);
    assert.equal(doc.status.version, '2.0.0');

    const modeOut = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'bin', 'wk.mjs'), 'mode', 'confirm', '--workspace', ctx.ws, '--json'], {
      env: ctx.env,
      encoding: 'utf8',
    }));
    assert.equal(modeOut.mode, 'confirm');

    const brainOut = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'bin', 'wk.mjs'), 'brain', 'carbon-high', '--workspace', ctx.ws, '--json'], {
      env: ctx.env,
      encoding: 'utf8',
    }));
    assert.equal(brainOut.brain, 'carbon-high');

    const statusRaw = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'wk-status.mjs'), '--workspace', ctx.ws, '--json'], {
      env: ctx.env,
      encoding: 'utf8',
    });
    const statusJson = JSON.parse(statusRaw);
    assert.ok(Array.isArray(statusJson.pipeline_stages), 'wk-status --json must include pipeline_stages');
    assert.equal(statusJson.pipeline_stages[0].name, 'Hook Multiplexer Bus');
    assert.ok(statusJson.commands.claude_code.includes('/wk'));
  } finally {
    ctx.cleanup();
  }
});

test('core/hook_bus.py preserves fail-closed PreToolUse wk-guard semantics and UserPromptSubmit compilation', () => {
  const ctx = makeTempEnv();
  try {
    // 1. PreToolUse reading .env must fail closed with exit code 2
    const blocked = spawnSync(PY, [path.join(ROOT, 'core', 'hook_bus.py'), 'PreToolUse'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(ctx.ws, '.env') }, cwd: ctx.ws }),
      env: ctx.env,
      encoding: 'utf8',
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /watchkeeper blocked/i);

    // 2. PreToolUse reading normal source file succeeds
    const allowed = spawnSync(PY, [path.join(ROOT, 'core', 'hook_bus.py'), 'PreToolUse'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(ctx.ws, 'app.py') }, cwd: ctx.ws }),
      env: ctx.env,
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0);

    // 3. UserPromptSubmit raw: bypasses cleanly
    const rawPass = spawnSync(PY, [path.join(ROOT, 'core', 'hook_bus.py'), 'UserPromptSubmit'], {
      input: JSON.stringify({ session_id: 's_node_1', cwd: ctx.ws, prompt: 'raw: check git status' }),
      env: ctx.env,
      encoding: 'utf8',
    });
    assert.equal(rawPass.status, 0);
    assert.deepEqual(JSON.parse(rawPass.stdout), {});

    // 4. Normal technical prompt emits [WK-SPEC-V2:...]
    const compiled = spawnSync(PY, [path.join(ROOT, 'core', 'hook_bus.py'), 'UserPromptSubmit'], {
      input: JSON.stringify({ session_id: 's_node_1', cwd: ctx.ws, prompt: 'Implement API rate limiter with unit tests' }),
      env: ctx.env,
      encoding: 'utf8',
    });
    assert.equal(compiled.status, 0);
    const outObj = JSON.parse(compiled.stdout);
    const addCtx = outObj?.hookSpecificOutput?.additionalContext || '';
    assert.match(addCtx, /\[WK-SPEC-V2:[0-9a-f]{12}\]/);
  } finally {
    ctx.cleanup();
  }
});
