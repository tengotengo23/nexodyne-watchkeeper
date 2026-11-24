---
name: re-prompt
description: Open the Re-Prompt overlay composer or rewrite a rough user prompt into structured, AI-friendly and human-readable instructions for Antigravity or Claude Code with session-aware dynamic skill routing and Graphify workspace context.
---

# Re-Prompt

Use this skill when the user wants to open the **Re-Prompt** interactive prompt composer overlay or transform a rough prompt into a structured, unambiguous, dual-readable specification.

## Inline Controls & Skill Pinning

- Explicit prefixes: `rp:` (balanced), `rp-spec:` (deep spec), `rp-bug:` (bug fix), `rp-refactor:` (architecture refactor), `rp-concise:` (concise action plan).
- Automatic rule (owner, 24 Nov 2026): a plain prompt of **more than 30 words** is re-prompted without a prefix, in Antigravity and in Claude Code alike. 30 words or fewer stay exactly as typed. Chinese and Japanese characters count one word each. Slash commands, task reports and already-rewritten text are never re-prompted. Setting: `autoRewriteOverWords` (30; 0 turns the rule off).
- Raw bypass: prefix with `raw:` or `rp-raw:` (or `:raw `) to forward any prompt untouched, whatever its length. Rewriting every prompt (`hookAutoAll`) is opt-in and off by default.
- Explicit skill pinning inside any prompt: `+skill:<name>` or `@skill:<name>` force-loads a skill; `-skill:<name>` suppresses a skill.

## When to Use Which Tool

1. **Open the Interactive Composer Overlay (`open_reprompt`)**
   - Call the `re-prompt` MCP tool `open_reprompt` (with optional `draft`, `target`, `mode`) whenever the user invokes `/re-prompt` without text or wants to interactively inspect, refine, manage session skills, and send prompts.

2. **Direct Prompt Rewriting (`rewrite_prompt`)**
   - When the user passes rough text (e.g. `/re-prompt fix the auth timeout and add tests`), call `rewrite_prompt` with:
     - `prompt`: the user's rough request
     - `target`: `"antigravity"`, `"claude_code"`, or `"general"`
     - `mode`: `"balanced"`, `"deep_spec"`, `"bug_fix"`, `"refactor"`, or `"concise"`
     - `workspace_context`: optional short active-file/stack summary (Graphify context is detected automatically when `graphify-out/graph.json` exists)
     - `session_id` / `new_session` / `pinned_skills`: optional session and pin overrides
   - Present the structured specification clearly in a copyable markdown block, note key improvements and loaded/recommended skills, and ask whether to run it or tweak anything.
