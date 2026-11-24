#!/usr/bin/env python3
"""Launcher wrapper for the Claude Code plugin MCP server."""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

for candidate in (
    PLUGIN_ROOT / "server" / "reprompt_mcp_server.py",
    PLUGIN_ROOT.parent / "server" / "reprompt_mcp_server.py",
    PLUGIN_ROOT / "reprompt" / "server" / "reprompt_mcp_server.py",
    PLUGIN_ROOT.parent / "reprompt" / "server" / "reprompt_mcp_server.py",
):
    if candidate.is_file():
        os.execv(sys.executable, [sys.executable, str(candidate), *sys.argv[1:]])

sys.stderr.write("re-prompt: could not locate reprompt_mcp_server.py\n")
raise SystemExit(1)
