---
name: re-prompt
description: Open the Re-Prompt overlay composer or rewrite a rough user prompt into structured, AI-friendly and human-readable instructions for Antigravity or Claude Code with automatic session-aware skill assumption (Turn 1) and complexity-growth recommendations (Turn 2+).
---

# Re-Prompt

Use this skill when the user wants to open the **Re-Prompt** interactive prompt composer overlay or transform a rough prompt into a structured, unambiguous, dual-readable prompt.

## Automatic Session-Aware Skill Routing

Re-Prompt is bundled with the **Profession Skill Vault** and automatically adapts across turns:
- **Turn 1 (Session Start):** Automatically analyzes the prompt, detects domain/complexity, and embeds the top 1–2 matching skills under `## Skills to Load` in the rewritten prompt so the agent starts with the right specialist workflows.
- **Turn 2+ (Complexity Growth):** Stays silent on routine follow-ups; when session complexity rises or a new specialist domain appears, surfaces up to 2 uncovered skills as optional recommendations to load.

## When to Use Which Tool

1. **Open the Interactive Composer Overlay (`open_reprompt`)**
   - Call `re-prompt:open_reprompt` (with optional `draft`, `target`, `mode`) whenever the user says "open re-prompt", invokes `/re-prompt` without text, or wants to interactively draft, tweak, compare, manage session skills, and send prompts.
   - Calling `open_reprompt` with `{}` opens the Re-Prompt MCP App panel in the side pane.

2. **Direct Prompt Rewriting (`rewrite_prompt`)**
   - When the user passes a rough prompt directly (e.g., `/re-prompt fix the auth bug and add tests`), call `re-prompt:rewrite_prompt` with:
     - `prompt`: the user's original rough text
     - `target`: `"antigravity"`, `"claude_code"`, or `"general"` (infer from user request or default `"antigravity"`)
     - `mode`: `"balanced"`, `"deep_spec"`, `"bug_fix"`, `"refactor"`, or `"concise"`
     - `workspace_context`: optional short string describing active file/stack if relevant
     - `session_id` / `new_session`: optional session routing controls
   - Present the rewritten prompt clearly in a copyable markdown block, plus the brief summary of improvements (and any Turn 2+ skill recommendations if complexity grew), and ask if they want to run it as-is or tweak anything.
