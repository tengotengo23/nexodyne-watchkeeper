---
name: profession-skill-vault
description: >-
  Search and load on demand from a local curated vault of top-reviewed GitHub
  skills across professions: finance & accounting, legal & compliance, medicine
  & scientific research, marketing & SEO, product management, sales & support,
  HR & recruiting, UI/UX design & diagrams, education & teaching, writing &
  editing, office docs (Word/Excel/PDF/PowerPoint), data/SQL/AI, cybersecurity,
  and software/DevOps engineering. Activate only when specialized domain
  guidance improves the task; never bulk-load skills.
---

# Profession Skill Vault

Query the local index (`~/.gemini/skill-vault/index.json` across the approved Gemini + Claude + universal GitHub repositories) and load **only** the 1–2 best matching `SKILL.md` files for the current task. Note that Re-Prompt hooks, UI, MCP, and `duo-orchestrator` also emit `## Skill Directives (Auto-Selected)` with automatic **Load**, **Keep Active**, and **Unload** decisions across turns—follow those directives immediately.

## Strict Pre-Flight & Token-Efficient Protocol

0. **Assess needed skills before starting any larger task:**
   Briefly identify the 1–2 concrete skill categories that will produce the highest quality efficiently (e.g., architecture/planning, domain compliance/standards, UI polish, security audit, document generation). If a needed skill type is absent from the vault after searching, note the gap concisely instead of loading unrelated skills.

1. **Search first (cheap, ~150 tokens):**
   Run one targeted query per needed category (`--limit 5`) using `${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py` (or `~/.gemini/config/plugins/re-prompt/scripts/skill_vault.py`):
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" search "<2-5 domain keywords>" --limit 5
   ```
   Optional filter: `--domain <domain>` (run `domains` to list valid domains).

2. **Load minimally & apply (1–2 skills max):**
   Use `read_file` on **only** the 1–2 highest-value matching `SKILL.md` paths printed by search (or supplied by the Re-Prompt Skill Router), and follow their checklist/workflow throughout execution. Never bulk-read multiple skills or browse entire repo directories.

3. **Selective resources & safety:**
   Before opening files inside a skill's `references/`, `examples/`, or `scripts/` directories, inspect what exists:
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" info <skill-id-or-name>
   ```
   Read only the specific reference file needed, and **always read and inspect any third-party script before executing it**.

## Maintenance & Discovery Commands

- List domain counts: `python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" domains`
- Inspect vault stats: `python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" stats`
- Sync missing / update all cloned GitHub repositories & rebuild index:
  `python3 "${CLAUDE_PLUGIN_ROOT}/reprompt/scripts/skill_vault.py" update`

