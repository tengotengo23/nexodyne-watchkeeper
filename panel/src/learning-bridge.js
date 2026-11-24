'use strict';
// Antigravity IDE / VS Code bridge for Watchkeeper's autonomous learning loop and local-first FTS5 snippet database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function getVscode() {
  try {
    return require('vscode');
  } catch {
    return null;
  }
}

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const EMPTY_SUMMARY = Object.freeze({
  available: false,
  snippetCount: 0,
  verifiedCount: 0,
  userCorrectedCount: 0,
  correctionCount: 0,
  heuristicCount: 0,
  pendingSyncCount: 0,
  lastSyncAt: null,
  topSnippets: [],
  topHeuristics: [],
});

function resolveWkHome(dataDir = '') {
  const expand = s => String(s || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  if (dataDir && String(dataDir).trim()) return path.resolve(expand(dataDir));
  if (process.env.WK_HOME && process.env.WK_HOME.trim()) return path.resolve(expand(process.env.WK_HOME));
  return path.join(os.homedir(), '.wk');
}

function resolveLearningDir(dataDir = '') {
  if (process.env.WK_SNIPPET_DB && process.env.WK_SNIPPET_DB.trim()) {
    return path.dirname(path.resolve(process.env.WK_SNIPPET_DB.trim()));
  }
  return path.join(resolveWkHome(dataDir), 'learning');
}

function resolveDbPath(dataDir = '') {
  if (process.env.WK_SNIPPET_DB && process.env.WK_SNIPPET_DB.trim()) {
    return path.resolve(process.env.WK_SNIPPET_DB.trim());
  }
  return path.join(resolveLearningDir(dataDir), 'snippets.db');
}

function resolveSummaryPath(dataDir = '') {
  return path.join(resolveLearningDir(dataDir), 'summary.json');
}

function isKillOn(dataDir = '') {
  try {
    return fs.existsSync(path.join(resolveWkHome(dataDir), 'KILL'));
  } catch {
    return true;
  }
}

function findPython() {
  const candidates = [
    process.env.WK_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python3') return c;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch { /* try next */ }
  }
  return 'python3';
}

function resolveHookScript(pluginPath = '') {
  let fallbackPlugin = '';
  try { fallbackPlugin = require('./data').findPlugin('', os.homedir(), path.join(os.homedir(), '.claude')); } catch { /* ignore */ }
  const roots = [
    pluginPath,
    path.resolve(__dirname, '..', '..'),
    fallbackPlugin,
  ].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'bin', 'wk-learning-hook.py');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* continue */ }
  }
  return '';
}

function buildFtsQuery(rawQuery) {
  const tokens = String(rawQuery || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  const seen = [];
  for (const tok of tokens) {
    if (tok.length < 2 && tokens.length > 2) continue;
    if (!seen.includes(tok)) seen.push(tok);
    if (seen.length >= 10) break;
  }
  return seen.map(t => `"${t}"`).join(' OR ');
}

function parseJsonSafe(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Read-only summary snapshot (<1ms) without creating files or directories. */
function readLearningSummary(dataDir = '') {
  const sumPath = resolveSummaryPath(dataDir);
  try {
    if (fs.existsSync(sumPath)) {
      const parsed = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          available: Boolean(parsed.available),
          snippetCount: Number(parsed.snippetCount || 0),
          verifiedCount: Number(parsed.verifiedCount || 0),
          userCorrectedCount: Number(parsed.userCorrectedCount || 0),
          correctionCount: Number(parsed.correctionCount || 0),
          heuristicCount: Number(parsed.heuristicCount || 0),
          pendingSyncCount: Number(parsed.pendingSyncCount || 0),
          lastSyncAt: parsed.lastSyncAt || null,
          topSnippets: Array.isArray(parsed.topSnippets) ? parsed.topSnippets.slice(0, 15) : [],
          topHeuristics: Array.isArray(parsed.topHeuristics) ? parsed.topHeuristics.slice(0, 10) : [],
        };
      }
    }
  } catch { /* fallback to sqlite */ }

  const dbPath = resolveDbPath(dataDir);
  if (!DatabaseSync || !fs.existsSync(dbPath)) {
    return { ...EMPTY_SUMMARY, topSnippets: [], topHeuristics: [] };
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const cnt = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN verification_status = 'verified_pass' THEN 1 ELSE 0 END) AS verified,
             SUM(CASE WHEN verification_status = 'user_corrected' THEN 1 ELSE 0 END) AS corrected
      FROM snippets
    `).get();
    const corr = db.prepare('SELECT COUNT(*) AS c FROM corrections').get();
    const heur = db.prepare('SELECT COUNT(*) AS c FROM heuristics WHERE active = 1').get();
    const pend = db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE status = 'pending'").get();
    const topSnips = db.prepare(`
      SELECT id, title, language, verification_status, quality_score, use_count, tags_json
      FROM snippets
      WHERE verification_status IN ('verified_pass', 'user_corrected')
      ORDER BY quality_score DESC, use_count DESC, updated_at DESC
      LIMIT 15
    `).all();
    const topHeur = db.prepare(`
      SELECT id, language, category, rule_text, confidence, evidence_count
      FROM heuristics
      WHERE active = 1
      ORDER BY confidence DESC, evidence_count DESC
      LIMIT 10
    `).all();
    return {
      available: true,
      snippetCount: Number(cnt?.total || 0),
      verifiedCount: Number(cnt?.verified || 0),
      userCorrectedCount: Number(cnt?.corrected || 0),
      correctionCount: Number(corr?.c || 0),
      heuristicCount: Number(heur?.c || 0),
      pendingSyncCount: Number(pend?.c || 0),
      lastSyncAt: null,
      topSnippets: topSnips.map(r => ({
        id: r.id,
        title: r.title,
        language: r.language,
        verification_status: r.verification_status,
        quality_score: Number(r.quality_score || 1),
        use_count: Number(r.use_count || 0),
        tags: parseJsonSafe(r.tags_json || '[]', []),
      })),
      topHeuristics: topHeur.map(r => ({
        id: r.id,
        language: r.language,
        category: r.category,
        rule_text: r.rule_text,
        confidence: Number(r.confidence || 0.6),
        evidence_count: Number(r.evidence_count || 1),
      })),
    };
  } catch {
    return { ...EMPTY_SUMMARY, topSnippets: [], topHeuristics: [] };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

function runPythonBridge(dataDir, pluginPath, action, payload, timeoutMs = 8000) {
  const script = resolveHookScript(pluginPath);
  if (!script) {
    return Promise.resolve({ ok: false, error: 'wk-learning-hook.py not found' });
  }
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (dataDir) env.WK_HOME = resolveWkHome(dataDir);
    const child = execFile(findPython(), [script, action], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err) });
        return;
      }
      const parsed = parseJsonSafe(String(stdout || '').trim(), null);
      resolve(parsed || { ok: false, error: 'Invalid response from learning bridge' });
    });
    if (child && child.stdin) {
      child.stdin.end(JSON.stringify(payload || {}));
    }
  });
}

/** Query the local-first FTS5 snippet database (<2ms via node:sqlite, with Python fallback). */
async function searchSnippetsLocal(dataDir = '', pluginPath = '', query = '', opts = {}) {
  const t0 = process.hrtime.bigint();
  const dbPath = resolveDbPath(dataDir);
  if (!fs.existsSync(dbPath)) {
    return { ok: true, snippets: [], total_matched: 0, latency_ms: 0 };
  }

  const limit = Math.max(1, Math.min(30, Number(opts.limit || 8)));
  const language = String(opts.language || '').trim().toLowerCase();
  const verifiedOnly = Boolean(opts.verifiedOnly);
  const ftsQ = buildFtsQuery(query);

  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      let rows = [];
      if (ftsQ) {
        try {
          let sql = `
            SELECT s.*, bm25(snippets_fts) AS rank
            FROM snippets_fts
            JOIN snippets s ON s.rowid = snippets_fts.rowid
            WHERE snippets_fts MATCH ?
          `;
          const params = [ftsQ];
          if (verifiedOnly) sql += " AND s.verification_status = 'verified_pass'";
          if (language) { sql += ' AND LOWER(s.language) = ?'; params.push(language); }
          sql += ' ORDER BY rank ASC, s.quality_score DESC LIMIT ?';
          params.push(limit);
          rows = db.prepare(sql).all(...params);
        } catch {
          rows = [];
        }
      }
      if (!rows.length && !ftsQ) {
        let sql = 'SELECT * FROM snippets WHERE 1=1';
        const params = [];
        if (verifiedOnly) sql += " AND verification_status = 'verified_pass'";
        if (language) { sql += ' AND LOWER(language) = ?'; params.push(language); }
        sql += ' ORDER BY quality_score DESC, use_count DESC, updated_at DESC LIMIT ?';
        params.push(limit);
        rows = db.prepare(sql).all(...params);
      }
      const snippets = rows
        .filter(r => r.verification_status !== 'quarantined')
        .map(r => ({
          id: r.id,
          title: r.title,
          language: r.language,
          code: r.code,
          context: r.context,
          tags: parseJsonSafe(r.tags_json || '[]', []),
          verification_status: r.verification_status,
          verification_cmd: r.verification_cmd || '',
          quality_score: Number(r.quality_score || 1),
          use_count: Number(r.use_count || 0),
        }));
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      return { ok: true, snippets, total_matched: snippets.length, latency_ms: Math.round(elapsedMs * 1000) / 1000, backend: 'node:sqlite' };
    } catch {
      /* fallback to python */
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }

  return runPythonBridge(dataDir, pluginPath, 'search', {
    query,
    language,
    verified_only: verifiedOnly,
    limit,
  });
}

async function saveSnippetLocal(dataDir = '', pluginPath = '', payload = {}, opts = {}) {
  if (opts.trusted === false) return { ok: false, error: 'Untrusted workspace.' };
  if (isKillOn(dataDir)) return { ok: false, error: 'Kill switch is active.' };
  return runPythonBridge(dataDir, pluginPath, 'save', payload);
}

async function recordDocumentSaveCorrection(dataDir = '', pluginPath = '', payload = {}, opts = {}) {
  if (opts.trusted === false || isKillOn(dataDir)) return { ok: false, detected: false, skipped: true };
  const snapFile = path.join(resolveLearningDir(dataDir), 'agent_snapshots.json');
  if (!fs.existsSync(snapFile)) return { ok: true, detected: false, skipped: true, reason: 'no_snapshots' };
  return runPythonBridge(dataDir, pluginPath, 'record-save', payload);
}

function attachLearningToExtension(ctx, panel) {
  if (!ctx || !panel) return;
  const vscode = getVscode();
  if (!vscode) return;
  const subs = Array.isArray(ctx.subscriptions) ? ctx.subscriptions : [];
  const getCfg = () => {
    const raw = typeof panel.cfg === 'function' ? panel.cfg() : { dataDir: '', pluginPath: '' };
    return require('./data').resolvePaths(raw);
  };
  const getRepo = () => (typeof panel.repo === 'function' ? panel.repo() : '');
  const isTrusted = () => Boolean(vscode.workspace && vscode.workspace.isTrusted === true);

  if (vscode.workspace && typeof vscode.workspace.onDidSaveTextDocument === 'function') {
    subs.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        try {
          if (!isTrusted() || !doc || !doc.uri || doc.uri.scheme !== 'file' || !doc.fileName) return;
          const c = getCfg();
          const res = await recordDocumentSaveCorrection(
            c.dataDir,
            c.pluginPath,
            {
              file_path: doc.fileName,
              content: typeof doc.getText === 'function' ? doc.getText() : undefined,
              workspace_dir: getRepo(),
              session_id: panel.activeChatSessionId || 'ide',
              context: 'Antigravity IDE manual document save',
            },
            { trusted: isTrusted() }
          );
          if (res && res.detected && res.ok && typeof panel.refresh === 'function') {
            panel.refresh();
          }
        } catch { /* non-fatal background observer */ }
      })
    );
  }

  if (vscode.commands && typeof vscode.commands.registerCommand === 'function') {
    subs.push(
      vscode.commands.registerCommand('watchkeeper.searchSnippets', async () => {
        try {
          const c = getCfg();
          const query = vscode.window && typeof vscode.window.showInputBox === 'function'
            ? await vscode.window.showInputBox({ prompt: 'Search Watchkeeper verified snippets', placeHolder: 'e.g. cleanup timer, retry, auth, sql' })
            : '';
          if (query === undefined) return;
          const res = await searchSnippetsLocal(c.dataDir, c.pluginPath, query || '', { limit: 10 });
          const list = Array.isArray(res.snippets) ? res.snippets : [];
          if (!list.length) {
            vscode.window?.showInformationMessage?.('Watchkeeper: No matching snippets stored yet.');
            return;
          }
          if (vscode.window && typeof vscode.window.showQuickPick === 'function') {
            const pick = await vscode.window.showQuickPick(
              list.map(s => ({
                label: `$(code) ${s.title}`,
                description: `${s.language} · ${s.verification_status}`,
                detail: String(s.code || '').replace(/\s+/g, ' ').slice(0, 120),
                snippet: s,
              })),
              { placeHolder: `Watchkeeper Snippets (${res.latency_ms}ms)` }
            );
            if (pick && pick.snippet) {
              const editor = vscode.window.activeTextEditor;
              if (editor && typeof editor.edit === 'function') {
                await editor.edit(eb => eb.insert(editor.selection.active, pick.snippet.code));
              } else if (vscode.env && vscode.env.clipboard && typeof vscode.env.clipboard.writeText === 'function') {
                await vscode.env.clipboard.writeText(pick.snippet.code);
                vscode.window?.showInformationMessage?.(`Copied "${pick.snippet.title}" to clipboard.`);
              }
            }
          }
        } catch { /* ignore */ }
      }),

      vscode.commands.registerCommand('watchkeeper.captureSnippet', async () => {
        try {
          if (!isTrusted()) {
            vscode.window?.showWarningMessage?.('Watchkeeper: Trust this folder before capturing snippets.');
            return;
          }
          const editor = vscode.window && vscode.window.activeTextEditor;
          if (!editor || !editor.document) {
            vscode.window?.showInformationMessage?.('Watchkeeper: Open a file and select code to capture.');
            return;
          }
          const doc = editor.document;
          const sel = editor.selection && !editor.selection.isEmpty ? doc.getText(editor.selection) : doc.getText();
          if (!sel || !sel.trim()) return;
          const title = vscode.window && typeof vscode.window.showInputBox === 'function'
            ? await vscode.window.showInputBox({ prompt: 'Snippet title', value: `${path.basename(doc.fileName || 'snippet')} pattern` })
            : `${path.basename(doc.fileName || 'snippet')} pattern`;
          if (!title) return;
          const c = getCfg();
          const res = await saveSnippetLocal(
            c.dataDir,
            c.pluginPath,
            {
              title,
              code: sel,
              language: doc.languageId || '',
              file_path: doc.fileName || '',
              context: 'Captured from Antigravity IDE editor selection',
              workspace_dir: getRepo(),
              source: 'ide_capture',
            },
            { trusted: isTrusted() }
          );
          if (res && res.ok) {
            vscode.window?.showInformationMessage?.(`Watchkeeper saved sanitized snippet "${res.snippet.title}" (${res.snippet.id}).`);
            if (typeof panel.refresh === 'function') panel.refresh();
          } else {
            vscode.window?.showWarningMessage?.(`Watchkeeper did not save snippet: ${(res && (res.reason || res.error)) || 'blocked'}`);
          }
        } catch { /* ignore */ }
      }),

      vscode.commands.registerCommand('watchkeeper.learningStats', async () => {
        const c = getCfg();
        const st = readLearningSummary(c.dataDir);
        vscode.window?.showInformationMessage?.(
          `Watchkeeper Learning: ${st.snippetCount} snippets (${st.verifiedCount} verified), ${st.correctionCount} corrections, ${st.heuristicCount} heuristics.`
        );
      })
    );
  }
}

module.exports = {
  EMPTY_SUMMARY,
  resolveWkHome,
  resolveLearningDir,
  resolveDbPath,
  resolveSummaryPath,
  buildFtsQuery,
  readLearningSummary,
  searchSnippetsLocal,
  saveSnippetLocal,
  recordDocumentSaveCorrection,
  attachLearningToExtension,
};
