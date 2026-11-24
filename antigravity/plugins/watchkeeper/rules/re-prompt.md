---
trigger: always_on
---

# Re-Prompt & Dynamic Skill Routing

This plugin normalizes rough prompts, selects specialist skills on demand, and integrates Graphify workspace context while honoring Watchkeeper guards and the `~/.wk/KILL` switch.

## Inline Prompt Prefixes & Raw Bypass

- Explicit prefixes force immediate prompt normalization before execution:
  - `rp:` (balanced specification), `rp-spec:` (deep spec), `rp-bug:` (root-cause & fix plan), `rp-refactor:` (architecture & clean diff), `rp-concise:` (tight actionable brief).
- Automatic rule (owner, 24 Nov 2026): a plain prompt of **more than 30 words** is re-prompted without a prefix, in Antigravity and in Claude Code alike. 30 words or fewer stay exactly as typed. Chinese and Japanese characters count one word each. Slash commands, task reports and already-rewritten text are never re-prompted. Setting: `autoRewriteOverWords` (30; 0 turns the rule off).
- Prefix with `raw:` or `rp-raw:` (or `:raw `) to pass any prompt through untouched, whatever its length (skipping rewrite injection and skill auto-routing for that turn).
- Rewriting every prompt (`hookAutoAll`) is an opt-in switch and is off by default.
- Explicit skill overrides can be written inline: `+skill:<name>` or `@skill:<name>` force-loads a matching skill, and `-skill:<name>` suppresses a skill.

## Dynamic Skill Vault Protocol (`## Skill Directives (Auto-Selected)`)

When a prompt or hook output contains `## Skill Directives (Auto-Selected)`:
1. **`Load` directives (max 1-2 skills):** Read only the named `SKILL.md` path(s) with `read_file` and apply their checklist/constraints carefully. Never bulk-read unrelated skills or browse entire skill repositories.
2. **`Keep Active` directives:** Continue following already-loaded relevant skills without re-reading them unless a specific reference file is needed.
3. **`Unload` directives:** Drop stale domain instructions that no longer apply to the current turn.
4. **Watchkeeper boundaries prevail:** Never override `~/.wk/KILL`, Watchkeeper path/secret/push restrictions, or `quarantine` no-tools restrictions.
