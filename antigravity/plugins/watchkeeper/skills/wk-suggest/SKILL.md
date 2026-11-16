---
name: wk-suggest
description: >-
  Posts a suggestion or a question for the owner to the W panel, where they answer with one press (OK, Not now or No).
  Use it instead of asking the owner in chat whenever you need their decision, or want to propose something they should approve.
---

# Post a suggestion for the owner

The owner is often not watching the chat. They see suggestions in the W panel (and later on their phone) under "Waiting for you", and answer with one press: OK, Not now, or No. So whenever you need their decision, post a suggestion instead of asking in chat, then carry on with everything that does not depend on it.

Run:

```
"{{NODE}}" "{{WK_BIN_DIR}}/wk-suggest.mjs" add --from gemini --title "<the suggestion, with your recommendation>" --detail "<why, the options, and what happens on OK>"
```

- Write the title so that OK makes sense as the answer: "Use the existing date picker on the booking page?" rather than "Which date picker?".
- `--title`: up to 200 characters. `--detail`: up to 4,000 characters; for long text, leave out `--detail` and pipe it in.
- Plain, short words. One decision per suggestion. Never put keys, tokens or passwords in it.
- Money, buying, accounts, legal wording and publishing always wait for the owner: suggest them, never do them.

It prints the suggestion id. `"{{NODE}}" "{{WK_BIN_DIR}}/wk-suggest.mjs" list --decided` shows what the owner answered.
