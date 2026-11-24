'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const engine = require('./reprompt-engine');
const { autoOverWords, migrateSettings } = require('./prompt-prefix');
const { Orchestrator } = require('./reprompt-orchestrator');
const { getGraphifyContext } = require('./graphify-layer');
const D = require('./data');
const A = require('./actions');

const SETTINGS_KEY = 'reprompt.settings.v1';
const SETTINGS_MIGRATED_KEY = 'reprompt.settings.migrated.v2';
const HISTORY_KEY = 'reprompt.history.v1';
const ORCH_USAGE_KEY = 'reprompt.orchestrator.usage.v1';
const MAX_HISTORY = 50;

const SECRET_PROVIDERS = ['gemini', 'anthropic', 'openai'];
const SECRET_KEYS = Object.fromEntries(
  SECRET_PROVIDERS.map((p) => [`${p}ApiKey`, `reprompt.secret.${p}ApiKey`])
);
const HOOK_SYNC_KEYS = [
  'provider',
  'agyModel',
  'agyModelExplicit',
  'claudeModel',
  'geminiModel',
  'anthropicModel',
  'openaiModel',
  'openaiBaseUrl',
  'defaultTarget',
  'defaultMode',
  'autoRewrite',
  'autoRewriteDelayMs',
  'includeWorkspaceContext',
  'enableSkillRouting',
  'hookAutoAll',
  'autoRewriteOverWords',
];

// P2-272 (B2-8): the shared settings.json is the only source for the synced keys (HOOK_SYNC_KEYS). Read on every getSettings,
// written by merging only the changed keys, atomically. globalState keeps window/UI state only.
const WK_STORE_DIR = () => path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'watchkeeper');
const OLD_PLATFORM_DIR = () => {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 're-prompt');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 're-prompt');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 're-prompt');
};
// The one data folder: REPROMPT_DATA_DIR (or PLUGIN_DATA) first, then the Watchkeeper folder when it exists, then the old platform default.
function resolveDataDir() {
  for (const v of [process.env.REPROMPT_DATA_DIR, process.env.PLUGIN_DATA]) if (v && v.trim()) return v.trim();
  try { if (fs.statSync(WK_STORE_DIR()).isDirectory()) return WK_STORE_DIR(); } catch (_) { }
  return OLD_PLATFORM_DIR();
}

// null = no file (REPROMPT_SKIP_HOOK_SYNC=1: tests and sandboxes keep the synced keys in memory only).
function getStorePath() {
  if (process.env.REPROMPT_SKIP_HOOK_SYNC === '1') return null;
  if (process.env.REPROMPT_HOOK_SETTINGS_PATHS) {
    const first = process.env.REPROMPT_HOOK_SETTINGS_PATHS.split(path.delimiter).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return path.join(resolveDataDir(), 'settings.json');
}

function readJsonObject(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch (_) { }
  return null;
}

const pickKeys = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, obj[k]]));

// Merge only `changes` into the file (keys the panel does not know stay), re-reading the file just before the write; temp file + rename.
function writeStoreKeys(filePath, changes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = readJsonObject(filePath);
  // A settings file that exists but does not parse is never overwritten: the write is refused and the user is told.
  if (!current && fs.existsSync(filePath)) {
    const err = new Error(`The settings file ${filePath} could not be read; fix or move it, then try again.`);
    err.code = 'WK_SETTINGS_UNREADABLE';
    throw err;
  }
  // P2-273 review: a file from before P2-273 is moved to the new defaults once (prompt-prefix.js migrateSettings).
  const next = { ...migrateSettings(current || {}), ...changes };
  const tmp = path.join(path.dirname(filePath), `.settings.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) { }
}

function backupFile(src, dir) {
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, `${path.basename(path.dirname(src)).replace(/[^\w.-]/g, '_')}-settings.${Date.now()}.json`));
  } catch (_) { }
}

const UNTRUSTED_EXEC_MSG =
  'This folder is not trusted, so Re-Prompt runs no CLI tools or external providers here. Trust the folder (Manage Workspace Trust), then try again.';

const isTrustedWorkspace = () => Boolean(vscode.workspace && vscode.workspace.isTrusted === true);

function resolveExtensionRoot(context) {
  return (
    (context && (context.extensionPath || (context.extensionUri && context.extensionUri.fsPath))) ||
    path.join(__dirname, '..')
  );
}

function getWebviewHtml(extensionRoot) {
  const htmlPath = path.join(extensionRoot, 'media', 'reprompt_app.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const cspMeta =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">';
  html = html.replace('<head>', `<head>\n${cspMeta}`);
  return html;
}

function collectWorkspaceContext(prompt = '', opts = {}) {
  const editor = vscode.window && vscode.window.activeTextEditor;
  const wsFolder = (vscode.workspace && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) || null;
  const wsRoot = wsFolder && wsFolder.uri && wsFolder.uri.fsPath ? wsFolder.uri.fsPath : '';

  let label = '';
  const blocks = [];
  if (editor && editor.document) {
    const doc = editor.document;
    const relPath =
      (vscode.workspace &&
        typeof vscode.workspace.asRelativePath === 'function' &&
        vscode.workspace.asRelativePath(doc.uri, false)) ||
      path.basename(doc.fileName || '');
    const lang = doc.languageId || 'text';
    const sel = editor.selection;
    if (sel && !sel.isEmpty && typeof doc.getText === 'function') {
      const startLine = sel.start.line + 1;
      const endLine = sel.end.line + 1;
      const rawText = doc.getText(sel);
      const lines = rawText.split(/\r?\n/);
      const truncated = lines.slice(0, 120).join('\n').slice(0, 4000);
      const note = lines.length > 120 || rawText.length > 4000 ? '\n... [truncated]' : '';
      label = `${relPath} (L${startLine}-${endLine})`;
      blocks.push(`Active file: ${relPath} (${lang}, lines ${startLine}-${endLine})\nSelected snippet:\n\`\`\`${lang}\n${truncated}${note}\n\`\`\``);
    } else {
      label = relPath;
      blocks.push(`Active file: ${relPath} (${lang})`);
    }
  }

  let graphify = null;
  if (wsRoot && process.env.WK_GRAPHIFY_DEFAULT !== '0') {
    try {
      const allowWrite = typeof opts.trusted === 'boolean' ? opts.trusted : isTrustedWorkspace();
      graphify = getGraphifyContext(wsRoot, prompt, { autoBootstrap: true, allowWrite });
      if (graphify && graphify.available && graphify.contextBlock) {
        blocks.push(graphify.contextBlock);
      }
    } catch {
      graphify = null;
    }
  }

  return {
    contextLabel: label,
    workspaceContext: blocks.join('\n\n'),
    workspaceRoot: wsRoot,
    graphify,
  };
}

class RePromptController {
  constructor(context) {
    this.context = context || {};
    this.extensionRoot = resolveExtensionRoot(this.context);

    const memState = new Map();
    this.globalState = this.context.globalState || {
      get: (k) => memState.get(k),
      update: async (k, v) => {
        memState.set(k, v);
      },
    };
    const memSecrets = new Map();
    this.secrets = this.context.secrets || {
      get: async (k) => memSecrets.get(k) || '',
      store: async (k, v) => {
        memSecrets.set(k, v);
      },
      delete: async (k) => {
        memSecrets.delete(k);
      },
    };

    this.memStore = {};
    try { this.migrateSettingsOnce(); } catch (_) { }

    this.views = new Set();
    this.overlayPanel = null;
    this.overlayDetached = false;
    this.ctxTimer = null;
    this.pendingInitialState = null;
    this.orchestrator = new Orchestrator({
      loadState: () => this.globalState.get(ORCH_USAGE_KEY),
      saveState: (st) => this.globalState.update(ORCH_USAGE_KEY, st),
      getSecrets: () => this.getSecrets(),
    });
  }

  dispose() {
    if (this.ctxTimer) {
      clearTimeout(this.ctxTimer);
      this.ctxTimer = null;
    }
  }

  readStore() {
    const f = getStorePath();
    return f ? (readJsonObject(f) || {}) : { ...this.memStore };
  }

  writeStore(changes) {
    const f = getStorePath();
    if (!f) { Object.assign(this.memStore, changes); return; }
    try { writeStoreKeys(f, changes); } catch (e) {
      if (e && e.code === 'WK_SETTINGS_UNREADABLE') { vscode.window.showErrorMessage(e.message); return false; }
      throw e;
    }
    return true;
  }

  // One time: a synced key found only in globalState (or only in the old per-user Re-Prompt file) is copied into the shared file,
  // after both are backed up; then globalState keeps window/UI state only.
  migrateSettingsOnce() {
    if (this.globalState.get(SETTINGS_MIGRATED_KEY) === true) return;
    const old = this.globalState.get(SETTINGS_KEY) || {};
    const f = getStorePath();
    const store = this.readStore();
    const add = {};
    for (const k of HOOK_SYNC_KEYS) if (old[k] !== undefined && store[k] === undefined) add[k] = old[k];
    if (f && !process.env.REPROMPT_HOOK_SETTINGS_PATHS) {
      const legacy = path.join(OLD_PLATFORM_DIR(), 'settings.json');
      if (path.resolve(legacy) !== path.resolve(f)) {
        const lg = readJsonObject(legacy) || {};
        const lgAdd = {};
        for (const k of Object.keys(lg)) if (store[k] === undefined && add[k] === undefined) lgAdd[k] = lg[k];
        if (Object.keys(lgAdd).length) {
          backupFile(legacy, path.join(path.dirname(f), 'settings-backups'));
          Object.assign(add, lgAdd);
        }
      }
    }
    if (Object.keys(add).length) {
      if (f) backupFile(f, path.join(path.dirname(f), 'settings-backups'));
      // Refused (the shared file does not parse): keep the old keys in globalState and try again on a later start.
      if (this.writeStore(add) === false) return;
    }
    const ui = {};
    for (const k of Object.keys(old)) if (!HOOK_SYNC_KEYS.includes(k)) ui[k] = old[k];
    Promise.resolve(this.globalState.update(SETTINGS_KEY, ui)).catch(() => { });
    Promise.resolve(this.globalState.update(SETTINGS_MIGRATED_KEY, true)).catch(() => { });
  }

  getSettings() {
    const ui = this.globalState.get(SETTINGS_KEY) || {};
    const uiOnly = {};
    for (const k of Object.keys(ui)) if (!HOOK_SYNC_KEYS.includes(k)) uiOnly[k] = ui[k];
    const synced = pickKeys(migrateSettings(this.readStore()), HOOK_SYNC_KEYS);
    const merged = { ...engine.DEFAULT_SETTINGS, ...uiOnly, ...synced };
    if (merged.agyModel === 'gemini-3.8-flash-low' && !merged.agyModelExplicit) {
      merged.agyModel = engine.AGY_ORCHESTRATOR_MODEL;
    }
    return merged;
  }

  async getSecrets() {
    const [geminiApiKey, anthropicApiKey, openaiApiKey] = await Promise.all([
      this.secrets.get(SECRET_KEYS.geminiApiKey),
      this.secrets.get(SECRET_KEYS.anthropicApiKey),
      this.secrets.get(SECRET_KEYS.openaiApiKey),
    ]);
    return {
      geminiApiKey: geminiApiKey || '',
      anthropicApiKey: anthropicApiKey || '',
      openaiApiKey: openaiApiKey || '',
    };
  }

  async getPublicSettings() {
    const s = this.getSettings();
    const secrets = await this.getSecrets();
    return {
      ...s,
      hasGeminiApiKey: Boolean(secrets.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      hasAnthropicApiKey: Boolean(secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
      hasOpenaiApiKey: Boolean(secrets.openaiApiKey || process.env.OPENAI_API_KEY),
    };
  }

  getHistory() {
    const list = this.globalState.get(HISTORY_KEY);
    return Array.isArray(list) ? list.slice(0, MAX_HISTORY) : [];
  }

  async addHistory(entry) {
    const record = {
      id: crypto.randomBytes(6).toString('hex'),
      timestamp: new Date().toISOString(),
      original: entry.original,
      rewritten: entry.rewritten_prompt,
      summary: entry.summary,
      improvements: entry.improvements || [],
      target: entry.target,
      mode: entry.mode,
      provider: entry.provider,
      model: entry.model,
      duration_ms: entry.duration_ms || 0,
    };
    const next = [record, ...this.getHistory()].slice(0, MAX_HISTORY);
    await this.globalState.update(HISTORY_KEY, next);
    return next;
  }

  _getSession(sessionId = 'default') {
    if (!this._sessions) this._sessions = new Map();
    const sid = String(sessionId || 'default').trim() || 'default';
    if (!this._sessions.has(sid)) {
      const saved = this.globalState && typeof this.globalState.get === 'function'
        ? (this.globalState.get('reprompt.sessions', {}) || {})[sid]
        : null;
      this._sessions.set(sid, saved && typeof saved === 'object'
        ? { session_id: sid, turn_count: Number(saved.turn_count || 0), loaded_skills: Array.isArray(saved.loaded_skills) ? [...saved.loaded_skills] : [], loaded_domains: Array.isArray(saved.loaded_domains) ? [...saved.loaded_domains] : [] }
        : { session_id: sid, turn_count: 0, loaded_skills: [], loaded_domains: [] });
    }
    return this._sessions.get(sid);
  }

  _saveSession(session) {
    if (!this._sessions) this._sessions = new Map();
    const sid = String((session && session.session_id) || 'default');
    this._sessions.set(sid, session);
    if (this.globalState && typeof this.globalState.update === 'function') {
      const all = { ...(this.globalState.get('reprompt.sessions', {}) || {}) };
      all[sid] = session;
      Promise.resolve(this.globalState.update('reprompt.sessions', all)).catch(() => {});
    }
    return session;
  }

  async buildStatePayload(extra = {}) {
    const [settings, ctx, orchStatus] = await Promise.all([
      this.getPublicSettings(),
      Promise.resolve(collectWorkspaceContext()),
      this.orchestrator.status(),
    ]);
    const paths = D.resolvePaths({});
    const home = paths.home || require('os').homedir();
    const vault = D.readSkillLibrary(home, paths.dataDir, 120);
    const sid = String((extra && extra.session_id) || 'default');
    return {
      settings,
      providers: engine.getProviderStatuses(),
      history: this.getHistory(),
      session: this._getSession(sid),
      vault,
      orchestrator: orchStatus,
      workspaceContext: ctx.workspaceContext,
      contextLabel: ctx.contextLabel,
      untrustedWorkspace: !isTrustedWorkspace(),
      ...extra,
    };
  }

  broadcast(event, data) {
    const msg = { type: 'event', event, data };
    for (const wv of this.views) {
      try {
        wv.postMessage(msg);
      } catch (_) { }
    }
    if (this.overlayPanel) {
      try {
        this.overlayPanel.webview.postMessage(msg);
      } catch (_) { }
    }
  }

  pushContextUpdate() {
    if (this.ctxTimer) clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(() => {
      const ctx = collectWorkspaceContext();
      this.broadcast('contextUpdate', ctx);
    }, 250);
  }

  async saveSettings(updates) {
    const current = this.getSettings();
    const before = { ...current };
    const strKeys = [
      'provider',
      'agyModel',
      'claudeModel',
      'geminiModel',
      'anthropicModel',
      'openaiModel',
      'openaiBaseUrl',
      'defaultTarget',
      'defaultMode',
    ];
    for (const k of strKeys) {
      if (typeof updates[k] === 'string') {
        current[k] = updates[k].trim();
        if (k === 'agyModel' && current[k]) current.agyModelExplicit = true;
      }
    }
    if (typeof updates.autoRewrite === 'boolean') current.autoRewrite = updates.autoRewrite;
    if (typeof updates.includeWorkspaceContext === 'boolean') {
      current.includeWorkspaceContext = updates.includeWorkspaceContext;
    }
    if (typeof updates.openInFloatingWindow === 'boolean') {
      current.openInFloatingWindow = updates.openInFloatingWindow;
    }
    if (typeof updates.hookAutoAll === 'boolean') {
      current.hookAutoAll = updates.hookAutoAll;
    }
    if (updates.autoRewriteOverWords !== undefined) current.autoRewriteOverWords = Math.min(500, autoOverWords(updates.autoRewriteOverWords));
    if (typeof updates.enableSkillRouting === 'boolean') {
      current.enableSkillRouting = updates.enableSkillRouting;
    }
    if (updates.autoRewriteDelayMs !== undefined) {
      const n = Number(updates.autoRewriteDelayMs);
      if (Number.isFinite(n)) current.autoRewriteDelayMs = Math.max(400, Math.min(5000, Math.round(n)));
    }
    const store = this.readStore();
    const changed = {};
    for (const k of HOOK_SYNC_KEYS) {
      if (current[k] !== undefined && (current[k] !== before[k] || (store[k] === undefined && updates[k] !== undefined))) changed[k] = current[k];
    }
    if (Object.keys(changed).length) this.writeStore(changed);
    const uiState = {};
    for (const k of Object.keys(current)) if (!HOOK_SYNC_KEYS.includes(k)) uiState[k] = current[k];
    await this.globalState.update(SETTINGS_KEY, uiState);

    for (const [field, clearFlag] of [
      ['geminiApiKey', 'clearGeminiApiKey'],
      ['anthropicApiKey', 'clearAnthropicApiKey'],
      ['openaiApiKey', 'clearOpenaiApiKey'],
    ]) {
      if (updates[clearFlag]) {
        await this.secrets.delete(SECRET_KEYS[field]);
      } else if (typeof updates[field] === 'string' && updates[field].trim()) {
        await this.secrets.store(SECRET_KEYS[field], updates[field].trim());
      }
    }

    const state = await this.buildStatePayload();
    this.broadcast('stateUpdate', state);
    return state;
  }

  async copyClipboard(text) {
    if (vscode.env && vscode.env.clipboard && typeof vscode.env.clipboard.writeText === 'function') {
      await vscode.env.clipboard.writeText(text);
    }
  }

  async getCommandsSet() {
    if (vscode.commands && typeof vscode.commands.getCommands === 'function') {
      return new Set(await vscode.commands.getCommands(true));
    }
    return new Set();
  }

  async sendToAntigravity(text) {
    await this.copyClipboard(text);
    const cmds = await this.getCommandsSet();

    if (cmds.has('antigravity.panel.focus') || cmds.has('antigravity.toggleChatFocus')) {
      let ok = false;
      if (cmds.has('antigravity.panel.focus')) {
        try {
          await vscode.commands.executeCommand('antigravity.panel.focus');
          ok = true;
        } catch (_) { }
      }
      if (cmds.has('antigravity.toggleChatFocus')) {
        try {
          await vscode.commands.executeCommand('antigravity.toggleChatFocus', 'focus');
          ok = true;
        } catch (_) { }
      }
      if (ok) {
        vscode.window?.setStatusBarMessage?.('Re-Prompt: Copied prompt & focused Antigravity IDE Chat', 4000);
        return {
          focused: true,
          ide: 'antigravity',
          message:
            'Copied compiled prompt & focused Antigravity IDE Chat — press Cmd+V (Ctrl+V) to send directly in Antigravity IDE.',
        };
      }
    }

    if (cmds.has('workbench.action.chat.open')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: text,
          isPartialQuery: true,
        });
        vscode.window?.setStatusBarMessage?.('Re-Prompt: Inserted into chat & copied to clipboard', 4000);
        return { focused: true, message: 'Inserted into chat input (and copied to clipboard).' };
      } catch (_) { }
    }

    const focusCandidates = [
      'workbench.action.chat.focusInput',
      'workbench.panel.chat.view.copilot.focus',
      'antigravity.openChat',
      'antigravity.chat.focus',
      'antigravity.focusChat',
      'cascade.focus',
    ];
    for (const c of focusCandidates) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { focused: true, message: 'Copied to clipboard & focused Antigravity Chat — press Ctrl+V (Cmd+V) to paste.' };
        } catch (_) { }
      }
    }

    for (const c of cmds) {
      if (/(?:antigravity|cascade).*(?:chat|panel).*(?:open|focus)/i.test(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { focused: true, message: 'Copied to clipboard & focused Antigravity Chat — press Ctrl+V (Cmd+V) to paste.' };
        } catch (_) { }
      }
    }

    return { focused: false, message: 'Prompt copied to clipboard — paste into Antigravity Chat (Ctrl+V / Cmd+V).' };
  }

  async sendToAntigravityNewSession(text) {
    await this.copyClipboard(text);
    const cmds = await this.getCommandsSet();

    if (cmds.has('antigravity.startNewConversation')) {
      try {
        await vscode.commands.executeCommand('antigravity.startNewConversation');
        if (cmds.has('antigravity.toggleChatFocus')) {
          try {
            await vscode.commands.executeCommand('antigravity.toggleChatFocus', 'focus');
          } catch (_) { }
        }
        vscode.window?.setStatusBarMessage?.('Re-Prompt: Started new Antigravity IDE conversation & copied prompt', 4000);
        return {
          focused: true,
          ide: 'antigravity',
          newSession: true,
          message: 'Started new Antigravity IDE conversation & copied prompt — press Cmd+V (Ctrl+V) to send.',
        };
      } catch (_) { }
    }

    if (cmds.has('antigravity.panel.focus') || cmds.has('antigravity.toggleChatFocus')) {
      let ok = false;
      if (cmds.has('antigravity.panel.focus')) {
        try {
          await vscode.commands.executeCommand('antigravity.panel.focus');
          ok = true;
        } catch (_) { }
      }
      if (cmds.has('antigravity.toggleChatFocus')) {
        try {
          await vscode.commands.executeCommand('antigravity.toggleChatFocus', 'focus');
          ok = true;
        } catch (_) { }
      }
      if (ok) {
        return { focused: true, ide: 'antigravity', message: 'Copied prompt & focused Antigravity IDE Chat — press Cmd+V (Ctrl+V) to paste.' };
      }
    }

    if (cmds.has('workbench.action.chat.newChat')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        if (cmds.has('workbench.action.chat.open')) {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: text,
            isPartialQuery: true,
          });
          vscode.window?.setStatusBarMessage?.('Re-Prompt: Started new chat & copied prompt', 4000);
          return { focused: true, message: 'Started new chat & inserted prompt (also copied to clipboard).' };
        }
        return { focused: true, message: 'Started new chat & copied prompt — press Ctrl+V (Cmd+V) to paste.' };
      } catch (_) { }
    }

    const focusCandidates = [
      'workbench.action.chat.focusInput',
      'workbench.panel.chat.view.copilot.focus',
      'antigravity.openChat',
      'antigravity.chat.focus',
      'antigravity.focusChat',
      'cascade.focus',
    ];
    for (const c of focusCandidates) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { focused: true, message: 'Copied prompt & focused chat — start a new session and press Ctrl+V (Cmd+V) to paste.' };
        } catch (_) { }
      }
    }

    return { focused: false, message: 'Prompt copied to clipboard — open a new chat session and press Ctrl+V (Cmd+V) to paste.' };
  }

  async sendToClaudeCode(text) {
    await this.copyClipboard(text);
    const cmds = await this.getCommandsSet();

    const claudeCommands = [
      'claude-vscode.focus',
      'claude-vscode.editor.open',
      'claude-vscode.sidebar.open',
      'claude-vscode.open',
      'claude-code.open',
      'claude-code.focus',
    ];
    for (const c of claudeCommands) {
      if (cmds.has(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: 'Copied prompt & focused Claude Code — press Ctrl+V (Cmd+V) to paste.' };
        } catch (_) { }
      }
    }
    for (const c of cmds) {
      if (/^claude[-_.].*(?:open|focus)/i.test(c)) {
        try {
          await vscode.commands.executeCommand(c);
          return { message: 'Copied prompt & focused Claude Code — press Ctrl+V (Cmd+V) to paste.' };
        } catch (_) { }
      }
    }

    const terminals = Array.isArray(vscode.window?.terminals) ? vscode.window.terminals : [];
    const claudeTerm = terminals.find((t) => /claude/i.test(t.name));
    if (claudeTerm) {
      claudeTerm.show(false);
      if (typeof vscode.window.showInformationMessage === 'function') {
        vscode.window
          .showInformationMessage('Re-Prompt copied to clipboard for Claude Code terminal.', 'Paste into Terminal')
          .then((choice) => {
            if (choice === 'Paste into Terminal') {
              claudeTerm.sendText(text, false);
            }
          });
      }
      return { message: 'Focused Claude Code terminal & copied prompt to clipboard.' };
    }

    return { message: 'Prompt copied to clipboard — open Claude Code chat or terminal and paste (Ctrl+V / Cmd+V).' };
  }

  async handleWebviewMessage(webview, msg) {
    if (!msg || msg.type !== 'request') return;
    const { id, method, params = {} } = msg;
    const reply = (result, error = null) => {
      try {
        webview.postMessage({ type: 'response', id, result, error });
      } catch (_) { }
    };

    try {
      if (method === 'getState') {
        const extra = this.pendingInitialState || {};
        this.pendingInitialState = null;
        reply(await this.buildStatePayload(extra));
      } else if (method === 'saveSettings') {
        reply(await this.saveSettings(params));
      } else if (method === 'rewrite') {
        if (!isTrustedWorkspace()) {
          reply(null, UNTRUSTED_EXEC_MSG);
          return;
        }
        const [settings, secrets] = await Promise.all([this.getSettings(), this.getSecrets()]);
        const ws = collectWorkspaceContext();
        const res = await engine.rewriteWithProvider({
          settings,
          secrets,
          prompt: params.prompt,
          target: params.target,
          mode: params.mode,
          workspaceContext: params.workspace_context || '',
          workspaceDir: ws.workspaceRoot || '',
          refinement: params.refinement || '',
          previousRewritten: params.previous_rewritten || '',
        });
        const history = await this.addHistory(res);
        reply({ ...res, history });
      } else if (method === 'listModels') {
        if (!isTrustedWorkspace()) {
          reply(null, UNTRUSTED_EXEC_MSG);
          return;
        }
        const models = await engine.listAgyModels();
        reply({ models });
      } else if (method === 'clearHistory') {
        await this.globalState.update(HISTORY_KEY, []);
        reply({ history: [] });
      } else if (method === 'deleteHistory') {
        const next = this.getHistory().filter((item) => item.id !== params.id);
        await this.globalState.update(HISTORY_KEY, next);
        reply({ history: next });
      } else if (method === 'copyText') {
        await this.copyClipboard(String(params.text || ''));
        reply({ copied: true });
      } else if (method === 'sendToAntigravity') {
        reply(await this.sendToAntigravity(String(params.text || '')));
      } else if (method === 'sendToAntigravityNewSession') {
        reply(await this.sendToAntigravityNewSession(String(params.text || '')));
      } else if (method === 'sendToClaudeCode') {
        reply(await this.sendToClaudeCode(String(params.text || '')));
      } else if (method === 'popOutWindow') {
        if (this.overlayPanel && webview === this.overlayPanel.webview) {
          if (!this.overlayDetached) {
            this.overlayPanel.reveal(undefined, false);
            const cmds = await this.getCommandsSet();
            if (cmds.has('workbench.action.moveEditorToNewWindow')) {
              try {
                await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
                this.overlayDetached = true;
              } catch (_) { }
            }
          } else {
            this.overlayPanel.reveal(undefined, false);
          }
          reply({ detached: this.overlayDetached });
        } else {
          await this.openOverlayPanel({}, { forceWindow: true });
          reply({ detached: this.overlayDetached });
        }
      } else if (method === 'newSession') {
        const sid = String((params && params.session_id) || 'default').trim() || 'default';
        const session = this._saveSession({ session_id: sid, turn_count: 0, loaded_skills: [], loaded_domains: [] });
        reply({ session });
      } else if (method === 'loadSkill') {
        const sid = String((params && params.session_id) || 'default').trim() || 'default';
        const sess = this._getSession(sid);
        const skillObj = params && params.skill && typeof params.skill === 'object' ? params.skill : null;
        const skillId = String((params && params.skill_id) || (skillObj && (skillObj.id || skillObj.name)) || '').trim();
        let entry = skillObj;
        if (!entry && skillId) {
          const paths = D.resolvePaths({});
          const lib = D.readSkillLibrary(paths.home || require('os').homedir(), paths.dataDir, 300);
          entry = (lib.items || []).find(s => s.id === skillId || s.name === skillId) || { id: skillId, name: skillId, domain: 'general' };
        }
        if (entry && (entry.id || entry.name)) {
          const id = entry.id || entry.name;
          if (!sess.loaded_skills.some(x => (x.id || x.name) === id)) {
            sess.loaded_skills.push({ id, name: entry.name || id, domain: entry.domain || 'general', path: entry.path || '' });
          }
          if (entry.domain && !sess.loaded_domains.includes(entry.domain)) {
            sess.loaded_domains.push(entry.domain);
          }
          this._saveSession(sess);
        }
        reply({ session: sess });
      } else if (method === 'removeSkill') {
        const sid = String((params && params.session_id) || 'default').trim() || 'default';
        const skillId = String((params && params.skill_id) || '').trim();
        const sess = this._getSession(sid);
        if (skillId) {
          sess.loaded_skills = sess.loaded_skills.filter(x => x.id !== skillId && x.name !== skillId);
          this._saveSession(sess);
        }
        reply({ session: sess });
      } else if (method === 'vaultList') {
        const paths = D.resolvePaths({});
        const home = paths.home || require('os').homedir();
        reply(D.readSkillLibrary(home, paths.dataDir, 120));
      } else if (method === 'syncVault' || method === 'vaultDiscoverTrending') {
        if (!isTrustedWorkspace()) {
          reply(null, UNTRUSTED_EXEC_MSG);
        } else {
          const paths = D.resolvePaths({});
          const r = D.pluginInstalled(paths.pluginPath)
            ? await A.skillsSync(paths)
            : { ok: false, text: 'Watchkeeper plugin folder not found.' };
          const home = paths.home || require('os').homedir();
          const vault = D.readSkillLibrary(home, paths.dataDir, 120);
          reply({ sync: r, vault }, r.ok ? null : (r.text || 'Skill vault sync failed.'));
        }
      } else if (method === 'orchestratorStatus') {
        reply(await this.orchestrator.status());
      } else if (method === 'orchestratorPreview') {
        reply(await this.orchestrator.previewRoute(params));
      } else if (method === 'orchestratorRun') {
        if (params.dry_run) {
          reply(await this.orchestrator.previewRoute(params));
        } else if (!isTrustedWorkspace()) {
          reply(null, UNTRUSTED_EXEC_MSG);
        } else {
          reply(await this.orchestrator.orchestrateWorkflow({
        ...(params || {}),
        workspaceDir: (params && params.workspaceDir) || (Array.isArray(require('vscode').workspace.workspaceFolders) && require('vscode').workspace.workspaceFolders[0] ? require('vscode').workspace.workspaceFolders[0].uri.fsPath : ''),
        trustedWorkspace: isTrustedWorkspace(),
      }));
        }
      } else if (method === 'orchestratorSaveConfig') {
        reply(await this.orchestrator.updateConfig(params));
      } else if (method === 'orchestratorResetUsage') {
        reply(await this.orchestrator.resetUsage());
      } else {
        reply(null, `Unknown request: ${method}`);
      }
    } catch (err) {
      reply(null, err && err.message ? err.message : String(err));
    }
  }

  attachWebview(webview) {
    webview.options = { enableScripts: true };
    webview.html = getWebviewHtml(this.extensionRoot);
    webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(webview, msg));
  }

  async openOverlayPanel(initialState = {}, opts = {}) {
    if (this.overlayPanel) {
      this.overlayPanel.reveal(undefined, false);
      if (initialState.rewritten) {
        this.buildStatePayload(initialState).then((payload) => {
          this.overlayPanel?.webview.postMessage({ type: 'event', event: 'stateUpdate', data: payload });
        });
      } else if (initialState.draft) {
        this.overlayPanel.webview.postMessage({ type: 'event', event: 'prefillDraft', data: initialState });
      } else {
        this.overlayPanel.webview.postMessage({ type: 'event', event: 'focusDraft', data: {} });
      }
      if (opts.forceWindow && !this.overlayDetached) {
        const cmds = await this.getCommandsSet();
        if (cmds.has('workbench.action.moveEditorToNewWindow')) {
          try {
            await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
            this.overlayDetached = true;
          } catch (_) { }
        }
      }
      return;
    }

    if (!vscode.window || typeof vscode.window.createWebviewPanel !== 'function') return;

    const shouldDetach =
      opts.forceWindow !== undefined
        ? Boolean(opts.forceWindow)
        : this.getSettings().openInFloatingWindow !== false;

    if (initialState.draft || initialState.rewritten || initialState.activeTab) {
      this.pendingInitialState = initialState;
    }

    const colActive = vscode.ViewColumn?.Active ?? 1;
    const colBeside = vscode.ViewColumn?.Beside ?? 2;
    const panel = vscode.window.createWebviewPanel(
      'reprompt.overlayPanel',
      'Re-Prompt Overlay',
      { viewColumn: shouldDetach ? colActive : colBeside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    if (vscode.Uri && typeof vscode.Uri.file === 'function') {
      panel.iconPath = vscode.Uri.file(path.join(this.extensionRoot, 'media', 'reprompt-icon.png'));
    }
    this.overlayPanel = panel;
    this.overlayDetached = false;
    this.attachWebview(panel.webview);

    panel.onDidDispose(() => {
      if (this.overlayPanel === panel) {
        this.overlayPanel = null;
        this.overlayDetached = false;
      }
    });

    if (shouldDetach) {
      const cmds = await this.getCommandsSet();
      if (cmds.has('workbench.action.moveEditorToNewWindow')) {
        try {
          await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
          this.overlayDetached = true;
        } catch (_) { }
      }
    }
  }

  async runQuickOverlay(prefill = '') {
    if (!isTrustedWorkspace()) {
      vscode.window?.showErrorMessage?.(UNTRUSTED_EXEC_MSG);
      return;
    }
    if (!vscode.window || typeof vscode.window.showInputBox !== 'function') return;
    const draft = await vscode.window.showInputBox({
      title: 'Re-Prompt Floating Overlay',
      prompt: 'Type a rough prompt — AI will rewrite it for Antigravity or Claude Code',
      placeHolder: 'e.g. fix auth timeout, preserve cookies, and add unit tests',
      value: prefill,
      ignoreFocusOut: true,
    });
    if (!draft || !draft.trim()) return;

    const settings = this.getSettings();
    const secrets = await this.getSecrets();
    const ctx = settings.includeWorkspaceContext ? collectWorkspaceContext() : { workspaceContext: '' };

    let res;
    try {
      const runRewrite = async () => {
        const out = await engine.rewriteWithProvider({
          settings,
          secrets,
          prompt: draft,
          target: settings.defaultTarget,
          mode: settings.defaultMode,
          workspaceContext: ctx.workspaceContext,
        });
        await this.addHistory(out);
        return out;
      };
      res =
        typeof vscode.window.withProgress === 'function'
          ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation?.Notification ?? 15,
              title: 'Re-Prompt: Rewriting your prompt...',
              cancellable: false,
            },
            runRewrite
          )
          : await runRewrite();
    } catch (err) {
      vscode.window?.showErrorMessage?.(`Re-Prompt failed: ${err.message || err}`);
      return;
    }

    if (typeof vscode.window.showQuickPick !== 'function') return;
    const firstLines = res.rewritten_prompt.replace(/\s+/g, ' ').slice(0, 140);
    const choice = await vscode.window.showQuickPick(
      [
        {
          id: 'antigravity',
          label: '$(send) Send to Antigravity Chat',
          description: res.summary,
          detail: firstLines,
        },
        {
          id: 'claude',
          label: '$(terminal) Send to Claude Code',
          description: 'Copies & focuses Claude Code',
          detail: firstLines,
        },
        {
          id: 'open',
          label: '$(edit) Open Full Overlay Composer (Inspect / Edit)',
          description: `${res.provider} · ${res.model}`,
        },
        {
          id: 'copy',
          label: '$(copy) Copy to Clipboard',
          description: 'Copies structured prompt without leaving editor',
        },
      ],
      {
        title: 'Re-Prompt Ready',
        placeHolder: 'Choose where to send or inspect your rewritten prompt',
        ignoreFocusOut: true,
      }
    );

    if (!choice) return;
    if (choice.id === 'antigravity') {
      const msg = await this.sendToAntigravity(res.rewritten_prompt);
      vscode.window?.showInformationMessage?.(msg.message);
    } else if (choice.id === 'claude') {
      const msg = await this.sendToClaudeCode(res.rewritten_prompt);
      vscode.window?.showInformationMessage?.(msg.message);
    } else if (choice.id === 'copy') {
      await this.copyClipboard(res.rewritten_prompt);
      vscode.window?.showInformationMessage?.('Re-Prompt copied to clipboard.');
    } else if (choice.id === 'open') {
      this.openOverlayPanel({ draft, rewritten: res });
    }
  }
}

class RePromptWebviewViewProvider {
  constructor(controller) {
    this.controller = controller;
  }

  resolveWebviewView(webviewView) {
    this.controller.views.add(webviewView.webview);
    this.controller.attachWebview(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.controller.views.delete(webviewView.webview);
    });
  }
}

function activateRePrompt(context) {
  const controller = new RePromptController(context);
  const viewProvider = new RePromptWebviewViewProvider(controller);

  if (vscode.window && typeof vscode.window.registerWebviewViewProvider === 'function') {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('reprompt.sidebarView', viewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.registerWebviewViewProvider('reprompt.composerView', viewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
  }

  if (vscode.window && typeof vscode.window.createStatusBarItem === 'function') {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Right ?? 2, 100);
    statusItem.text = '$(sparkle) Re-Prompt';
    statusItem.tooltip = 'Open Re-Prompt Overlay (Ctrl+Alt+R / Cmd+Alt+R)';
    statusItem.command = 'reprompt.openOverlay';
    statusItem.show();
    context.subscriptions.push(statusItem);
  }

  if (vscode.commands && typeof vscode.commands.registerCommand === 'function') {
    context.subscriptions.push(
      vscode.commands.registerCommand('reprompt.openOverlay', () => controller.openOverlayPanel()),
      // One action, one label ("Open in Separate Floating Window"): popOutWindow is an alias kept for old keybindings.
      vscode.commands.registerCommand('reprompt.openWindow', () =>
        controller.openOverlayPanel({}, { forceWindow: true })
      ),
      vscode.commands.registerCommand('reprompt.popOutWindow', () => vscode.commands.executeCommand('reprompt.openWindow')),
      vscode.commands.registerCommand('reprompt.orchestratorStatus', async () => {
        const st = await controller.orchestrator.status();
        controller.openOverlayPanel({ activeTab: 'orchestrator', orchestrator: st });
        controller.broadcast('switchTab', { tab: 'orchestrator', orchestrator: st });
      }),
      vscode.commands.registerCommand('reprompt.orchestrateTask', async () => {
        if (!isTrustedWorkspace()) {
          vscode.window?.showErrorMessage?.(UNTRUSTED_EXEC_MSG);
          return;
        }
        if (typeof vscode.window?.showInputBox !== 'function') return;
        const task = await vscode.window.showInputBox({
          title: 'Gemini + Claude Smart Orchestrator',
          prompt: 'Enter a task — auto-routes across Gemini & Claude based on quota, spend pace & complexity',
          placeHolder: 'e.g. summarize the error logs below OR architect our retry queue',
          ignoreFocusOut: true,
        });
        if (!task || !task.trim()) return;
        const ctx = collectWorkspaceContext();
        try {
          const wsFolders = require('vscode').workspace.workspaceFolders || [];
          const runOrch = () => controller.orchestrator.orchestrateWorkflow({
            task,
            context: ctx.workspaceContext,
            workspaceDir: wsFolders[0] ? wsFolders[0].uri.fsPath : '',
            trustedWorkspace: isTrustedWorkspace(),
          });
          const res =
            typeof vscode.window.withProgress === 'function'
              ? await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation?.Notification ?? 15,
                  title: 'Orchestrating across Gemini + Claude...',
                },
                runOrch
              )
              : await runOrch();
          if (typeof vscode.workspace?.openTextDocument === 'function') {
            const doc = await vscode.workspace.openTextDocument({
              language: 'markdown',
              content: `# Orchestrated Result\n- **Provider:** ${res.provider} (${res.model} via ${res.channel})\n- **Routing Reason:** ${res.reason_summary}\n- **Tokens:** ${res.tokens.total} · **Est. Claude Savings:** $${(res.claude_savings_usd || 0).toFixed(4)}\n\n---\n\n${res.output}\n`,
            });
            await vscode.window?.showTextDocument?.(doc, { preview: false });
          }
        } catch (err) {
          vscode.window?.showErrorMessage?.(`Orchestration failed: ${err.message || err}`);
        }
      }),
      vscode.commands.registerCommand('reprompt.quickOverlay', () => controller.runQuickOverlay()),
      vscode.commands.registerCommand('reprompt.focusView', () =>
        vscode.commands.executeCommand?.('reprompt.composerView.focus')
      ),
      vscode.commands.registerCommand('reprompt.rewriteSelection', () => {
        const editor = vscode.window?.activeTextEditor;
        const selText = editor && editor.selection ? editor.document.getText(editor.selection).trim() : '';
        controller.openOverlayPanel({ draft: selText });
      })
    );
  }

  if (vscode.window && typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => controller.pushContextUpdate()));
  }
  if (vscode.window && typeof vscode.window.onDidChangeTextEditorSelection === 'function') {
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => controller.pushContextUpdate()));
  }

  context.subscriptions.push({ dispose: () => controller.dispose() });
  return controller;
}

module.exports = {
  RePromptController,
  RePromptWebviewViewProvider,
  activateRePrompt,
  collectWorkspaceContext,
  UNTRUSTED_EXEC_MSG,
  resolveDataDir,
  HOOK_SYNC_KEYS,
};
