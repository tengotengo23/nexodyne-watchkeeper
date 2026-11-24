#!/usr/bin/env python3
"""Antigravity PreInvocation hook for dynamic Load/Keep/Unload skill directives."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent
for p in (str(PLUGIN_ROOT), str(SCRIPT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from server.reprompt_engine import (  # noqa: E402
    RePromptStore,
    default_data_dir,
    detect_graphify_context,
    parse_raw_bypass,
)
from prompt_prefix import auto_over_words  # noqa: E402
from reprompt_inline_hook import is_wk_kill_active_for_payload, parse_inline_trigger  # noqa: E402
from skill_router import (  # noqa: E402
    default_session_state,
    extract_existing_skill_paths,
    format_skill_directives,  # noqa: F401
    format_skill_outline_directives,
    has_skill_directive_block,
    judge_skills_for_prompt,
    record_injected_skills,
    regate_session_skills,
    score_complexity,
    LEVEL_RANK,
)
from skill_vault import _index_file  # noqa: E402


def _state_dir() -> Path:
    base = os.environ.get("REPROMPT_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    if base:
        return Path(base).expanduser() / "hook_sessions"
    return Path.home() / ".gemini" / "skill-vault" / "hook-state" / "hook_sessions"


def _safe_conv_id(conv_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (conv_id or "default").strip())
    return cleaned[:96] or "default"


def _load_state(path: Path) -> dict[str, Any]:
    state = default_session_state()
    state["last_prompt_hash"] = ""
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                state.update(raw)
        except Exception:
            pass
    return state


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    try:
        if os.environ.get("REPROMPT_INTERNAL_CALL") == "1" or os.environ.get("WK_SUBAGENT_ACTIVE") == "1":
            print("{}")
            return 0

        raw_stdin = sys.stdin.read()
        if not raw_stdin.strip():
            print("{}")
            return 0

        payload = json.loads(raw_stdin)
        if not isinstance(payload, dict):
            print("{}")
            return 0

        if is_wk_kill_active_for_payload(payload):
            print("{}")
            return 0

        user_input = str(payload.get("lastUserInput") or "").strip()
        if not user_input or user_input.startswith("SYSTEM OVERRIDE: You are Re-Prompt"):
            print("{}")
            return 0

        store = RePromptStore(default_data_dir())
        settings = store.load_settings()
        if not bool(settings.get("enableSkillRouting", True)):
            print("{}")
            return 0

        # Yield to reprompt_inline_hook when inline rewrite or raw bypass handles this turn
        auto_all = bool(settings.get("hookAutoAll", False))
        over_words = auto_over_words(settings.get("autoRewriteOverWords"))
        if (
            parse_raw_bypass(user_input) is not None
            or parse_inline_trigger(user_input, auto_all=auto_all, over_words=over_words) is not None
        ):
            print("{}")
            return 0

        if not _index_file().is_file():
            print("{}")
            return 0

        conv_id = _safe_conv_id(str(payload.get("conversationId") or "default"))
        state_path = _state_dir() / f"{conv_id}.json"
        state = _load_state(state_path)
        try:
            persisted = store.get_session(conv_id)
            if isinstance(persisted, dict):
                seen_ids = {x.get("id") for x in (state.get("loaded_skills") or []) if isinstance(x, dict)}
                for item in persisted.get("loaded_skills") or []:
                    if isinstance(item, dict) and item.get("id") and item["id"] not in seen_ids:
                        state.setdefault("loaded_skills", []).append(item)
                        seen_ids.add(item["id"])
                doms = state.setdefault("loaded_domains", [])
                for d in persisted.get("loaded_domains") or []:
                    if d and d not in doms:
                        doms.append(d)
        except Exception:
            pass
        # A source rejected since these skills loaded takes its skills out of the session too (P2-272 B-fix).
        regate_session_skills(state)

        prompt_hash = hashlib.sha256(user_input.encode("utf-8", errors="replace")).hexdigest()
        if prompt_hash == state.get("last_prompt_hash"):
            print("{}")
            return 0

        # Avoid duplicating skills already embedded by Re-Prompt / Orchestrator
        if (
            has_skill_directive_block(user_input)
            or "/skill-vault/repos/" in user_input
        ):
            existing = extract_existing_skill_paths(user_input)
            loaded = state.setdefault("loaded_skills", [])
            loaded_doms = state.setdefault("loaded_domains", [])
            for item in existing:
                if all(x.get("id") != item["id"] for x in loaded):
                    loaded.append(item)
                if item["domain"] not in loaded_doms:
                    loaded_doms.append(item["domain"])
            comp = score_complexity(user_input)
            for d in comp["domains"]:
                if d not in loaded_doms:
                    loaded_doms.append(d)
            state["turn_count"] = max(1, int(state.get("turn_count", 0)) + 1)
            state["peak_complexity_score"] = max(float(state.get("peak_complexity_score", 0.0)), comp["score"])
            prev_lvl = str(state.get("peak_complexity_level", "low"))
            if LEVEL_RANK.get(comp["level"], 0) > LEVEL_RANK.get(prev_lvl, 0):
                state["peak_complexity_level"] = comp["level"]
            state["last_prompt_hash"] = prompt_hash
            _save_state(state_path, state)
            print("{}")
            return 0

        ws_list = payload.get("workspacePaths")
        workspace_dir = str(payload.get("cwd") or (ws_list[0] if isinstance(ws_list, list) and ws_list else "") or "")
        graphify_ctx = detect_graphify_context(workspace_dir)

        judgment, updated = judge_skills_for_prompt(
            received_prompt=user_input,
            session_state=state,
            workspace_context=graphify_ctx,
            target_provider="gemini",
            max_active_skills=2,
        )
        updated["last_prompt_hash"] = prompt_hash
        _save_state(state_path, updated)

        load_skills = list(judgment.get("load_skills") or [])[:2]
        unload_skills = judgment.get("unload_skills") or []
        # P2-272 (B): the status line's "skills N" reads this record.
        record_injected_skills(conv_id, load_skills, host="antigravity")
        if not load_skills and not unload_skills:
            print("{}")
            return 0

        # P2-272 (B): outline-first, at most two skills; never a whole SKILL.md.
        directive_md = format_skill_outline_directives(judgment, target_provider="gemini")
        parts: list[str] = []
        if load_skills:
            parts.append("Loaded: " + ", ".join(s["name"] for s in load_skills))
        if unload_skills:
            parts.append("Unloaded: " + ", ".join(u["name"] for u in unload_skills))
        user_summary = "⚡ Skills auto-updated — " + " · ".join(parts)

        print(
            json.dumps(
                {
                    "injectSteps": [
                        {
                            "systemMessage": {
                                "systemMessage": f"[Re-Prompt Skill Auto-Judge]\n{directive_md}",
                                "metadata": {"user_markdown": user_summary},
                            }
                        }
                    ]
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception:
        print("{}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
