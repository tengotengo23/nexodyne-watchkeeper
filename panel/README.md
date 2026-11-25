# Watchkeeper

Unified full-IDE workspace and sidebar cockpit for Claude Code, Google Antigravity, Re-Prompt, Skills Library, and the Duo Orchestrator (Claude, or the Gemini lane by quota).

Watchkeeper sits in the side bar by default (click **W** on the Activity Bar). It does not open by itself; **`Cmd+Alt+W`** / **`Ctrl+Alt+W`** opens it, and the setting `watchkeeper.preferredLocation` can make it a full editor workspace instead. The panel has three parts:

- **The rail** (left): **+ New Session**, your Watchkeeper sessions, the Claude and IDE sessions of the last 24 hours, and an **Archived** group. Each session row has **✓ Done**, which archives it; an archived row has **Reopen** and **Delete for good** (asked again under the row before anything is removed). A session that is still running cannot be archived or deleted until it is stopped. The usage and pace card sits at the foot of the rail.
- **The canvas** (middle): the conversation and the composer only. The composer keeps the mode pill and **Send**; the route and the switches sit under **Overrides**, closed by default.
- **The drawer**: **Controls and settings** (the Stop switch, review, spend, phone, version, messages, graph) and the other tools as closed groups: the orchestrator, jobs, projects, sessions and workers, skills, Gemini tasks, advice, inbox and about. The drawer is closed on a fresh profile.

While the panel is open it reads again every 30 seconds; **Refresh** reads at once.

At the top, **/wk-take-task** takes the next queued task and lets Gemini work on it in the chat section; what happened shows under the header. It needs the plugin and a trusted folder, and it does nothing while the Stop switch is on.

## Private by design

- It reads files on your computer only: the session files in `~/.claude/projects` (of a long file only its start and its end), the locks folder if there is one, and one check whether the Watchkeeper plugin is installed. Without the plugin it reads nothing else.
- No telemetry, no account. The panel makes one network call, and only once a release key is pinned: at most once an hour it reads the signed update.json and news.json from https://nexodyne.org/watchkeeper/channel/ and sends nothing else. With the plugin, a job you start runs `claude -p` on your own Claude Code login.
- In a folder you have not trusted, it runs nothing: answering, deciding, adding a task, jobs and the phone controls are off, and the panel says why.
- What the panel itself writes and reads, and only with the plugin installed, in a trusted folder, and while the Stop switch is off: it moves finished or old Watchkeeper chat sessions into `~/.wk/chat-sessions/archive/` (✓ Done, the overflow above the session limit, and sessions quiet for a week); once an hour it moves `~/.wk/hook_sessions` files older than 7 days into `~/.wk/hook_sessions/archive/`. On the Mac panel it reads the account email once from `claude auth status --json` on your computer and keeps it in memory (10 minutes; **Refresh** reads again); it is shown only to you and sent nowhere. The plugin features below write more, and only with the plugin.

## With the Watchkeeper plugin

Watchkeeper is also a free plugin for Claude Code, from the same repository. In Claude Code:

```
/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper
```

On Claude Code before 2.1.275, use two lines:

```
/plugin marketplace add tengotengo23/nexodyne-watchkeeper
/plugin install watchkeeper@nexodyne
```

Claude Code does not update a third-party marketplace by itself unless you turn on auto-update for it in `/plugin`; by hand: `claude plugin marketplace update nexodyne`, then `claude plugin update watchkeeper@nexodyne`.

The panel finds the installed plugin by itself. With it, the panel also shows:

- **Waiting for you**: suggestions from Watchkeeper, Claude or Gemini, newest first, each with a recommended answer (and, if your own tooling keeps an `orchestration/QUESTIONS.md` with an `nx answer` script and you name that folder as `"orchestration"` in `~/.wk/remote.json`, its open questions). **OK** sends it, **Answer…** lets you write your own, **Later** hides one for 24 hours. A question about money, legal wording or an account needs a second press.
- **This week**: usage pace against your plan's weekly limit, read from the last headless run (empty until the steward or a job has run once), and the steward's wake-ups with their spend once you schedule it.
- **Jobs** and **Projects**: start, reply to and stop `claude -p` jobs in a project you listed, with the model and mode you choose. Never with a flag that skips Claude Code's permission checks.
- **Spend, last 7 days**: cost and calls per item and model from the ledger.
- **Gemini**: the tasks queued for Gemini in Antigravity, their status and the model each kind suggests, Gemini's last sessions, and a form to hand Gemini a task. Under it, **Show the automation prompt** (opt-in; Watchkeeper never switches an automation on) reads out the whole text the copy button gives, and **Commands for this computer** lists the stop, resume, inbox, take, done, watch, status and log commands filled in for this system, with a copy button. **Show the change** opens a finished task's diff before you decide; **OK** merges it.
- **Answered for you**: the last questions Gemini put to Claude, with their answers.
- A box for your notes, a **Wake-up switch** that stops all unattended work (it writes `~/.wk/KILL`), and **Updates**.

Without the plugin those parts stay hidden.

## Next release (after 2.1)

- **Done instead of delete**: **×** is gone from session rows. **✓ Done** archives a session; **Delete for good** is only on archived rows and asks again under the row. A running session is never archived or deleted ("Still running. Stop it first, or wait.").
- **Honest Gemini card**: it shows Watchkeeper's own count on this Mac, not Google's figure: a real 7-day count, the cooldown with its reason, and "Nothing counted yet." when there is nothing.
- **No "finished" clean-up**: the old `insp.finished` step is removed. A transcript you are viewing is never cleared.
- **Never runs `agy`**: Antigravity's agent is never run by Watchkeeper, in any context; work for Antigravity goes into the task queue (`wk-task add`).

## What's new in 2.1

- **Conversational Session Window & Clickable Left Sessions Sidebar**: Browse and resume persistent Watchkeeper sessions (`WKS-*` with turn counts, model badges, and Graphify token savings) alongside clickable Claude Code sessions (live transcript inspection plus one-click **Continue in Watchkeeper →**).
- **Automatic Target, Mode, Model & Skill Selection with Inline `Go →` Confirmation**: Every prompt automatically collects Graphify context, infers Target (`claude` vs `antigravity`) and Mode (`bugfix`/`refactor`/`spec`/`concise`/`balanced`), picks matching skills and route, and presents an editable normalized preview awaiting **Go →** (toggle **Confirm before Go** off to auto-run, or use `raw:` / `rp-raw:` to pass through untouched).
- **Mixed-Model Visible Thinking & Attribution**: Captures live thinking traces, tool chips, and active model names across Claude CLI, Antigravity CLI, Gemini 4, Anthropic API, Orchestrator steps, and Claude Code transcripts with color-coded `Graphify`, `Gemini`, `Claude`, and `Carbon` badges.
- **Default Graphify AST Token-Saving Layer**: Lightweight AST bootstrap and 2-hop ego-subgraph extraction now run by default across core hooks, prompt compilation, Orchestrator, the Claude-limit handover, and panel sessions (reporting token savings automatically; set `WK_GRAPHIFY_DEFAULT=0` to turn off).

## What's new in 2.0

- **Unified Hook Multiplexer Bus (`core/hook_bus.py`) & `/wk` Controls**: Consolidated `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, and `Stop` dispatcher with `flock`-guarded state (`core/state_store.py`), `/wk status|doctor|mode|brain|skills|graph`, and MCP tools `wk_command` & `wk_doctor`.
- **Gemini 4 Frontier Compiler (`gemini-4-carbon` `high` + `gemini-4-hydrogen` `xhigh`/`high`)**: Official `google-genai` SDK + Interactions API + REST/offline fallback with deterministic 4,096+ token `[STATIC BLOCK A]+[STATIC BLOCK B]` implicit prefix caching and `65536` max output tokens.
- **`<5ms` Loop-Immune Fast-Path & Isolated Clipboard**: Zero-recursion guards for `[WK-SPEC-V2:<hash>]` and nested subagents (`SubagentStart`/`SubagentStop`), plus clean standalone `/reprompt` nested-fence copy on `Stop` while leaving inline clipboards untouched.
- **Unrestricted Multi-Skill Composer & 2-Hop Graphify AST Bridge**: Composes all domain-matched skills plus `references/`/`templates/`/`scripts/`, queries `<50ms` 2-hop ego-subgraphs, and alerts on high-impact caller blast radius before edits.

## What's new in 0.8

- **Full-IDE Workspace (`Cmd+Alt+W`)**: `Cmd+Alt+W` opens Watchkeeper; set `watchkeeper.preferredLocation` to `editor-maximized` or `editor` to have it as a full editor workspace. Since the next release the default is the side bar, and it does not open by itself.
- **Sync skills**: Automatic 24-hour discovery and safe local indexing of top trending `SKILL.md` / `agent-skills` GitHub repositories (`bin/wk-skill-sync.mjs`) plus in-UI search and pinning.
- **Claude-limit handover** (changed in the next release): when Claude limits run out, the panel's Auto route can use the Gemini lane only with a Gemini API key added in Settings, otherwise it queues the task for Antigravity; `wk-job`, the steward and `wk-ask-claude` put the task in the queue for Antigravity (`wk-task`). Watchkeeper never runs Antigravity's agent (`agy`).

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `watchkeeper.preferredLocation` | `sidebar` | Where it opens: `sidebar`, `editor` tab, `editor-maximized` (fills the IDE) or `studio` |
| `watchkeeper.openOnStartup` | `false` | Open Watchkeeper when the IDE starts (only for the editor locations; the side bar never opens by itself) |
| `watchkeeper.autoTakeTasks` | `false` | Run queued tasks here with your Gemini API key. Off: the queue is for Antigravity |
| `watchkeeper.claudeDir` | `~/.claude` | Claude Code's folder (sessions are in `projects/`) |
| `watchkeeper.orchestrationDir` | empty | A folder that holds `locks/`. Empty: the `orchestration` folder of the open workspace, if it has one. Questions come only from the folder named in `~/.wk/remote.json` |
| `watchkeeper.pluginPath` | empty | The Watchkeeper plugin's folder. Empty means automatic: `~/Projects/watchkeeper` if it holds the plugin, else the newest `watchkeeper@*` plugin Claude Code installed |
| `watchkeeper.dataDir` | `~/.wk` | The plugin's data folder |

## Where it runs

Made for Antigravity and tested there on macOS. It should work in any editor built on VS Code 1.90 or later, such as VS Code, Cursor, Windsurf or VSCodium. Linux and Windows are untested.

Source, plugin and issues: https://github.com/tengotengo23/nexodyne-watchkeeper

Watchkeeper is an independent tool by Nexodyne. It is not made or endorsed by Anthropic or Google. Claude and Claude Code are trademarks of Anthropic, PBC. Gemini and Antigravity are trademarks of Google LLC. MIT License.
