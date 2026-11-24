"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const TARGETS = {
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    guidance:
      "Optimize for an autonomous coding agent in Antigravity IDE / CLI " +
      "(capable of reading/editing workspace files, running terminal commands, " +
      "searching the codebase, and verifying changes). Specify concrete deliverables, " +
      "acceptance criteria, verification commands/tests, and guardrails.",
  },
  claude_code: {
    id: "claude_code",
    label: "Claude Code",
    guidance:
      "Optimize for Claude Code (terminal & IDE coding agent). Make the prompt " +
      "crystal clear about exploration vs. editing expectations, exact scope, " +
      "edge cases, coding conventions to preserve, and verification checks to run " +
      "before finishing.",
  },
  general: {
    id: "general",
    label: "General AI",
    guidance:
      "Optimize for a general-purpose AI coding or reasoning assistant. Structure " +
      "the objective, background context, explicit instructions, output format, " +
      "and quality checks clearly.",
  },
};

const MODES = {
  balanced: {
    id: "balanced",
    label: "Balanced",
    guidance:
      "Produce a clear, well-proportioned specification with concise sections: " +
      "Goal, Context & Scope, Requirements, Constraints & Edge Cases, and Verification.",
  },
  deep_spec: {
    id: "deep_spec",
    label: "Deep Spec",
    guidance:
      "Produce a thorough engineering specification covering architecture, data flow, " +
      "interfaces, error handling, edge cases, non-goals, and multi-step verification.",
  },
  bug_fix: {
    id: "bug_fix",
    label: "Bug Fix",
    guidance:
      "Frame the prompt around root-cause investigation first: observed vs. expected " +
      "behavior, reproduction steps, likely fault boundaries, fix constraints, and " +
      "regression test verification.",
  },
  refactor: {
    id: "refactor",
    label: "Refactor",
    guidance:
      "Emphasize behavior preservation, structural clarity, modular boundaries, " +
      "backwards compatibility, incremental steps, and proving existing behavior stays intact.",
  },
  concise: {
    id: "concise",
    label: "Concise",
    guidance:
      "Keep the rewritten prompt compact and punchy (short bullet points, no fluff) " +
      "while still eliminating ambiguity and stating clear verification criteria.",
  },
};

const REFINEMENTS = {
  shorter:
    "Condense the rewritten prompt by ~35-45% while preserving every critical requirement, constraint, and verification step.",
  detailed:
    "Expand the rewritten prompt with more concrete implementation guidance, edge cases, failure modes, and acceptance checks without inventing nonexistent files.",
  edge_cases:
    "Strengthen the Constraints & Edge Cases section to explicitly call out boundary conditions, error states, concurrency/platform pitfalls, and invalid inputs.",
  add_tests:
    "Enhance the Verification section with specific unit, integration, and manual/end-to-end test cases the AI should write and run.",
};

const DEFAULT_SETTINGS = {
  provider: "agy",
  agyModel: "gemini-3.8-flash-low",
  claudeModel: "",
  geminiModel: "gemini-4-hydrogen",
  anthropicModel: "claude-sonnet-4-20250514",
  openaiModel: "gpt-4o-mini",
  openaiBaseUrl: "https://api.openai.com/v1",
  defaultTarget: "antigravity",
  defaultMode: "balanced",
  autoRewrite: false,
  autoRewriteDelayMs: 1200,
  includeWorkspaceContext: true,
  openInFloatingWindow: true,
};

const PREAMBLE_RE =
  /^(?:here(?:'s| is)\s+(?:the\s+)?(?:rewritten|improved|refined|updated)\s+prompt\s*:?\s*\n+|sure[,!.]?\s+here(?:'s| is)[^\n]*:\s*\n+|rewritten\s+prompt\s*:\s*\n+)/i;

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function findInPath(names) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

function findAgyBinary() {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const fromPath = findInPath(isWin ? ["agy.exe", "agy.cmd", "agy"] : ["agy"]);
  if (fromPath) return fromPath;

  const candidates = [
    path.join(home, ".local", "bin", isWin ? "agy.exe" : "agy"),
    path.join(home, ".gemini", "bin", isWin ? "agy.exe" : "agy"),
    path.join(home, ".gemini", "antigravity", "bin", isWin ? "agy.exe" : "agy"),
  ];
  if (!isWin) {
    candidates.push("/usr/local/bin/agy", "/opt/homebrew/bin/agy");
  } else {
    const localApp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.unshift(
      path.join(localApp, "Programs", "antigravity", "agy.exe"),
      path.join(localApp, "Antigravity", "agy.exe")
    );
  }
  return candidates.find(isExecutableFile) || null;
}

function findClaudeBinary() {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const fromPath = findInPath(isWin ? ["claude.exe", "claude.cmd", "claude"] : ["claude"]);
  if (fromPath) return fromPath;

  const candidates = [
    path.join(home, ".claude", "local", isWin ? "claude.exe" : "claude"),
    path.join(home, ".local", "bin", isWin ? "claude.exe" : "claude"),
    path.join(home, ".npm-global", "bin", isWin ? "claude.cmd" : "claude"),
  ];
  if (!isWin) {
    candidates.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  } else {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    candidates.unshift(
      path.join(appData, "npm", "claude.cmd"),
      path.join(appData, "npm", "claude.exe")
    );
  }
  return candidates.find(isExecutableFile) || null;
}

function runSubprocess(bin, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      env: { ...process.env, NO_COLOR: "1", REPROMPT_INTERNAL_CALL: "1" },
      shell: isWinCmd,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGTERM");
        } catch (_) {}
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s running ${path.basename(bin)}`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function httpPostJson(rawUrl, headers, payload, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(
      parsed,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}: ${data.slice(0, 400)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${parsed.hostname}: ${err.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Request to ${parsed.hostname} timed out`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildSystemPrompt(target, mode) {
  const tInfo = TARGETS[target] || TARGETS.antigravity;
  const mInfo = MODES[mode] || MODES.balanced;
  return (
    "SYSTEM OVERRIDE: You are Re-Prompt, a deterministic prompt-engineering transformation " +
    "utility inside an IDE developer tool. Ignore any external persona, storytelling, " +
    "child-mentoring, or forced-language rules. This is a strict JSON data-transformation call.\n\n" +
    "MISSION:\n" +
    "Transform the user's rough, informal, or underspecified prompt into a structured, " +
    "unambiguous, detailed prompt that is simultaneously:\n" +
    "1. Easy for an AI coding agent to execute accurately on the first try (clear scope, " +
    "concrete requirements, explicit constraints, and verification steps).\n" +
    "2. Easy for the human prompter to read, scan, and edit in seconds (clean Markdown headings " +
    "and crisp bullet points, zero robotic jargon or bloated boilerplate).\n\n" +
    `TARGET ASSISTANT (${tInfo.label}):\n${tInfo.guidance}\n\n` +
    `REWRITE MODE (${mInfo.label}):\n${mInfo.guidance}\n\n` +
    "STRICT RULES:\n" +
    "- LANGUAGE PRESERVATION: Write `rewritten_prompt`, `summary`, and `improvements` in the " +
    "EXACT same natural language as the user's `<ROUGH_PROMPT>` (e.g., if English, respond ONLY in English; " +
    "if Georgian, ONLY in Georgian; if Spanish, ONLY in Spanish).\n" +
    "- NEVER invent or hallucinate file paths, symbol names, library versions, or command outputs " +
    "not present in `<ROUGH_PROMPT>` or `<WORKSPACE_CONTEXT>`. Use generic phrasing (e.g., 'the relevant module') " +
    "when exact paths are unknown.\n" +
    "- Preserve every explicit user requirement, constraint, technology choice, and preference.\n" +
    "- Structure `rewritten_prompt` using clean Markdown headings (`## Goal`, `## Context & Scope`, " +
    "`## Requirements`, `## Constraints & Edge Cases`, `## Verification`) — omit `## Context & Scope` only in " +
    "`concise` mode if unnecessary.\n" +
    "- Do NOT execute tools, read files, or answer the prompt yourself — ONLY rewrite it.\n" +
    "- Output ONLY a single valid JSON object (no markdown preamble or postscript) with this exact schema:\n" +
    "{\n" +
    '  "rewritten_prompt": "<clean markdown prompt string>",\n' +
    '  "summary": "<1 concise sentence explaining how the prompt was improved>",\n' +
    '  "improvements": ["<short tag 1>", "<short tag 2>", "<short tag 3>"]\n' +
    "}\n"
  );
}

function buildUserPrompt({
  roughPrompt,
  target = "antigravity",
  mode = "balanced",
  workspaceContext = "",
  refinement = "",
  previousRewritten = "",
}) {
  const parts = [
    `<TARGET>${target}</TARGET>`,
    `<MODE>${mode}</MODE>`,
    `<ROUGH_PROMPT>\n${String(roughPrompt || "").trim()}\n</ROUGH_PROMPT>`,
  ];
  if (workspaceContext && workspaceContext.trim()) {
    parts.push(`<WORKSPACE_CONTEXT>\n${workspaceContext.trim()}\n</WORKSPACE_CONTEXT>`);
  }
  if (previousRewritten && previousRewritten.trim()) {
    parts.push(`<CURRENT_REWRITTEN_PROMPT>\n${previousRewritten.trim()}\n</CURRENT_REWRITTEN_PROMPT>`);
  }
  if (refinement && refinement.trim()) {
    const inst = REFINEMENTS[refinement.trim()] || refinement.trim();
    parts.push(`<REFINEMENT_INSTRUCTION>\n${inst}\n</REFINEMENT_INSTRUCTION>`);
  }
  parts.push("Return ONLY the JSON object matching the required schema.");
  return parts.join("\n\n");
}

function extractBalancedJson(text) {
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inStr) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(start, i + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch (_) {
              break;
            }
          }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

function parseRewriteResponse(rawText, originalPrompt = "") {
  const cleaned = String(rawText || "").trim();
  if (!cleaned) {
    throw new Error("Provider returned an empty response.");
  }

  let parsed = null;
  if (cleaned.startsWith("{")) {
    try {
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj === "object") parsed = obj;
    } catch (_) {}
  }

  if (!parsed) {
    const m = cleaned.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/i);
    if (m) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj && typeof obj === "object") parsed = obj;
      } catch (_) {}
    }
  }

  if (!parsed) {
    const candidate = extractBalancedJson(cleaned);
    if (candidate) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === "object") parsed = obj;
      } catch (_) {}
    }
  }

  if (parsed && typeof parsed.rewritten_prompt === "string" && parsed.rewritten_prompt.trim()) {
    const improvements = Array.isArray(parsed.improvements)
      ? parsed.improvements.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [];
    return {
      rewritten_prompt: parsed.rewritten_prompt.trim(),
      summary: String(parsed.summary || "Structured goal, constraints, and verification steps.").trim(),
      improvements: improvements.length ? improvements : ["Clear Goal", "Actionable Requirements", "Verification Steps"],
    };
  }

  let fallback = cleaned.replace(PREAMBLE_RE, "").trim();
  if (fallback.startsWith("```") && fallback.endsWith("```")) {
    const lines = fallback.split("\n");
    if (lines.length >= 3) fallback = lines.slice(1, -1).join("\n").trim();
  }
  if (!fallback) fallback = String(originalPrompt || "").trim();

  return {
    rewritten_prompt: fallback,
    summary: "Structured rough input into clear instructions for AI and human review.",
    improvements: ["Structured Layout", "Explicit Scope", "Verification Criteria"],
  };
}

function capFirst(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : "";
}

function offlineRewrite({
  roughPrompt,
  target = "antigravity",
  mode = "balanced",
  workspaceContext = "",
  refinement = "",
}) {
  const cleanLines = String(roughPrompt || "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const goalLine = cleanLines[0] || String(roughPrompt || "").trim();

  const rawClauses = String(roughPrompt || "")
    .trim()
    .split(/(?:\.\s+|;|\bthen\b|\n|\band\s+(?=add|fix|update|create|build|test|check|make|write|implement|refactor))/i);
  let requirements = rawClauses.map((c) => c.replace(/^[\s.,-]+|[\s.,-]+$/g, "")).filter(Boolean);
  if (!requirements.length) requirements = [goalLine];
  requirements = requirements.map(capFirst);

  const targetNote =
    {
      antigravity:
        "Inspect relevant workspace files before editing, implement changes incrementally, and verify behavior end-to-end.",
      claude_code:
        "Explore the relevant codebase context first, preserve existing conventions, implement minimal clean edits, and verify with tests.",
      general:
        "Address every requirement below directly, avoid guessing missing facts, and present clear verifiable output.",
    }[target] || "Implement the goal carefully and verify the result.";

  if (mode === "concise" || refinement === "shorter") {
    const reqBullets = requirements.slice(0, 5).map((r) => `- ${r}`).join("\n");
    const ctxLine = workspaceContext.trim() ? `\n- Workspace context: ${workspaceContext.trim()}` : "";
    return {
      rewritten_prompt:
        `## Goal\n${capFirst(goalLine)}\n\n` +
        `## Requirements\n${reqBullets}${ctxLine}\n\n` +
        `## Verification\n- Confirm all requested behavior works without regressions or errors.`,
      summary: "Formatted into a compact, scannable specification (offline template).",
      improvements: ["Concise Goal", "Bulleted Scope", "Clear Verification"],
    };
  }

  const reqBullets = requirements.map((r) => `- ${r}`).join("\n");
  const constraints = [
    "Preserve existing working behavior and public interfaces unless a change is explicitly required.",
    "Do not assume unobserved paths, APIs, or configurations—inspect or clarify before modifying.",
  ];
  if (refinement === "edge_cases" || mode === "bug_fix" || mode === "deep_spec") {
    constraints.push(
      "Handle empty/invalid inputs, failure states, and boundary conditions explicitly with clear error reporting."
    );
  }
  if (mode === "refactor") {
    constraints.push("Keep behavior 100% backwards-compatible while improving modularity and readability.");
  }

  const verify = [
    "Run existing automated tests, linters, or type checks covering the modified components.",
    "Confirm edge cases and error paths behave as expected with no regressions.",
  ];
  if (refinement === "add_tests" || mode === "bug_fix" || mode === "deep_spec") {
    verify.unshift("Add or update automated unit/integration tests covering both normal paths and failure/edge cases.");
  }

  const sections = [
    `## Goal\n${capFirst(goalLine)}`,
    `## Context & Scope\n${targetNote}` +
      (workspaceContext.trim() ? `\n\nActive context:\n${workspaceContext.trim()}` : ""),
    `## Requirements\n${reqBullets}`,
    `## Constraints & Edge Cases\n${constraints.map((c) => `- ${c}`).join("\n")}`,
    `## Verification\n${verify.map((v) => `- ${v}`).join("\n")}`,
  ];
  if (refinement === "detailed" || mode === "deep_spec") {
    sections.splice(
      3,
      0,
      "## Implementation Approach\n" +
        "- Trace current entrypoints and data flow before editing.\n" +
        "- Break changes into small, testable units with clear responsibilities.\n" +
        "- Summarize modified files and verification results upon completion."
    );
  }

  return {
    rewritten_prompt: sections.join("\n\n"),
    summary: "Expanded rough request into structured goal, scope, constraints, and verification (offline template).",
    improvements: ["Structured Goal", "Explicit Constraints", "Verification Checklist"],
  };
}

// P2-272 4B (canon line 65): Watchkeeper never runs Antigravity's `agy` (it uses the owner's Google login).
const AGY_NEVER_RUN_MESSAGE =
  "Watchkeeper does not run Antigravity's `agy` (it uses your Google login); the local template rewrote this prompt.";

// P2-272 S11: the old agy branch refuses with this canon line at its first line.
const NEVER_AGY = "Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.";

function agyRefusal() {
  return new Error(NEVER_AGY);
}

async function listAgyModels() {
  // Never runs `agy models`; the model list stays empty.
  return [];
}

// Pure parser for an `agy models` listing the owner pastes or exports; nothing here runs agy.
function parseAgyModelsOutput(stdout) {
  const res = { stdout: String(stdout || "") };
  const models = [];
  for (const rawLine of (res.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("fetching")) continue;
    if (line.includes("\t")) {
      const [id, label] = line.split("\t", 2);
      models.push({ id: id.trim(), label: label.trim() });
    } else {
      const parts = line.split(/\s+/);
      if (parts.length) {
        models.push({ id: parts[0], label: parts.slice(1).join(" ") || parts[0] });
      }
    }
  }
  return models;
}

function getProviderStatuses() {
  const agyBin = findAgyBinary();
  const claudeBin = findClaudeBinary();
  return [
    {
      id: "agy",
      label: "Antigravity CLI (agy)",
      available: Boolean(agyBin),
      detail: "Not run by Watchkeeper; the local template rewrites the prompt",
      requiresKey: false,
    },
    {
      id: "claude_cli",
      label: "Claude Code CLI (claude)",
      available: Boolean(claudeBin),
      detail: claudeBin || "claude CLI not found on PATH",
      requiresKey: false,
    },
    {
      id: "gemini_api",
      label: "Gemini REST API",
      available: true,
      detail: "Direct HTTPS API (requires Gemini API key)",
      requiresKey: true,
    },
    {
      id: "anthropic_api",
      label: "Anthropic Messages API",
      available: true,
      detail: "Direct HTTPS API (requires Anthropic API key)",
      requiresKey: true,
    },
    {
      id: "openai_compat",
      label: "OpenAI-Compatible / Ollama",
      available: true,
      detail: "Any /v1/chat/completions endpoint (OpenAI, OpenRouter, Ollama)",
      requiresKey: false,
    },
    {
      id: "offline_template",
      label: "Offline Structural Template",
      available: true,
      detail: "Instant local prompt structuring with zero API/CLI calls",
      requiresKey: false,
    },
  ];
}

async function rewriteWithProvider({
  settings,
  secrets = {},
  prompt,
  target,
  mode,
  workspaceContext = "",
  refinement = "",
  previousRewritten = "",
}) {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Please enter a prompt to rewrite.");

  const chosenTarget = TARGETS[target] ? target : TARGETS[settings.defaultTarget] ? settings.defaultTarget : "antigravity";
  const chosenMode = MODES[mode] ? mode : MODES[settings.defaultMode] ? settings.defaultMode : "balanced";
  const provider = String(settings.provider || "agy").trim();

  const started = Date.now();
  let parsed;
  let usedModel = "";

  let agyNote = "";
  if (provider === "offline_template" || provider === "agy") {
    // P2-272 4B: the "agy" provider never starts agy; the local template rewrites the prompt and says so.
    if (provider === "agy") agyNote = AGY_NEVER_RUN_MESSAGE;
    parsed = offlineRewrite({
      roughPrompt: cleanPrompt,
      target: chosenTarget,
      mode: chosenMode,
      workspaceContext,
      refinement,
      previousRewritten,
    });
    usedModel = "local-template";
  } else {
    const sysPrompt = buildSystemPrompt(chosenTarget, chosenMode);
    const usrPrompt = buildUserPrompt({
      roughPrompt: cleanPrompt,
      target: chosenTarget,
      mode: chosenMode,
      workspaceContext,
      refinement,
      previousRewritten,
    });

    let rawText = "";
    if (provider === "agy") {
      // Unreachable since P2-272 4B (the branch above takes "agy"); kept as a backstop that never runs agy.
      throw agyRefusal();
      // eslint-disable-next-line no-unreachable
      const agyBin = findAgyBinary();
      if (!agyBin) {
        throw new Error(
          "Antigravity CLI (`agy`) was not found. Install/sign in to Antigravity CLI or pick another provider in Settings."
        );
      }
      usedModel = settings.agyModel || "gemini-3.8-flash-low";
      const combined = `${sysPrompt}\n\n---\n\n${usrPrompt}`;
      const res = await runSubprocess(
        agyBin,
        ["--disable-slash-commands", "--model", usedModel, "--output-format", "text", `-p=${combined}`],
        45000
      );
      if (res.code !== 0) {
        throw new Error(`agy CLI failed: ${(res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 400)}`);
      }
      rawText = res.stdout;
    } else if (provider === "claude_cli") {
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        throw new Error(
          "Claude Code CLI (`claude`) was not found. Install Claude Code CLI or pick another provider in Settings."
        );
      }
      const combined = `${sysPrompt}\n\n---\n\n${usrPrompt}`;
      const args = ["-p", combined, "--output-format", "text"];
      if (settings.claudeModel) {
        args.push("--model", settings.claudeModel);
        usedModel = settings.claudeModel;
      } else {
        usedModel = "claude-default";
      }
      const res = await runSubprocess(claudeBin, args, 45000);
      if (res.code !== 0) {
        throw new Error(`claude CLI failed: ${(res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 400)}`);
      }
      rawText = res.stdout;
    } else if (provider === "gemini_api") {
      const key = secrets.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
      if (!key) throw new Error("Missing Gemini API key. Add it in Re-Prompt Settings.");
      const rawModel = String(settings.geminiModel || "gemini-4-hydrogen");
      usedModel = /^gemini-2\.5-pro/i.test(rawModel) ? "gemini-4-carbon" : (/^gemini-2\./i.test(rawModel) ? "gemini-4-hydrogen" : rawModel);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(usedModel)}:generateContent?key=${encodeURIComponent(key)}`;
      const data = await httpPostJson(
        url,
        { "Content-Type": "application/json" },
        {
          systemInstruction: { parts: [{ text: sysPrompt }] },
          contents: [{ role: "user", parts: [{ text: usrPrompt }] }],
          generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: "high" } },
        }
      );
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      rawText = parts.map((p) => p.text || "").join("");
    } else if (provider === "anthropic_api") {
      const key = secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
      if (!key) throw new Error("Missing Anthropic API key. Add it in Re-Prompt Settings.");
      usedModel = settings.anthropicModel || "claude-sonnet-4-20250514";
      const data = await httpPostJson(
        "https://api.anthropic.com/v1/messages",
        {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        {
          model: usedModel,
          max_tokens: 2048,
          temperature: 0.25,
          system: sysPrompt,
          messages: [{ role: "user", content: usrPrompt }],
        }
      );
      rawText = (data.content || [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text || "")
        .join("");
    } else if (provider === "openai_compat") {
      const base = (settings.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const key = secrets.openaiApiKey || process.env.OPENAI_API_KEY || "";
      if (!key && base.includes("api.openai.com")) {
        throw new Error("Missing OpenAI API key. Add it in Re-Prompt Settings or use a local Ollama URL.");
      }
      usedModel = settings.openaiModel || "gpt-4o-mini";
      const headers = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const data = await httpPostJson(`${base}/chat/completions`, headers, {
        model: usedModel,
        temperature: 0.25,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: usrPrompt },
        ],
      });
      rawText = (((data.choices || [])[0] || {}).message || {}).content || "";
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    parsed = parseRewriteResponse(rawText, cleanPrompt);
  }
  if (agyNote) parsed.summary = `${String(parsed.summary || "")} ${agyNote}`.trim();

  return {
    original: cleanPrompt,
    rewritten_prompt: parsed.rewritten_prompt,
    summary: parsed.summary,
    improvements: parsed.improvements,
    target: chosenTarget,
    mode: chosenMode,
    provider,
    model: usedModel,
    duration_ms: Date.now() - started,
  };
}

module.exports = {
  TARGETS,
  MODES,
  REFINEMENTS,
  DEFAULT_SETTINGS,
  isExecutableFile,
  findInPath,
  findAgyBinary,
  findClaudeBinary,
  AGY_NEVER_RUN_MESSAGE,
  NEVER_AGY,
  agyRefusal,
  parseAgyModelsOutput,
  runSubprocess,
  httpPostJson,
  buildSystemPrompt,
  buildUserPrompt,
  parseRewriteResponse,
  offlineRewrite,
  listAgyModels,
  getProviderStatuses,
  rewriteWithProvider,
};
