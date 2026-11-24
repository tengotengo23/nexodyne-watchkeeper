---
description: Bridge: wait in the background for a handoff from Gemini, take it with /wk-take-task --handoff, then wait again.
---

Bridge keeps this Claude Code tab ready for work that Antigravity (Gemini) hands over. The wait itself costs no model turns: one model turn per handoff, none while idle.

1. Start the wait with the Bash tool and `run_in_background: true`. Give it no `--max`: a background command has no time limit, and the wait checks itself once a minute.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wk-bridge.mjs" wait --for claude
```

2. Do not poll its output. You are woken when it exits.
   - Exit 0: it printed one JSON line (`kind`, `id`, `title`, `repo`) and has already claimed that handoff for this tab. Take it as a handoff, in its repo, and never with `--claim`:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/bin/wk.mjs" take-task --handoff --cwd "<repo from the JSON line>"
     ```

     If that prints a brief, do the work, then start step 1 again. If it exits 5, the handoff was already gone: that is an empty wake; start step 1 again. After 3 empty wakes in a row (three wakes where the handoff was already gone when you ran it), stop and say "Bridge: three wakes found nothing; run /wk-bridge to wait again."
   - Exit 1 (only if someone set a `--max` limit and it passed): start step 1 again. This does not count as an empty wake.
   - Exit 2 (the kill switch is on or Bridge is off): say so in one line and stop.
   - Any other exit code N: say "Bridge stopped (code N); run /wk-bridge to wait again." and stop.

3. The owner's messages always come first: when they ask for something else, do that, and re-arm the wait only after it.

Never start `agy`, Antigravity's agent or `claude -p`. `wk-bridge off` turns Bridge off; `wk-bridge status` shows what waits.
