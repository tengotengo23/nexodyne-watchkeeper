---
name: duo-orchestrator
description: Unified Gemini + Claude quota, rate-limit, and spend-aware orchestrator. Automatically routes tasks and orchestrator subtasks across Gemini and Claude to preserve Claude capacity, balance spend, and degrade gracefully on limits.
---

# Duo Orchestrator (Gemini + Claude)

Use this skill when the user wants to run, plan, inspect, or balance tasks automatically across **Gemini** and **Claude** plugins from this single plugin without manual provider switching.

## Unified Tools

1. **Check Setup, Quota & Spend Pacing (`orchestrator_status`)**
   - Call `re-prompt:orchestrator_status` with `{}` to inspect detected Gemini/Claude plugins and CLIs, remaining daily budgets, token limits, RPM usage, active cooldowns, and cumulative Claude savings.

2. **Route & Run a Task or Multi-Step Workflow (`orchestrate_task`)**
   - Call `re-prompt:orchestrate_task` with:
     - `task`: what needs to be done
     - `context`: optional large text/logs/code context (if >= 3,000 est. tokens, automatically compressed via Gemini)
     - `role`: `"auto"`, `"execution"`, `"orchestrator"`, or `"planning"`
     - `subtasks`: optional list of subtasks to distribute across Gemini & Claude and aggregate via Gemini
     - `required_capabilities`: optional capability pins (`"claude_code_hooks"`, `"gemini_1m_context"`, etc.)
     - `override_provider`: optional `"gemini"` or `"claude"`
     - `dry_run`: `true` to preview the routing decision and savings without executing
     - `session_id`: optional session identifier for persistent multi-turn skill tracking
     - `auto_skills`: `true` (default) to automatically judge and inject `## Skill Directives (Auto-Selected)` (`Load` / `Keep` / `Unload`) across the approved-source Gemini + Claude skill library
   - Always surface which provider/model handled the work, why (`reason_summary`), and any auto-selected skill directives (`[Skills: ...]`).

