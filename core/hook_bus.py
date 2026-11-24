#!/usr/bin/env python3
"""Deterministic Topological DAG Hook Multiplexer Bus for Watchkeeper Unified Runtime v2.0."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.clipboard_io import copy_to_clipboard, extract_fenced_rewrite  # noqa: E402
from core.fast_path import evaluate_fast_path  # noqa: E402
from core.gemini_engine import Gemini4Engine  # noqa: E402
from core.graph_bridge import check_blast_radius, sync_and_load_graph  # noqa: E402
from core.learning_engine import (  # noqa: E402
    promote_session_snippets_on_test_pass,
    scan_workspace_for_corrections,
    track_agent_edit,
)
from core.prompt_compiler import compile_prompt_v2  # noqa: E402
from core.state_store import StateStore, atomic_write_json, file_lock, read_json_safe  # noqa: E402
from core.watchdog import recover_hanging_tasks, run_in_group, scan_hanging_tasks  # noqa: E402

BIN_DIR = ROOT / "bin"


def _find_node() -> str:
    env_node = os.environ.get("WK_NODE")
    if env_node and Path(env_node).is_file():
        return env_node
    w = shutil.which("node")
    if w:
        return w
    for cand in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if Path(cand).is_file():
            return cand
    return "node"


def _run_node_script(script_name: str, args: list[str], raw_input: str, timeout_s: float = 20.0) -> subprocess.CompletedProcess[str]:
    node = _find_node()
    script = BIN_DIR / script_name
    argv = [node, str(script), *args]
    try:
        return run_in_group(
            argv,
            input=raw_input,
            timeout=timeout_s,
            env=dict(os.environ),
            kind="hook",
            label=f"hook {script_name}",
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return subprocess.CompletedProcess(
            args=argv,
            returncode=2,
            stdout="",
            stderr=f"hook subprocess failed ({script_name}): {exc}\n",
        )


def _wk_home_dir() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()


def _kill_switch_active(payload: dict[str, Any] | None = None) -> bool:
    return (_wk_home_dir() / "KILL").exists()


@contextmanager
def _exclusive_file_lock(lock_path: Path, wait_s: float = 5.0, stale_s: float = 60.0):
    """Cross-language O_EXCL token-verified lock compatible with Node withFileLock."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}:{time.time()}:{uuid.uuid4().hex[:8]}"
    deadline = time.monotonic() + wait_s
    acquired = False
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, (token + "\n").encode("utf-8"))
            finally:
                os.close(fd)
            acquired = True
            break
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > stale_s:
                    lock_path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise TimeoutError(f"timed out waiting for lock {lock_path}")
            time.sleep(0.03)
    try:
        yield
    finally:
        if acquired:
            try:
                if lock_path.is_file() and lock_path.read_text(encoding="utf-8").strip() == token:
                    lock_path.unlink(missing_ok=True)
            except OSError:
                pass


def _consume_shared_handoff(workspace_dir: Path, target_engine: str = "claude") -> str:
    """Atomically claim any fresh unconsumed shared-workspace handoff for target_engine."""
    if _kill_switch_active():
        return ""
    wk_home = _wk_home_dir()
    shared_file = wk_home / "shared-workspace.json"
    if not shared_file.is_file():
        return ""
    try:
        ws = str(workspace_dir.expanduser().resolve())
    except OSError:
        ws = str(workspace_dir)
    if not ws:
        return ""
    try:
        with _exclusive_file_lock(wk_home / "shared-workspace.lock", wait_s=5.0, stale_s=60.0):
            raw = read_json_safe(shared_file, None)
            workspaces = raw.get("workspaces") if isinstance(raw, dict) else None
            if not isinstance(workspaces, dict):
                return ""
            entry = workspaces.get(ws)
            if not isinstance(entry, dict) or entry.get("consumed_by"):
                return ""
            from_eng = str(entry.get("from_engine") or "")
            to_eng = str(entry.get("to_engine") or "any")
            if not from_eng or from_eng == target_engine or to_eng not in (target_engine, "any"):
                return ""
            updated_str = str(entry.get("updated_at") or "").strip()
            if not updated_str:
                return ""
            updated_dt = dt.datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
            if updated_dt.tzinfo is None:
                updated_dt = updated_dt.replace(tzinfo=dt.timezone.utc)
            age_sec = (dt.datetime.now(dt.timezone.utc) - updated_dt).total_seconds()
            if age_sec < -60 or age_sec > 7200:
                return ""
            entry["consumed_by"] = target_engine
            entry["consumed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            workspaces[ws] = entry
            atomic_write_json(shared_file, raw)
            parts = [
                f"[Shared Workspace Handoff from {from_eng}]",
                f"Workspace: {ws}",
                f"Context: {entry.get('title') or 'Active session handoff'}",
            ]
            if entry.get("summary"):
                parts.append(str(entry["summary"]))
            if entry.get("next_steps"):
                parts.append(f"Next Steps:\n{entry['next_steps']}")
            if entry.get("task_id"):
                parts.append(f"Watchkeeper Task: {entry['task_id']}" + (f" (Worktree: {entry['worktree']})" if entry.get("worktree") else ""))
            parts.append("Continue seamlessly in this shared workspace without asking the user to re-explain handover.")
            return "\n".join(parts)
    except Exception:
        return ""


def _workspace_from_payload(payload: dict[str, Any]) -> Path:
    for key in ("cwd", "workspace"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return Path(v).expanduser()
    ws_list = payload.get("workspacePaths")
    if isinstance(ws_list, list):
        for item in ws_list:
            if isinstance(item, str) and item.strip():
                return Path(item).expanduser()
    return Path.cwd()


def _session_id_from_payload(payload: dict[str, Any]) -> str:
    return str(payload.get("session_id") or payload.get("conversationId") or "claude_default")


def _extract_edited_paths(payload: dict[str, Any]) -> list[str]:
    tool = str(payload.get("tool_name") or payload.get("tool") or "")
    t_in = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    if not t_in and isinstance(payload.get("toolCall"), dict):
        tc = payload["toolCall"]
        tool = str(tc.get("name") or tool)
        t_in = tc.get("args") if isinstance(tc.get("args"), dict) else {}

    paths: list[str] = []
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit", "write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "edit_file"):
        for k in ("file_path", "path", "TargetFile", "target_file", "Path"):
            v = t_in.get(k)
            if isinstance(v, str) and v.strip():
                paths.append(v.strip())
    elif isinstance(payload.get("modified_files"), list):
        for v in payload["modified_files"]:
            if isinstance(v, str) and v.strip():
                paths.append(v.strip())
    return paths


def _is_antigravity(event_name: str, payload: dict[str, Any]) -> bool:
    """P2-272: Antigravity hosts use camelCase payloads (conversationId) and the PreInvocation event."""
    if event_name == "PreInvocation":
        return True
    host = os.environ.get("WK_HOST", "").strip().lower()
    if host:
        return host == "antigravity"
    return bool(payload.get("conversationId")) and not payload.get("session_id") and not payload.get("hook_event_name")


def _standalone_reprompt_hook_registered(ws: str | Path | None = None) -> bool:
    """P2-272: True when Claude Code's own settings already run the standalone Re-Prompt hook (run-inline-hook.py)
    on every prompt. The Watchkeeper plugin then leaves inline prompts to it, so no prompt is rewritten twice.
    Only the hooks section is looked at; nothing from the settings files is printed or kept."""
    home = os.environ.get("HOME") or ""
    bases = [Path(home)] if home else []
    if ws:
        bases.append(Path(ws))
    for base in bases:
        for name in ("settings.json", "settings.local.json"):
            try:
                data = json.loads((base / ".claude" / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            hooks = data.get("hooks") if isinstance(data, dict) else None
            ups = hooks.get("UserPromptSubmit") if isinstance(hooks, dict) else None
            if ups and "run-inline-hook.py" in json.dumps(ups):
                return True
    return False


def _ag_inject(text: str, badge: str = "") -> str:
    """P2-272: the exact Antigravity injectSteps shape (no "type" key)."""
    return json.dumps({
        "injectSteps": [{"systemMessage": {"systemMessage": text, "metadata": {"user_markdown": badge}}}]
    }) + "\n"


def _ag_badge(text: str) -> str:
    """Compact one-line badge for the Antigravity UI."""
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line[:160]
    return ""


def _ag_stop_output(block_reason: str | None, payload: dict[str, Any], notes: list[str] | None = None) -> tuple[int, str, str]:
    """P2-272: Antigravity Stop answers {} normally; {"decision":"continue"} only when blocking and no continuation is active."""
    err = (" | ".join(n for n in (notes or []) if n) + "\n") if notes and any(notes) else ""
    if block_reason and payload.get("continuationActive") is not True:
        return 0, json.dumps({"decision": "continue", "reason": block_reason}) + "\n", err
    return 0, "{}\n", err


def _block_reason(stdout: str) -> str:
    try:
        parsed = json.loads(stdout or "")
    except ValueError:
        return (stdout or "").strip() or "Watchkeeper blocked the stop."
    if isinstance(parsed, dict):
        return str(parsed.get("reason") or parsed.get("systemMessage") or "Watchkeeper blocked the stop.")
    return "Watchkeeper blocked the stop."


def _merge_hook_outputs(outputs: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministically merge hookSpecificOutput / systemMessage / decision fields."""
    merged: dict[str, Any] = {}
    ctx_parts: list[str] = []
    sys_msgs: list[str] = []
    hook_event_name: str | None = None

    for o in outputs:
        if not isinstance(o, dict):
            continue
        if o.get("decision") == "block":
            return o
        if isinstance(o.get("systemMessage"), str) and o["systemMessage"].strip():
            sys_msgs.append(o["systemMessage"].strip())
        hso = o.get("hookSpecificOutput")
        if isinstance(hso, dict):
            if hso.get("hookEventName") and not hook_event_name:
                hook_event_name = str(hso["hookEventName"])
            if isinstance(hso.get("additionalContext"), str) and hso["additionalContext"].strip():
                ctx_parts.append(hso["additionalContext"].strip())

    if ctx_parts:
        merged["hookSpecificOutput"] = {
            "hookEventName": hook_event_name or "WatchkeeperUnified",
            "additionalContext": "\n\n".join(ctx_parts),
        }
    if sys_msgs:
        merged["systemMessage"] = " | ".join(sys_msgs)
    return merged


def handle_event(
    event_name: str,
    raw_stdin: str,
    *,
    store: StateStore | None = None,
    bypass_subprocesses: bool = False,
) -> tuple[int, str, str]:
    """Dispatch one lifecycle hook event across registered Watchkeeper handlers in topological order."""
    try:
        payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    ws = _workspace_from_payload(payload)
    sid = _session_id_from_payload(payload)
    is_ag = _is_antigravity(event_name, payload)
    rt = store or StateStore(workspace_dir=ws)

    # 1. PreToolUse: security guard FIRST (fail closed!), then Graphify blast-radius check
    if event_name == "PreToolUse":
        if not bypass_subprocesses:
            res = _run_node_script("wk-guard.mjs", [], raw_stdin, timeout_s=20.0)
            if res.returncode != 0:
                return 2, res.stdout, res.stderr
        edited = _extract_edited_paths(payload)
        if edited:
            cfg = rt.load_config()
            br = check_blast_radius(ws, edited[0], min_callers=int(cfg.get("blast_radius_min_callers") or 5))
            if br.get("high_impact"):
                return 0, json.dumps({"systemMessage": br["message"]}), ""
        return 0, "", ""

    # 2. SessionStart: start orientation + handoff-on-clear + session subagent depth reset + default Graphify warmup
    if event_name == "SessionStart":
        src_ev = str(payload.get("source") or "")
        if src_ev in ("", "startup", "clear", "resume"):
            rt.update_session(sid, lambda st: st.__setitem__("subagent_depth", 0))
        cfg = rt.load_config()
        if bool(cfg.get("graphify_default", True)) and os.environ.get("WK_GRAPHIFY_DEFAULT") != "0" and not _kill_switch_active(payload):
            try:
                sync_and_load_graph(ws, store=rt, bootstrap=True)
            except Exception:
                pass
        outputs: list[dict[str, Any]] = []
        if not bypass_subprocesses:
            r_start = _run_node_script("wk-start.mjs", [], raw_stdin, timeout_s=10.0)
            start_txt = r_start.stdout.strip()
            if start_txt:
                try:
                    outputs.append(json.loads(start_txt))
                except ValueError:
                    outputs.append({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": start_txt}})
            if payload.get("source") == "clear":
                r_hand = _run_node_script("wk-handoff.mjs", ["start"], raw_stdin, timeout_s=10.0)
                hand_txt = r_hand.stdout.strip()
                if hand_txt:
                    try:
                        outputs.append(json.loads(hand_txt))
                    except ValueError:
                        outputs.append({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": hand_txt}})
        if not _kill_switch_active(payload):
            try:
                wd = scan_hanging_tasks(write_summary=False)
                if int(wd.get("hungCount") or 0) > 0:
                    if os.environ.get("WK_AUTO_RECOVER_HANGS") == "1":
                        rec = recover_hanging_tasks()
                        rec_cnt = int(rec.get("recoveredCount") or 0)
                        if rec_cnt > 0:
                            outputs.append({"systemMessage": f"Watchkeeper Watchdog: automatically recovered {rec_cnt} hanging task(s)/job(s)."})
                    else:
                        outputs.append({"systemMessage": f"Watchkeeper Watchdog: {wd['hungCount']} hanging task(s)/job(s) detected — run '/wk watchdog recover'."})
            except Exception:
                pass
        merged = _merge_hook_outputs(outputs)
        if is_ag:
            if not merged:
                return 0, "{}\n", ""
            parts: list[str] = []
            hso = merged.get("hookSpecificOutput")
            if isinstance(hso, dict) and isinstance(hso.get("additionalContext"), str):
                parts.append(hso["additionalContext"])
            for k in ("systemMessage", "reason"):
                if isinstance(merged.get(k), str) and merged[k].strip():
                    parts.append(merged[k].strip())
            text = "\n\n".join(p for p in parts if p)
            return 0, (_ag_inject(text, _ag_badge(merged.get("systemMessage") or "")) if text else "{}\n"), ""
        return 0, (json.dumps(merged) + "\n") if merged else "", ""

    # 3. SubagentStart / SubagentStop: maintain deterministic subagent recursion depth
    if event_name == "SubagentStart":
        rt.update_session(sid, lambda st: st.__setitem__("subagent_depth", int(st.get("subagent_depth") or 0) + 1))
        return 0, "{}\n", ""

    if event_name == "SubagentStop":
        rt.update_session(sid, lambda st: st.__setitem__("subagent_depth", max(0, int(st.get("subagent_depth") or 0) - 1)))
        return 0, "{}\n", ""

    # 4. PostToolUse / PostToolBatch: record test evidence on Bash + enqueue modified files + autonomous learning
    if event_name in ("PostToolUse", "PostToolBatch"):
        tc = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
        tool = str(payload.get("tool_name") or payload.get("tool") or tc.get("name") or "")
        t_in = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else (
            tc.get("args") if isinstance(tc.get("args"), dict) else {}
        )
        rc = 0
        out = ""
        err = ""
        if not bypass_subprocesses and (tool in ("Bash", "run_command") or event_name == "PostToolUse"):
            res = _run_node_script("wk-evidence.mjs", ["record"], raw_stdin, timeout_s=15.0)
            rc, out, err = res.returncode, res.stdout, res.stderr
        edited = _extract_edited_paths(payload)
        if edited:
            rt.push_dirty_files(edited)
            if not _kill_switch_active(payload):
                for ep in edited:
                    try:
                        track_agent_edit(file_path=ep, session_id=sid, workspace_dir=ws, tool_name=tool)
                    except Exception:
                        pass
        if not _kill_switch_active(payload) and tool in ("Bash", "run_command"):
            t_resp = payload.get("tool_response") if isinstance(payload.get("tool_response"), dict) else {}
            cmd = str(t_in.get("command") or t_in.get("CommandLine") or t_in.get("cmd") or "")
            resp_out = (
                str(t_resp.get("stdout") or "")
                + "\n"
                + str(t_resp.get("stderr") or "")
                + "\n"
                + str(payload.get("output") or "")
            )
            exit_code = t_resp.get("exitCode") if t_resp.get("exitCode") is not None else t_resp.get("exit_code")
            if exit_code is None:
                exit_code = payload.get("exitCode") if payload.get("exitCode") is not None else payload.get("exit_code")
            failed = (
                bool(t_resp.get("is_error"))
                or bool(payload.get("error"))
                or bool(payload.get("interrupted"))
                or (isinstance(exit_code, int) and exit_code != 0)
                or bool(re.search(r"\bWK_EXIT=([1-9]\d*)\b", resp_out))
                or bool(re.search(r"(?:^|\n)\s*(?:FAIL\b|FAILED\b|AssertionError:|Traceback \(most recent call last\)|not ok \d+)", resp_out))
            )
            if cmd and not failed:
                try:
                    promote_session_snippets_on_test_pass(session_id=sid, workspace_dir=ws, test_command=cmd)
                except Exception:
                    pass
        return rc, out, err

    # 5. UserPromptSubmit / PreInvocation: Fast-path triage -> Graph -> Multi-Skill -> Gemini 4 Spec
    if event_name in ("UserPromptSubmit", "PreInvocation"):
        if _kill_switch_active(payload):
            return 0, "{}\n", ""

        prompt_text = str(payload.get("prompt") or payload.get("lastUserInput") or "")
        sess = rt.get_session(sid)
        is_subagent = os.environ.get("WK_SUBAGENT_ACTIVE") == "1" or int(sess.get("subagent_depth") or 0) > 0
        if not is_subagent:
            try:
                scan_workspace_for_corrections(workspace_dir=ws, session_id=sid)
            except Exception:
                pass
        handoff_note = ""
        if event_name == "UserPromptSubmit" and not is_subagent and not prompt_text.lstrip().startswith("/"):
            handoff_note = _consume_shared_handoff(ws, "claude")

        cfg = rt.load_config()
        decision = evaluate_fast_path(prompt_text, env=dict(os.environ), session_state=sess, runtime_config=cfg)
        # P2-272: in Claude Code the standalone Re-Prompt hook (settings.json) already handles inline prompts, so the
        # plugin leaves them to it and no prompt is rewritten twice. Standalone /reprompt stays with the plugin.
        defer_inline = (
            not decision.bypass
            and event_name == "UserPromptSubmit"
            and not is_ag
            and decision.mode != "standalone_reprompt"
            and _standalone_reprompt_hook_registered(ws)
        )
        if decision.bypass or defer_inline:
            if handoff_note:
                return 0, json.dumps({
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": handoff_note,
                    }
                }) + "\n", ""
            return 0, "{}\n", ""

        # P2-272 canon: a Claude Code prompt never reaches Gemini; the engine falls back to the local template.
        cc_engine = None if is_ag else Gemini4Engine(env={**os.environ, "WK_CALLER": "claude_code"})
        compiled = compile_prompt_v2(decision, workspace_dir=ws, session_id=sid, store=rt, engine=cc_engine)
        if decision.mode == "standalone_reprompt":
            instructions = (
                f"{compiled['hud']}\n\n"
                "STANDALONE `/reprompt` MODE ACTIVE: Present the rewritten specification below verbatim inside the single code fence, "
                "summarize the key improvements briefly, and STOP immediately without modifying repository files or running tools. "
                "The Watchkeeper Stop hook will copy the clean specification to your clipboard.\n\n"
                f"{compiled['fenced_markdown']}"
            )
        else:
            instructions = compiled["compiled_text"]

        if handoff_note:
            instructions = f"{instructions}\n\n{handoff_note}"

        if event_name == "PreInvocation":
            return 0, _ag_inject(instructions, _ag_badge(compiled.get("hud") or "")), ""

        return 0, json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": instructions,
            }
        }) + "\n", ""

    # 6. Stop: (A) Standalone clipboard copy, (B) Watchkeeper evidence + handoff gate, (C) Graphify drain sync
    if event_name == "Stop":
        killed = _kill_switch_active(payload)
        sess = rt.get_session(sid)
        clip_msg: str | None = None
        sr = sess.get("standalone_reprompt")
        if isinstance(sr, dict) and sr.get("active"):
            assistant_text = str(payload.get("last_assistant_message") or payload.get("assistant_message") or "")
            to_copy = extract_fenced_rewrite(assistant_text) if "```" in assistant_text else str(sr.get("clean_text") or "")
            if to_copy:
                c_res = copy_to_clipboard(to_copy, env=dict(os.environ))
                if c_res.get("ok"):
                    clip_msg = f"Watchkeeper copied rewritten prompt to clipboard ({c_res['backend']}, {c_res['chars']} chars)."
                else:
                    clip_msg = f"Watchkeeper could not copy to clipboard ({c_res.get('error', 'unknown')})."
            rt.update_session(sid, lambda st: st.__setitem__("standalone_reprompt", None))

        ho_msg: str | None = None
        # Preserve wk-evidence gate & wk-handoff stop semantics cleanly without skipping Steps C/D on non-blocking messages
        if not bypass_subprocesses and not killed:
            r_ev = _run_node_script("wk-evidence.mjs", ["gate"], raw_stdin, timeout_s=15.0)
            if r_ev.returncode != 0 or '"block"' in (r_ev.stdout or ""):
                if is_ag:
                    return _ag_stop_output(_block_reason(r_ev.stdout) if '"block"' in (r_ev.stdout or "") else (r_ev.stderr or "").strip() or "Watchkeeper evidence gate blocked the stop.", payload, [clip_msg or ""])
                return r_ev.returncode, r_ev.stdout, r_ev.stderr
            r_ho = _run_node_script("wk-handoff.mjs", ["stop"], raw_stdin, timeout_s=15.0)
            if r_ho.returncode != 0:
                if is_ag:
                    return _ag_stop_output((r_ho.stderr or "").strip() or "Watchkeeper handoff blocked the stop.", payload, [clip_msg or ""])
                return r_ho.returncode, r_ho.stdout, r_ho.stderr
            if r_ho.stdout.strip():
                try:
                    parsed_ho = json.loads(r_ho.stdout)
                except ValueError:
                    parsed_ho = None
                if isinstance(parsed_ho, dict) and parsed_ho.get("decision") == "block":
                    if is_ag:
                        return _ag_stop_output(_block_reason(r_ho.stdout), payload, [clip_msg or ""])
                    if clip_msg:
                        cur_sys = str(parsed_ho.get("systemMessage") or "").strip()
                        parsed_ho["systemMessage"] = f"{clip_msg} | {cur_sys}" if cur_sys else clip_msg
                        return r_ho.returncode, json.dumps(parsed_ho) + "\n", r_ho.stderr
                    return r_ho.returncode, r_ho.stdout, r_ho.stderr
                if isinstance(parsed_ho, dict) and parsed_ho.get("systemMessage"):
                    ho_msg = str(parsed_ho["systemMessage"]).strip()
                elif parsed_ho is None:
                    ho_msg = r_ho.stdout.strip()

        # Step C: drain queued dirty files and sync Graphify AST incrementally (respect KILL)
        if not killed:
            dirty = rt.drain_dirty_files()
            if dirty:
                try:
                    cfg = rt.load_config()
                    sync_and_load_graph(ws, store=rt, bootstrap=bool(cfg.get("graphify_default", True)), dirty_paths=dirty)
                except Exception:
                    pass

        # Step D: scan for user corrections made after agent edits and check hung items (respect KILL)
        wd_msg: str | None = None
        if not killed:
            try:
                scan_workspace_for_corrections(workspace_dir=ws, session_id=sid)
            except Exception:
                pass
            try:
                wd = scan_hanging_tasks(write_summary=False)
                if int(wd.get("hungCount") or 0) > 0:
                    if os.environ.get("WK_AUTO_RECOVER_HANGS") == "1":
                        rec = recover_hanging_tasks()
                        rec_cnt = int(rec.get("recoveredCount") or 0)
                        if rec_cnt > 0:
                            wd_msg = f"Watchkeeper Watchdog: recovered {rec_cnt} hanging task(s)/job(s)."
                    else:
                        wd_msg = f"Watchkeeper Watchdog: {wd['hungCount']} hanging task(s)/job(s) detected — run '/wk watchdog recover'."
            except Exception:
                pass

        msgs = [m for m in (clip_msg, ho_msg, wd_msg) if m]
        if is_ag:
            return _ag_stop_output(None, payload, msgs)
        if msgs:
            return 0, json.dumps({"systemMessage": " | ".join(msgs)}) + "\n", ""
        return 0, "", ""

    return 0, "{}\n", ""


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: hook_bus.py <EventName>\n")
        return 2
    event_name = sys.argv[1].strip()
    raw_stdin = sys.stdin.read()
    code, out, err = handle_event(event_name, raw_stdin)
    if out:
        sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
