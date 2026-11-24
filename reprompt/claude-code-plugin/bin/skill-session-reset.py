#!/usr/bin/env python3
"""P2-272 (B): Claude Code SessionStart hook (matcher "clear|compact").

After /clear or /compact the skills shown earlier are gone from the context, so the per-session "already shown"
state is cleared: the next prompt may show the matching skills' outlines again. It also sets the status line's
"skills N" record to 0. Antigravity has no /clear or /compact event; a new Antigravity conversation simply starts
with an empty state (its state is kept per conversationId).
The Stop switch (~/.wk/KILL): nothing happens, output {}, exit 0. Never prints anything but JSON.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
REPO_CANDIDATE = next(
    (
        root
        for root in (PLUGIN_ROOT, PLUGIN_ROOT.parent, PLUGIN_ROOT / "reprompt", PLUGIN_ROOT.parent / "reprompt")
        if (root / "server" / "reprompt_engine.py").is_file()
    ),
    None,
)
if REPO_CANDIDATE:
    for p in (str(REPO_CANDIDATE), str(REPO_CANDIDATE / "scripts")):
        if p not in sys.path:
            sys.path.insert(0, p)

RESET_SOURCES = {"clear", "compact"}


def _stopped() -> bool:
    wk_home = Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser()
    return (wk_home / "KILL").exists()


def reset_session(session_id: str) -> dict:
    """Clear the shown-skills state of one session in every place that keeps it."""
    from server.reprompt_engine import RePromptStore, default_data_dir
    from skill_router import default_session_state, record_injected_skills

    sid = (session_id or "claude_default").strip() or "claude_default"
    done = []
    store = RePromptStore(default_data_dir())
    store.save_session(sid, default_session_state())
    done.append("store")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", sid)[:96] or "default"
    base = os.environ.get("REPROMPT_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    hs = (Path(base).expanduser() if base else Path.home() / ".gemini" / "skill-vault" / "hook-state") / "hook_sessions"
    f = hs / f"{safe}.json"
    if f.is_file():
        state = default_session_state()
        state["last_prompt_hash"] = ""
        tmp = f.with_name(f".{f.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, f)
        done.append("hook_sessions")
    record_injected_skills(sid, [], host="claude")
    done.append("injected")
    return {"session": sid, "reset": done}


def main() -> int:
    try:
        if _stopped() or os.environ.get("WK_SUBAGENT_ACTIVE") == "1":
            print("{}")
            return 0
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            print("{}")
            return 0
        source = str(payload.get("source") or "").strip().lower()
        if source in RESET_SOURCES:
            reset_session(str(payload.get("session_id") or payload.get("conversationId") or ""))
        print("{}")
        return 0
    except Exception:
        print("{}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
