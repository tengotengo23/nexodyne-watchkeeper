#!/usr/bin/env python3
"""Antigravity graph hooks (P2-272): SessionStart, PreInvocation, PostToolUse, Stop; plus the detached worker.

Every path prints neutral output and exits 0 when the Stop switch (~/.wk/KILL) is on or anything fails.
Builds never run on the PreInvocation path: SessionStart and Stop start one detached worker (lock) and return.
Quiet by default (P2-273, the owner: "quiet AST Graphify"): the AST graph updates silently in the background; adding
graph context to every turn is opt-in ("graphTurnContext": true in the shared Re-Prompt settings.json). Without it
PreInvocation adds nothing; the agent still reads the graph on demand (graphify skill, graphify-out/).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PRE_BUDGET_S = 0.05
WRITE_TOOLS = {"write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "edit_file",
               "Write", "Edit", "MultiEdit", "NotebookEdit"}


def _home() -> Path:
    env = (os.environ.get("WK_HOME") or "").strip()
    return Path(env).expanduser().resolve() if env else (Path.home() / ".wk").resolve()


def _killed() -> bool:
    return (_home() / "KILL").exists()


def _workspace(payload: dict[str, Any]) -> str:
    wl = payload.get("workspacePaths")
    return str(payload.get("cwd") or (wl[0] if isinstance(wl, list) and wl else "") or os.getcwd())


def _state_dir(ws: str) -> Path:
    h = hashlib.sha1(str(Path(ws).resolve()).encode()).hexdigest()[:12]
    d = _home() / "graph-hook" / h
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_payload() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _spawn_worker(ws: str, mode: str) -> bool:
    """Start the detached worker through the process registry. Returns at once."""
    try:
        from core.watchdog import register_process
        import subprocess  # here only: the prompt path never starts a process (saves about 4 ms per prompt)
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "worker", ws, mode],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, cwd=ws if Path(ws).is_dir() else None,
        )
        try:
            register_process(proc.pid, pgid=proc.pid, kind="graph", label=f"graph {mode}", cwd=ws, max_wall_ms=300000)
        except Exception:
            pass
        return True
    except Exception:
        return False


def _changed_file(state: Path) -> Path:
    return state / "changed.json"


def _load_changed(state: Path) -> list[str]:
    try:
        v = json.loads(_changed_file(state).read_text(encoding="utf-8"))
        return [str(x) for x in v.get("files", [])] if isinstance(v, dict) else []
    except Exception:
        return []


def on_session_start(payload: dict[str, Any]) -> dict[str, Any]:
    if _killed():
        return {}
    ws = _workspace(payload)
    if not Path(ws).is_dir():
        return {}
    gf = Path(ws) / "graphify-out" / "graph.json"
    _spawn_worker(ws, "update" if gf.is_file() else "build")
    return {}


def _turn_context_on() -> bool:
    """True only when the owner opted in: "graphTurnContext": true in the shared settings.json (REPROMPT_DATA_DIR,
    PLUGIN_DATA, else ~/.gemini/antigravity/plugin_data/watchkeeper). Anything unreadable means off."""
    base = os.environ.get("REPROMPT_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    folder = Path(base).expanduser() if base else Path.home() / ".gemini" / "antigravity" / "plugin_data" / "watchkeeper"
    try:
        data = json.loads((folder / "settings.json").read_text(encoding="utf-8"))
    except Exception:
        return False
    return isinstance(data, dict) and data.get("graphTurnContext") is True


def on_pre_invocation(payload: dict[str, Any]) -> dict[str, Any]:
    if _killed():
        return {}
    if not _turn_context_on():
        return {}
    t0 = time.monotonic()
    try:
        from core.graph_ego import ego_context
        ws = _workspace(payload)
        prompt = str(payload.get("lastUserInput") or "")
        text = ego_context(ws, prompt, budget_s=PRE_BUDGET_S, dirty=_load_changed(_state_dir(ws)))
    except Exception:
        return {}
    if not text or time.monotonic() - t0 > PRE_BUDGET_S * 4:
        return {}
    return {"injectSteps": [{"systemMessage": {"systemMessage": text, "metadata": {"user_markdown": ""}}}]}


def on_post_tool_use(payload: dict[str, Any]) -> dict[str, Any]:
    if _killed():
        return {}
    try:
        tc = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
        name = str(tc.get("name") or payload.get("tool_name") or "")
        if name not in WRITE_TOOLS:
            return {}
        args = tc.get("args") if isinstance(tc.get("args"), dict) else (
            payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {})
        target = str(args.get("TargetFile") or args.get("target_file") or args.get("file_path")
                     or args.get("path") or args.get("Path") or "").strip()
        if not target:
            return {}
        ws = _workspace(payload)
        try:
            rel = str(Path(target).resolve().relative_to(Path(ws).resolve()))
        except Exception:
            return {}
        state = _state_dir(ws)
        files = _load_changed(state)
        if rel not in files:
            files.append(rel)
        tmp = _changed_file(state).with_suffix(".tmp")
        tmp.write_text(json.dumps({"files": files[-200:], "updated_at": time.time()}), encoding="utf-8")
        os.replace(tmp, _changed_file(state))
    except Exception:
        pass
    return {}


def on_stop(payload: dict[str, Any]) -> dict[str, Any]:
    if _killed():
        return {}
    try:
        ws = _workspace(payload)
        if Path(ws).is_dir() and _load_changed(_state_dir(ws)):
            _spawn_worker(ws, "update")
    except Exception:
        pass
    return {}


def run_worker(ws: str, mode: str) -> int:
    """Detached: one build at a time (non-blocking lock), AST only, KILL respected."""
    import fcntl
    from core.watchdog import unregister_process
    try:
        if _killed():
            return 0
        state = _state_dir(ws)
        fd = os.open(str(state / "build.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # another build runs
        try:
            from core.graph_bridge import sync_and_load_graph
            changed = _load_changed(state)
            sync_and_load_graph(ws, bootstrap=True, force=(mode == "build" or not changed),
                                dirty_paths=changed or None, cli_timeout=240.0)
            if changed:
                try:
                    _changed_file(state).unlink()
                except OSError:
                    pass
        finally:
            os.close(fd)
    except Exception:
        return 0
    finally:
        try:
            unregister_process(os.getpid())
        except Exception:
            pass
    return 0


def main(argv: list[str]) -> int:
    event = argv[1] if len(argv) > 1 else ""
    if event == "worker":
        return run_worker(argv[2], argv[3] if len(argv) > 3 else "update")
    handlers = {"SessionStart": on_session_start, "PreInvocation": on_pre_invocation,
                "PostToolUse": on_post_tool_use, "Stop": on_stop}
    h = handlers.get(event)
    out: dict[str, Any] = {}
    if h:
        try:
            out = h(_read_payload())
        except Exception:
            out = {}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
