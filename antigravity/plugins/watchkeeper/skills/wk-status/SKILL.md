---
name: wk-status
description: Inspect the unified Watchkeeper + Graphify + Re-Prompt + Skill Vault + Duo Orchestrator status dashboard, active modules, triggers, loaded skills, and pipeline stages.
---

Part of the /wk family (`/wk`, `/wk status`, `/wk graph`, `/wk sync`, `/wk stop`, `/wk go`, `/wk task`, `/wk take-task`). This is an alias.


# Watchkeeper Unified Status (`/wk-status`)

Run the read-only unified status tool whenever the user asks what this plugin can do, which modules are active, or wants a snapshot of Watchkeeper, Graphify, Re-Prompt, Skill Vault, and Duo Orchestrator state.

## Run Status Check

Prefer calling the `watchkeeper_status` MCP tool if available, or run:

```bash
"{{NODE}}" "{{WK_BIN_DIR}}/wk-status.mjs"
```

Pass `--json` for full machine-readable output:

```bash
"{{NODE}}" "{{WK_BIN_DIR}}/wk-status.mjs" --json
```

## Summarize Clearly

Report at a glance:
1. **Watchkeeper**: version, Stop switch (`~/.wk/KILL`), policy pin state, weekly plan meter utilization, pending task queue, and open suggestions.
2. **Graphify**: CLI install & workspace `graphify-out/graph.json` availability.
3. **Re-Prompt**: the 30-word rule (`autoRewriteOverWords`, default 30), the opt-in rewrite-everything switch (`hookAutoAll`, off by default), inline prefixes (`rp:`, `rp-spec:`, `rp-bug:`, `rp-refactor:`, `rp-concise:`), and raw bypass prefixes (`raw:`, `rp-raw:`).
4. **Skill Vault**: indexed skill count, daily trending GitHub sync status (`wk-skill-sync.mjs`), and explicit pin syntax (`+skill:<name>`, `@skill:<name>`, `-skill:<name>`).
5. **Duo Orchestrator**: Gemini/Claude readiness, the Gemini queue (`gemini=queued for Antigravity`: when Claude limits run out, tasks wait in the `wk-task` queue until the owner runs `/wk-take-task` in Antigravity), daily quotas/spend, and active pipeline stages.
