---
name: wk-take-task
description: >-
  Takes the next task from the Watchkeeper queue, does it in its own git worktree, runs its test and finishes with done,
  so Watchkeeper can check it and the owner can merge it with one press. Use it when the owner types /wk-take-task,
  when an automation says to take the next Watchkeeper task, or when the owner asks you to work through the queue.
---

# Take a Watchkeeper task

The owner and Claude put work for you in a queue. You take one task, do it in a separate git worktree, and finish with `done`. Watchkeeper then checks that you changed only the allowed files and that the test passes. Only then does the owner see "Gemini finished … Merge it?" and answer with one press. You never merge, commit or push yourself.

## 1. Take the task
Where you can, start a fresh conversation for each task. Watchkeeper's rules apply to the conversations that do Watchkeeper work, from the moment a conversation takes a task or touches `~/.wk` until it ends, so a fresh conversation keeps one task's work apart from the owner's own chats and from other tasks.

Run:

```
"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" take --model-used "<the model you run as>"
```

- Exit code 3: the owner has stopped Watchkeeper (the kill switch). Stop and say so in one line.
- Exit code 4: today's task limit is reached. Stop and say so in one line.
- Exit code 5: nothing is queued. Stop.
- Otherwise it prints the task id, the worktree folder, the suggested model, the allowed files, the test and the task text. Read all of it.

## 2. The model
Antigravity's model menu (or the automation's setting) chooses your model; Watchkeeper only suggests one. If the model you run as differs from the suggested model, keep going, and say so in the note at the end (for example "Suggested gemini-4-hydrogen-xhigh, ran on gemini-3.8-flash-medium").

## 3. Do the work
- Work only inside the worktree folder that `take` printed. Never change the main folder of the repository.
- Change only the allowed files.
- For larger tasks, use the subagents: `wk-scout` maps the files first (fast, read-only), `wk-builder` makes a well-described part, `wk-reviewer` checks the change before you finish.
- Never read keys, tokens, passwords or `.env` files. Never push, deploy, publish, send mail or buy anything. Never skip permissions.
- If you need the owner's decision, do not ask in chat: use the `wk-suggest` skill, then go on with what you can do.

## 4. Test
Run the task's test yourself in the worktree until it passes. If no test is set, run the project's usual checks if there are any.

## 5. Finish
Do not commit. Run:

```
"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" done <task id> --model-used "<the model you run as>" --note "<what you did, in two or three plain lines>"
```

- Exit code 0: done. Watchkeeper committed the change in the worktree and the owner sees it in the W panel. Stop here.
- Exit code 1: it says why (files outside the task, or the test failed). Fix it in the worktree and run `done` again. After two more tries, stop and leave it: the owner sees what failed.

`"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" list` shows the queue; `show <task id>` shows one task.
