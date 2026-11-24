#!/usr/bin/env python3
"""Antigravity PreInvocation hook for in-place `rp:` prompt rewriting."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent
for p in (str(PLUGIN_ROOT), str(SCRIPT_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from server.reprompt_engine import (  # noqa: E402
    RePromptStore,
    default_data_dir,
    detect_graphify_context,
    parse_raw_bypass,
    rewrite_with_provider,
)
from skill_router import ACK_RE, is_trivial_prompt  # noqa: E402

# P2-272: one prefix grammar for every surface (scripts/prompt_prefix.py; spec section 3.5).
from prompt_prefix import (  # noqa: E402
    AUTO_FLOOR_CHARS,
    PREFIX_MODE_MAP,
    TAKE_TASK_RE,
    auto_over_words,
    cap_injected,
    is_loop_text,
    is_machine_turn,
    parse_rewrite,
    wants_auto_rewrite,
    word_count,
)
from prompt_prefix import REWRITE_PREFIX_RE as PREFIX_RE  # noqa: E402,F401

# Antigravity stops a hook at 45 s; the model gets at most 30 s, so at least 10 s stay for the rest.
HOOK_BUDGET_MAX_S = 30.0


def _wk_home_dir() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()


def _node_bin() -> str:
    env_node = (os.environ.get("WK_NODE") or "").strip()
    if env_node and Path(env_node).is_file():
        return env_node
    found = shutil.which("node")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if Path(cand).is_file():
            return cand
    return "node"


def _takeover_bin() -> Path:
    rel = PLUGIN_ROOT.parent / "bin" / "wk-takeover.mjs"
    if rel.is_file():
        return rel
    root_env = (os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("WK_PLUGIN_ROOT") or "").strip()
    if root_env:
        cand = Path(root_env).expanduser() / "bin" / "wk-takeover.mjs"
        if cand.is_file():
            return cand
    return Path.home() / "Projects" / "watchkeeper" / "bin" / "wk-takeover.mjs"


def _resolve_ws(workspace_dir: str) -> str:
    if not workspace_dir:
        return ""
    try:
        return str(Path(workspace_dir).expanduser().resolve())
    except Exception:
        return os.path.abspath(workspace_dir)


def run_takeover_command(user_input: str, workspace_dir: str, engine: str) -> str | None:
    """Resolve `/wk-take-task [id]` (or `/wk take-task [id]`) via wk-takeover.mjs for immediate direct execution."""
    m = TAKE_TASK_RE.match((user_input or "").strip())
    if not m:
        return None
    if (_wk_home_dir() / "KILL").exists():
        return "[Watchkeeper /wk-take-task] Wake-ups are stopped (~/.wk/KILL exists). Do not run task handover."
    takeover = _takeover_bin()
    if not takeover.is_file():
        return "[Watchkeeper /wk-take-task] wk-takeover.mjs not found."
    ws = _resolve_ws(workspace_dir or os.getcwd())
    model_used = "gemini-pro-orchestrator" if engine == "antigravity" else "claude"
    cmd = [
        _node_bin(),
        str(takeover),
        "brief",
        "--cwd",
        ws,
        "--engine",
        engine,
        "--claim",
        "--consume",
        "--model-used",
        model_used,
    ]
    task_id = (m.group(1) or "").strip()
    if task_id:
        cmd.extend(["--id", task_id])
    proc = subprocess.run(
        cmd,
        env=dict(os.environ),
        capture_output=True,
        text=True,
        timeout=15,
    )
    out_txt = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode == 0 and out_txt:
        return (
            "[Watchkeeper /wk-take-task — Auto Execute]\n"
            "Execute the task/handoff brief below immediately in the named directory without asking the user "
            "to re-explain or confirm handover:\n\n"
            f"{out_txt}"
        )
    return f"[Watchkeeper /wk-take-task]\n{out_txt or 'No queued tasks or active handoffs found for this workspace.'}"


def consume_pending_shared_handoff(workspace_dir: str, target_engine: str) -> str:
    """Atomically claim any fresh unconsumed shared-workspace handoff destined for target_engine."""
    if not workspace_dir or (_wk_home_dir() / "KILL").exists():
        return ""
    shared_file = _wk_home_dir() / "shared-workspace.json"
    if not shared_file.is_file():
        return ""
    ws = _resolve_ws(workspace_dir)
    if not ws:
        return ""
    lock_path = _wk_home_dir() / "shared-workspace.lock"
    lock_token = f"{os.getpid()}:{time.time()}:{uuid.uuid4().hex[:8]}"
    lock_acquired = False
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 5.0
        while True:
            try:
                fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    os.write(fd, (lock_token + "\n").encode("utf-8"))
                finally:
                    os.close(fd)
                lock_acquired = True
                break
            except FileExistsError:
                try:
                    if time.time() - lock_path.stat().st_mtime > 60.0:
                        lock_path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                except OSError:
                    pass
                if time.monotonic() > deadline:
                    return ""
                time.sleep(0.03)
        raw = json.loads(shared_file.read_text(encoding="utf-8"))
        workspaces = raw.get("workspaces") if isinstance(raw, dict) else None
        if not isinstance(workspaces, dict):
            return ""
        entry = workspaces.get(ws)
        if not isinstance(entry, dict):
            return ""
        if entry.get("consumed_by"):
            return ""
        from_eng = str(entry.get("from_engine") or "")
        to_eng = str(entry.get("to_engine") or "any")
        if not from_eng or from_eng == target_engine or to_eng not in (target_engine, "any"):
            return ""
        updated_str = str(entry.get("updated_at") or "").strip()
        if not updated_str:
            return ""
        updated_dt = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
        if updated_dt.tzinfo is None:
            updated_dt = updated_dt.replace(tzinfo=timezone.utc)
        age_sec = (datetime.now(timezone.utc) - updated_dt).total_seconds()
        if age_sec < -60 or age_sec > 7200:
            return ""
        entry["consumed_by"] = target_engine
        entry["consumed_at"] = datetime.now(timezone.utc).isoformat()
        workspaces[ws] = entry
        tmp = shared_file.with_name(f".{shared_file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        if os.name == "posix":
            os.chmod(tmp, 0o600)
        os.replace(tmp, shared_file)
        if os.name == "posix":
            os.chmod(shared_file, 0o600)
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
    finally:
        if lock_acquired:
            try:
                if lock_path.is_file() and lock_path.read_text(encoding="utf-8").strip() == lock_token:
                    lock_path.unlink(missing_ok=True)
            except Exception:
                pass


def is_wk_kill_active_for_payload(payload: dict[str, Any]) -> bool:
    """Return True while the Stop switch (~/.wk/KILL) is on.

    P2-272 (owner's spec): the Stop switch halts the prompt hooks in every folder; WK_KILL_STRICT is no
    longer needed (still accepted). The older, narrower scope (only Watchkeeper's worktrees and ~/.wk)
    stays available as an opt-in: WK_KILL_SCOPE=worktrees.
    """
    wk_home = Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()
    if not (wk_home / "KILL").exists():
        return False
    if os.environ.get("WK_KILL_STRICT") == "1":
        return True
    if (os.environ.get("WK_KILL_SCOPE") or "").strip().lower() != "worktrees":
        return True
    trees = (wk_home / "worktrees").resolve()
    candidates = [payload.get("cwd")]
    ws = payload.get("workspacePaths")
    if isinstance(ws, list):
        candidates.extend(ws)
    for raw in candidates:
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            p = Path(raw).expanduser().resolve()
            if p == trees or trees in p.parents or p == wk_home or wk_home in p.parents:
                return True
        except Exception:
            pass
    return False


def parse_inline_trigger(
    text: str, auto_all: bool = False, over_words: int = 0
) -> tuple[str, str | None] | None:
    """Return (prompt_body, mode_override) if inline re-prompt should run, else None.

    Triggers: an rp: prefix; a plain prompt of more than over_words words (P2-273, the owner's rule; the hook passes
    the autoRewriteOverWords setting, 30 by default; 0 = off); or any prompt of AUTO_FLOOR_CHARS+ when the opt-in
    hookAutoAll switch is on."""
    stripped = (text or "").strip()
    if not stripped:
        return None
    # Machine turns and already-rewritten or compiled text are never rewritten (no loops).
    if is_machine_turn(stripped) or is_loop_text(stripped):
        return None
    if stripped.startswith("/"):
        return None
    if parse_raw_bypass(stripped) is not None:
        return None

    parsed = parse_rewrite(stripped)
    if parsed is not None:
        _prefix, body, mode = parsed
        return body, mode

    if over_words and wants_auto_rewrite(stripped, over_words):
        return stripped, None
    if auto_all and len(stripped) >= AUTO_FLOOR_CHARS and not ACK_RE.match(stripped):
        return stripped, None
    return None


def _state_dir() -> Path:
    base = os.environ.get("REPROMPT_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    if base:
        return Path(base).expanduser() / "hook_sessions"
    return Path.home() / ".gemini" / "skill-vault" / "hook-state" / "hook_sessions"


def _safe_conv_id(conv_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (conv_id or "default").strip())
    return cleaned[:96] or "default"


def _load_last_hash(path: Path) -> str:
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return str(data.get("last_prompt_hash") or "")
        except Exception:
            pass
    return ""


def _save_last_hash(path: Path, prompt_hash: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"last_prompt_hash": prompt_hash}), encoding="utf-8")
    os.replace(tmp, path)


def _hook_budget_s() -> float:
    """P2-272: model time for one rewrite (REPROMPT_HOOK_BUDGET_S, 5 to 30 s, default 30)."""
    try:
        val = float(os.environ.get("REPROMPT_HOOK_BUDGET_S") or HOOK_BUDGET_MAX_S)
    except ValueError:
        val = HOOK_BUDGET_MAX_S
    return max(5.0, min(HOOK_BUDGET_MAX_S, val))


def _mark(store: Any, session_id: str, route: str, **kw: Any) -> None:
    """P2-272: remember how this conversation's last prompt went (raw, reprompt, plain) for the W panel badges."""
    try:
        store.mark_route(session_id, route, "antigravity", **kw)
    except Exception:
        pass


def _inject(system_message: str, user_markdown: str) -> str:
    """Antigravity PreInvocation shape (owner, 23 Nov): no "type" key."""
    return json.dumps(
        {"injectSteps": [{"systemMessage": {"systemMessage": system_message, "metadata": {"user_markdown": user_markdown}}}]},
        ensure_ascii=False,
    )


def main() -> int:
    try:
        if os.environ.get("REPROMPT_INTERNAL_CALL") == "1" or os.environ.get("WK_SUBAGENT_ACTIVE") == "1":
            print("{}")
            return 0

        raw_stdin = sys.stdin.read()
        if not raw_stdin.strip():
            print("{}")
            return 0

        payload = json.loads(raw_stdin)
        if not isinstance(payload, dict):
            print("{}")
            return 0

        if is_wk_kill_active_for_payload(payload):
            print("{}")
            return 0

        user_input = str(payload.get("lastUserInput") or "").strip()
        if not user_input:
            print("{}")
            return 0

        store = RePromptStore(default_data_dir())
        settings = store.load_settings()
        auto_all = bool(settings.get("hookAutoAll", False))
        over_words = auto_over_words(settings.get("autoRewriteOverWords"))

        conv_id = _safe_conv_id(str(payload.get("conversationId") or "default"))
        state_path = _state_dir() / f"{conv_id}_inline.json"
        skill_state_path = _state_dir() / f"{conv_id}.json"
        prompt_hash = hashlib.sha256(user_input.encode("utf-8", errors="replace")).hexdigest()
        ws_list = payload.get("workspacePaths")
        workspace_dir = str(payload.get("cwd") or (ws_list[0] if isinstance(ws_list, list) and ws_list else "") or "")

        takeover_msg = run_takeover_command(user_input, workspace_dir, "antigravity")
        if takeover_msg is not None:
            if prompt_hash == _load_last_hash(state_path):
                print("{}")
                return 0
            _save_last_hash(state_path, prompt_hash)
            print(
                json.dumps(
                    {
                        "injectSteps": [
                            {
                                "systemMessage": {
                                    "systemMessage": takeover_msg,
                                    "metadata": {
                                        "user_markdown": f"**⚡ `/wk-take-task`:**\n\n{takeover_msg}"
                                    },
                                }
                            }
                        ]
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        raw_body = parse_raw_bypass(user_input)
        if raw_body is not None:
            if prompt_hash == _load_last_hash(state_path):
                print("{}")
                return 0
            _save_last_hash(state_path, prompt_hash)
            _mark(store, conv_id, "raw")
            # P2-272 (A4): one line in the chat, in every mode, the same as in Claude Code.
            print(
                _inject(
                    "[Re-Prompt · Raw Mode] The message starts with a raw marker (`raw:` or `:raw`): take it "
                    f"exactly as typed, without the marker. No rewrite was made:\n\n{raw_body}",
                    "⚡ Raw · sent as typed",
                )
            )
            return 0

        if prompt_hash == _load_last_hash(state_path):
            print("{}")
            return 0

        handoff_note = ""
        if not user_input.startswith("/"):
            handoff_note = consume_pending_shared_handoff(workspace_dir, "antigravity")

        parsed = parse_inline_trigger(user_input, auto_all=auto_all, over_words=over_words)
        if not parsed:
            if not user_input.startswith("/"):
                _mark(store, conv_id, "plain")
            if handoff_note:
                _save_last_hash(state_path, prompt_hash)
                print(
                    json.dumps(
                        {
                            "injectSteps": [
                                {
                                    "systemMessage": {
                                        "systemMessage": handoff_note,
                                        "metadata": {"user_markdown": "**🔄 Shared Workspace Handoff Applied**"},
                                    }
                                }
                            ]
                        },
                        ensure_ascii=False,
                    )
                )
                return 0
            print("{}")
            return 0

        body, mode_override = parsed
        common: dict[str, Any] = {
            "prompt": body,
            "target": "antigravity",
            "mode": mode_override,
            "save_history": True,
            "session_id": conv_id,
            "workspace_dir": workspace_dir,
        }
        # P2-273: say why a prompt without a prefix was re-prompted (the owner's 30-word rule); raw: skips it.
        if parse_rewrite(user_input) is not None:
            trigger = "prefix"
        elif wants_auto_rewrite(user_input, over_words):
            trigger = "words"
        else:
            trigger = "all"
        try:
            if trigger == "words":
                # P2-273 review: a prompt caught only by the word rule uses the fast local template, so long prompts
                # never wait for a model; an explicit rp: (and the opt-in rewrite-everything switch) use the provider.
                res = rewrite_with_provider(store, provider_override="offline_template", **common)
            else:
                # P2-272: one model, at most 30 s, no retry chain; the local template is the fallback.
                res = rewrite_with_provider(store, time_budget_s=_hook_budget_s(), **common)
        except Exception:
            res = rewrite_with_provider(store, provider_override="offline_template", **common)
        _save_last_hash(state_path, prompt_hash)
        sess_data = res.get("session")
        if isinstance(sess_data, dict):
            synced_state = dict(sess_data)
            synced_state["last_prompt_hash"] = prompt_hash
            skill_state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_skill = skill_state_path.with_suffix(".tmp")
            tmp_skill.write_text(json.dumps(synced_state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp_skill, skill_state_path)

        rewritten = cap_injected(res["rewritten_prompt"])
        mode_used = str(res.get("mode") or mode_override or "balanced")
        skills = [str(s) for s in ((res.get("skill_judgment") or {}).get("load_skills") or [])]
        graphify = bool(detect_graphify_context(workspace_dir))
        # P2-272 (owner's spec): the owner's own message stays authoritative; never "Do NOT pause to ask".
        sys_msg_body = (
            f"[Re-Prompt · {mode_used}] Below is a structured version of the user's message. "
            "The user's own message stays authoritative; this structure is a reading aid. "
            "Ask if anything is unclear.\n\n"
            f"{rewritten}"
        )
        if handoff_note:
            sys_msg_body = f"{sys_msg_body}\n\n{handoff_note}"
        # P2-272 (A4): one line in the chat; the full rewrite stays in the system message and in Re-Prompt history.
        why = f" · {word_count(user_input)} words" if trigger == "words" else ""
        indicator = f"✨ Re-prompted{why} · {mode_used} · {len(skills)} skill{'' if len(skills) == 1 else 's'}"
        if graphify:
            indicator += " · Graphify"
        _mark(store, conv_id, "reprompt", mode=mode_used, skills=len(skills), graphify=graphify, trigger=trigger)
        print(_inject(sys_msg_body, indicator))
        return 0
    except Exception:
        print("{}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
