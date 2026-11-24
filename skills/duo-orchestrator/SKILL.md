---
name: duo-orchestrator
description: Unified Gemini + Claude quota, rate-limit, and spend-aware orchestrator harmonized with Watchkeeper's weekly plan meter and kill switch.
---

# Duo Orchestrator (Gemini + Claude)

Use this skill when the user wants to run, plan, inspect, or balance tasks automatically across **Gemini** and **Claude** while respecting Watchkeeper's weekly plan meter (`~/.wk/steward/meter.json`) and kill switch (`~/.wk/KILL`).

## Unified Tools & CLI

1. **Check Setup, Quota & Spend Pacing (`orchestrator_status`)**
   - Call MCP tool `orchestrator_status` (or `watchkeeper_status` for full unified Watchkeeper state) or run:
     ```bash
     python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/orchestrate.py" --json status
     ```

2. **Route & Run a Task or Workflow (`orchestrate_task`)**
   - Call MCP tool `orchestrate_task` with:
     - `task`: what needs to be done
     - `context`: optional logs/code context (auto-compressed via Gemini when >= 3,000 est. tokens)
     - `workspace`: optional workspace directory for Graphify AST subgraph injection & skill context
     - `role`: `"auto"`, `"execution"`, `"orchestrator"`, `"planning"`, `"scout"`, `"reviewer"`, or `"quarantine"`
     - `subtasks`: optional list of subtasks distributed across Gemini & Claude and aggregated via Gemini
     - `required_capabilities`: optional pins (`"claude_code_hooks"`, `"gemini_1m_context"`, etc.)
     - `override_provider`: optional `"gemini"` or `"claude"`
     - `pinned_skills`: optional list of `+skill`/`-skill` overrides
     - `dry_run`: `true` to preview route, Watchkeeper pace influence, and skill selection without executing
   - CLI dry-run / execution:
     ```bash
     python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/orchestrate.py" --dry-run "<task>"
     ```
   - Always surface which provider/model handled the work, `reason_summary`, and `[Skills: ...]`.
   - When Watchkeeper's weekly/5h Claude Code limits are exhausted (`meter.json` or Claude rate-limit errors), Watchkeeper (`wk-carbon-fallback.mjs`) queues the task for Antigravity in the `wk-task` file queue. Watchkeeper never runs `agy` or Gemini itself; the task waits until the owner runs `/wk-take-task` in Antigravity.
