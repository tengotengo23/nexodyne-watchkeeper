---
name: duo-orchestrator
description: Unified Gemini + Claude quota, rate-limit, and spend-aware orchestrator harmonized with Watchkeeper's weekly plan meter and kill switch.
---

# Duo Orchestrator (Gemini + Claude)

Use this skill when the user wants to inspect quota/pacing across Gemini and Claude or route tasks/subtasks across both providers while respecting Watchkeeper's weekly plan meter (`~/.wk/steward/meter.json`) and kill switch (`~/.wk/KILL`).

## Unified Tools & CLI

1. **Inspect Quota, Pacing & Integrations**
   - Call MCP tool `orchestrator_status` (or `watchkeeper_status` for full unified telemetry) or run:
     ```bash
     "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/orchestrate.py" --json status
     ```

2. **Route & Run a Task or Workflow (`orchestrate_task`)**
   - Call MCP tool `orchestrate_task` with:
     - `task`: what needs to be done
     - `context`: optional logs/code context (automatically compressed via Gemini when >= 3,000 est. tokens)
     - `workspace`: optional workspace path for Graphify AST context injection & skill routing
     - `role`: `"auto"`, `"execution"`, `"orchestrator"`, `"planning"`, `"scout"`, `"reviewer"`, or `"quarantine"`
     - `subtasks`: optional list of subtasks distributed across Gemini & Claude and aggregated via Gemini
     - `required_capabilities`: optional pins (`"claude_code_hooks"`, `"gemini_1m_context"`, etc.)
     - `override_provider`: optional `"gemini"` or `"claude"`
     - `pinned_skills`: optional list of `+skill`/`-skill` overrides
     - `dry_run`: `true` to preview route, Watchkeeper pace influence, and skill selection without executing
   - CLI equivalent for dry-run planning or direct execution:
     ```bash
     "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/orchestrate.py" --dry-run "<task>"
     ```
   - Always surface which provider and model handled the step, `reason_summary`, and any `[Skills: ...]` directives.
   - When Claude Code usage/rate limits run out (`~/.wk/steward/meter.json` exhausted or limit error), Watchkeeper (`wk-carbon-fallback.mjs`) queues the task for Antigravity in the `wk-task` file queue. Watchkeeper never runs `agy` or Gemini itself; the task waits until the owner runs `/wk-take-task` in Antigravity.
   - Asking Claude: one hard point that needs an answer now goes through the API (the ask-api skill). A whole review or a long job goes to Claude through the handoff (`wk-takeover.mjs publish --to claude`), where it runs on the user's Claude plan.
