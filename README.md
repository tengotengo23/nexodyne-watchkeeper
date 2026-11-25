# Watchkeeper · v3.8.0

**Watchkeeper is an open-source (MIT), local-first AI coding control plane and full-IDE workspace for Claude Code and Google Antigravity.** It unifies fail-closed tool & secret guards, test-verified completion gates (`done` evidence), an integrated **Re-Prompt** prompt-normalization studio, a **Running Tasks** cockpit, an auto-updating **Skills Library** that discovers trending GitHub agent skills daily, and a Claude-limit handover (the Gemini lane by quota, or the task queue for Antigravity) so work is not lost when Claude Code plan or rate limits run out. Everything stays in local files on your machine — zero Nexodyne servers, zero accounts, and zero telemetry.

> **TL;DR for AI Engineering Teams & Search Engines:** Watchkeeper answers the core reliability problem of multi-agent AI coding (*"How do I stop Claude Code and Gemini subagents from wasting tokens, forgetting skills, skipping tests, hitting weekly plan caps, or running unsafe commands?"*). One install provides deterministic hooks, progressive skill loading, a Claude-limit handover to the Gemini lane or the Antigravity task queue, and a side-bar panel that `Cmd+Alt+W` opens (or a full editor workspace) inside Antigravity and VS Code.

## Typical AI Coding Setup vs. Watchkeeper Unified Workspace

| Challenge | Typical AI Coding CLI / IDE | Watchkeeper Unified Control Plane |
|---|---|---|
| **Vague prompts burn tokens** | Raw ad-hoc instructions cause retries & bloated context | Embedded **Re-Prompt** studio + inline `rp:` / `rp-spec:` / `rp-bug:` prefixes structure goals with Graphify AST context |
| **Claude Code weekly or 5h limit hit** | Work stops cold mid-task with manual copy-pasting | The **Duo Orchestrator** can route the panel's runs to the Gemini lane (Gemini CLI or API key) by quota; jobs, steward visits and advice go into the task queue for Antigravity (`wk-task`). Watchkeeper never runs `agy` |
| **Static, stale skill prompts** | Manually hunting GitHub for updated workflow skills | **Skills Library** scans trending, highest-used & highest-rated GitHub agent skill repos every 24h (`--no-hooks` hardened) & composes **all domain-needed skills + helper resources** per turn with progressive disclosure |
| **Invisible background subagents** | Scattered terminal tabs & mystery token burn | **The panel** (side bar by default, `Cmd+Alt+W`): a sessions rail, a conversation canvas, and a drawer of controls and tools |
| **Unsafe edits & unverified "done"** | Unchecked shell commands or hallucinated test passes | Fail-closed `gates.json` guard, `~/.wk/KILL` switch, evidence gate blocking unverified `"done"`, and SHA-256 policy pin |

## Full-IDE Unified Workspace (`panel/`)

Watchkeeper sits in the side bar by default (`watchkeeper.preferredLocation: "sidebar"`). It does not open by itself; `Cmd+Alt+W` / `Ctrl+Alt+W` opens it, and the `editor` or `editor-maximized` setting makes it a full editor workspace. It has three parts:

1. **The rail** — **+ New Session**, Watchkeeper sessions, Claude and IDE sessions of the last 24 hours, and **Archived**. **✓ Done** archives a session; archived rows have **Reopen** and **Delete for good** (asked again first). A running session cannot be archived or deleted. The usage and pace card sits at its foot.
2. **The canvas** — the conversation and the composer (`rp:`, `rp-spec:`, `rp-bug:`, `rp-refactor:`, `rp-concise:`, or `raw:`), with Graphify context and `+skill:<name>` / `-skill:<name>` routing. The route and switches sit under **Overrides**, closed by default.
3. **The drawer** — **Controls and settings** (Stop switch `~/.wk/KILL`, review, spend, phone and bridge, version, messages, graph) and closed groups for the orchestrator, jobs, projects, sessions and workers, skills (**Sync skills**), Gemini tasks, advice, inbox and about.

## Two parts

| Part | Where it runs | What you get |
|---|---|---|
| **The Full-IDE Panel** (`panel/`) | Antigravity IDE, VS Code, Cursor, Windsurf, VSCodium | Side-bar panel by default (or a full editor workspace): sessions rail, conversation canvas, and a drawer of controls and tools. Works standalone for session visibility. |
| **The Plugin & CLI** (`hooks/`, `bin/`, `reprompt/`, `antigravity/`) | Claude Code & Antigravity IDE | PreToolUse/PostToolUse/Stop safety & evidence hooks, spend ledger, steward loop, Graphify AST indexer, daily GitHub trending skill sync, MCP server (`re-prompt`), and the Claude-limit handover (Gemini lane or the Antigravity task queue). |

## When Claude limits run out

When Claude Code hits a 5-hour or weekly cap, a rate limit (`429` / `usage limit`), or Watchkeeper's pace threshold (`meter.json` exhausted), Watchkeeper hands the work on. It never runs Antigravity's agent (`agy`) itself:

- **The panel's Duo Orchestrator** (Auto route) — can send a run to the Gemini lane, through the Gemini CLI or a Gemini API key, by quota; the Stop switch `~/.wk/KILL` still applies.
- **Headless Jobs** (`bin/wk-job.mjs`) — put the job in the task queue for Antigravity (`wk-task`).
- **Steward visits** (`bin/wk-steward.mjs`) — put the visit in the same queue.
- **Gemini Asks Claude** (`bin/wk-ask-claude.mjs`) — puts the question in the queue for Antigravity.

## Sync skills (daily GitHub skill sync)

Watchkeeper keeps your agent skills automatically fresh without bloating prompts:

- Runs a 24-hour macOS `launchd` scheduler (`com.nexodyne.watchkeeper-skill-sync`, managed via `node bin/wk-skill-sync.mjs install|run|status|uninstall`) or manual **Sync skills** from the Skills Library tab.
- Queries GitHub's public Search API (`topic:agent-skills`, `SKILL.md` ecosystem repositories ranked by stars & recent activity) and merges top libraries into `~/.gemini/skill-vault/sources.json` alongside curated libraries.
- Clones/updates with hardened git flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `submodule.recurse=false`), honors `~/.wk/KILL`, and uses **progressive disclosure** (`core/skill_router.py`): scans a SHA-256 cached 3-tier manifest and composes all domain-relevant `SKILL.md` guides, `references/`, `templates/`, and `scripts/` without artificial skill caps.

## Install

### The panel

Download `watchkeeper-panel-<version>.vsix` from this repository's [Releases](https://github.com/tengotengo23/nexodyne-watchkeeper/releases). In Antigravity, VS Code, Cursor, Windsurf or VSCodium, open **Extensions → … → Install from VSIX…** and pick the file. Then click the **W** on the Activity Bar.

### The plugin

In Claude Code:

```
/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper
```

On Claude Code before 2.1.275, use two lines:

```
/plugin marketplace add tengotengo23/nexodyne-watchkeeper
/plugin install watchkeeper@nexodyne
```

Claude Code puts the plugin under `~/.claude/plugins/`, and the panel finds it there by itself (the `watchkeeper.pluginPath` setting stays empty).

Updates: Claude Code does not update a third-party marketplace by itself unless you turn on auto-update for it in `/plugin` (**Marketplaces → nexodyne**). By hand:

```
claude plugin marketplace update nexodyne
claude plugin update watchkeeper@nexodyne
```

Copies installed from the public mirror update themselves too: each release's update.json is signed with the developer's key and names the exact public file tree (public_tree); a copy reads it from https://nexodyne.org/watchkeeper/channel/ when its clone has none, and moves only to a tag whose files match. The developer's publish step refuses to push a version to the public mirror before it is signed. The release key's fingerprint is `ae6a:87a7:3beb:9deb:6cc2:fd23:6554:fb7e:a0b5:62dd:24ce:6cd6:3956:8f20:277d:ab6c`; the first install prints the fingerprint of the key it pinned, so compare the two.

If you would rather read and change the code first, clone it and start Claude Code with the folder each time:

```
git clone https://github.com/tengotengo23/nexodyne-watchkeeper ~/Projects/watchkeeper
claude --plugin-dir ~/Projects/watchkeeper
```

The panel looks in `~/Projects/watchkeeper` too, so this route needs no setting either.

Below, `<plugin>` means the plugin's folder: `~/.claude/plugins/cache/nexodyne/watchkeeper/<version>` for a marketplace install, or your clone.

### The Antigravity plugin on its own

Each release from 3.2.0 also carries `watchkeeper-antigravity-<version>.zip`: the Antigravity plugin with its hooks and tools inside it, for people who use Antigravity without Claude Code. Unzip it, open `/plugin` in Antigravity (or the Plugins Manager), choose **+ Install from local directory...**, and pick the `watchkeeper` folder. It needs Node.js 20 or later, Python 3.9 or later and git. Its README lists what it reads, writes and sends.

### Gemini in Antigravity, Graphify, Re-Prompt & Skill Vault (optional)

```
node <plugin>/bin/wk-graphify.mjs install
```

This installs pinned Graphify (`graphifyy[mcp]==0.9.115`) via `uv`/`pipx`, copies the unified Watchkeeper Antigravity plugin (skills including `/graphify`, `/re-prompt`, `/duo-orchestrator`, `/profession-skill-vault`, `/wk-status`, three subagents, four always-on rules (bedrock: evidence before claims, open source first, Graphify and lean reads, skills on demand; Watchkeeper; graphify; re-prompt), MCP server, and Watchkeeper + Re-Prompt hooks) to `~/.gemini/config/plugins/watchkeeper`, registers `/graphify` globally for Claude Code, and locally bootstraps `~/.gemini/skill-vault/index.json` offline. To install only the Antigravity plugin, run `node <plugin>/bin/wk-antigravity.mjs install` (`--dry-run` shows what it would do; `node <plugin>/bin/wk-status.mjs` prints the full unified status). Run again after each plugin update.

## What the panel does

Click the **W** on the Activity Bar. For the last 24 hours you see:

- each Claude Code session: its title, project, model, the size of its transcript (an estimate, in tokens) and whether it is active (it wrote in the last 10 minutes);
- the workers (subagents) a session started: what each was asked to do, its model and effort, and whether it has finished;
- area locks, if your own tooling keeps them: one file per locked area in an `orchestration/locks/` folder, first line `pid|label|since`.

While the panel is open it reads again every 30 seconds; **Refresh** reads at once.

With the plugin installed the panel also shows:

- **Waiting for you**: suggestions from Watchkeeper, Claude or Gemini, newest first, each with a recommended answer and OK, Answer and Later buttons. If your own tooling keeps a question queue (an `orchestration/QUESTIONS.md` with an `nx` script that answers it), name that folder as `"orchestration"` in `~/.wk/remote.json` and its open questions show here too.
- **This week**: usage pace against your plan's weekly limit, read from the last headless run (empty until the steward or a job has run once).
- **Jobs** and **Projects**: start, reply to and stop `claude -p` jobs in a project you listed.
- **Spend, last 7 days**, **Gemini** (the task queue, the last Gemini sessions, a form to hand Gemini a task), **Answered for you** (questions Gemini asked Claude), **Recommendations and rules**, a **Wake-up switch** that stops all unattended work, and **Updates**.

### The 30-second checker (optional)

`node <plugin>/bin/wk-watch.mjs install` adds a small background job (a LaunchAgent on macOS, a systemd user timer on Linux) that looks every 30 seconds for work waiting for Gemini or Claude and shows one notification for each new item. It never starts an agent and uses no network. Every 5 minutes it also puts dead tasks back in the queue: a clean one at once, one with changes after a checked backup; after 3 automatic requeues the task waits for you. `uninstall` removes the job.

The agents take the work themselves: in Antigravity, by one click (`/wk-take-task`), the Gemini chain or an automation (see *Gemini Desk* below; the W panel's *Copy the automation prompt* button gives you the prompt and the setup); in Claude Code, `/loop 5m /wk-take-task`. With nothing queued, `/wk-take-task` stops after one short line.

### Bridge: handoffs between Gemini and Claude (optional)

Bridge carries work between Antigravity (Gemini) and Claude Code without starting either agent for you.

- **In Claude Code**, `/wk-bridge` waits in the background with no time limit (no model turns while idle) and wakes the tab when Gemini hands over work: one model turn per handoff. When a Claude session stops and a handoff waits, the Stop hook asks it to run `/wk-take-task --handoff --cwd "<repo>"`. A handoff is claimed first, so only one session takes it, and each session chains at most 3 an hour. Antigravity's Stop hook still prints `{}`.
- **Commands:** `wk-bridge status`, `wait`, `on`, `off`, `crossings` and `open`. `open --handoff <repo>` prints the line to start Claude in the repo, for you to run. `open --task` opens Antigravity on the repo and copies `/wk-take-task` for you to paste.
- **Hold:** `wk-task hold <id> [--hours N]` keeps a task where it is, queued or taken. The checker and the watchdog never requeue a held task. `wk-task release <id>` ends the hold.
- **Log:** each crossing (queued, taken, done, failed, requeued, written, consumed) is one line in `~/.wk/bridge/crossings.jsonl`. The checker's `watch.json` shows the counts, the held tasks and the last crossings. The panel reads them.
- **Reads and writes:** reads the tasks and `~/.wk/shared-workspace.json`; writes only under `~/.wk/bridge/` (claims, chain counts, the crossings log). It starts no agent and uses no network.
- **Off:** the kill switch or `wk-bridge off` stops all of it.
- **Phone control is now `wk-remote`.** `wk-bridge run` only points to `wk-remote run`; `wk-remote install` moves the old phone agent to `~/.wk/backups/` and installs the new one.

### Gemini Desk: Claude proposes, Gemini judges and does

Claude can hand Gemini a job in the queue with `wk-task add`. Gemini treats it as a proposal, not an order: it judges the job against the project's rules and code first, then does it its own way, on your Antigravity plan at no API cost. Gemini hands work to Claude through the handoff, and Bridge wakes the Claude tab.

- **The Desk rules** (`config/gemini.json` `desk_rules`; the `wk-take-task` skill carries the same text):

  > Gemini Desk rules (the owner's standing instruction). A proposal from Claude waits in the Watchkeeper queue. It is a proposal, not an order. 1. Take it with /wk-take-task and read it whole. 2. Judge it against this project's rules, its canon and its code: is it worth doing, right and safe? If not, finish it as out-of-scope with one line saying why, and stop. 3. If it is good, improve it where you can, then do the job your own way. 4. Verify with the project's tests. 5. Finish with done and a short report. One task at a time; in an automation run, after done, take the next task while the run's budget lasts (the take command says when to stop). Never run agy. Stop when nothing waits.

- **One click:** type `/wk-take-task` in Antigravity.
- **The chain (off by default):** when an Antigravity turn ends and a proposal waits, the Stop hook offers it to the same session with the Desk rules. Turn it on with `wk-bridge gemini-chain on`. This is your own decision: Google's consumer terms do not address a Stop hook that continues your own session with a task you queued on your own computer. It continues only after a normal end of turn, never after an error or the step limit, at most 3 times an hour per conversation and 12 tasks a day. Any failed check or error means Antigravity gets `{}` as before.
- **The automation:** an Antigravity automation (its scheduled runs; the menu names vary by version) with the prompt from the W panel's *Copy the automation prompt* button. The prompt first runs `wk-task inbox --brief` and stops when nothing waits; it carries the Desk rules and the run budget: a run takes tasks for about 60 minutes, at most 6, then stops. The schedule is a custom cron in your time zone: by default `CRON_TZ=<your time zone> */30 9-21 * * *` (every 30 minutes from 09:00 to 21:30); the quieter choice is `0 8-23 * * *` (once an hour from 08:00 to 23:00). Pick the strongest model your plan offers. Its honest limits: an unattended run denies any command its test run did not grant, so it suits known, repeatable jobs (do the test run with a sample task queued); each run starts a new conversation and uses quota even when nothing waits. The automation is your choice: Watchkeeper never creates, installs or turns it on, and the 12-a-day cap, the Stop switch and your merge in the panel still hold.
- **Key or queue:** `ask_gemini` and `/wk-ask` are for small, quick questions that cannot wait, paid from your own key. Big or long work goes in the queue.
- **Stop:** the kill switch or `wk-bridge off` stops the chain; the kill switch also makes `wk-task inbox --brief` print 0 waiting, so the automation stops too.
- **Claude Code's MCP tools:** `wk-handoff install --apply` also registers the Re-Prompt MCP server for Claude Code (`claude mcp add --scope user`), after a backup of `~/.claude.json`; it skips this when it is already registered, when the Watchkeeper plugin for Claude Code is enabled (the plugin brings the same server) or when `claude` is not installed. `uninstall --apply` removes it only when `wk-handoff` added it.
- **What leaves the computer:** nothing new. The chain and the inbox read and write files under `~/.wk/` only.

### API drive (optional)

Claude Code can hand one task to Gemini, and Antigravity's Gemini can hand one task to Claude, through the official APIs and your own keys. It is off until you save a key.

- **The two boxes:** the W panel's *API keys* card (on the Mac only) has a box for a paid Gemini API key and one for a Claude API key, with Save, Check and Remove. The box is cleared as soon as you press Save; the panel shows only the last four characters, the last check and today's spend. In a terminal: `wk-keys set gemini` reads the key from stdin (never as an argument); `wk-keys status`, `check` and `remove`.
- **The keys** live in `~/.config/watchkeeper/keys/` (folder 0700, files 0600). Both guards deny the known ways for the AI to reach this folder (reads, searches, links and shell commands, in any spelling or letter case), and no command prints a key.
- **Use:** `/wk-ask gemini <task>` in Claude Code, the `ask-api` skill in Antigravity, or the MCP tools `ask_gemini` and `ask_claude` (they run in the open project; where the IDE names none, pass `project`, the project's git root). One call, one answer; the calling agent reviews and applies it.
- **Caps:** US$2.00 a day for each provider and 30 calls an hour by default; change them in `~/.wk/api-drive.json` (`"enabled": false` switches the drive off); the AI cannot change that file or the usage log. Each answer shows its tokens and about what it cost.
- **Stop switch:** while `~/.wk/KILL` exists, no call is made.
- **What is sent to whom:** the task and the files you name (only inside the current git root) go to Google or Anthropic, with your key in a header. Nothing goes to Nexodyne. The usage log `~/.wk/api-drive/usage.jsonl` keeps tokens and cost, never the prompt, the answer or a key.
- **The honest limit.** The guards block the known ways for the AI to read the keys (file reads, searches, links and shell commands, in any spelling or letter case) and to change or delete the caps file `~/.wk/api-drive.json` and the usage log in `~/.wk/api-drive/`, and the AI never receives a key. But an AI that can run commands as your user could still find another way to reach a file your user can read or write. The stop switch, the caps and the guards make that hard and visible; they are not a sandbox.
- **The terms, in plain words.** Use your own keys only, each billed to you. Never use a Claude Pro or Max login, or your Google login, for scripted calls: only API keys. You must be 18 or over and in a country where each API is offered. Use a paid Gemini key: with a free one, Google uses what you send and what it answers to improve its products, and people at Google may read it; in the European Economic Area, Switzerland and the United Kingdom only a paid key is allowed. Do not use the drive to skip a step where a person must confirm something. Do not use the answers to train or distil a model that competes with Gemini or Claude.

## What the plugin does

Four hooks run in every Claude Code session (`hooks/hooks.json`):

- **Start**: if the project keeps these files, a short orientation of at most 6 KB: the "## Now" part of `worklog/STATE.md`, the head of `worklog/PHASE.md`, the last five dated lines of `worklog/REMARKS.md` and the top of a notes file (the files are listed in `bin/wk-start.mjs`). Other projects get nothing.
- **Before every tool call** (`bin/wk-guard.mjs`): refuses writes to the policy file and to paths the policy excludes, hard resets and force pushes, content that looks like a secret, and the gated classes: sending mail, publishing packages or releases, Stripe calls that create, change or refund anything, purchases. A standing approval in the policy can open one gated class for a narrow pattern until a date. Every refusal is logged to `.wk/blocked.log` in the project.
- **After every shell command**: a test run (a command the policy lists as a test) is recorded in `.wk/evidence/<session>.jsonl`.
- **On stop** (`bin/wk-evidence.mjs gate`): a message that claims done, tested or live is sent back when the session has no fresh test line (90 minutes) or its last test failed. Honest wording ("not tested", "skipped") passes. One nudge per turn; after that the stop goes through and `.wk/defects.log` counts it.

The policy is one file, `<plugin>/config/gates.json`. A broken or incomplete policy refuses every tool (it fails closed). A project may add to the deny and test lists in its own `.wk/gates.json`; it cannot loosen anything. `node <plugin>/bin/wk-pin.mjs` writes a hash of the policy to `~/.wk/policy.sha256`; after that, a changed policy turns every writing, shell, web and MCP tool off until you pin again. A plugin update that changes the shipped policy counts as a change: read it, then pin again. Without a pin the hooks still run, and the start hook prints one "policy not pinned" line.

The shipped policy has no standing approvals, so every gated class stays closed. To open one (for example creating Stripe prices through a connector), add a standing approval with a narrow pattern and an end date to `config/gates.json`; the `_end` line in its `standing_approvals` list says what each one needs. Where that edit lives matters:

- A project's `.wk/gates.json` cannot add approvals: the plugin ignores `standing_approvals` there.
- In a marketplace install, an edit to the policy in `~/.claude/plugins/cache/` is lost at the next plugin update.
- In a clone, your edit stays: the updater never overwrites local changes or your own commits. It leaves the folder as it is and says why, and you merge new releases yourself with git.

So no place outside a clone keeps an approval across updates.

Also in the plugin:

- **Kill switch**: `touch ~/.wk/KILL` denies every tool except reads in every session; `rm ~/.wk/KILL` resumes. The panel's wake-up switch writes the same file.
- **Quarantine**: an agent with no tools that reads untrusted text (web pages, comments, mails) and returns data. The guard refuses every tool call from that agent type.
- **Spend ledger** (`bin/wk-ledger.mjs`): cost rows for the headless `claude -p` runs Watchkeeper starts, in `~/.wk/ledger.jsonl` (your interactive sessions are not counted); `/watchkeeper:spend` prints cost and calls per item and model; `/watchkeeper:optimise` shows a token-saving settings baseline and applies it only with your yes.
- **Steward** (`bin/wk-steward.mjs`, off until you set it up): `node <plugin>/bin/wk-steward.mjs init` writes `~/.wk/steward.json`, `node <plugin>/bin/wk-projects.mjs scan` lists your projects, and then a scheduler you create (cron or launchd) runs `node <plugin>/bin/wk-steward.mjs tick`. Each visit is one small headless call that asks for ideas on one project and files them for your answer. It paces itself on your plan's weekly limit (holds at 80 % used until the last day of the week) and builds, sends or buys nothing.
- **Subagents** `scout`, `builder`, `reviewer` and `quarantine`, each with a fixed model, effort, turn cap and context window; skills `lean-tokens`, `evidence`, `graphify`, `re-prompt`, `duo-orchestrator`, `profession-skill-vault`, and `wk-status` (`bin/wk-start.mjs` also checks for `graphify-out/graph.json` at startup).
- **Re-Prompt, Dynamic Skill Vault & Duo Orchestrator (`reprompt/`, `.mcp.json`)**: normalizes rough prompts inline via `rp:`, `rp-spec:`, `rp-bug:`, `rp-refactor:`, `rp-concise:` (or bypasses auto-rewrite with `raw:`/`rp-raw:`), enriches rewrites with workspace `graphify-out/graph.json` context when present, dynamically selects 1–2 relevant skills (`+skill:<name>` / `@skill:<name>` / `-skill:<name>` supported), and routes Gemini <-> Claude subtasks while honoring Watchkeeper's weekly plan meter (`~/.wk/steward/meter.json`) and `~/.wk/KILL` switch. Use `/watchkeeper:status` or `node <plugin>/bin/wk-status.mjs` to inspect all modules and pipeline stages at a glance.
- **Gemini in Antigravity** (`bin/wk-task.mjs`, `bin/wk-suggest.mjs`): a task queue under `~/.wk/`. Gemini takes a task when you type `/wk-take-task` in Antigravity (or an automation you create there does), works in its own git worktree, and `done` checks the changed files against the task's allowed paths and runs the task's test. You merge with one press in the panel, and the merge checks everything again from git. At most 12 tasks a day. Watchkeeper never runs Antigravity for you and never calls Google's service: it only reads and writes files under `~/.wk/`.
- **Gemini asks Claude** (`bin/wk-ask-claude.mjs`): the `ask-claude` skill lets Gemini put a decision to Claude Code, which answers as you would from the project's rules, memory and decision files, in your own voice from `~/.wk/voice.md` when that file exists. Read-only tools only; 8 questions a day; 30 minutes each. Set `WK_ASK_CWD`, or `main_project` in `~/.wk/ask.json`, to the project folder Claude should read; without either, it reads the `--project` folder or the folder it was started in, and says which in its answer. Each answer uses your plan's strongest model at maximum effort, so it is costly: change the limit with `WK_ASK_DAILY_MAX` and the model with `WK_ASK_MODEL`.

## The /wk command family (`bin/wk.mjs`)

One set of words in the terminal, Claude Code and Antigravity.

| Command | What it does |
|---|---|
| `/wk` | overview, one screen, read-only |
| `/wk status` | runtime status |
| `/wk graph` | refresh the code graph |
| `/wk sync` | one skill index sync (approved sources only) and a graph refresh; refuses while the Stop switch is on |
| `/wk stop [reason]` | turn the Stop switch on (writes `~/.wk/KILL`) |
| `/wk go` | turn the Stop switch off |
| `/wk task "..."` | queue a task as a file; starts nothing |
| `/wk take-task` | take the next queued task or the latest handoff |

Aliases that still work: `/wk-status`, `/wk-take-task`, `/wk-add-task`, `/wk-suggest`, and the subcommands `overview`, `heal`, `tasks`, `handoff`, `watchdog`, `learn`, `mode`, `brain`, `skills`, `doctor`, `help`.

## What it reads, writes and sends

**Reads.** The panel reads `~/.claude/projects` (of a long file only its start and end), the workspace's `orchestration/locks/` folder if there is one, and with the plugin `~/.wk/` and the plugin's own config. The plugin's hooks read the policy, the project's `worklog/` and `.wk/` files, and the tool call Claude Code hands them.

**Writes.** The plugin writes `~/.wk/` (ledger, pin, kill file, notes, steward state, tasks, worktrees, advice). Watchkeeper edits none of your files. It adds one folder, `.wk/`, to each project it runs in, for its logs (blocked, approved and evidence), with a `.wk/.gitignore` containing `*` so git leaves it out. The worktrees for Gemini live under `~/.wk/worktrees/`. The 30-second checker, if you install it, reads `~/.wk/tasks/` and `~/.wk/shared-workspace.json`, writes `~/.wk/watch.json` and adds `~/Library/LaunchAgents/com.tengo.watchkeeper-watch.plist` (macOS) or `~/.config/systemd/user/watchkeeper-watch.{service,timer}` (Linux).

**Runs.** The panel writes the kill file and a note line. On each refresh it runs the plugin's `bin/wk-ledger.mjs pace` and read-only git commands (branch, last commit, status) in the projects listed in `~/.wk/projects.json`. Those git commands never contact a remote, and they switch off the repository settings that would run a command of its own (fsmonitor, filters, signature checks, hooks); status does not look inside submodules; if git cannot list a project's filters, the panel skips that project's status. On your press it runs only the plugin's own scripts from the plugin's folder (answer a suggestion, add a task, start, reply to or stop a job, set up Gemini's ask skill, the phone controls) and, for a question, the `nx` script in the orchestration folder named in `~/.wk/remote.json`. It never runs a file from a workspace folder. In a folder you have not trusted, it runs nothing at all and says so.

**Sends.** Nothing goes to Nexodyne. There is no telemetry and no account. The panel makes one network call, and only once a release key is pinned (`~/.wk/release-key.pub.pem`): at most once an hour it reads the signed `update.json` and `news.json` from https://nexodyne.org/watchkeeper/channel/ and sends nothing else; it shows only items whose signature checks. The plugin's network use, each off until you set it up:

- `claude -p` runs (the steward, jobs, ask-claude) use your own Claude Code login and count against your own plan;
- the business snapshot (`bin/wk-snapshot.mjs`) reads totals from your own Stripe account, only when you set `STRIPE_RESTRICTED_KEY` in the environment, and keeps no customer data;
- the clone route's updater (`bin/wk-update.mjs install`, macOS) fetches this repository's release tags (a copy from the public mirror also reads the signed `update.json` named above);
- the phone link (`bin/wk-remote.mjs`) is off by default and needs a companion server that is not published yet (docs/REMOTE.md); with one, the phone page shows the same status line as the panel; `wk-remote config` sets a server of your own, and until then every remote command refuses.
- Continue prompts (`bin/wk-handoff.mjs`): when a session's context or the plan's usage runs high, W asks the session to write a continue file (`~/.wk/handoff/`), tells you to `/clear`, and the next session in that folder loads the file. It never types `/clear` for you. `node bin/wk-handoff.mjs install` shows what it would add to `~/.claude/settings.json` (dry run; `--apply` after a backup).

### Sync skills (`bin/wk-skill-sync.mjs`)

```bash
node <plugin>/bin/wk-skill-sync.mjs install   # install 24h macOS launchd job
node <plugin>/bin/wk-skill-sync.mjs run       # run trending GitHub discovery + local re-index now
node <plugin>/bin/wk-skill-sync.mjs status    # inspect last sync timestamp & indexed skill count
```

### Claude Code Limit Failover (`bin/wk-carbon-fallback.mjs`)

When Watchkeeper detects that Claude's plan or rate limit has run out, it puts the job, steward visit or question in the task queue for Antigravity (`wk-task`). It never runs `agy`. Set `WK_CARBON_FALLBACK=0` to turn the handover off.

## Unified Runtime v2.0 (Gemini 4 Frontier + Hook Multiplexer Bus)

Watchkeeper v2.0 consolidates all Watchkeeper guardrails, **Graphify** structural mapping, **Re-Prompt**, and local Skill Libraries behind one deterministic runtime under `core/`:

- **Unified Hook Multiplexer Bus (`core/hook_bus.py` + `hooks/hooks.json`)**: Dispatches `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`*`), `PostToolUse`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, and `Stop` in topological order while keeping `wk-guard.mjs` fail-closed checks first.
- **Gemini 4 Frontier Compiler (`core/gemini_engine.py`)**: Runs `gemini-4-carbon` (`high`) and `gemini-4-hydrogen` (`xhigh`/`high`, `max_output_tokens: 65536`) via the official `google-genai` SDK (`models.generate_content` + `interactions.create`), stdlib v1beta REST fallback, or offline synthesis. Deterministic 4,096+ token `[STATIC BLOCK A]+[STATIC BLOCK B]` prefixes maximize implicit cache reuse while isolating fresh turn state in `[DYNAMIC BLOCK C]`.
- **Loop-Immune `<5ms` Fast-Path (`core/fast_path.py`) & Isolated Clipboard (`core/clipboard_io.py`)**: Skips `[WK-SPEC-V2:<hash>]` prompts, active subagents (`WK_SUBAGENT_ACTIVE=1` and `SubagentStart`/`SubagentStop` recursion depth via `flock`-guarded `core/state_store.py`), `raw:`/`rp-raw:`, confirmations, and read-only commands. Inline turns never touch the system clipboard; standalone `/reprompt` copies nested (4-backtick) specs on `Stop`.
- **Unrestricted Multi-Skill Composer & 2-Hop Graphify AST Bridge (`core/skill_router.py`, `core/graph_bridge.py`)**: Resolves `project_local > watchkeeper_core > user_global` precedence across local, Watchkeeper, and Skill Vault catalogs, loads every matching skill plus sibling `references/` and `scripts/` paths, queries `<50ms` 2-hop Graphify AST ego-subgraphs with `PreToolUse` high-impact caller blast-radius warnings, and syncs dirty files incrementally on `Stop`.
- **Unified `/wk` CLI & MCP Tools (`bin/wk.mjs`, `core/wk_cli.py`)**: Run `/wk status`, `/wk doctor`, `/wk mode <auto|confirm|reprompt-only|passthrough|raw>`, `/wk brain <adaptive-max|carbon-high|hydrogen-xhigh>`, `/wk skills <list|reload|match>`, and `/wk graph <sync|inspect|open>` via CLI, slash command `/wk`, or MCP tools `wk_command` & `wk_doctor`.
- **Conversational Session GUI, Auto `Go →` Review, Mixed-Model Thinking & Default Graphify Layer (`2.1`)**: The full-IDE **Re-Prompt** tab runs as a persistent conversational session thread paired with clickable Watchkeeper (`WKS-*`) and Claude Code sessions in the left sidebar. Every prompt runs Graphify 2-hop AST context as a default token-saving baseline (`WK_GRAPHIFY_DEFAULT=0` to disable), auto-infers Target (`claude`/`antigravity`), Mode, Model, and Skills, shows an editable inline **Go →** confirmation card (optional auto-run when unchecked), and streams expandable mixed-model thinking traces with `Graphify`, `Gemini`, `Claude`, and `Carbon` attribution badges.

## Frequently Asked Questions (FAQ)

### What is the most efficient way to interact with Claude Code and Gemini together?
Combine structured prompt normalization (**Re-Prompt** `rp:` prefixes and `[WK-SPEC-V2]` Gemini 4 prefix caching), **unrestricted progressive multi-skill composition** (loading every domain-relevant `SKILL.md` + `references/`/`scripts/` on demand while excluding unrelated skills), and 2-hop AST codebase querying (**Graphify**) inside **Watchkeeper**. This routinely cuts wasted retries while keeping context windows lean.

### What happens when my Claude Code weekly or 5-hour usage limit runs out?
Pending `wk-job` runs, steward visits and `ask-claude` questions go into the task queue for Antigravity (`wk-task`); the panel's Auto route can use the Gemini lane (Gemini CLI or API key) by quota. Watchkeeper never runs `agy`, and every file guard and the `~/.wk/KILL` switch still apply.

### How does Watchkeeper discover new trending AI agent skills automatically?
Watchkeeper checks GitHub once every 24 hours (`skill_vault.py discover-trending --sync --daily` via `com.nexodyne.watchkeeper-skill-sync`), ranks active repositories with `agent-skills` / `SKILL.md` workflows by stars and recency, clones with git hooks disabled, and indexes them locally for instant search in the **Skills Library** tab.

### Does Watchkeeper send my code, prompts, or sessions to third-party servers?
No. All logs, usage meters, skill indexes, Re-Prompt history, and Graphite graphs stay strictly in local files (`~/.wk/`, `~/.gemini/`, `.wk/`). Network calls happen only through your own configured CLI logins (`claude`, `agy`), optional GitHub public API skill-index fetches, or opt-in release/Stripe utilities.

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `watchkeeper.preferredLocation` | `sidebar` | Where Watchkeeper opens: `sidebar`, `editor` tab, `editor-maximized` (fills the IDE) or `studio` |
| `watchkeeper.openOnStartup` | `false` | Open Watchkeeper when the IDE starts (editor locations only; the side bar never opens by itself) |
| `watchkeeper.autoTakeTasks` | `false` | Run queued tasks here with Gemini (Gemini CLI or API key). Off: the queue is for Antigravity |
| `watchkeeper.claudeDir` | `~/.claude` | Claude Code's folder (sessions are in `projects/`) |
| `watchkeeper.orchestrationDir` | empty | A folder that holds `locks/`. Empty: the `orchestration` folder of the open workspace, if it has one. Questions come only from the folder named in `~/.wk/remote.json` |
| `watchkeeper.pluginPath` | empty | The plugin's folder. Empty means automatic: `~/Projects/watchkeeper` if it holds the plugin, else the newest `watchkeeper@*` plugin Claude Code installed |
| `watchkeeper.dataDir` | `~/.wk` | The plugin's data folder |

Plugin knobs live in `config/*.json` (gates, steward, gemini, models) and in `~/.wk/steward.json` and `~/.wk/projects.json`, which `wk-steward init` and `wk-projects scan` create.

## Requirements

- Node.js 20 or later on your PATH; the scripts are plain Node with no dependencies (tested with Node 26).
- Claude Code with plugin support for the plugin; an editor on VS Code 1.90 or later for the panel.
- Tested on macOS only. The launchd parts (the updater and the phone link) are macOS-only. The hooks and the panel use nothing platform-specific that we know of, but Linux and Windows are untested.

## Tests

```
node test/run.mjs
node --test test/*.test.mjs
python3 tests/verify_watchkeeper_v2.py
python3 -m unittest discover -s reprompt/tests -v
cd panel && npm test
```

Run them with a temporary `HOME` and `WK_HOME`; the suites use fakes for ssh, launchctl and claude and touch no real folder of yours.

## Uninstall

- The plugin: `/plugin uninstall watchkeeper@nexodyne`, then `/plugin marketplace remove nexodyne` (or stop passing `--plugin-dir`).
- The panel: **Extensions → Watchkeeper → Uninstall**.
- The Gemini plugin: delete `~/.gemini/config/plugins/watchkeeper`.
- The phone link, if you set it up: `node <plugin>/bin/wk-remote.mjs uninstall`, then delete `~/.ssh/wk_bridge_ed25519*` and its line in the server's `authorized_keys`.
- The updater, if you installed it: `node <plugin>/bin/wk-update.mjs uninstall`.
- The 30-second checker, if you installed it: `node <plugin>/bin/wk-watch.mjs uninstall`.
- Your data: delete `~/.wk/` and the `.wk/` folder in each project.

## Licence and trademarks

MIT License, Copyright (c) 2026 Nexodyne Limited. See [LICENSE](LICENSE).

Watchkeeper is an independent tool by Nexodyne. It is not made or endorsed by Anthropic or Google. Claude and Claude Code are trademarks of Anthropic, PBC. Gemini and Antigravity are trademarks of Google LLC.
