# Re-Prompt v1.3.0 — Setup & Usage Guide

**Re-Prompt + Duo Orchestrator** is a self-contained, zero-dependency toolkit for **Antigravity (CLI & IDE)**, **VS Code / Cursor**, and **Claude Code**. It combines:

- **Overlay Prompt Composer:** Interactive prompt rewriter with **Readable**, **Edit**, and **Compare** views, target switching (**Antigravity** / **Claude Code** / **General**), and modes (**Balanced**, **Deep Spec**, **Bug Fix**, **Refactor**, **Concise**).
- **In-Place `rp:` Chat Hooks:** Rewrite prompts inline inside Antigravity or Claude Code chat inputs using short prefixes (`rp:`, `rp-spec:`, `rp-bug:`, `rp-refactor:`, `rp-concise:`).
- **Profession Skill Vault & Auto Skill Judge:** Automatically scores prompts across the approved GitHub skill repositories (counts come from the index at run time: `node bin/wk-skill-sync.mjs status`) and emits `Load` / `Keep` / `Unload` directives with minimal context overhead.
- **Gemini + Claude Quota & Spend-Aware Orchestrator (`Duo Orchestrator`):** Routes high-token or fan-out subtasks to Gemini to preserve Claude capacity, enforces capability guardrails, and falls back automatically on rate limits.

---

## 1. Prerequisites & Supported Environments

- **Python:** **Python 3.10+** (uses only the Python standard library — no `pip install` or `npm install` needed).
- **Operating Systems:** Linux, macOS, and Windows.
- **Git (Optional):** Only required if you choose to sync/update the local approved-source Profession Skill Vault (`~/.gemini/skill-vault/`).
- **Supported Hosts (install any or all):**
  - **Antigravity CLI / Antigravity IDE (`agy`)**
  - **Claude Code (`claude` CLI)**
  - **Antigravity IDE / VS Code (`^1.85.0`) / Cursor** (via the `.vsix` extension)
  - **Standalone CLI / MCP Server**
- **AI Providers (Zero-Config or API Keys):**
  - Works out of the box with an authenticated local `agy` or `claude` CLI.
  - Alternatively, configure `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, a local Ollama endpoint, or use the built-in **Offline Template** mode with no external credentials.

---

## 2. Step-by-Step Installation

First, extract `re-prompt-v1.3.0.zip` and open a terminal inside the extracted folder:

```bash
unzip re-prompt-v1.3.0.zip
cd re-prompt-v1.3.0
```

### Option A — Cross-Platform Full Install (Linux / macOS / Windows)

Build the distribution artifacts (`.vsix`, Antigravity plugin `.zip`, Claude Code plugin `.zip`) and install them:

```bash
python3 scripts/build_dist.py
python3 scripts/install.py --all
```

You can also install individual targets instead of `--all`:

- Antigravity Plugin only (`~/.gemini/config/plugins/re-prompt`):
  ```bash
  python3 scripts/install.py --antigravity
  ```
- IDE Extension only (`.vsix` for Antigravity IDE, VS Code, or Cursor):
  ```bash
  python3 scripts/install.py --ide
  ```
  > If your IDE CLI is not detected on `PATH`, install manually in the IDE: **Extensions** -> **`...` menu** -> **Install from VSIX...** -> select `dist/re-prompt-1.3.0.vsix`.
- Claude Code Plugin only (`~/.claude/plugins/re-prompt`):
  ```bash
  python3 scripts/install.py --claude
  ```

### Option B — Quick Antigravity Plugin + Skill Vault Setup (Linux / macOS)

To validate and install the Antigravity plugin directly and optionally sync the Skill Vault:

```bash
./scripts/install_bundle.sh
```

This script:
1. Validates the plugin strictly via `agy plugin validate --strict` (if `agy` is installed).
2. Copies the plugin cleanly into `~/.gemini/config/plugins/re-prompt` with executable script permissions.
3. Syncs `~/.gemini/skill-vault/` if `index.json` is not yet present.

### Optional: Sync or Update the 39-Repo Profession Skill Vault

Requires `git` and internet access:

```bash
# Initial clone & index build
python3 scripts/skill_vault.py sync

# Pull latest updates & rebuild index anytime
python3 scripts/skill_vault.py update

# Check indexed domain counts & stats
python3 scripts/skill_vault.py stats
```

### Optional: Launch Claude Code with Re-Prompt

```bash
claude --plugin-dir "$HOME/.claude/plugins/re-prompt"
```

### Optional: Provider API Keys

If you are not relying on local `agy` / `claude` CLI auth, export one or more API keys in your shell profile (or save them inside the Re-Prompt **Settings** UI tab):

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
# Optional:
export OPENAI_API_KEY="your-openai-api-key"
```

---

## 3. Quick-Start Usage

### A. In-Place Chat Rewriting (`rp:` Prefix)

In Antigravity or Claude Code chat, start any message with a prefix to rewrite and enrich it automatically before execution:

| Prefix | Mode | Best For |
| --- | --- | --- |
| `rp: <prompt>` (or `reprompt:`) | **Balanced** | General coding & implementation tasks |
| `rp-spec: <prompt>` (or `rp-deep:`) | **Deep Spec** | Architecture, multi-file plans, acceptance criteria |
| `rp-bug: <prompt>` | **Bug Fix** | Root-cause analysis, reproduction, regression tests |
| `rp-refactor: <prompt>` | **Refactor** | Clean restructuring with invariants & verification |
| `rp-concise: <prompt>` (or `rp-short:`) | **Concise** | Tight, direct, low-token instructions |

**Automatic above 30 words (default, owner's rule of 24 Nov 2026):** a plain message of more than 30 words is re-prompted without a prefix, in Antigravity and Claude Code alike; 30 words or fewer stay exactly as typed; `raw: <prompt>` always passes a message untouched. Setting `autoRewriteOverWords` (30; 0 turns it off). In Claude Code, `claudeCodeRewrite` is `words` by default (`prefix` = only `rp:`, `always` = every message of 40+ characters, `never` = off).

*(Optional, off by default: **Auto re-prompt ALL chat messages in hook** (`hookAutoAll`) rewrites every non-trivial prompt without a prefix.)*

### B. IDE Overlay Composer (Antigravity IDE / VS Code)

- Click **`✨ Re-Prompt`** in the bottom-right status bar, or press:
  - **`Ctrl+Alt+R`** (Linux/Windows) / **`Cmd+Alt+R`** (macOS) — Open the Overlay Composer (defaults to a separate floating window; toggleable in Settings).
  - **`Ctrl+Alt+Shift+R`** (Linux/Windows) / **`Cmd+Alt+Shift+R`** (macOS) — Quick Floating Rewrite Overlay.
- Right-click any selected text in the editor -> **Re-Prompt: Rewrite Selected Text as Prompt**.
- Switch to the **`⚡ Gemini + Claude Router`** tab inside the UI to inspect live provider status, quotas, and routing decisions.

### C. Slash Commands & MCP Tools

- **Antigravity Skills / Commands:** `/re-prompt`, `/duo-orchestrator`, `/profession-skill-vault`
- **Claude Code Slash Commands:** `/re-prompt <rough prompt>`, `/orchestrate <task>`
- **MCP Tools (`re-prompt` server):** `open_reprompt`, `rewrite_prompt`, `orchestrate_task`, `orchestrator_status`

### D. Standalone CLI Quick Commands

```bash
# Check detected Gemini/Claude CLIs, API keys, budgets, and usage
python3 scripts/orchestrate.py status

# Preview routing and skill selection without executing (dry run)
python3 scripts/orchestrate.py plan "Summarize auth logs and list anomalies"

# Route and execute a task
python3 scripts/orchestrate.py run "Draft a database migration checklist"

# Search the local Profession Skill Vault
python3 scripts/skill_vault.py search "security audit" --limit 5
```

---

## 4. Verify Your Installation

Run the included test suite from the `re-prompt-v1.3.0` directory:

```bash
python3 -m unittest discover -s tests -v
```

*(Note: `LiveAgyTests` exercises the live `agy` CLI if present and authenticated; all offline routing, hook, MCP, CSP, and skill-vault tests run without external network calls.)*

---

## 5. Package Contents

- `plugin.json`, `mcp_config.json`, `hooks.json` — Antigravity plugin manifest, MCP server config, and `PreInvocation` hooks
- `skills/` — Built-in `re-prompt`, `duo-orchestrator`, and `profession-skill-vault` skills
- `rules/AGENTS.md` — Workspace rule enabling automatic `Load` / `Keep` / `Unload` skill directives
- `scripts/` — CLI orchestrator, hook handlers, skill router/vault manager, cross-platform installers, and `build_dist.py`
- `server/` — Prompt rewriting engine, Gemini + Claude orchestrator, and stdio MCP server
- `ui/` — Standalone HTML/JS interactive Re-Prompt composer & orchestrator dashboard
- `ide-extension/` — VS Code / Antigravity IDE extension source (packaged into `.vsix` by `scripts/build_dist.py`)
- `claude-code-plugin/` — Claude Code plugin wrapper (`.claude-plugin/plugin.json`, hooks, commands, MCP launcher)
- `tests/` — Automated test suites (`test_reprompt.py`, `test_orchestrator.py`, `test_skill_autosync.py`)
- `assets/`, `LICENSE`, `README.md`, `SETUP_AND_USAGE.md` — Icons, MIT license, and documentation
