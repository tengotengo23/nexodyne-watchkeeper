#!/usr/bin/env node
/**
 * Unified Watchkeeper + Graphify + Re-Prompt + Skill Vault + Duo Orchestrator status CLI.
 * Read-only inspection tool (supports `--json` and `--orchestration <dir>`).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, proj, readJSON, gates, policyPin, killOn } from './lib.mjs';
import { antigravityStatus, findPython } from './antigravity-lib.mjs';
import { graphifyStatus } from './wk-graphify.mjs';
import { state as readWkState } from './wk-state.mjs';
import { readSyncStatus } from './wk-skill-sync.mjs';
import { statusLine } from './wk-handoff.mjs';
import { loadConfig, loadProjects, upkeepReading, meterFile, nowMs } from './steward-lib.mjs';
import { resolveDataDir } from './rp-dir.mjs';

function parseArgs(argv) {
  let json = false;
  let orchestration = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') help = true;
    else if (a === '--orchestration' && argv[i + 1]) orchestration = argv[++i];
    else if (a.startsWith('--orchestration=')) orchestration = a.slice('--orchestration='.length);
  }
  return { json, orchestration, help };
}

function readPythonSubsystemStatus(repromptDir) {
  const py = typeof findPython === 'function' ? findPython() : null;
  if (!py || !fs.existsSync(path.join(repromptDir, 'server', 'reprompt_engine.py'))) {
    return {
      ok: false,
      error: py ? 'reprompt module missing' : 'python3 not found',
      reprompt: { installed: false, settings: {}, providers: {} },
      skill_vault: { ready: false, indexed: false, skill_count: 0 },
      orchestrator: { overall_status: 'unavailable' },
    };
  }

  const code = [
    'import json, sys',
    'from pathlib import Path',
    'rp = Path(sys.argv[1])',
    'sys.path.insert(0, str(rp))',
    'sys.path.insert(0, str(rp / "scripts"))',
    'from server.reprompt_engine import RePromptStore, get_provider_statuses',
    'from server.orchestrator import Orchestrator',
    'from skill_vault import vault_status',
    'store = RePromptStore()',
    'pub = store.public_settings()',
    'orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings()).status()',
    'print(json.dumps({"reprompt": {"installed": True, "settings": pub, "providers": get_provider_statuses()}, "skill_vault": vault_status(), "orchestrator": orch}))',
  ].join('\n');

  const r = spawnSync(py, ['-c', code, repromptDir], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0 && (r.stdout || '').trim()) {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      return { ok: true, ...parsed };
    } catch {}
  }
  return {
    ok: false,
    error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200),
    reprompt: { installed: true, settings: {}, providers: {} },
    skill_vault: { indexed: false, skill_count: 0 },
    orchestrator: { overall_status: 'error' },
  };
}

// P2-273: the upkeep cap reading (Watchkeeper's own upkeep against its share of the week); null when the steward config cannot be read.
function readUpkeep(wkHome) {
  try { const cfg = loadConfig(), pj = loadProjects(); return upkeepReading(cfg, nowMs(), readJSON(meterFile(), null), pj.projects || []); } catch { return null; }
}

function readPaceMeter(wkHome) {
  const raw = readJSON(path.join(wkHome, 'steward', 'meter.json'), null);
  if (!raw || typeof raw !== 'object') return null;
  const norm = v => (typeof v === 'number' && Number.isFinite(v) ? (v > 1 ? v / 100 : v) : null);
  return {
    status: raw.status || null,
    seven_day_utilization: norm(raw.utilization),
    five_hour_utilization: norm(raw.fiveHour?.utilization),
    fetched_at: raw.fetchedAt || null,
    resets_at: raw.resetsAt || null,
    source: raw.source || null,
    windows: raw.windows && typeof raw.windows === 'object' ? raw.windows : {},
  };
}

// Gemini usage Watchkeeper already records: the Re-Prompt orchestrator's orchestrator_usage.json (read-only); null when nothing is recorded.
function readGeminiUsage() {
  const dir = resolveDataDir();
  const raw = readJSON(path.join(dir, 'orchestrator_usage.json'), null);
  const u = raw && raw.providers && raw.providers.gemini;
  if (!u || typeof u !== 'object') return null;
  const until = Number(u.cooldown_until || 0), inCooldown = until > Date.now() / 1000;
  return { source: 'orchestrator_usage.json', requests: Number(u.requests || 0), spend_usd: Number(u.spend_usd || 0), in_cooldown: inCooldown,
    cooldown_until: inCooldown ? new Date(until * 1000).toISOString() : null, cooldown_reason: inCooldown ? String(u.cooldown_reason || '') : '' };
}

function graphCoverageText(c) {
  if (!c) return '';
  const a = c.age_seconds, age = a == null ? '' : a < 60 ? ', just built' : a < 3600 ? `, ${Math.floor(a / 60)}m old` : a < 86400 ? `, ${Math.floor(a / 3600)}h old` : `, ${Math.floor(a / 86400)}d old`;
  return ` (${c.files_indexed}/${c.files_total} files${c.truncated ? ', truncated' : ''}${age}${c.dirty_count ? `, ${c.dirty_count} changed` : ''})`;
}

function summarizeWorkspaceGraph(cwd) {
  const outDir = path.join(cwd, 'graphify-out');
  const graphJson = path.join(outDir, 'graph.json');
  const wikiIndex = path.join(outDir, 'wiki', 'index.md');
  const report = path.join(outDir, 'GRAPH_REPORT.md');
  let cov = null;   // P2-272: graphify-out/wk-coverage.json
  try {
    const c = JSON.parse(fs.readFileSync(path.join(outDir, 'wk-coverage.json'), 'utf8'));
    const built = Date.parse(c.built_at);
    cov = { files_indexed: Number(c.files_indexed) || 0, files_total: Number(c.files_total) || 0, truncated: c.truncated === true, dirty_count: Number(c.dirty_count) || 0,
      mode: String(c.mode || ''), built_at: c.built_at || null, age_seconds: Number.isFinite(built) ? Math.max(0, Math.round((Date.now() - built) / 1000)) : null };
  } catch { /* no coverage file yet */ }
  return {
    workspace: cwd,
    coverage: cov,
    graph_exists: fs.existsSync(graphJson),
    wiki_exists: fs.existsSync(wikiIndex),
    report_exists: fs.existsSync(report),
    graph_path: fs.existsSync(graphJson) ? graphJson : null,
  };
}

export function buildUnifiedStatus(opts = {}) {
  const pluginRoot = root();
  const cwd = proj();
  const wkHome = process.env.WK_HOME || path.join(os.homedir(), '.wk');
  const pkgMeta = readJSON(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), {});
  const version = pkgMeta.version || 'unknown';

  let g = null;
  let policyError = null;
  try {
    g = gates({ allowMismatch: true });
  } catch (e) {
    policyError = String(e.message || e);
  }
  const pin = policyPin();
  const killSwitch = fs.existsSync(path.join(wkHome, 'KILL')) || (g ? killOn(g) : false);

  let wkState = null;
  try {
    wkState = readWkState({ orchestration: opts.orchestration || undefined });
  } catch {}

  const agy = antigravityStatus();
  const gf = graphifyStatus();
  const repromptDir = path.join(pluginRoot, 'reprompt');
  const pySub = readPythonSubsystemStatus(repromptDir);

  const queueCounts = { pending: 0, in_progress: 0, attention: 0, done: 0, total: 0 };
  const tasks = wkState?.queue?.tasks || wkState?.tasks || [];
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      queueCounts.total++;
      const st = String(t.status || '');
      if (st === 'queued' || st === 'pending') queueCounts.pending++;
      else if (st === 'taken' || st === 'in_progress' || st === 'running') queueCounts.in_progress++;
      else if (st === 'failed' || st === 'out-of-scope' || st === 'conflict') queueCounts.attention++;
      else if (st === 'merged' || st === 'verified' || st === 'no-change' || st === 'discarded' || st === 'done') queueCounts.done++;
    }
  }
  const openSuggest = Array.isArray(wkState?.suggestions)
    ? wkState.suggestions.length
    : Array.isArray(wkState?.suggest?.items)
      ? wkState.suggest.items.filter(s => s.status === 'open').length
      : Number(wkState?.suggestions_open || 0);

  const learningRaw = readJSON(path.join(wkHome, 'learning', 'summary.json'), null);
  const learning = learningRaw && typeof learningRaw === 'object'
    ? {
      available: Boolean(learningRaw.available),
      snippetCount: Number(learningRaw.snippetCount || 0),
      verifiedCount: Number(learningRaw.verifiedCount || 0),
      correctionCount: Number(learningRaw.correctionCount || 0),
      heuristicCount: Number(learningRaw.heuristicCount || 0),
      pendingSyncCount: Number(learningRaw.pendingSyncCount || 0),
      lastSyncAt: learningRaw.lastSyncAt || null,
    }
    : { available: false, snippetCount: 0, verifiedCount: 0, correctionCount: 0, heuristicCount: 0, pendingSyncCount: 0, lastSyncAt: null };

  const watchdogRaw = readJSON(path.join(wkHome, 'watchdog', 'summary.json'), null);
  const watchdog = watchdogRaw && typeof watchdogRaw === 'object'
    ? {
      available: true,
      scanned_at: watchdogRaw.scanned_at || null,
      activeCount: Number(watchdogRaw.activeCount || 0),
      warningCount: Number(watchdogRaw.warningCount || 0),
      hungCount: Number(watchdogRaw.hungCount || 0),
    }
    : { available: false, scanned_at: null, activeCount: 0, warningCount: 0, hungCount: 0 };

  let line = 'W'; try { line = statusLine({ cwd }); } catch {}
  return {
    line,
    gemini: readGeminiUsage(),
    watchkeeper: {
      version,
      plugin_root: pluginRoot,
      wk_home: wkHome,
      kill_switch: killSwitch,
      policy_pin: pin?.state || (policyError ? 'error' : 'unknown'),
      policy_error: policyError,
      pace: readPaceMeter(wkHome),
      upkeep: readUpkeep(wkHome),
      queue: queueCounts,
      suggestions_open: openSuggest,
      antigravity: agy,
    },
    graphify: {
      ...gf,
      workspace_graph: summarizeWorkspaceGraph(cwd),
    },
    reprompt: {
      ...pySub.reprompt,
      inline_prefixes: ['rp:', 'rp-spec:', 'rp-bug:', 'rp-refactor:', 'rp-concise:'],
      raw_bypass_prefixes: ['raw:', 'rp-raw:'],
      skill_pin_syntax: ['+skill:<name>', '@skill:<name>', '-skill:<name>'],
    },
    skill_vault: {
      indexed: Boolean(pySub.skill_vault?.ready ?? pySub.skill_vault?.indexed),
      ...pySub.skill_vault,
    },
    skill_sync: readSyncStatus(),
    learning,
    watchdog,
    orchestrator: pySub.orchestrator,
    pipeline_stages: [
      { stage: 1, name: 'Hook Multiplexer Bus', detail: 'core/hook_bus.py topological dispatcher + PreToolUse/Stop guards' },
      { stage: 2, name: 'Antigravity queue (wk-task)', detail: 'work for Gemini 4 Carbon High waits in the wk-task queue; Antigravity takes it when the owner runs /wk-take-task' },
      { stage: 3, name: 'Graphify 2-Hop Bridge', detail: 'Incremental AST sync + <50ms 2-hop ego-subgraph query' },
      { stage: 4, name: 'Unrestricted Skill Composer', detail: '3-tier full-library indexing & resource bundling (+skill:/-skill:)' },
      { stage: 5, name: 'Duo Orchestrator & Claude-limit handover', detail: 'Claude CLI/API; at Claude\'s limits the work is queued for Antigravity (wk-task); never agy, never the Gemini CLI' },
    ],
    commands: {
      claude_code: ['/wk', '/wk-status', '/re-prompt', '/orchestrate', '/optimise', '/spend'],
      antigravity: ['/wk', '/wk-status', '/re-prompt', '/duo-orchestrator', '/profession-skill-vault', '/graphify', '/wk-take-task', '/wk-add-task', '/wk-suggest', '/ask-claude'],
      cli: ['wk.mjs', 'wk-status.mjs', 'wk-skill-sync.mjs', 'wk-antigravity.mjs', 'wk-graphify.mjs', 'wk-pin.mjs', 'wk-task.mjs', 'wk-suggest.mjs', 'wk-state.mjs', 'wk-watchdog.mjs'],
    },
  };
}

function formatText(rep) {
  const wk = rep.watchkeeper;
  const gf = rep.graphify;
  const rp = rep.reprompt;
  const sv = rep.skill_vault;
  const ss = rep.skill_sync || {};
  const or = rep.orchestrator;
  const pct = v => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a');
  const lines = [
    `Watchkeeper Unified Plugin v${wk.version}`,
    `  Watchkeeper : kill=${wk.kill_switch ? 'ACTIVE' : 'off'} | pin=${wk.policy_pin} | queue=${wk.queue.pending} queued, ${wk.queue.in_progress} active, ${wk.queue.attention} attention, ${wk.queue.done} done (${wk.queue.total} total) | open_suggest=${wk.suggestions_open}`,
    `  Plan Meter  : ${wk.pace ? `7d=${pct(wk.pace.seven_day_utilization)} 5h=${pct(wk.pace.five_hour_utilization)} (${wk.pace.status || 'ok'})` : 'not recorded'}`,
    `  Upkeep      : ${wk.upkeep ? `US$${wk.upkeep.spentUsd.toFixed(2)} of US$${wk.upkeep.capUsd.toFixed(2)} this week (${Math.round(wk.upkeep.share * 100)}% of the week; cap ${Math.round(wk.upkeep.maxShare * 100)}%${wk.upkeep.over ? '; reached, upkeep paused' : ''})` : 'not available'}`,
    `  Antigravity : installed=${Boolean(wk.antigravity?.installed)} current=${Boolean(wk.antigravity?.current)} skills=${Array.isArray(wk.antigravity?.skills) ? wk.antigravity.skills.length : Number(wk.antigravity?.skills || 0)} mcp=${Boolean(wk.antigravity?.mcp)}`,
    `  Graphify    : cli=${Boolean(gf.cli?.installed)} (${gf.cli?.version || 'n/a'}) | claude=${Boolean(gf.claude?.installed)} | workspace graph=${gf.workspace_graph?.graph_exists ? 'yes' : 'no'}${graphCoverageText(gf.workspace_graph?.coverage)}`,
    `  Re-Prompt   : installed=${Boolean(rp.installed)} | hookAutoAll=${Boolean(rp.settings?.hookAutoAll)} | skillRouting=${rp.settings?.enableSkillRouting !== false}`,
    `                prefixes: ${rp.inline_prefixes.join(', ')} (bypass: ${rp.raw_bypass_prefixes.join(', ')})`,
    `                pins: ${rp.skill_pin_syntax.join(', ')}`,
    `  Skill Vault : indexed=${Boolean(sv?.indexed)} | skills=${sv?.skill_count ?? 0} | daily_sync=${Boolean(ss.scheduled_daily)} (last=${ss.last_sync_at || 'never'})`,
    `  Learning DB : snippets=${rep.learning?.snippetCount ?? 0} (${rep.learning?.verifiedCount ?? 0} verified) | corrections=${rep.learning?.correctionCount ?? 0} | heuristics=${rep.learning?.heuristicCount ?? 0}`,
    `  Watchdog    : hung=${rep.watchdog?.hungCount ?? 0} | warning=${rep.watchdog?.warningCount ?? 0} | active=${rep.watchdog?.activeCount ?? 0}`,
    `  Orchestrator: status=${or?.overall_status || 'unknown'} | gemini=queued for Antigravity | claude_savings=$${Number(or?.claude_savings_usd || 0).toFixed(4)}`,
    `  Runtime v2.0: hook_bus=active | brain=Claude Code here; Gemini work queued for Antigravity (wk-task) | /wk doctor ready`,
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: wk-status.mjs [--json] [--orchestration <dir>]');
    process.exit(0);
  }
  const rep = buildUnifiedStatus(opts);
  if (opts.json) console.log(JSON.stringify(rep, null, 2));
  else console.log(formatText(rep));
}
