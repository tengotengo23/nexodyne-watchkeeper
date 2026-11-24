---
description: Alias of /wk take-task: take the next queued Watchkeeper task or the latest handoff.
---

Run the Watchkeeper /wk command family:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wk.mjs" take-task $ARGUMENTS
```

Show the output as printed. Do not start agy or Gemini.

If it exits with code 5 ("No queued Watchkeeper tasks or active handoff"), nothing is waiting: reply with one short line, such as "Nothing queued.", and stop at once. Run no other tool and look for no other work, so a `/loop 5m /wk-take-task` pass with nothing to do costs almost nothing.

Alias of `/wk take-task`. Read the brief it prints and continue the work without asking the user to re-explain.
