#!/usr/bin/env node
// wk-takeover: Shared Antigravity <-> Claude Code workspace & task handover CLI.
// Coordinates Watchkeeper queued tasks (worktrees via wk-task.mjs) and direct shared-workspace session handovers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BIN = path.dirname(new URL(import.meta.url).pathname);
const TASK_ID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/;
const END_SENTINEL = 'WK-HANDOFF-END';

const wkHome = () => (process.env.WK_HOME ? path.resolve(process.env.WK_HOME) : path.join(os.homedir(), '.wk'));
const claudeDir = () => (process.env.WK_CLAUDE_DIR ? path.resolve(process.env.WK_CLAUDE_DIR) : path.join(os.homedir(), '.claude'));
const killActive = () => fs.existsSync(path.join(wkHome(), 'KILL'));

export function normWs(p) {
  if (!p || typeof p !== 'string') return '';
  const abs = path.resolve(p.trim());
  try { return fs.realpathSync(abs); } catch { return abs; }
}

export function scrubSecrets(text) {
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

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function writePrivateText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

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

const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

export function gitSnapshot(cwd) {
  const ws = normWs(cwd);
  const empty = { isGit: false, branch: '', head: '', changedFiles: [], recentCommits: [] };
  if (!ws || !fs.existsSync(ws)) return empty;
  const runGit = args => {
    try {
      return execFileSync('git', args, { cwd: ws, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return null;
    }
  };
  const inside = runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return empty;
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
  const head = runGit(['rev-parse', '--short', 'HEAD']) || '';
  const por = runGit(['status', '--porcelain']) || '';
  const changedFiles = por.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 30);
  const log = runGit(['log', '-3', '--oneline']) || '';
  const recentCommits = log.split('\n').map(l => l.trim()).filter(Boolean);
  return { isGit: true, branch, head, changedFiles, recentCommits };
}

function readHeadTailCapped(file, cap = 64 * 1024) {
  const st = fs.statSync(file);
  if (!st.isFile()) return '';
  if (st.size <= cap) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const b1 = Buffer.alloc(Math.floor(cap / 2));
    const r1 = fs.readSync(fd, b1, 0, b1.length, 0);
    const b2 = Buffer.alloc(Math.floor(cap / 2));
    const r2 = fs.readSync(fd, b2, 0, b2.length, Math.max(0, st.size - b2.length));
    return `${b1.toString('utf8', 0, r1)}\n${b2.toString('utf8', 0, r2).split('\n').slice(1).join('\n')}`;
  } finally {
    fs.closeSync(fd);
  }
}

export function findNewestClaudeSessionForCwd(cDir, cwd) {
  const target = normWs(cwd);
  if (!target) return null;
  const root = path.join(cDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const cands = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(root, d.name, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) cands.push({ id: f.slice(0, -6), file: p, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of cands.slice(0, 60)) {
    let raw = '';
    try { raw = readHeadTailCapped(c.file, 64 * 1024); } catch { continue; }
    let sessCwd = '', title = '', model = '';
    const turns = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!sessCwd && typeof o.cwd === 'string' && o.cwd.trim()) sessCwd = normWs(o.cwd);
      if (o.type === 'summary' && typeof o.summary === 'string') title = o.summary;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = o.customTitle;
      if (o.type === 'user' && !o.isMeta && !o.isSidechain && o.message) {
        const content = o.message.content;
        const txt = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(' ')
            : '';
        const clean = scrubSecrets(txt.replace(/\s+/g, ' ').trim());
        if (clean) {
          if (!title) title = clean.slice(0, 80);
          turns.push({ role: 'user', text: clean.slice(0, 600) });
        }
      } else if (o.type === 'assistant' && o.message) {
        if (typeof o.message.model === 'string' && o.message.model !== '<synthetic>') model = o.message.model;
        const content = o.message.content;
        const txt = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
            : '';
        const clean = scrubSecrets(txt.trim());
        if (clean) turns.push({ role: 'assistant', text: clean.slice(0, 800) });
      }
    }
    if (sessCwd && sessCwd === target && turns.length) {
      return {
        id: c.id,
        title: title || 'Claude Code Session',
        model: model || 'Claude',
        cwd: sessCwd,
        updatedAt: new Date(c.mtimeMs).toISOString(),
        turns: turns.slice(-6),
      };
    }
  }
  return null;
}

export function findNewestWkSessionForCwd(dataDir, cwd) {
  const target = normWs(cwd);
  if (!target) return null;
  const parsed = readJsonSafe(path.join(dataDir, 'chat-sessions.json'), null);
  const list = Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
  const matching = list
    .filter(s => s && typeof s === 'object' && normWs(s.workspace) === target && Array.isArray(s.turns) && s.turns.length)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (!matching.length) return null;
  const s = matching[0];
  return {
    id: s.id,
    title: s.title || 'Watchkeeper Session',
    workspace: normWs(s.workspace),
    agyConversationId: s.agyConversationId || '',
    taskId: s.taskId || '',
    worktree: s.worktree || '',
    updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : '',
    turns: (s.turns || []).slice(-4).map(t => ({
      rawPrompt: scrubSecrets(t.rawPrompt || '').slice(0, 500),
      answer: scrubSecrets(t.answer || '').slice(0, 900),
      answerModel: t.answerModel || t.plannedModel || '',
      status: t.status || '',
    })),
  };
}

function listAllTasks(dataDir) {
  const dir = path.join(dataDir, 'tasks');
  let names = [];
  try { names = fs.readdirSync(dir).filter(x => TASK_ID_RE.test(x)).sort(); } catch { return []; }
  const out = [];
  for (const id of names) {
    const m = readJsonSafe(path.join(dir, id, 'meta.json'), null);
    if (m && m.id === id) out.push(m);
  }
  return out;
}

const sharedFilePath = dataDir => path.join(dataDir, 'shared-workspace.json');

export function loadSharedStore(dataDir) {
  const raw = readJsonSafe(sharedFilePath(dataDir), null);
  if (raw && raw.workspaces && typeof raw.workspaces === 'object') return raw;
  return { version: 1, workspaces: {} };
}

export function publishHandoff({
  cwd,
  from = 'claude',
  to = 'any',
  title = '',
  summary = '',
  nextSteps = '',
  sessionId = '',
  agyConv = '',
  claudeSession = '',
  taskId = '',
  worktree = '',
}, dataDir = wkHome()) {
  if (killActive()) {
    const e = new Error('Kill switch active (~/.wk/KILL).');
    e.code = 3;
    throw e;
  }
  const ws = normWs(cwd);
  if (!ws) throw new Error('--cwd is required');
  const snap = gitSnapshot(ws);
  const cleanTitle = scrubSecrets(String(title || `Session in ${path.basename(ws)}`).replace(/\s+/g, ' ').trim()).slice(0, 140);
  const cleanSummary = scrubSecrets(String(summary || '').trim()).slice(0, 4000);
  const cleanNext = scrubSecrets(String(nextSteps || '').trim()).slice(0, 2000);
  const now = new Date();
  const rand = crypto.randomBytes(4).toString('hex');
  const mdName = `${stamp(now)}-wk-${rand}.md`;
  const mdFile = path.join(dataDir, 'handoff', mdName);
  const sessFile = path.join(dataDir, 'handoff', 'sessions', `wk-${rand}.json`);

  const mdLines = [
    `# Continue — ${now.toISOString().slice(0, 16).replace('T', ' ')} (${from} → ${to})`,
    '',
    '## Goal',
    cleanTitle,
    '',
    '## Done',
    cleanSummary || 'Active shared workspace handoff.',
    '',
    '## State',
    `- Shared Workspace: \`${ws}\``,
    snap.isGit ? `- Git Branch: \`${snap.branch || 'HEAD'}\` (${snap.head || 'unknown'})` : '- Git: not a git repository',
    snap.changedFiles.length ? `- Modified/Untracked Files:\n${snap.changedFiles.map(f => `  - ${f}`).join('\n')}` : '- Working Tree: clean',
    taskId ? `- Watchkeeper Task: \`${taskId}\`${worktree ? ` (Worktree: \`${worktree}\`)` : ''}` : null,
    '',
    '## Next',
    cleanNext || '1. Inspect the shared workspace files above and seamlessly continue executing the task without asking for re-explanation.',
    '',
    '## Decisions and rules',
    '- Preserve existing behavior, verify changes cleanly with tests, and never print or touch secrets.',
    '',
    '## Resume prompt',
    `Continue seamlessly in ${ws}${taskId ? ` (task ${taskId})` : ''}: ${cleanTitle}.`,
    '',
    END_SENTINEL,
    '',
  ].filter(l => l !== null);

  writePrivateText(mdFile, mdLines.join('\n'));
  writePrivateJson(sessFile, {
    session: `wk-${rand}`,
    cwd: ws,
    asked_at: now.toISOString(),
    ready_at: now.toISOString(),
    why: 'shared workspace handoff',
    file: mdFile,
    from_engine: from,
    to_engine: to,
  });

  const entry = {
    workspace: ws,
    updated_at: now.toISOString(),
    from_engine: from,
    to_engine: to,
    title: cleanTitle,
    summary: cleanSummary,
    next_steps: cleanNext,
    wk_session_id: sessionId || '',
    agy_conversation_id: agyConv || '',
    claude_session_id: claudeSession || '',
    task_id: taskId || '',
    worktree: worktree || '',
    handoff_file: mdFile,
    git_branch: snap.branch,
    changed_files: snap.changedFiles,
    consumed_by: null,
  };
  withFileLock(path.join(dataDir, 'shared-workspace.lock'), () => {
    const store = loadSharedStore(dataDir);
    store.workspaces[ws] = entry;
    writePrivateJson(sharedFilePath(dataDir), store);
  });
  return { ok: true, workspace: ws, handoff_file: mdFile, shared_file: sharedFilePath(dataDir), entry };
}

function buildTaskBrief(meta, dataDir) {
  let taskMd = '';
  try { taskMd = fs.readFileSync(path.join(dataDir, 'tasks', meta.id, 'task.md'), 'utf8').trim(); } catch {}
  const doneBin = path.join(BIN, 'wk-task.mjs');
  return [
    `[Watchkeeper /wk-take-task — Queued Task ${meta.id}]`,
    `Title: ${meta.title}`,
    `Repository: ${meta.repo}`,
    `Worktree: ${meta.worktree || path.join(dataDir, 'worktrees', meta.id)}`,
    `Kind: ${meta.kind} · Suggested model: ${meta.model || 'gemini-pro-orchestrator'}`,
    `Allowed files: ${(meta.allow || ['**']).join(', ')}`,
    `Test command: ${meta.test || 'none set'}`,
    '',
    'Execution Rules:',
    '- Work ONLY inside the Worktree path above. Never modify the main repository directly on a queued task.',
    '- When `graphify-out/graph.json` exists in the worktree, query it first and run `graphify update .` after edits.',
    '- Do not commit or push. Verify all tests/checks pass, then finish with:',
    `  "${process.execPath}" "${doneBin}" done ${meta.id} --model-used "${meta.model_used || meta.model || 'claude'}" --note "<concise summary of changes and test results>"`,
    '',
    'Task Specification:',
    taskMd || `# ${meta.title}`,
  ].join('\n');
}

function buildHandoffBrief({ ws, snap, sharedEntry, claudeSess, wkSess, engine }) {
  const gfExists = fs.existsSync(path.join(ws, 'graphify-out', 'graph.json'));
  const lines = [
    `[Watchkeeper Shared Workspace Takeover — ${engine === 'claude' ? 'Claude Code' : 'Antigravity'}]`,
    `Shared Workspace: ${ws}`,
    snap.isGit ? `Git: branch \`${snap.branch || 'HEAD'}\` @ \`${snap.head || 'unknown'}\`` : 'Git: non-git workspace',
    `Graphify AST Graph: ${gfExists ? 'Present (`graphify-out/graph.json` — query before broad grep; update after edits)' : 'Not generated'}`,
  ];
  if (snap.changedFiles.length) {
    lines.push('Current Uncommitted Changes:');
    for (const f of snap.changedFiles.slice(0, 20)) lines.push(`- ${f}`);
  }
  if (sharedEntry) {
    lines.push('', `Latest Handoff (${sharedEntry.from_engine} → ${sharedEntry.to_engine}, ${sharedEntry.updated_at}):`, `**${sharedEntry.title}**`);
    if (sharedEntry.summary) lines.push(sharedEntry.summary);
    if (sharedEntry.next_steps) lines.push('', 'Next Steps:', sharedEntry.next_steps);
    if (sharedEntry.task_id) lines.push(`Watchkeeper Task Ref: \`${sharedEntry.task_id}\`${sharedEntry.worktree ? ` · Worktree: \`${sharedEntry.worktree}\`` : ''}`);
  }
  if (engine === 'antigravity' && claudeSess) {
    lines.push('', `Active/Recent Claude Code Session (${claudeSess.id}, ${claudeSess.model}): ${claudeSess.title}`);
    for (const t of claudeSess.turns) lines.push(`- [${t.role}] ${t.text.replace(/\s+/g, ' ').slice(0, 320)}`);
  }
  if (engine === 'claude' && wkSess) {
    lines.push('', `Recent Watchkeeper/Antigravity Simulated Session (${wkSess.id}): ${wkSess.title}`);
    for (const t of wkSess.turns) {
      if (t.rawPrompt) lines.push(`- [user] ${t.rawPrompt.replace(/\s+/g, ' ').slice(0, 260)}`);
      if (t.answer) lines.push(`- [${t.answerModel || 'antigravity'}] ${t.answer.replace(/\s+/g, ' ').slice(0, 340)}`);
    }
  }
  lines.push(
    '',
    'Action:',
    'You are seamlessly taking over this ongoing work in the EXACT same shared workspace above.',
    'Inspect current workspace files on disk, verify any uncommitted state, and continue executing directly without asking the user to re-explain the task or approve handover.'
  );
  return lines.join('\n');
}

export function getBrief({
  cwd = process.cwd(),
  engine = 'claude',
  id = '',
  claim = false,
  modelUsed = '',
  consume = false,
} = {}, dataDir = wkHome(), cDir = claudeDir()) {
  if (killActive()) return { ok: false, code: 3, error: 'The kill switch is on (~/.wk/KILL), so Watchkeeper does no work.' };
  const ws = normWs(cwd);
  const tasks = listAllTasks(dataDir);

  let targetTask = null;
  if (id && TASK_ID_RE.test(id)) {
    targetTask = tasks.find(t => t.id === id) || null;
  } else if (claim) {
    const queued = tasks.filter(t => t.status === 'queued');
    targetTask = (ws && queued.find(t => normWs(t.repo) === ws)) || queued[0] || null;
  }

  if (targetTask) {
    let meta = targetTask;
    if (meta.status === 'queued' && claim) {
      const takeArgs = [path.join(BIN, 'wk-task.mjs'), 'take', '--id', meta.id, '--json'];
      if (modelUsed) takeArgs.push('--model-used', modelUsed);
      try {
        const out = execFileSync(process.execPath, takeArgs, {
          encoding: 'utf8',
          timeout: 20000,
          env: { ...process.env, WK_HOME: dataDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        meta = JSON.parse(out.trim());
      } catch (err) {
        const code = Number.isInteger(err && err.status) && err.status > 0 ? err.status : 1;
        const msg = String((err && (err.stderr || err.stdout)) || (err && err.message) || err).trim().split('\n')[0];
        return { ok: false, code, error: msg || `wk-task take exited ${code}` };
      }
    }
    const brief = buildTaskBrief(meta, dataDir);
    return { ok: true, code: 0, kind: 'task', task_id: meta.id, workspace: meta.repo, worktree: meta.worktree || '', brief };
  }

  let sharedEntry = null;
  let brief = '';
  const claudeSess = engine === 'antigravity' && ws ? findNewestClaudeSessionForCwd(cDir, ws) : null;
  const wkSess = engine === 'claude' && ws ? findNewestWkSessionForCwd(dataDir, ws) : null;

  withFileLock(path.join(dataDir, 'shared-workspace.lock'), () => {
    const store = loadSharedStore(dataDir);
    sharedEntry = ws ? store.workspaces[ws] || null : null;
    if (sharedEntry || claudeSess || wkSess) {
      const snap = gitSnapshot(ws);
      brief = buildHandoffBrief({ ws, snap, sharedEntry, claudeSess, wkSess, engine });
      if (sharedEntry && consume) {
        store.workspaces[ws] = { ...sharedEntry, consumed_by: engine, consumed_at: new Date().toISOString() };
        writePrivateJson(sharedFilePath(dataDir), store);
      }
    }
  });

  if (sharedEntry || claudeSess || wkSess) {
    return { ok: true, code: 0, kind: 'handoff', workspace: ws, shared: sharedEntry, brief };
  }

  return { ok: false, code: 5, error: 'No queued Watchkeeper tasks or active handoff found for this workspace.' };
}

export function getStatus({ cwd = process.cwd() } = {}, dataDir = wkHome()) {
  const ws = normWs(cwd);
  const tasks = listAllTasks(dataDir);
  const store = loadSharedStore(dataDir);
  const shared = ws ? store.workspaces[ws] || null : null;
  return {
    ok: true,
    workspace: ws,
    killed: killActive(),
    queued_tasks: tasks.filter(t => t.status === 'queued').length,
    taken_tasks: tasks.filter(t => t.status === 'taken').length,
    matching_queued: ws ? tasks.filter(t => t.status === 'queued' && normWs(t.repo) === ws).length : 0,
    shared,
    git: ws ? gitSnapshot(ws) : { isGit: false, branch: '', head: '', changedFiles: [], recentCommits: [] },
  };
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help' };
  const cmd = argv[0] || '';
  const opts = { cmd, cwd: process.cwd(), engine: 'claude', from: 'claude', to: 'any', id: '', title: '', summary: '', nextSteps: '', sessionId: '', agyConv: '', claudeSession: '', taskId: '', worktree: '', modelUsed: '', claim: false, consume: false, json: false };
  const VAL = {
    '--cwd': 'cwd', '--engine': 'engine', '--from': 'from', '--to': 'to', '--id': 'id',
    '--title': 'title', '--summary': 'summary', '--next': 'nextSteps', '--session-id': 'sessionId',
    '--agy-conv': 'agyConv', '--claude-session': 'claudeSession', '--task-id': 'taskId',
    '--worktree': 'worktree', '--model-used': 'modelUsed',
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claim') opts.claim = true;
    else if (a === '--consume') opts.consume = true;
    else if (a === '--json') opts.json = true;
    else if (VAL[a]) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[VAL[a]] = argv[++i];
    } else if (!a.startsWith('--') && !opts.id) {
      opts.id = a;
    } else {
      throw new Error(`unknown option ${a.slice(0, 40)}`);
    }
  }
  return opts;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'help') {
      console.log('usage: wk-takeover publish|brief|status [options]');
    } else if (o.cmd === 'publish') {
      const r = publishHandoff(o);
      console.log(JSON.stringify(r));
    } else if (o.cmd === 'brief') {
      const r = getBrief(o);
      if (o.json) console.log(JSON.stringify(r));
      else console.log(r.ok ? r.brief : r.error);
      process.exitCode = r.code;
    } else if (o.cmd === 'status') {
      const r = getStatus(o);
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`Workspace: ${r.workspace}\nQueued tasks: ${r.queued_tasks} (here: ${r.matching_queued}) | Taken: ${r.taken_tasks}\nShared handoff: ${r.shared ? `${r.shared.from_engine} -> ${r.shared.to_engine} (${r.shared.title})` : 'none'}`);
    } else {
      console.error('usage: wk-takeover publish|brief|status [options]');
      process.exitCode = 2;
    }
  } catch (err) {
    const code = Number.isInteger(err && err.code) ? err.code : 1;
    console.error(`wk-takeover: ${err && err.message ? err.message : err}`);
    process.exitCode = code;
  }
}
