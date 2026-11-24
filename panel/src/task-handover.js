'use strict';
// Watchkeeper Panel <-> Shared Workspace / Task Queue handover helpers (no vscode dependency).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const END_SENTINEL = 'WK-HANDOFF-END';

function parseTakeTaskCommand(prompt) {
  const m = /^\s*\/wk-take-task(?:\s+([A-Za-z0-9_-]{4,80}))?\s*$/i.exec(String(prompt || ''));
  return m ? { taskId: m[1] || '' } : null;
}

function parseHandoffClaudeCommand(prompt) {
  const m = /^\s*\/(?:wk-handoff-claude|claude-takeover)(?:\s+([\s\S]+))?$/i.exec(String(prompt || ''));
  return m ? { note: (m[1] || '').trim() } : null;
}

function scrubSecrets(text) {
  let s = String(text ?? '');
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  s = s.replace(/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]');
  s = s.replace(/\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/g, '[REDACTED_KEY]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  s = s.replace(/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*(['"]?)[^\s'"]{8,}\2/gi, '$1=[REDACTED]');
  return s;
}

function normWs(p) {
  if (!p || typeof p !== 'string') return '';
  const abs = path.resolve(p.trim());
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function execFileAsync(bin, args, { cwd, env, timeoutMs = 10000, maxBuffer = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        ok: !err,
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function buildNodeEnv(dataDir) {
  const env = { ...process.env, HOME: process.env.HOME || os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', WK_HOME: dataDir };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function collectWorkspaceSnapshot(workspaceDir) {
  const ws = normWs(workspaceDir);
  const empty = { isGit: false, workspace: ws, branch: '', sha7: '', dirtyFiles: [], recentCommits: [] };
  if (!ws || !fs.existsSync(ws)) return empty;
  const runGit = async (args) => {
    const r = await execFileAsync('git', args, { cwd: ws, timeoutMs: 5000 });
    return r.ok ? r.stdout.trim() : null;
  };
  const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return empty;
  const [branch, sha7, statusOut, logOut] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(['rev-parse', '--short', 'HEAD']),
    runGit(['status', '--porcelain']),
    runGit(['log', '-3', '--oneline']),
  ]);
  const dirtyFiles = String(statusOut || '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 25);
  const recentCommits = String(logOut || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  return { isGit: true, workspace: ws, branch: branch || '', sha7: sha7 || '', dirtyFiles, recentCommits };
}

async function takeQueuedTask(pluginPath, dataDir, { taskId = '', modelUsed = 'gemini-pro-orchestrator', nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-task.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, code: 1, meta: null, taskMarkdown: '', error: 'wk-task.mjs is missing in the plugin directory.' };
  }
  const args = [script, 'take', '--json'];
  if (taskId) args.push('--id', taskId);
  if (modelUsed) args.push('--model-used', modelUsed);
  const r = await execFileAsync(nodeBin || process.execPath, args, {
    cwd: pluginPath,
    env: buildNodeEnv(dataDir),
    timeoutMs: 25000,
    maxBuffer: 512 * 1024,
  });
  if (!r.ok) {
    const errMsg = (r.stderr || r.stdout || `wk-task take exited ${r.code}`).trim().split('\n')[0];
    return { ok: false, code: r.code, meta: null, taskMarkdown: '', error: errMsg };
  }
  let meta;
  try {
    meta = JSON.parse(r.stdout.trim());
  } catch (e) {
    return { ok: false, code: 1, meta: null, taskMarkdown: '', error: `Invalid wk-task output: ${e.message}` };
  }
  let taskMarkdown = '';
  try {
    taskMarkdown = fs.readFileSync(path.join(dataDir, 'tasks', meta.id, 'task.md'), 'utf8').trim();
  } catch {
    taskMarkdown = `# ${meta.title || meta.id}`;
  }
  return { ok: true, code: 0, meta, taskMarkdown, error: '' };
}

async function finishTakenTask(pluginPath, dataDir, { taskId, modelUsed = 'gemini-pro-orchestrator', note = '', nodeBin } = {}) {
  const script = path.join(pluginPath, 'bin', 'wk-task.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, code: 1, out: '', err: 'wk-task.mjs is missing in the plugin directory.' };
  }
  const cleanNote = scrubSecrets(String(note || '').replace(/\s+/g, ' ').trim()).slice(0, 600);
  const args = [script, 'done', taskId];
  if (modelUsed) args.push('--model-used', modelUsed);
  if (cleanNote) args.push('--note', cleanNote);
  const r = await execFileAsync(nodeBin || process.execPath, args, {
    cwd: pluginPath,
    env: buildNodeEnv(dataDir),
    timeoutMs: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: r.ok,
    code: r.code,
    out: r.stdout.trim().slice(0, 600),
    err: r.stderr.trim().slice(0, 600),
  };
}

function buildTakeTaskExecutionPrompt(meta, taskMarkdown, workspaceSnap) {
  const wt = meta.worktree || '';
  const allow = Array.isArray(meta.allow) && meta.allow.length ? meta.allow.join(', ') : '**';
  const branchInfo = workspaceSnap && workspaceSnap.isGit
    ? `Repo branch \`${workspaceSnap.branch}\` (${workspaceSnap.sha7})`
    : 'Git worktree isolated for this task';
  return [
    `## Goal`,
    `Execute Watchkeeper task \`${meta.id}\`: ${meta.title}`,
    '',
    '## Context & Scope',
    `- Isolated Worktree (ALL file reads, edits, and test commands MUST run here): \`${wt}\``,
    `- Origin Repository (do NOT edit directly): \`${meta.repo}\` (${branchInfo})`,
    `- Allowed File Globs: \`${allow}\``,
    `- Required Test Command: \`${meta.test || 'none set — run targeted checks for modified files'}\``,
    `- Graphify: if \`graphify-out/graph.json\` exists in \`${wt}\`, query it first (\`graphify query/path/explain\`) and run \`graphify update .\` after editing code.`,
    '',
    '## Watchkeeper Task Brief',
    taskMarkdown || `# ${meta.title}`,
    '',
    '## Execution Rules & Verification',
    '- Execute immediately in the worktree without pausing to ask for confirmation.',
    '- Modify ONLY files inside the worktree matching the allowed file globs above.',
    '- Never commit, push, deploy, or read `.env` / secrets.',
    '- Run the required test command inside the worktree after edits and summarize exact changed files + observed test results (Watchkeeper will automatically run `wk-task done` next).',
  ].join('\n');
}

function buildClaudeTakeoverPrompt(transcript, workspaceSnap, sharedWorkspace) {
  const ws = normWs(sharedWorkspace || (transcript && transcript.cwd) || '');
  const dirtyLines = workspaceSnap && workspaceSnap.dirtyFiles && workspaceSnap.dirtyFiles.length
    ? workspaceSnap.dirtyFiles.slice(0, 20).map(f => `- ${f}`).join('\n')
    : '- (clean git working tree)';
  const turns = Array.isArray(transcript && transcript.turns) ? transcript.turns.slice(-8) : [];
  const historyLines = turns.length
    ? turns.map(t => `- **${t.role === 'user' ? 'User' : (t.model || 'Claude')}**: ${scrubSecrets(String(t.text || '')).replace(/\s+/g, ' ').slice(0, 420)}`).join('\n')
    : '- (No recent transcript turns parsed — inspect workspace files directly.)';

  return [
    '## Goal',
    `Continue Claude Code session "${(transcript && transcript.title) || 'Active Session'}" in the shared workspace.`,
    '',
    '## Shared Workspace Context',
    `- Shared Workspace Path (EXACT shared project folder): \`${ws}\``,
    workspaceSnap && workspaceSnap.isGit
      ? `- Git Branch: \`${workspaceSnap.branch || 'HEAD'}\` (\`${workspaceSnap.sha7 || 'unknown'}\`)`
      : '- Git: non-git workspace',
    `- Claude Session ID: \`${(transcript && transcript.id) || 'unknown'}\` (${(transcript && transcript.model) || 'Claude'})`,
    `- Uncommitted Workspace Files:\n${dirtyLines}`,
    '',
    '## Recent Work From Claude Code (Do Not Ask User To Re-Explain)',
    historyLines,
    '',
    '## Execution Instructions',
    '- You are taking over this work seamlessly inside the EXACT same shared workspace (`cwd`).',
    '- First check `git status`, inspect `graphify-out/` if present, and read any relevant modified files on disk.',
    '- Continue the next concrete engineering steps directly and verify changes without asking the user to confirm or re-describe the handover.',
  ].join('\n');
}

const pad2 = n => String(n).padStart(2, '0');
function formatStamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function writePrivateAtomic(file, content, isJson = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = isJson ? JSON.stringify(content, null, 2) + '\n' : content;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readSharedStore(dataDir) {
  const file = path.join(dataDir, 'shared-workspace.json');
  try {
    if (!fs.existsSync(file)) return { version: 1, workspaces: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.workspaces && typeof parsed.workspaces === 'object') return parsed;
  } catch {}
  return { version: 1, workspaces: {} };
}

function readSharedWorkspace(dataDir, workspaceDir) {
  const ws = normWs(workspaceDir);
  if (!ws) return null;
  const store = readSharedStore(dataDir);
  return store.workspaces[ws] || null;
}

function publishSharedHandoff(dataDir, payload = {}) {
  const ws = normWs(payload.workspace || '');
  if (!ws) throw new Error('workspace is required for publishSharedHandoff');
  const fromEngine = payload.fromEngine || 'antigravity';
  const toEngine = payload.toEngine || 'any';
  const title = scrubSecrets(String(payload.title || `Shared work in ${path.basename(ws)}`).replace(/\s+/g, ' ').trim()).slice(0, 140);
  const summary = scrubSecrets(String(payload.summary || '').trim()).slice(0, 4000);
  const nextSteps = scrubSecrets(String(payload.nextSteps || '').trim()).slice(0, 2000);
  const snap = payload.gitSnapshot || null;
  const recentTurns = Array.isArray(payload.recentTurns) ? payload.recentTurns : [];

  const now = new Date();
  const rand = crypto.randomBytes(4).toString('hex');
  const handoffFile = path.join(dataDir, 'handoff', `${formatStamp(now)}-wk-${rand}.md`);
  const sessionPtrFile = path.join(dataDir, 'handoff', 'sessions', `wk-${rand}.json`);
  const sharedFile = path.join(dataDir, 'shared-workspace.json');

  const lines = [
    `# Continue — ${now.toISOString().slice(0, 16).replace('T', ' ')} (${fromEngine} → ${toEngine})`,
    '',
    '## Goal',
    title,
    '',
    '## Done',
    summary || 'Work completed in Watchkeeper simulated session.',
    recentTurns.length ? '\nRecent Turns:\n' + recentTurns.map(t => `- ${scrubSecrets(String(t)).slice(0, 350)}`).join('\n') : null,
    '',
    '## State',
    `- Shared Workspace: \`${ws}\``,
    snap && snap.isGit ? `- Git Branch: \`${snap.branch || 'HEAD'}\` (\`${snap.sha7 || 'unknown'}\`)` : null,
    snap && Array.isArray(snap.dirtyFiles) && snap.dirtyFiles.length
      ? `- Uncommitted Files:\n${snap.dirtyFiles.slice(0, 20).map(f => `  - ${f}`).join('\n')}`
      : null,
    payload.taskId ? `- Watchkeeper Task: \`${payload.taskId}\`${payload.worktree ? ` (Worktree: \`${payload.worktree}\`)` : ''}` : null,
    '',
    '## Next',
    nextSteps || `1. Run \`/wk-take-task\` or inspect \`${ws}\` and continue seamlessly.`,
    '',
    '## Decisions and rules',
    '- Work in the shared workspace above, use Graphify when present, verify tests, and never print secrets.',
    '',
    '## Resume prompt',
    `Continue seamlessly in ${ws}: ${title}.`,
    '',
    END_SENTINEL,
    '',
  ].filter(v => v !== null);

  writePrivateAtomic(handoffFile, lines.join('\n'), false);
  writePrivateAtomic(sessionPtrFile, {
    session: `wk-${rand}`,
    cwd: ws,
    ready_at: now.toISOString(),
    asked_at: now.toISOString(),
    why: 'shared workspace handoff',
    file: handoffFile,
    from_engine: fromEngine,
    to_engine: toEngine,
  }, true);

function withFileLock(lockFile, fn, { waitMs = 5000, staleMs = 60000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, token + '\n');
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > until) throw new Error('timed out waiting for shared-workspace lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  try {
    return fn();
  } finally {
    try {
      const cur = fs.readFileSync(lockFile, 'utf8').trim();
      if (cur === token) fs.rmSync(lockFile, { force: true });
    } catch { /* ignore */ }
  }
}

  withFileLock(path.join(dataDir, 'shared-workspace.lock'), () => {
    const store = readSharedStore(dataDir);
    store.workspaces[ws] = {
      workspace: ws,
      updated_at: now.toISOString(),
      from_engine: fromEngine,
      to_engine: toEngine,
      title,
      summary,
      next_steps: nextSteps,
      wk_session_id: payload.wkSessionId || '',
      agy_conversation_id: payload.agyConversationId || '',
      claude_session_id: payload.claudeSessionId || '',
      task_id: payload.taskId || '',
      worktree: payload.worktree || '',
      handoff_file: handoffFile,
      git_branch: (snap && snap.branch) || '',
      changed_files: (snap && snap.dirtyFiles) || [],
      consumed_by: null,
    };
    writePrivateAtomic(sharedFile, store, true);
  });

  const claudePrompt = [
    `/wk-take-task`,
    `Shared Workspace: ${ws}`,
    `Handoff File: ${handoffFile}`,
    `Summary: ${title}`,
  ].join('\n');

  return { handoffFile, sharedFile, claudePrompt };
}

module.exports = {
  parseTakeTaskCommand,
  parseHandoffClaudeCommand,
  scrubSecrets,
  normWs,
  collectWorkspaceSnapshot,
  takeQueuedTask,
  finishTakenTask,
  buildTakeTaskExecutionPrompt,
  buildClaudeTakeoverPrompt,
  publishSharedHandoff,
  readSharedWorkspace,
};
