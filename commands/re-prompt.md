---
description: Rewrite a rough prompt into structured, unambiguous, AI-executable instructions with dynamic skill loading and Graphify context awareness.
---

Use the `re-prompt` MCP tool `rewrite_prompt` with `target: "claude_code"` (or `provider: "auto"` in Watchkeeper Panel) to transform the rough request below into a clear, unambiguous specification.

User rough prompt (supports inline prefixes `rp:`, `rp-spec:`, `rp-bug:`, `rp-refactor:`, `rp-concise:`, `raw:`/`rp-raw:` bypass (plain prompts of more than 30 words are re-prompted automatically), and `+skill:<name>` / `@skill:<name>` / `-skill:<name>` overrides):
$ARGUMENTS

Return:
1. The rewritten prompt inside a clean markdown block so the user can inspect, approve, or edit it easily.
2. A short summary of improvements and loaded/recommended skills.
3. Ask whether to execute the rewritten prompt as-is or refine it further.
