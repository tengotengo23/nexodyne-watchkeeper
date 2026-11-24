---
name: wk-add-task
description: >-
  Hands a piece of work to the Watchkeeper queue, with a kind that picks the suggested model, so it is done later in its
  own worktree and checked before the owner merges it. Use it when you find work outside your current task, or when the
  owner asks you to queue something for later.
---

Part of the /wk family (`/wk`, `/wk status`, `/wk graph`, `/wk sync`, `/wk stop`, `/wk go`, `/wk task`, `/wk take-task`). This is an alias.


# Hand a task to the queue

Use this for a separate piece of work you should not do now: something outside your current task, or a job the owner wants done later. The task waits in the queue until a Gemini session takes it with `/wk-take-task`.

Run:

```
"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" add --from gemini --repo "<absolute path of the git repository>" --title "<short title>" --kind <kind> --allow "<glob>" --text "<what to do, why, and how to know it is done>"
```

- `--title`: up to 200 characters, plain words.
- `--text`: everything the next session needs: the files, the goal, and how to check it. For long text, leave out `--text` and pipe the text in.
- `--allow`: the files the task may change, as globs relative to the repository (for example `src/app/**`). Repeat it for more. Leave it out to allow every file.
- You cannot set a test: the owner or Claude sets tests.
- `--kind` picks the suggested model (leave it out to let Watchkeeper choose from the words):

| kind | for |
|---|---|
| read | read, search, summarize, list; no edits |
| quick | renames, boilerplate, docs, small scripts, tests for clear functions |
| code | everyday coding: a feature or fix in one area |
| ui | screens, layout, styles |
| plan | multi-file features, refactors |
| hard | hard bugs, concurrency, migrations, architecture |
| review | a second opinion on a change, read-only |
| legal | legal wording (terms, privacy, licences, consent): the strongest model; ask Claude first (ask-claude skill), and the owner approves before use |

It prints the new task id. Queue one task per piece of work, and never the same work twice: check `"{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs" list` first.
