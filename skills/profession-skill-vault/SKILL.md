---
name: profession-skill-vault
description: Search and load on demand from the local curated Profession Skill Vault (local Claude Code, Antigravity, and Watchkeeper skills plus optional GitHub skill repositories). Activate only when specialized guidance improves quality; never bulk-load skills.
---

# Profession Skill Vault

Query the local index (`~/.gemini/skill-vault/index.json`) and load **only** the 1-2 best matching `SKILL.md` files for the current task. Re-Prompt hooks, MCP tools, and `duo-orchestrator` emit `## Skill Directives (Auto-Selected)` with **Load**, **Keep Active**, and **Unload** decisions across turns—follow those directives immediately.

## Strict Pre-Flight & Token-Efficient Protocol

1. **Search first (cheap, ~150 tokens):**
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" search "<2-5 domain keywords>" --limit 5
   ```
   Optional filter: `--domain <domain>` (run `domains` to list valid domains).

2. **Load minimally & apply (1-2 skills max):**
   Read **only** the 1-2 highest-value matching `SKILL.md` files surfaced by search or pinned with `+skill:<name>` / `@skill:<name>`, and follow their workflow rigorously. Never bulk-read unrelated skills.

3. **Selective resources & safety:**
   Inspect bundled `references/`, `examples/`, or `scripts/` before opening files, and always read any third-party script before running it:
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" info <skill-id-or-name>
   ```

## Maintenance & Local Bootstrap Commands

- Bootstrap/refresh local skills offline (`~/.claude/skills`, `~/.gemini/config/skills`, Watchkeeper `skills/`):
  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" bootstrap-local
  ```
- Inspect domains or stats:
  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" stats
  ```
- Sync/update cloned GitHub skill repositories or run daily trending discovery (ranks top-starred/active `SKILL.md` repos with `--no-hooks` git hardening):
  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" discover-trending --sync --daily
  node "${CLAUDE_PLUGIN_ROOT}/bin/wk-skill-sync.mjs" status
  ```
- Inspect full cloned update:
  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" update
  ```
