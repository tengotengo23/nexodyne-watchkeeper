---
description: Alias of /wk take-task: take the next queued Watchkeeper task or the latest handoff; --handoff --cwd <repo> takes only that repo's handoff; --run new|<run id> works through an automation run's budget.
---

Run the Watchkeeper /wk command family:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wk.mjs" take-task $ARGUMENTS
```

Show the output as printed. Do not start agy or Gemini.

If it exits with code 5 ("No queued Watchkeeper tasks or active handoff"), nothing is waiting: reply with one short line, such as "Nothing queued.", and stop at once. Run no other tool and look for no other work, so a `/loop 5m /wk-take-task` pass with nothing to do costs almost nothing.

Alias of `/wk take-task`. Read the brief it prints and continue the work without asking the user to re-explain.

With `--handoff --cwd <repo>` (what Bridge uses) it takes only that repo's unread handoff, never a queued task; exit 5 then means the handoff was already taken.

Automation runs (P2-282): `--run new` starts a run (about 60 minutes, at most 6 tasks; `run_budget_minutes` and `max_tasks_per_run` in config/gemini.json) and takes its first task. The brief starts with `Run <id>: budget 60 min, used 0 min, task 1 of 6.` and ends with the command for the next one. After `done`, run `take-task --run <id>` again. Exit 6 ("Run <id> is complete ... Stop here.") means this run's budget is used: reply with that one line and stop. The Stop switch (exit 3) and the 12-a-day cap (exit 4) still come first.
