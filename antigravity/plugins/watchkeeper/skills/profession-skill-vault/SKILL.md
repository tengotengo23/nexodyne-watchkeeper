---
name: profession-skill-vault
description: Search and load on demand from the local curated Profession Skill Vault (local Antigravity, Claude Code, and Watchkeeper skills plus optional GitHub skill repositories). Activate only when specialist domain guidance improves quality; never bulk-load skills.
---

# Profession Skill Vault

Query the local index (`~/.gemini/skill-vault/index.json`) and load **only** the 1-2 best matching `SKILL.md` files needed for the active task. Re-Prompt hooks, MCP tools, and `duo-orchestrator` also emit `## Skill Directives (Auto-Selected)` with **Load**, **Keep Active**, and **Unload** directives—follow those directives directly.

## Strict Pre-Flight & Token-Efficient Protocol

1. **Search first (cheap, ~150 tokens):**
   Run one targeted query (`--limit 5`) or filter by `--domain`:
   ```bash
   "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" search "<2-5 domain keywords>" --limit 5
   ```

2. **Load minimally & apply (1-2 skills max):**
   Use `read_file` on **only** the 1-2 highest-value matching `SKILL.md` paths (or those pinned via `+skill:<name>` / `@skill:<name>`), and follow their checklist throughout execution. Never bulk-read unrelated skills.

3. **Selective resources & safety:**
   Inspect a skill's bundled `references/`, `examples/`, or `scripts/` before opening files, and always inspect any third-party script before executing it:
   ```bash
   "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" info <skill-id-or-name>
   ```

## Local Bootstrap & Sync Commands

- Bootstrap/refresh local installed skills (`~/.claude/skills`, `~/.gemini/config/skills`, Watchkeeper `skills/`, offline):
  ```bash
  "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" bootstrap-local
  ```
- Inspect domains or stats:
  ```bash
  "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" stats
  ```
- Discover and sync trending/top-starred GitHub skill libraries (24h auto-sync via `com.nexodyne.watchkeeper-skill-sync`, or run via MCP `app_vault_discover_trending`):
  ```bash
  "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" discover-trending --sync --daily
  "{{NODE}}" "{{WK_BIN_DIR}}/wk-skill-sync.mjs" status
  ```
- Optional full GitHub vault clone/update (curated + trending repos):
  ```bash
  "{{PYTHON}}" "{{WK_REPROMPT_DIR}}/scripts/skill_vault.py" update
  ```
