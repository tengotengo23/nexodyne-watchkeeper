# Re-Prompt + Profession Skill Vault

A unified, token-efficient Antigravity & Claude Code plugin combining the **Re-Prompt** interactive prompt composer, a curated **Profession Skill Vault** (approved Gemini + Claude + universal GitHub repositories), an **automatic Load / Keep / Unload skill judge**, and a **quota & spend-aware Gemini + Claude orchestrator**.

## How Automatic Skill Judging (Load / Keep / Unload) Works

1. **Dual-Prompt Judgment:** Evaluates both the prompt you typed and the rewritten prompt (along with active session skills) across the approved-source Gemini + Claude skill library, weighted by GitHub stars, authority tier, and target-provider affinity (`gemini` / `claude`).
2. **Automatic Load & Unload Directives:** Injects `## Skill Directives (Auto-Selected)` directly into rewritten prompts, Antigravity `PreInvocation` hooks, Claude Code `UserPromptSubmit` hooks, and Duo Orchestrator prompts—explicitly instructing the agent which 1–2 `SKILL.md` files to **Load**, which active skills to **Keep**, and which off-topic skills to **Unload** when the task shifts domains.
3. **Zero Bloat:** Baseline context stays minimal while `~/.gemini/skill-vault/` stores every skill from approved sources on disk and reads only what the current prompt needs.

## Distributable Package & Installation

Build the self-contained `.zip` bundle (`dist/re-prompt-skill-suite.zip`):
```bash
./scripts/install_bundle.sh --package
```

Validate & install locally (also syncs `~/.gemini/skill-vault` if missing):
```bash
./scripts/install_bundle.sh
```

Update all 39 skill repositories and rebuild the index anytime:
```bash
python3 ~/.gemini/config/plugins/re-prompt/scripts/skill_vault.py update
```

## Overlay Window, Session Controls & In-Place `rp:` Chat Hooks

- **Detached Separate Floating Window (IDE `.vsix`):** Click **`✨ Re-Prompt`** in the bottom-right status bar (or press `Ctrl+Alt+R` / `Cmd+Alt+R`, or click **`⧉ Window`** in the composer header) to open Re-Prompt in its own separate floating OS window (`openInFloatingWindow` defaults to `true` in Settings).
- **Current Session vs. Start New Session:** Use **`Send to Current Session`** to inject your rewritten prompt into the active conversation, or **`Start New Session`** to launch a brand-new separate Antigravity session with it.
- **In-Place `rp:` Chat Prefix (Antigravity & Claude Code):** Type directly inside the regular Antigravity or Claude Code chat input box with a prefix:
  - `rp: <rough prompt>` (or `reprompt:`) — balanced mode
  - `rp-spec: <rough prompt>` (or `rp-deep:`) — deep specification mode
  - `rp-bug: <rough prompt>` — bug-fix root-cause mode
  - `rp-refactor: <rough prompt>` — refactor mode
  - `rp-concise: <rough prompt>` (or `rp-short:`) — concise mode
  - **Automatic above 30 words (default):** a plain message of more than 30 words is re-prompted without a prefix, in Antigravity and Claude Code alike; 30 words or fewer stay as typed. `raw: <prompt>` (or `:raw `) always passes a message untouched. Setting: `autoRewriteOverWords` (30; 0 = off). Claude Code: `claudeCodeRewrite` is `words` by default (`prefix` = only `rp:`, `never` = off).
  - *(Optional, off by default)* Enable **Auto re-prompt ALL chat messages in hook** in Settings (`hookAutoAll`) to rewrite every non-trivial chat message without needing `rp:`.

## Gemini + Claude Quota & Spend-Aware Orchestrator (Single-Install)

Installing this plugin alone unlocks unified task and workflow orchestration across **Gemini** and **Claude** without manual provider switching:

- **Auto Detection:** Discovers `agy` (Antigravity), `gemini` CLI, `claude` CLI, Claude Code IDE extension, and `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` automatically, showing actionable setup hints if either provider is unconfigured.
- **Smart Routing & Quota Pacing:**
  - High-token, lower-complexity work and orchestrator subtasks (context summarization, log triage, fan-out aggregation) automatically offload to **Gemini** to extend Claude capacity and match daily spend pacing.
  - Complex reasoning/architecture work routes to **Claude** (preserving capability guardrails like `claude_code_hooks` and `gemini_1m_context`).
  - Rate-limit errors trigger an automatic cooldown and transparent fallback to the healthy provider.
- **Entrypoints:**
  - **UI Tab:** Open Re-Prompt and switch to **`⚡ Gemini + Claude Router`** (or run `Re-Prompt: Gemini + Claude Orchestrator Status` in the IDE).
  - **MCP / Slash Tools:** Call `orchestrate_task` / `orchestrator_status` or `/duo-orchestrator` in Antigravity and `/orchestrate` in Claude Code.
  - **Unified CLI:** `python3 scripts/orchestrate.py status`, `plan "<task>"`, or `run "<task>"`.


