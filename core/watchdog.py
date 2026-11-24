#!/usr/bin/env python3
"""Dynamic multi-signal hanging-task watchdog and auto-recovery engine for Watchkeeper."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.sanitizer import sanitize_text  # noqa: E402
from core.state_store import atomic_write_json, file_lock, read_json_safe  # noqa: E402

JOB_ID_RE = re.compile(r"^J-\d{8}-\d{4}-[0-9a-f]{4}$")
TASK_ID_RE = re.compile(r"^\d{8}-\d{6}-[a-z0-9-]{1,40}$")
ACTIVE_CPU_THRESHOLD = 5.0

DEFAULT_JOB_STALL_MS = 15 * 60 * 1000
DEFAULT_TASK_STALE_MS = 45 * 60 * 1000
DEFAULT_CHAT_STALL_MS = 10 * 60 * 1000
DEFAULT_PROC_STALL_MS = 5 * 60 * 1000


def resolve_wk_home(wk_home: str | Path | None = None) -> Path:
    """Resolve Watchkeeper home directory (~/.wk or WK_HOME)."""
    if wk_home:
        return Path(wk_home).expanduser().resolve()
    env_home = (os.environ.get("WK_HOME") or "").strip()
    if env_home:
        return Path(env_home).expanduser().resolve()
    return (Path.home() / ".wk").expanduser().resolve()


def resolve_watchdog_dir(wk_home: str | Path | None = None) -> Path:
    """Return Watchkeeper watchdog state directory."""
    return resolve_wk_home(wk_home) / "watchdog"


def _task_held(tdir: Path, now_ms: int) -> bool:
    """P2-277: True when ~/.wk/tasks/<id>/hold exists and has not run out (no "until" = until released)."""
    data = read_json_safe(tdir / "hold", None)
    if not isinstance(data, dict):
        return False
    until = data.get("until")
    if not until:
        return True
    try:
        end = dt.datetime.fromisoformat(str(until).replace("Z", "+00:00")).timestamp() * 1000
    except (TypeError, ValueError):
        return True
    return end > now_ms


def _bridge_crossing(home: Path, tid: str, frm: str, to: str, event: str, title: str, now_ms: int) -> None:
    """P2-277: one line in ~/.wk/bridge/crossings.jsonl (the same shape bin/wk-bridge.mjs writes); never raises."""
    try:
        bdir = home / "bridge"
        bdir.mkdir(mode=0o700, parents=True, exist_ok=True)
        f = bdir / "crossings.jsonl"
        clean = lambda v: re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", str(v or ""))).strip()
        line = json.dumps({"at": _iso_utc(now_ms), "kind": "task", "id": clean(tid), "from": clean(frm), "to": clean(to),
                           "event": clean(event), "title": clean(title)[:120]}, ensure_ascii=False) + "\n"
        fd = os.open(str(f), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
        lines = f.read_text(encoding="utf-8").splitlines()
        if len(lines) > 2000:
            tmp = bdir / f"crossings.jsonl.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
            tfd = os.open(str(tmp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)   # private from the first byte
            with os.fdopen(tfd, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines[-2000:]) + "\n")
            os.replace(tmp, f)
        inbox = bdir / "inbox"
        inbox.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(str(inbox / f"{now_ms}-{os.getpid()}-{uuid.uuid4().hex[:6]}"), os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
    except OSError:
        pass


def is_kill_switch_active(wk_home: str | Path | None = None) -> bool:
    """Return True if KILL switch file is present in Watchkeeper home."""
    return (resolve_wk_home(wk_home) / "KILL").exists()


def _env_int(name: str, default: int, *, minimum: int = 50) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return max(minimum, val)
    except ValueError:
        return default


def _now_ms(now_ms: int | float | None = None) -> int:
    return int(now_ms) if now_ms is not None else int(time.time() * 1000)


def _iso_utc(ms: int | None = None) -> str:
    sec = (_now_ms(ms)) / 1000.0
    return dt.datetime.fromtimestamp(sec, tz=dt.timezone.utc).isoformat()


def _parse_ts_ms(val: Any) -> int | None:
    if isinstance(val, (int, float)) and val > 0:
        return int(val * 1000) if val < 1e11 else int(val)
    if isinstance(val, str) and val.strip():
        s = val.strip()
        try:
            num = float(s)
            if num > 0:
                return int(num * 1000) if num < 1e11 else int(num)
        except ValueError:
            pass
        try:
            iso = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
            if iso.tzinfo is None:
                iso = iso.replace(tzinfo=dt.timezone.utc)
            return int(iso.timestamp() * 1000)
        except Exception:
            return None
    return None


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def _pid_alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _parse_ps_etime_ms(raw: str) -> int | None:
    s = (raw or "").strip()
    if not s:
        return None
    days = 0
    if "-" in s:
        d_part, s = s.split("-", 1)
        try:
            days = int(d_part)
        except ValueError:
            return None
    parts = s.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        secs = nums[0] * 60 + nums[1]
    elif len(nums) == 3:
        secs = nums[0] * 3600 + nums[1] * 60 + nums[2]
    else:
        return None
    return (days * 86400 + secs) * 1000


def inspect_process_tree(root_pid: int | None, pgid: int | None = None) -> dict[str, Any]:
    """Inspect a Watchkeeper-owned process and its descendants/process group via ps."""
    alive = _pid_alive(root_pid)
    has_pgid = isinstance(pgid, int) and pgid > 1
    if not alive and not has_pgid:
        return {
            "alive": False,
            "pids": [],
            "total_cpu": 0.0,
            "states": [],
            "zombie": False,
            "stopped": False,
            "elapsed_ms": None,
            "commands": [],
        }

    try:
        proc = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,pgid=,pcpu=,etime=,state=,command="],
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
    except Exception:
        return {
            "alive": alive,
            "pids": [root_pid] if alive and root_pid else [],
            "total_cpu": 0.0,
            "states": [],
            "zombie": False,
            "stopped": False,
            "elapsed_ms": None,
            "commands": [],
        }

    if proc.returncode != 0 or not proc.stdout:
        return {
            "alive": alive,
            "pids": [root_pid] if alive and root_pid else [],
            "total_cpu": 0.0,
            "states": [],
            "zombie": False,
            "stopped": False,
            "elapsed_ms": None,
            "commands": [],
        }

    rows: list[dict[str, Any]] = []
    by_ppid: dict[int, list[int]] = {}
    by_pid: dict[int, dict[str, Any]] = {}
    for line in proc.stdout.splitlines():
        parts = line.strip().split(None, 6)
        if len(parts) < 6:
            continue
        try:
            pid_v = int(parts[0])
            ppid_v = int(parts[1])
            pgid_v = int(parts[2])
            cpu_v = float(parts[3].replace(",", "."))
        except ValueError:
            continue
        etime_v = parts[4]
        state_v = parts[5]
        cmd_v = parts[6] if len(parts) > 6 else ""
        row = {
            "pid": pid_v,
            "ppid": ppid_v,
            "pgid": pgid_v,
            "cpu": cpu_v,
            "etime_ms": _parse_ps_etime_ms(etime_v),
            "state": state_v,
            "command": cmd_v[:160],
        }
        rows.append(row)
        by_pid[pid_v] = row
        by_ppid.setdefault(ppid_v, []).append(pid_v)

    tree_pids: set[int] = set()
    queue: list[int] = []
    if isinstance(root_pid, int) and root_pid in by_pid:
        queue.append(root_pid)
    if has_pgid:
        for r in rows:
            if r["pgid"] == pgid and r["pid"] > 1:
                queue.append(r["pid"])

    while queue:
        cur = queue.pop()
        if cur in tree_pids or cur <= 1:
            continue
        tree_pids.add(cur)
        for child_pid in by_ppid.get(cur, []):
            if child_pid not in tree_pids:
                queue.append(child_pid)

    if not tree_pids:
        return {
            "alive": alive,
            "pids": [root_pid] if alive and root_pid else [],
            "total_cpu": 0.0,
            "states": [],
            "zombie": False,
            "stopped": False,
            "elapsed_ms": None,
            "commands": [],
        }

    total_cpu = 0.0
    states: list[str] = []
    commands: list[str] = []
    elapsed_vals: list[int] = []
    live_non_zombie = False
    has_zombie = False
    has_stopped = False

    for p_id in sorted(tree_pids):
        r = by_pid.get(p_id)
        if not r:
            continue
        st = str(r["state"] or "")
        states.append(st)
        total_cpu += float(r["cpu"] or 0.0)
        if r["etime_ms"] is not None:
            elapsed_vals.append(int(r["etime_ms"]))
        if r["command"]:
            commands.append(r["command"])
        if st.startswith("Z"):
            has_zombie = True
        elif st.startswith("T"):
            has_stopped = True
        else:
            live_non_zombie = True

    root_row = by_pid.get(root_pid) if isinstance(root_pid, int) else None
    root_is_zombie = bool(root_row and str(root_row["state"] or "").startswith("Z"))
    root_is_stopped = bool(root_row and str(root_row["state"] or "").startswith("T"))
    effective_alive = live_non_zombie or (alive and not root_is_zombie)

    return {
        "alive": effective_alive,
        "pids": sorted(tree_pids),
        "total_cpu": round(total_cpu, 2),
        "states": states[:20],
        "zombie": root_is_zombie or (has_zombie and not live_non_zombie),
        "stopped": root_is_stopped or (has_stopped and not live_non_zombie),
        "elapsed_ms": max(elapsed_vals) if elapsed_vals else None,
        "commands": commands[:10],
    }


def kill_process_group(pid: int | None, pgid: int | None = None, *, grace_ms: int = 1500) -> dict[str, Any]:
    """Terminate a Watchkeeper-owned process/process-group with SIGTERM then SIGKILL."""
    self_pid = os.getpid()
    self_pgid = os.getpgrp() if hasattr(os, "getpgrp") else -1
    tree = inspect_process_tree(pid, pgid)
    targets = [p for p in tree["pids"] if p > 1 and p != self_pid]
    if isinstance(pid, int) and pid > 1 and pid != self_pid and pid not in targets:
        targets.append(pid)

    safe_pgid = pgid if isinstance(pgid, int) and pgid > 1 and pgid != self_pgid and pgid != self_pid else None
    if safe_pgid is None and isinstance(pid, int) and pid > 1 and pid != self_pid and pid != self_pgid:
        try:
            actual_pgid = os.getpgid(pid)
            if actual_pgid > 1 and actual_pgid != self_pgid:
                safe_pgid = actual_pgid
        except OSError:
            pass

    if not targets and safe_pgid is None:
        return {"ok": True, "killed_pids": [], "signal_used": "none"}

    def _send(sig: int) -> None:
        if safe_pgid is not None and os.name == "posix":
            try:
                os.killpg(safe_pgid, sig)
            except OSError:
                pass
        for t in targets:
            try:
                os.kill(t, sig)
            except OSError:
                pass

    _send(signal.SIGTERM)
    sig_used = "SIGTERM"
    deadline = time.monotonic() + max(0.05, grace_ms / 1000.0)
    while time.monotonic() < deadline:
        if not any(_pid_alive(t) for t in targets):
            break
        time.sleep(0.05)

    still_up = [t for t in targets if _pid_alive(t)]
    if still_up:
        _send(signal.SIGKILL)
        sig_used = "SIGKILL"
        time.sleep(0.05)

    return {"ok": True, "killed_pids": targets, "pgid": safe_pgid, "signal_used": sig_used}


def _processes_file(home: Path) -> Path:
    return home / "watchdog" / "processes.json"


def _processes_lock(home: Path) -> Path:
    return home / "watchdog" / "processes.lock"


def _summary_file(home: Path) -> Path:
    return home / "watchdog" / "summary.json"


def register_process(
    pid: int,
    *,
    pgid: int | None = None,
    kind: str = "task",
    label: str = "",
    cwd: str = "",
    stall_ms: int | None = None,
    max_wall_ms: int | None = None,
    task_id: str = "",
    wk_home: str | Path | None = None,
) -> dict[str, Any]:
    """Register a running Watchkeeper subprocess in the dynamic watchdog registry."""
    if not isinstance(pid, int) or pid <= 1:
        return {"ok": False, "error": "Invalid pid"}
    home = resolve_wk_home(wk_home)
    _ensure_private_dir(home / "watchdog")
    now = _now_ms()
    eff_pgid = pgid
    if eff_pgid is None and os.name == "posix":
        try:
            eff_pgid = os.getpgid(pid)
        except OSError:
            eff_pgid = None

    entry = {
        "pid": pid,
        "pgid": eff_pgid if isinstance(eff_pgid, int) and eff_pgid > 1 else None,
        "kind": str(kind or "task")[:40],
        "label": str(label or "")[:160],
        "cwd": str(cwd or "")[:300],
        "task_id": str(task_id or "")[:100],
        "stall_ms": max(50, int(stall_ms or _env_int("WK_PROC_STALL_MS", DEFAULT_PROC_STALL_MS))),
        "max_wall_ms": max(100, int(max_wall_ms or 30 * 60 * 1000)),
        "started_at": now,
        "last_heartbeat_at": now,
        "detail": "started",
    }

    with file_lock(_processes_lock(home)):
        raw = read_json_safe(_processes_file(home), {"version": 1, "processes": {}})
        procs = raw.get("processes") if isinstance(raw, dict) and isinstance(raw.get("processes"), dict) else {}
        procs[str(pid)] = entry
        atomic_write_json(_processes_file(home), {"version": 1, "processes": procs})
    return {"ok": True, "entry": entry}


def heartbeat_process(pid: int, *, detail: str = "", wk_home: str | Path | None = None) -> dict[str, Any]:
    """Update heartbeat timestamp for a registered Watchkeeper process."""
    home = resolve_wk_home(wk_home)
    pf = _processes_file(home)
    if not pf.is_file():
        return {"ok": False, "found": False}
    now = _now_ms()
    with file_lock(_processes_lock(home)):
        raw = read_json_safe(pf, {"version": 1, "processes": {}})
        procs = raw.get("processes") if isinstance(raw, dict) and isinstance(raw.get("processes"), dict) else {}
        entry = procs.get(str(pid))
        if not isinstance(entry, dict):
            return {"ok": False, "found": False}
        entry["last_heartbeat_at"] = now
        if detail:
            entry["detail"] = str(detail)[:200]
        procs[str(pid)] = entry
        atomic_write_json(pf, {"version": 1, "processes": procs})
    return {"ok": True, "found": True, "last_heartbeat_at": now}


def unregister_process(pid: int, *, wk_home: str | Path | None = None) -> dict[str, Any]:
    """Remove a completed/terminated process from the dynamic watchdog registry."""
    home = resolve_wk_home(wk_home)
    pf = _processes_file(home)
    if not pf.is_file():
        return {"ok": True, "removed": False}
    removed = False
    with file_lock(_processes_lock(home)):
        raw = read_json_safe(pf, {"version": 1, "processes": {}})
        procs = raw.get("processes") if isinstance(raw, dict) and isinstance(raw.get("processes"), dict) else {}
        if str(pid) in procs:
            procs.pop(str(pid), None)
            removed = True
            atomic_write_json(pf, {"version": 1, "processes": procs})
    return {"ok": True, "removed": removed}


def run_in_group(
    cmd: list[str],
    *,
    timeout: float,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    input: str | None = None,
    kind: str = "child",
    label: str = "",
    grace_ms: int = 1500,
    sweep_group: bool = False,
    register: bool = True,
    wk_home: str | Path | None = None,
) -> subprocess.CompletedProcess:
    """Run ``cmd`` in its own session and process group (P2-272).

    On timeout (or any interruption) the whole group gets SIGTERM, then SIGKILL after
    ``grace_ms``, and ``subprocess.TimeoutExpired`` is raised, so a tool that starts a
    worker pool (graphify, agy, claude) never leaves PPID-1 orphans behind.
    ``sweep_group=True`` also ends group members that outlive a normal exit.
    The child is listed in the watchdog registry while it runs (best effort).
    """
    posix = os.name == "posix"
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=posix,
    )
    registered = False
    if register:
        try:
            registered = bool(
                register_process(
                    proc.pid,
                    pgid=proc.pid if posix else None,
                    kind=kind,
                    label=label or " ".join(str(c) for c in cmd[:2]),
                    cwd=cwd or "",
                    max_wall_ms=int(timeout * 1000) + grace_ms,
                    wk_home=wk_home,
                ).get("ok")
            )
        except Exception:
            registered = False
    try:
        try:
            out, err = proc.communicate(input=input, timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_process_group(proc.pid, proc.pid if posix else None, grace_ms=grace_ms)
            try:
                out, err = proc.communicate(timeout=max(1.0, grace_ms / 1000.0))
            except Exception:
                out, err = "", ""
            raise subprocess.TimeoutExpired(cmd, timeout, output=out, stderr=err) from None
        except BaseException:
            kill_process_group(proc.pid, proc.pid if posix else None, grace_ms=grace_ms)
            raise
        if sweep_group and posix:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass
        return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
    finally:
        if registered:
            try:
                unregister_process(proc.pid, wk_home=wk_home)
            except Exception:
                pass


def _classify_process_signal(
    *,
    alive: bool,
    zombie: bool,
    stopped: bool,
    total_cpu: float,
    idle_ms: int,
    elapsed_ms: int,
    stall_ms: int,
    max_wall_ms: int,
) -> tuple[str, str]:
    if not alive:
        return "hung", "process_dead"
    if zombie:
        return "hung", "process_zombie"
    if stopped and idle_ms >= min(stall_ms, 5000):
        return "hung", "process_stopped"
    if elapsed_ms >= max_wall_ms:
        return "hung", "wall_limit_exceeded"
    if idle_ms >= stall_ms:
        if total_cpu >= ACTIVE_CPU_THRESHOLD:
            return "active", "active_cpu_override"
        return "hung", "idle_stall"
    if idle_ms >= max(1, int(0.5 * stall_ms)) and total_cpu < ACTIVE_CPU_THRESHOLD:
        return "warning", "idle_warning"
    return "active", "running"


def _scan_worktree_state(wt: Path, base: str | None) -> dict[str, Any]:
    latest_mtime_ms: int | None = None
    if not wt.is_symlink() and wt.is_dir():
        seen = 0
        for root_dir, dirnames, filenames in os.walk(wt):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
            for fn in filenames:
                if fn == ".git":
                    continue
                seen += 1
                p = Path(root_dir) / fn
                try:
                    m_ms = int(p.stat().st_mtime * 1000)
                    if latest_mtime_ms is None or m_ms > latest_mtime_ms:
                        latest_mtime_ms = m_ms
                except OSError:
                    pass
                if seen >= 300:
                    break
            if seen >= 300:
                break

    dirty = False
    if not wt.is_symlink() and wt.is_dir():
        try:
            r_st = run_in_group(["git", "-C", str(wt), "status", "--porcelain"], timeout=4.0, register=False)
            if r_st.returncode == 0 and r_st.stdout.strip():
                dirty = True
            elif base:
                r_hd = run_in_group(["git", "-C", str(wt), "rev-parse", "HEAD"], timeout=4.0, register=False)
                if r_hd.returncode == 0 and r_hd.stdout.strip() and r_hd.stdout.strip() != base.strip():
                    dirty = True
        except Exception:
            dirty = True

    return {"latest_mtime_ms": latest_mtime_ms, "dirty": dirty}


# --- P2-272: signs of life and the pending-removals record -------------------------------------
# A worktree is never removed by wall-clock alone. A quiet, dead task is only recorded in
# WK_HOME/watchdog/pending-removals.json; the owner approves the removal (W panel OK button or
# `wk watchdog approve-remove <task_id>`), which re-checks liveness and backs up first.
PENDING_REMOVALS_VERSION = 1
LATER_HIDE_MS = 24 * 60 * 60 * 1000


def pending_removals_file(home: Path) -> Path:
    return home / "watchdog" / "pending-removals.json"


def _pending_removals_lock(home: Path) -> Path:
    return home / "watchdog" / "pending-removals.lock"


def load_pending_removals(wk_home: str | Path | None = None) -> dict[str, Any]:
    home = resolve_wk_home(wk_home)
    raw = read_json_safe(pending_removals_file(home), None)
    items = raw.get("items") if isinstance(raw, dict) and isinstance(raw.get("items"), dict) else {}
    return {"version": PENDING_REMOVALS_VERSION, "items": {k: v for k, v in items.items() if isinstance(v, dict)}}


def _save_pending_removals(home: Path, data: dict[str, Any]) -> None:
    _ensure_private_dir(home / "watchdog")
    atomic_write_json(pending_removals_file(home), {"version": PENDING_REMOVALS_VERSION, "items": data.get("items") or {}})


def _claim_pid(tdir: Path) -> int | None:
    try:
        first = (tdir / "claim").read_text(encoding="utf-8").split()
    except OSError:
        return None
    try:
        pid = int(first[0]) if first else 0
    except ValueError:
        return None
    return pid if pid > 1 else None


def task_heartbeat_ms(home: Path, tid: str) -> int | None:
    """P2-276: mtime of WK_HOME/tasks/<id>/heartbeat, touched by the guard hooks on each tool call
    inside the task's worktree. None when missing, a symlink or unreadable."""
    hb = home / "tasks" / tid / "heartbeat"
    try:
        if hb.is_symlink():
            return None
        return int(hb.stat().st_mtime * 1000)
    except OSError:
        return None


# P2-276: automatic recovery of dead tasks. A clean dead task is requeued at once; one with changes
# waits 3 x the stale window, is backed up (verified) and then requeued. After this many automatic
# requeues the owner decides again (pending removal), as before.
AUTO_REQUEUE_CAP = 3
DIRTY_WAIT_FACTOR = 3
# P2-276 review: an automatic requeue counts only quiet time the watcher itself saw. Passes more
# than QUIET_PASS_GAP_MS apart (a sleeping Mac, a stopped watcher) reset the count, so wall-clock
# idle alone never requeues a task. Clean tasks need 2 x the stale window, tasks with changes 3 x.
CLEAN_WAIT_FACTOR = 2
QUIET_PASS_GAP_MS = 120_000
# P2-276 round 2: a failed automatic backup is tried again no sooner than this, and after this many
# failures Watchkeeper stops trying and the owner decides (one notice). A good backup clears the count.
BACKUP_RETRY_MS = 60 * 60 * 1000
BACKUP_FAIL_CAP = 3
TASK_LOCK_STALE_MS = 15 * 60 * 1000


class _TaskLock:
    """P2-276 review: the per-task lock shared with bin/wk-task.mjs (take and done).

    Same protocol as withLock in bin/gemini-lib.mjs: create WK_HOME/watchdog/task_<id>.lock with
    O_EXCL and a token "pid ms hex"; take over a lock older than TASK_LOCK_STALE_MS or whose pid is
    gone; on release remove the file only while it still holds our token. Raises TimeoutError.
    """

    def __init__(self, home: Path, tid: str, wait_s: float = 15.0) -> None:
        self.path = home / "watchdog" / f"task_{tid}.lock"
        self.wait_s = wait_s
        self.token = ""

    def __enter__(self) -> "_TaskLock":
        _ensure_private_dir(self.path.parent)
        self.token = f"{os.getpid()} {int(time.time() * 1000)} {uuid.uuid4().hex[:8]}"
        deadline = time.monotonic() + max(0.05, self.wait_s)
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    os.write(fd, (self.token + "\n").encode("ascii"))
                finally:
                    os.close(fd)
                return self
            except FileExistsError:
                stale = False
                try:
                    st = self.path.lstat()
                    stale = (time.time() * 1000 - st.st_mtime * 1000) > TASK_LOCK_STALE_MS
                    if not stale:
                        first = self.path.read_text(encoding="utf-8", errors="ignore").split()
                        if first and first[0].isdigit() and int(first[0]) > 1 and not _pid_alive(int(first[0])):
                            stale = True
                except FileNotFoundError:
                    continue
                except OSError:
                    pass
                if stale:
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"task lock held: {self.path.name}")
                time.sleep(0.04)

    def __exit__(self, *exc: Any) -> None:
        try:
            if self.path.read_text(encoding="utf-8", errors="ignore").strip() == self.token:
                self.path.unlink()
        except OSError:
            pass


def _task_lock(home: Path, tid: str, wait_s: float = 15.0) -> _TaskLock:
    return _TaskLock(home, tid, wait_s)


_WT_NAME_RE = re.compile(r"^(?P<tid>.+?)(?:\.a(?P<n>[2-9]|[1-9]\d{1,3}))?$")


def _task_worktree(home: Path, tid: str, meta: dict[str, Any] | None) -> Path:
    """The task's worktree: meta.worktree when it sits directly in WK_HOME/worktrees and is named
    <tid> or <tid>.a<n> (attempt n >= 2); otherwise WK_HOME/worktrees/<tid>."""
    default = home / "worktrees" / tid
    raw = str((meta or {}).get("worktree") or "").strip() if isinstance(meta, dict) else ""
    if not raw:
        return default
    try:
        cand = Path(raw)
        if not cand.is_absolute():
            return default
        if cand.parent.resolve() != (home / "worktrees").resolve():
            return default
        m = _WT_NAME_RE.match(cand.name)
        if not m or m.group("tid") != tid:
            return default
        return (home / "worktrees") / cand.name
    except (OSError, ValueError):
        return default


def _task_quiet_file(home: Path) -> Path:
    return home / "watchdog" / "task-quiet.json"


def _update_task_quiet(home: Path, items: list[dict[str, Any]], now: int) -> dict[str, int]:
    """Track per task how long the watcher has seen it quiet (quiet_since, quiet_ms).

    A pass more than QUIET_PASS_GAP_MS after the previous one (or the first pass, or a clock going
    back) restarts every count at now: only quiet time seen pass by pass counts. A new attempt restarts
    the count too. Returns {task_id: quiet_ms}.
    """
    raw = read_json_safe(_task_quiet_file(home), None)
    raw = raw if isinstance(raw, dict) else {}
    try:
        last_pass = int(raw.get("last_pass_ms") or 0)
    except (TypeError, ValueError):
        last_pass = 0
    prev = raw.get("tasks") if isinstance(raw.get("tasks"), dict) else {}
    gap = now - last_pass if last_pass else None
    continuous = gap is not None and 0 <= gap <= QUIET_PASS_GAP_MS
    tasks: dict[str, Any] = {}
    out: dict[str, int] = {}
    for it in items:
        if it.get("surface") != "task":
            continue
        tid = str(it.get("id") or "")
        if not tid:
            continue
        attempt = int(it.get("attempt") or 1)
        if it.get("active_owner") or it.get("pid_alive") or float(it.get("cpu_pct") or 0.0) >= ACTIVE_CPU_THRESHOLD:
            sign = now
        else:
            sign = now - int(it.get("idle_ms") or 0)
        old = prev.get(tid) if isinstance(prev.get(tid), dict) else None
        if continuous and old is not None and int(old.get("attempt") or 1) == attempt:
            try:
                since = max(int(old.get("quiet_since") or now), sign)
            except (TypeError, ValueError):
                since = now
        else:
            since = now
        since = min(since, now)
        tasks[tid] = {"quiet_since": since, "attempt": attempt}
        out[tid] = max(0, now - since)
    _ensure_private_dir(home / "watchdog")
    atomic_write_json(_task_quiet_file(home), {"last_pass_ms": now, "tasks": tasks})
    return out


def _pid_cpu_pct(pid: int | None) -> float:
    """CPU of one pid via ``ps -o %cpu=`` (0.0 when gone or unreadable)."""
    if not _pid_alive(pid):
        return 0.0
    try:
        r = run_in_group(["ps", "-o", "%cpu=", "-p", str(int(pid or 0))], timeout=3.0, register=False)
        return float((r.stdout or "").strip().split()[0]) if r.returncode == 0 and (r.stdout or "").strip() else 0.0
    except Exception:
        return 0.0


def task_liveness(
    home: Path,
    tid: str,
    meta: dict[str, Any] | None,
    *,
    now_ms: int | None = None,
    stale_ms: int | None = None,
    registered_pids: list[int] | None = None,
    worktree_mtime_ms: int | None = None,
) -> dict[str, Any]:
    """Signs of life for a taken task: a live pid, CPU >= 5%, or output inside the stale window.

    Any one sign means the task is working and must not be treated as hung or removed.
    """
    now = _now_ms(now_ms)
    stale = int(stale_ms or _env_int("WK_TASK_STALE_MS", DEFAULT_TASK_STALE_MS))
    meta = meta if isinstance(meta, dict) else {}
    tdir = home / "tasks" / tid
    wt = _task_worktree(home, tid, meta)

    candidates: list[int] = []
    for raw in [*(registered_pids or []), meta.get("pid"), meta.get("runner_pid"), _claim_pid(tdir)]:
        try:
            v = int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            v = 0
        if v > 1 and v != os.getpid() and v not in candidates:
            candidates.append(v)
    pid: int | None = None
    pid_alive = False
    cpu_pct = 0.0
    for c in candidates:
        if _pid_alive(c):
            tree = inspect_process_tree(c, None)
            if tree.get("zombie") and not tree.get("total_cpu"):
                continue
            pid, pid_alive = c, True
            cpu_pct = max(float(tree.get("total_cpu") or 0.0), _pid_cpu_pct(c))
            break
    if pid is None and candidates:
        pid = candidates[0]

    if worktree_mtime_ms is None:
        worktree_mtime_ms = _scan_worktree_state(wt, None)["latest_mtime_ms"] if wt.is_dir() and not wt.is_symlink() else None
    last_output_ms = max(
        int(worktree_mtime_ms or 0),
        int(_parse_ts_ms(meta.get("last_activity_at")) or 0),
        int(_parse_ts_ms(meta.get("last_output_at")) or 0),
        int(_parse_ts_ms(meta.get("taken_at")) or 0),   # a task just taken counts as fresh output
    ) or None
    recent_output = bool(last_output_ms and now - last_output_ms < stale)
    hb_ms = task_heartbeat_ms(home, tid)
    recent_heartbeat = bool(hb_ms and now - hb_ms < stale)
    signs: list[str] = []
    if pid_alive:
        signs.append("pid_alive")
    if cpu_pct >= ACTIVE_CPU_THRESHOLD:
        signs.append("cpu")
    if recent_output:
        signs.append("recent_output")
    if recent_heartbeat:
        signs.append("heartbeat")
    return {
        "alive": bool(signs),
        "signs": signs,
        "pid": pid,
        "pid_alive": pid_alive,
        "cpu_pct": round(cpu_pct, 1),
        "last_output_at": _iso_utc(last_output_ms) if last_output_ms else None,
        "last_output_ms": last_output_ms,
        "heartbeat_at": _iso_utc(hb_ms) if hb_ms else None,
    }


def _record_pending_removal(home: Path, it: dict[str, Any], now: int) -> tuple[dict[str, Any], bool]:
    """Record (once) a quiet, dead task in pending-removals.json. Returns (entry, notify_now).

    notify_now is True only for a first sighting, or when a "later" decision has run out:
    one notice per hung task, never one per watchdog loop. "kept" never asks again.
    """
    tid = str(it.get("id") or "")
    with file_lock(_pending_removals_lock(home)):
        data = load_pending_removals(home)
        items = data["items"]
        entry = items.get(tid)
        notify = False
        if not isinstance(entry, dict) or entry.get("removed_at"):
            entry = {
                "task_id": tid,
                "worktree": str(it.get("worktree") or ""),
                "repo": str(it.get("repo") or ""),
                "dirty": bool(it.get("dirty")),
                "reason": "hung_dirty" if it.get("dirty") else "hung_clean",
                "first_seen_at": _iso_utc(now),
                "notified_at": _iso_utc(now),
                "pid": it.get("pid"),
                "pid_alive": bool(it.get("pid_alive")),
                "cpu_pct": float(it.get("cpu_pct") or 0.0),
                "last_output_at": it.get("last_output_at"),
                "decision": None,
                "decided_at": None,
                "later_until": None,
                "backup": None,
                "removed_at": None,
            }
            notify = True
        else:
            entry["dirty"] = bool(it.get("dirty"))
            entry["reason"] = "hung_dirty" if it.get("dirty") else "hung_clean"
            entry["pid"] = it.get("pid")
            entry["pid_alive"] = bool(it.get("pid_alive"))
            entry["cpu_pct"] = float(it.get("cpu_pct") or 0.0)
            entry["last_output_at"] = it.get("last_output_at")
            if entry.get("decision") == "later":
                until = _parse_ts_ms(entry.get("later_until")) or 0
                if until and now >= until:
                    entry["decision"] = None
                    entry["later_until"] = None
                    entry["owner_decided"] = True   # an expired "later" asks the owner again; no automatic requeue
                    entry["notified_at"] = _iso_utc(now)
                    notify = True
        items[tid] = entry
        _save_pending_removals(home, data)
    return entry, notify


def _verify_worktree_backup(wt: Path, backup_dir: Path, tar_members: int, commits_after_base: bool) -> None:
    """P2-276: check the backup is complete before anything is removed; raise on any gap."""
    import tarfile

    patch = backup_dir / "changes.patch"
    for f in (patch, backup_dir / "untracked.tar", backup_dir / "backup.json"):
        if not f.is_file():
            raise RuntimeError(f"backup file missing: {f.name}")
    if commits_after_base and not (backup_dir / "commits.patch").is_file():
        raise RuntimeError("backup file missing: commits.patch")
    with tarfile.open(backup_dir / "untracked.tar", "r") as tf:
        if len(tf.getmembers()) != tar_members:
            raise RuntimeError("untracked.tar is incomplete")
    info = read_json_safe(backup_dir / "backup.json", None)
    if not isinstance(info, dict) or not info.get("task_id"):
        raise RuntimeError("backup.json unreadable")
    # Tracked changes present means the patch must not be empty.
    r_q = run_in_group(["git", "-C", str(wt), "diff", "HEAD", "--quiet"], timeout=30.0, register=False)
    if r_q.returncode not in (0, 1):
        raise RuntimeError("git diff --quiet failed")
    if r_q.returncode == 1 and patch.stat().st_size == 0:
        raise RuntimeError("changes.patch is empty but the worktree has changes")


def decide_pending_removal(
    task_id: str,
    decision: str,
    *,
    wk_home: str | Path | None = None,
    now_ms: int | float | None = None,
    stale_ms: int | None = None,
) -> dict[str, Any]:
    """Owner decision on a pending removal: approve-remove | later | keep.

    approve-remove re-checks every sign of life and refuses ("still working") on any; otherwise it
    backs up (git diff HEAD patch + tar of untracked files) to WK_HOME/backups/worktrees/<id>-<stamp>/,
    removes the worktree and requeues the task. later hides the item for 24 h; keep never asks again.
    """
    home = resolve_wk_home(wk_home)
    now = _now_ms(now_ms)
    tid = str(task_id or "").strip()
    dec_in = str(decision or "").strip().lower()
    dec_map = {"approve-remove": "approved", "approve": "approved", "later": "later", "keep": "kept"}

    def out(ok: bool, dec: str | None, msg: str, **extra: Any) -> dict[str, Any]:
        res = {"ok": ok, "task_id": tid, "decision": dec, "message": msg}
        res.update(extra)
        return res

    if dec_in not in dec_map:
        return out(False, None, "Unknown decision; use approve-remove, later or keep.")
    if not TASK_ID_RE.match(tid):
        return out(False, None, "Invalid task id.")
    dec = dec_map[dec_in]

    if dec != "approved":
        with file_lock(_pending_removals_lock(home)):
            data = load_pending_removals(home)
            entry = data["items"].get(tid)
            if not isinstance(entry, dict):
                return out(False, None, "No pending removal for this task.")
            entry["decision"] = dec
            entry["decided_at"] = _iso_utc(now)
            entry["owner_decided"] = True
            entry["later_until"] = _iso_utc(now + LATER_HIDE_MS) if dec == "later" else None
            data["items"][tid] = entry
            _save_pending_removals(home, data)
        msg = "Hidden for 24 hours; Watchkeeper will ask again then." if dec == "later" else "Kept; Watchkeeper will not ask about this worktree again."
        # The panel's question closes with the same answer (later hides it 24 h there too; keep closes it).
        t_meta = read_json_safe(home / "tasks" / tid / "meta.json", None)
        if isinstance(t_meta, dict):
            _append_suggestion_event(home, str(t_meta.get("stalled_suggestion_id") or ""), "later" if dec == "later" else "no", now, msg)
        return out(True, dec, msg)

    if is_kill_switch_active(home):
        return out(False, None, "Stop switch is on; nothing was removed.")

    try:
        tlock = _task_lock(home, tid)
        tlock.__enter__()
    except TimeoutError:
        return out(False, None, "The task is busy (being taken or finished); try again in a minute.", busy=True)
    try:
        data = load_pending_removals(home)
        entry = data["items"].get(tid)
        if not isinstance(entry, dict):
            return out(False, None, "No pending removal for this task.")
        if entry.get("removed_at") and not entry.get("removing"):
            return out(True, "approved", "Already removed.", backup=entry.get("backup"), requeued=False)
        tdir = home / "tasks" / tid
        mpath = tdir / "meta.json"
        meta = read_json_safe(mpath, None)
        meta = meta if isinstance(meta, dict) else {}
        wt = _task_worktree(home, tid, meta)

        # P2-276 review: a removal interrupted by a kill resumes here. The backup was made and
        # recorded before anything was removed, so finish with that backup and make no new one.
        resuming = bool(meta.get("removing") or entry.get("removing"))
        backup_dir: Path | None = None
        if resuming:
            pend = str(meta.get("removal_backup_pending") or entry.get("backup") or "").strip()
            backup_dir = Path(pend) if pend else None
        else:
            reg_pids: list[int] = []
            raw_p = read_json_safe(_processes_file(home), {"processes": {}})
            procs = raw_p.get("processes") if isinstance(raw_p, dict) and isinstance(raw_p.get("processes"), dict) else {}
            for e in procs.values():
                if isinstance(e, dict) and str(e.get("task_id") or "") == tid:
                    try:
                        reg_pids.append(int(e.get("pid")))
                    except (TypeError, ValueError):
                        pass

            def _alive_now() -> dict[str, Any]:
                lv = task_liveness(home, tid, meta, now_ms=_now_ms(None) if now_ms is None else now, stale_ms=stale_ms, registered_pids=reg_pids)
                with file_lock(_pending_removals_lock(home)):
                    d2 = load_pending_removals(home)
                    e2 = d2["items"].get(tid) or entry
                    e2["pid"] = lv["pid"]
                    e2["pid_alive"] = lv["pid_alive"]
                    e2["cpu_pct"] = lv["cpu_pct"]
                    e2["last_output_at"] = lv["last_output_at"]
                    d2["items"][tid] = e2
                    _save_pending_removals(home, d2)
                return lv

            life = _alive_now()
            if life["alive"]:
                return out(False, None, "Still working (" + ", ".join(life["signs"]) + "); nothing was removed.", signs=life["signs"])

            if wt.is_dir() and not wt.is_symlink():
                if not (wt / ".git").exists():
                    return out(False, None, "This folder is not a git worktree (no .git); nothing was backed up or removed.")
                stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
                backup_dir = home / "backups" / "worktrees" / f"{tid}-{stamp}"
                n = 1
                while backup_dir.exists():
                    n += 1
                    backup_dir = home / "backups" / "worktrees" / f"{tid}-{stamp}-{n}"
                try:
                    _ensure_private_dir(home / "backups")
                    _ensure_private_dir(home / "backups" / "worktrees")
                    _ensure_private_dir(backup_dir)
                    patch = backup_dir / "changes.patch"
                    r_d = run_in_group(
                        ["git", "-C", str(wt), "diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", f"--output={patch}"],
                        timeout=30.0,
                        register=False,
                    )
                    if r_d.returncode != 0:
                        raise RuntimeError("git diff HEAD failed")
                    r_u = run_in_group(["git", "-C", str(wt), "ls-files", "--others", "--exclude-standard", "-z"], timeout=30.0, register=False)
                    if r_u.returncode != 0:
                        raise RuntimeError("git ls-files failed")
                    import tarfile

                    untracked = [u for u in (r_u.stdout or "").split("\0") if u]
                    added = 0
                    with tarfile.open(backup_dir / "untracked.tar", "w") as tf:
                        for rel in untracked:
                            src = wt / rel
                            if src.is_file() or src.is_symlink():
                                tf.add(str(src), arcname=rel, recursive=False)
                                added += 1
                    # P2-276: the worktree is detached, so commits made after the base would go with it;
                    # keep them as a patch (base..HEAD) and record HEAD.
                    head = ""
                    r_h = run_in_group(["git", "-C", str(wt), "rev-parse", "HEAD"], timeout=15.0, register=False)
                    if r_h.returncode == 0:
                        head = (r_h.stdout or "").strip()
                    base_ref = str(meta.get("base") or "").strip()
                    commits_after_base = bool(base_ref and head and head != base_ref)
                    if commits_after_base:
                        cpatch = backup_dir / "commits.patch"
                        r_c = run_in_group(
                            ["git", "-C", str(wt), "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", f"--output={cpatch}", base_ref, "HEAD"],
                            timeout=30.0,
                            register=False,
                        )
                        if r_c.returncode != 0 or not cpatch.is_file():
                            raise RuntimeError("git diff base..HEAD failed")
                    atomic_write_json(backup_dir / "backup.json", {
                        "task_id": tid,
                        "worktree": str(wt),
                        "repo": str(meta.get("repo") or entry.get("repo") or ""),
                        "base": meta.get("base"),
                        "head": head or None,
                        "commits_after_base": commits_after_base,
                        "untracked_files": len(untracked),
                        "made_at": _iso_utc(now),
                    })
                    _verify_worktree_backup(wt, backup_dir, added, commits_after_base)
                except Exception as exc:  # never remove without a complete backup
                    # Remove the partial backup folder this pass created (its name did not exist before).
                    shutil.rmtree(backup_dir, ignore_errors=True)
                    fails = int(meta.get("removal_backup_failures") or 0) + 1
                    next_try = now + BACKUP_RETRY_MS
                    if meta:
                        meta["removal_backup_failed_at"] = now
                        meta["removal_backup_failed_error"] = type(exc).__name__
                        meta["removal_backup_failures"] = fails
                        atomic_write_json(mpath, meta)
                    return out(False, None, f"Backup failed ({type(exc).__name__}); nothing was removed.",
                               backup_failed=True, backup_failures=fails, next_try_at=_iso_utc(next_try))
                # A complete, verified backup clears earlier failures.
                for k in ("removal_backup_failed_at", "removal_backup_failed_error", "removal_backup_failures"):
                    meta.pop(k, None)

                # The backup took time: check every sign of life once more just before removing.
                life = _alive_now()
                if life["alive"]:
                    return out(False, None, "Still working (" + ", ".join(life["signs"]) + "); backup kept, nothing was removed.",
                               signs=life["signs"], backup=str(backup_dir))

            # Record the intent before removing anything, so a kill from here on is resumed (above).
            if meta:
                meta["removing"] = True
                meta["removal_backup_pending"] = str(backup_dir) if backup_dir else None
                atomic_write_json(mpath, meta)
            with file_lock(_pending_removals_lock(home)):
                d3 = load_pending_removals(home)
                e3 = d3["items"].get(tid) or entry
                e3["removing"] = True
                e3["backup"] = str(backup_dir) if backup_dir else None
                d3["items"][tid] = e3
                _save_pending_removals(home, d3)
                entry = e3

        repo = str(meta.get("repo") or entry.get("repo") or "")
        if wt.is_dir() and not wt.is_symlink():
            if repo and Path(repo).is_dir():
                try:
                    run_in_group(["git", "-C", repo, "worktree", "remove", "--force", str(wt)], timeout=30.0, register=False)
                    run_in_group(["git", "-C", repo, "worktree", "prune"], timeout=15.0, register=False)
                except Exception:
                    pass
            if wt.exists() and wt.resolve().parent == (home / "worktrees").resolve():
                shutil.rmtree(wt, ignore_errors=True)
        elif wt.is_symlink():
            try:
                wt.unlink()
            except OSError:
                pass
        if wt.exists() or wt.is_symlink():
            return out(False, None, "Worktree could not be removed; backup kept.", backup=str(backup_dir) if backup_dir else None)

        sug_id = str(meta.get("stalled_suggestion_id") or "") if meta else ""
        requeued = False
        if meta:
            if str(meta.get("status") or "") == "taken":
                try:
                    (tdir / "claim").unlink()
                except OSError:
                    pass
                meta["status"] = "queued"
                meta["taken_at"] = None
                meta["worktree"] = None
                meta["base"] = None
                meta["stalled_at"] = None
                meta["stall_note"] = None
                meta["claim_nonce"] = None
                # Where removed worktrees went (undo): every backup is kept in removal_backups; the
                # latest also stays in removal_backup so older readers keep working.
                backups = meta.get("removal_backups") if isinstance(meta.get("removal_backups"), list) else []
                if not backups and meta.get("removal_backup"):
                    backups = [str(meta.get("removal_backup"))]
                backups = [str(b) for b in backups if b]
                if backup_dir:
                    backups.append(str(backup_dir))
                meta["removal_backups"] = backups
                meta["removal_backup"] = str(backup_dir) if backup_dir else None
                meta["stalled_suggestion_id"] = None
                meta["last_activity_at"] = None
                meta["requeue_count"] = int(meta.get("requeue_count") or 0) + 1
                # The next take works in a fresh folder (worktrees/<id>.a<n>); work from an earlier
                # attempt can no longer be handed in as this one.
                meta["attempt"] = int(meta.get("attempt") or 1) + 1
                meta["last_recovered_at"] = now
                requeued = True
            meta.pop("removing", None)
            meta.pop("removal_backup_pending", None)
            atomic_write_json(mpath, meta)

        with file_lock(_pending_removals_lock(home)):
            data = load_pending_removals(home)
            entry = data["items"].get(tid) or entry
            entry["decision"] = "approved"
            entry["decided_at"] = _iso_utc(now)
            entry["later_until"] = None
            entry["backup"] = str(backup_dir) if backup_dir else None
            entry["removed_at"] = _iso_utc(now)
            entry.pop("removing", None)
            data["items"][tid] = entry
            _save_pending_removals(home, data)
    finally:
        tlock.__exit__(None, None, None)
    done_msg = ("Worktree removed and task requeued." if requeued else "Worktree removed.") + (f" Backup: {backup_dir}" if backup_dir else "")
    _append_suggestion_event(home, sug_id, "ok", now, done_msg)   # the panel's question is answered
    return out(True, "approved", done_msg, backup=str(backup_dir) if backup_dir else None, requeued=requeued, resumed=resuming)


def scan_hanging_tasks(
    wk_home: str | Path | None = None,
    *,
    now_ms: int | float | None = None,
    job_stall_ms: int | None = None,
    task_stale_ms: int | None = None,
    chat_stall_ms: int | None = None,
    proc_stall_ms: int | None = None,
    write_summary: bool = False,
) -> dict[str, Any]:
    """Non-destructive read-only scan of Watchkeeper jobs, taken tasks, chat turns, and tracked PIDs."""
    home = resolve_wk_home(wk_home)
    now = _now_ms(now_ms)
    j_stall = max(50, int(job_stall_ms if job_stall_ms is not None else _env_int("WK_JOB_STALL_MS", DEFAULT_JOB_STALL_MS)))
    t_stale = max(50, int(task_stale_ms if task_stale_ms is not None else _env_int("WK_TASK_STALE_MS", DEFAULT_TASK_STALE_MS)))
    c_stall = max(50, int(chat_stall_ms if chat_stall_ms is not None else _env_int("WK_CHAT_STALL_MS", DEFAULT_CHAT_STALL_MS)))
    p_stall = max(50, int(proc_stall_ms if proc_stall_ms is not None else _env_int("WK_PROC_STALL_MS", DEFAULT_PROC_STALL_MS)))

    jobs_dir = home / "jobs"
    tasks_dir = home / "tasks"
    chat_file = home / "chat-sessions.json"
    procs_file = _processes_file(home)

    if not jobs_dir.is_dir() and not tasks_dir.is_dir() and not chat_file.is_file() and not procs_file.is_file():
        empty_report = {
            "ok": True,
            "scanned_at": _iso_utc(now),
            "scanned_at_ms": now,
            "activeCount": 0,
            "warningCount": 0,
            "hungCount": 0,
            "items": [],
            "summary": {"jobs": 0, "tasks": 0, "chat_turns": 0, "processes": 0},
        }
        if write_summary:
            _ensure_private_dir(home / "watchdog")
            atomic_write_json(_summary_file(home), empty_report)
        return empty_report

    items: list[dict[str, Any]] = []
    active_task_ids: set[str] = set()
    task_live_pids: dict[str, list[int]] = {}

    # 1. Registered processes
    if procs_file.is_file():
        raw_p = read_json_safe(procs_file, {"processes": {}})
        procs = raw_p.get("processes") if isinstance(raw_p, dict) and isinstance(raw_p.get("processes"), dict) else {}
        for key, entry in list(procs.items()):
            if not isinstance(entry, dict):
                continue
            pid = entry.get("pid")
            try:
                pid_i = int(pid)
            except (TypeError, ValueError):
                continue
            pgid_v = entry.get("pgid")
            pgid_i = int(pgid_v) if isinstance(pgid_v, int) and pgid_v > 1 else None
            eff_stall = int(entry.get("stall_ms") or p_stall) if proc_stall_ms is None else p_stall
            eff_wall = int(entry.get("max_wall_ms") or 30 * 60 * 1000)
            started_ms = _parse_ts_ms(entry.get("started_at")) or now
            last_hb_ms = _parse_ts_ms(entry.get("last_heartbeat_at")) or started_ms
            idle_ms = max(0, now - last_hb_ms)
            elapsed_ms = max(0, now - started_ms)

            tree = inspect_process_tree(pid_i, pgid_i)
            status_cls, reason = _classify_process_signal(
                alive=bool(tree["alive"]),
                zombie=bool(tree["zombie"]),
                stopped=bool(tree["stopped"]),
                total_cpu=float(tree["total_cpu"] or 0.0),
                idle_ms=idle_ms,
                elapsed_ms=elapsed_ms,
                stall_ms=eff_stall,
                max_wall_ms=eff_wall,
            )
            task_ref = str(entry.get("task_id") or "").strip()
            if task_ref and status_cls in ("active", "warning"):
                active_task_ids.add(task_ref)
            if task_ref and tree["alive"]:
                task_live_pids.setdefault(task_ref, []).append(pid_i)
            items.append({
                "surface": "process",
                "id": f"pid:{pid_i}",
                "pid": pid_i,
                "pgid": pgid_i,
                "kind": entry.get("kind") or "task",
                "label": entry.get("label") or key,
                "task_id": task_ref,
                "cwd": entry.get("cwd") or "",
                "classification": status_cls,
                "reason": reason,
                "idle_ms": idle_ms,
                "elapsed_ms": elapsed_ms,
                "total_cpu": tree["total_cpu"],
                "pids": tree["pids"],
                "alive": tree["alive"],
            })

    # 2. Running / queued jobs
    if jobs_dir.is_dir():
        try:
            job_names = sorted(d.name for d in jobs_dir.iterdir() if d.is_dir() and JOB_ID_RE.match(d.name))
        except OSError:
            job_names = []
        for jid in job_names:
            jdir = jobs_dir / jid
            meta = read_json_safe(jdir / "meta.json", None)
            if not isinstance(meta, dict) or meta.get("id") != jid:
                continue
            state = str(meta.get("state") or "")
            if state not in ("running", "queued"):
                continue

            runner_pid = meta.get("runner_pid")
            if not isinstance(runner_pid, int):
                rpid_file = jdir / "runner.pid"
                if rpid_file.is_file():
                    try:
                        runner_pid = int(rpid_file.read_text(encoding="utf-8").strip())
                    except Exception:
                        runner_pid = None
            pgid = meta.get("pgid") if isinstance(meta.get("pgid"), int) else None

            ev_mtime_ms = None
            ev_file = jdir / "events.jsonl"
            if ev_file.is_file():
                try:
                    ev_mtime_ms = int(ev_file.stat().st_mtime * 1000)
                except OSError:
                    ev_mtime_ms = None

            started_ms = (
                _parse_ts_ms(meta.get("run_started_at"))
                or _parse_ts_ms(meta.get("started_at"))
                or _parse_ts_ms(meta.get("queued_at"))
                or now
            )
            last_act = max(
                _parse_ts_ms(meta.get("last_activity_at")) or 0,
                ev_mtime_ms or 0,
                started_ms,
            )
            idle_ms = max(0, now - last_act)
            elapsed_ms = max(0, now - started_ms)
            wall_ms = int(meta.get("wall_ms") or 3 * 3600 * 1000)

            tree = inspect_process_tree(runner_pid if isinstance(runner_pid, int) else None, pgid)
            if not tree["alive"] and elapsed_ms <= 15000 and idle_ms < j_stall:
                status_cls, reason = "active", "starting"
            elif not tree["alive"]:
                status_cls, reason = "hung", "dead_runner"
            else:
                status_cls, reason = _classify_process_signal(
                    alive=True,
                    zombie=bool(tree["zombie"]),
                    stopped=bool(tree["stopped"]),
                    total_cpu=float(tree["total_cpu"] or 0.0),
                    idle_ms=idle_ms,
                    elapsed_ms=elapsed_ms,
                    stall_ms=j_stall,
                    max_wall_ms=wall_ms,
                )

            items.append({
                "surface": "job",
                "id": jid,
                "project": meta.get("project") or "",
                "state": state,
                "pid": runner_pid,
                "pgid": pgid,
                "classification": status_cls,
                "reason": reason,
                "idle_ms": idle_ms,
                "elapsed_ms": elapsed_ms,
                "total_cpu": tree["total_cpu"],
                "pids": tree["pids"],
                "alive": tree["alive"],
            })

    # 3. Chat sessions (check active turns before tasks so active task_ids are noted)
    chat_turns_items: list[dict[str, Any]] = []
    if chat_file.is_file():
        cdata = read_json_safe(chat_file, {})
        sessions = cdata.get("sessions") if isinstance(cdata, dict) and isinstance(cdata.get("sessions"), list) else []
        for sess in sessions:
            if not isinstance(sess, dict):
                continue
            sid = str(sess.get("id") or "")
            task_ref = str(sess.get("taskId") or "").strip()
            for turn in sess.get("turns") or []:
                if not isinstance(turn, dict):
                    continue
                t_st = str(turn.get("status") or "")
                if t_st not in ("running", "preparing"):
                    continue
                updated_ms = (
                    _parse_ts_ms(turn.get("updatedAt"))
                    or _parse_ts_ms(turn.get("createdAt"))
                    or _parse_ts_ms(sess.get("updatedAt"))
                    or now
                )
                idle_ms = max(0, now - updated_ms)
                if task_ref and task_ref in active_task_ids:
                    status_cls, reason = "active", "tracked_process_active"
                elif idle_ms >= c_stall:
                    status_cls, reason = "hung", "chat_turn_stalled"
                elif idle_ms >= max(1, int(0.5 * c_stall)):
                    status_cls, reason = "warning", "chat_turn_idle"
                else:
                    status_cls, reason = "active", "running"
                    if task_ref:
                        active_task_ids.add(task_ref)

                chat_turns_items.append({
                    "surface": "chat_turn",
                    "id": f"{sid}:{turn.get('id') or ''}",
                    "session_id": sid,
                    "turn_id": turn.get("id") or "",
                    "task_id": task_ref,
                    "title": sess.get("title") or turn.get("rawPrompt") or "Chat turn",
                    "classification": status_cls,
                    "reason": reason,
                    "idle_ms": idle_ms,
                    "elapsed_ms": idle_ms,
                })
    items.extend(chat_turns_items)

    # 4. Taken Gemini tasks
    if tasks_dir.is_dir():
        try:
            task_names = sorted(d.name for d in tasks_dir.iterdir() if d.is_dir() and TASK_ID_RE.match(d.name))
        except OSError:
            task_names = []
        for tid in task_names:
            tdir = tasks_dir / tid
            meta = read_json_safe(tdir / "meta.json", None)
            if not isinstance(meta, dict) or meta.get("id") != tid:
                continue
            if str(meta.get("status") or "") != "taken":
                continue

            taken_ms = _parse_ts_ms(meta.get("taken_at")) or _parse_ts_ms(meta.get("created_at")) or now
            wt = _task_worktree(home, tid, meta)
            wt_info = _scan_worktree_state(wt, str(meta.get("base") or ""))
            last_act = max(taken_ms, wt_info["latest_mtime_ms"] or 0, _parse_ts_ms(meta.get("last_activity_at")) or 0, task_heartbeat_ms(home, tid) or 0)
            idle_ms = max(0, now - last_act)
            elapsed_ms = max(0, now - taken_ms)

            has_active_owner = tid in active_task_ids
            life = task_liveness(
                home, tid, meta, now_ms=now, stale_ms=t_stale,
                registered_pids=task_live_pids.get(tid), worktree_mtime_ms=wt_info["latest_mtime_ms"],
            )
            if has_active_owner:
                status_cls, reason = "active", "owner_process_active"
            elif life["pid_alive"] or life["cpu_pct"] >= ACTIVE_CPU_THRESHOLD:
                status_cls, reason = "active", "task_process_alive"
            elif idle_ms >= t_stale:
                status_cls = "hung"
                reason = "hung_dirty" if wt_info["dirty"] else "hung_clean"
            elif idle_ms >= max(1, int(0.5 * t_stale)):
                status_cls = "warning"
                reason = "task_idle_warning"
            else:
                status_cls, reason = "active", "in_progress"

            items.append({
                "surface": "task",
                "id": tid,
                "title": meta.get("title") or tid,
                "repo": meta.get("repo") or "",
                "worktree": str(wt),
                "dirty": bool(wt_info["dirty"]),
                "classification": status_cls,
                "reason": reason,
                "idle_ms": idle_ms,
                "elapsed_ms": elapsed_ms,
                "stalled_suggestion_id": meta.get("stalled_suggestion_id") or "",
                "pid": life["pid"],
                "pid_alive": life["pid_alive"],
                "cpu_pct": life["cpu_pct"],
                "last_output_at": life["last_output_at"],
                "attempt": int(meta.get("attempt") or 1),
                "active_owner": bool(has_active_owner),
            })

    counts = {"active": 0, "warning": 0, "hung": 0}
    surf_counts = {"job": 0, "task": 0, "chat_turn": 0, "process": 0}
    for it in items:
        c = it.get("classification") or "active"
        if c in counts:
            counts[c] += 1
        s = it.get("surface") or "task"
        if s in surf_counts:
            surf_counts[s] += 1

    # Prioritize hung -> warning -> active before capping so recovery never misses hung items
    _sev_order = {"hung": 0, "warning": 1, "active": 2}
    items.sort(key=lambda it: _sev_order.get(str(it.get("classification") or "active"), 3))

    report = {
        "ok": True,
        "scanned_at": _iso_utc(now),
        "scanned_at_ms": now,
        "activeCount": counts["active"],
        "warningCount": counts["warning"],
        "hungCount": counts["hung"],
        "items": items[:80],
        "summary": {
            "jobs": surf_counts["job"],
            "tasks": surf_counts["task"],
            "chat_turns": surf_counts["chat_turn"],
            "processes": surf_counts["process"],
        },
    }

    if write_summary:
        _ensure_private_dir(home / "watchdog")
        atomic_write_json(_summary_file(home), report)

    return report


def _append_suggestion_line(home: Path, *, title: str, detail: str, now_ms: int) -> str:
    sec = now_ms / 1000.0
    stamp = dt.datetime.fromtimestamp(sec, tz=dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    sid = f"S-{stamp}-{uuid.uuid4().hex[:4]}"
    row = {
        "id": sid,
        "at": _iso_utc(now_ms),
        "from": "watchkeeper",
        "title": re.sub(r"\s+", " ", title).strip()[:200],
        "detail": sanitize_text(detail).text[:4000],
        "action": {"type": "none"},
    }
    sfile = home / "suggestions.jsonl"
    _ensure_private_dir(home)
    fd = os.open(str(sfile), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return sid


def _append_suggestion_event(home: Path, sid: str, status: str, now_ms: int, text: str = "") -> None:
    """Close or snooze a suggestion the way the panel and wk-suggest do: {id, at, status: ok|later|no, text?}."""
    if not sid or not re.match(r"^S-[\w-]{1,80}$", sid) or status not in ("ok", "later", "no"):
        return
    row: dict[str, Any] = {"id": sid, "at": _iso_utc(now_ms), "status": status}
    if text:
        row["text"] = sanitize_text(text).text[:500]
    sfile = home / "suggestions.jsonl"
    try:
        _ensure_private_dir(home)
        fd = os.open(str(sfile), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    except OSError:
        return
    try:
        os.write(fd, (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def _append_job_note(home: Path, job_id: str, meta: dict[str, Any], text: str, now_ms: int) -> None:
    clean = sanitize_text(text).text[:2000]
    ev_num = int(meta.get("events") or 0) + 1
    meta["events"] = ev_num
    ev_row = {"n": ev_num, "at": now_ms, "type": "note", "text": clean}
    ev_file = home / "jobs" / job_id / "events.jsonl"
    _ensure_private_dir(ev_file.parent)
    fd = os.open(str(ev_file), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        if os.name == "posix":
            os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(ev_row, ensure_ascii=False) + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def recover_hanging_tasks(
    wk_home: str | Path | None = None,
    *,
    now_ms: int | float | None = None,
    dry_run: bool = False,
    record_learning: bool = True,
    grace_ms: int = 1200,
    job_stall_ms: int | None = None,
    task_stale_ms: int | None = None,
    chat_stall_ms: int | None = None,
    proc_stall_ms: int | None = None,
    surface: str | None = None,
    owner: bool = False,
    _locked: bool = False,
) -> dict[str, Any]:
    """Dynamically recover hanging Watchkeeper jobs, tasks, chat turns, and tracked processes safely.

    surface limits the pass to one kind ("task", "job", "chat_turn", "process"); wk-watch uses
    "task" so it never touches jobs or processes. owner=True is the owner's own path (wk heal):
    the old rules, not the watched quiet time.
    """
    home = resolve_wk_home(wk_home)
    if not dry_run and not _locked:
        # P2-276 review: one recover pass at a time (wk-watch, the daemon and wk heal may overlap).
        try:
            with file_lock(home / "watchdog" / "recover.lock", timeout_s=300):
                return recover_hanging_tasks(
                    home, now_ms=now_ms, dry_run=False, record_learning=record_learning, grace_ms=grace_ms,
                    job_stall_ms=job_stall_ms, task_stale_ms=task_stale_ms, chat_stall_ms=chat_stall_ms,
                    proc_stall_ms=proc_stall_ms, surface=surface, owner=owner, _locked=True,
                )
        except TimeoutError:
            return {"ok": False, "killed": False, "busy": True, "dry_run": False, "recovered": [],
                    "reason": "Another recover pass is running."}
    now = _now_ms(now_ms)
    if is_kill_switch_active(home):
        return {
            "ok": False,
            "killed": True,
            "dry_run": dry_run,
            "recovered": [],
            "reason": "Kill switch active (~/.wk/KILL); dynamic recovery skipped.",
        }

    scan = scan_hanging_tasks(
        home,
        now_ms=now,
        job_stall_ms=job_stall_ms,
        task_stale_ms=task_stale_ms,
        chat_stall_ms=chat_stall_ms,
        proc_stall_ms=proc_stall_ms,
        write_summary=False,
    )
    hung_items = [it for it in scan.get("items") or [] if it.get("classification") == "hung"]
    if surface:
        hung_items = [it for it in hung_items if it.get("surface") == surface]
    recovered: list[dict[str, Any]] = []
    t_stale = max(50, int(task_stale_ms if task_stale_ms is not None else _env_int("WK_TASK_STALE_MS", DEFAULT_TASK_STALE_MS)))

    if dry_run:
        return {
            "ok": True,
            "killed": False,
            "dry_run": True,
            "hungCount": len(hung_items),
            "would_recover": hung_items,
            "recovered": [],
        }

    quiet: dict[str, int] = {}
    if surface in (None, "task"):
        quiet = _update_task_quiet(home, [it for it in scan.get("items") or [] if it.get("surface") == "task"], now)
        # P2-276 review: a removal cut short by a kill is finished first, with its recorded backup.
        tasks_dir = home / "tasks"
        if tasks_dir.is_dir():
            for td in sorted(tasks_dir.iterdir()):
                m = read_json_safe(td / "meta.json", None)
                if isinstance(m, dict) and m.get("removing"):
                    res = decide_pending_removal(td.name, "approve-remove", wk_home=home, now_ms=now, stale_ms=t_stale)
                    if res.get("ok"):
                        recovered.append({"surface": "task", "id": td.name, "action": "removal_resumed",
                                          "backup": res.get("backup"), "requeued": bool(res.get("requeued"))})
        done_ids = {r["id"] for r in recovered}
        hung_items = [it for it in hung_items if not (it.get("surface") == "task" and str(it.get("id")) in done_ids)]

    for it in hung_items:
        surf = it.get("surface")
        reason = str(it.get("reason") or "hung")

        if surf == "process":
            pid_i = it.get("pid")
            pgid_i = it.get("pgid")
            kres = kill_process_group(pid_i, pgid_i, grace_ms=grace_ms)
            unregister_process(int(pid_i), wk_home=home)
            recovered.append({
                "surface": "process",
                "id": it["id"],
                "action": "terminated_and_unregistered",
                "reason": reason,
                "signal": kres.get("signal_used"),
            })

        elif surf == "job":
            jid = str(it["id"])
            jdir = home / "jobs" / jid
            mpath = jdir / "meta.json"
            with file_lock(home / "watchdog" / f"job_{jid}.lock"):
                meta = read_json_safe(mpath, None)
                if not isinstance(meta, dict):
                    continue
                kres = kill_process_group(it.get("pid"), it.get("pgid"), grace_ms=grace_ms)
                msg = f"Recovered stalled job {jid} automatically ({reason})."
                meta["state"] = "failed"
                meta["ended_at"] = now
                meta["stall_recovered_at"] = now
                meta["last_text"] = msg
                _append_job_note(home, jid, meta, msg, now)
                atomic_write_json(mpath, meta)
            recovered.append({
                "surface": "job",
                "id": jid,
                "action": "marked_failed_and_killed_group",
                "reason": reason,
                "signal": kres.get("signal_used"),
            })

        elif surf == "task":
            tid = str(it["id"])
            tdir = home / "tasks" / tid
            mpath = tdir / "meta.json"
            meta0 = read_json_safe(mpath, None)
            meta0 = meta0 if isinstance(meta0, dict) else {}
            wt = _task_worktree(home, tid, meta0)
            wt_present = wt.is_dir() and not wt.is_symlink()
            rq = int(meta0.get("requeue_count") or 0)
            idle_ms_i = int(it.get("idle_ms") or 0)
            quiet_i = int(quiet.get(tid, 0))
            pend0 = load_pending_removals(home)["items"].get(tid)
            pend0 = pend0 if isinstance(pend0, dict) and not pend0.get("removed_at") else {}
            # An owner's answer (keep, later, or a "later" that ran out) means the owner decides from now on.
            owner_hold = str(pend0.get("decision") or "") in ("kept", "later") or bool(pend0.get("owner_decided"))
            # P2-277: the owner's hold (wk-task hold) stops the automatic path; the worktree stays as it is.
            if not owner and _task_held(tdir, now):
                recovered.append({"surface": "task", "id": tid, "action": "held", "reason": reason,
                                  "message": "Held by the owner (wk-task release to lift it); not requeued."})
                continue
            if reason == "hung_dirty" or wt_present or rq >= AUTO_REQUEUE_CAP or owner_hold:
                # P2-272: one notice per hung task, and never a removal by wall-clock alone.
                # P2-276 review: a dead task is recovered automatically only after the watcher itself
                # saw it quiet, pass after pass, for CLEAN_WAIT_FACTOR x the stale window (clean) or
                # DIRTY_WAIT_FACTOR x (with changes); a sleeping Mac resets the count. Always through
                # decide_pending_removal (it re-checks every sign of life, backs up and verifies before
                # removing). After AUTO_REQUEUE_CAP automatic requeues, or once the owner answered,
                # the owner decides. The owner's own paths (wk heal) keep the old rule.
                pend, notify = _record_pending_removal(home, it, now)
                owner_hold = owner_hold or str(pend.get("decision") or "") in ("kept", "later") or bool(pend.get("owner_decided"))
                # P2-276 round 2: failed automatic backups wait BACKUP_RETRY_MS between tries; after
                # BACKUP_FAIL_CAP failures the owner decides.
                bf_n = int(meta0.get("removal_backup_failures") or 0)
                try:
                    bf_at = int(meta0.get("removal_backup_failed_at") or 0)
                except (TypeError, ValueError):
                    bf_at = 0
                backup_gave_up = bf_n >= BACKUP_FAIL_CAP
                owner_hold = owner_hold or backup_gave_up
                if owner:
                    due = reason == "hung_clean" or idle_ms_i >= DIRTY_WAIT_FACTOR * t_stale
                else:
                    due = quiet_i >= (CLEAN_WAIT_FACTOR if reason == "hung_clean" else DIRTY_WAIT_FACTOR) * t_stale
                auto_ok = wt_present and not owner_hold and rq < AUTO_REQUEUE_CAP and due
                auto_refused = False
                if auto_ok and bf_n and now - bf_at < BACKUP_RETRY_MS:
                    recovered.append({
                        "surface": "task",
                        "id": tid,
                        "action": "auto_recovery_waiting",
                        "reason": reason,
                        "message": f"Backup failed {bf_n} of {BACKUP_FAIL_CAP} times; next try after {_iso_utc(bf_at + BACKUP_RETRY_MS)}.",
                        "next_try_at": _iso_utc(bf_at + BACKUP_RETRY_MS),
                    })
                    continue
                if auto_ok:
                    with file_lock(_pending_removals_lock(home)):
                        pdata = load_pending_removals(home)
                        pe = pdata["items"].get(tid)
                        if isinstance(pe, dict):
                            pe["auto"] = True
                            _save_pending_removals(home, pdata)
                    res = decide_pending_removal(tid, "approve-remove", wk_home=home, now_ms=now, stale_ms=t_stale)
                    if res.get("ok") and res.get("requeued"):
                        title = str(meta0.get("title") or tid)[:120]
                        _bridge_crossing(home, tid, str(meta0.get("model_used") or "gemini"), "gemini", "requeued", title, now)
                        bk = res.get("backup")
                        quiet_min = round((idle_ms_i if owner else quiet_i) / 60000.0, 1)
                        detail = (
                            f"Task {tid} showed no sign of life for {quiet_min} minutes, so Watchkeeper "
                            + ("backed up its changes, " if reason == "hung_dirty" else "")
                            + "removed its worktree and put it back in the queue (automatic requeue "
                            + f"{rq + 1} of {AUTO_REQUEUE_CAP})."
                            + (f" Backup: {bk}." if bk else "")
                            + " Nothing to do; the next agent that takes it is told where the backup is."
                        )
                        info_id = _append_suggestion_line(home, title=f'Task "{title}" requeued automatically', detail=detail, now_ms=now)
                        recovered.append({
                            "surface": "task",
                            "id": tid,
                            "action": "auto_requeued",
                            "reason": reason,
                            "backup": bk,
                            "requeue_count": rq + 1,
                            "suggestion_id": info_id,
                        })
                        continue
                    if res.get("ok"):
                        # Removed, but the task had already left "taken" (finished meanwhile): nothing requeued.
                        recovered.append({"surface": "task", "id": tid, "action": "worktree_removed", "reason": reason, "backup": res.get("backup")})
                        continue
                    bf_now = int(res.get("backup_failures") or 0) if res.get("backup_failed") else 0
                    retry = bool(bf_now) and bf_now < BACKUP_FAIL_CAP
                    recovered.append({
                        "surface": "task",
                        "id": tid,
                        "action": "auto_recovery_refused",
                        "reason": reason,
                        "message": str(res.get("message") or "")
                        + (f" Next try after {res.get('next_try_at')}." if retry else "")
                        + (f" Backup failed {bf_now} times; Watchkeeper stopped trying and the owner decides." if bf_now >= BACKUP_FAIL_CAP else ""),
                        **({"next_try_at": res.get("next_try_at")} if retry else {}),
                    })
                    if res.get("signs") or res.get("busy"):
                        continue   # it came back to life (or is being taken/finished) meanwhile: leave it alone
                    if retry:
                        continue   # tried again after BACKUP_RETRY_MS; no notice yet
                    if bf_now >= BACKUP_FAIL_CAP:
                        owner_hold = backup_gave_up = True
                    auto_refused = True
                # A clean task on its way to an automatic requeue gets no question: the requeue sends one
                # info notice (one notice per task). If the automatic path is refused (for example the
                # backup failed), the owner is asked after all.
                auto_coming = (reason == "hung_clean" and not owner and wt_present and not owner_hold
                               and rq < AUTO_REQUEUE_CAP and not auto_refused)
                if auto_coming:
                    continue
                if not notify:
                    m_chk = read_json_safe(mpath, None)
                    if not (auto_refused and isinstance(m_chk, dict) and not m_chk.get("stalled_suggestion_id")):
                        continue
                sug_id = ""
                try:
                    with _task_lock(home, tid):
                        meta = read_json_safe(mpath, None)
                        if not isinstance(meta, dict):
                            continue
                        diff_path = tdir / "change.diff"
                        if reason == "hung_dirty" and wt_present and not diff_path.is_file():
                            base = str(meta.get("base") or "").strip()
                            _ensure_private_dir(tdir)
                            diff_args = ["-C", str(wt), "diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-relative", "--no-color", f"--output={diff_path}"]
                            if base:
                                diff_args.append(base)
                            try:
                                dr = run_in_group(["git", *diff_args], timeout=6.0, register=False)
                                if dr.returncode != 0 or (diff_path.is_file() and diff_path.stat().st_size == 0):
                                    diff_path.unlink(missing_ok=True)
                                elif os.name == "posix" and diff_path.is_file():
                                    os.chmod(diff_path, 0o600)
                            except Exception:
                                try:
                                    diff_path.unlink(missing_ok=True)
                                except OSError:
                                    pass
                        idle_min = round(int(it.get("idle_ms") or 0) / 60000.0, 1)
                        meta["stalled_at"] = _iso_utc(now)
                        if reason == "hung_dirty":
                            meta["stall_note"] = f"Stalled dirty task preserved after {idle_min}m without progress."
                        else:
                            meta["stall_note"] = f"Stalled task quiet for {idle_min}m; worktree kept until the owner approves its removal."
                        sug_id = str(meta.get("stalled_suggestion_id") or "").strip()
                        gave_up_note = (
                            f" Automatic backup failed {int(meta.get('removal_backup_failures') or 0)} times"
                            f" ({meta.get('removal_backup_failed_error') or 'error'}), so Watchkeeper stopped trying; you decide."
                            if int(meta.get("removal_backup_failures") or 0) >= BACKUP_FAIL_CAP else ""
                        )
                        if not sug_id:
                            title = str(meta.get("title") or tid)[:120]
                            auto_note = not owner_hold and rq < AUTO_REQUEUE_CAP
                            if reason == "hung_dirty":
                                sug_id = _append_suggestion_line(
                                    home,
                                    title=f'Stalled task "{title}" has unsaved changes',
                                    detail=f"Task {tid} stopped updating while holding changes in {wt}. Watchkeeper preserved the worktree and saved change.diff; inspect, finish with wk-task done {tid}, or approve removal in the W panel (wk watchdog approve-remove {tid}; a backup is made first)."
                                    + (f" If Watchkeeper sees it stay quiet for {DIRTY_WAIT_FACTOR} x the stale window ({round(DIRTY_WAIT_FACTOR * t_stale / 60000.0, 1)} minutes, counted while the Mac is awake), it backs it up and requeues it by itself." if auto_note else "") + gave_up_note,
                                    now_ms=now,
                                )
                            else:
                                sug_id = _append_suggestion_line(
                                    home,
                                    title=f'Stalled task "{title}": remove its worktree?',
                                    detail=f"Task {tid} shows no sign of life (no live process, no CPU, no recent output). Nothing was deleted. Press OK in the W panel (wk watchdog approve-remove {tid}) to back up, remove the worktree and requeue the task; or choose later or keep."
                                    + (f" If Watchkeeper sees it stay quiet for {CLEAN_WAIT_FACTOR} x the stale window ({round(CLEAN_WAIT_FACTOR * t_stale / 60000.0, 1)} minutes, counted while the Mac is awake), it does this by itself." if auto_note else "") + gave_up_note,
                                    now_ms=now,
                                )
                            meta["stalled_suggestion_id"] = sug_id
                        atomic_write_json(mpath, meta)
                except TimeoutError:
                    continue
                recovered.append({
                    "surface": "task",
                    "id": tid,
                    "action": "preserved_dirty_worktree_and_suggested" if reason == "hung_dirty" else "recorded_pending_removal",
                    "reason": reason,
                    "suggestion_id": sug_id,
                })
            else:
                # Clean task whose worktree is already gone: nothing to delete, just requeue it, after
                # the same watched quiet time as a clean task with a worktree (the owner's heal: at once).
                if not owner and quiet_i < CLEAN_WAIT_FACTOR * t_stale:
                    continue
                requeued = False
                try:
                    with _task_lock(home, tid):
                        meta = read_json_safe(mpath, None)
                        if not isinstance(meta, dict) or str(meta.get("status") or "") != "taken":
                            continue
                        if int(meta.get("requeue_count") or 0) >= AUTO_REQUEUE_CAP and not owner:
                            continue
                        claim = tdir / "claim"
                        try:
                            claim.unlink()
                        except OSError:
                            pass
                        if wt.is_symlink():
                            try:
                                wt.unlink()
                            except OSError:
                                pass
                        meta["status"] = "queued"
                        meta["taken_at"] = None
                        meta["worktree"] = None
                        meta["base"] = None
                        meta["stalled_at"] = None
                        meta["stall_note"] = None
                        meta["stalled_suggestion_id"] = None
                        meta["last_activity_at"] = None
                        meta["claim_nonce"] = None
                        meta["requeue_count"] = int(meta.get("requeue_count") or 0) + 1
                        meta["attempt"] = int(meta.get("attempt") or 1) + 1
                        meta["last_recovered_at"] = now
                        atomic_write_json(mpath, meta)
                        requeued = True
                except TimeoutError:
                    continue
                if requeued:
                    recovered.append({
                        "surface": "task",
                        "id": tid,
                        "action": "requeued_clean_task",
                        "reason": reason,
                    })
        elif surf == "chat_turn":
            sid = str(it.get("session_id") or "")
            tid = str(it.get("turn_id") or "")
            chat_file = home / "chat-sessions.json"
            changed = False
            with file_lock(home / "watchdog" / "chat_sessions.lock"):
                cdata = read_json_safe(chat_file, None)
                if not isinstance(cdata, dict) or not isinstance(cdata.get("sessions"), list):
                    continue
                for sess in cdata["sessions"]:
                    if not isinstance(sess, dict) or sess.get("id") != sid:
                        continue
                    for turn in sess.get("turns") or []:
                        if isinstance(turn, dict) and turn.get("id") == tid and turn.get("status") in ("running", "preparing"):
                            turn["status"] = "error"
                            turn["updatedAt"] = now
                            turn["error"] = "Recovered stalled Watchkeeper turn automatically after inactivity timeout."
                            sess["updatedAt"] = now
                            changed = True
                            break
                if changed:
                    atomic_write_json(chat_file, cdata)
            if changed:
                recovered.append({
                    "surface": "chat_turn",
                    "id": it["id"],
                    "action": "marked_turn_error",
                    "reason": reason,
                })

    if record_learning and recovered:
        try:
            from core.snippet_store import SnippetStore  # noqa: E402

            db_target = Path(os.environ.get("WK_SNIPPET_DB") or (home / "learning" / "snippets.db")) if home == resolve_wk_home() else (home / "learning" / "snippets.db")
            db = SnippetStore(db_path=db_target)
            db.upsert_heuristic(
                rule_text=(
                    "Bind spawned child processes in detached process groups, .unref() background timers, "
                    "and enforce CPU/output-aware idle watchdogs so hanging tasks fail over or clean up without orphans."
                ),
                category="cleanup_lifecycle",
                language="all",
                scope="global",
                tags=["watchdog", "cleanup", "timers", "process-group", "timeout"],
                confidence_delta=0.05,
                ranking_delta=0.10,
            )
        except Exception:
            pass

    after_scan = scan_hanging_tasks(
        home,
        now_ms=now,
        job_stall_ms=job_stall_ms,
        task_stale_ms=task_stale_ms,
        chat_stall_ms=chat_stall_ms,
        proc_stall_ms=proc_stall_ms,
        write_summary=True,
    )
    return {
        "ok": True,
        "killed": False,
        "dry_run": False,
        "recovered": recovered,
        "recoveredCount": len(recovered),
        "remainingHungCount": after_scan["hungCount"],
        "summary": after_scan,
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="watchdog", add_help=True)
    parser.add_argument("action", nargs="?", default="scan", choices=["scan", "status", "recover", "register", "heartbeat", "unregister"])
    parser.add_argument("--wk-home", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--surface", default="", choices=["", "task", "job", "chat_turn", "process"])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pid", type=int, default=0)
    parser.add_argument("--pgid", type=int, default=0)
    parser.add_argument("--kind", default="task")
    parser.add_argument("--label", default="")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--task-id", default="")
    ns, _ = parser.parse_known_args(argv if argv is not None else sys.argv[1:])
    home = ns.wk_home or None

    if ns.action in ("scan", "status"):
        out = scan_hanging_tasks(home, write_summary=(ns.action == "scan"))
    elif ns.action == "recover":
        out = recover_hanging_tasks(home, dry_run=ns.dry_run, surface=(ns.surface or None))
    elif ns.action == "register":
        out = register_process(ns.pid, pgid=ns.pgid or None, kind=ns.kind, label=ns.label, cwd=ns.cwd, task_id=ns.task_id, wk_home=home)
    elif ns.action == "heartbeat":
        out = heartbeat_process(ns.pid, detail=ns.label, wk_home=home)
    else:
        out = unregister_process(ns.pid, wk_home=home)

    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if out.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
