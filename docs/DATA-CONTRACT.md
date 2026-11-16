# Watchkeeper data contract (0.6.0)

One set of plain files for the Watchkeeper panel and any tool you build on it. Everything lives under `~/.wk/` (or `$WK_HOME` when it is set, as in the tests). Folders are 0700 and files 0600. Writers append or replace a whole file (written to a temporary file, then renamed); readers skip any line they cannot parse.

Nothing here talks to Google or runs `agy`: Gemini reads and writes these files only through the Watchkeeper scripts its plugin skills call.

## Ids
- Task: `YYYYMMDD-HHMMSS-<slug>`, the slug 1 to 40 characters of `[a-z0-9-]` (the same rule as the advice ids of `wk-ask-claude`). Local time.
- Suggestion: `S-YYYYMMDD-HHMMSS-<4 hex>`.
- Job: `J-YYYYMMDD-HHMM-<4 hex>` (local time).
- Phone key: the passkey's raw id as base64url; a phone command: 16 random bytes as base64url.

## Files

| File | Written by | Read by |
|---|---|---|
| `tasks/<id>/meta.json` | `wk-task` (add, take, done, merge, discard) | the panel, `wk-state`, `wk-task list/show` |
| `tasks/<id>/task.md` | `wk-task add` | Gemini (printed by `wk-task take`) |
| `tasks/<id>/change.diff` | `wk-task done` (and `discard` when no diff exists yet) | the panel (*Show the change*), `wk-task merge` (its sha-256) |
| `tasks/<id>/verify.json` | `wk-task done` | the panel, `wk-task show` |
| `tasks/<id>/claim` | `wk-task take` (made once, so a task is taken once) | `wk-task` |
| `worktrees/<id>/` | `wk-task take` (git worktree, detached at the repository's HEAD) | Gemini works here |
| `suggestions.jsonl` | `wk-suggest add/decide`, `wk-task done` | the panel, `wk-state`, `wk-suggest list` |
| `owner-inbox.jsonl` | the panel (recommendation, rule, decision), `wk-suggest decide` (decision) | a Claude Code session |
| `gemini/sessions.jsonl` | `wk-gemini-log` (the Antigravity Stop hook) | the panel, `wk-state` |
| `gemini/guarded.jsonl` | `wk-guard-agy` (the Antigravity PreToolUse hook) | `wk-guard-agy` only |
| `panel-state.json` | the panel only | the panel only |
| `antigravity-hook.json` | `wk-antigravity install` (so every `wk-update` too) | `wk-guard-agy` (the Antigravity hook), the panel |
| `<orchestration>/QUESTIONS.md` | your own tooling, if it keeps a question queue; answered only with `<orchestration>/nx answer <n> "<text>"` | the panel, `wk-state` |
| `remote.json` | `wk-bridge config`, `enable`/`disable`, the panel's phone switch, a phone's `remote-off` | `wk-bridge`, `wk-job`, the panel |
| `remote-keys.json` | `wk-bridge trust/reject`, the panel's Trust and Reject (sign counters: `wk-bridge run`) | `wk-bridge`, the panel |
| `remote-pending.json` | `wk-bridge run` (key lines from the server) | `wk-bridge trust/reject/keys`, the panel |
| `remote-seen.jsonl`, `remote-log.jsonl`, `remote-status.json` | `wk-bridge run` | `wk-bridge`, `wk-bridge status` |
| `jobs/<id>/` (meta.json, prompt-<n>.txt, events.jsonl, pushed.json) | `wk-job` (pushed.json: `wk-bridge run`) | the panel, `wk-bridge` (to the server), `wk-job list/show` |
| `model-pick.json`, `model-audit.jsonl` | `bin/model-pick.mjs` (from `wk-job` and `wk-ask-claude`) | `model-pick.mjs`, `node bin/model-pick.mjs [lane] [--json]` |
| `projects.json` | `wk-projects scan` (first run or `--write`); you may edit it | `wk-job`, the panel, `wk-bridge` |

### `tasks/<id>/meta.json`
```
{ "id", "created_at" (ISO), "from": "claude"|"owner"|"gemini", "title" (≤200), "kind", "model" (suggested), "fallback",
  "repo" (absolute, the repository's top folder), "allow": [globs relative to the repository], "test": string|null,
  "status": "queued"|"taken"|"verified"|"failed"|"out-of-scope"|"no-change"|"merged"|"discarded"|"conflict",
  "taken_at", "model_used", "worktree", "base" (sha), "commit" (sha), "done_at", "note" (≤4000) }
```
- `queued` → `take` → `taken` → `done` → `verified` (scope and test pass, committed in the worktree), `failed` (the test failed or the commit failed), `out-of-scope` (a file outside `allow`, or one `gates.json` excludes), or `no-change`.
- `failed` and `out-of-scope` can run `done` again after a fix. `verified` → `merge` → `merged`, or `conflict` (the merge was undone). Anything not merged → `discard` → `discarded`.
- `allow` defaults to `["**"]`. `*` matches within one folder, `**` across folders. A task from Gemini never has a `test`.
- `worktree` is written for readers only. Every tool uses `worktrees/<id>/` and never this field, because Gemini could rewrite this file.
- Scope: a rename counts as a deletion of the old path plus a new file (`--no-renames`). Files under `.husky/`, `.githooks/` or the configured `core.hooksPath` are out of scope unless an `allow` glob names that folder (`.husky/**`, not `**`).
- `merge` checks again from git and refuses, changing nothing, unless `commit` is one commit whose parent is `base`, `base` is in the repository's branch, every file of `git diff --no-renames base commit` is in scope, and the sha-256 of `git diff --binary --no-renames --no-ext-diff --no-textconv --no-relative --no-color base commit` equals that of `change.diff`. It also refuses while the repository has staged changes.

### `tasks/<id>/change.diff`
The bytes of `git diff --binary --no-renames --no-ext-diff --no-textconv --no-relative --no-color base commit` once `done` has committed (before that, the same diff of the staged work).

### `antigravity-hook.json` (0600)
`{ "pass": "allow"|"ask", "preset": "<userSettings.permissionPreset or null>", "policy": "<userSettings.autoExecutionPolicy or null>", "browser_policy": "<userSettings.browserJsExecutionPolicy or null>", "detected_at" (ISO), "source": "detected"|"flag" }`
- Written by every `wk-antigravity install` (and `wk-ask-claude install-antigravity`), which reads only those three keys of `~/.gemini/config/config.json`. `pass` is `allow` only when the preset is `AGENT_PERMISSION_PRESET_TURBO`, the policy is `CASCADE_COMMANDS_AUTO_EXECUTION_EAGER` and the browser policy is `BROWSER_JS_EXECUTION_POLICY_TURBO`; otherwise (a missing file, other values, bad JSON) `ask`. `--pass allow|ask` sets it by hand (`source: "flag"`).
- In Watchkeeper's conversations (see `gemini/guarded.jsonl`) the hook prints it for its 8 known tools, and every other tool gets `ask`; without this file: `config/gemini.json` `hook_pass_decision`, then `ask`. In every other conversation it prints it for every tool, and `ask` without this file (or with a bad one).

### `gemini/guarded.jsonl` (0600, folder 0700)
One line per conversation that did Watchkeeper work: `{ "at" (ISO), "conversation_id" (Antigravity's `conversationId`, ≤200) }`; the last 500 kept.
- Written by the PreToolUse hook on the first call of a conversation that runs `wk-task`, `wk-suggest`, `wk-state` or `wk-ask-claude` (or anything from Watchkeeper's `bin/`), names the data folder in a command, or has a cwd, workspace path or path argument in it. That call and every later call of the conversation meet Watchkeeper's rules; other conversations meet none. Without a `conversationId` each call is judged alone and nothing is written.
- Watchkeeper's rules apply to the conversations that do Watchkeeper work: from the moment a conversation takes a task or touches `~/.wk` until it ends. Your own chats are not changed.
- allow: Antigravity runs the call without asking you. ask: Antigravity asks you first; an unattended run (the hourly automation) then refuses the call.

### `tasks/<id>/verify.json`
`{ "files": [changed paths], "out_of_scope": [paths], "test": null | { "cmd", "code" (exit code, null when it did not run to the end), "tail" (the last 40 lines) } }`

### `suggestions.jsonl`
Append-only. Two kinds of line:
- an item: `{ "id", "at", "from": "claude"|"gemini"|"watchkeeper"|"owner", "title" (≤200), "detail" (≤4000), "action": { "type": "none"|"task-merge", "ref"? (task id) } }`
- an event: `{ "id", "at", "status": "ok"|"later"|"no", "text"? }`

The newest event wins. `later` hides the item for 24 hours (`later_hours` in `config/gemini.json`), then it is open again. Only `wk-task done` makes `task-merge` items. Control characters are stripped and the lengths enforced on write; readers still treat every field as text, never as a command or a path.

### `owner-inbox.jsonl`
Existing kinds `recommendation` and `rule` (`{at, kind, text, status}`, written by the panel). New kind `decision`, one row for every answer you give:
`{ "at", "kind": "decision", "ref" (a suggestion id, or "Q<n>" for a question), "choice": "ok"|"later"|"no"|"answer", "title", "text"? }`

### `gemini/sessions.jsonl`
`{ "at", "conversation_id", "model" (Antigravity's modelName), "workspace" (the first workspace folder), "reason" (terminationReason) }`, one line per finished Gemini turn; the last 500 lines are kept (`sessions_keep`).

### `panel-state.json`
`{ "later": { "Q106": <until, ms since 1970> } }` (the panel's own state).

### Questions
Open lines in `<orchestration>/QUESTIONS.md`: `- [ ] Q<n> (<date time>, tab <x>): <text>`, often with "Recommended: …" near the end. Never edited directly: `nx answer` ticks the line and appends to `DECISIONS.md`.

### Phone control (docs/REMOTE.md has the whole story; it needs a companion server that is not published yet)
- `remote.json`: `{ "enabled": false, "origin": "", "rp_id": "", "host": "", "port": 22, "user": "", "server_command": "", "key": "~/.ssh/wk_bridge_ed25519", "max_jobs": 2, "job_hours": 3, "pace_stop_pct": 90, "orchestration"?: <abs>, "task_repo"?: <abs> }`. Only the Mac turns `enabled` on. There is no built-in server: `origin`, `rp_id`, `host`, `user` and `server_command` (the forced command in the server's `authorized_keys` line) stay empty until `wk-bridge config` sets them (for example `--origin https://panel.example.com --host 192.0.2.10 --user root`), and until then the link and every command that reaches the server refuse.
- `remote-keys.json`: `{ "keys": [ { "id", "spki" (b64u DER), "label", "added_at", "registered_at", "sign_count", "used_at"? } ], "rejected": [ "<id>" ] }` (the last 200 rejected ids).
- `remote-pending.json`: `{ "keys": [ { "id", "spki", "alg": -7, "label" (<= 40, control characters removed), "registered_at", "seen_at" } ] }`.
- `remote-seen.jsonl`: `{ "id", "at", "status": "started"|"done"|"interrupted", "ok", "text" (<= 2000), "hash" }` per verified command, kept 7 days; the `started` line is written (fsync) before the action and `done` after it; a `started` line found at start-up becomes `interrupted` ("Interrupted, send again."), never a second run; a repeat id gets the stored answer again.
- `remote-log.jsonl`: one line per event (`{ "at": ISO, "ev": ..., ... }`: done, refused, repeat, repeat-running, interrupted, cmd-error, link-open, link-closed, link-error, line-dropped, line-not-json, send-too-large, model-cut, model-hidden, push-error, key-pending, key-refused, key-trusted, key-rejected, unknown-line). Never a command's text.
- `remote-status.json`: `{ pid, started_at, connected, connected_at, last_push_at, last_error, last_close_at, retry_in_s }`.
- `jobs/<id>/meta.json`: `{ id, project, cwd, model, mode, max_turns, from: "phone"|"panel"|"cli", state: queued|running|waiting|done|failed|stopped, session_id, started_at, ended_at, cost_usd, turns, last_text, prompts, events, runner_pid, pgid, wall_ms, legal, model_id, effort }` (`legal: true` when a prompt or reply holds legal wording, `panel/src/legal-words.js`; then `model_id` is the model it actually ran on and `effort` is `xhigh`). `events.jsonl`: `{ n, at, type, ... }` with type prompt, init, text, tool, permission_denied, result, note or model (`{ model, effort, text: "Legal: newest top model (<id>)" }`, one per attempt of a legal job) (strings secret-scanned and cut). `pushed.json`: `{ n }`, the last event sent to the server.
- `model-pick.json` (0600): `{ "v": 1, "unavailable": { "<model>": { at, lane, why } }, "picked": { "<lane>": { model, at } } }`; entries older than `cache_hours` (24, `config/models.json`) are ignored. `model-audit.jsonl`: `{ at: ISO, ev: "model-fallback"|"model-picked", lane, from, model, next?, why? }`, one line per fallback and per change of pick.
- `config/models.json` (in the plugin): `"legal": ["claude-fable-5-2", "fable", "opus", "sonnet"]`, the order legal wording tries; a newer Fable needs only its id first. The next model is tried only on "not available" (api_error_status 404); a 429, 529 or rate limit waits and retries the same model. `config/gemini.json` `routes.legal`: the Gemini lane for legal wording (the strongest models, the same as `hard`), matched by the same word list.
- `projects.json`: `{ "projects": [ { key, name, path (with ~), kind: "repo"|"folder", repo? } ] }`.
- What `wk-bridge` pushes: the panel's `collect` model without `host` and `paths`, plus `mac {name: "this Mac" (never the hostname), free_mb, low_ram}`, each `questions.items[i].h` (16 lowercase hex: SHA-256 of that item's `text` as pushed, cut to 16; an `answer` command must send it back as `args.q`), `phone {enabled, trusted[{id,label,added_at}], pending[{id,label,registered_at}]}`, `bridge {version, pushed_at}`; jobs without `tail`; `~` for the home folder; secrets as `[hidden]`; at most 1.5 MB (`cut: true` when even the trimmed model was too big).

## `node bin/wk-state.mjs --json`
The documented feed for any tool you build on these files:
```
{ "version": "0.5.0", "generated_at": ISO,
  "questions": [ { "n", "at", "tab", "text", "recommended": string|null } ],     newest number first
  "suggestions": [ { "id", "at", "from", "title", "detail", "action" } ],       open only, newest first
  "tasks": [ { "id", "created_at", "from", "title", "kind", "model", "fallback", "model_used", "repo", "status", "taken_at", "done_at", "note" } ],  newest first
  "gemini_sessions": [ ...the last 20 lines of gemini/sessions.jsonl, newest first ] }
```
The orchestration folder comes from `--orchestration <dir>`, else `$WK_ORCHESTRATION`, else the nearest `orchestration/` folder holding `QUESTIONS.md` above the current folder; with none, `questions` is empty.

## Commands that write
- `node bin/wk-task.mjs add --repo <abs> --title "<t>" [--kind <k>] [--model <m>] [--allow <glob>]... [--test "<cmd>"] [--from claude|owner|gemini] [--text "<t>" | stdin]` prints the new id.
- `node bin/wk-task.mjs take [--id <id>] [--model-used <m>]` · `done <id> [--note "<t>"] [--model-used <m>]` · `merge <id>` · `discard <id>` · `list [--json]` · `show <id> [--json]`. Exit 0 done, 1 failed or refused, 2 bad input, 3 kill switch on, 4 today's cap reached, 5 nothing queued.
- `node bin/wk-suggest.mjs add --title "<t>" [--detail "<t>" | stdin] [--from <who>]` prints the new id. `decide <id> ok|later|no [--text "<t>"]` exits 0 on success; on failure it exits non-zero with one plain line on stderr. `list [--open|--decided|--all] [--json]`.
- `node bin/wk-job.mjs start --project <key> --prompt "<t>" [--model sonnet|opus|fable|haiku] [--mode auto|acceptEdits|plan] [--max-turns <1-400>] [--from phone|panel|cli]` · `reply <id> --prompt "<t>"` · `stop <id>` · `list [--json]` · `show <id> [--json] [--after <n>]`. Exit 0 done, 1 refused, 2 bad input, 3 stop switch on.
- `node bin/wk-projects.mjs scan [--write] [--json] [--root <dir>]... | list [--json]` · `node bin/wk-bridge.mjs setup|run|trust <id>|reject <id>|keys|enable|disable|status|install|uninstall` (docs/REMOTE.md).
- All honour `WK_HOME`. Every git call uses execFile with an argument array; nothing pushes or uses the network. (Only `wk-bridge run` talks to the network: one ssh link to your own server.)
