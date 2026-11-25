---
description: API drive: hand one task to Gemini (or Claude) through the user's own API key, with the cost shown. /wk-ask gemini <task>
---

Hand one self-contained task to the other model through the official API, with the key the user pasted in the W panel's API keys card. You never see or need the key.

When to use it: a small, quick question for Gemini Flash-Lite (an answer of under about 1,000 tokens over at most about 50 KB of files) when waiting is not an option. Big or long work (long files, large drafts, many steps, anything that can wait) does not go here: queue it with `wk-task add`, and Gemini does it on the user's Antigravity plan at no API cost. Keep hard reasoning and careful edits yourself. The answer is text only (an answer, a plan or a unified diff); you review it and apply it yourself.

The first word of the arguments is the provider (`gemini` or `claude`); the rest is the task. Add project files with `--file <path>` (repeat it), a model with `--model flash|mid|pro` (Gemini) or `--model haiku|sonnet|opus` (Claude).

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wk-ask.mjs" $ARGUMENTS
```

Show the answer, then the cost line it prints last. Exit codes, each with one plain sentence: 3 the stop switch is on; 4 the API drive is switched off; 5 today's cost cap or the hourly call limit is reached; 6 no key saved (tell the user: "Paste your key in the W panel's API keys card."); 2 bad use or a refused file; 1 the request failed. On 3 to 6, do not retry: say so in one line and carry on yourself.

Never send confidential or personal information. Never start `agy`, Antigravity's agent or the `claude` CLI; never read the keys folder.
