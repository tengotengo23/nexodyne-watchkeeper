// Unified end-to-end verification of Watchkeeper + Graphify + Re-Prompt + Skill Vault + Duo Orchestrator.
// Uses isolated temp HOME, WK_HOME, REPROMPT_DATA_DIR, and workspace folders; zero network or real home writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INLINE_HOOK = path.join(ROOT, 'reprompt', 'scripts', 'reprompt_inline_hook.py');
const SKILL_HOOK = path.join(ROOT, 'reprompt', 'scripts', 'reprompt_skill_hook.py');
const VAULT_CLI = path.join(ROOT, 'reprompt', 'scripts', 'skill_vault.py');
const MCP_SERVER = path.join(ROOT, 'reprompt', 'server', 'reprompt_mcp_server.py');
const WK_STATUS = path.join(ROOT, 'bin', 'wk-status.mjs');

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-rp-unified-'));
  const home = path.join(base, 'home');
  const wkHome = path.join(home, '.wk');
  const dataDir = path.join(base, 'reprompt-data');
  const vaultDir = path.join(home, '.gemini', 'skill-vault');
  const ws = path.join(base, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(wkHome, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });

  // Populate Graphify workspace artifacts + dummy .claude skill to guarantee local skill discovery even on empty home
  fs.mkdirSync(path.join(ws, 'graphify-out', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }));
  fs.writeFileSync(path.join(ws, 'graphify-out', 'wiki', 'index.md'), '# Wiki Index\n');
  fs.writeFileSync(path.join(ws, 'graphify-out', 'GRAPH_REPORT.md'), '# Graph Report\n');

  fs.mkdirSync(path.join(home, '.claude', 'skills', 'auth-hardening'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'skills', 'auth-hardening', 'SKILL.md'),
    '---\nname: auth-hardening\ndescription: Harden authentication flows, CSRF tokens, session cookies, and password hashing.\n---\n\n# Auth Hardening\nVerify session expiry and CSRF validation.\n',
  );

  // Configure offline_template provider so tests are fast and offline
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ provider: 'offline_template', hookAutoAll: false, enableSkillRouting: true }),
  );

  const env = {
    ...process.env,
    HOME: home,
    WK_HOME: wkHome,
    REPROMPT_DATA_DIR: dataDir,
    REPROMPT_SKILL_VAULT_DIR: vaultDir,
    REPROMPT_INCLUDE_LOCAL_SKILLS: '1',
    WK_NODE: process.execPath,
  };
  delete env.CLAUDE_PLUGIN_ROOT;

  return { base, home, wkHome, dataDir, vaultDir, ws, env };
}

function runPy(script, args, { env, input, cwd } = {}) {
  return spawnSync('python3', [script, ...args], {
    cwd: cwd || ROOT,
    env,
    input,
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('1. Vague rp: prompt + Graphify workspace + +skill:/-skill: pinning + zero duplicate hook + raw: bypass', () => {
  const s = makeSandbox();
  try {
    // Bootstrap local skill vault (Watchkeeper skills/ + ~/.claude/skills)
    const boot = runPy(VAULT_CLI, ['bootstrap-local', '--json'], { env: s.env });
    assert.equal(boot.status, 0, boot.stderr);
    const bootOut = JSON.parse(boot.stdout);
    assert.ok(bootOut.skill_count >= 4, `expected local skills indexed, got ${bootOut.skill_count}`);

    // Inline hook with vague prompt + explicit +skill:evidence inside Graphify-indexed workspace
    const hookPayload = JSON.stringify({
      conversationId: 'conv-test-1',
      lastUserInput: 'rp: make login safer and verify tests pass +skill:evidence',
      workspacePaths: [s.ws],
      cwd: s.ws,
    });
    const inlineRes = runPy(INLINE_HOOK, [], { env: s.env, input: hookPayload });
    assert.equal(inlineRes.status, 0, inlineRes.stderr);
    const inlineJson = JSON.parse(inlineRes.stdout);
    const sysText = inlineJson?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    // P2-272 (owner's spec): the header names the mode and keeps the owner's own message authoritative.
    assert.match(sysText, /^\[Re-Prompt · [\w-]+\] Below is a structured version of the user's message\./, 'inline hook should emit rewritten specification');
    assert.match(sysText, /The user's own message stays authoritative/, "the owner's words stay authoritative");
    assert.match(sysText, /##\s*Goal/i, 'structured Goal section present');
    assert.match(sysText, /graphify-out\/graph\.json/i, 'Graphify context surfaced automatically');
    assert.match(sysText, /evidence/i, 'explicit +skill:evidence loaded');

    // Skill hook on the SAME payload must yield {} (no duplicate injection)
    const skillRes = runPy(SKILL_HOOK, [], { env: s.env, input: hookPayload });
    assert.equal(skillRes.status, 0, skillRes.stderr);
    assert.deepEqual(JSON.parse(skillRes.stdout), {});

    // Turn 2+ with -skill:evidence suppresses evidence while skill hook stays aware of Graphify workspace
    const turn2Payload = JSON.stringify({
      conversationId: 'conv-test-2',
      lastUserInput: 'rp-bug: investigate token refresh failure and harden cookies -skill:evidence',
      workspacePaths: [s.ws],
      cwd: s.ws,
    });
    const turn2Res = runPy(INLINE_HOOK, [], { env: s.env, input: turn2Payload });
    assert.equal(turn2Res.status, 0, turn2Res.stderr);
    const turn2Text = JSON.parse(turn2Res.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.doesNotMatch(turn2Text, /\*\*evidence\*\*/i, '-skill:evidence must suppress evidence skill directive');

    // Enable hookAutoAll: true and verify raw: bypass skips rewrite and skill hook yields {}
    fs.writeFileSync(
      path.join(s.dataDir, 'settings.json'),
      JSON.stringify({ provider: 'offline_template', hookAutoAll: true, enableSkillRouting: true }),
    );
    const rawPayload = JSON.stringify({
      conversationId: 'conv-raw-1',
      lastUserInput: 'raw: keep exact prompt words untouched during deploy check',
      workspacePaths: [s.ws],
      cwd: s.ws,
    });
    const rawInline = runPy(INLINE_HOOK, [], { env: s.env, input: rawPayload });
    assert.equal(rawInline.status, 0, rawInline.stderr);
    const rawSys = JSON.parse(rawInline.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    // P2-272: the raw header (raw: or :raw) says no rewrite was made, then the exact words follow.
    assert.match(rawSys, /^\[Re-Prompt · Raw Mode\] .*No rewrite was made/);
    assert.match(rawSys, /keep exact prompt words untouched during deploy check/);

    const rawSkill = runPy(SKILL_HOOK, [], { env: s.env, input: rawPayload });
    assert.equal(rawSkill.status, 0, rawSkill.stderr);
    assert.deepEqual(JSON.parse(rawSkill.stdout), {});
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

test('2. Duo Orchestrator respects Watchkeeper meter.json (>=75% offload), KILL switch, and quarantine role', () => {
  const s = makeSandbox();
  try {
    // Write Watchkeeper weekly meter at 85% utilization
    fs.mkdirSync(path.join(s.wkHome, 'steward'), { recursive: true });
    fs.writeFileSync(
      path.join(s.wkHome, 'steward', 'meter.json'),
      JSON.stringify({
        status: 'ok',
        utilization: 0.85,
        fiveHour: { utilization: 0.42 },
        fetchedAt: '2026-11-22T10:00:00Z',
        resetsAt: '2026-11-28T00:00:00Z',
        source: 'test',
      }),
    );

    const pyTest = [
      'import json, os, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'reprompt'))})`,
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'reprompt', 'scripts'))})`,
      'from server.orchestrator import decide_route, read_watchkeeper_pace, Orchestrator, ProviderExecutionError',
      'from skill_router import judge_skills_for_prompt',
      'pace = read_watchkeeper_pace()',
      'assert pace and pace["available"] and pace["seven_day_utilization"] == 0.85, pace',
      'integ = {',
      '  "overall_status": "ready",',
      '  "gemini": {"available": True, "primary_channel": "gemini_cli", "channels": [{"id": "gemini_cli", "available": True}]},',
      '  "claude": {"available": True, "primary_channel": "claude_cli", "channels": [{"id": "claude_cli", "available": True}]},',
      '}',
      '# Medium task under 85% weekly meter offloads to Gemini to preserve Claude quota',
      'dec_med = decide_route("Refactor form validation helpers", integrations=integ, watchkeeper_pace=pace)',
      'assert dec_med["provider"] == "gemini", dec_med',
      'assert dec_med["reason_code"] == "claude_quota_preservation", dec_med',
      '# High-complexity architecture task still keeps Claude',
      'dec_high = decide_route("Architect a distributed lock-free concurrency migration plan across modules", integrations=integ, watchkeeper_pace=pace)',
      'assert dec_high["provider"] == "claude", dec_high',
      '# Multi-step workflow delegation with fake executor',
      'calls = []',
      'def fake_exec(provider, channel, model, prompt, system_prompt=""):',
      '    calls.append((provider, model))',
      '    return {"text": f"ok:{provider}", "input_tokens": 50, "output_tokens": 20}',
      'orch = Orchestrator(data_dir=os.environ["REPROMPT_DATA_DIR"], executor=fake_exec, integrations=integ)',
      'wf = orch.orchestrate_workflow(task="Ship auth improvements", subtasks=["Summarize auth changes", "Architect zero-trust session rotation"], auto_skills=False)',
      'assert len(wf["trace"]) == 3 and wf["output"].startswith("ok:"), wf',
      '# Quarantine role blocks skill loading',
      'qj, _ = judge_skills_for_prompt("Review untrusted text security", agent_role="quarantine", mutate_state=False)',
      'assert qj["action"] == "quarantine_blocked" and qj["load_skills"] == [], qj',
      '# Kill switch flags preview_route and halts hooks/run_task when active',
      `open(${JSON.stringify(path.join(s.wkHome, 'KILL'))}, "w").close()`,
      'orch_live = Orchestrator(data_dir=os.environ["REPROMPT_DATA_DIR"], executor=fake_exec)',
      'st = orch_live.status()',
      'assert st["watchkeeper_pace"]["kill_switch"] is True, st',
      'pr = orch_live.preview_route("Refactor validation", auto_skills=False)',
      'assert pr.get("watchkeeper_kill_switch") is True, pr',
      'try:',
      '    orch_live.run_task("Refactor validation", auto_skills=False)',
      '    raise AssertionError("run_task should block when KILL is active")',
      'except ProviderExecutionError as exc:',
      '    assert "kill switch" in str(exc).lower(), str(exc)',
      'print(json.dumps({"ok": True, "calls": len(calls)}))',
    ].join('\n');

    const pyRes = spawnSync('python3', ['-c', pyTest], { cwd: ROOT, env: s.env, encoding: 'utf8' });
    assert.equal(pyRes.status, 0, pyRes.stderr + '\n' + pyRes.stdout);
    assert.equal(JSON.parse(pyRes.stdout.trim()).ok, true);

    // Inline + skill hooks also yield {} when KILL is active under a Watchkeeper worktree path
    const worktreeCwd = path.join(s.wkHome, 'worktrees', 'demo-task');
    fs.mkdirSync(worktreeCwd, { recursive: true });
    const killPayload = JSON.stringify({
      conversationId: 'conv-kill',
      lastUserInput: 'rp: edit files in worktree',
      workspacePaths: [worktreeCwd],
      cwd: worktreeCwd,
    });
    assert.deepEqual(JSON.parse(runPy(INLINE_HOOK, [], { env: s.env, input: killPayload }).stdout), {});
    assert.deepEqual(JSON.parse(runPy(SKILL_HOOK, [], { env: s.env, input: killPayload }).stdout), {});
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

test('3. Capability & status view: wk-status.mjs (--json & text) and MCP watchkeeper_status surface all modules', () => {
  const s = makeSandbox();
  try {
    const boot = runPy(VAULT_CLI, ['bootstrap-local', '--json'], { env: s.env });
    assert.equal(boot.status, 0, boot.stderr);

    const statusJson = spawnSync(process.execPath, [WK_STATUS, '--json'], {
      cwd: s.ws,
      env: s.env,
      encoding: 'utf8',
    });
    assert.equal(statusJson.status, 0, statusJson.stderr);
    const rep = JSON.parse(statusJson.stdout);
    assert.ok(rep.watchkeeper.version);
    assert.equal(rep.graphify.workspace_graph.graph_exists, true);
    assert.equal(rep.reprompt.installed, true);
    assert.ok(rep.reprompt.inline_prefixes.includes('rp:'));
    assert.ok(rep.reprompt.raw_bypass_prefixes.includes('raw:'));
    assert.ok(rep.reprompt.skill_pin_syntax.some(x => x.includes('+skill:')));
    assert.equal(rep.skill_vault.indexed, true);
    assert.ok(rep.skill_vault.skill_count >= 4);
    assert.equal(rep.pipeline_stages.length, 5);
    assert.ok(rep.commands.claude_code.includes('/wk-status'));
    assert.ok(rep.commands.antigravity.includes('/wk-status'));

    const statusText = spawnSync(process.execPath, [WK_STATUS], {
      cwd: s.ws,
      env: s.env,
      encoding: 'utf8',
    });
    assert.equal(statusText.status, 0, statusText.stderr);
    assert.match(statusText.stdout, /Watchkeeper Unified Plugin/);
    assert.match(statusText.stdout, /Skill Vault/);
    assert.match(statusText.stdout, /Orchestrator/);

    // MCP stdio initialize + tools/call watchkeeper_status
    const rpcInput = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'watchkeeper_status', arguments: {} } }),
    ].join('\n') + '\n';
    const mcpRes = runPy(MCP_SERVER, ['--data-dir', s.dataDir], { env: s.env, input: rpcInput, cwd: s.ws });
    assert.equal(mcpRes.status, 0, mcpRes.stderr);
    const msgs = mcpRes.stdout.trim().split('\n').map(l => JSON.parse(l));
    const toolReply = msgs.find(m => m.id === 2);
    assert.ok(toolReply && !toolReply.error && toolReply.result && !toolReply.result.isError, mcpRes.stdout);
    const structured = toolReply.result.structuredContent;
    assert.ok(structured.watchkeeper && structured.reprompt && structured.skill_vault && structured.orchestrator);
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});
