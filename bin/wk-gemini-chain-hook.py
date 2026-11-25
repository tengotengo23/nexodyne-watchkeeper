#!/usr/bin/env python3
"""Antigravity Stop hook for the Gemini chain (P2-279).

Reads the Stop payload on stdin and prints {"decision":"continue","reason":...} with the owner's Desk rules and the
next queued task when every condition holds (chain on, no KILL, model_stop, fully idle, no continuation, under the
caps); otherwise {}. File reads only (plus the chain count and one crossings line); starts no process; any error
prints {}. It does not run the evidence or handoff checks: the watchkeeper Stop entry stays as it was.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    try:
        raw = sys.stdin.read()
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        from core.hook_bus import _ag_stop_output, _bridge_stop_reason_ag

        _code, out, _err = _ag_stop_output(_bridge_stop_reason_ag(payload) or None, payload)
        sys.stdout.write(out)
    except Exception:
        sys.stdout.write("{}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
