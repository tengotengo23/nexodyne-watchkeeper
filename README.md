# Watchkeeper · v0.6.1

Watchkeeper is a free, MIT-licensed panel and plugin for people who run many Claude Code sessions and subagents: the panel, beside your code in Antigravity or an editor built on VS Code, lists every session and the workers it started; the plugin guards tool calls, keeps a spend ledger for the headless runs it starts, and sends back a "done" that has no test behind it. Gemini in Antigravity can join as an optional second worker. Your data stays in local files; nothing goes to Nexodyne, and there is no telemetry.

## Two parts

| Part | Where it runs | What you get |
|---|---|---|
| **The panel** (`panel/`) | Antigravity, VS Code, Cursor, Windsurf, VSCodium | Your Claude Code sessions and their workers for the last 24 hours. Works alone. |
| **The plugin** (the rest of this repository) | Claude Code | Hooks that guard every tool call, an evidence gate on "done", a spend ledger, a steward you can schedule, a queue for Gemini. The panel shows all of it when both are installed. |

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

If you would rather read and change the code first, clone it and start Claude Code with the folder each time:

```
git clone https://github.com/tengotengo23/nexodyne-watchkeeper ~/Projects/watchkeeper
claude --plugin-dir ~/Projects/watchkeeper
```

The panel looks in `~/Projects/watchkeeper` too, so this route needs no setting either.

Below, `<plugin>` means the plugin's folder: `~/.claude/plugins/cache/nexodyne/watchkeeper/<version>` for a marketplace install, or your clone.

### Gemini in Antigravity (optional)

```
node <plugin>/bin/wk-antigravity.mjs install
```

This copies a small Antigravity plugin (skills, three subagents, a rules file and a hook) to `~/.gemini/config/plugins/watchkeeper`, with absolute paths filled in, so run it again after each plugin update. `--dry-run` shows what it would do; `status` says what is installed.

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
- **Subagents** `scout`, `builder`, `reviewer` and `quarantine`, each with a fixed model, effort, turn cap and context window; skills `lean-tokens` and `evidence`.
- **Gemini in Antigravity** (`bin/wk-task.mjs`, `bin/wk-suggest.mjs`): a task queue under `~/.wk/`. Gemini takes a task when you type `/wk-take-task` in Antigravity (or an automation you create there does), works in its own git worktree, and `done` checks the changed files against the task's allowed paths and runs the task's test. You merge with one press in the panel, and the merge checks everything again from git. At most 12 tasks a day. Watchkeeper never runs Antigravity for you and never calls Google's service: it only reads and writes files under `~/.wk/`.
- **Gemini asks Claude** (`bin/wk-ask-claude.mjs`): the `ask-claude` skill lets Gemini put a decision to Claude Code, which answers as you would from the project's rules, memory and decision files, in your own voice from `~/.wk/voice.md` when that file exists. Read-only tools only; 8 questions a day; 30 minutes each. Set `WK_ASK_CWD`, or `main_project` in `~/.wk/ask.json`, to the project folder Claude should read; without either, it reads the `--project` folder or the folder it was started in, and says which in its answer. Each answer uses your plan's strongest model at maximum effort, so it is costly: change the limit with `WK_ASK_DAILY_MAX` and the model with `WK_ASK_MODEL`.

## What it reads, writes and sends

**Reads.** The panel reads `~/.claude/projects` (of a long file only its start and end), the workspace's `orchestration/locks/` folder if there is one, and with the plugin `~/.wk/` and the plugin's own config. The plugin's hooks read the policy, the project's `worklog/` and `.wk/` files, and the tool call Claude Code hands them.

**Writes.** The plugin writes `~/.wk/` (ledger, pin, kill file, notes, steward state, tasks, worktrees, advice). Watchkeeper edits none of your files. It adds one folder, `.wk/`, to each project it runs in, for its logs (blocked, approved and evidence), with a `.wk/.gitignore` containing `*` so git leaves it out. The worktrees for Gemini live under `~/.wk/worktrees/`.

**Runs.** The panel writes the kill file and a note line. On each refresh it runs the plugin's `bin/wk-ledger.mjs pace` and read-only git commands (branch, last commit, status) in the projects listed in `~/.wk/projects.json`. Those git commands never contact a remote, and they switch off the repository settings that would run a command of its own (fsmonitor, filters, signature checks, hooks); status does not look inside submodules; if git cannot list a project's filters, the panel skips that project's status. On your press it runs only the plugin's own scripts from the plugin's folder (answer a suggestion, add a task, start, reply to or stop a job, set up Gemini's ask skill, the phone controls) and, for a question, the `nx` script in the orchestration folder named in `~/.wk/remote.json`. It never runs a file from a workspace folder. In a folder you have not trusted, it runs nothing at all and says so.

**Sends.** Nothing goes to Nexodyne. There is no telemetry, no account and no network call in the panel. The plugin's network use, each off until you set it up:

- `claude -p` runs (the steward, jobs, ask-claude) use your own Claude Code login and count against your own plan;
- the business snapshot (`bin/wk-snapshot.mjs`) reads totals from your own Stripe account, only when you set `STRIPE_RESTRICTED_KEY` in the environment, and keeps no customer data;
- the clone route's updater (`bin/wk-update.mjs install`, macOS) fetches this repository's release tags;
- the phone link (`bin/wk-bridge.mjs`) is off by default and needs a companion server that is not published yet; `wk-bridge config` sets a server of your own, and until then every remote command refuses.

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
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
cd panel && npm test
```

Run them with a temporary `HOME` and `WK_HOME`; the suites use fakes for ssh, launchctl and claude and touch no real folder of yours.

## Uninstall

- The plugin: `/plugin uninstall watchkeeper@nexodyne`, then `/plugin marketplace remove nexodyne` (or stop passing `--plugin-dir`).
- The panel: **Extensions → Watchkeeper → Uninstall**.
- The Gemini plugin: delete `~/.gemini/config/plugins/watchkeeper`.
- The phone link, if you set it up: `node <plugin>/bin/wk-bridge.mjs uninstall`, then delete `~/.ssh/wk_bridge_ed25519*` and its line in the server's `authorized_keys`.
- The updater, if you installed it: `node <plugin>/bin/wk-update.mjs uninstall`.
- Your data: delete `~/.wk/` and the `.wk/` folder in each project.

## Licence and trademarks

MIT License, Copyright (c) 2026 Nexodyne Limited. See [LICENSE](LICENSE).

Watchkeeper is an independent tool by Nexodyne. It is not made or endorsed by Anthropic or Google. Claude and Claude Code are trademarks of Anthropic, PBC. Gemini and Antigravity are trademarks of Google LLC.
