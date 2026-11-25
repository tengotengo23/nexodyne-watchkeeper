# Watchkeeper for Antigravity

Version {{VERSION}} · MIT licence · source: https://github.com/tengotengo23/nexodyne-watchkeeper

Watchkeeper watches over agent work. This is its Antigravity plugin in one folder: its hooks and tools run from here, and nothing else of Watchkeeper needs installing.

## What it adds

- **Guard and stop switch.** A hook checks each tool call. In the conversations that do Watchkeeper work, it blocks secrets, pushes, hard resets and force pushes, and every step while the stop switch is on. A conversation does Watchkeeper work from its first step that runs `wk-task`, `wk-suggest` or `wk-ask-claude`, or touches `~/.wk`; so after `/wk-add-task` or `/ask-claude`, that chat follows these rules too. Other chats get no Watchkeeper rules.
- **Bedrock rules.** An always-on rule for every conversation: no claim of done, tested or live without the command and its result, no invented values, open-source code before new code, the code graph and small reads before raw reads, Watchkeeper skills loaded on demand, small decisions made without stopping. It stays under the guard.
- **Code graph.** The graph hooks keep a graph of the project's Python and JavaScript/TypeScript code up to date as files change, so the agent can see how the code fits together. `/graphify` builds a fuller graph that also covers other languages and documents; on first use it installs the graphify package from PyPI.
- **Re-Prompt.** A plain prompt of more than 30 words is rewritten into clear, structured instructions by a local template before the agent starts. Start a prompt with `raw:` to send it as you typed it, or with `rp:` to ask for a rewrite. An `rp:` rewrite uses a model only after you pick a provider in Re-Prompt's settings, with your own API key.
- **Memory.** When the agent edits a file, a hook keeps a copy of it for two hours (secrets masked). When you then change code the agent wrote, it saves your change as a snippet and shows matching snippets to the agent in later prompts.
- **Skills library.** `/profession-skill-vault` searches a local index of skills and loads one only when it helps.
- **Task queue.** `/wk-take-task` takes the next task that Claude Code queued for Antigravity, `/wk-add-task` queues one, and `/ask-claude` asks Claude Code a question through your own Claude Code login.

## Requirements

- Antigravity (IDE or CLI) on macOS or Linux
- Node.js 20 or newer, Python 3.9 or newer, and git
- Claude Code, only for `/ask-claude` and for tasks that Claude Code queues

## Install

1. Download `watchkeeper-antigravity-{{VERSION}}.zip` from the GitHub release and unzip it.
2. In Antigravity, open `/plugin` (or the Plugins Manager), choose **+ Install from local directory...**, and pick the unzipped `watchkeeper` folder.
3. Start a new conversation and ask: "Show Watchkeeper's status".

## Commands

| Command | What it does |
|---|---|
| `/wk` | overview, status, graph, sync, stop, go, task, take-task |
| `/wk-status` | Watchkeeper's status in one screen |
| `/re-prompt` | rewrite a rough prompt into clear instructions |
| `/wk-take-task`, `/wk-add-task` | take or queue a task |
| `/wk-suggest` | leave a suggestion for the owner to approve |
| `/ask-claude` | ask Claude Code a question |
| `/profession-skill-vault` | search the skills library |
| `/graphify` | build or query the code graph |
| `/duo-orchestrator` | see the limits of Claude and Gemini and where a task should go |

The same tools are in the plugin's `bin/` folder (`wk`, `wk-status`, `wk-task` and others), so the agent can run them by name.

## Permissions

In your own chats the guard only passes on a decision for each tool call: "allow" when Antigravity's Turbo preset, eager commands and Turbo browser scripts are all on, otherwise "ask". If `~/.wk/antigravity-hook.json` exists (a full Watchkeeper install writes it), the decision saved there is used instead; delete that file after you change those settings.

## What it reads, writes and sends

- **Reads:** the project you work in, and three values in `~/.gemini/config/config.json` (Antigravity's permission settings).
- **Writes:**
  - `~/.wk/`: state, tasks and logs, including one line for each finished turn in every chat (conversation id, model and workspace path); and the memory in `~/.wk/learning/` (copies of code the agent edited, and your saved snippets).
  - The plugin's data folder that Antigravity gives it: your last 50 prompts and their rewrites, and the hooks' state for each chat.
  - `~/.gemini/skill-vault/`: the skills index.
  - `~/.wk/watch.json`, and, only if you run `wk-watch install`, a LaunchAgent (`~/Library/LaunchAgents/com.tengo.watchkeeper-watch.plist`) or a systemd user timer (`~/.config/systemd/user/watchkeeper-watch.timer`) that checks every 30 seconds for waiting work and shows a notification. It never starts an agent.
  - In each project: a `.wk/` folder for its logs (with a `.gitignore`, so git ignores it) and a `graphify-out/` folder for the graph.
- **Sends:** nothing to Nexodyne. There is no telemetry and no account. Other connections happen only through steps you start:
  - `/ask-claude` uses your own Claude Code login.
  - `rp:` rewrites and the Gemini helpers call a model provider only with a key you add yourself.
  - `/graphify` downloads the graphify package from PyPI on first use.
  - `wk sync` and `wk-skill-vault update` update the downloaded skill libraries from GitHub; `wk-skill-sync` also searches GitHub for new ones; `wk-skill-sync install` adds a daily job that does both.

## Turn it off

- Stop switch: `wk stop` stops every step in Watchkeeper's conversations and pauses Re-Prompt, the graph and the memory in every chat; `wk go` turns it off again.
- The 30-second checker, if you installed it: `wk-watch uninstall`.
- Switch the plugin off with `/plugin disable watchkeeper`, or remove it with `/plugin uninstall watchkeeper`. Your data stays in the folders above until you delete it.

## Licence

MIT. See `LICENSE`.
