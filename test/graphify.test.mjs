// Unified Watchkeeper + Graphify installer & public-safety checks.
// Uses isolated temp HOME / WK_HOME and a fake `uv` script; never touches real ~/.wk, ~/.gemini, or ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GRAPHIFY_VERSION, GRAPHIFY_PKG } from '../bin/wk-graphify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'wk-graphify.mjs');

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gph-test-'));
  const home = path.join(base, 'home');
  const wkHome = path.join(home, '.wk');
  const uvLog = path.join(base, 'uv.log');
  const fakeUv = path.join(base, 'uv');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(fakeUv, `#!/bin/sh
echo "$@" >> ${JSON.stringify(uvLog)}
if [ "$1" = "tool" ] && [ "$2" = "install" ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/graphify" << 'G'
#!/bin/sh
if [ "$1" = "--version" ]; then echo "graphify ${GRAPHIFY_VERSION}"; exit 0; fi
exit 0
G
  chmod +x "$HOME/.local/bin/graphify"
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: home,
    WK_HOME: wkHome,
    WK_NODE: process.execPath,
    WK_ISOLATE_PATH: '1',
    WK_UV_BIN: fakeUv,
    WK_PIPX_BIN: '',
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.WK_GRAPHIFY_BIN;

  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  return { base, home, wkHome, uvLog, fakeUv, env, run };
}

test('dry-run writes nothing and reports would-install', () => {
  const s = makeSandbox();
  try {
    const r = s.run(['install', '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.cli.state, 'would-install');
    assert.equal(out.cli.via, 'uv');
    assert.equal(out.antigravity.state, 'would-install');
    assert.equal(out.claude.state, 'would-install');
    assert.ok(!fs.existsSync(s.uvLog));
    assert.ok(!fs.existsSync(path.join(s.home, '.gemini')));
    assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

test('install installs CLI, Antigravity plugin, and Claude Code global skill, and is idempotent', () => {
  const s = makeSandbox();
  try {
    fs.mkdirSync(path.join(s.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(s.home, '.claude', 'CLAUDE.md'), '# Existing Rules\nKeep me.\n');

    const r1 = s.run(['install', '--json']);
    assert.equal(r1.status, 0, r1.stderr);
    const res1 = JSON.parse(r1.stdout);
    assert.equal(res1.ok, true);
    assert.equal(res1.cli.state, 'installed');
    assert.equal(res1.cli.version, GRAPHIFY_VERSION);
    assert.equal(res1.antigravity.state, 'installed');
    assert.equal(res1.claude.state, 'installed');
    assert.equal(res1.skillVault.state, 'bootstrapped');
    assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'skill-vault', 'index.json')), 'local skill vault index bootstrapped');

    assert.equal(fs.readFileSync(s.uvLog, 'utf8').trim(), `tool install --force ${GRAPHIFY_PKG}`);
    assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'config', 'plugins', 'watchkeeper', 'skills', 'graphify', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'config', 'plugins', 'watchkeeper', 'skills', 're-prompt', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'config', 'plugins', 'watchkeeper', 'mcp_config.json')));
    assert.ok(fs.existsSync(path.join(s.home, '.gemini', 'config', 'plugins', 'watchkeeper', 'rules', 'graphify.md')));
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'graphify', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'graphify', 'references', 'query.md')));

    const claudeMd = fs.readFileSync(path.join(s.home, '.claude', 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /^# Existing Rules\nKeep me\./);
    assert.match(claudeMd, /# graphify\n- \*\*graphify\*\* \(`~\/\.claude\/skills\/graphify\/SKILL\.md`\)/);

    const st = JSON.parse(s.run(['status', '--json']).stdout);
    assert.equal(st.cli.current, true);
    assert.equal(st.antigravity.current, true);
    assert.equal(st.claude.installed, true);
    assert.equal(st.claude.registered, true);
    assert.equal(st.reprompt.engine_present, true);
    assert.equal(st.reprompt.claude_mcp_json, true);
    assert.equal(st.reprompt.antigravity_mcp_json, true);
    assert.equal(st.reprompt.skill_vault_index, true);

    // Second run: completely idempotent, uv is not invoked again
    const r2 = s.run(['install', '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    const res2 = JSON.parse(r2.stdout);
    assert.equal(res2.cli.state, 'current');
    assert.equal(res2.antigravity.state, 'current');
    assert.equal(res2.claude.state, 'current');
    assert.equal(res2.skillVault.state, 'current');
    assert.equal(fs.readFileSync(s.uvLog, 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

test('standalone ~/.claude/plugins/re-prompt is backed up and consolidated during install', () => {
  const s = makeSandbox();
  try {
    const oldRePrompt = path.join(s.home, '.claude', 'plugins', 're-prompt');
    fs.mkdirSync(oldRePrompt, { recursive: true });
    fs.writeFileSync(path.join(oldRePrompt, 'plugin.json'), '{"name":"re-prompt"}\n');
    const r = s.run(['install', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.ok(!fs.existsSync(oldRePrompt), 'standalone claude re-prompt plugin removed');
    assert.ok(res.claude.removedStandaloneRePrompt && res.claude.removedStandaloneRePrompt.includes('claude-reprompt-'));
    assert.ok(fs.existsSync(path.join(res.claude.removedStandaloneRePrompt, 'plugin.json')));
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

test('kill switch stops install with exit 3 and changes nothing', () => {
  const s = makeSandbox();
  try {
    fs.mkdirSync(s.wkHome, { recursive: true });
    fs.writeFileSync(path.join(s.wkHome, 'KILL'), 'stop\n');
    const r = s.run(['install', '--json']);
    assert.equal(r.status, 3);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /kill switch/);
    assert.ok(!fs.existsSync(s.uvLog));
    assert.ok(!fs.existsSync(path.join(s.home, '.gemini')));
    assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  } finally {
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

const PUB_SCRIPT = path.join(ROOT, 'scripts', 'publish-public.mjs');
test('public-repo safety: all allowed files in repository (including Graphify files) pass blocklist', { skip: !fs.existsSync(PUB_SCRIPT) }, async () => {
  const { parseAllowlist, allowed, parseBlocklist, scanTree } = await import('../scripts/publish-public.mjs');
  const list = parseAllowlist(fs.readFileSync(path.join(ROOT, 'scripts', 'public-files.txt'), 'utf8'));
  const rules = parseBlocklist(fs.readFileSync(path.join(ROOT, 'scripts', 'public-blocklist.txt'), 'utf8'));
  const all = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .stdout.split('\0').filter(f => f && fs.existsSync(path.join(ROOT, f)));
  const pubFiles = all.filter(f => allowed(f, list));
  assert.ok(pubFiles.includes('bin/wk-graphify.mjs'), 'bin/wk-graphify.mjs is in public allowlist');
  assert.ok(pubFiles.includes('bin/wk-status.mjs'), 'bin/wk-status.mjs is in public allowlist');
  assert.ok(pubFiles.includes('.mcp.json'), '.mcp.json is in public allowlist');
  assert.ok(pubFiles.includes('reprompt/server/reprompt_mcp_server.py'), 'reprompt MCP server is in public allowlist');
  assert.ok(pubFiles.includes('skills/graphify/SKILL.md'), 'skills/graphify/SKILL.md is in public allowlist');
  assert.ok(pubFiles.includes('antigravity/plugins/watchkeeper/rules/graphify.md'), 'antigravity graphify rule is in public allowlist');
  assert.deepEqual(scanTree(ROOT, pubFiles, rules), [], 'zero blocklist hits across allowed files');
});
