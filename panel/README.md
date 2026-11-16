# Watchkeeper

See your Claude Code sessions, and the workers each one started, in a panel beside your code.

Click the **W** on the Activity Bar. For the last 24 hours you see:

- each Claude Code session: its title, project, model, the size of its transcript (an estimate, in tokens), and whether it is active (it wrote in the last 10 minutes);
- the workers (subagents) a session started: what each was asked to do, its model and effort, and whether it has finished;
- area locks, if your own tooling keeps them: one file per locked area in an `orchestration/locks/` folder, first line `pid|label|since`.

While the panel is open it reads again every 30 seconds; **Refresh** reads at once.

## Private by design

- It reads files on your computer only: the session files in `~/.claude/projects` (of a long file only its start and its end), the locks folder if there is one, and one check whether the Watchkeeper plugin is installed. Without the plugin it reads nothing else.
- The panel itself makes no network calls: no telemetry, no account. With the plugin, a job you start runs `claude -p` on your own Claude Code login.
- In a folder you have not trusted, it runs nothing: answering, deciding, adding a task, jobs and the phone controls are off, and the panel says why.
- It writes nothing. Only the plugin features below write, and only with the plugin.

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
- **Gemini**: the tasks queued for Gemini in Antigravity, their status and the model each kind suggests, Gemini's last sessions, and a form to hand Gemini a task. **Show the change** opens a finished task's diff before you decide; **OK** merges it.
- **Answered for you**: the last questions Gemini put to Claude, with their answers.
- A box for your notes, a **Wake-up switch** that stops all unattended work (it writes `~/.wk/KILL`), and **Updates**.

Without the plugin those parts stay hidden.

## What's new in 0.6

- **Jobs** and **Projects**: run `claude -p` in one of your projects from the panel, reply to it and stop it.
- The panel finds a plugin installed through Claude Code by itself; `watchkeeper.pluginPath` is now empty (automatic) by default.

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `watchkeeper.claudeDir` | `~/.claude` | Claude Code's folder (sessions are in `projects/`) |
| `watchkeeper.orchestrationDir` | empty | A folder that holds `locks/`. Empty: the `orchestration` folder of the open workspace, if it has one. Questions come only from the folder named in `~/.wk/remote.json` |
| `watchkeeper.pluginPath` | empty | The Watchkeeper plugin's folder. Empty means automatic: `~/Projects/watchkeeper` if it holds the plugin, else the newest `watchkeeper@*` plugin Claude Code installed |
| `watchkeeper.dataDir` | `~/.wk` | The plugin's data folder |

## Where it runs

Made for Antigravity and tested there on macOS. It should work in any editor built on VS Code 1.90 or later, such as VS Code, Cursor, Windsurf or VSCodium. Linux and Windows are untested.

Source, plugin and issues: https://github.com/tengotengo23/nexodyne-watchkeeper

Watchkeeper is an independent tool by Nexodyne. It is not made or endorsed by Anthropic or Google. Claude and Claude Code are trademarks of Anthropic, PBC. Gemini and Antigravity are trademarks of Google LLC. MIT License.
