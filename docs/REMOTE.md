# Phone control (not usable yet)

Phone control needs a companion server that is not published yet. These notes describe the Mac side, which is off by default.

With such a server, you can see the Watchkeeper panel on your phone (a page the server serves) and act on it: answer questions, decide suggestions, send notes, start and stop Claude jobs. The Mac is the judge. The server only stores and forwards; it never holds a phone key's trust and never runs anything.

```
iPhone Safari --HTTPS, basic auth--> your server's phone page --files--> the server's bridge program (forced command of one ssh key)
                                                                                          ^ one long ssh link, opened by the Mac (outbound only)
wk-bridge on the Mac (launchd) --> checks every signature --> panel/src/actions.js or wk-job --> pushes the state back
```

## The parts on the Mac
- `bin/wk-bridge.mjs`: the protocol (hello, state, result, job, keys out; cmd, key in), the checks, the actions, the push, the CLI and the launchd agent.
- `bin/bridge-link.mjs`: the transport only (spawning ssh, line framing, the 2 MB line limit, reconnect backoff from 5 s to 5 min). It knows no message types, so another transport could sit here later without touching the checks.
- `bin/remote-lib.mjs`: canonical JSON, base64url, the passkey and grant checks, the allowlist, seen ids, the secret scan for anything pushed.
- `bin/wk-job.mjs`: Claude jobs (`claude -p` in a project, its own process group). `bin/wk-projects.mjs`: the project list.
- `panel/src/actions.js`: the same action code the Antigravity panel runs. A phone command and a panel button do exactly the same thing.

## One-time steps
0. On the Mac: tell Watchkeeper your server. There is no built-in one; until this is set, `setup`, `install`, `run`, `enable` and the link refuse with "Phone control needs a companion server", and `status` says "Server: not set".
   `node bin/wk-bridge.mjs config --origin https://panel.example.com --host 192.0.2.10 --user root` (also `--port N`, default 22, and `--rp-id DOMAIN`, default the origin's host name; it must be that name or a parent domain of it). The origin must be https. The command checks each value, writes `~/.wk/remote.json` and prints what it set. The phone page needs a companion server that is not published yet; phone control is off by default.
   `server_command` in `remote.json` is the program your server runs for this key (the forced command in its `authorized_keys` line): set it with `node bin/wk-bridge.mjs config --server-command /usr/local/sbin/example-bridge` (an absolute path; letters, digits, dots, underscores, dashes and slashes only). It starts empty, and `setup` refuses until it is set.
1. On the Mac: `node bin/wk-bridge.mjs setup`. It makes `~/.ssh/wk_bridge_ed25519` (once, 0600) and prints one line for the server. Add that line to the ssh user's `~/.ssh/authorized_keys` on the server.
2. On the Mac: `node bin/wk-bridge.mjs install`. This starts the link (launchd agent `org.nexodyne.wk-bridge`). From now on the Mac pushes its state, so the phone page shows it; the Mac still acts on nothing from the phone.
3. On the phone: open the phone page on your server and press **Set up this phone** (Face ID). The page names the key and the time.
4. On the Mac: in the Watchkeeper panel's Phone section, press **Trust** next to that name and time (or `node bin/wk-bridge.mjs trust <id>`). Trust it only if you set up your phone just now. **Reject** drops a key you do not know.
5. On the Mac: press **Switch phone control on** (or `node bin/wk-bridge.mjs enable`). Only the Mac can switch it on; the phone can only switch it off.

`node bin/wk-bridge.mjs status` shows the server, the link and the last push. `disable` switches phone control off; `uninstall` stops the link (the plist moves to `~/.wk/backups/`).

## What the Mac checks for every command
In order, and the first failure is the answer (logged in `~/.wk/remote-log.jsonl`):
1. Phone control is on, else "Phone control is off on the Mac."
2. Each passkey assertion: a trusted key; type `webauthn.get`; the origin and RP ID from `remote.json`; the challenge is the hash of the canonical command (or grant); user presence and Face ID flags; the signature; the sign counter only goes up.
3. A session grant (one Face ID covers 10 minutes of decisions): scope `decide` only, at most 10 minutes, not starting more than 5 minutes ahead of the Mac's clock, not expired, the command inside its time, the session signature.
4. The command: never seen before (a repeat gets the stored answer again and acts once), not too old (24 h for decisions, 2 h for prompts) or in the future, on the allowlist, prompt kinds only with a fresh Face ID, valid arguments.
5. At most 30 commands a minute and 300 a day. Only commands that passed the signature checks count: an unsigned or forged envelope is refused without using the budget, so a flood of them cannot lock you out. A command refused for the rate is remembered as refused and never runs later.

Allowlist: decisions `ping`, `answer`, `later`, `suggestion`, `task`, `send`, `stop-on`, `remote-off`, `job-stop`; with a fresh Face ID only `job-start`, `job-reply`, `stop-off`. Anything else: "Not something the phone can do."

A question about money, legal wording or an account needs the phone's "confirmed" as well, as in the panel. A "use the recommended answer" takes the recommended text the way the panel does (`OK: <recommended>`).

An `answer` names its question twice: the number `n` and `q`, the hash the push put on that question (`h`: the first 16 hex characters of SHA-256 over the question's text as pushed). Just before acting, the Mac reads question `n` again, hashes it the same way and compares; a question that is gone or whose text changed gets "That question has changed. Open it again." and nothing is sent. Suggestions need no hash: their ids (`S-<date>-<time>-<4 hex>`) are made once, and the first line with an id wins, so an id never names a different suggestion.

## Jobs from the phone
`job-start` runs `wk-job start` with the project, prompt, model (sonnet, opus, fable, haiku) and mode (auto, acceptEdits, plan). It never uses a mode or flag that skips Claude's permission checks (the refusal list `FORBIDDEN` in `bin/wk-job.mjs`; a test inspects the argv). It refuses when the stop switch is on, RAM is low, `max_jobs` run, the weekly pace is at or over `pace_stop_pct`, or the project is not in `~/.wk/projects.json`. A job stops after `job_hours`. Its events go to the server in batches (at most 200 events or about 1 MB per line, once a second); `jobs/<id>/pushed.json` remembers how far, and each event's `n` lets the server drop copies.

## What leaves the Mac
The panel's own model (`collect`), plus `mac`, `projects`, `jobs` (summaries), `phone` (labels and ids, never key material) and `bridge`. The home folder becomes `~`, every string goes through the secret scan (a hit becomes `[hidden]`; besides `gates.json` it hides `whsec_`, `sk_test_`, `AIza` and Slack `xoxb-`-style keys, and any `…SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY` or `PRIVATE_KEY` followed by `=` or `:` and a value; this outgoing list is not used by wk-guard), and over 1.5 MB the oldest ledger and session detail go first (logged). No `host`, no file paths section, and no hostname: `mac.name`, `hello` and `pong` say "this Mac". State is pushed when it changes (at most every 10 s) and every 60 s as a heartbeat.

## Honest limits
- **Trust on first use.** The Mac cannot know that a new key is your phone. It shows the name and the time it was set up; you must trust only a key set up just now. A key someone else registers with the panel password stays pending until rejected.
- **The served JavaScript.** If someone controls the panel's served JavaScript while you use it, they could ask for a Face ID signature over their own command; Face ID cannot show what is being signed. Strict CSP on the phone page, the Mac-side allowlist, the limits and the fresh Face ID for prompts are the defence, not a cure.
- **A crash mid-action: at most once.** The Mac writes a command's id to `remote-seen.jsonl` as `started`, flushed to disk, before it acts, and the result after. If the Mac dies between the two, the next start of the bridge marks the command `interrupted`, tells the phone "Interrupted, send again.", and gives that same answer to any re-delivery: it never runs a second time. A lost command is the price: you send it again, which makes a new id. A doubled job or answer would be worse. If the Mac cannot write the `started` line, it does not act.
- **A late or reordered answer.** The server may hold a decision for up to 24 hours or deliver it out of order. An `answer` whose question has changed or gone since the phone showed it is now refused ("That question has changed. Open it again."), and stays refused if it arrives again. Other decisions (`later`, `suggestion`, `stop-on`, …) still act when they arrive within 24 hours, on the item they name.
- **The ssh key** has no passphrase so launchd can use it. It can do one thing on the server (the forced command), and `-F /dev/null` with `IdentityAgent=none` means no other key is ever offered.
- **Pushing while off.** With the service installed, the state reaches the server even while phone control is off; only acting is off. `uninstall` stops the push.

## Files (all 0600 in `~/.wk/`, or `$WK_HOME`)
`remote.json` (settings), `remote-keys.json` (trusted and rejected keys), `remote-pending.json` (keys waiting for Trust), `remote-seen.jsonl` (command ids and their answers, 7 days), `remote-log.jsonl`, `remote-status.json` (the link), `jobs/<id>/`, `projects.json`, `bridge.log` (launchd output). docs/DATA-CONTRACT.md has the formats.

## Tests
`node --test test/remote.test.mjs test/job.test.mjs test/projects.test.mjs test/bridge.test.mjs` and `cd panel && npm test`. Temp HOME and WK_HOME; fake ssh (a fake server), ssh-keygen, launchctl and claude in `test/fixtures/`. Nothing reaches the server or the real home folder.
