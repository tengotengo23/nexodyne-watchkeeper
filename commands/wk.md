---
description: Watchkeeper /wk family: overview, status, graph, sync, stop, go, task, take-task (old names still work).
---

Run the Watchkeeper /wk command family:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wk.mjs" $ARGUMENTS
```

Show the output as printed. Do not start agy or Gemini.

| Command | What it does |
|---|---|
| `/wk` | overview, one screen, read-only |
| `/wk status` | runtime status |
| `/wk graph` | refresh the code graph (`graph inspect <symbol>`, `graph open`) |
| `/wk sync` | one skill index sync (approved sources only) and a graph refresh |
| `/wk stop [reason]` | turn the Stop switch on |
| `/wk go` | turn the Stop switch off |
| `/wk task "..."` | queue a task as a file; starts nothing |
| `/wk take-task` | take the next queued task or the latest handoff |

Old names still work: `/wk-status`, `/wk-take-task`, `/wk-add-task`, `/wk-suggest`, and the subcommands `overview`, `heal`, `tasks`, `handoff`, `watchdog`, `learn`, `mode`, `brain`, `skills`, `doctor`, `help`.
