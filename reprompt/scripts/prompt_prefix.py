#!/usr/bin/env python3
"""One prompt-prefix grammar for every Watchkeeper / Re-Prompt surface (P2-272, spec section 3.5).

Imported by core/fast_path.py, reprompt/scripts/reprompt_inline_hook.py (Antigravity),
reprompt/claude-code-plugin/bin/run-inline-hook.py (Claude Code) and reprompt/server/reprompt_engine.py.
panel/src/prompt-prefix.js mirrors it; both pass test/fixtures/prompt-prefix-vectors.json.

Grammar (prefixes are case-insensitive; the body after the prefix must not be empty):
  raw (pass the prompt untouched):   `raw:`  `rp-raw:`  `/wk raw:`  `:raw <body>`
  rewrite:                           `rp:` `reprompt:` `re-prompt:` `rp-spec:` `rp-deep:` `rp-bug:`
                                     `rp-refactor:` `rp-concise:` `rp-short:`
                                     `:rp <body>` `:reprompt <body>` `:re-prompt <body>`
  Colon-first forms need white space after the word, so `:rpx` is plain text.
  Mode per prefix: see PREFIX_MODE_MAP (None = the default mode).
Never rewritten: machine turns (the text opens with a hyphenated tag such as `<task-notification>` or
`<agent-message ...>`; `<pasted_content ...>` uses an underscore and stays the owner's own message) and loop
text (already rewritten or compiled: "[Re-Prompt ·", "[Re-Prompt Inline", "[WK-SPEC-V2:", the Re-Prompt system
override, or a spec with both "## Goal" and "## Verification").
Take-over command: `/wk-take-task [id]` and `/wk take-task [id]`.
Automatic rewriting by length (P2-273, the owner's rule): a plain prompt of more than AUTO_OVER_WORDS (30) words is
rewritten without a prefix, in Claude Code and in Antigravity alike; 30 words or fewer stay exactly as typed unless
they carry a rewrite prefix. A word is a white-space token holding a letter or digit; Chinese and Japanese characters
count one word each (they are written without spaces). Slash commands, machine turns, loop text and `raw:` prompts
are never rewritten, whatever their length. See word_count() and wants_auto_rewrite().
The opt-in "rewrite every prompt" switches (Antigravity hookAutoAll, Claude Code "always") start at AUTO_FLOOR_CHARS
and SHORT_REPLY_CHARS characters so short replies pass untouched.

Python 3.9 safe: the Claude Code hook runs under /usr/bin/python3.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple

PREFIX_MODE_MAP: Dict[str, Optional[str]] = {
    "rp": None,
    "reprompt": None,
    "re-prompt": None,
    "rp-spec": "deep_spec",
    "rp-deep": "deep_spec",
    "rp-bug": "bug_fix",
    "rp-refactor": "refactor",
    "rp-concise": "concise",
    "rp-short": "concise",
}

REWRITE_PREFIX_RE = re.compile(
    r"^\s*(?:(rp-spec|rp-deep|rp-bug|rp-refactor|rp-concise|rp-short|re-prompt|reprompt|rp)\s*:"
    r"|:(re-prompt|reprompt|rp)(?=\s))\s*(.+)$",
    re.IGNORECASE | re.DOTALL,
)
RAW_PREFIX_RE = re.compile(
    r"^\s*(?:(rp-raw|raw|/wk\s+raw)\s*:|:(raw)(?=\s))\s*(.+)$",
    re.IGNORECASE | re.DOTALL,
)
MACHINE_TAG_RE = re.compile(r"^\s*<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b", re.IGNORECASE)
TAKE_TASK_RE = re.compile(r"^\s*/wk(?:-|\s+)take-task(?:\s+([A-Za-z0-9_-]{4,80}))?\s*$", re.IGNORECASE)

SYSTEM_OVERRIDE_SENTINEL = "SYSTEM OVERRIDE: You are Re-Prompt"
LOOP_MARKERS = ("[Re-Prompt ·", "[Re-Prompt Inline", "[WK-SPEC-V2:")
AUTO_FLOOR_CHARS = 8
SHORT_REPLY_CHARS = 40
AUTO_OVER_WORDS = 30
CJK_CHAR_RE = re.compile("[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
# P2-273 review: one explicit white-space class, the same in panel/src/prompt-prefix.js (Python's str.split and JS \s differ).
WS_CLASS = "[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
WS_RE = re.compile(WS_CLASS + "+")
OVER_WORDS_RE = re.compile("^" + WS_CLASS + "*([0-9]{1,9})(?:\\.[0-9]+)?" + WS_CLASS + "*$")
# Settings written before P2-273 held the old defaults (Claude Code "prefix", hookAutoAll true); version 2 moves them once.
SETTINGS_VERSION = 2
# The most text a hook adds to a turn; the user's own message is always there in full.
INJECT_CAP_CHARS = 4000


def _norm_prefix(word: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (word or "").strip().lower())


def parse_raw(text: Any) -> Optional[str]:
    """Body of a raw-bypass prompt, or None when the text carries no raw prefix (or an empty body)."""
    m = RAW_PREFIX_RE.match(str(text or "").strip())
    if not m:
        return None
    body = (m.group(3) or "").strip()
    return body or None


def parse_rewrite(text: Any) -> Optional[Tuple[str, str, Optional[str]]]:
    """(prefix, body, mode) for an explicit rewrite prefix, else None."""
    m = REWRITE_PREFIX_RE.match(str(text or ""))
    if not m:
        return None
    body = (m.group(3) or "").strip()
    if not body:
        return None
    prefix = _norm_prefix(m.group(1) or m.group(2) or "rp")
    return prefix, body, PREFIX_MODE_MAP.get(prefix)


def is_machine_turn(text: Any) -> bool:
    """True when the text opens with a hyphenated tag (a harness or agent turn, not the owner)."""
    return bool(MACHINE_TAG_RE.match(str(text or "")))


def is_loop_text(text: Any) -> bool:
    """True for text that was already rewritten or compiled, so it must never be rewritten again."""
    s = str(text or "")
    if s.lstrip().startswith(SYSTEM_OVERRIDE_SENTINEL):
        return True
    if any(marker in s for marker in LOOP_MARKERS):
        return True
    return "## Goal" in s and "## Verification" in s


def match_take_task(text: Any) -> Optional[Tuple[str]]:
    """(task_id or "",) for `/wk-take-task [id]` or `/wk take-task [id]`, else None."""
    m = TAKE_TASK_RE.match(str(text or ""))
    if not m:
        return None
    return ((m.group(1) or ""),)


def _has_word_char(token: str) -> bool:
    return any(ch.isalpha() or ch.isdigit() or ch.isnumeric() for ch in token)


def word_count(text: Any) -> int:
    """Words in a prompt: white-space tokens holding a letter or digit, plus one per Chinese/Japanese character."""
    n = 0
    for token in WS_RE.split(str(text or "")):
        if not token:
            continue
        cjk = len(CJK_CHAR_RE.findall(token))
        if cjk:
            n += cjk
            n += sum(1 for part in WS_RE.split(CJK_CHAR_RE.sub(" ", token)) if part and _has_word_char(part))
        elif _has_word_char(token):
            n += 1
    return n


def auto_over_words(value: Any, default: int = AUTO_OVER_WORDS) -> int:
    """The word threshold from a setting: a whole number >= 0 (0 = the length rule is off), else the default."""
    if value is None or isinstance(value, bool):
        return default
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    m = OVER_WORDS_RE.match(str(value))
    return int(m.group(1)) if m else default


def migrate_settings(raw: Any) -> Dict[str, Any]:
    """A copy of a settings dict moved to SETTINGS_VERSION: files from before P2-273 (no settingsVersion) held the old
    defaults, so "prefix" for Claude Code becomes "words" and hookAutoAll true becomes false, once. Later choices stay."""
    out = dict(raw) if isinstance(raw, dict) else {}
    ver = out.get("settingsVersion")
    whole = (isinstance(ver, int) and not isinstance(ver, bool)) or (isinstance(ver, float) and ver.is_integer())
    if not whole or ver < SETTINGS_VERSION:  # 2.0 counts as 2, as in JS (Number.isInteger)
        if str(out.get("claudeCodeRewrite") or "").strip().lower() == "prefix":
            out["claudeCodeRewrite"] = "words"
        if out.get("hookAutoAll") is True:
            out["hookAutoAll"] = False
        out["settingsVersion"] = SETTINGS_VERSION
    return out


def skill_labels(items: Any, limit: int = 3) -> list:
    """Short skill names for the one-line note after a rewrite. The router hands over skill records (dicts); the note
    must show their names, never a raw record (found in the P2-273 live check)."""
    out = []
    for s in items if isinstance(items, list) else []:
        name = (s.get("name") or s.get("id")) if isinstance(s, dict) else s
        name = " ".join(str(name or "").split())[:60]
        if name:
            out.append(name)
    return out[:limit]


def cap_injected(text: Any, limit: int = INJECT_CAP_CHARS) -> str:
    """Text a hook adds to a turn, cut to `limit` characters at a line end; the cut points back to the user's message."""
    s = str(text or "")
    if limit <= 0 or len(s) <= limit:
        return s
    cut = s[:limit]
    nl = cut.rfind("\n")
    if nl >= limit // 2:
        cut = cut[:nl]
    return cut.rstrip() + "\n\n[... cut at " + format(limit, ",") + " characters; the full text is the user's message above.]"


def wants_auto_rewrite(text: Any, over_words: Any = AUTO_OVER_WORDS) -> bool:
    """True when a plain prompt (no prefix, no slash command, not a machine or loop turn) has more than
    over_words words. over_words 0 turns the rule off."""
    limit = auto_over_words(over_words)
    if limit <= 0:
        return False
    s = str(text or "").strip()
    if not s or s.startswith("/"):
        return False
    if classify(s)["kind"] != "none":
        return False
    return word_count(s) > limit


def classify(text: Any) -> Dict[str, Any]:
    """One verdict for a prompt: kind is empty | take_task | machine | loop | raw | rewrite | none."""
    s = str(text or "")
    out: Dict[str, Any] = {"kind": "none", "prefix": None, "body": s.strip(), "mode": None, "task_id": None}
    if not s.strip():
        out["kind"] = "empty"
        out["body"] = ""
        return out
    take = match_take_task(s)
    if take is not None:
        out.update(kind="take_task", task_id=take[0] or None)
        return out
    if is_machine_turn(s):
        out["kind"] = "machine"
        return out
    if is_loop_text(s):
        out["kind"] = "loop"
        return out
    m = RAW_PREFIX_RE.match(s.strip())
    if m and (m.group(3) or "").strip():
        out.update(kind="raw", prefix=_norm_prefix(m.group(1) or m.group(2)), body=m.group(3).strip())
        return out
    rw = parse_rewrite(s)
    if rw is not None:
        out.update(kind="rewrite", prefix=rw[0], body=rw[1], mode=rw[2])
        return out
    return out


__all__ = [
    "AUTO_FLOOR_CHARS",
    "AUTO_OVER_WORDS",
    "INJECT_CAP_CHARS",
    "SETTINGS_VERSION",
    "WS_CLASS",
    "cap_injected",
    "skill_labels",
    "migrate_settings",
    "CJK_CHAR_RE",
    "LOOP_MARKERS",
    "MACHINE_TAG_RE",
    "PREFIX_MODE_MAP",
    "RAW_PREFIX_RE",
    "REWRITE_PREFIX_RE",
    "SHORT_REPLY_CHARS",
    "SYSTEM_OVERRIDE_SENTINEL",
    "TAKE_TASK_RE",
    "auto_over_words",
    "classify",
    "is_loop_text",
    "is_machine_turn",
    "match_take_task",
    "parse_raw",
    "parse_rewrite",
    "wants_auto_rewrite",
    "word_count",
]
