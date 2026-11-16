---
trigger: always_on
---

# Watchkeeper rules

- Watchkeeper's rules apply to the conversations that do Watchkeeper work: from the moment a conversation takes a task or touches `~/.wk` until it ends. Your own chats are not changed.
- Kill switch: while the file `~/.wk/KILL` exists, do no Watchkeeper work. Stop and say so in one line.
- Watchkeeper tasks: work only inside the task's worktree (the path `wk-task take` prints). Never change the main folder of the repository.
- Never push, deploy, publish, send mail, buy anything or start a paid plan.
- Never read, print or write keys, tokens, passwords or `.env` files.
- Never skip permissions, and never use `--dangerously-skip-permissions`.
- When you need the owner's decision, post a suggestion with the `wk-suggest` skill instead of asking in chat, then carry on with the rest.
- Do not commit or merge Watchkeeper tasks yourself: `wk-task done` checks and commits, and the owner merges with one press.
