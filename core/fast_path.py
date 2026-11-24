#!/usr/bin/env python3
"""Sub-5ms zero-token fast-path filter, loop immunity & mode classifier."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

SPEC_SENTINEL = "[WK-SPEC-V2:"


def _load_prompt_prefix():
    """P2-272: the one prefix grammar lives in reprompt/scripts/prompt_prefix.py (spec section 3.5).

    Loaded by file path so core never puts reprompt/scripts (with its own skill_router.py) on sys.path.
    """
    import sys

    mod = sys.modules.get("prompt_prefix")
    if mod is not None:
        return mod
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "reprompt" / "scripts" / "prompt_prefix.py"
    spec = importlib.util.spec_from_file_location("prompt_prefix", str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"prompt_prefix not found at {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prompt_prefix"] = mod
    spec.loader.exec_module(mod)
    return mod


_pp = _load_prompt_prefix()
# Rewrite prefix: groups 1 (`rp:` style) or 2 (`:rp ` style), body in group 3.
INLINE_PREFIX_RE = _pp.REWRITE_PREFIX_RE
# Raw bypass: `raw:`, `rp-raw:`, `/wk raw:`, `:raw `; body in group 3.
RAW_BYPASS_RE = _pp.RAW_PREFIX_RE
PREFIX_MODE_MAP: dict[str, str | None] = dict(_pp.PREFIX_MODE_MAP)
AUTO_FLOOR_CHARS: int = _pp.AUTO_FLOOR_CHARS
parse_raw = _pp.parse_raw
parse_rewrite = _pp.parse_rewrite
is_machine_turn = _pp.is_machine_turn
is_loop_text = _pp.is_loop_text
STANDALONE_SLASH_RE = re.compile(r"^\s*/(?:re-?prompt)(?:\s+([\s\S]+))?$", re.IGNORECASE)

TRIVIAL_CONFIRM_RE = re.compile(
    r"^(?:y|yes|yep|yeah|ok|okay|continue|proceed|go\s+ahead|ship\s+it|abort|no|nope|n|done|cancel|retry|skip|\d{1,2})\.?$",
    re.IGNORECASE,
)

READONLY_CMD_RE = re.compile(
    r"^(?:ls|pwd|git\s+(?:status|diff|log|branch|show|remote)|which|echo|cat\s+\S+)\b[^\n;|&`]*$",
    re.IGNORECASE,
)

SYSTEM_BYPASS_PREFIXES = (
    "/wk",
    "/wk-status",
    "/wk-tasks",
    "/wk-heal",
    "/doctor",
    "/clear",
    "/compact",
    "/reload-skills",
    "/help",
    "/cost",
    "/status",
    "/exit",
)

@dataclass(frozen=True)
class FastPathDecision:
    bypass: bool
    reason: str
    mode: str  # bypass | inline | standalone_reprompt
    prompt_body: str
    style_override: str | None = None
    confirm_required: bool = False


def evaluate_fast_path(
    prompt: str,
    *,
    env: dict[str, str] | None = None,
    session_state: dict[str, Any] | None = None,
    runtime_config: dict[str, Any] | None = None,
) -> FastPathDecision:
    """Classify turn in <5ms with zero network or LLM calls."""
    env_map = env if env is not None else os.environ
    sess = session_state or {}
    cfg = runtime_config or {}
    text = (prompt or "").strip()

    if not text:
        return FastPathDecision(True, "empty_prompt", "bypass", "")

    if SPEC_SENTINEL in text or ("## Goal" in text and "## Verification" in text):
        return FastPathDecision(True, "already_compiled_spec", "bypass", text)

    if text.startswith("SYSTEM OVERRIDE: You are Re-Prompt"):
        return FastPathDecision(True, "internal_override_sentinel", "bypass", text)

    if env_map.get("REPROMPT_INTERNAL_CALL") == "1":
        return FastPathDecision(True, "internal_call_env", "bypass", text)

    if env_map.get("WK_SUBAGENT_ACTIVE") == "1" or int(sess.get("subagent_depth") or 0) > 0:
        return FastPathDecision(True, "subagent_loop_guard", "bypass", text)

    if is_machine_turn(text):
        return FastPathDecision(True, "machine_turn", "bypass", text)

    if is_loop_text(text):
        return FastPathDecision(True, "loop_guard_rewritten", "bypass", text)

    raw_body = parse_raw(text)
    if raw_body is not None:
        return FastPathDecision(True, "explicit_raw_bypass", "bypass", raw_body)

    cfg_mode = str(cfg.get("mode") or "auto").lower()
    if cfg_mode == "passthrough":
        return FastPathDecision(True, "mode_passthrough", "bypass", text)

    # Check standalone /reprompt BEFORE generic slash command bypass
    standalone_m = STANDALONE_SLASH_RE.match(text)
    if standalone_m:
        draft = (standalone_m.group(1) or "").strip()
        if not draft:
            return FastPathDecision(True, "slash_reprompt_empty", "bypass", text)
        return FastPathDecision(False, "standalone_reprompt_command", "standalone_reprompt", draft)

    lower = text.lower()
    for sp in SYSTEM_BYPASS_PREFIXES:
        if lower == sp or lower.startswith(sp + " ") or lower.startswith(sp + ":"):
            return FastPathDecision(True, f"system_command:{sp}", "bypass", text)

    if text.startswith("/") and not INLINE_PREFIX_RE.match(text):
        return FastPathDecision(True, "slash_command_passthrough", "bypass", text)

    if TRIVIAL_CONFIRM_RE.match(text):
        return FastPathDecision(True, "trivial_confirmation", "bypass", text)

    if "\n" not in text and READONLY_CMD_RE.match(text):
        return FastPathDecision(True, "readonly_inspection_cmd", "bypass", text)

    if cfg_mode == "reprompt-only":
        return FastPathDecision(False, "mode_reprompt_only", "standalone_reprompt", text)

    parsed = parse_rewrite(text)
    if parsed is not None:
        pref, body, style = parsed
        return FastPathDecision(
            False,
            f"inline_prefix:{pref}",
            "inline",
            body,
            style_override=style,
            confirm_required=(cfg_mode == "confirm"),
        )

    if cfg_mode in ("auto", "confirm") and len(text) >= AUTO_FLOOR_CHARS:
        return FastPathDecision(
            False,
            f"inline_{cfg_mode}",
            "inline",
            text,
            confirm_required=(cfg_mode == "confirm"),
        )

    return FastPathDecision(True, "short_or_untriggered", "bypass", text)
