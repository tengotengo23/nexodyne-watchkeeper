#!/usr/bin/env python3
"""Cross-platform isolated clipboard I/O and nested-backtick-safe fence utilities."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


def format_standalone_fence(spec_text: str, language: str = "markdown") -> str:
    """Wrap standalone /reprompt output in a single outer code fence safe for nested fences."""
    body = (spec_text or "").strip()
    runs = [len(m.group(0)) for m in re.finditer(r"`{3,}", body)]
    fence_len = max(runs, default=2) + 1 if runs else 3
    fence = "`" * max(3, fence_len)
    return f"{fence}{language}\n{body}\n{fence}"


def extract_fenced_rewrite(text: str) -> str:
    """Extract the content of the first outermost fenced code block (3+ or 4+ backticks)."""
    s = (text or "").strip()
    if not s:
        return ""
    lines = s.splitlines()
    start_idx = -1
    fence = ""
    for i, line in enumerate(lines):
        m = re.match(r"^\s*(`{3,})(?:[A-Za-z0-9_-]+)?\s*$", line)
        if m:
            start_idx = i
            fence = m.group(1)
            break
    if start_idx >= 0:
        fence_len = len(fence)
        depth = 0
        open_same_re = re.compile(rf"^\s*`{{{fence_len}}}(?!`)[A-Za-z0-9_-]+\s*$")
        close_exact_re = re.compile(rf"^\s*`{{{fence_len}}}(?!`)\s*$")
        for j in range(start_idx + 1, len(lines)):
            if open_same_re.match(lines[j]):
                depth += 1
            elif close_exact_re.match(lines[j]):
                if depth > 0:
                    depth -= 1
                else:
                    return "\n".join(lines[start_idx + 1 : j]).strip()
    return s


def copy_to_clipboard(text: str, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Copy text strictly in explicit standalone mode; supports WK_CLIPBOARD_FILE for isolation."""
    env_map = env if env is not None else os.environ
    payload = text or ""

    test_sink = env_map.get("WK_CLIPBOARD_FILE")
    if test_sink:
        sink = Path(test_sink).expanduser()
        sink.parent.mkdir(parents=True, exist_ok=True)
        sink.write_text(payload, encoding="utf-8")
        return {"ok": True, "backend": "wk_clipboard_file", "exit_code": 0, "chars": len(payload)}

    candidates: list[list[str]] = [
        ["pbcopy"],
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
        ["clip.exe"],
    ]
    for argv in candidates:
        exe = shutil.which(argv[0])
        if not exe:
            continue
        try:
            from core.watchdog import run_in_group  # P2-272: group cleanup on timeout

            proc = run_in_group(
                [exe, *argv[1:]],
                input=payload,
                timeout=5,
                kind="clipboard",
                label=argv[0],
                register=False,
            )
            if proc.returncode == 0:
                return {"ok": True, "backend": argv[0], "exit_code": 0, "chars": len(payload)}
            return {
                "ok": False,
                "backend": argv[0],
                "exit_code": proc.returncode,
                "error": (proc.stderr or "").strip()[:200],
            }
        except Exception as exc:
            return {"ok": False, "backend": argv[0], "exit_code": -1, "error": str(exc)[:200]}

    return {"ok": False, "backend": "none", "exit_code": 127, "error": "No supported clipboard binary found"}
