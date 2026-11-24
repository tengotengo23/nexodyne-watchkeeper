#!/usr/bin/env node
// wk-graphify: unified installer & status for audited Graphify (graphifyy[mcp]==0.9.115)
// across the CLI, Antigravity (Watchkeeper plugin), and Claude Code (~/.claude).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gates, killOn, root } from './lib.mjs';
import { installAntigravity, antigravityStatus, findPython, passWords } from './antigravity-lib.mjs';
import { installSkillSync, readSyncStatus, runGrouped } from './wk-skill-sync.mjs';
// Every child runs in its own process group (runGrouped), so a timeout ends the whole tree, not only the first process.
const runChild = (bin, args, { env, timeout }) => runGrouped(bin, args, { env, timeoutMs: timeout, cwd: process.cwd() });

export const GRAPHIFY_VERSION = '0.9.115';
export const GRAPHIFY_PKG = `graphifyy[mcp]==${GRAPHIFY_VERSION}`;

const homedir = (env = process.env) => (env.HOME ? path.resolve(env.HOME) : os.homedir());
const tilde = (p, home = homedir()) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
const firstLine = s => String(s || '').trim().split('\n')[0].slice(0, 160) || 'unknown error';
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const isExec = p => {
  if (!p) return false;
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
};

function scanCandidates(name, { env = process.env, explicitKey, systemDirs = [], home = homedir(env) }) {
  if (explicitKey && env[explicitKey] !== undefined) {
    return env[explicitKey] && isExec(env[explicitKey]) ? env[explicitKey] : null;
  }
  const candidates = [path.join(home, '.local', 'bin', name)];
  if (env.WK_ISOLATE_PATH !== '1') {
    for (const d of systemDirs) candidates.push(path.join(d, name));
    for (const d of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(d, name));
    }
  }
  for (const p of candidates) if (isExec(p)) return p;
  return null;
}

export function findGraphify({ home, env = process.env } = {}) {
  const h = home || homedir(env);
  return scanCandidates('graphify', { env, explicitKey: 'WK_GRAPHIFY_BIN', home: h });
}

export function readGraphifyVersion(bin, env = process.env) {
  if (!bin) return null;
  const r = runChild(bin, ['--version'], { env, timeout: 10000 });
  if (r.status !== 0) return null;
  const m = /\b(\d+\.\d+\.\d+)\b/.exec((r.stdout || '') + '\n' + (r.stderr || ''));
  return m ? m[1] : null;
}

export function findInstaller({ home, env = process.env } = {}) {
  const h = home || homedir(env);
  const uv = scanCandidates('uv', { env, explicitKey: 'WK_UV_BIN', systemDirs: ['/opt/homebrew/bin', '/usr/local/bin'], home: h });
  if (uv) return { kind: 'uv', bin: uv };
  const pipx = scanCandidates('pipx', { env, explicitKey: 'WK_PIPX_BIN', systemDirs: ['/opt/homebrew/bin', '/usr/local/bin'], home: h });
  if (pipx) return { kind: 'pipx', bin: pipx };
  return null;
}

function isKillOn(wkDir) {
  try {
    const g = gates({ allowMismatch: true });
    if (killOn(g)) return true;
  } catch {
    return true;
  }
  const p = path.join(wkDir, 'KILL');
  try { fs.statSync(p); return true; } catch (e) { return !['ENOENT', 'ENOTDIR'].includes(e.code); }
}

function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

function skillRegistration(skillRef) {
  return [
    '# graphify',
    `- **graphify** (\`${skillRef}\`) - any input to knowledge graph. Trigger: \`/graphify\``,
    'When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.',
  ].join('\n');
}

function replaceOrAppendSection(content, marker, block) {
  const norm = content.replace(/\r\n/g, '\n');
  const lines = norm ? norm.split('\n') : [];
  const start = lines.findIndex(l => l.trim() === marker);
  let out;
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('# ')) { end = i; break; }
    }
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    while (before.length && before[before.length - 1] === '') before.pop();
    while (after.length && after[0] === '') after.shift();
    const parts = [];
    if (before.length) parts.push(before.join('\n'));
    parts.push(block);
    if (after.length) parts.push(after.join('\n'));
    out = parts.join('\n\n') + '\n';
  } else {
    const trimmed = norm.replace(/\s+$/, '');
    out = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }
  return out;
}

export function registerClaudeGlobal({ home, wkDir, dryRun = false, now = new Date(), env = process.env } = {}) {
  const h = home || homedir(env);
  const wkd = wkDir || path.resolve(env.WK_HOME || path.join(h, '.wk'));
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(h, '.claude');
  const srcDir = path.join(root(), 'skills', 'graphify');
  const dstDir = path.join(claudeDir, 'skills', 'graphify');
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  const skillRef = env.CLAUDE_CONFIG_DIR
    ? path.join(claudeDir, 'skills', 'graphify', 'SKILL.md')
    : '~/.claude/skills/graphify/SKILL.md';
  const block = skillRegistration(skillRef);

  const relFiles = walkFiles(srcDir);
  const skillsSame = fs.existsSync(dstDir) && relFiles.every(rel => {
    try { return fs.readFileSync(path.join(dstDir, rel)).equals(fs.readFileSync(path.join(srcDir, rel))); }
    catch { return false; }
  });
  let verSame = false;
  try { verSame = fs.readFileSync(path.join(dstDir, '.graphify_version'), 'utf8').trim() === GRAPHIFY_VERSION; } catch {}

  const mdExisted = fs.existsSync(claudeMd);
  const rawMd = mdExisted ? fs.readFileSync(claudeMd, 'utf8') : '';
  const newline = mdExisted && rawMd.includes('\r\n') ? '\r\n' : '\n';
  const nextMdNorm = replaceOrAppendSection(rawMd, '# graphify', block);
  const nextMd = newline === '\r\n' ? nextMdNorm.replace(/\n/g, '\r\n') : nextMdNorm;
  const mdSame = mdExisted && rawMd === nextMd;

  let removedStandaloneRePrompt = null;
  if (!dryRun) removedStandaloneRePrompt = tidyClaudeRePrompt(claudeDir, wkd, now);

  if (skillsSame && verSame && mdSame) {
    return {
      state: 'current',
      skillDir: dstDir,
      claudeMd,
      files: relFiles.length,
      ...(removedStandaloneRePrompt ? { removedStandaloneRePrompt } : {}),
    };
  }
  const existedBefore = fs.existsSync(dstDir) || (mdExisted && rawMd.split(/\r?\n/).some(l => l.trim() === '# graphify'));
  if (dryRun) {
    return { state: existedBefore ? 'would-update' : 'would-install', skillDir: dstDir, claudeMd, files: relFiles.length };
  }

  for (const rel of relFiles) {
    const p = path.join(dstDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), p);
  }
  fs.writeFileSync(path.join(dstDir, '.graphify_version'), `${GRAPHIFY_VERSION}\n`, { mode: 0o600 });

  let backup = null;
  if (!mdSame) {
    if (mdExisted) {
      backup = path.join(wkd, 'backups', `claude-md-${stamp(now)}.md`);
      for (let i = 2; fs.existsSync(backup); i++) backup = path.join(wkd, 'backups', `claude-md-${stamp(now)}-${i}.md`);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      fs.copyFileSync(claudeMd, backup);
    }
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, nextMd, 'utf8');
  }
  return { state: existedBefore ? 'updated' : 'installed', skillDir: dstDir, claudeMd, files: relFiles.length, backup, ...(removedStandaloneRePrompt ? { removedStandaloneRePrompt } : {}) };
}

function tidyClaudeRePrompt(claudeDir, wkd, now) {
  const oldClaudeRePrompt = path.join(claudeDir, 'plugins', 're-prompt');
  if (!fs.existsSync(oldClaudeRePrompt)) return null;
  let rpBak = path.join(wkd, 'backups', `claude-reprompt-${stamp(now)}`);
  for (let i = 2; fs.existsSync(rpBak); i++) rpBak = path.join(wkd, 'backups', `claude-reprompt-${stamp(now)}-${i}`);
  fs.mkdirSync(path.dirname(rpBak), { recursive: true, mode: 0o700 });
  fs.cpSync(oldClaudeRePrompt, rpBak, { recursive: true });
  fs.rmSync(oldClaudeRePrompt, { recursive: true, force: true });
  return rpBak;
}

function bootstrapSkillVault({ home, env = process.env, dryRun = false } = {}) {
  const vaultDir = env.REPROMPT_SKILL_VAULT_DIR
    ? path.resolve(env.REPROMPT_SKILL_VAULT_DIR)
    : path.join(home, '.gemini', 'skill-vault');
  const indexFile = path.join(vaultDir, 'index.json');
  if (fs.existsSync(indexFile)) return { state: 'current', index: indexFile };
  if (dryRun) return { state: 'would-bootstrap', index: indexFile };
  const script = path.join(root(), 'reprompt', 'scripts', 'skill_vault.py');
  if (!fs.existsSync(script)) return { state: 'missing-script', index: indexFile };
  const py = findPython({ env });
  const r = runChild(py, [script, 'bootstrap-local', '--json'], {
    env: { ...env, HOME: home },
    timeout: 15000,
  });
  if (r.status === 0) {
    try {
      const parsed = JSON.parse((r.stdout || '{}').trim());
      return { state: parsed.state || 'bootstrapped', skill_count: Number(parsed.skill_count || 0), index: parsed.index_file || indexFile };
    } catch {
      return { state: 'bootstrapped', index: indexFile };
    }
  }
  return { state: 'failed', index: indexFile, error: firstLine(r.stderr || r.stdout || `exit ${r.status}`) };
}

function withEnv(home, wkDir, fn) {
  const prevHome = process.env.HOME;
  const prevWk = process.env.WK_HOME;
  process.env.HOME = home;
  process.env.WK_HOME = wkDir;
  try { return fn(); }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevWk === undefined) delete process.env.WK_HOME; else process.env.WK_HOME = prevWk;
  }
}

export function installGraphify({ home, wkDir, pluginsDest, dryRun = false, skipCli = false, skipSkillSync = false, pass, now = new Date(), env = process.env } = {}) {
  const h = home || homedir(env);
  const wkd = wkDir || path.resolve(env.WK_HOME || path.join(h, '.wk'));
  const dest = pluginsDest || path.join(h, '.gemini', 'config', 'plugins');

  if (!dryRun && isKillOn(wkd)) {
    return { ok: false, code: 3, error: 'the kill switch is on, so nothing was installed' };
  }

  // 1. Graphify CLI (pinned to audited 0.9.115)
  let bin = findGraphify({ home: h, env });
  let ver = readGraphifyVersion(bin, env);
  let cli;
  if (ver === GRAPHIFY_VERSION) {
    cli = { state: 'current', version: ver, bin };
  } else if (skipCli || env.WK_SKIP_GRAPHIFY_CLI === '1') {
    cli = { state: 'skipped', version: ver, bin };
  } else {
    const installer = findInstaller({ home: h, env });
    if (dryRun) {
      cli = { state: installer ? 'would-install' : 'missing-installer', via: installer?.kind || null, pkg: GRAPHIFY_PKG, version: ver };
    } else if (!installer) {
      cli = { state: 'missing-installer', pkg: GRAPHIFY_PKG, version: ver, note: 'install uv (brew install uv) then re-run node bin/wk-graphify.mjs install' };
    } else {
      const cmdArgs = installer.kind === 'uv'
        ? ['tool', 'install', '--force', GRAPHIFY_PKG]
        : ['install', '--force', GRAPHIFY_PKG];
      const r = runChild(installer.bin, cmdArgs, { env: { ...env, HOME: h }, timeout: 180000 });
      bin = findGraphify({ home: h, env });
      ver = readGraphifyVersion(bin, env);
      if (r.status !== 0 || ver !== GRAPHIFY_VERSION) {
        cli = {
          state: 'failed',
          via: installer.kind,
          pkg: GRAPHIFY_PKG,
          version: ver,
          error: firstLine(r.stderr || r.stdout || r.error?.message || `expected ${GRAPHIFY_VERSION}, got ${ver || 'none'}`),
        };
      } else {
        cli = { state: 'installed', via: installer.kind, pkg: GRAPHIFY_PKG, version: ver, bin };
      }
    }
  }

  // 2. Antigravity plugin (includes bundled graphify + re-prompt skills, MCP, rules + consolidation)
  const antigravity = withEnv(h, wkd, () => installAntigravity({ dest, dryRun, now, pass }));

  // 3. Claude Code global skill + CLAUDE.md registration
  const claude = registerClaudeGlobal({ home: h, wkDir: wkd, dryRun, now, env });

  // 4. Local Skill Vault bootstrap (~/.gemini/skill-vault/index.json) if missing
  const skillVault = bootstrapSkillVault({ home: h, env, dryRun });

  // 5. Daily GitHub trending skill sync launchd agent (macOS interactive installs or explicit test env)
  let skillSync = { state: 'skipped' };
  const canLaunchd = process.platform === 'darwin' || Boolean(env.WK_LAUNCH_AGENTS);
  const allowAutoSync = !dryRun && !skipSkillSync && canLaunchd && (!home || Boolean(env.WK_LAUNCH_AGENTS) || env.WK_SKILL_SYNC_ON_INSTALL === '1') && env.WK_ISOLATE_PATH !== '1';
  if (allowAutoSync) {
    skillSync = withEnv(h, wkd, () => installSkillSync({ now, env }));
  } else if (dryRun && canLaunchd) {
    skillSync = { state: 'would-install-daily' };
  }

  const ok = cli.state !== 'failed';
  return { ok, code: ok ? 0 : 1, cli, antigravity, claude, skillVault, skillSync };
}

export function graphifyStatus({ home, wkDir, pluginsDest, env = process.env } = {}) {
  const h = home || homedir(env);
  const wkd = wkDir || path.resolve(env.WK_HOME || path.join(h, '.wk'));
  const dest = pluginsDest || path.join(h, '.gemini', 'config', 'plugins');

  const bin = findGraphify({ home: h, env });
  const ver = readGraphifyVersion(bin, env);
  const cli = {
    installed: Boolean(bin && ver),
    current: ver === GRAPHIFY_VERSION,
    version: ver,
    expected: GRAPHIFY_VERSION,
    bin,
  };

  const agy = withEnv(h, wkd, () => antigravityStatus({ dest }));
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(h, '.claude');
  const skillMd = path.join(claudeDir, 'skills', 'graphify', 'SKILL.md');
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  let registered = false;
  try { registered = fs.readFileSync(claudeMd, 'utf8').split(/\r?\n/).some(l => l.trim() === '# graphify'); } catch {}
  let claudeVer = null;
  try { claudeVer = fs.readFileSync(path.join(claudeDir, 'skills', 'graphify', '.graphify_version'), 'utf8').trim() || null; } catch {}

  const claude = {
    installed: fs.existsSync(skillMd),
    registered,
    version: claudeVer,
    skill: skillMd,
    claudeMd,
  };

  const vaultDir = env.REPROMPT_SKILL_VAULT_DIR
    ? path.resolve(env.REPROMPT_SKILL_VAULT_DIR)
    : path.join(h, '.gemini', 'skill-vault');
  const syncSt = withEnv(h, wkd, () => readSyncStatus({ env }));
  const reprompt = {
    engine_present: fs.existsSync(path.join(root(), 'reprompt', 'server', 'reprompt_engine.py')),
    claude_mcp_json: fs.existsSync(path.join(root(), '.mcp.json')),
    antigravity_mcp_json: Boolean(agy.mcp),
    skill_vault_index: fs.existsSync(path.join(vaultDir, 'index.json')),
    skill_sync: syncSt,
  };

  return { cli, antigravity: agy, claude, reprompt };
}

export function graphifyWords(r, env = process.env) {
  const h = homedir(env);
  if (!r.ok) return `wk-graphify: ${r.error || r.cli?.error || 'install failed'}`;
  const lines = [];
  if (r.cli.state === 'current') lines.push(`Graphify CLI: already up to date (${r.cli.version} at ${tilde(r.cli.bin, h)}).`);
  else if (r.cli.state === 'installed') lines.push(`Graphify CLI: installed ${r.cli.pkg} via ${r.cli.via} (${tilde(r.cli.bin, h)}).`);
  else if (r.cli.state === 'would-install') lines.push(`Graphify CLI: would install ${r.cli.pkg} via ${r.cli.via}.`);
  else if (r.cli.state === 'missing-installer') lines.push(`Graphify CLI: ${r.cli.note || 'installer not found'}.`);
  else if (r.cli.state === 'skipped') lines.push(`Graphify CLI: skipped (${r.cli.version ? `found ${r.cli.version}` : 'not installed'}).`);

  const agyWords = {
    current: 'already up to date',
    installed: 'installed',
    updated: 'updated',
    'would-install': 'would be installed',
    'would-update': 'would be updated',
  };
  const agy = r.antigravity;
  const dupNote = agy.removedDuplicates?.length ? `; consolidated ${agy.removedDuplicates.length} standalone item(s)` : '';
  lines.push(`Antigravity plugin ${agyWords[agy.state] || agy.state}: ${tilde(agy.target, h)} (${agy.files.length} files${dupNote}).`);
  if (agy.pass) lines.push(passWords(agy.pass));

  const c = r.claude;
  const claudeWords = {
    current: 'already up to date',
    installed: 'installed',
    updated: 'updated',
    'would-install': 'would be installed',
    'would-update': 'would be updated',
  };
  lines.push(`Claude Code skill ${claudeWords[c.state] || c.state}: ${tilde(c.skillDir, h)} (${c.files} files) and ${tilde(c.claudeMd, h)}.`);
  if (r.skillVault) {
    const sv = r.skillVault;
    if (sv.state === 'bootstrapped') lines.push(`Skill Vault: bootstrapped local index (${sv.skill_count || 0} skills) at ${tilde(sv.index, h)}.`);
    else if (sv.state === 'current') lines.push(`Skill Vault: already indexed at ${tilde(sv.index, h)}.`);
    else if (sv.state === 'would-bootstrap') lines.push(`Skill Vault: would bootstrap local index at ${tilde(sv.index, h)}.`);
    else if (sv.state === 'failed') lines.push(`Skill Vault: bootstrap warning (${sv.error || 'unknown error'}).`);
  }
  if (r.skillSync && r.skillSync.state && r.skillSync.state !== 'skipped') {
    const ss = r.skillSync;
    if (ss.state === 'installed') lines.push(`Daily Trending Skill Sync: enabled (once/day launchd at ${tilde(ss.plist, h)}).`);
    else if (ss.state === 'would-install-daily') lines.push('Daily Trending Skill Sync: would enable once/day GitHub trending sync.');
    else if (!ss.ok && ss.message) lines.push(`Daily Trending Skill Sync: ${ss.message}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { cmd: argv[0] || '', dryRun: false, skipCli: false, json: false, pass: undefined };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--dry-run') o.dryRun = true;
    else if (x === '--skip-cli') o.skipCli = true;
    else if (x === '--json') o.json = true;
    else if (x === '--pass') {
      o.pass = a.shift();
      if (!['allow', 'ask', 'detect'].includes(o.pass)) throw new Error('--pass must be allow, ask or detect');
    } else throw new Error(`unknown option ${x.slice(0, 40)}`);
  }
  return o;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'install') {
      const r = installGraphify({ dryRun: o.dryRun, skipCli: o.skipCli, pass: o.pass });
      if (o.json) console.log(JSON.stringify(r));
      else if (!r.ok) console.error(graphifyWords(r));
      else console.log(graphifyWords(r));
      process.exitCode = r.code;
    } else if (o.cmd === 'status') {
      const s = graphifyStatus();
      if (o.json) console.log(JSON.stringify(s));
      else {
        const h = homedir();
        console.log([
          `Graphify CLI: ${s.cli.installed ? `${s.cli.version} (${tilde(s.cli.bin, h)}; ${s.cli.current ? 'matches pinned ' + s.cli.expected : 'expected ' + s.cli.expected})` : 'not installed'}`,
          `Antigravity plugin: ${s.antigravity.installed ? `${tilde(s.antigravity.target, h)} (${s.antigravity.current ? 'up to date' : 'differs'}; skills: ${s.antigravity.skills.join(', ')}; rules: ${s.antigravity.rules.join(', ')})` : 'not installed'}`,
          `Claude Code skill: ${s.claude.installed ? `${tilde(s.claude.skill, h)} (version ${s.claude.version || 'unknown'}; CLAUDE.md ${s.claude.registered ? 'registered' : 'not registered'})` : 'not installed'}`,
        ].join('\n'));
      }
      process.exitCode = 0;
    } else {
      console.error('usage: wk-graphify install|status [--dry-run] [--skip-cli] [--pass allow|ask|detect] [--json]');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`wk-graphify: ${e.message}`);
    process.exitCode = 1;
  }
}
