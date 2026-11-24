---
name: lean-tokens
description: Use when planning model choice, subagents, long test output, big reads or compaction. Rules that keep token cost low without lowering quality.
---
Cost is context size times call count. Measured on a real set-up (67 sessions): 88% of input tokens were read above 200k context; a subagent run read a median 2.2M tokens.
- One task per session; keep state in worklog files, not the chat; compact at about 100k.
- Route by stakes: plain code or script first; Haiku for search, listings, status; Sonnet for edits, builds, tests; Opus/Fable only for design, security, payments, hard bugs, customer-facing copy and the final review. Escalate on a failed verify; never re-run the same failing prompt on the same tier.
- Subagent windows are set per agent in frontmatter (autoCompactWindow, maxTurns, model, effort): this plugin ships `scout` (haiku, 100k, 15 turns), `builder` (sonnet, 150k, 30) and `reviewer` (opus, 200k, 20). Use them instead of general-purpose (908 of 908 past runs were general-purpose at a 2.2M median). CLAUDE_AUTOCOMPACT_PCT_OVERRIDE applies to subagents too.
- Subagents only for independent work, at most three, each counted at about 2.2M input tokens. Routine work is a single call with a strict output schema.
- Run tests through `${CLAUDE_PLUGIN_ROOT}/bin/wk-run <cmd>` (counts, failures, last 20 lines; full log on disk). Read files with `wc -l` first, then `grep -n` and a range.
- When `graphify-out/graph.json` exists, run `graphify query "<question>"` (or `path` / `explain` / `section`) before raw grep or source reads, and `graphify update .` after code edits (local AST, zero API tokens).
- Reuse proven open-source code before writing a script; log the search in one line.
- Rules files: core under 15KB, long sections in an on-demand file read only when pointed to. Start-up under 20k tokens.
