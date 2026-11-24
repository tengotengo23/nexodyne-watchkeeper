"""P2-272: run a CLI in its own process group so a timeout ends the whole group (no PPID-1 orphans).

Shared by the Re-Prompt engine, hooks, skill vault, orchestrator and MCP server. Inside the Watchkeeper repo it
uses core.watchdog.run_in_group (process registry + CPU-aware watchdog); the standalone Re-Prompt bundle falls back
to the same pattern here: new session, SIGTERM to the group, a short grace, then SIGKILL.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

WK_ROOT = Path(__file__).resolve().parents[2]


def _watchdog_runner():
    try:
        if (WK_ROOT / "core" / "watchdog.py").is_file() and str(WK_ROOT) not in sys.path:
            sys.path.insert(0, str(WK_ROOT))
        from core.watchdog import run_in_group  # noqa: E402

        return run_in_group
    except Exception:
        return None


def run_cli_isolated(
    cmd: list[str],
    *,
    timeout: float,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    input: str | None = None,
    label: str = "",
    kind: str = "reprompt",
    sweep_group: bool = False,
    grace_s: float = 1.5,
) -> subprocess.CompletedProcess:
    """Like subprocess.run(capture_output=True, text=True, timeout=...), but the child gets its own process group.

    On a timeout (or any interruption) the whole group gets SIGTERM, then SIGKILL after ``grace_s``, and
    subprocess.TimeoutExpired is raised as usual. ``sweep_group`` also ends helpers the child left behind after a
    normal exit (for tools such as graphify that start worker pools).
    """
    runner = _watchdog_runner()
    if runner is not None:
        return runner(cmd, timeout=timeout, cwd=cwd, env=env, input=input, kind=kind, label=label,
                      grace_ms=int(grace_s * 1000), sweep_group=sweep_group)

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

    def _end_group() -> None:
        if posix:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                proc.wait(timeout=grace_s)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
        else:
            proc.kill()

    try:
        out, err = proc.communicate(input=input, timeout=timeout)
    except BaseException as exc:
        _end_group()
        try:
            proc.communicate(timeout=1.0)
        except Exception:
            pass
        if isinstance(exc, subprocess.TimeoutExpired):
            raise subprocess.TimeoutExpired(cmd, timeout) from None
        raise
    if sweep_group and posix:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
