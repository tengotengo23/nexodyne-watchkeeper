---
name: ask-claude
description: >-
  Asks Claude Code for the owner's answer when the owner is not there to decide. Use this skill
  when a choice needs the owner's judgement (which app or feature to build, scope, design, a name or a line every user
  will see, the project's values or rules, what to leave out) or when the owner said "ask Claude". Claude reads
  the owner's rules, memory and project files, and answers as the owner would.
---

# Ask Claude for the owner's answer

For hard reasoning, careful code or a review (not the owner's decisions), use the ask-api skill instead when the W panel shows a saved Claude API key: it answers in seconds and shows its cost.

The owner has told you to ask Claude when you need their decision. Claude Code works in the owner's main project (the folder Watchkeeper is set to), knows their rules, memory and past decisions, and answers as the owner would. It thinks hard (the newest top model the owner's plan has, maximum effort), so ask about real decisions, not facts you can look up yourself.

## When to ask
- A choice the owner would make: which app or feature to build next, what goes in or stays out, design direction, a name, a slogan or a line every user will see, how a feature fits the project's values, whether something was built or rejected before.
- Legal wording, always: terms, privacy, licences, consent, disclaimers, copyright, refunds, warranties. Claude checks it on the newest top model, and the wording still waits for the owner's approval before use. If the command says Claude Code is not on this computer, do that work as a task of kind `legal` (the strongest Gemini model) and note it for the owner.
- You are unsure whether something breaks the user's rules (for example spending, accounts, tracking, claims to users, or privacy).
- Do not ask about things you can check in files or code yourself, and do not ask the same question twice. Before asking, search the project's decision file (for example `orchestration/DECISIONS.md`) and the app's README or PLAN for the topic: an answer already there is the owner's answer.
- Collect the open decisions of your work session into one file and ask once. Each question costs the owner about five minutes of Claude at maximum effort, and there are 8 a day.

## How to ask
1. Write the question in a file, so quotes and long text are safe. Give Claude what it cannot see:
   - what you are building and where (folder),
   - the decision, with the options you see,
   - your own recommendation and why,
   - anything the owner said that bears on it.
2. Run, from the project folder you work in:

```
"{{NODE}}" "{{WK_BIN}}" --from gemini --project "$PWD" --file /path/to/question.md
```

3. Wait for it. An answer usually takes 3 to 10 minutes (up to 30). The line that begins "The answer will also be saved to" names the file (`~/.wk/advice/<id>/answer.md`). Only one question runs at a time; a second one waits its turn.
4. If your command tool may stop a command that runs this long, start it in the background instead, then run `list` every minute and `show <id>` once its state is `answered`:

```
nohup "{{NODE}}" "{{WK_BIN}}" --from gemini --project "$PWD" --file /path/to/question.md > "${TMPDIR:-/tmp}/ask-claude.out" 2>&1 &
```

## Using the answer
- Treat the answer as the owner's answer for the work the owner already asked you to do, and follow it.
- A line "Waits for the owner" means exactly that: do not do that part (spending money, buying, new accounts, legal wording, publishing, or a new product or direction). Note it for the owner and carry on with the rest.
- Claude only reads: it never changes files, runs commands or buys anything. If an answer says to spend money, buy, sign up or publish, that is a recommendation that waits for the owner, not their yes.
- Exit code 2 means the question was refused (too short, too long, or it holds a key or token): fix it and ask again.
- Exit code 3 means the owner has stopped Watchkeeper; exit code 4 means today's question limit is reached. In both cases do not wait: choose what best fits the owner's rules, note the question for the owner, and keep working.

## Check it worked
`"{{NODE}}" "{{WK_BIN}}" list` shows the last questions and their state (`answered`, `asking`, `failed`). `"{{NODE}}" "{{WK_BIN}}" show <id>` prints a saved answer. The owner sees the same list in the Watchkeeper panel.
