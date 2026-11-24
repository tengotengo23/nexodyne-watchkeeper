"use strict";

// P2-272 (spec section 3.5): JS mirror of reprompt/scripts/prompt_prefix.py, the one prompt-prefix grammar.
// Both pass test/fixtures/prompt-prefix-vectors.json; change them together.
//   raw (pass untouched): `raw:` `rp-raw:` `/wk raw:` `:raw <body>`
//   rewrite: `rp:` `reprompt:` `re-prompt:` `rp-spec:` `rp-deep:` `rp-bug:` `rp-refactor:` `rp-concise:` `rp-short:`
//            `:rp <body>` `:reprompt <body>` `:re-prompt <body>`  (colon-first forms need white space after the word)
// Machine turns (a leading hyphenated tag) and loop text ("[Re-Prompt ·" and friends) are never rewritten.
// P2-273: a plain prompt of more than AUTO_OVER_WORDS (30) words is rewritten without a prefix (wantsAutoRewrite);
// a word is a white-space token holding a letter or digit, and each Chinese/Japanese character counts as one word.

const PREFIX_MODE_MAP = Object.freeze({
  rp: null,
  reprompt: null,
  "re-prompt": null,
  "rp-spec": "deep_spec",
  "rp-deep": "deep_spec",
  "rp-bug": "bug_fix",
  "rp-refactor": "refactor",
  "rp-concise": "concise",
  "rp-short": "concise",
});

const REWRITE_PREFIX_RE =
  /^\s*(?:(rp-spec|rp-deep|rp-bug|rp-refactor|rp-concise|rp-short|re-prompt|reprompt|rp)\s*:|:(re-prompt|reprompt|rp)(?=\s))\s*([\s\S]+)$/i;
const RAW_PREFIX_RE = /^\s*(?:(rp-raw|raw|\/wk\s+raw)\s*:|:(raw)(?=\s))\s*([\s\S]+)$/i;
const MACHINE_TAG_RE = /^\s*<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/i;
const TAKE_TASK_RE = /^\s*\/wk(?:-|\s+)take-task(?:\s+([A-Za-z0-9_-]{4,80}))?\s*$/i;

const SYSTEM_OVERRIDE_SENTINEL = "SYSTEM OVERRIDE: You are Re-Prompt";
const LOOP_MARKERS = Object.freeze(["[Re-Prompt ·", "[Re-Prompt Inline", "[WK-SPEC-V2:"]);
const AUTO_FLOOR_CHARS = 8;
const SHORT_REPLY_CHARS = 40;
const AUTO_OVER_WORDS = 30;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
// P2-273 review: one explicit white-space class, the same in reprompt/scripts/prompt_prefix.py (JS \s and Python's split differ).
const WS_CLASS = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
const WS_RE = new RegExp(WS_CLASS + "+");
const OVER_WORDS_RE = new RegExp("^" + WS_CLASS + "*([0-9]{1,9})(?:\\.[0-9]+)?" + WS_CLASS + "*$");
// Settings written before P2-273 held the old defaults (Claude Code "prefix", hookAutoAll true); version 2 moves them once.
const SETTINGS_VERSION = 2;

function normPrefix(word) {
  return String(word || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseRaw(text) {
  const m = RAW_PREFIX_RE.exec(String(text || "").trim());
  if (!m) return null;
  const body = String(m[3] || "").trim();
  return body || null;
}

function parseRewrite(text) {
  const m = REWRITE_PREFIX_RE.exec(String(text || ""));
  if (!m) return null;
  const body = String(m[3] || "").trim();
  if (!body) return null;
  const prefix = normPrefix(m[1] || m[2] || "rp");
  const mode = Object.prototype.hasOwnProperty.call(PREFIX_MODE_MAP, prefix) ? PREFIX_MODE_MAP[prefix] : null;
  return { prefix, body, mode };
}

function isMachineTurn(text) {
  return MACHINE_TAG_RE.test(String(text || ""));
}

function isLoopText(text) {
  const s = String(text || "");
  if (s.trimStart().startsWith(SYSTEM_OVERRIDE_SENTINEL)) return true;
  if (LOOP_MARKERS.some((marker) => s.includes(marker))) return true;
  return s.includes("## Goal") && s.includes("## Verification");
}

function matchTakeTask(text) {
  const m = TAKE_TASK_RE.exec(String(text || ""));
  if (!m) return null;
  return { taskId: m[1] || "" };
}

function wordCount(text) {
  let n = 0;
  for (const token of String(text || "").split(WS_RE)) {
    if (!token) continue;
    const cjk = token.match(CJK_CHAR_RE);
    if (cjk) {
      n += cjk.length;
      for (const part of token.replace(CJK_CHAR_RE, " ").split(WS_RE)) if (part && WORD_CHAR_RE.test(part)) n += 1;
    } else if (WORD_CHAR_RE.test(token)) {
      n += 1;
    }
  }
  return n;
}

function autoOverWords(value, fallback = AUTO_OVER_WORDS) {
  if (typeof value === "boolean" || value === null || value === undefined) return fallback;
  const m = OVER_WORDS_RE.exec(String(value));
  return m ? Number(m[1]) : fallback;
}

// A copy of a settings object moved to SETTINGS_VERSION (twin of prompt_prefix.py migrate_settings).
function migrateSettings(raw) {
  const out = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const ver = out.settingsVersion;
  if (!Number.isInteger(ver) || ver < SETTINGS_VERSION) {
    if (String(out.claudeCodeRewrite || "").trim().toLowerCase() === "prefix") out.claudeCodeRewrite = "words";
    if (out.hookAutoAll === true) out.hookAutoAll = false;
    out.settingsVersion = SETTINGS_VERSION;
  }
  return out;
}

function wantsAutoRewrite(text, overWords = AUTO_OVER_WORDS) {
  const limit = autoOverWords(overWords);
  if (limit <= 0) return false;
  const s = String(text || "").trim();
  if (!s || s.startsWith("/")) return false;
  if (classify(s).kind !== "none") return false;
  return wordCount(s) > limit;
}

function classify(text) {
  const s = String(text || "");
  const out = { kind: "none", prefix: null, body: s.trim(), mode: null, task_id: null };
  if (!s.trim()) return { ...out, kind: "empty", body: "" };
  const take = matchTakeTask(s);
  if (take) return { ...out, kind: "take_task", task_id: take.taskId || null };
  if (isMachineTurn(s)) return { ...out, kind: "machine" };
  if (isLoopText(s)) return { ...out, kind: "loop" };
  const m = RAW_PREFIX_RE.exec(s.trim());
  if (m && String(m[3] || "").trim()) {
    return { ...out, kind: "raw", prefix: normPrefix(m[1] || m[2]), body: m[3].trim() };
  }
  const rw = parseRewrite(s);
  if (rw) return { ...out, kind: "rewrite", prefix: rw.prefix, body: rw.body, mode: rw.mode };
  return out;
}

module.exports = {
  AUTO_FLOOR_CHARS,
  AUTO_OVER_WORDS,
  LOOP_MARKERS,
  SETTINGS_VERSION,
  WS_CLASS,
  MACHINE_TAG_RE,
  PREFIX_MODE_MAP,
  RAW_PREFIX_RE,
  REWRITE_PREFIX_RE,
  SHORT_REPLY_CHARS,
  SYSTEM_OVERRIDE_SENTINEL,
  TAKE_TASK_RE,
  autoOverWords,
  classify,
  isLoopText,
  isMachineTurn,
  matchTakeTask,
  migrateSettings,
  parseRaw,
  parseRewrite,
  wantsAutoRewrite,
  wordCount,
};
