---
name: re-prompt
description: Open the Re-Prompt overlay composer or rewrite a rough user prompt into structured, AI-friendly and human-readable instructions for Claude Code or Antigravity with automatic session-aware skill routing and Graphify workspace context.
---

# Re-Prompt

Use this skill when the user wants to open the **Re-Prompt** interactive prompt composer overlay or transform a rough prompt into a structured, unambiguous specification.

## Inline Prefixes & Overrides

- Force normalization via prefix: `rp:` (balanced), `rp-spec:` (deep spec), `rp-bug:` (bug fix), `rp-refactor:` (refactor), `rp-concise:` (concise).
- Automatic rule (owner, 24 Nov 2026): a plain prompt of **more than 30 words** is re-prompted without a prefix, in Antigravity and in Claude Code alike. 30 words or fewer stay exactly as typed. Chinese and Japanese characters count one word each. Slash commands, task reports and already-rewritten text are never re-prompted. Setting: `autoRewriteOverWords` (30; 0 turns the rule off).
- Pass any prompt untouched, whatever its length: `raw:` or `rp-raw:` (or `:raw `). Rewriting every prompt (`hookAutoAll`) is opt-in and off by default.
- Pin or suppress skills inline: `+skill:<name>` or `@skill:<name>` to force-load; `-skill:<name>` to suppress.

## Automatic Session-Aware Skill Routing

- **Turn 1 (Session Start):** Detects domain/complexity + workspace `graphify-out/graph.json`, embeds top matching skills under `## Skills to Load`.
- **Turn 2+ (Complexity Growth):** Silent on routine follow-ups; surfaces up to 2 newly needed specialist skills when scope or complexity grows.

## MCP Tools

1. **Interactive Composer Overlay (`open_reprompt`)**: Call `open_reprompt` (with optional `draft`, `target`, `mode`).
2. **Direct Prompt Rewriting (`rewrite_prompt`)**: Call `rewrite_prompt` with `prompt`, `target` (`"claude_code"` default here, `"antigravity"`, or `"general"`), `mode`, optional `workspace_context`, `session_id`, `new_session`, and `pinned_skills`.
