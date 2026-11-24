---
description: Rewrite a rough prompt into structured, detailed, AI-friendly and human-readable instructions for Claude Code.
---

Use the `re-prompt` MCP tool `rewrite_prompt` with `target: "claude_code"` to transform the user's rough request below into a clear, unambiguous, dual-readable prompt.

User rough prompt:
$ARGUMENTS

Return:
1. The rewritten prompt inside a clean markdown block so the user can review or edit it easily.
2. The short summary of improvements.
3. Ask whether to execute the rewritten prompt right now or refine it further.
