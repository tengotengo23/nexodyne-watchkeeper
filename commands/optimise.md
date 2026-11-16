---
description: Show (and with --apply, set) the token-saving settings baseline; check context size
argument-hint: [--apply]
---
Run `node "${CLAUDE_PLUGIN_ROOT}/bin/wk-optimise.mjs" $ARGUMENTS` and show the diff. Never apply without the user's yes. Then, if a recent transcript path is known, run `node "${CLAUDE_PLUGIN_ROOT}/bin/wk-ledger.mjs" context <transcript>` and report only the verdict line.
