---
description: Orchestrate a task or multi-step workflow across Gemini and Claude with quota, Watchkeeper weekly meter pacing, and dynamic skill routing.
---

Use the `re-prompt` MCP tool `orchestrate_task` (or `orchestrator_status` if asking about remaining quotas/setup) to handle the request below across Gemini and Claude while respecting Watchkeeper's weekly plan meter and `~/.wk/KILL`.

User request (supports `pinned_skills` and `dry_run: true`):
$ARGUMENTS

Always show:
1. Which provider & model handled each step (`gemini` or `claude`) and the routing reason (`reason_summary`).
2. Any auto-selected `[Skills: ...]` directives.
3. The task output clearly.
