---
name: ask-api
description: >-
  Hands one hard task to Claude through the user's own Claude API key (the API drive), and shows what it cost.
  Use it for hard reasoning, careful code, a second opinion, or a review of a plan or a diff, when the W panel
  shows a saved Claude key. Not for the owner's decisions: those go to the ask-claude skill.
---

# Ask Claude through the API

The user pasted a Claude API key in the W panel's API keys card. Watchkeeper sends your task to Claude's API with that key and returns the answer. You never see or need the key, and you must never look for it.

## When to use it
- Hard reasoning, careful code, a tricky bug, a review of your plan or diff, a second opinion.
- Not for easy or bulky work: do that yourself. Not for the owner's decisions (scope, names, design, legal wording): those go to the ask-claude skill.
- One-shot: Claude cannot run tools. It returns text (an answer, a plan or a unified diff); you review it and apply it yourself.

## How to ask
Write the task so it stands alone: what you are building, the question, what you tried. Add project files with `--file` (inside the project only, text only, 400 KB in total). From the project folder:

```
"{{NODE}}" "{{WK_BIN_DIR}}/wk-ask.mjs" claude "<the task>" --file path/to/file.js
```

- A long task: write it to a file and pipe it in with `-` as the task: `... claude - < task.md`.
- Model: `--model sonnet` (default), `--model haiku` (cheapest) or `--model opus` (hardest work, costs most).
- The answer comes on stdout; the last line on stderr is the cost: model, tokens, about US$ cost, today's spend of the cap.

## Exit codes
- 0: the answer. 1: the request failed (the message says why; the key is never shown).
- 2: bad use or a refused file (outside the project, a key file, a denied file, too big, not text). Fix it and ask again.
- 3: the owner's stop switch is on. 4: the API drive is switched off. 5: today's cost cap or the hourly call limit is reached. 6: no Claude key saved ("Paste your key in the W panel's API keys card."). On 3 to 6, do not retry: carry on yourself and note it for the owner.

## Rules
- Never send confidential or personal information, keys, tokens or passwords.
- Never read, list or copy anything in the keys folder; Watchkeeper blocks it.
- Never start `agy`, Antigravity's agent or the `claude` CLI for this: `wk-ask` is the only way.
