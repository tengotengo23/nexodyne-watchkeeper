'use strict';
// Persistent Watchkeeper conversational sessions store (~/.wk/chat-sessions.json, mode 0600).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AUTO_OVER_WORDS, classify, RAW_PREFIX_RE, REWRITE_PREFIX_RE, wantsAutoRewrite } = require('./prompt-prefix');

const CHAT_SESSION_ID = /^WKS-\d{8}-\d{6}-[0-9a-f]{4}$/;
const TURN_ID = /^T-[0-9a-z]{6,20}$/;
const MAX_SESSIONS = 40;
const MAX_TURNS = 60;

const pad = n => String(n).padStart(2, '0');
const sessionsFile = dataDir => path.join(dataDir, 'chat-sessions.json');
// P2-272 (spec section 3.6): archived sessions are moved here, one file each, never deleted.
const archiveDir = dataDir => path.join(dataDir, 'chat-sessions', 'archive');
const PROMPT_MODES = Object.freeze(['raw', 'reprompt']);
const HOOK_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVED_LISTED = 200;

// The prompt mode of one typed prompt (the one grammar in prompt-prefix.js): 'raw' for a raw prefix, 'reprompt' for an
// rp: prefix, and for a plain prompt 'reprompt' only when Auto Re-Prompt is on and it has more than overWords words
// (P2-273, the owner's 30-word rule, the same as the Claude Code and Antigravity hooks); otherwise 'raw'.
function promptModeOf(text, { autoReprompt = true, overWords = AUTO_OVER_WORDS } = {}) {
  const c = classify(text);
  if (c.kind === 'raw') return 'raw';
  if (c.kind === 'rewrite') return 'reprompt';
  return autoReprompt && wantsAutoRewrite(text, overWords) ? 'reprompt' : 'raw';
}

const cleanPromptMode = v => (PROMPT_MODES.includes(v) ? v : '');

function makeChatSessionId(now = Date.now()) {
  const d = new Date(now);
  return `WKS-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

function makeTurnId(now = Date.now()) {
  return `T-${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

// P2-272 (P3 fixes, S9): a typed mode prefix (":raw ", "raw:", ":re-prompt ", "rp:") is not part of the title.
function stripModePrefix(text) {
  const s = String(text || '');
  const m = RAW_PREFIX_RE.exec(s.trim()) || REWRITE_PREFIX_RE.exec(s);
  return m && String(m[3] || '').trim() ? String(m[3]).trim() : s;
}

function shortTitle(text, fallback = 'New session') {
  const clean = stripModePrefix(String(text || '').replace(/\s+/g, ' ').trim()).replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 68 ? `${clean.slice(0, 67).trimEnd()}…` : clean;
}

function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadChatSessions(dataDir) {
  if (!dataDir) return [];
  try {
    const raw = fs.readFileSync(sessionsFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
    // P2-272 (P3 fixes, S12): nothing is cut on read; saveChatSessions archives the overflow.
    return list.filter(s => s && typeof s === 'object' && CHAT_SESSION_ID.test(String(s.id || '')));
  } catch {
    return [];
  }
}

// P2-272 (P3 fixes, M2): a session whose last turn is preparing, running, waiting for a confirm or queued.
const WAITING_STATES = new Set(['awaiting_confirm', 'preparing', 'running', 'queued']);
function sessionBusy(sess) {
  const turns = sess && Array.isArray(sess.turns) ? sess.turns : [];
  const last = turns.length ? turns[turns.length - 1] : null;
  if (last) return WAITING_STATES.has(String(last.status || ''));
  return !!(sess && WAITING_STATES.has(String(sess.lastStatus || '')));
}
function busyError(id) {
  const e = new Error('Still running. Stop it first, or wait.');
  e.code = 'SESSION_BUSY';
  e.sessionId = id;
  return e;
}

// Writes one archive record and reads it back; throws when it cannot be read back.
function writeArchiveRecord(dataDir, sess, reason, now) {
  const file = path.join(archiveDir(dataDir), `${sess.id}.json`);
  const record = { ...sess, archivedAt: now, archiveReason: String(reason || 'done').slice(0, 40) };
  writePrivateJson(file, record);
  const back = readJsonFile(file);
  if (!back || back.id !== sess.id) throw new Error(`archive of ${sess.id} could not be read back`);
  return record;
}

// P2-272 (P3 fixes, S12): over MAX_SESSIONS, the least recently active sessions are archived (reason
// 'overflow') before they leave the list; a running or waiting one, or one whose archive fails, stays.
function saveChatSessions(dataDir, sessions, now = Date.now()) {
  if (!dataDir) return [];
  let list = (Array.isArray(sessions) ? sessions : [])
    .filter(s => s && typeof s === 'object' && CHAT_SESSION_ID.test(String(s.id || '')))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (list.length > MAX_SESSIONS) {
    const drop = new Set();
    for (let i = list.length - 1; i >= 0 && list.length - drop.size > MAX_SESSIONS; i--) {
      const s = list[i];
      if (sessionBusy(s)) continue;
      try { writeArchiveRecord(dataDir, s, 'overflow', now); drop.add(s.id); } catch { /* kept in the list */ }
    }
    list = list.filter(s => !drop.has(s.id));
  }
  writePrivateJson(sessionsFile(dataDir), { version: 1, sessions: list });
  return list;
}

function getChatSession(dataDir, id) {
  if (!CHAT_SESSION_ID.test(String(id || ''))) return null;
  return loadChatSessions(dataDir).find(s => s.id === id) || null;
}

function createChatSession(dataDir, { title = '', workspace = '', taskId = '', worktree = '', claudeSessionId = '', handoffFile = '', engine = '', promptMode = '', now = Date.now() } = {}) {
  const list = loadChatSessions(dataDir);
  const sess = {
    id: makeChatSessionId(now),
    title: shortTitle(title, 'New session'),
    workspace: String(workspace || '').slice(0, 300),
    ...(taskId ? { taskId: String(taskId).slice(0, 100) } : {}),
    ...(worktree ? { worktree: String(worktree).slice(0, 400) } : {}),
    ...(claudeSessionId ? { claudeSessionId: String(claudeSessionId).slice(0, 100) } : {}),
    ...(handoffFile ? { handoffFile: String(handoffFile).slice(0, 400) } : {}),
    ...(engine ? { engine: String(engine).slice(0, 40) } : {}),
    promptMode: cleanPromptMode(promptMode) || 'reprompt',
    createdAt: now,
    updatedAt: now,
    modelsUsed: [],
    totalSavedTokens: 0,
    turns: [],
  };
  saveChatSessions(dataDir, [sess, ...list]);
  return sess;
}

// P2-272 (P3 fixes, M1): × never erases an active session: it archives it (reason 'deleted') through
// the same write, read back, then remove path. Only purgeArchivedChatSession removes a file, on the owner's confirm.
function deleteChatSession(dataDir, id, now = Date.now()) {
  if (!CHAT_SESSION_ID.test(String(id || ''))) return false;
  return !!archiveChatSession(dataDir, id, 'deleted', now);
}

function recomputeSessionMeta(sess) {
  const models = [];
  let saved = 0;
  for (const t of sess.turns || []) {
    if (t.graphify && Number.isFinite(t.graphify.savedTokens)) saved += t.graphify.savedTokens;
    for (const m of [t.repromptModel, t.plannedModel, t.answerModel]) {
      const s = String(m || '').trim();
      if (s && !models.includes(s)) models.push(s);
    }
    for (const st of t.steps || []) {
      const s = String((st && st.model) || '').trim();
      if (s && !models.includes(s)) models.push(s);
    }
  }
  sess.modelsUsed = models.slice(0, 8);
  sess.totalSavedTokens = saved;
}

function upsertTurn(dataDir, sessionId, turn, now = Date.now(), sessionPatch = null) {
  if (!CHAT_SESSION_ID.test(String(sessionId || ''))) return null;
  const list = loadChatSessions(dataDir);
  let idx = list.findIndex(s => s.id === sessionId);
  if (idx < 0) return null;
  const sess = { ...list[idx], turns: Array.isArray(list[idx].turns) ? [...list[idx].turns] : [] };
  if (sessionPatch && typeof sessionPatch.agyConversationId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(sessionPatch.agyConversationId)) {
    sess.agyConversationId = sessionPatch.agyConversationId;
  }
  if (sessionPatch && typeof sessionPatch === 'object') {
    for (const k of ['taskId', 'worktree', 'claudeSessionId', 'handoffFile', 'engine']) {
      if (typeof sessionPatch[k] === 'string' && sessionPatch[k].trim()) {
        sess[k] = sessionPatch[k].trim().slice(0, 400);
      }
    }
  }
  if (turn && cleanPromptMode(turn.promptMode)) sess.promptMode = turn.promptMode;
  const tIdx = sess.turns.findIndex(t => t && t.id === turn.id);
  if (tIdx >= 0) sess.turns[tIdx] = turn;
  else sess.turns.push(turn);
  sess.turns = sess.turns.slice(-MAX_TURNS);
  if ((!sess.title || sess.title === 'New session') && turn.rawPrompt) {
    sess.title = shortTitle(turn.rawPrompt, 'New session');
  }
  sess.updatedAt = now;
  recomputeSessionMeta(sess);
  list[idx] = sess;
  saveChatSessions(dataDir, list);
  return sess;
}

function listChatSessionSummaries(dataDir) {
  return loadChatSessions(dataDir).map(s => {
    const lastTurn = Array.isArray(s.turns) && s.turns.length ? s.turns[s.turns.length - 1] : null;
    return {
      id: s.id,
      title: shortTitle(s.title, 'New session'),
      workspace: s.workspace || '',
      createdAt: Number(s.createdAt || 0),
      updatedAt: Number(s.updatedAt || 0),
      turnCount: Array.isArray(s.turns) ? s.turns.length : 0,
      lastStatus: lastTurn ? String(lastTurn.status || 'done') : 'idle',
      modelsUsed: Array.isArray(s.modelsUsed) ? s.modelsUsed.slice(0, 5) : [],
      totalSavedTokens: Number(s.totalSavedTokens || 0),
      taskId: s.taskId || '',
      claudeSessionId: s.claudeSessionId || '',
      engine: s.engine || '',
      worktree: s.worktree || '',
      handoffFile: s.handoffFile || '',
      promptMode: cleanPromptMode(s.promptMode) || 'reprompt',
    };
  });
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Moves one session out of the active list into chat-sessions/archive/<id>.json. The archive file is
// written and read back before the session leaves the list, so a failure never loses it.
function archiveChatSession(dataDir, id, reason = 'done', now = Date.now()) {
  if (!dataDir || !CHAT_SESSION_ID.test(String(id || ''))) return null;
  const list = loadChatSessions(dataDir);
  const sess = list.find(s => s.id === id);
  if (!sess) return null;
  if (sessionBusy(sess)) throw busyError(id);
  const record = writeArchiveRecord(dataDir, sess, reason, now);
  saveChatSessions(dataDir, list.filter(s => s.id !== id), now);
  return record;
}

// "Delete for good" (after the owner's [Delete] on the confirm line): removes archive/<id>.json only.
function purgeArchivedChatSession(dataDir, id) {
  if (!dataDir || !CHAT_SESSION_ID.test(String(id || ''))) return false;
  const file = path.join(archiveDir(dataDir), `${id}.json`);
  const rec = readJsonFile(file);
  if (!rec || rec.id !== id) return false;
  fs.unlinkSync(file);
  return true;
}

function listArchivedChatSessions(dataDir) {
  if (!dataDir) return [];
  let names = [];
  try { names = fs.readdirSync(archiveDir(dataDir)); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^(WKS-\d{8}-\d{6}-[0-9a-f]{4})\.json$/.exec(name);
    if (!m) continue;
    const s = readJsonFile(path.join(archiveDir(dataDir), name));
    if (!s || s.id !== m[1]) continue;
    out.push({
      id: s.id,
      title: shortTitle(s.title, 'New session'),
      workspace: s.workspace || '',
      updatedAt: Number(s.updatedAt || 0),
      archivedAt: Number(s.archivedAt || 0),
      archiveReason: String(s.archiveReason || ''),
      turnCount: Array.isArray(s.turns) ? s.turns.length : 0,
      taskId: s.taskId || '',
      promptMode: cleanPromptMode(s.promptMode) || 'reprompt',
    });
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt).slice(0, MAX_ARCHIVED_LISTED);
}

// Brings an archived session back to the active list. The archive file is renamed to
// <id>.reopened-<time>.json (kept, never deleted).
function reopenChatSession(dataDir, id, now = Date.now()) {
  if (!dataDir || !CHAT_SESSION_ID.test(String(id || ''))) return null;
  const file = path.join(archiveDir(dataDir), `${id}.json`);
  const rec = readJsonFile(file);
  if (!rec || rec.id !== id) return null;
  const { archivedAt, archiveReason, ...sess } = rec;
  sess.updatedAt = now;
  sess.reopenedAt = now;
  // P2-272 (P3 fixes, N2): the archive file is renamed first and renamed back if the list cannot be
  // saved, so the session sits in exactly one list whatever fails.
  const kept = path.join(archiveDir(dataDir), `${id}.reopened-${now}.json`);
  fs.renameSync(file, kept);
  try {
    const list = loadChatSessions(dataDir).filter(s => s.id !== id);
    saveChatSessions(dataDir, [sess, ...list], now);
  } catch (e) {
    try { fs.renameSync(kept, file); } catch { /* the reopened copy is still kept */ }
    throw e;
  }
  return sess;
}

// Re-Prompt's hook_sessions folder: files older than maxAgeMs and not open move to <dir>/archive/.
// Nothing is deleted. openIds lists session ids (file names without extension) that are open now.
function archiveStaleHookSessions(dir, { now = Date.now(), openIds = [], maxAgeMs = HOOK_SESSION_MAX_AGE_MS } = {}) {
  const moved = [];
  if (!dir) return moved;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return moved; }
  const open = new Set((openIds || []).map(String));
  for (const name of names) {
    if (name === 'archive' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const stem = name.replace(/\.[^.]+$/, '');
    if (open.has(stem) || open.has(name)) continue;
    if (now - st.mtimeMs <= maxAgeMs) continue;
    const dest = path.join(dir, 'archive');
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    let target = path.join(dest, name);
    if (fs.existsSync(target)) target = path.join(dest, `${stem}.${now}${name.slice(stem.length)}`);
    fs.renameSync(full, target);
    moved.push(name);
  }
  return moved;
}

// The automatic archive triggers (spec 3.6), as a pure choice the extension acts on:
// 1. a task session whose last turn is done, with nothing waiting for approval, that is not open now;
// 2. a session tied to an inspected Claude session that has finished (finishedClaudeIds).
// The third trigger (the Done button and /done) archives directly. A session reopened from the
// archive stays until a new turn arrives after the reopen.
function autoArchiveCandidates(sessions, { activeId = '', finishedClaudeIds = [] } = {}) {
  const finished = new Set((finishedClaudeIds || []).map(String));
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !CHAT_SESSION_ID.test(String(s.id || '')) || s.id === activeId) continue;
    if (s.reopenedAt && Number(s.updatedAt || 0) <= Number(s.reopenedAt)) continue;
    const turns = Array.isArray(s.turns) ? s.turns : [];
    const last = turns.length ? turns[turns.length - 1] : null;
    const waiting = turns.some(t => t && WAITING_STATES.has(String(t.status || '')));
    if (s.taskId && last && last.status === 'done' && !waiting) out.push({ id: s.id, reason: 'task-done' });
    else if (s.claudeSessionId && finished.has(String(s.claudeSessionId)) && !waiting) out.push({ id: s.id, reason: 'claude-finished' });
  }
  return out;
}

function hookSessionsDir(env = process.env, home = require('os').homedir()) {
  // Same rule as reprompt/scripts/reprompt_skill_hook.py _state_dir().
  const base = env.REPROMPT_DATA_DIR || env.PLUGIN_DATA || '';
  if (base) return path.join(base.replace(/^~(?=\/|$)/, home), 'hook_sessions');
  return path.join(home, '.gemini', 'skill-vault', 'hook-state', 'hook_sessions');
}

module.exports = {
  CHAT_SESSION_ID,
  TURN_ID,
  sessionsFile,
  makeChatSessionId,
  makeTurnId,
  shortTitle,
  loadChatSessions,
  saveChatSessions,
  getChatSession,
  createChatSession,
  deleteChatSession,
  upsertTurn,
  listChatSessionSummaries,
  archiveDir,
  PROMPT_MODES,
  promptModeOf,
  archiveChatSession,
  purgeArchivedChatSession,
  sessionBusy,
  stripModePrefix,
  MAX_SESSIONS,
  listArchivedChatSessions,
  reopenChatSession,
  archiveStaleHookSessions,
  autoArchiveCandidates,
  hookSessionsDir,
  HOOK_SESSION_MAX_AGE_MS,
};
