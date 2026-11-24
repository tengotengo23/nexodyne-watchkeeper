---
name: evidence
description: Use before saying done, tested, fixed, deployed or LIVE. Backs every completion claim with output from this session.
---
A claim of done needs: the command, its exit code and counts, from this session. Run checks via `"${CLAUDE_PLUGIN_ROOT}/bin/wk-run"` (or `bin/wk-run`) so the Stop hook can record the evidence. A check that failed to start, or only checks syntax, is not a pass. Say which checks you skipped and why. Never delete, skip or weaken a test to make it pass. The Stop hook blocks once if a completion claim has no fresh passing run; answer it with output, or restate the claim as unverified.
