#!/usr/bin/env python3
"""Atomic flock-guarded state store, runtime config, session tracking & dirty-file queue."""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_RUNTIME_CONFIG: dict[str, Any] = {
    "mode": "auto",  # auto | confirm | reprompt-only | passthrough
    "brain": "adaptive-max",  # adaptive-max | carbon-high | hydrogen-xhigh
    "max_output_tokens": 65536,
    "blast_radius_min_callers": 5,
    "auto_skill_budget": "unrestricted",
    "graphify_default": True,
}

VALID_MODES = frozenset({"auto", "confirm", "reprompt-only", "passthrough"})
VALID_BRAINS = frozenset({"adaptive-max", "carbon-high", "hydrogen-xhigh"})


def watchkeeper_runtime_dir(workspace_dir: str | Path | None = None) -> Path:
    """Resolve runtime directory (WK_RUNTIME_DIR -> WK_HOME/runtime -> .watchkeeper)."""
    env_dir = os.environ.get("WK_RUNTIME_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    wk_home = os.environ.get("WK_HOME")
    if wk_home:
        return (Path(wk_home).expanduser().resolve() / "runtime")
    if workspace_dir:
        ws = Path(workspace_dir).expanduser().resolve()
        if (ws / "core").is_dir() or (ws / ".watchkeeper").is_dir():
            return ws / ".watchkeeper"
    return Path.home() / ".wk" / "runtime"


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _safe_id(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (raw or "default").strip())
    return cleaned[:96] or "default"


@contextmanager
def file_lock(lock_path: Path, timeout_s: float = 10.0) -> Iterator[None]:
    """Acquire an OS advisory flock with stale-PID cleanup and retry backoff."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + max(0.2, timeout_s)
    acquired = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                try:
                    raw = os.pread(fd, 128, 0).decode("utf-8", errors="ignore").strip()
                    if raw.isdigit() and not _pid_alive(int(raw)):
                        os.ftruncate(fd, 0)
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for lock {lock_path}")
                time.sleep(0.02)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode("ascii"))
        yield
    finally:
        if acquired:
            try:
                os.ftruncate(fd, 0)
            except OSError:
                pass
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:6]}.tmp")
    raw_bytes = (json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        view = memoryview(raw_bytes)
        written = 0
        while written < len(raw_bytes):
            written += os.write(fd, view[written:])
        os.fsync(fd)
    except Exception:
        os.close(fd)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    os.close(fd)
    os.replace(tmp, path)


def read_json_safe(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class StateStore:
    """Flock-synchronized Watchkeeper v2.0 runtime state repository."""

    def __init__(self, runtime_dir: str | Path | None = None, workspace_dir: str | Path | None = None) -> None:
        self.root = Path(runtime_dir).expanduser().resolve() if runtime_dir else watchkeeper_runtime_dir(workspace_dir)
        self.locks_dir = self.root / "locks"
        self.sessions_dir = self.root / "sessions"
        self.config_file = self.root / "runtime_config.json"
        self.cache_stats_file = self.root / "prefix_cache_stats.json"
        self.dirty_queue_file = self.root / "dirty_files.queue"

    def load_config(self) -> dict[str, Any]:
        cfg = dict(DEFAULT_RUNTIME_CONFIG)
        raw = read_json_safe(self.config_file, {})
        if isinstance(raw, dict):
            if raw.get("mode") in VALID_MODES:
                cfg["mode"] = raw["mode"]
            if raw.get("brain") in VALID_BRAINS:
                cfg["brain"] = raw["brain"]
            if isinstance(raw.get("blast_radius_min_callers"), int) and raw["blast_radius_min_callers"] >= 1:
                cfg["blast_radius_min_callers"] = raw["blast_radius_min_callers"]
            if isinstance(raw.get("graphify_default"), bool):
                cfg["graphify_default"] = raw["graphify_default"]
        return cfg

    def save_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        with file_lock(self.locks_dir / "config.lock"):
            cfg = self.load_config()
            if "mode" in updates:
                if updates["mode"] not in VALID_MODES:
                    raise ValueError(f"Unsupported mode: {updates['mode']}")
                cfg["mode"] = updates["mode"]
            if "brain" in updates:
                if updates["brain"] not in VALID_BRAINS:
                    raise ValueError(f"Unsupported brain policy: {updates['brain']}")
                cfg["brain"] = updates["brain"]
            if "blast_radius_min_callers" in updates:
                cfg["blast_radius_min_callers"] = max(1, int(updates["blast_radius_min_callers"]))
            if "graphify_default" in updates:
                cfg["graphify_default"] = bool(updates["graphify_default"])
            atomic_write_json(self.config_file, cfg)
            return cfg

    def get_session(self, session_id: str) -> dict[str, Any]:
        path = self.sessions_dir / f"{_safe_id(session_id)}.json"
        data = read_json_safe(path, {})
        if not isinstance(data, dict):
            data = {}
        return {
            "session_id": _safe_id(session_id),
            "subagent_depth": int(data.get("subagent_depth") or 0),
            "standalone_reprompt": data.get("standalone_reprompt") if isinstance(data.get("standalone_reprompt"), dict) else None,
            "last_interaction_id": str(data.get("last_interaction_id") or "") or None,
            "last_spec_hash": str(data.get("last_spec_hash") or ""),
            "last_compiled_criteria": list(data.get("last_compiled_criteria") or []),
            "updated_at": data.get("updated_at"),
        }

    def update_session(self, session_id: str, updater: Any) -> dict[str, Any]:
        sid = _safe_id(session_id)
        path = self.sessions_dir / f"{sid}.json"
        with file_lock(self.locks_dir / f"sess_{sid}.lock"):
            st = self.get_session(sid)
            updater(st)
            st["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            atomic_write_json(path, st)
            return st

    def record_prefix_cache(self, prefix_sha: str, hit: bool) -> dict[str, Any]:
        with file_lock(self.locks_dir / "prefix_cache.lock"):
            st = read_json_safe(self.cache_stats_file, {"hits": 0, "misses": 0, "last_prefix_sha": "", "last_at": None})
            if not isinstance(st, dict):
                st = {"hits": 0, "misses": 0}
            if hit:
                st["hits"] = int(st.get("hits") or 0) + 1
            else:
                st["misses"] = int(st.get("misses") or 0) + 1
            st["last_prefix_sha"] = prefix_sha
            st["last_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            atomic_write_json(self.cache_stats_file, st)
            return st

    def get_cache_stats(self) -> dict[str, Any]:
        st = read_json_safe(self.cache_stats_file, {"hits": 0, "misses": 0, "last_prefix_sha": "", "last_at": None})
        return st if isinstance(st, dict) else {"hits": 0, "misses": 0, "last_prefix_sha": "", "last_at": None}

    def push_dirty_files(self, paths: list[str]) -> list[str]:
        clean = [str(p).strip() for p in paths if str(p).strip()]
        if not clean:
            return []
        with file_lock(self.locks_dir / "dirty_queue.lock"):
            cur = read_json_safe(self.dirty_queue_file, [])
            if not isinstance(cur, list):
                cur = []
            seen = set(cur)
            for item in clean:
                if item not in seen:
                    seen.add(item)
                    cur.append(item)
            atomic_write_json(self.dirty_queue_file, cur[-500:])
            return cur

    def drain_dirty_files(self) -> list[str]:
        with file_lock(self.locks_dir / "dirty_queue.lock"):
            cur = read_json_safe(self.dirty_queue_file, [])
            items = [str(x) for x in cur if str(x).strip()] if isinstance(cur, list) else []
            atomic_write_json(self.dirty_queue_file, [])
            return items
