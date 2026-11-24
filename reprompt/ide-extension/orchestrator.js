"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const engine = require("./repromptEngine");

const CLAUDE_ONLY_CAPABILITIES = new Set([
  "claude_code_hooks",
  "anthropic_prompt_cache",
  "claude_extended_thinking",
  "claude_plugin_exclusive",
]);

const GEMINI_ONLY_CAPABILITIES = new Set([
  "gemini_1m_context",
  "multimodal_video",
  "google_search_grounding",
  "gemini_plugin_exclusive",
]);

const RATE_LIMIT_RE =
  /(?:429|rate[_\s-]*limit|quota|resource[_\s-]*exhausted|too\s+many\s+requests|overloaded|insufficient_quota|credit\s+balance|limit\s+reached)/i;

const ORCHESTRATOR_VERBS_RE =
  /\b(?:summarize|summary|compress|condense|digest|triage|fan[- ]?out|aggregate|merge\s+outputs|synthesize\s+logs|extract\s+context|chunk)\b/i;

const HIGH_REASONING_RE =
  /\b(?:architect|architecture|concurrency|race\s+condition|deadlock|distributed|security\s+audit|cryptograph|zero[- ]trust|kernel|compiler|prove|root\s+cause|multi[- ]file\s+refactor|memory\s+leak|migration\s+plan)\b/i;

const BULK_TOKEN_RE =
  /\b(?:logs?|transcript|corpus|entire\s+repo|codebase|dump|bundle|bulk|hundreds|thousands|all\s+files|diff|changelog)\b/i;

const DEFAULT_ORCHESTRATOR_CONFIG = {
  gemini: {
    dailyBudgetUsd: 10.0,
    dailyTokenLimit: 4000000,
    rpmLimit: 30,
    tpmLimit: 500000,
    fastModel: "gemini-3.8-flash-low",
    strongModel: "gemini-4-neon-medium",
    apiFastModel: "gemini-4-hydrogen",
    apiStrongModel: "gemini-4-carbon",
    cliFastModel: "gemini-4-hydrogen",
    cliStrongModel: "gemini-4-carbon",
    preferredChannel: "auto",
  },
  claude: {
    dailyBudgetUsd: 10.0,
    dailyTokenLimit: 800000,
    rpmLimit: 15,
    tpmLimit: 120000,
    fastModel: "claude-sonnet-5-5-low",
    strongModel: "claude-sonnet-5-5-high",
    apiModel: "claude-sonnet-4-20250514",
    cliModel: "",
    preferredChannel: "auto",
  },
  claudePreserveThreshold: 0.7,
  spendPaceLeadThreshold: 0.15,
  tokenOffloadThreshold: 3000,
  orchestratorOffloadThreshold: 1500,
  cooldownSeconds: 60,
};

const MODEL_PRICING_PER_1M = {
  "gemini-3.8-flash-low": [0.1, 0.4],
  "gemini-3.8-flash-medium": [0.15, 0.6],
  "gemini-4-hydrogen": [0.15, 0.6],
  "gemini-4-neon-medium": [1.25, 5.0],
  "gemini-4-carbon": [1.25, 5.0],
  "claude-sonnet-5-5-low": [3.0, 15.0],
  "claude-sonnet-5-5-medium": [3.0, 15.0],
  "claude-sonnet-5-5-high": [3.0, 15.0],
  "claude-sonnet-4-20250514": [3.0, 15.0],
  "claude-opus-5-5-medium": [15.0, 75.0],
  "claude-default": [3.0, 15.0],
};

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function findGeminiBinary() {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const fromPath = engine.findInPath(isWin ? ["gemini.exe", "gemini.cmd", "gemini"] : ["gemini"]);
  if (fromPath) return fromPath;
  const candidates = [
    path.join(home, ".local", "bin", isWin ? "gemini.exe" : "gemini"),
    path.join(home, ".npm-global", "bin", isWin ? "gemini.cmd" : "gemini"),
  ];
  if (!isWin) {
    candidates.push("/usr/local/bin/gemini", "/opt/homebrew/bin/gemini");
  } else {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    candidates.unshift(path.join(appData, "npm", "gemini.cmd"), path.join(appData, "npm", "gemini.exe"));
  }
  return candidates.find(engine.isExecutableFile) || null;
}

function detectIdeClaudeExtension() {
  const home = os.homedir();
  for (const root of [
    path.join(home, ".antigravity-ide", "extensions"),
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ]) {
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        const entries = fs.readdirSync(root);
        if (entries.some((n) => n.toLowerCase().startsWith("anthropic.claude-code"))) return true;
      }
    } catch (_) {}
  }
  return false;
}

// P2-272 4B (canon line 65): the Gemini lanes (agy_gemini, agy_claude, gemini_cli) only queue a wk-task for
// Antigravity, in every context. Nothing here runs `agy` or `gemini`; gemini_api (a key typed into Settings) is unchanged.
const QUEUE_DETAIL = "Not run by Watchkeeper; queued for Antigravity";
const QUEUE_CHANNELS = new Set(["agy_gemini", "agy_claude", "gemini_cli"]);
const QUEUE_TITLE_MAX = 120;
const QUEUE_TEXT_MAX = 20000;

function queueCallerSource(env = process.env) {
  return env.CLAUDECODE === "1" || String(env.WK_CALLER || "").trim().toLowerCase() === "claude_code" ? "claude" : "owner";
}

function findWkTaskScript(env = process.env) {
  const cands = [];
  if (env.WK_PLUGIN_ROOT) cands.push(path.join(env.WK_PLUGIN_ROOT, "bin", "wk-task.mjs"));
  cands.push(path.resolve(__dirname, "..", "..", "bin", "wk-task.mjs"));
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch (_) { return false; } }) || "";
}

function queueTitle(prompt) {
  const first = String(prompt || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "Re-Prompt task";
  return first.length > QUEUE_TITLE_MAX ? `${first.slice(0, QUEUE_TITLE_MAX - 1).trimEnd()}\u2026` : first;
}

function runQuiet(cmd, args, opts) {
  const { execFile } = require("child_process");
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** Queue `prompt` as a wk-task in the workspace's git root. Resolves {text, queued_task}; queued_task is null when nothing was queued. */
async function queueForAntigravity(prompt, workspace = "", { source = "", env = process.env } = {}) {
  const folder = String(workspace || env.WK_WORKSPACE || process.cwd());
  let isDir = false;
  try { isDir = fs.statSync(folder).isDirectory(); } catch (_) { isDir = false; }
  const git = isDir ? await runQuiet("git", ["-C", folder, "rev-parse", "--show-toplevel"], { env }) : { code: 1, stdout: "" };
  const root = git.code === 0 ? git.stdout.trim() : "";
  if (!root) return { text: `Not queued: ${folder} is not a git repository, so Antigravity has nothing to take. Nothing was run.`, queued_task: null };
  const script = findWkTaskScript(env);
  if (!script) return { text: "Not queued: bin/wk-task.mjs was not found. Nothing was run.", queued_task: null };
  const title = queueTitle(prompt);
  const text = String(prompt || "").trim().slice(0, QUEUE_TEXT_MAX) || title;
  const src = ["claude", "owner", "gemini"].includes(source) ? source : queueCallerSource(env);
  const node = env.WK_NODE || process.execPath;
  const res = await runQuiet(node, [script, "add", "--repo", root, "--title", title, "--text", text, "--allow", "**", "--from", src], { env: { ...env, NO_COLOR: "1" }, cwd: path.dirname(path.dirname(script)) });
  const lines = res.stdout.trim().split(/\r?\n/);
  const id = (lines[lines.length - 1] || "").trim();
  if (res.code !== 0 || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    const msg = (res.stderr || res.stdout || `exit ${res.code}`).trim().split(/\r?\n/);
    return { text: `Not queued: wk-task said ${String(msg[msg.length - 1] || "nothing").slice(0, 300)}. Nothing was run.`, queued_task: null };
  }
  return { text: `Queued for Antigravity as task ${id}. Antigravity takes it when you run /wk-take-task there.`, queued_task: id };
}

function detectIntegrations(secrets = {}) {
  const agyBin = engine.findAgyBinary();
  const geminiBin = findGeminiBinary();
  const claudeBin = engine.findClaudeBinary();
  const geminiKey = Boolean(secrets.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const anthropicKey = Boolean(secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const home = os.homedir();

  const geminiChannels = [
    { id: "gemini_cli", label: "Gemini CLI (gemini)", available: Boolean(geminiBin), detail: QUEUE_DETAIL },
    { id: "agy_gemini", label: "Antigravity queue (wk-task)", available: Boolean(agyBin), detail: agyBin ? QUEUE_DETAIL : "Antigravity not found; nothing to queue for" },
    { id: "gemini_api", label: "Gemini REST API", available: geminiKey, detail: geminiKey ? "API key configured" : "Set GEMINI_API_KEY or add key in Settings" },
  ];

  const claudeChannels = [
    { id: "claude_cli", label: "Claude Code CLI (claude)", available: Boolean(claudeBin), detail: claudeBin || "claude CLI not installed" },
    { id: "agy_claude", label: "Antigravity queue (wk-task)", available: Boolean(agyBin), detail: agyBin ? QUEUE_DETAIL : "Antigravity not found; nothing to queue for" },
    { id: "anthropic_api", label: "Anthropic Messages API", available: anthropicKey, detail: anthropicKey ? "API key configured" : "Set ANTHROPIC_API_KEY or add key in Settings" },
  ];

  const geminiReady = geminiChannels.some((c) => c.available);
  const claudeReady = claudeChannels.some((c) => c.available);
  const geminiPrimary = (geminiChannels.find((c) => c.available) || {}).id || null;
  const claudePrimary = (claudeChannels.find((c) => c.available) || {}).id || null;

  return {
    overall_status: geminiReady && claudeReady ? "dual_ready" : geminiReady || claudeReady ? "single_provider_fallback" : "unconfigured",
    gemini: {
      available: geminiReady,
      primary_channel: geminiPrimary,
      channels: geminiChannels,
      plugin_dir_detected: fs.existsSync(path.join(home, ".gemini", "config", "plugins")),
      setup_hint: geminiReady ? `Ready via ${geminiPrimary}.` : "Set GEMINI_API_KEY in Re-Prompt Settings, or install Antigravity: Watchkeeper never runs `agy` or `gemini`; it queues Gemini work for Antigravity (wk-task).",
    },
    claude: {
      available: claudeReady,
      primary_channel: claudePrimary,
      channels: claudeChannels,
      plugin_dir_detected: fs.existsSync(path.join(home, ".claude", "plugins")),
      ide_extension_detected: detectIdeClaudeExtension(),
      setup_hint: claudeReady ? `Ready via ${claudePrimary}.` : "Install the `claude` CLI, or set ANTHROPIC_API_KEY in Re-Prompt Settings. Watchkeeper never runs `agy`.",
    },
  };
}

function selectChannel(integrationInfo, preferredChannel = "auto") {
  const avail = (integrationInfo.channels || []).filter((c) => c.available).map((c) => c.id);
  if (!avail.length) return null;
  if (preferredChannel && preferredChannel !== "auto" && avail.includes(preferredChannel)) return preferredChannel;
  return avail[0];
}

function estimateTokens(text) {
  const cleaned = String(text || "").trim();
  return cleaned ? Math.max(1, Math.ceil(cleaned.length / 3.8)) : 0;
}

function estimateCostUsd(provider, model, inputTokens, outputTokens) {
  const rates = MODEL_PRICING_PER_1M[model] || (provider === "gemini" ? [0.15, 0.6] : [3.0, 15.0]);
  return Number(((inputTokens * rates[0] + outputTokens * rates[1]) / 1000000).toFixed(6));
}

function classifyTask(task, context = "", role = "auto", requiredCapabilities = []) {
  const cleanTask = String(task || "").trim();
  const cleanCtx = String(context || "").trim();
  const inTokens = estimateTokens(cleanTask) + estimateTokens(cleanCtx);

  let chosenRole = String(role || "auto").toLowerCase();
  if (!["auto", "execution", "orchestrator", "planning"].includes(chosenRole)) chosenRole = "execution";
  if (chosenRole === "auto") {
    if (ORCHESTRATOR_VERBS_RE.test(cleanTask)) chosenRole = "orchestrator";
    else if (/\b(?:plan|roadmap|breakdown|decompose)\b/i.test(cleanTask)) chosenRole = "planning";
    else chosenRole = "execution";
  }

  let outTokens = 350;
  if (chosenRole === "orchestrator") outTokens = Math.max(220, Math.min(1800, Math.floor(inTokens * 0.25)));
  else if (chosenRole === "planning") outTokens = Math.max(450, Math.min(2200, Math.floor(inTokens * 0.4)));
  else outTokens = Math.max(350, Math.min(2800, Math.floor(inTokens * 0.45)));
  const totalTokens = inTokens + outTokens;

  const words = (cleanTask.match(/[A-Za-z0-9_.-]+/g) || []).length;
  let score = words >= 85 ? 25 : words >= 40 ? 15 : words >= 18 ? 8 : 2;
  if (HIGH_REASONING_RE.test(cleanTask)) score = Math.max(score + 38, 58);
  const isOrchBulk = chosenRole === "orchestrator" || ORCHESTRATOR_VERBS_RE.test(cleanTask);
  if (isOrchBulk && !HIGH_REASONING_RE.test(cleanTask)) score = Math.min(score, 44);

  const complexity = score >= 52 ? "high" : score >= 24 ? "medium" : "low";
  let tokenVolume = "low";
  if (totalTokens >= 10000 || inTokens >= 8000 || (BULK_TOKEN_RE.test(cleanTask) && inTokens >= 1500)) {
    tokenVolume = "high";
  } else if (totalTokens >= 2500) {
    tokenVolume = "medium";
  }

  const caps = Array.isArray(requiredCapabilities) ? requiredCapabilities.map((c) => String(c).trim()).filter(Boolean) : [];
  if (inTokens >= 180000 && !caps.includes("gemini_1m_context")) caps.push("gemini_1m_context");

  return {
    role: chosenRole,
    complexity,
    complexity_score: score,
    token_volume: tokenVolume,
    estimated_input_tokens: inTokens,
    estimated_output_tokens: outTokens,
    estimated_total_tokens: totalTokens,
    required_capabilities: caps,
    requires_claude: caps.some((c) => CLAUDE_ONLY_CAPABILITIES.has(c)),
    requires_gemini: caps.some((c) => GEMINI_ONLY_CAPABILITIES.has(c)),
    is_orchestrator_bulk: isOrchBulk,
  };
}

function deepMergeConfig(base, updates) {
  const out = JSON.parse(JSON.stringify(base));
  if (!updates || typeof updates !== "object") return out;
  for (const [k, v] of Object.entries(updates)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv !== undefined && sv !== null) out[k][sk] = sv;
      }
    } else if (v !== undefined && v !== null && k in out) {
      out[k] = v;
    }
  }
  return out;
}

function emptyProviderUsage() {
  return {
    tokens_used: 0,
    input_tokens: 0,
    output_tokens: 0,
    spend_usd: 0.0,
    requests: 0,
    rate_limit_hits: 0,
    cooldown_until: 0,
    cooldown_reason: "",
    recent_window: [],
  };
}

function getProviderSnapshot(state, provider, nowSec = Date.now() / 1000) {
  const cfg = (state.config && state.config[provider]) || DEFAULT_ORCHESTRATOR_CONFIG[provider];
  const u = (state.providers && state.providers[provider]) || emptyProviderUsage();
  const budget = Math.max(0.01, Number(cfg.dailyBudgetUsd || 10.0));
  const tokLimit = Math.max(1, Number(cfg.dailyTokenLimit || 1000000));
  const rpmLimit = Math.max(1, Number(cfg.rpmLimit || 20));
  const tpmLimit = Math.max(1, Number(cfg.tpmLimit || 100000));

  const spend = Number(u.spend_usd || 0);
  const tokens = Number(u.tokens_used || 0);
  const spendRatio = spend / budget;
  const tokenRatio = tokens / tokLimit;
  const utilization = Math.max(spendRatio, tokenRatio);
  const headroom = Math.max(0, 1 - utilization);

  const window = (u.recent_window || []).filter((it) => it && nowSec - Number(it.ts || 0) < 60);
  const rpmUsed = window.length;
  const tpmUsed = window.reduce((acc, it) => acc + Number(it.tokens || 0), 0);

  const cooldownUntil = Number(u.cooldown_until || 0);
  const inCooldown = cooldownUntil > nowSec;
  const isSaturated = spendRatio >= 1 || tokenRatio >= 1 || rpmUsed >= rpmLimit || tpmUsed >= tpmLimit;

  return {
    provider,
    spend_usd: Number(spend.toFixed(6)),
    daily_budget_usd: budget,
    remaining_budget_usd: Number(Math.max(0, budget - spend).toFixed(4)),
    tokens_used: tokens,
    daily_token_limit: tokLimit,
    remaining_tokens: Math.max(0, tokLimit - tokens),
    requests: Number(u.requests || 0),
    rate_limit_hits: Number(u.rate_limit_hits || 0),
    spend_ratio: Number(spendRatio.toFixed(4)),
    token_ratio: Number(tokenRatio.toFixed(4)),
    utilization: Number(utilization.toFixed(4)),
    headroom: Number(headroom.toFixed(4)),
    rpm_used: rpmUsed,
    rpm_limit: rpmLimit,
    tpm_used: tpmUsed,
    tpm_limit: tpmLimit,
    in_cooldown: inCooldown,
    cooldown_remaining_s: inCooldown ? Math.max(0, Math.ceil(cooldownUntil - nowSec)) : 0,
    cooldown_reason: inCooldown ? String(u.cooldown_reason || "") : "",
    is_saturated: isSaturated,
  };
}

function pickModelFor(provider, channel, complexity, config) {
  const pCfg = config[provider] || DEFAULT_ORCHESTRATOR_CONFIG[provider];
  if (provider === "gemini") {
    if (channel === "gemini_api") return complexity === "high" ? pCfg.apiStrongModel : pCfg.apiFastModel;
    if (channel === "gemini_cli") return complexity === "high" ? pCfg.cliStrongModel : pCfg.cliFastModel;
    return complexity === "high" ? pCfg.strongModel : pCfg.fastModel;
  }
  if (channel === "anthropic_api") return pCfg.apiModel;
  if (channel === "claude_cli") return pCfg.cliModel || "claude-default";
  return complexity === "high" ? pCfg.strongModel : pCfg.fastModel;
}

function decideRoute({
  task,
  context = "",
  role = "auto",
  requiredCapabilities = [],
  overrideProvider = null,
  strictOverride = false,
  integrations,
  ledgerState,
  nowSec = Date.now() / 1000,
}) {
  const integ = integrations || detectIntegrations();
  const state = ledgerState || {
    date: todayUtc(),
    config: JSON.parse(JSON.stringify(DEFAULT_ORCHESTRATOR_CONFIG)),
    providers: { gemini: emptyProviderUsage(), claude: emptyProviderUsage() },
  };
  const config = deepMergeConfig(DEFAULT_ORCHESTRATOR_CONFIG, state.config || {});
  const gSnap = getProviderSnapshot(state, "gemini", nowSec);
  const cSnap = getProviderSnapshot(state, "claude", nowSec);

  const gChannel = selectChannel(integ.gemini, config.gemini.preferredChannel);
  // P2-272 open point 5: the words say where Gemini-lane work really goes. Only gemini_api outside Claude Code sends the
  // prompt to Gemini, with the owner's own key; every other channel, and gemini_api under Claude Code, queues a wk-task.
  const gDirect = gChannel === "gemini_api" && queueCallerSource() !== "claude";
  const gVerb = gDirect ? "Sent" : "Queued";
  const gWhere = gDirect ? "to Gemini with your own API key" : "for Antigravity (wk-task)";
  const cChannel = selectChannel(integ.claude, config.claude.preferredChannel);
  const gHealthy = Boolean(integ.gemini.available) && !gSnap.in_cooldown && !gSnap.is_saturated;
  const cHealthy = Boolean(integ.claude.available) && !cSnap.in_cooldown && !cSnap.is_saturated;

  const cls = classifyTask(task, context, role, requiredCapabilities);
  const inTok = cls.estimated_input_tokens;
  const outTok = cls.estimated_output_tokens;
  const totTok = cls.estimated_total_tokens;

  const buildDecision = (provider, reasonCode, reasonSummary, guardrail = null, overrideApplied = false, error = null) => {
    if (!provider) {
      return {
        provider: null,
        channel: null,
        model: null,
        fallback_provider: null,
        reason_code: reasonCode,
        reason_summary: reasonSummary,
        classification: cls,
        estimated_tokens: totTok,
        estimated_cost_usd: 0,
        claude_savings_usd: 0,
        guardrail,
        override_applied: overrideApplied,
        snapshots: { gemini: gSnap, claude: cSnap },
        error: error || reasonSummary,
      };
    }
    const ch = provider === "gemini" ? gChannel : cChannel;
    const model = pickModelFor(provider, ch, cls.complexity, config);
    const estCost = estimateCostUsd(provider, model, inTok, outTok);
    const claudeRefCost = estimateCostUsd("claude", pickModelFor("claude", cChannel, cls.complexity, config), inTok, outTok);
    const savings = provider === "gemini" ? Number(Math.max(0, claudeRefCost - estCost).toFixed(6)) : 0;
    const other = provider === "gemini" ? "claude" : "gemini";
    const otherHealthy = other === "claude" ? cHealthy : gHealthy;

    return {
      provider,
      channel: ch,
      model,
      fallback_provider: otherHealthy && !guardrail ? other : null,
      reason_code: reasonCode,
      reason_summary: reasonSummary,
      classification: cls,
      estimated_tokens: totTok,
      estimated_cost_usd: estCost,
      claude_savings_usd: savings,
      guardrail,
      override_applied: overrideApplied,
      snapshots: { gemini: gSnap, claude: cSnap },
      error: null,
    };
  };

  if (cls.requires_claude && cls.requires_gemini) {
    return buildDecision(null, "guardrail_conflict", "Conflicting Gemini-only and Claude-only capabilities.", "conflict");
  }
  if (cls.requires_claude) {
    return cHealthy
      ? buildDecision("claude", "guardrail_claude_only", "Pinned to Claude due to required Claude-exclusive capability.", "claude_only")
      : buildDecision(null, "guardrail_claude_unavailable", `Claude-only capability required, but Claude is unavailable (${integ.claude.setup_hint}).`, "claude_only");
  }
  if (cls.requires_gemini) {
    return gHealthy
      ? buildDecision("gemini", "guardrail_gemini_only", "Pinned to Gemini due to Gemini-exclusive capability or >180k context size.", "gemini_only")
      : buildDecision(null, "guardrail_gemini_unavailable", `Gemini-only capability required, but Gemini is unavailable (${integ.gemini.setup_hint}).`, "gemini_only");
  }

  if (overrideProvider === "gemini" || overrideProvider === "claude") {
    const targetHealthy = overrideProvider === "gemini" ? gHealthy : cHealthy;
    if (targetHealthy) {
      return buildDecision(overrideProvider, "user_override", `Routed to ${overrideProvider} per explicit user override.`, null, true);
    }
    if (strictOverride) {
      return buildDecision(null, "override_unavailable", `Strict override to ${overrideProvider} failed: unavailable or rate-limited.`, null, true);
    }
    const other = overrideProvider === "gemini" ? "claude" : "gemini";
    if (other === "claude" ? cHealthy : gHealthy) {
      return buildDecision(other, "override_fallback", `Requested ${overrideProvider} is unavailable/rate-limited; fell back to ${other}.`, null, true);
    }
  }

  if (!gHealthy && !cHealthy) {
    return buildDecision(
      null,
      "no_provider_available",
      `Neither Gemini nor Claude is ready. Gemini: ${integ.gemini.setup_hint} Claude: ${integ.claude.setup_hint}`
    );
  }
  if (gHealthy && !cHealthy) {
    const code = cSnap.in_cooldown || cSnap.is_saturated ? "fallback_rate_limited" : "fallback_unavailable";
    return buildDecision("gemini", code, `${gVerb} ${gDirect ? gWhere : "for Antigravity"} because Claude is ${code === "fallback_rate_limited" ? "in cooldown/quota cap" : "not configured"}.`);
  }
  if (cHealthy && !gHealthy) {
    const code = gSnap.in_cooldown || gSnap.is_saturated ? "fallback_rate_limited" : "fallback_unavailable";
    return buildDecision("claude", code, `Routed to Claude because Gemini is ${code === "fallback_rate_limited" ? "in cooldown/quota cap" : "not configured"}.`);
  }

  if (
    (cls.role === "orchestrator" || cls.role === "planning") &&
    (cls.complexity !== "high" || (totTok >= Number(config.orchestratorOffloadThreshold || 1500) && cls.is_orchestrator_bulk))
  ) {
    return buildDecision("gemini", "orchestrator_token_offload", `${gVerb} ${cls.role} subtask (~${totTok.toLocaleString()} tokens) ${gWhere} to preserve Claude capacity.`);
  }

  if (cls.complexity !== "high" && (cls.token_volume !== "low" || totTok >= Number(config.tokenOffloadThreshold || 3000))) {
    return buildDecision("gemini", "token_heavy_offload", `${gVerb} ${cls.complexity}-complexity, ${cls.token_volume}-token (~${totTok.toLocaleString()} tok) task ${gWhere} to save Claude limits.`);
  }

  const preserveThresh = Number(config.claudePreserveThreshold || 0.7);
  const paceLead = Number(config.spendPaceLeadThreshold || 0.15);

  if (cSnap.utilization >= preserveThresh && cls.complexity !== "high") {
    return buildDecision("gemini", "claude_quota_preservation", `Claude utilization at ${Math.round(cSnap.utilization * 100)}%; preserving Claude for complex tasks.`);
  }
  if (cSnap.utilization - gSnap.utilization > paceLead && cls.complexity !== "high") {
    return buildDecision("gemini", "spend_pacing_balance", `Claude utilization leads Gemini; ${gVerb.toLowerCase()} ${gWhere} to balance spend.`);
  }
  if (cls.complexity === "high") {
    return buildDecision("claude", "high_complexity_claude", "Routed high-complexity reasoning/architecture task to Claude.");
  }
  if (gSnap.utilization - cSnap.utilization > paceLead) {
    return buildDecision("claude", "spend_pacing_balance", "Gemini utilization leads Claude; balancing spend to Claude.");
  }
  return buildDecision("gemini", "cost_efficient_default", `${gVerb} this routine task ${gWhere} to keep Claude limits in reserve.`);
}

async function defaultExecuteChannel({ channel, model, prompt, systemPrompt = "", secrets = {}, workspace = "", noQueue = false }) {
  const fullPrompt = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n---\n\n${prompt.trim()}` : prompt.trim();

  // P2-272 4B: agy_gemini, agy_claude and gemini_cli only queue a wk-task for Antigravity, in the IDE and under Claude Code.
  // Nothing here starts `agy` or `gemini`. Internal steps (compression, aggregation) pass noQueue so they never queue a junk task.
  if (QUEUE_CHANNELS.has(channel)) {
    if (noQueue) return { text: "", queue_skipped: true };
    return queueForAntigravity(prompt, workspace);
  }

  // S10 (P2-272 review): under Claude Code (CLAUDECODE=1 or WK_CALLER=claude_code) a prompt is never sent to Gemini,
  // not even through the REST API; it is queued for Antigravity instead, like the Python server (orchestrator.py).
  if (channel === "gemini_api" && queueCallerSource() === "claude") {
    if (noQueue) return { text: "", queue_skipped: true };
    return queueForAntigravity(prompt, workspace);
  }

  if (channel === "claude_cli") {
    const claudeBin = engine.findClaudeBinary();
    if (!claudeBin) throw new Error("`claude` CLI not found.");
    const args = ["-p", fullPrompt, "--output-format", "text"];
    if (model && model !== "claude-default") args.push("--model", model);
    const res = await engine.runSubprocess(claudeBin, args, 60000);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || `claude exit ${res.code}`).trim().slice(0, 400));
    return { text: res.stdout.trim() };
  }

  if (channel === "gemini_api") {
    const key = secrets.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
    if (!key) throw new Error("Missing Gemini API key.");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = { contents: [{ role: "user", parts: [{ text: prompt.trim() }] }], generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: "high" } } };
    if (systemPrompt.trim()) body.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
    const data = await engine.httpPostJson(url, { "Content-Type": "application/json" }, body, 60000);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return { text: parts.map((p) => p.text || "").join("").trim() };
  }

  if (channel === "anthropic_api") {
    const key = secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
    if (!key) throw new Error("Missing Anthropic API key.");
    const body = { model, max_tokens: 2048, temperature: 0.25, messages: [{ role: "user", content: prompt.trim() }] };
    if (systemPrompt.trim()) body.system = systemPrompt.trim();
    const data = await engine.httpPostJson(
      "https://api.anthropic.com/v1/messages",
      { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body,
      60000
    );
    return { text: (data.content || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("").trim() };
  }

  throw new Error(`Unsupported channel: ${channel}`);
}

class Orchestrator {
  constructor({ loadState, saveState, getSecrets, executor } = {}) {
    this._loadStateFn = loadState;
    this._saveStateFn = saveState;
    this._getSecrets = getSecrets || (async () => ({}));
    this._executor = executor || defaultExecuteChannel;
  }

  loadLedger() {
    const raw = this._loadStateFn ? this._loadStateFn() : null;
    if (raw && raw.date === todayUtc()) {
      return {
        date: raw.date,
        config: deepMergeConfig(DEFAULT_ORCHESTRATOR_CONFIG, raw.config || {}),
        providers: {
          gemini: { ...emptyProviderUsage(), ...(raw.providers && raw.providers.gemini) },
          claude: { ...emptyProviderUsage(), ...(raw.providers && raw.providers.claude) },
        },
        claude_savings_usd: Number(raw.claude_savings_usd || 0),
        decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(0, 100) : [],
        sessions: raw.sessions && typeof raw.sessions === "object" ? { ...raw.sessions } : {},
      };
    }
    return {
      date: todayUtc(),
      config: deepMergeConfig(DEFAULT_ORCHESTRATOR_CONFIG, (raw && raw.config) || {}),
      providers: { gemini: emptyProviderUsage(), claude: emptyProviderUsage() },
      claude_savings_usd: 0,
      decisions: [],
      sessions: {},
    };
  }

  getSession(sessionId = "default", existingState = null) {
    const sid = String(sessionId || "default").trim() || "default";
    const state = existingState || this.loadLedger();
    const sess = state.sessions && state.sessions[sid];
    if (sess && typeof sess === "object") {
      return { ...defaultSkillSessionState(), ...sess };
    }
    return defaultSkillSessionState();
  }

  saveSession(sessionId = "default", sessState = null, existingState = null) {
    const sid = String(sessionId || "default").trim() || "default";
    const state = existingState || this.loadLedger();
    if (!state.sessions || typeof state.sessions !== "object") {
      state.sessions = {};
    }
    state.sessions[sid] = { ...defaultSkillSessionState(), ...(sessState || {}) };
    const keys = Object.keys(state.sessions);
    if (keys.length > 50) {
      for (const oldKey of keys.slice(0, keys.length - 50)) {
        delete state.sessions[oldKey];
      }
    }
    if (typeof this.saveLedger === "function") {
      this.saveLedger(state);
    } else if (typeof this._saveStateFn === "function") {
      this._saveStateFn(state);
    }
    return state.sessions[sid];
  }

  async saveLedger(state) {
    if (this._saveStateFn) await this._saveStateFn(state);
    return state;
  }

  async updateConfig(updates) {
    const state = this.loadLedger();
    state.config = deepMergeConfig(state.config, updates);
    await this.saveLedger(state);
    return this.status();
  }

  async resetUsage() {
    const state = this.loadLedger();
    const fresh = {
      date: todayUtc(),
      config: state.config,
      providers: { gemini: emptyProviderUsage(), claude: emptyProviderUsage() },
      claude_savings_usd: 0,
      decisions: [],
    };
    await this.saveLedger(fresh);
    return this.status();
  }

  async status() {
    const secrets = await this._getSecrets();
    const integ = detectIntegrations(secrets);
    const state = this.loadLedger();
    const nowSec = Date.now() / 1000;
    return {
      date: state.date,
      overall_status: integ.overall_status,
      integrations: integ,
      config: state.config,
      usage: {
        gemini: getProviderSnapshot(state, "gemini", nowSec),
        claude: getProviderSnapshot(state, "claude", nowSec),
      },
      claude_savings_usd: Number((state.claude_savings_usd || 0).toFixed(6)),
      recent_decisions: (state.decisions || []).slice(0, 15),
    };
  }

  async previewRoute(params = {}) {
    const secrets = await this._getSecrets();
    const integ = detectIntegrations(secrets);
    const state = this.loadLedger();
    const dec = decideRoute({
      task: params.task || "",
      context: params.context || "",
      role: params.role || "auto",
      requiredCapabilities: params.required_capabilities || [],
      overrideProvider: params.override_provider || null,
      strictOverride: Boolean(params.strict_override),
      integrations: integ,
      ledgerState: state,
    });
    if (params.auto_skills !== false && dec.provider) {
      const sessionId = String(params.session_id || "default").trim() || "default";
      const sess = this.getSession(sessionId, state);
      const judged = judgeSkillsFromVault({
        task: params.task || "",
        context: params.context || "",
        targetProvider: dec.provider,
        sessionState: sess,
        maxActiveSkills: 2,
        indexPath: params.indexPath || null,
        mutateState: false,
      });
      dec.skill_judgment = judged.judgment;
    }
    return dec;
  }

  async runTask(params = {}) {
    const secrets = await this._getSecrets();
    const integ = detectIntegrations(secrets);
    const state = this.loadLedger();
    const nowSec = Date.now() / 1000;

    let decision = decideRoute({
      task: params.task || "",
      context: params.context || "",
      role: params.role || "auto",
      requiredCapabilities: params.required_capabilities || [],
      overrideProvider: params.override_provider || null,
      strictOverride: Boolean(params.strict_override),
      integrations: integ,
      ledgerState: state,
      nowSec,
    });

    if (!decision.provider) {
      throw new Error(decision.error || decision.reason_summary || "No provider available.");
    }

    const autoSkills = params.auto_skills !== false && (params.role || "auto") !== "orchestrator";
    const sessionId = String(params.session_id || "default").trim() || "default";
    let skillJudgment = null;
    let taskWithSkills = String(params.task || "").trim();
    if (autoSkills) {
      const sess = this.getSession(sessionId, state);
      const judged = judgeSkillsFromVault({
        task: taskWithSkills,
        context: params.context || "",
        targetProvider: decision.provider,
        sessionState: sess,
        maxActiveSkills: 2,
        indexPath: params.indexPath || null,
        mutateState: true,
      });
      skillJudgment = judged.judgment;
      if (skillJudgment.action !== "vault_missing") {
        this.saveSession(sessionId, judged.session_state, state);
      }
      if ((skillJudgment.load_skills || []).length || (skillJudgment.unload_skills || []).length) {
        taskWithSkills = injectSkillDirectives(taskWithSkills, skillJudgment, decision.provider);
      }
    }

    const fullPrompt = String(params.context || "").trim()
      ? `${taskWithSkills}\n\nContext:\n${String(params.context).trim()}`
      : taskWithSkills;

    let provider = decision.provider;
    let channel = decision.channel;
    let model = decision.model;
    let fallbackFrom = null;
    let fallbackReason = null;
    const started = Date.now();
    let execRes;

    try {
      execRes = await this._executor({ provider, channel, model, prompt: fullPrompt, systemPrompt: params.systemPrompt || "", secrets, workspace: params.workspace || "", noQueue: Boolean(params.no_queue) });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const isRl = RATE_LIMIT_RE.test(msg);
      const pUse = state.providers[provider];
      pUse.rate_limit_hits += 1;
      pUse.cooldown_until = nowSec + Math.max(5, Number(state.config.cooldownSeconds || 60));
      pUse.cooldown_reason = msg.slice(0, 240);
      await this.saveLedger(state);

      if (!decision.fallback_provider || params.strict_override || decision.guardrail) {
        throw new Error(`${provider} failed (${msg}) and no fallback is permitted/available.`);
      }

      const fbDecision = decideRoute({
        task: params.task || "",
        context: params.context || "",
        role: params.role || "auto",
        requiredCapabilities: params.required_capabilities || [],
        overrideProvider: decision.fallback_provider,
        strictOverride: true,
        integrations: integ,
        ledgerState: state,
        nowSec,
      });
      if (!fbDecision.provider) {
        throw new Error(`${provider} failed (${msg}) and fallback ${decision.fallback_provider} is unavailable.`);
      }

      fallbackFrom = provider;
      fallbackReason = msg;
      provider = fbDecision.provider;
      channel = fbDecision.channel;
      model = fbDecision.model;
      decision = {
        ...fbDecision,
        reason_code: "fallback_after_error",
        reason_summary: `${fallbackFrom} failed (${isRl ? "rate limit" : "error"}); automatically fell back to ${provider}.`,
      };
      execRes = await this._executor({ provider, channel, model, prompt: fullPrompt, systemPrompt: params.systemPrompt || "", secrets, workspace: params.workspace || "", noQueue: Boolean(params.no_queue) });
    }

    const outText = String((execRes && execRes.text) || "").trim();
    const inTok = Number((execRes && execRes.input_tokens) || decision.classification.estimated_input_tokens);
    const outTok = Number((execRes && execRes.output_tokens) || estimateTokens(outText));
    const totTok = inTok + outTok;
    const cost = estimateCostUsd(provider, model, inTok, outTok);

    const pUsage = state.providers[provider];
    pUsage.input_tokens += inTok;
    pUsage.output_tokens += outTok;
    pUsage.tokens_used += totTok;
    pUsage.spend_usd = Number((pUsage.spend_usd + cost).toFixed(6));
    pUsage.requests += 1;
    pUsage.recent_window = [...(pUsage.recent_window || []).filter((it) => nowSec - Number(it.ts || 0) < 60), { ts: nowSec, tokens: totTok }].slice(-200);
    if (provider === "gemini" && decision.claude_savings_usd > 0) {
      state.claude_savings_usd = Number((state.claude_savings_usd + decision.claude_savings_usd).toFixed(6));
    }
    state.decisions = [
      {
        timestamp: new Date(nowSec * 1000).toISOString(),
        provider,
        channel,
        model,
        reason_code: decision.reason_code,
        reason_summary: decision.reason_summary,
        tokens: totTok,
        cost_usd: cost,
        claude_savings_usd: decision.claude_savings_usd,
      },
      ...(state.decisions || []),
    ].slice(0, 100);
    await this.saveLedger(state);

    return {
      output: outText,
      provider,
      channel,
      model,
      reason_code: decision.reason_code,
      reason_summary: decision.reason_summary,
      fallback_from: fallbackFrom,
      fallback_reason: fallbackReason,
      classification: decision.classification,
      tokens: { input: inTok, output: outTok, total: totTok },
      cost_usd: cost,
      claude_savings_usd: decision.claude_savings_usd,
      duration_ms: Date.now() - started,
      status: await this.status(),
      ...(skillJudgment ? { skill_judgment: skillJudgment } : {}),
      ...(execRes && execRes.queued_task ? { queued_task: String(execRes.queued_task) } : {}),
      ...(execRes && execRes.queue_skipped ? { queue_skipped: true } : {}),
    };
  }

  async orchestrateWorkflow(params = {}) {
    const trace = [];
    let workingContext = String(params.context || "");
    const caps = params.required_capabilities || [];
    const hasClaudePin = caps.some((c) => CLAUDE_ONLY_CAPABILITIES.has(c));

    if (params.compress_context !== false && estimateTokens(workingContext) >= 3000 && !hasClaudePin) {
      const compRes = await this.runTask({
        task: "Summarize and compress the context below while preserving all technical details relevant to the goal.",
      no_queue: true,
        context: `Goal: ${params.task}\n\n${workingContext}`,
        role: "orchestrator",
        auto_skills: false,
      });
      trace.push({
        step: "context_compression",
        role: "orchestrator",
        provider: compRes.provider,
        model: compRes.model,
        reason_code: compRes.reason_code,
        reason_summary: compRes.reason_summary,
        tokens: compRes.tokens.total,
      });
      if (!compRes.queue_skipped && String(compRes.output || "").trim()) workingContext = compRes.output;
    }

    const subtasks = Array.isArray(params.subtasks) ? params.subtasks.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!subtasks.length) {
      const mainRes = await this.runTask({ ...params, context: workingContext });
      trace.push({
        step: "main_task",
        role: mainRes.classification.role,
        provider: mainRes.provider,
        model: mainRes.model,
        reason_code: mainRes.reason_code,
        reason_summary: mainRes.reason_summary,
        tokens: mainRes.tokens.total,
      });
      return { ...mainRes, trace };
    }

    const subOutputs = [];
    for (let i = 0; i < subtasks.length; i++) {
      const subRes = await this.runTask({
        task: subtasks[i],
        context: workingContext,
        role: "auto",
        override_provider: params.override_provider,
        strict_override: params.strict_override,
        auto_skills: params.auto_skills,
        session_id: params.session_id,
        indexPath: params.indexPath,
        workspace: params.workspace,
      });
      trace.push({
        step: `subtask_${i + 1}`,
        task: subtasks[i].slice(0, 80),
        role: subRes.classification.role,
        provider: subRes.provider,
        model: subRes.model,
        reason_code: subRes.reason_code,
        reason_summary: subRes.reason_summary,
        tokens: subRes.tokens.total,
        ...(subRes.queued_task ? { queued_task: subRes.queued_task } : {}),
      });
      subOutputs.push(`### Subtask ${i + 1}: ${subtasks[i]}\n${subRes.output}`);
    }

    const aggRes = await this.runTask({
      task: "Aggregate and synthesize the subtask outputs below into a single cohesive response.",
      no_queue: true,
      context: `Overall goal: ${params.task}\n\n${subOutputs.join("\n\n")}`,
      role: "orchestrator",
      auto_skills: false,
    });
    trace.push({
      step: "aggregation",
      role: "orchestrator",
      provider: aggRes.provider,
      model: aggRes.model,
      reason_code: aggRes.reason_code,
      reason_summary: aggRes.reason_summary,
      tokens: aggRes.tokens.total,
    });
    // The orchestrator lane may only queue; then join the subtask outputs here instead of queueing a merge task.
    const aggOut = aggRes.queue_skipped || !String(aggRes.output || "").trim() ? subOutputs.join("\n\n") : aggRes.output;
    const queuedTasks = trace.map((t) => t.queued_task).filter(Boolean);
    return { ...aggRes, output: aggOut, trace, ...(queuedTasks.length ? { queued_tasks: queuedTasks } : {}) };
  }
}

const _SKILL_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "for", "to", "of",
  "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "can", "could", "should", "would",
  "may", "might", "must", "will", "this", "that", "these", "those", "it", "its", "i", "we",
  "you", "they", "my", "our", "your", "their", "need", "want", "make", "create", "build",
  "write", "help", "please", "use", "using", "into", "over", "under", "about", "all", "new",
  "good", "best", "high", "well", "some", "more", "most", "very", "just", "also", "get",
  "give", "take", "keep", "put", "add", "run", "see", "now", "here", "there", "how",
  "what", "which", "who", "why", "where", "up", "out", "so", "than", "too", "let", "me",
  "us", "company", "project", "system", "task", "work", "thanks", "thank", "looks",
  "sounds", "great", "nice", "cool", "awesome", "sure", "okay",
]);
const _SKILL_SHORT_ACRONYMS = new Set([
  "ai", "ui", "ux", "qa", "hr", "ib", "pe", "ci", "cd", "db", "ml", "pr", "go", "ts", "js", "py", "r",
]);
const _SKILL_SPECIALIST_ACRONYMS = new Set([
  "dcf", "lbo", "nda", "gdpr", "ccpa", "hipaa", "prd", "seo", "cro", "owasp", "stride",
  "pubmed", "prisma", "docx", "xlsx", "pptx", "pdf", "sql", "k8s", "tdd", "wacc", "sox",
]);
const _SKILL_KEYWORD_DOMAIN_RULES = [
  ["legal", ["contract", "nda", "gdpr", "ccpa", "hipaa", "eu ai act", "compliance", "litigation", "counsel", "statute", "clause", "redline", "due diligence", "governance", "liability", "patent", "trademark", "bylaw"]],
  ["finance", ["dcf", "lbo", "3-statement", "ebitda", "valuation", "equity research", "investment banking", "private equity", "portfolio", "reconciliation", "journal entry", "month-end close", "sox", "cash flow", "balance sheet", "income statement", "stock", "earnings", "merger", "financial model", "wacc", "sensitivity"]],
  ["medicine-science", ["pubmed", "clinical trial", "patient", "diagnosis", "ehr", "dicom", "genomics", "rna-seq", "protein", "molecule", "drug discovery", "admet", "prisma", "strobe", "stard", "biomedical", "pharmacology", "pathology", "epidemiology", "scientific", "laboratory", "arxiv"]],
  ["marketing", ["seo", "cro", "conversion rate", "landing page", "copywriting", "ad copy", "email sequence", "funnel", "go-to-market", "gtm", "brand voice", "campaign", "paid ads", "keyword research", "organic traffic", "positioning"]],
  ["product", ["prd", "product requirements", "roadmap", "user research", "rice", "jtbd", "north star", "product strategy", "backlog", "feature spec", "okr", "product-market fit", "persona", "discovery sprint"]],
  ["sales-support", ["sales", "prospecting", "cold email", "battlecard", "pipeline", "deal review", "objection handling", "discovery call", "customer support", "ticket triage", "escalation", "helpdesk", "churn"]],
  ["hr-recruiting", ["recruiting", "job description", "resume screening", "candidate", "interview rubric", "offer letter", "compensation", "salary benchmark", "onboarding", "performance review", "talent acquisition"]],
  ["design-ux", ["ui/ux", "ui design", "ux design", "typography", "color palette", "wcag", "accessibility", "layout", "wireframe", "design system", "svg diagram", "flowchart", "mermaid", "animation", "micro-interaction", "aesthetic", "visual design"]],
  ["education", ["lesson plan", "curriculum", "pedagogy", "rubric", "syllabus", "quiz", "formative assessment", "bloom", "student", "classroom", "tutoring", "instructional design", "scaffolding"]],
  ["writing-comms", ["humanize", "ai writing", "copyedit", "proofread", "storytelling", "narrative", "blog post", "newsletter", "press release", "tone of voice", "co-authoring"]],
  ["office-productivity", ["docx", "xlsx", "pptx", "pdf", "powerpoint", "excel", "word document", "spreadsheet", "slide deck", "obsidian", "markdown", "note-taking", "task management"]],
  ["data-ai", ["sql", "postgres", "postgresql", "supabase", "bigquery", "data warehouse", "data analysis", "visualization", "pandas", "huggingface", "fine-tuning", "dataset", "embeddings", "vector", "machine learning", "model training"]],
  ["security", ["threat model", "stride", "owasp", "cve", "vulnerability", "static analysis", "semgrep", "codeql", "fuzzing", "penetration", "mitre att&ck", "nist", "zero trust", "secrets", "xss", "sql injection", "smart contract audit", "security"]],
  ["business-ops", ["ceo", "cfo", "cto", "coo", "board deck", "sop", "vendor", "procurement", "okr", "kpi", "quarterly review", "small business", "risk register", "change management"]],
  ["engineering-devops", ["tdd", "test-driven", "debugging", "code review", "refactor", "react", "next.js", "typescript", "python", "kubernetes", "terraform", "docker", "ci/cd", "github actions", "observability", "opentelemetry", "incident response", "microservices"]],
];
const _SKILL_SYNONYMS = {
  dcf: ["valuation", "financial", "modeling"],
  valuation: ["dcf", "comps", "lbo", "financial"],
  financial: ["finance", "accounting", "modeling"],
  accounting: ["reconciliation", "journal", "close", "finance"],
  nda: ["contract", "agreement", "legal"],
  contract: ["agreement", "redline", "clause", "legal"],
  gdpr: ["privacy", "compliance", "data", "legal"],
  pubmed: ["literature", "medical", "biomedical", "citation"],
  clinical: ["trial", "medical", "protocol", "patient"],
  bioinformatics: ["genomics", "rna", "sequence", "scientific"],
  seo: ["search", "organic", "marketing", "audit"],
  cro: ["conversion", "landing", "optimization", "funnel"],
  prd: ["requirements", "spec", "product"],
  roadmap: ["strategy", "prioritization", "product"],
  battlecard: ["competitive", "sales", "positioning"],
  ui: ["interface", "frontend", "design", "ux"],
  ux: ["usability", "design", "user", "accessibility"],
  a11y: ["accessibility", "wcag", "screen-reader"],
  svg: ["diagram", "chart", "visual"],
  diagram: ["architecture", "flowchart", "visual", "svg"],
  curriculum: ["lesson", "syllabus", "pedagogy", "education"],
  docx: ["word", "document", "report"],
  xlsx: ["excel", "spreadsheet", "financial"],
  pptx: ["powerpoint", "slides", "deck", "presentation"],
  sql: ["postgres", "bigquery", "database", "query"],
  security: ["threat", "owasp", "audit", "vulnerability"],
  tdd: ["testing", "unit", "pytest", "verification"],
};
const _SKILL_ACTION_VERBS = new Set([
  "architect", "architecture", "implement", "refactor", "migrate", "audit", "review",
  "model", "valuation", "forecast", "redline", "draft", "optimize", "deploy", "debug",
  "benchmark", "integrate", "package", "protocol", "curriculum", "diagram", "presentation",
  "spreadsheet", "threat", "compliance", "pipeline", "design", "analyze", "assess",
  "evaluate", "synthesize", "reconcile",
]);
const _SKILL_RISK_SIGNALS = new Set([
  "test", "tests", "testing", "edge", "security", "compliance", "gdpr", "hipaa", "sox",
  "accessibility", "wcag", "production", "schema", "ci", "cd", "multi", "backwards",
  "compatibility", "sensitivity", "audit", "verification", "threat", "stride", "owasp",
  "governance",
]);
const _SKILL_ACK_RE = /^(?:ok(?:ay)?|yes|yep|yeah|no|nope|thanks|thank\s+you|thx|please|continue|proceed|looks\s+good|sounds\s+good|go\s+ahead|do\s+it|done|hi|hello|hey|cool|great|nice|got\s+it|sure)(?:[\s,!.;]+(?:ok(?:ay)?|yes|yep|yeah|no|nope|thanks|thank\s+you|thx|please|continue|proceed|looks\s+good|sounds\s+good|go\s+ahead|do\s+it|done|hi|hello|hey|cool|great|nice|got\s+it|sure))*[.!?\s]*$/i;
const _SKILL_DIRECTIVE_BLOCK_RE = /\n*##\s+(?:Skills\s+to\s+Load|Skill\s+Directives(?:\s*\([^)]*\))?)\b[\s\S]*?(?=\n##\s+|$)/gi;
const _SKILL_SWITCH_TOPIC_RE = /\b(?:switch\s+to|new\s+topic|different\s+task|unrelated\s+task|forget\s+previous|start\s+fresh)\b/i;
const _SKILL_GEORGIAN_SPEC_RE = /(?:ფინანს|ბუღალტ|კონტრაქტ|იურ|სამედიც|მარკეტინგ|უსაფრთხ|დიზაინ|დიაგრამ|dcf|nda|gdpr|prd|seo|owasp|stride|docx|xlsx|pptx|pdf|sql|kubernetes|terraform)/i;
const _SKILL_LEVEL_RANK = { low: 0, medium: 1, high: 2 };

function defaultSkillSessionState() {
  return {
    turn_count: 0,
    loaded_skills: [],
    loaded_domains: [],
    recommended_skill_ids: [],
    unloaded_history: [],
    peak_complexity_score: 0.0,
    peak_complexity_level: "low",
  };
}

function _normSkillName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function _tokenizeSkillText(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().match(/[a-z0-9][a-z0-9_+.-]*/g) || [];
  const out = [];
  for (const tok of raw) {
    for (const part of tok.split(/[._/]+/)) {
      if (!part) continue;
      if ((part.length >= 2 || _SKILL_SHORT_ACRONYMS.has(part)) && !_SKILL_STOPWORDS.has(part)) {
        out.push(part);
      }
    }
  }
  return out;
}

function stripSkillDirectives(text) {
  return String(text || "").replace(_SKILL_DIRECTIVE_BLOCK_RE, "").trim();
}

function _isTrivialSkillPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return true;
  if (text.startsWith("SYSTEM OVERRIDE: You are Re-Prompt")) return true;
  if (_SKILL_ACK_RE.test(text)) return true;

  const alpha = text.match(/\p{L}/gu) || [];
  if (alpha.length) {
    const ka = alpha.filter((ch) => ch >= "\u10A0" && ch <= "\u10FF").length;
    if (ka / alpha.length >= 0.4 && !_SKILL_GEORGIAN_SPEC_RE.test(text)) {
      return true;
    }
  }
  if (text.length < 14) {
    const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!words.some((w) => _SKILL_SPECIALIST_ACRONYMS.has(w))) return true;
  }
  return false;
}

function _detectSkillDomains(text) {
  const lower = String(text || "").toLowerCase();
  const scores = {};
  for (const [dom, keywords] of _SKILL_KEYWORD_DOMAIN_RULES) {
    let hits = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) hits += 1;
    }
    if (hits > 0) scores[dom] = hits;
  }
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([dom]) => dom);
}

function _scoreSkillComplexity(text, workspaceContext = "") {
  const combined = `${text || ""} ${workspaceContext || ""}`.trim();
  const tokens = _tokenizeSkillText(combined);
  const tokenSet = new Set(tokens);
  const domains = _detectSkillDomains(combined);
  const signals = [];
  let score = 0;

  if (tokens.length >= 8) score += 1.0;
  if (tokens.length >= 18) {
    score += 1.5;
    signals.push("detailed_prompt");
  }
  if (tokens.length >= 35) score += 1.5;

  const actionHits = [...tokenSet].filter((t) => _SKILL_ACTION_VERBS.has(t));
  if (actionHits.length) {
    score += Math.min(2.5, actionHits.length * 0.8);
    signals.push("action_verbs");
  }
  if (domains.length >= 1) {
    score += 1.5;
    signals.push(`domains:${domains.slice(0, 3).join(",")}`);
  }
  if (domains.length >= 2) {
    score += 2.0;
    signals.push("cross_domain");
  }
  const specHits = [...tokenSet].filter((t) => _SKILL_SPECIALIST_ACRONYMS.has(t));
  if (specHits.length) {
    score += Math.min(2.5, specHits.length * 1.2);
    signals.push("specialist_terms");
  }
  const riskHits = [...tokenSet].filter((t) => _SKILL_RISK_SIGNALS.has(t));
  if (riskHits.length) {
    score += Math.min(2.0, riskHits.length * 0.9);
    signals.push("risk_or_verification");
  }
  const level = score >= 6.5 ? "high" : (score >= 3.0 ? "medium" : "low");
  return {
    score: Math.round(score * 100) / 100,
    level,
    domains: domains.slice(0, 3),
    signals,
  };
}

function _compactVaultSkill(s, score = 0) {
  return {
    id: s.id,
    name: s.name,
    domain: s.domain || "",
    repo: s.repo || "",
    ecosystem_focus: s.ecosystem_focus || "universal",
    stars: Number(s.stars || 0),
    tier: Number(s.tier || 3),
    description: s.description || "",
    path: s.path || "",
    has_scripts: Boolean(s.has_scripts),
    has_references: Boolean(s.has_references),
    score: Math.round(Number(score || 0) * 100) / 100,
  };
}

function _scoreLoadedSkillRelevance(skill, promptTokSet, detectedDomains) {
  let score = 0;
  if (detectedDomains.includes(skill.domain)) score += 2.5;
  const nameToks = new Set(_tokenizeSkillText(String(skill.name || "").replace(/[-_]/g, " ")));
  const descToks = new Set(_tokenizeSkillText(skill.description || ""));
  for (const t of nameToks) {
    if (promptTokSet.has(t)) score += 3.0;
  }
  for (const t of descToks) {
    if (promptTokSet.has(t)) score += 1.5;
  }
  return Math.round(score * 100) / 100;
}

function _searchVaultSkillsNode(query, { domain = null, limit = 8, indexData = null, targetProvider = null } = {}) {
  const skills = Array.isArray(indexData && indexData.skills) ? indexData.skills : [];
  const pool = domain ? skills.filter((s) => s.domain === domain) : skills;
  if (!pool.length) return [];

  const baseTokens = _tokenizeSkillText(query);
  if (!baseTokens.length) return [];
  const baseSet = new Set(baseTokens);
  const synTokens = [];
  for (const t of baseTokens) {
    for (const st of (_SKILL_SYNONYMS[t] || [])) {
      if (!baseSet.has(st)) synTokens.push(st);
    }
  }
  const synUnique = [...new Set(synTokens)];
  const rawQ = String(query || "").trim().toLowerCase();
  const slugQ = rawQ.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const df = Object.create(null);
  const docs = pool.map((s) => {
    const nameToks = new Set(_tokenizeSkillText(String(s.name || "").replace(/-/g, " ")));
    const descToks = new Set(_tokenizeSkillText(s.description || ""));
    const pathToks = new Set(_tokenizeSkillText(`${s.path || ""} ${s.repo || ""}`));
    const union = new Set([...nameToks, ...descToks, ...pathToks]);
    for (const t of union) df[t] = (df[t] || 0) + 1;
    return { s, nameToks, descToks, pathToks };
  });

  const nDocs = Math.max(1, docs.length);
  const idfFor = (t) => Math.log(1.0 + (nDocs - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
  const scored = [];
  const tp = targetProvider === "gemini" || targetProvider === "claude" ? targetProvider : null;

  for (const { s, nameToks, descToks, pathToks } of docs) {
    let score = 0;
    let matchedBase = 0;
    const sNameLower = String(s.name || "").toLowerCase();
    const sDescLower = String(s.description || "").toLowerCase();

    if (sNameLower.includes(rawQ) || (slugQ && sNameLower.includes(slugQ))) {
      score += 18.0;
    } else if (sDescLower.includes(rawQ)) {
      score += 7.0;
    }

    for (const t of baseTokens) {
      const idf = idfFor(t);
      let hit = false;
      if (nameToks.has(t)) {
        score += 6.0 * idf;
        hit = true;
      } else if (t.length >= 3 && [...nameToks].some((nt) => nt.includes(t))) {
        score += 3.5 * idf;
        hit = true;
      }
      if (descToks.has(t)) {
        score += 2.6 * idf;
        hit = true;
      } else if (t.length >= 4 && [...descToks].some((dt) => dt.includes(t))) {
        score += 1.1 * idf;
        hit = true;
      }
      if (pathToks.has(t)) {
        score += 1.6 * idf;
        hit = true;
      }
      if (hit) matchedBase += 1;
    }

    if (matchedBase === 0) {
      let synHits = 0;
      for (const t of synUnique) {
        const idf = idfFor(t);
        if (nameToks.has(t)) {
          score += 2.2 * idf;
          synHits += 1;
        } else if (descToks.has(t)) {
          score += 1.0 * idf;
          synHits += 1;
        }
      }
      if (synHits === 0) continue;
    } else {
      const coverage = matchedBase / baseTokens.length;
      score *= 0.65 + 0.7 * coverage;
      for (const t of synUnique) {
        const idf = idfFor(t);
        if (nameToks.has(t)) score += 1.8 * idf;
        else if (descToks.has(t)) score += 0.7 * idf;
      }
    }

    const tier = Number(s.tier || 3);
    const authMult = tier === 1 ? 1.18 : (tier === 2 ? 1.08 : 1.0);
    const stars = Number(s.stars || 0);
    const starMult = 1.0 + Math.min(0.14, Math.log10(Math.max(stars, 10)) * 0.025);
    const eco = String(s.ecosystem_focus || "universal").toLowerCase();
    const ecoMult = tp && eco === tp ? 1.06 : 1.0;
    score *= authMult * starMult * ecoMult;
    scored.push([score, s]);
  }

  scored.sort((a, b) => (
    (b[0] - a[0])
    || (Number(a[1].tier || 3) - Number(b[1].tier || 3))
    || (Number(b[1].stars || 0) - Number(a[1].stars || 0))
    || String(a[1].name || "").localeCompare(String(b[1].name || ""))
  ));
  return scored.slice(0, Math.max(1, limit));
}

function judgeSkillsFromVault({
  task = "",
  rewrittenPrompt = "",
  context = "",
  targetProvider = "auto",
  sessionState = null,
  maxActiveSkills = 2,
  indexPath = null,
  mutateState = true,
} = {}) {
  const fsMod = require("fs");
  const pathMod = require("path");
  const osMod = require("os");

  const state = {
    ...defaultSkillSessionState(),
    ...(sessionState && typeof sessionState === "object" ? JSON.parse(JSON.stringify(sessionState)) : {}),
  };

  const vaultDir = process.env.REPROMPT_SKILL_VAULT_DIR || pathMod.join(osMod.homedir(), ".gemini", "skill-vault");
  const idxFile = indexPath || pathMod.join(vaultDir, "index.json");
  let indexData = null;
  try {
    if (fsMod.existsSync(idxFile)) {
      indexData = JSON.parse(fsMod.readFileSync(idxFile, "utf8"));
    }
  } catch {
    indexData = null;
  }

  if (!indexData || !Array.isArray(indexData.skills)) {
    const missing = {
      action: "vault_missing",
      turn: Number(state.turn_count || 0),
      target_provider: targetProvider,
      complexity: { score: 0.0, level: "low", domains: [], signals: [] },
      load_skills: [],
      keep_skills: [],
      unload_skills: [],
      active_skills: Array.isArray(state.loaded_skills) ? state.loaded_skills : [],
      reason: "Local skill vault index not initialized yet.",
      query: "",
    };
    return { ...missing, judgment: missing, session_state: state };
  }

  const cleanReceived = stripSkillDirectives(task);
  const cleanRewritten = stripSkillDirectives(rewrittenPrompt);
  const combinedText = [cleanReceived, cleanRewritten].filter(Boolean).join("\n\n").trim();
  const loadedNow = Array.isArray(state.loaded_skills) ? state.loaded_skills : [];

  if (_isTrivialSkillPrompt(cleanReceived) && !cleanRewritten) {
    if (mutateState) state.turn_count = Number(state.turn_count || 0) + 1;
    const triv = {
      action: loadedNow.length ? "keep" : "none",
      turn: Number(state.turn_count || 0),
      target_provider: targetProvider,
      complexity: { score: 0.0, level: "low", domains: [], signals: ["trivial"] },
      load_skills: [],
      keep_skills: loadedNow,
      unload_skills: [],
      active_skills: loadedNow,
      reason: loadedNow.length
        ? "Trivial prompt; keeping existing session state unchanged."
        : "Trivial prompt; no skills needed.",
      query: "",
    };
    return { ...triv, judgment: triv, session_state: state };
  }

  const complexity = _scoreSkillComplexity(combinedText, context);
  const domains = complexity.domains || [];
  const qToks = _tokenizeSkillText(combinedText);
  const queryParts = [];
  for (const t of qToks) {
    if (!queryParts.includes(t) && queryParts.length < 10) queryParts.push(t);
  }
  const query = queryParts.join(" ");
  const promptTokSet = new Set(qToks);
  const explicitSwitch = _SKILL_SWITCH_TOPIC_RE.test(cleanReceived);

  const byId = new Map();
  if (qToks.length) {
    for (const [sc, s] of _searchVaultSkillsNode(query, { limit: 6, indexData, targetProvider })) {
      const boosted = sc * (domains.includes(s.domain) ? 1.25 : 1.0);
      if (!byId.has(s.id) || boosted > byId.get(s.id)[0]) byId.set(s.id, [boosted, s]);
    }
    for (const dom of domains.slice(0, 2)) {
      for (const [sc, s] of _searchVaultSkillsNode(query, { domain: dom, limit: 4, indexData, targetProvider })) {
        const boosted = sc * 1.25;
        if (!byId.has(s.id) || boosted > byId.get(s.id)[0]) byId.set(s.id, [boosted, s]);
      }
    }
  }
  const candidates = [...byId.values()].sort((a, b) => b[0] - a[0]);

  const effectiveMax = (complexity.level === "high" && domains.length >= 2)
    ? Math.max(maxActiveSkills, 3)
    : maxActiveSkills;
  const minScore = (complexity.level === "medium" || complexity.level === "high" || Boolean(cleanRewritten)) ? 13.0 : 20.0;
  let filtered = candidates.filter(([sc]) => sc >= minScore);
  const hasSpecialist = domains.length > 0
    || [...promptTokSet].some((t) => _SKILL_SPECIALIST_ACRONYMS.has(t))
    || (Boolean(cleanRewritten) && filtered.length > 0);
  if (complexity.level === "low" && !hasSpecialist) {
    filtered = [];
  }

  const keepSkills = [];
  const unloadSkills = [];
  const candDomains = new Set(filtered.slice(0, 4).map(([, s]) => s.domain).filter(Boolean));

  for (const sk of loadedNow) {
    const rel = _scoreLoadedSkillRelevance(sk, promptTokSet, domains);
    const skDom = sk.domain || "";
    const domMismatch = domains.length > 0 && !domains.includes(skDom);
    const candShift = candDomains.size > 0 && !candDomains.has(skDom);

    if (explicitSwitch && rel < 6.0) {
      unloadSkills.push({ ...sk, unload_reason: "explicit topic switch" });
    } else if (rel < 2.5 && (domMismatch || (candShift && domains.length === 0))) {
      const domLabel = domains.length ? domains.join(", ") : [...candDomains].sort().slice(0, 2).join(", ");
      unloadSkills.push({ ...sk, unload_reason: `off-topic for ${domLabel || "current task"}` });
    } else {
      keepSkills.push({ ...sk, relevance: rel });
    }
  }

  const keepIds = new Set(keepSkills.map((s) => s.id));
  const keepNames = new Set(keepSkills.map((s) => _normSkillName(s.name)));
  const pickPool = [];

  if (domains.length >= 2 && filtered.length >= 2) {
    const usedDoms = new Set(keepSkills.map((s) => s.domain).filter(Boolean));
    for (const [sc, s] of filtered) {
      if (keepIds.has(s.id) || keepNames.has(_normSkillName(s.name))) continue;
      if (domains.slice(0, 2).includes(s.domain) && !usedDoms.has(s.domain)) {
        pickPool.push(_compactVaultSkill(s, sc));
        usedDoms.add(s.domain);
        if (pickPool.length >= effectiveMax) break;
      }
    }
  }
  for (const [sc, s] of filtered) {
    if (pickPool.length >= effectiveMax) break;
    if (keepIds.has(s.id) || keepNames.has(_normSkillName(s.name))) continue;
    if (!pickPool.some((p) => p.id === s.id)) {
      pickPool.push(_compactVaultSkill(s, sc));
    }
  }

  const loadSkills = [];
  for (const cand of pickPool) {
    if (keepSkills.length + loadSkills.length < effectiveMax) {
      loadSkills.push(cand);
    } else if (keepSkills.length) {
      let lowestIdx = 0;
      for (let i = 1; i < keepSkills.length; i += 1) {
        if (Number(keepSkills[i].relevance || 0) < Number(keepSkills[lowestIdx].relevance || 0)) {
          lowestIdx = i;
        }
      }
      const lowest = keepSkills[lowestIdx];
      if (Number(lowest.relevance || 0) < 5.0 && lowest.domain !== cand.domain) {
        keepSkills.splice(lowestIdx, 1);
        unloadSkills.push({ ...lowest, unload_reason: "replaced by higher-relevance skill for current task" });
        loadSkills.push(cand);
      }
    }
  }

  const activeSkills = [...keepSkills, ...loadSkills];
  if (mutateState) {
    state.turn_count = Number(state.turn_count || 0) + 1;
    state.loaded_skills = activeSkills;
    state.loaded_domains = [...new Set([...activeSkills.map((s) => s.domain).filter(Boolean), ...domains])];
    if (unloadSkills.length) {
      const hist = Array.isArray(state.unloaded_history) ? [...state.unloaded_history] : [];
      for (const u of unloadSkills) {
        hist.push({ id: u.id || "", name: u.name || "", reason: u.unload_reason || "" });
      }
      state.unloaded_history = hist.slice(-30);
    }
    state.peak_complexity_score = Math.max(Number(state.peak_complexity_score || 0), complexity.score);
    if ((_SKILL_LEVEL_RANK[complexity.level] || 0) > (_SKILL_LEVEL_RANK[state.peak_complexity_level] || 0)) {
      state.peak_complexity_level = complexity.level;
    }
  }

  let action = "none";
  let reason = "No specialized vault skills required for this prompt.";
  if (loadSkills.length && unloadSkills.length) {
    action = "swap";
    reason = `Swapped skills: loaded ${loadSkills.map((s) => s.name).join(", ")}; unloaded ${unloadSkills.map((u) => u.name).join(", ")}.`;
  } else if (loadSkills.length) {
    action = "load";
    reason = `Auto-selected ${loadSkills.length} skill(s) for ${domains.join(", ") || "task"}: ${loadSkills.map((s) => s.name).join(", ")}.`;
  } else if (unloadSkills.length) {
    action = "unload";
    reason = `Unloaded ${unloadSkills.length} off-topic skill(s): ${unloadSkills.map((u) => u.name).join(", ")}.`;
  } else if (keepSkills.length) {
    action = "keep";
    reason = `Kept ${keepSkills.length} active skill(s): ${keepSkills.map((s) => s.name).join(", ")}.`;
  }

  const judgment = {
    action,
    turn: Number(state.turn_count || 0),
    target_provider: targetProvider,
    complexity,
    load_skills: loadSkills,
    keep_skills: keepSkills,
    unload_skills: unloadSkills,
    active_skills: activeSkills,
    reason,
    query,
  };
  return { ...judgment, judgment, session_state: state };
}

function formatSkillDirectives(judgment, _targetProvider = "auto") {
  const j = judgment || {};
  const loadSkills = Array.isArray(j.load_skills) ? j.load_skills : [];
  const unloadSkills = Array.isArray(j.unload_skills) ? j.unload_skills : [];
  const keepSkills = Array.isArray(j.keep_skills) ? j.keep_skills : [];
  if (!loadSkills.length && !unloadSkills.length) return "";

  const lines = ["## Skill Directives (Auto-Selected)"];
  if (loadSkills.length) {
    lines.push("- **Load (read and apply before executing):**");
    for (const s of loadSkills) {
      lines.push(`  - **${s.name}** (\`${s.domain}\`, Tier ${s.tier || 2} · ${s.repo || ""}): \`${s.path}\``);
    }
  }
  if (unloadSkills.length) {
    lines.push("- **Unload (drop from active context — no longer needed for this task):**");
    for (const u of unloadSkills) {
      lines.push(`  - **${u.name}** (\`${u.domain}\`): ${u.unload_reason || "no longer relevant"}`);
    }
  }
  if (keepSkills.length) {
    lines.push(`- **Keep Active:** ${keepSkills.map((s) => `\`${s.name}\``).join(", ")}`);
  }
  return lines.join("\n");
}

function injectSkillDirectives(promptText, judgment, targetProvider = "auto") {
  const block = formatSkillDirectives(judgment, targetProvider);
  if (!block) return String(promptText || "");
  const cleaned = stripSkillDirectives(promptText);
  if (!cleaned) return block;

  const goalMatch = /^##\s+Goal\b[\s\S]*?(?=\n##\s+|$)/im.exec(cleaned);
  if (goalMatch) {
    const idx = goalMatch.index + goalMatch[0].length;
    const before = cleaned.slice(0, idx).replace(/\s+$/, "");
    const after = cleaned.slice(idx).replace(/^\s+/, "");
    return after ? `${before}\n\n${block}\n\n${after}` : `${before}\n\n${block}`;
  }
  return `${block}\n\n${cleaned}`;
}

module.exports = {
  judgeSkillsFromVault,
  formatSkillDirectives,
  injectSkillDirectives,
  CLAUDE_ONLY_CAPABILITIES,
  GEMINI_ONLY_CAPABILITIES,
  DEFAULT_ORCHESTRATOR_CONFIG,
  findGeminiBinary,
  detectIntegrations,
  defaultExecuteChannel,
  queueForAntigravity,
  queueCallerSource,
  QUEUE_CHANNELS,
  QUEUE_DETAIL,
  estimateTokens,
  estimateCostUsd,
  classifyTask,
  decideRoute,
  Orchestrator,
};

