#!/usr/bin/env python3
"""Stdio MCP + SEP-1865 MCP App server for Re-Prompt (pure Python 3 stdlib)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

# Ensure sibling imports work when executed directly as a script
SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
for p in (str(PLUGIN_ROOT), str(SCRIPTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import subprocess  # noqa: E402
from proc_group import run_cli_isolated  # noqa: E402  (P2-272: process-group cleanup)
from server.orchestrator import Orchestrator, read_watchkeeper_pace  # noqa: E402
from server.reprompt_engine import (  # noqa: E402
    MODES,
    TARGETS,
    RePromptStore,
    find_executable,
    get_provider_statuses,
    list_agy_models,
    rewrite_with_provider,
)
from skill_vault import _index_file, load_index, search_skills, sync_trending_daily, vault_status  # noqa: E402

APP_URI = "ui://re-prompt/app.html"
UI_HTML_PATH = PLUGIN_ROOT / "ui" / "reprompt_app.html"
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

_STDOUT_LOCK = threading.Lock()


def log(msg: str) -> None:
    print(f"[re-prompt-mcp] {msg}", file=sys.stderr, flush=True)


def send_jsonrpc(payload: dict[str, Any]) -> None:
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with _STDOUT_LOCK:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


def send_result(req_id: Any, result: Any) -> None:
    send_jsonrpc({"jsonrpc": "2.0", "id": req_id, "result": result})


def send_error(req_id: Any, code: int, message: str, data: Any = None) -> None:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    send_jsonrpc({"jsonrpc": "2.0", "id": req_id, "error": err})


def read_ui_html() -> str:
    env_override = os.environ.get("REPROMPT_APP_HTML")
    path = Path(env_override) if env_override else UI_HTML_PATH
    if not path.is_file():
        return "<!doctype html><html><body><p>Re-Prompt UI file missing.</p></body></html>"
    return path.read_text(encoding="utf-8")


def build_state_payload(
    store: RePromptStore,
    draft: str = "",
    target: str = "",
    mode: str = "",
    session_id: str = "default",
) -> dict[str, Any]:
    pub_settings = store.public_settings()
    chosen_target = target if target in TARGETS else pub_settings["defaultTarget"]
    chosen_mode = mode if mode in MODES else pub_settings["defaultMode"]
    orch_status = Orchestrator(data_dir=store.data_dir, settings=store.load_settings()).status()
    return {
        "settings": pub_settings,
        "providers": get_provider_statuses(),
        "history": store.load_history(),
        "session": store.get_session(session_id),
        "vault": vault_status(),
        "orchestrator": orch_status,
        "draft": draft or "",
        "rewritten": None,
        "target": chosen_target,
        "mode": chosen_mode,
        "targets": list(TARGETS.values()),
        "modes": list(MODES.values()),
    }


TOOLS: list[dict[str, Any]] = [
    {
        "name": "open_reprompt",
        "title": "Re-Prompt",
        "description": (
            "Open the interactive Re-Prompt overlay composer in Antigravity so the user "
            "can write a rough prompt, rewrite it into structured AI-friendly & human-readable "
            "instructions, inspect/edit it, and send it to chat."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "draft": {"type": "string", "description": "Optional initial rough prompt text."},
                "target": {
                    "type": "string",
                    "enum": ["antigravity", "claude_code", "general"],
                    "description": "Optional target AI assistant.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["balanced", "deep_spec", "bug_fix", "refactor", "concise"],
                    "description": "Optional prompt rewriting mode.",
                },
            },
            "additionalProperties": False,
        },
        "_meta": {
            "ui": {"resourceUri": APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "aux_pane", "title": "Re-Prompt"},
                    {"type": "global", "title": "Re-Prompt"},
                ]
            },
        },
    },
    {
        "name": "rewrite_prompt",
        "title": "Rewrite Prompt",
        "description": (
            "Rewrite a rough or underspecified prompt into clear, structured, detailed "
            "instructions optimized for both AI agents and human readers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Rough prompt text to rewrite."},
                "target": {
                    "type": "string",
                    "enum": ["antigravity", "claude_code", "general"],
                    "description": "Target assistant profile.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["balanced", "deep_spec", "bug_fix", "refactor", "concise"],
                    "description": "Rewriting style/depth mode.",
                },
                "workspace_context": {
                    "type": "string",
                    "description": "Optional context about active files or workspace.",
                },
                "refinement": {
                    "type": "string",
                    "description": "Optional refinement pass: shorter, detailed, edge_cases, or add_tests.",
                },
                "previous_rewritten": {
                    "type": "string",
                    "description": "Previously rewritten prompt when applying a refinement.",
                },
                "provider": {"type": "string", "description": "Optional provider override."},
                "model": {"type": "string", "description": "Optional model override."},
                "session_id": {"type": "string", "description": "Optional session identifier for turn-aware skill routing."},
                "new_session": {"type": "boolean", "description": "Treat this prompt as Turn 1 of a fresh session."},
                "include_skills": {"type": "boolean", "description": "Enable/disable automatic vault skill routing for this call."},
                "pinned_skills": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Explicit skill names/ids to force-load or suppress ('-skill').",
                },
            },
            "required": ["prompt"],
            "additionalProperties": False,
        },
        "_meta": {
            "ui": {"resourceUri": APP_URI},
        },
    },
    {
        "name": "app_get_state",
        "title": "Get Re-Prompt State",
        "description": "App-only tool to fetch Re-Prompt settings, provider status, session, vault status, and history.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_save_settings",
        "title": "Save Re-Prompt Settings",
        "description": "App-only tool to persist Re-Prompt settings.",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_rewrite",
        "title": "App Rewrite Prompt",
        "description": "App-only tool called by the Re-Prompt UI to rewrite a prompt.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "target": {"type": "string"},
                "mode": {"type": "string"},
                "workspace_context": {"type": "string"},
                "refinement": {"type": "string"},
                "previous_rewritten": {"type": "string"},
                "provider": {"type": "string"},
                "model": {"type": "string"},
                "session_id": {"type": "string"},
                "new_session": {"type": "boolean"},
                "include_skills": {"type": "boolean"},
                "selected_skills": {"type": "array"},
            },
            "required": ["prompt"],
            "additionalProperties": True,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_new_session",
        "title": "Start New Re-Prompt Session",
        "description": "App-only tool to reset turn count and loaded skills for a fresh session.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_session_load_skill",
        "title": "Load Skill Into Session",
        "description": "App-only tool to mark a recommended skill as loaded in the active session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "skill_id": {"type": "string"},
                "skill": {"type": "object"},
            },
            "additionalProperties": True,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_session_remove_skill",
        "title": "Remove Skill From Session",
        "description": "App-only tool to remove an assumed/loaded skill from the active session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "skill_id": {"type": "string"},
            },
            "required": ["skill_id"],
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_vault_search",
        "title": "Search Profession Skill Vault",
        "description": "App-only tool to search the local Profession Skill Vault.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "domain": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_vault_sync",
        "title": "Sync or Update Profession Skill Vault",
        "description": "App-only tool to sync/update cloned GitHub skill repos and rebuild the vault index.",
        "inputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string", "enum": ["sync", "update"]}},
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_vault_discover_trending",
        "title": "Sync skills",
        "description": "Discover newly trending, highest-used, and highest-rated GitHub agent skill repositories and rebuild the local Skill Vault index.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "force": {"type": "boolean"},
                "no_clone": {"type": "boolean"},
                "max_new": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "app_list_models",
        "title": "List Antigravity Models",
        "description": "App-only tool to query available models from local agy CLI.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_clear_history",
        "title": "Clear Rewrite History",
        "description": "App-only tool to clear all saved rewrite history.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_delete_history",
        "title": "Delete History Entry",
        "description": "App-only tool to delete a single rewrite history entry.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "orchestrate_task",
        "title": "Orchestrate Task (Gemini + Claude)",
        "description": (
            "Unified single-plugin entrypoint that routes and executes tasks or multi-step workflows "
            "across Gemini and Claude based on quota headroom, spend pacing, complexity, token volume, "
            "and capability guardrails."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "Task or goal to execute or route."},
                "context": {"type": "string", "description": "Optional context, logs, or file excerpts."},
                "role": {
                    "type": "string",
                    "enum": ["auto", "execution", "orchestrator", "planning", "scout", "reviewer", "quarantine"],
                    "description": "Task role (`orchestrator` subtasks offload token-heavy coordination to Gemini).",
                },
                "workspace": {
                    "type": "string",
                    "description": "Optional workspace directory for Graphify/skill detection and execution context.",
                },
                "subtasks": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of subtasks to route individually and aggregate.",
                },
                "required_capabilities": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional capability pins (e.g. claude_code_hooks, gemini_1m_context).",
                },
                "override_provider": {
                    "type": "string",
                    "enum": ["gemini", "claude"],
                    "description": "Optional explicit provider override.",
                },
                "strict_override": {"type": "boolean", "description": "Disable fallback if override fails."},
                "dry_run": {"type": "boolean", "description": "Preview routing decision without executing."},
                "session_id": {"type": "string", "description": "Session identifier for auto skill Load/Unload tracking."},
                "auto_skills": {"type": "boolean", "description": "Auto-judge and inject skill Load/Unload directives (default true)."},
                "pinned_skills": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Explicit skill names/ids to force-load or suppress ('-skill').",
                },
            },
            "required": ["task"],
            "additionalProperties": False,
        },
        "_meta": {"ui": {"resourceUri": APP_URI}},
    },
    {
        "name": "orchestrator_status",
        "title": "Gemini + Claude Orchestrator Status",
        "description": (
            "Check detected Gemini and Claude plugins/CLIs, daily spend & token quotas, RPM limits, "
            "active cooldowns, and estimated Claude spend savings."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_meta": {"ui": {"resourceUri": APP_URI}},
    },
    {
        "name": "watchkeeper_status",
        "title": "Unified Watchkeeper + Graphify + Re-Prompt Status",
        "description": (
            "Inspect Watchkeeper runtime state (kill switch, policy pin, weekly plan meter, queue), "
            "Graphify install & workspace index status, Re-Prompt triggers, Skill Vault, and Duo Orchestrator."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "app_orchestrator_status",
        "title": "App Orchestrator Status",
        "description": "App-only tool to fetch Gemini + Claude orchestrator status and usage ledger.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_orchestrator_route_preview",
        "title": "App Orchestrator Route Preview",
        "description": "App-only dry-run preview of Gemini vs Claude route selection.",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_orchestrator_run",
        "title": "App Orchestrator Run",
        "description": "App-only tool to execute a task or workflow via the Gemini + Claude orchestrator.",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_orchestrator_update_config",
        "title": "App Update Orchestrator Config",
        "description": "App-only tool to update daily budgets, token limits, and pacing thresholds.",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_orchestrator_reset_usage",
        "title": "App Reset Orchestrator Usage",
        "description": "App-only tool to reset daily Gemini + Claude usage and cooldown counters.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "wk_command",
        "title": "Run Watchkeeper /wk Command",
        "description": (
            "Execute a Watchkeeper unified runtime v2 command: overview, status, doctor, heal, "
            "mode (auto|confirm|reprompt-only|passthrough|raw), brain (adaptive-max|carbon-high|hydrogen-xhigh), "
            "skills (list|match|reload), graph (sync|inspect|open), tasks, handoff, watchdog (status|scan|recover), "
            "learn, or help."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Subcommand (overview, status, doctor, heal, mode, brain, skills, graph, tasks, handoff, watchdog, learn, help).",
                },
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional arguments for the subcommand.",
                },
                "workspace": {"type": "string", "description": "Optional target workspace path."},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    },
    {
        "name": "wk_doctor",
        "title": "Watchkeeper Unified v2 Health Diagnostic",
        "description": "Run Watchkeeper v2 /wk doctor checks across Hook Bus, Gemini 4 engine, StateStore, Skill Router, and Graphify bridge.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace": {"type": "string", "description": "Optional target workspace path."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "wk_snippet_search",
        "title": "Search Watchkeeper Verified Snippet Database",
        "description": "Query the local-first, privacy-sanitized Watchkeeper FTS5 database for verified code snippets and learned heuristics.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query (keywords, APIs, bug pattern, or task description)."},
                "language": {"type": "string", "description": "Optional language filter (e.g. python, javascript, typescript)."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tag filters."},
                "verified_only": {"type": "boolean", "description": "If true, return only test-verified snippets."},
                "limit": {"type": "integer", "description": "Maximum snippets to return (default 5)."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "wk_snippet_save",
        "title": "Save Verified Code Snippet to Shared Database",
        "description": "Sanitize and save a verified, reusable code snippet into Watchkeeper's offline-first shared snippet database.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short descriptive title of the pattern."},
                "code": {"type": "string", "description": "Functional code snippet to persist."},
                "language": {"type": "string", "description": "Programming language (python, javascript, etc.)."},
                "context": {"type": "string", "description": "When and why to use this pattern."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Topic or domain tags."},
                "verification_status": {"type": "string", "enum": ["verified_pass", "user_corrected", "unverified"]},
                "verification_cmd": {"type": "string", "description": "Optional test command that verified this code."},
                "workspace": {"type": "string", "description": "Optional workspace path for relative path sanitization."},
            },
            "required": ["title", "code"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    },
    {
        "name": "wk_record_correction",
        "title": "Record Developer Correction & Learn Heuristic",
        "description": "Ingest a developer correction over agent output, extract a reusable heuristic rule, and store the sanitized snippet.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File path where the correction occurred."},
                "agent_code": {"type": "string", "description": "Original agent-generated code."},
                "user_code": {"type": "string", "description": "Developer-corrected code."},
                "language": {"type": "string", "description": "Optional language override."},
                "context": {"type": "string", "description": "Optional explanation of the fix."},
                "tags": {"type": "array", "items": {"type": "string"}},
                "verification_status": {"type": "string", "enum": ["verified_pass", "user_corrected", "unverified"]},
                "verification_cmd": {"type": "string"},
                "workspace": {"type": "string"},
            },
            "required": ["file_path", "agent_code", "user_code"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    },
    {
        "name": "wk_learning_status",
        "title": "Watchkeeper Learning & Shared Snippet Status",
        "description": "Inspect Watchkeeper's autonomous learning metrics, learned heuristics, and sync outbox status (optionally trigger sync).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sync": {"type": "boolean", "description": "Attempt offline-safe sync now if configured."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    },
    {
        "name": "wk_watchdog",
        "title": "Watchkeeper Dynamic Hanging-Task Watchdog",
        "description": "Scan for or safely auto-recover hanging Watchkeeper jobs, taken tasks, chat turns, and tracked processes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["status", "scan", "recover"], "description": "Watchdog action (default: scan)."},
                "dry_run": {"type": "boolean", "description": "Preview recovery without mutating state."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False},
    },
    # P2-278 API drive: one model asks the other through the official API with the user's own key (wk-ask).
    {
        "name": "ask_gemini",
        "title": "Ask Gemini (API drive)",
        "description": (
            "Ask Gemini a small, quick question through the user's own Gemini API key (default model: Gemini Flas"
            "h-Lite, the cheapest): an answer of under about 1,000 tokens over at most about 50 KB of files, when"
            " waiting is not an option. For big or long work (long files, large drafts, many steps, anything that"
            " can wait) do not use this tool: queue it for Gemini with `wk-task add` instead; it then runs on the"
            " user's Antigravity plan at no API cost, and Gemini judges and does it at the end of the user's next"
            " Antigravity turn, by the user's automation, or at one click. "
            "One-shot: Gemini cannot run tools; it "
            "returns text (an answer, a plan or a unified diff) that you review and apply yourself. "
            "Files must be inside the project; key files and anything gates.json denies are refused. "
            "Every call shows its cost and counts towards a daily cap. Do not send confidential or "
            "personal information. If no key is saved, tell the user to paste one in the W panel's API keys card."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The task, complete and self-contained."},
                "files": {"type": "array", "items": {"type": "string"}, "description": "Project files to include (paths relative to the project or absolute inside it)."},
                "model": {"type": "string", "description": "flash (default), mid, pro, or a full gemini- model id."},
                "max_out": {"type": "integer", "minimum": 1, "maximum": 64000, "description": "Maximum output tokens (default 4096)."},
                "project": {"type": "string", "description": "The project folder (a git repository root). Needed only when the IDE does not tell Watchkeeper the project (no CLAUDE_PROJECT_DIR or WK_WORKSPACE); / and the home folder are refused."},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "openWorldHint": True},
    },
    {
        "name": "ask_claude",
        "title": "Ask Claude (API drive)",
        "description": (
            "Hand one hard task to Claude through the user's own Claude API key (default model: Sonnet): "
            "hard reasoning, careful code, a second opinion or a review of a plan or diff. One-shot: Claude "
            "cannot run tools; it returns text (an answer, a plan or a unified diff) that you review and apply "
            "yourself. Files must be inside the project; key files and anything gates.json denies are refused. "
            "Every call shows its cost and counts towards a daily cap. If no key is saved, tell the user to "
            "paste one in the W panel's API keys card."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The task, complete and self-contained."},
                "files": {"type": "array", "items": {"type": "string"}, "description": "Project files to include (paths relative to the project or absolute inside it)."},
                "model": {"type": "string", "description": "sonnet (default), haiku, opus, or a full claude- model id."},
                "max_out": {"type": "integer", "minimum": 1, "maximum": 64000, "description": "Maximum output tokens (default 4096)."},
                "project": {"type": "string", "description": "The project folder (a git repository root). Needed only when the IDE does not tell Watchkeeper the project (no CLAUDE_PROJECT_DIR or WK_WORKSPACE); / and the home folder are refused."},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "openWorldHint": True},
    },
]


def _tool_ok(text: str, structured: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured,
        "isError": False,
    }


def _tool_err(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "structuredContent": {"error": message},
        "isError": True,
    }


def _real(p: str) -> Path:
    return Path(os.path.realpath(os.path.expanduser(p)))


def _fold(p: Path) -> str:
    # macOS and Windows folders are case-insensitive by default: compare case-folded
    return str(p).casefold()


def _is_root_or_home(p: Path) -> bool:
    homes = {_fold(_real(h)) for h in (os.environ.get("HOME") or "", os.path.expanduser("~")) if h}
    return p == Path(p.anchor) or _fold(p) in homes


def _inside(p: Path, root: Path) -> bool:
    a, b = _fold(p), _fold(root)
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep)


def _ask_project_dir(args: dict[str, Any]) -> tuple[Path | None, str]:
    """The review's S1: wk-ask runs in the project folder, never in the server's own folder.

    Known roots are the ones the IDE names: CLAUDE_PROJECT_DIR (Claude Code), then WK_WORKSPACE (the workspace root).
    A ``project`` argument must lie inside a known root; with no known root it must be a git repository root.
    / and the home folder are refused either way. Returns (folder, "") or (None, reason).
    """
    known = []
    for var in ("CLAUDE_PROJECT_DIR", "WK_WORKSPACE"):
        v = (os.environ.get(var) or "").strip()
        if v:
            r = _real(v)
            if _is_root_or_home(r):
                return None, f"{var} is / or the home folder, so wk-ask does not run there; open a project folder."
            if r.is_dir():
                known.append(r)
    arg = args.get("project")
    if arg not in (None, ""):
        if not isinstance(arg, str):
            return None, "project must be a folder path."
        p = _real(arg)
        if _is_root_or_home(p):
            return None, "project is / or the home folder; pass the project folder itself."
        if not p.is_dir():
            return None, f"project {arg} is not a folder."
        if known:
            if not any(_inside(p, k) for k in known):
                return None, "project is outside the project this IDE has open, so it is refused."
        elif not (p / ".git").exists():
            return None, "project must be a git repository root (a folder with .git) when the IDE names no project."
        return p, ""
    if known:
        return known[0], ""
    return None, "Watchkeeper does not know the project folder here; pass project (the project's git root)."


def _ask_api(provider: str, args: dict[str, Any]) -> dict[str, Any]:
    """P2-278: run bin/wk-ask.mjs with the request as JSON on stdin. No key in argv or env; wk-ask reads it from the key store."""
    task = args.get("task")
    if not isinstance(task, str) or not task.strip():
        return _tool_err("Missing required parameter: task")
    files = args.get("files") or []
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        return _tool_err("files must be a list of paths.")
    req: dict[str, Any] = {"task": task, "files": files}
    if args.get("model") not in (None, ""):
        req["model"] = str(args.get("model"))
    if args.get("max_out") not in (None, ""):
        req["max_out"] = args.get("max_out")
    project, why = _ask_project_dir(args)
    if project is None:
        return _tool_err(why)
    wk_ask = PLUGIN_ROOT.parent / "bin" / "wk-ask.mjs"
    node_bin = find_executable("node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
    if not wk_ask.is_file() or not node_bin:
        return _tool_err("wk-ask is not available in this install (Node.js or bin/wk-ask.mjs is missing).")
    try:
        proc = run_cli_isolated(
            [node_bin, str(wk_ask), provider, "--stdin-json", "--json"],
            timeout=300,
            cwd=str(project),
            input=json.dumps(req),
            label=f"wk-ask {provider}",
            kind="api-drive",
        )
    except subprocess.TimeoutExpired:
        return _tool_err(f"wk-ask {provider}: no answer within 300 s.")
    footer = (proc.stderr or "").strip().splitlines()
    footer_line = footer[-1] if footer else ""
    try:
        payload = json.loads((proc.stdout or "").strip().splitlines()[-1])
    except Exception:
        return _tool_err(footer_line or f"wk-ask {provider} failed (exit {proc.returncode}).")
    if not payload.get("ok"):
        return _tool_err(str(payload.get("error") or footer_line or "wk-ask failed."))
    payload["cost_line"] = footer_line
    return _tool_ok(f"{payload.get('answer', '')}\n\n---\n{footer_line}", payload)


def execute_tool(store: RePromptStore, name: str, args: dict[str, Any]) -> dict[str, Any]:
    args = args if isinstance(args, dict) else {}

    if name == "open_reprompt":
        draft = str(args.get("draft") or "")
        target = str(args.get("target") or "")
        mode = str(args.get("mode") or "")
        state = build_state_payload(store, draft=draft, target=target, mode=mode)
        if draft.strip():
            try:
                rewritten = rewrite_with_provider(
                    store,
                    prompt=draft,
                    target=state["target"],
                    mode=state["mode"],
                )
                state["rewritten"] = rewritten
                state["history"] = rewritten.get("history", state["history"])
            except Exception as exc:
                state["rewriteError"] = str(exc)
        return _tool_ok("Re-Prompt composer is ready.", state)

    if name == "rewrite_prompt":
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            return _tool_err("Missing required parameter: prompt")
        session_id = str(args.get("session_id") or "default")
        new_session = bool(args.get("new_session"))
        include_skills = args.get("include_skills")
        raw_pins = args.get("pinned_skills")
        pinned_skills = (
            [str(x).strip() for x in raw_pins if str(x).strip()]
            if isinstance(raw_pins, list)
            else None
        )
        try:
            res = rewrite_with_provider(
                store,
                prompt=prompt,
                target=args.get("target"),
                mode=args.get("mode"),
                workspace_context=str(args.get("workspace_context") or ""),
                refinement=str(args.get("refinement") or ""),
                previous_rewritten=str(args.get("previous_rewritten") or ""),
                provider_override=args.get("provider"),
                model_override=args.get("model"),
                session_id=session_id,
                session_turn=1 if new_session else None,
                include_skills=bool(include_skills) if include_skills is not None else None,
                pinned_skills=pinned_skills,
            )
            text_out = res["rewritten_prompt"]
            sr = res.get("skill_routing") or {}
            if sr.get("action") == "recommend" and sr.get("recommended_skills"):
                reason = sr.get("growth_reason") or "session scope expanded"
                rec_lines = [
                    f"> **Complexity grew** ({reason}) — recommended skills to load:",
                    *[f"> - **{s['name']}** (`{s['domain']}`): `{s['path']}`" for s in sr["recommended_skills"]],
                ]
                text_out = text_out.rstrip() + "\n\n" + "\n".join(rec_lines)
            return _tool_ok(text_out, res)
        except Exception as exc:
            return _tool_err(f"Re-Prompt failed: {exc}")

    if name == "app_get_state":
        session_id = str(args.get("session_id") or "default")
        state = build_state_payload(store, session_id=session_id)
        return _tool_ok("State loaded.", state)

    if name == "app_save_settings":
        updated = store.save_settings(args)
        return _tool_ok("Settings saved.", {"settings": updated, "providers": get_provider_statuses()})

    if name == "app_rewrite":
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            return _tool_err("Please type a prompt before running Re-Prompt.")
        session_id = str(args.get("session_id") or "default")
        new_session = bool(args.get("new_session"))
        include_skills = args.get("include_skills")
        selected_skills = args.get("selected_skills") if isinstance(args.get("selected_skills"), list) else None
        try:
            res = rewrite_with_provider(
                store,
                prompt=prompt,
                target=args.get("target"),
                mode=args.get("mode"),
                workspace_context=str(args.get("workspace_context") or ""),
                refinement=str(args.get("refinement") or ""),
                previous_rewritten=str(args.get("previous_rewritten") or ""),
                provider_override=args.get("provider"),
                model_override=args.get("model"),
                session_id=session_id,
                session_turn=1 if new_session else None,
                include_skills=bool(include_skills) if include_skills is not None else None,
                selected_skills=selected_skills,
            )
            return _tool_ok(res["rewritten_prompt"], res)
        except Exception as exc:
            return _tool_err(str(exc))

    if name == "app_new_session":
        session_id = str(args.get("session_id") or "default")
        session = store.reset_session(session_id)
        return _tool_ok("Started new session.", {"session": session})

    if name == "app_session_load_skill":
        session_id = str(args.get("session_id") or "default")
        skill = args.get("skill") if isinstance(args.get("skill"), dict) else None
        skill_id = str(args.get("skill_id") or "").strip()
        if skill is None and skill_id and _index_file().is_file():
            idx = load_index()
            for item in idx.get("skills", []):
                if item.get("id") == skill_id or item.get("name") == skill_id:
                    skill = item
                    break
        if not skill:
            return _tool_err("Skill payload or valid skill_id is required.")
        session = store.add_loaded_skill(session_id, skill)
        return _tool_ok(f"Loaded skill {skill.get('name', skill.get('id'))}.", {"session": session})

    if name == "app_session_remove_skill":
        session_id = str(args.get("session_id") or "default")
        skill_id = str(args.get("skill_id") or "").strip()
        session = store.remove_loaded_skill(session_id, skill_id)
        return _tool_ok("Removed skill from session.", {"session": session})

    if name == "app_vault_search":
        query = str(args.get("query") or "").strip()
        if not query:
            return _tool_err("Query is required.")
        if not _index_file().is_file():
            return _tool_ok("Vault index not initialized yet.", {"results": [], "vault": vault_status()})
        domain = str(args.get("domain") or "").strip() or None
        limit = max(1, min(50, int(args.get("limit") or 6)))
        hits = [
            {
                "id": s["id"],
                "name": s["name"],
                "domain": s["domain"],
                "repo": s["repo"],
                "tier": int(s.get("tier", 3)),
                "description": s.get("description", ""),
                "path": s["path"],
                "score": round(float(sc), 2),
            }
            for sc, s in search_skills(query, domain=domain, limit=limit)
        ]
        return _tool_ok(f"Found {len(hits)} skills.", {"results": hits, "vault": vault_status()})

    if name == "app_vault_sync":
        action = str(args.get("action") or ("update" if _index_file().is_file() else "sync")).strip()
        if action not in ("sync", "update"):
            action = "sync"
        vault_cli = PLUGIN_ROOT / "scripts" / "skill_vault.py"
        proc = run_cli_isolated(
            [sys.executable, str(vault_cli), action],
            timeout=300,
            label=f"skill vault {action}",
            kind="vault",
            sweep_group=True,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
            return _tool_err(f"Vault {action} failed: {err[:300]}")
        status = vault_status()
        return _tool_ok(
            f"Vault {action} complete ({status.get('skill_count', 0)} skills).",
            {"vault": status, "output": (proc.stdout or "").strip()[-1000:]},
        )

    if name == "app_vault_discover_trending":
        res = sync_trending_daily(
            force=bool(args.get("force", True)),
            do_clone=not bool(args.get("no_clone", True)),
            max_new=max(1, min(15, int(args.get("max_new") or 6))),
        )
        if res.get("killed"):
            return _tool_err("Stopped: Watchkeeper kill switch (~/.wk/KILL) is active.")
        status = vault_status()
        return _tool_ok(
            f"Discovered {res.get('discovered_total', 0)} trending GitHub skill repos (+{len(res.get('added_repos') or [])} new); {status.get('skill_count', 0)} skills indexed.",
            {"sync": res, "vault": status},
        )

    if name == "app_list_models":
        try:
            models = list_agy_models()
            return _tool_ok(f"Loaded {len(models)} models.", {"models": models})
        except Exception as exc:
            return _tool_err(f"Failed listing agy models: {exc}")

    if name == "app_clear_history":
        history = store.clear_history()
        return _tool_ok("History cleared.", {"history": history})

    if name == "app_delete_history":
        item_id = str(args.get("id") or "")
        history = store.delete_history(item_id)
        return _tool_ok("History entry deleted.", {"history": history})

    if name in ("orchestrator_status", "app_orchestrator_status"):
        orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings())
        st = orch.status()
        gem_u = st["usage"]["gemini"]
        cla_u = st["usage"]["claude"]
        gem_i = st["integrations"]["gemini"]
        cla_i = st["integrations"]["claude"]
        summary_text = (
            f"Orchestrator Status: {st['overall_status']}\n"
            f"- Gemini: ready={gem_i['available']} ({gem_i['primary_channel'] or 'none'}) | "
            f"spend ${gem_u['spend_usd']:.4f}/${gem_u['daily_budget_usd']:.2f} | "
            f"tokens {gem_u['tokens_used']:,}/{gem_u['daily_token_limit']:,}\n"
            f"- Claude: ready={cla_i['available']} ({cla_i['primary_channel'] or 'none'}) | "
            f"spend ${cla_u['spend_usd']:.4f}/${cla_u['daily_budget_usd']:.2f} | "
            f"tokens {cla_u['tokens_used']:,}/{cla_u['daily_token_limit']:,}\n"
            f"- Claude Spend Saved: ${st['claude_savings_usd']:.4f}"
        )
        return _tool_ok(summary_text, st)

    if name == "app_orchestrator_route_preview":
        task = str(args.get("task") or "").strip()
        if not task:
            return _tool_err("Task is required to preview route.")
        orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings())
        dec = orch.preview_route(
            task=task,
            context=str(args.get("context") or ""),
            role=str(args.get("role") or "auto"),
            required_capabilities=args.get("required_capabilities"),
            override_provider=args.get("override_provider") or None,
            strict_override=bool(args.get("strict_override")),
            auto_skills=args.get("auto_skills", True) is not False,
            session_id=str(args.get("session_id") or "default"),
        )
        return _tool_ok(dec.get("reason_summary") or "Route computed.", dec)

    if name in ("orchestrate_task", "app_orchestrator_run"):
        task = str(args.get("task") or "").strip()
        if not task:
            return _tool_err("Missing required parameter: task")
        orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings())
        auto_skills = args.get("auto_skills", True) is not False
        session_id = str(args.get("session_id") or "default")
        raw_pins = args.get("pinned_skills")
        pinned_skills = (
            [str(x).strip() for x in raw_pins if str(x).strip()]
            if isinstance(raw_pins, list)
            else None
        )
        if args.get("dry_run"):
            dec = orch.preview_route(
                task=task,
                context=str(args.get("context") or ""),
                role=str(args.get("role") or "auto"),
                required_capabilities=args.get("required_capabilities"),
                override_provider=args.get("override_provider") or None,
                strict_override=bool(args.get("strict_override")),
                auto_skills=auto_skills,
                session_id=session_id,
                pinned_skills=pinned_skills,
            )
            return _tool_ok(f"[Dry Run] {dec.get('provider')}: {dec.get('reason_summary')}", dec)
        try:
            ws_arg = str(args.get("workspace") or "").strip() or None
            res = orch.orchestrate_workflow(
                task=task,
                context=str(args.get("context") or ""),
                subtasks=args.get("subtasks") if isinstance(args.get("subtasks"), list) else None,
                role=str(args.get("role") or "auto"),
                required_capabilities=args.get("required_capabilities"),
                override_provider=args.get("override_provider") or None,
                strict_override=bool(args.get("strict_override")),
                auto_skills=auto_skills,
                session_id=session_id,
                pinned_skills=pinned_skills,
                workspace=ws_arg,
            )
            header = f"[{res['provider']} · {res['model']} ({res['channel']}) | {res['reason_summary']}]"
            sj = res.get("skill_judgment") or {}
            sk_notes: list[str] = []
            if sj.get("load_skills"):
                sk_notes.append("Loaded: " + ", ".join(s["name"] for s in sj["load_skills"]))
            if sj.get("unload_skills"):
                sk_notes.append("Unloaded: " + ", ".join(u["name"] for u in sj["unload_skills"]))
            sk_line = ("\n[Skills: " + " · ".join(sk_notes) + "]") if sk_notes else ""
            return _tool_ok(f"{header}{sk_line}\n\n{res['output']}", res)
        except Exception as exc:
            return _tool_err(f"Orchestration failed: {exc}")

    if name == "app_orchestrator_update_config":
        orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings())
        orch.ledger.update_config(args)
        st = orch.status()
        return _tool_ok("Orchestrator config updated.", st)

    if name == "watchkeeper_status":
        wk_status_bin = PLUGIN_ROOT.parent / "bin" / "wk-status.mjs"
        node_bin = find_executable("node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
        if wk_status_bin.is_file() and node_bin:
            try:
                proc = run_cli_isolated(
                    [node_bin, str(wk_status_bin), "--json"],
                    timeout=15,
                    label="wk-status",
                    kind="status",
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    payload = json.loads(proc.stdout)
                    wk = payload.get("watchkeeper") or {}
                    gf = payload.get("graphify") or {}
                    sv = payload.get("skill_vault") or {}
                    gf_cli = gf.get("cli") or {}
                    summary = (
                        f"Watchkeeper Unified Status v{wk.get('version', 'unknown')}\n"
                        f"- Kill switch: {'ACTIVE' if wk.get('kill_switch') else 'off'} | "
                        f"Policy pin: {wk.get('policy_pin', 'unknown')}\n"
                        f"- Graphify CLI installed: {bool(gf_cli.get('installed'))} ({gf_cli.get('version') or 'n/a'})\n"
                        f"- Skill Vault: {sv.get('skill_count', 0)} skills indexed"
                    )
                    return _tool_ok(summary, payload)
            except Exception:
                pass
        pace = read_watchkeeper_pace()
        sv = vault_status()
        orch_st = Orchestrator(data_dir=store.data_dir, settings=store.load_settings()).status()
        cfg = store.public_settings()
        fallback_payload = {
            "watchkeeper": {"pace": pace, "kill_switch": bool((pace or {}).get("kill_switch"))},
            "skill_vault": sv,
            "orchestrator": orch_st,
            "reprompt": {"settings": cfg, "providers": get_provider_statuses()},
        }
        return _tool_ok(
            f"Watchkeeper + Re-Prompt Status | Skill Vault: {sv.get('skill_count', 0)} skills",
            fallback_payload,
        )

    if name == "app_orchestrator_reset_usage":
        orch = Orchestrator(data_dir=store.data_dir, settings=store.load_settings())
        orch.ledger.reset_usage()
        st = orch.status()
        return _tool_ok("Orchestrator daily counters reset.", st)

    if name in ("wk_command", "wk_doctor"):
        wk_root = PLUGIN_ROOT.parent
        if not (wk_root / "core" / "wk_cli.py").is_file():
            return _tool_err("Watchkeeper v2 core/wk_cli.py not available in this standalone package.")
        if str(wk_root) not in sys.path:
            sys.path.insert(0, str(wk_root))
        from core.wk_cli import run_wk_cli  # noqa: E402

        ws_arg = str(args.get("workspace")).strip() if args.get("workspace") else None
        if name == "wk_doctor":
            argv = ["doctor"]
        else:
            cmd = str(args.get("command") or "status").strip()
            raw_extra = args.get("args")
            extra = [str(item) for item in raw_extra] if isinstance(raw_extra, list) else []
            argv = [cmd, *extra]
        rc, res = run_wk_cli(argv, workspace=ws_arg)
        if rc != 0 and not res.get("checks"):
            return _tool_err(str(res.get("error") or json.dumps(res, indent=2)))
        return _tool_ok(json.dumps(res, indent=2, ensure_ascii=False), res)

    if name in ("wk_snippet_search", "wk_snippet_save", "wk_record_correction", "wk_learning_status"):
        wk_root = PLUGIN_ROOT.parent
        if not (wk_root / "core" / "snippet_store.py").is_file():
            return _tool_err("Watchkeeper core/snippet_store.py not available in this package.")
        if str(wk_root) not in sys.path:
            sys.path.insert(0, str(wk_root))
        from core.learning_engine import ingest_correction  # noqa: E402
        from core.snippet_store import SnippetStore, resolve_db_path  # noqa: E402

        if name == "wk_snippet_search":
            if not resolve_db_path().is_file():
                empty = {"ok": True, "snippets": [], "heuristics": [], "total_matched": 0, "latency_ms": 0.0}
                return _tool_ok("No learned snippets stored yet.", empty)
            db = SnippetStore()
            res = db.query_snippets(
                str(args.get("query") or ""),
                language=str(args.get("language") or ""),
                tags=args.get("tags") if isinstance(args.get("tags"), list) else None,
                verified_only=bool(args.get("verified_only")),
                limit=int(args.get("limit") or 5),
            )
            heur = db.query_heuristics(str(args.get("query") or ""), language=str(args.get("language") or ""), limit=4)
            res["heuristics"] = heur
            return _tool_ok(
                f"Found {len(res['snippets'])} snippet(s) and {len(heur)} heuristic(s) in {res['latency_ms']}ms.",
                res,
            )

        if name == "wk_snippet_save":
            res = SnippetStore().save_snippet(
                title=str(args.get("title") or "").strip(),
                code=str(args.get("code") or ""),
                language=str(args.get("language") or "text"),
                context=str(args.get("context") or ""),
                tags=args.get("tags") if isinstance(args.get("tags"), list) else [],
                verification_status=str(args.get("verification_status") or "unverified"),
                verification_cmd=str(args.get("verification_cmd") or ""),
                source="mcp_save",
                workspace_dir=args.get("workspace") or None,
            )
            if not res.get("ok"):
                return _tool_err(str(res.get("reason") or "Snippet rejected by sanitizer."))
            return _tool_ok(f"Saved sanitized snippet {res['snippet']['id']} ({res['snippet']['language']}).", res)

        if name == "wk_record_correction":
            res = ingest_correction(
                file_path=str(args.get("file_path") or "snippet.txt"),
                agent_code=str(args.get("agent_code") or ""),
                user_code=str(args.get("user_code") or ""),
                language=str(args.get("language") or ""),
                context=str(args.get("context") or ""),
                tags=args.get("tags") if isinstance(args.get("tags"), list) else None,
                workspace_dir=args.get("workspace") or None,
                verification_status=str(args.get("verification_status") or "user_corrected"),
                verification_cmd=str(args.get("verification_cmd") or ""),
            )
            if not res.get("ok"):
                return _tool_err(str(res.get("reason") or "Failed to record correction."))
            return _tool_ok(
                f"Recorded correction ({res.get('category')}) -> snippet {res['snippet']['id']}.",
                res,
            )

        if name == "wk_learning_status":
            if not resolve_db_path().is_file() and not args.get("sync"):
                st = {"available": False, "snippetCount": 0, "verifiedCount": 0, "correctionCount": 0, "heuristicCount": 0, "pendingSyncCount": 0}
                return _tool_ok("Watchkeeper learning store not initialized yet (0 snippets).", st)
            db = SnippetStore()
            st = db.stats()
            if args.get("sync"):
                st["sync"] = db.sync_now()
            return _tool_ok(
                f"Learning DB: {st['snippetCount']} snippets ({st['verifiedCount']} verified), {st['correctionCount']} corrections, {st['heuristicCount']} heuristics.",
                st,
            )

    if name == "wk_watchdog":
        wk_root = PLUGIN_ROOT.parent
        if not (wk_root / "core" / "watchdog.py").is_file():
            return _tool_err("Watchkeeper core/watchdog.py not available in this package.")
        if str(wk_root) not in sys.path:
            sys.path.insert(0, str(wk_root))
        from core.watchdog import recover_hanging_tasks, scan_hanging_tasks  # noqa: E402

        act = str(args.get("action") or "scan").strip().lower()
        if act == "recover":
            res = recover_hanging_tasks(dry_run=bool(args.get("dry_run")))
            if not res.get("ok"):
                return _tool_err(str(res.get("reason") or "Watchdog recovery refused."))
            cnt = int(res.get("recoveredCount") or 0)
            return _tool_ok(
                f"Watchdog recovery finished: {cnt} item(s) handled (dry_run={bool(res.get('dry_run'))}).",
                res,
            )
        if act in ("scan", "status"):
            res = scan_hanging_tasks(write_summary=(act == "scan"))
            return _tool_ok(
                f"Watchdog {act}: hung={res.get('hungCount', 0)}, warning={res.get('warningCount', 0)}, active={res.get('activeCount', 0)}.",
                res,
            )
        return _tool_err(f"Unknown watchdog action: {act}")

    if name in ("ask_gemini", "ask_claude"):
        return _ask_api("gemini" if name == "ask_gemini" else "claude", args)

    raise KeyError(f"Unknown tool: {name}")


def handle_request(store: RePromptStore, executor: ThreadPoolExecutor, msg: dict[str, Any]) -> None:
    req_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    is_notification = "id" not in msg or req_id is None

    if method == "notifications/initialized":
        return

    if method == "initialize":
        client_ver = str(params.get("protocolVersion") or "")
        proto_ver = client_ver if client_ver in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0]
        send_result(
            req_id,
            {
                "protocolVersion": proto_ver,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"subscribe": False, "listChanged": False},
                },
                "serverInfo": {"name": "re-prompt", "version": "1.3.0"},
            },
        )
        return

    if method == "ping":
        if not is_notification:
            send_result(req_id, {})
        return

    if method == "tools/list":
        send_result(req_id, {"tools": TOOLS})
        return

    if method == "resources/list":
        send_result(
            req_id,
            {
                "resources": [
                    {
                        "uri": APP_URI,
                        "name": "Re-Prompt Overlay App",
                        "description": "Interactive Re-Prompt overlay composer and prompt engineering studio.",
                        "mimeType": "text/html;profile=mcp-app",
                        "_meta": {"ui": {"prefersBorder": False}},
                    }
                ]
            },
        )
        return

    if method == "resources/read":
        uri = str(params.get("uri") or "")
        if uri != APP_URI:
            send_error(req_id, -32602, f"Unknown resource URI: {uri}")
            return
        html = read_ui_html()
        send_result(
            req_id,
            {
                "contents": [
                    {
                        "uri": APP_URI,
                        "mimeType": "text/html;profile=mcp-app",
                        "text": html,
                        "_meta": {"ui": {"prefersBorder": False}},
                    }
                ]
            },
        )
        return

    if method == "prompts/list":
        send_result(req_id, {"prompts": []})
        return

    if method == "tools/call":
        tool_name = str(params.get("name") or "")
        tool_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}

        def _run_and_reply() -> None:
            try:
                result = execute_tool(store, tool_name, tool_args)
                send_result(req_id, result)
            except KeyError as exc:
                send_error(req_id, -32602, str(exc))
            except Exception as exc:
                log(f"Tool execution error ({tool_name}): {exc}")
                send_result(req_id, _tool_err(str(exc)))

        # Run slow / external-CLI tools asynchronously so ping and state tools stay responsive
        if tool_name in (
            "rewrite_prompt",
            "app_rewrite",
            "app_list_models",
            "open_reprompt",
            "app_vault_sync",
            "app_vault_discover_trending",
            "orchestrate_task",
            "app_orchestrator_run",
            "wk_command",
            "wk_doctor",
            "ask_gemini",
            "ask_claude",
        ):
            executor.submit(_run_and_reply)
        else:
            _run_and_reply()
        return

    if not is_notification:
        send_error(req_id, -32601, f"Method not found: {method}")


def read_next_jsonrpc_message(stream: Any) -> dict[str, Any] | None:
    """Read either newline-delimited JSON or Content-Length framed JSON-RPC."""
    while True:
        raw_line = stream.readline()
        if not raw_line:
            return None
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line.lower().startswith("content-length:"):
            try:
                length = int(line.split(":", 1)[1].strip())
            except ValueError:
                continue
            while True:
                hdr = stream.readline()
                if not hdr or not hdr.strip():
                    break
            body = stream.read(length)
            if not body:
                return None
            return json.loads(body.decode("utf-8", errors="replace"))
        return json.loads(line)


def main() -> int:
    # P2-272 canon (belt and braces; the engine's called_from_claude_code is the rule): an MCP server hosted
    # by Claude Code never reaches agy or Gemini. Set here, not at import, so importing tests keep their env.
    if os.environ.get("CLAUDECODE") == "1":
        os.environ.setdefault("WK_CALLER", "claude_code")
    parser = argparse.ArgumentParser(description="Re-Prompt MCP stdio server")
    parser.add_argument("--data-dir", default="", help="Persistent data directory")
    args, _unknown = parser.parse_known_args()

    data_dir_arg = str(args.data_dir or "").strip()
    if data_dir_arg.startswith("${"):
        data_dir_arg = ""
    store = RePromptStore(data_dir_arg or None)
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="reprompt-worker")
    log(f"Started (data_dir={store.data_dir})")

    try:
        while True:
            try:
                msg = read_next_jsonrpc_message(sys.stdin.buffer)
            except json.JSONDecodeError as exc:
                log(f"Invalid JSON input: {exc}")
                continue
            if msg is None:
                break
            if isinstance(msg, dict):
                handle_request(store, executor, msg)
    finally:
        executor.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
