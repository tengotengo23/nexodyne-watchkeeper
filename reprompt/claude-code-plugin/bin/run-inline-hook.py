#!/usr/bin/env python3
"""Claude Code UserPromptSubmit hook for `rp:` rewriting + dynamic skill Load/Unload.

P2-272 (Watchkeeper canon): this hook never calls agy or Gemini. By default it rewrites only messages that start with
`rp:` / `rp-*:` / `:re-prompt` / `:rp` (setting claudeCodeRewrite: prefix | always | never), on the fast local template
(setting claudeCodeProvider), leaves task reports, agent messages and other machine turns alone, acts once even when it
is registered twice (plugin + ~/.claude/settings.json), and shows a one-line note instead of the rewritten text.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

REPO_CANDIDATE = next(
    (
        root
        for root in (
            PLUGIN_ROOT,
            PLUGIN_ROOT.parent,
            PLUGIN_ROOT / "reprompt",
            PLUGIN_ROOT.parent / "reprompt",
        )
        if (root / "server" / "reprompt_engine.py").is_file()
    ),
    None,
)

if REPO_CANDIDATE:
    for p in (str(REPO_CANDIDATE), str(REPO_CANDIDATE / "scripts")):
        if p not in sys.path:
            sys.path.insert(0, p)

# P2-272: one prefix grammar for every surface (scripts/prompt_prefix.py; spec section 3.5).
# Task reports, agent messages and reminders open with a hyphenated tag (<task-notification>, <agent-message …>):
# machine turns, not the owner's words. `<pasted_content …>` uses an underscore: the owner's own paste still counts.
try:
    from prompt_prefix import (  # noqa: E402
        AUTO_OVER_WORDS,
        MACHINE_TAG_RE,
        PREFIX_MODE_MAP,
        SHORT_REPLY_CHARS,
        auto_over_words,
        cap_injected,
        is_loop_text,
        is_machine_turn,
        parse_raw,
        parse_rewrite,
        skill_labels,
        wants_auto_rewrite,
        word_count,
    )
    from prompt_prefix import REWRITE_PREFIX_RE as PREFIX_RE  # noqa: E402,F401
except ImportError:  # grammar module missing: fail safe, never rewrite
    MACHINE_TAG_RE = re.compile(r"^\s*<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b", re.IGNORECASE)
    PREFIX_MODE_MAP = {}
    PREFIX_RE = None
    SHORT_REPLY_CHARS = 40
    AUTO_OVER_WORDS = 30

    def auto_over_words(value, default=AUTO_OVER_WORDS):  # type: ignore[no-redef]
        return 0

    def wants_auto_rewrite(text, over_words=AUTO_OVER_WORDS):  # type: ignore[no-redef]
        return False

    def skill_labels(items, limit=3):  # type: ignore[no-redef]
        return []

    def word_count(text):  # type: ignore[no-redef]
        return 0

    def cap_injected(text, limit=4000):  # type: ignore[no-redef]
        s = str(text or "")
        return s if len(s) <= limit else s[:limit] + "\n\n[... cut; the full text is the user's message above.]"

    def is_machine_turn(text):  # type: ignore[no-redef]
        return bool(MACHINE_TAG_RE.match(text or ""))

    def is_loop_text(text):  # type: ignore[no-redef]
        return True

    def parse_raw(text):  # type: ignore[no-redef]
        return None

    def parse_rewrite(text):  # type: ignore[no-redef]
        return None

SHORT_PROMPT_CHARS = SHORT_REPLY_CHARS
# P2-273: "words" (default) = rp: prefixes + plain prompts above autoRewriteOverWords words (the owner's 30-word rule).
REWRITE_MODES = ("prefix", "words", "always", "never")
CLAUDE_SAFE_PROVIDERS = ("offline_template", "claude_cli", "anthropic_api")
DEDUPE_WINDOW_S = 5.0  # both registrations fire within milliseconds of each other


def parse_inline_trigger(
    text: str, auto_all: bool = False, ack_re: re.Pattern[str] | None = None, over_words: int = 0
) -> tuple[str, str | None] | None:
    stripped = (text or "").strip()
    if not stripped or is_machine_turn(stripped) or is_loop_text(stripped) or stripped.startswith("/"):
        return None
    if parse_raw(stripped) is not None:
        return None

    parsed = parse_rewrite(stripped)
    if parsed is not None:
        _prefix, body, mode = parsed
        return body, mode

    # P2-273: a plain prompt of more than over_words words is rewritten (0 = the rule is off).
    if over_words and wants_auto_rewrite(stripped, over_words):
        return stripped, None
    # "always" mode: only real requests (40+ characters, not an acknowledgement) are rewritten.
    if auto_all and len(stripped) >= SHORT_PROMPT_CHARS and not (ack_re and ack_re.match(stripped)):
        return stripped, None
    return None


def first_run_for_prompt(session_id: str, prompt_text: str, now: float | None = None) -> bool:
    """True for the first copy of this hook that sees this prompt; False for a second registration of the same hook."""
    try:
        marker_dir = Path(tempfile.gettempdir()) / "wk-hook-dedupe"
        marker_dir.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(f"{session_id}\n{prompt_text}".encode("utf-8", "replace")).hexdigest()[:24]
        marker = marker_dir / f"{key}.mark"
        now = time.time() if now is None else now
        if random.random() < 0.05:
            for old in marker_dir.glob("*.mark"):
                try:
                    if now - old.stat().st_mtime > 3600:
                        old.unlink()
                except OSError:
                    pass
        for _ in range(2):
            try:
                fd = os.open(str(marker), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                return True
            except FileExistsError:
                try:
                    if now - marker.stat().st_mtime < DEDUPE_WINDOW_S:
                        return False
                    marker.unlink()
                except FileNotFoundError:
                    continue
                except OSError:
                    return True
        return False
    except Exception:
        return True


def rewrite_mode_from(settings: dict[str, Any]) -> str:
    mode = str(settings.get("claudeCodeRewrite") or "words").strip().lower()
    return mode if mode in REWRITE_MODES else "words"


def provider_from(settings: dict[str, Any]) -> str:
    provider = str(settings.get("claudeCodeProvider") or "offline_template").strip().lower()
    return provider if provider in CLAUDE_SAFE_PROVIDERS else "offline_template"


def hook_budget_s() -> float:
    """Model time inside the 90 s hook: at most 30 s, leaving room for the local fallback."""
    try:
        return max(5.0, min(30.0, float(os.environ.get("REPROMPT_HOOK_BUDGET_S") or 30)))
    except ValueError:
        return 30.0


def emit(context: str = "", note: str = "") -> None:
    out: dict[str, Any] = {}
    if context:
        out["hookSpecificOutput"] = {"hookEventName": "UserPromptSubmit", "additionalContext": context}
    if note:
        out["systemMessage"] = note
    print(json.dumps(out, ensure_ascii=False))


def mark(store: Any, session_id: str, route: str, **kw: Any) -> None:
    try:
        store.mark_route(session_id, route, "claude_code", **kw)
    except Exception:
        pass


def main() -> int:
    # P2-272 canon guard: the engine refuses agy / Gemini for calls marked as coming from Claude Code.
    os.environ["WK_CALLER"] = "claude_code"
    try:
        if (
            os.environ.get("REPROMPT_INTERNAL_CALL") == "1"
            or os.environ.get("WK_SUBAGENT_ACTIVE") == "1"
            or REPO_CANDIDATE is None
        ):
            print("{}")
            return 0

        raw_stdin = sys.stdin.read()
        payload = json.loads(raw_stdin) if raw_stdin.strip() else None
        if not isinstance(payload, dict):
            print("{}")
            return 0
        prompt_text = str(payload.get("prompt") or payload.get("lastUserInput") or "").strip()
        if not prompt_text or is_machine_turn(prompt_text):
            print("{}")
            return 0
        session_id = str(payload.get("session_id") or payload.get("conversationId") or "claude_default")
        if not first_run_for_prompt(session_id, prompt_text):
            print("{}")
            return 0

        from reprompt_inline_hook import (
            consume_pending_shared_handoff,
            is_wk_kill_active_for_payload,
            run_takeover_command,
        )
        from server.reprompt_engine import (
            RePromptStore,
            default_data_dir,
            detect_graphify_context,
            parse_raw_bypass,
            rewrite_with_provider,
        )
        from skill_router import ACK_RE, format_skill_directives, is_trivial_prompt, judge_skills_for_prompt  # noqa: F401
        from skill_router import format_skill_outline_directives, has_skill_directive_block, record_injected_skills
        from skill_vault import _index_file

        if is_wk_kill_active_for_payload(payload):
            print("{}")
            return 0

        store = RePromptStore(default_data_dir())
        settings = store.load_settings()
        rewrite_mode = rewrite_mode_from(settings)
        workspace_dir = str(payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or "")

        takeover_msg = run_takeover_command(prompt_text, workspace_dir, "claude")
        if takeover_msg is not None:
            emit(takeover_msg)
            return 0

        raw_body = parse_raw_bypass(prompt_text)
        if raw_body is not None:
            mark(store, session_id, "raw")
            emit(
                "[Re-Prompt] The message starts with a raw marker (`raw:` or `:raw`): take it exactly as typed, "
                "without the marker. No rewrite was made.",
                "⚡ Raw · sent as typed",
            )
            return 0

        handoff_note = ""
        if not prompt_text.startswith("/"):
            handoff_note = consume_pending_shared_handoff(workspace_dir, "claude")

        parsed = None
        over_words = auto_over_words(settings.get("autoRewriteOverWords")) if rewrite_mode in ("words", "always") else 0
        if rewrite_mode != "never":
            parsed = parse_inline_trigger(
                prompt_text, auto_all=rewrite_mode == "always", ack_re=ACK_RE, over_words=over_words
            )
        if parsed:
            body, mode_override = parsed
            provider = provider_from(settings)
            common: dict[str, Any] = {
                "prompt": body,
                "target": "claude_code",
                "mode": mode_override,
                "save_history": True,
                "session_id": session_id,
                "workspace_dir": workspace_dir,
            }
            started = time.monotonic()
            try:
                res = rewrite_with_provider(store, provider_override=provider, time_budget_s=hook_budget_s(), **common)
            except Exception:
                res = rewrite_with_provider(store, provider_override="offline_template", **common)
            elapsed = time.monotonic() - started
            mode_used = str(res.get("mode") or mode_override or "balanced")
            provider_used = str(res.get("provider") or provider)
            loaded = (res.get("skill_judgment") or {}).get("load_skills") or []
            skills = skill_labels(loaded, limit=len(loaded) if isinstance(loaded, list) else 0)
            graphify = bool(detect_graphify_context(workspace_dir))
            ctx_body = (
                f"[Re-Prompt · {mode_used}] Below is a structured version of the user's message. "
                "The user's own message stays authoritative; this structure is a reading aid. "
                "Ask if anything is unclear.\n\n"
                f"{cap_injected(res['rewritten_prompt'])}"
            )
            if handoff_note:
                ctx_body = f"{ctx_body}\n\n{handoff_note}"
            where = "locally" if provider_used == "offline_template" else f"with {provider_used}"
            # P2-273: say why a prompt without a prefix was re-prompted (the 30-word rule); raw: skips it.
            if parse_rewrite(prompt_text) is not None:
                trigger = "prefix"
            elif wants_auto_rewrite(prompt_text, over_words):
                trigger = "words"
            else:
                trigger = "all"
            why = f" · {word_count(prompt_text)} words" if trigger == "words" else ""
            note = f"✨ Re-prompted {where} in {elapsed:.1f} s{why} · {mode_used}"
            if skills:
                note += f" · skills: {', '.join(skills[:3])}"
            if graphify:
                note += " · Graphify"
            mark(store, session_id, "reprompt", mode=mode_used, skills=len(skills), graphify=graphify, trigger=trigger)
            emit(ctx_body, note)
            return 0

        # Not rewritten: still auto-judge Load/Unload skills and deliver any shared handoff.
        extra_parts: list[str] = []
        skill_names: list[str] = []
        if (
            bool(settings.get("enableSkillRouting", True))
            and _index_file().is_file()
            and not is_trivial_prompt(prompt_text)
            and not has_skill_directive_block(prompt_text)
        ):
            sess_state = store.get_session(session_id)
            graphify_ctx = detect_graphify_context(workspace_dir)
            judgment, updated_state = judge_skills_for_prompt(
                received_prompt=prompt_text,
                session_state=sess_state,
                workspace_context=graphify_ctx,
                target_provider="claude",
                max_active_skills=2,
            )
            store.save_session(session_id, updated_state)
            # P2-272 (B): outline-first, at most two skills; never a whole SKILL.md.
            directive_md = format_skill_outline_directives(judgment, target_provider="claude")
            loaded = list(judgment.get("load_skills") or [])[:2]
            record_injected_skills(session_id, loaded, host="claude")
            if directive_md:
                extra_parts.append(f"[Re-Prompt Skill Auto-Judge]\n{directive_md}")
                skill_names = [str(s.get("name") if isinstance(s, dict) else s) for s in loaded]

        if handoff_note:
            extra_parts.append(handoff_note)

        mark(store, session_id, "skills" if skill_names else "plain", skills=len(skill_names))
        if extra_parts:
            emit("\n\n".join(extra_parts), f"🧩 Skill hint · {', '.join(skill_names[:3])}" if skill_names else "")
            return 0

        print("{}")
        return 0
    except Exception:
        print("{}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
