#!/usr/bin/env python3
"""Antigravity lifecycle hook & CLI bridge for Watchkeeper autonomous learning & shared snippets."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.learning_engine import (  # noqa: E402
    build_learning_context,
    detect_and_record_correction,
    infer_language,
    ingest_correction,
    promote_session_snippets_on_test_pass,
    scan_workspace_for_corrections,
    track_agent_edit,
)
from core.snippet_store import (  # noqa: E402
    SnippetStore,
    is_kill_switch_active,
    resolve_db_path,
    resolve_learning_dir,
)
from core.state_store import read_json_safe, atomic_write_json  # noqa: E402

TRIVIAL_ACK_RE = re.compile(r"^\s*(?:ok|okay|yes|no|y|n|thanks|thank you|cool|great|done|continue|go|1|2)\s*[.!]?\s*$", re.IGNORECASE)
WRITE_TOOL_NAMES = {
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "write_file",
    "edit_file",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
}


def _workspace_from_payload(payload: dict[str, Any]) -> str:
    ws_list = payload.get("workspacePaths")
    return str(payload.get("cwd") or (ws_list[0] if isinstance(ws_list, list) and ws_list else "") or os.getcwd())


def _safe_conv_id(conv_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (conv_id or "default").strip())
    return cleaned[:96] or "default"


def _handle_post_tool_use(payload: dict[str, Any]) -> dict[str, Any]:
    if is_kill_switch_active():
        return {}
    tc = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
    tool_name = str(tc.get("name") or payload.get("tool_name") or "")
    args = tc.get("args") if isinstance(tc.get("args"), dict) else (
        payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    )
    ws = _workspace_from_payload(payload)
    sid = _safe_conv_id(str(payload.get("conversationId") or payload.get("session_id") or "default"))

    if tool_name in WRITE_TOOL_NAMES:
        target = args.get("TargetFile") or args.get("target_file") or args.get("file_path") or args.get("path") or args.get("Path") or ""
        if isinstance(target, str) and target.strip():
            track_agent_edit(file_path=target.strip(), session_id=sid, workspace_dir=ws, tool_name=tool_name)
        return {}

    if tool_name in ("run_command", "Bash"):
        t_resp = payload.get("tool_response") if isinstance(payload.get("tool_response"), dict) else {}
        exit_code = t_resp.get("exitCode") if t_resp.get("exitCode") is not None else t_resp.get("exit_code")
        if exit_code is None:
            exit_code = payload.get("exitCode") if payload.get("exitCode") is not None else payload.get("exit_code")
        resp_out = (
            str(t_resp.get("stdout") or "")
            + "\n"
            + str(t_resp.get("stderr") or "")
            + "\n"
            + str(payload.get("output") or "")
        )
        failed = (
            bool(payload.get("error"))
            or bool(t_resp.get("is_error"))
            or bool(payload.get("interrupted"))
            or (isinstance(exit_code, int) and exit_code != 0)
            or bool(re.search(r"\bWK_EXIT=([1-9]\d*)\b", resp_out))
            or bool(re.search(r"(?:^|\n)\s*(?:FAIL\b|FAILED\b|AssertionError:|Traceback \(most recent call last\)|not ok \d+)", resp_out))
        )
        if not failed:
            cmd = str(args.get("CommandLine") or args.get("command") or args.get("cmd") or "").strip()
            if cmd:
                promote_session_snippets_on_test_pass(session_id=sid, workspace_dir=ws, test_command=cmd)
    return {}


def _handle_pre_invocation(payload: dict[str, Any]) -> dict[str, Any]:
    if is_kill_switch_active():
        return {}
    if os.environ.get("REPROMPT_INTERNAL_CALL") == "1" or os.environ.get("WK_SUBAGENT_ACTIVE") == "1":
        return {}

    user_input = str(payload.get("lastUserInput") or payload.get("prompt") or "").strip()
    if not user_input or TRIVIAL_ACK_RE.match(user_input):
        return {}
    if re.match(r"^\s*(?:raw|rp-raw|rp-spec|rp-deep|rp-bug|rp-refactor|rp-concise|rp-short|reprompt|rp)\s*:", user_input, re.IGNORECASE):
        return {}
    if "[WK-SPEC-V2:" in user_input or "Learned Guardrails & Verified Snippets" in user_input:
        return {}

    ws = _workspace_from_payload(payload)
    sid = _safe_conv_id(str(payload.get("conversationId") or payload.get("session_id") or "default"))
    scan_workspace_for_corrections(workspace_dir=ws, session_id=sid)

    if not resolve_db_path().is_file():
        return {}

    prompt_hash = hashlib.sha256(user_input.encode("utf-8", errors="replace")).hexdigest()
    dedup_path = resolve_learning_dir() / f"hook_dedup_{sid}.json"
    prev = read_json_safe(dedup_path, {})
    if isinstance(prev, dict) and prev.get("last_prompt_hash") == prompt_hash:
        return {}

    ctx = build_learning_context(user_input, workspace_dir=ws, max_snippets=3, max_heuristics=4)
    if not ctx.get("has_context"):
        return {}

    atomic_write_json(dedup_path, {"last_prompt_hash": prompt_hash})
    s_cnt = len(ctx.get("snippets") or [])
    h_cnt = len(ctx.get("heuristics") or [])
    return {
        "injectSteps": [
            {
                "systemMessage": {
                    "systemMessage": ctx["markdown"],
                    "metadata": {
                        "user_markdown": f"🧠 Watchkeeper Memory: {s_cnt} verified snippet(s) · {h_cnt} learned heuristic(s) ({ctx['latency_ms']:.1f}ms)"
                    },
                }
            }
        ]
    }


def _handle_stop(payload: dict[str, Any]) -> dict[str, Any]:
    if not is_kill_switch_active():
        ws = _workspace_from_payload(payload)
        sid = _safe_conv_id(str(payload.get("conversationId") or payload.get("session_id") or "default"))
        scan_workspace_for_corrections(workspace_dir=ws, session_id=sid)
    return {}


def _run_cli_action(action: str, raw_stdin: str) -> dict[str, Any]:
    payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    if not isinstance(payload, dict):
        payload = {}

    if action == "search":
        if not resolve_db_path().is_file():
            return {"ok": True, "snippets": [], "total_matched": 0, "latency_ms": 0.0}
        return SnippetStore().query_snippets(
            str(payload.get("query") or ""),
            language=str(payload.get("language") or ""),
            tags=payload.get("tags") if isinstance(payload.get("tags"), list) else None,
            verified_only=bool(payload.get("verified_only")),
            limit=int(payload.get("limit") or 8),
        )

    if action == "save":
        return SnippetStore().save_snippet(
            title=str(payload.get("title") or "IDE Snippet"),
            code=str(payload.get("code") or ""),
            language=str(payload.get("language") or infer_language(str(payload.get("file_path") or ""))),
            context=str(payload.get("context") or ""),
            tags=payload.get("tags") if isinstance(payload.get("tags"), list) else [],
            verification_status=str(payload.get("verification_status") or "unverified"),
            verification_cmd=str(payload.get("verification_cmd") or ""),
            source=str(payload.get("source") or "ide_capture"),
            workspace_dir=payload.get("workspace_dir") or None,
        )

    if action == "record":
        return ingest_correction(
            file_path=str(payload.get("file_path") or "snippet.txt"),
            agent_code=str(payload.get("agent_code") or ""),
            user_code=str(payload.get("user_code") or ""),
            language=str(payload.get("language") or ""),
            context=str(payload.get("context") or ""),
            tags=payload.get("tags") if isinstance(payload.get("tags"), list) else None,
            session_id=str(payload.get("session_id") or "cli"),
            workspace_dir=payload.get("workspace_dir") or None,
            verification_status=str(payload.get("verification_status") or "user_corrected"),
            verification_cmd=str(payload.get("verification_cmd") or ""),
        )

    if action == "record-save":
        fp = str(payload.get("file_path") or "").strip()
        if not fp:
            return {"ok": False, "detected": False, "reason": "missing_file_path"}
        return detect_and_record_correction(
            file_path=fp,
            new_content=payload.get("content"),
            session_id=str(payload.get("session_id") or "ide"),
            workspace_dir=payload.get("workspace_dir") or None,
            context=str(payload.get("context") or "IDE document save"),
        )

    if action == "stats":
        if not resolve_db_path().is_file():
            return {"available": False, "snippetCount": 0, "verifiedCount": 0, "correctionCount": 0, "heuristicCount": 0}
        return SnippetStore().stats()

    if action == "sync":
        return SnippetStore().sync_now(
            sync_dir=payload.get("sync_dir") or None,
            sync_url=payload.get("sync_url") or None,
        )

    return {"ok": False, "error": f"Unknown action: {action}"}


def main() -> int:
    mode = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    raw_stdin = sys.stdin.read()
    is_cli_action = mode in ("search", "save", "record", "record-save", "stats", "sync")
    try:
        if is_cli_action:
            out = _run_cli_action(mode, raw_stdin)
            print(json.dumps(out, ensure_ascii=False))
            return 0 if out.get("ok", True) is not False else 1

        payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
        if not isinstance(payload, dict):
            payload = {}

        if mode == "PostToolUse":
            print(json.dumps(_handle_post_tool_use(payload), ensure_ascii=False))
        elif mode == "PreInvocation":
            print(json.dumps(_handle_pre_invocation(payload), ensure_ascii=False))
        elif mode == "Stop":
            print(json.dumps(_handle_stop(payload), ensure_ascii=False))
        else:
            print("{}")
        return 0
    except Exception as exc:
        if is_cli_action:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            return 1
        print("{}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
