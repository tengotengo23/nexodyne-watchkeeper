---
description: Orchestrate a task or multi-step workflow across Gemini and Claude with quota, rate-limit, and spend-aware routing.
---

Use the `re-prompt` MCP tool `orchestrate_task` (or `orchestrator_status` if the user asks about remaining limits/setup) to handle the request below across Gemini and Claude seamlessly.

User request:
$ARGUMENTS

Always show:
1. Which provider & model handled the task (`gemini` or `claude`) and the routing reason (`reason_summary`).
2. The task output clearly.

