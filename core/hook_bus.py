#!/usr/bin/env python3
"""Deterministic Topological DAG Hook Multiplexer Bus for Watchkeeper Unified Runtime v2.0."""

from __future__ import annotations

import datetime as dt
import hashlib
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


# ---------------------------------------------------------------- Bridge (P2-277)
# Names, TTL and cap match bin/wk-bridge.mjs: a claim is ~/.wk/bridge/claims/<sha256(id)[:32]>, made with O_EXCL; one older
# than 15 minutes is stale. The Stop hook chains at most 3 handoffs an hour per Claude session. Nothing here starts a process.
_BRIDGE_CLAIM_TTL_S = 15 * 60
_BRIDGE_CHAIN_CAP = 3
_BRIDGE_CTRL = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]+")


def _bridge_line(s: Any) -> str:
    return re.sub(r"\s+", " ", _BRIDGE_CTRL.sub(" ", str(s if s is not None else ""))).strip()


def _bridge_short(s: Any, n: int = 120) -> str:
    t = _bridge_line(s) or "untitled"
    return t if len(t) <= n else t[: n - 1] + "\u2026"


def _bridge_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]


def _bridge_on() -> bool:
    return not (_wk_home_dir() / "bridge" / "off").exists()


def _bridge_waiting_for_claude() -> list[dict[str, Any]]:
    """Unread handoffs addressed to Claude (same ids as wk-bridge.mjs waitingFor('claude'))."""
    raw = read_json_safe(_wk_home_dir() / "shared-workspace.json", {})
    wss = raw.get("workspaces") if isinstance(raw, dict) else None
    out: list[dict[str, Any]] = []
    if not isinstance(wss, dict):
        return out
    for key, e in wss.items():
        if not isinstance(e, dict) or e.get("consumed_by") or str(e.get("to_engine") or "").lower() != "claude":
            continue
        repo = _bridge_line(e.get("workspace") or key)
        out.append({"id": f"{repo}@{_bridge_line(e.get('updated_at') or '')}", "title": _bridge_short(e.get("title")), "at": e.get("updated_at"), "repo": repo})
    return out


def _bridge_age(at: Any) -> str:
    try:
        then = dt.datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        mins = round((time.time() - then.timestamp()) / 60)
    except (TypeError, ValueError):
        return "just now"
    if mins < 1:
        return "just now"
    return f"{mins} min ago" if mins < 60 else f"{round(mins / 60)} h ago"


def _bridge_claimed_fresh(item_id: str) -> bool:
    try:
        return time.time() - (_wk_home_dir() / "bridge" / "claims" / _bridge_hash(item_id)).stat().st_mtime < _BRIDGE_CLAIM_TTL_S
    except OSError:
        return False


def _bridge_claim(item_id: str, by: str) -> bool:
    d = _wk_home_dir() / "bridge" / "claims"
    try:
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        return False
    f = d / _bridge_hash(item_id)
    for _ in range(2):
        try:
            fd = os.open(str(f), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, (json.dumps({"id": item_id, "by": _bridge_line(by), "at": dt.datetime.now(dt.timezone.utc).isoformat()}) + "\n").encode("utf-8"))
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            try:
                if time.time() - f.stat().st_mtime < _BRIDGE_CLAIM_TTL_S:
                    return False
            except OSError:
                continue
            # Stale: only the holder of <claim>.steal (O_EXCL) may remove it, after checking again under that lock.
            # Nobody else ever removes a claim, so a fresh claim cannot be lost; the new claim is then taken with
            # O_EXCL like any other, so exactly one claimer wins. A crash's leftover lock is pruned after an hour.
            steal = d / (f.name + ".steal")
            try:
                sfd = os.open(str(steal), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except OSError:
                return False
            try:
                try:
                    stale = time.time() - f.stat().st_mtime >= _BRIDGE_CLAIM_TTL_S
                except FileNotFoundError:
                    stale = True
                except OSError:
                    return False
                if not stale:
                    return False
                try:
                    f.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    return False
                try:
                    fd = os.open(str(f), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except OSError:
                    return False
                try:
                    os.write(fd, (json.dumps({"id": item_id, "by": _bridge_line(by), "at": dt.datetime.now(dt.timezone.utc).isoformat()}) + "\n").encode("utf-8"))
                finally:
                    os.close(fd)
                return True
            finally:
                try:
                    os.close(sfd)
                except OSError:
                    pass
                try:
                    steal.unlink()
                except OSError:
                    pass
        except OSError:
            return False
    return False


def _bridge_release(item_id: str) -> None:
    try:
        (_wk_home_dir() / "bridge" / "claims" / _bridge_hash(item_id)).unlink()
    except OSError:
        pass


def _bridge_chain_take(sid: str, wait_s: float = 5.0, strict: bool = False) -> bool:
    """Count one Stop-hook chain for this session; False when 3 already ran in the last hour.

    strict (the Antigravity Gemini chain, P2-279 fix round): a chains file that exists but cannot be read counts as
    the cap reached, and nothing is written, so a corrupt file never resets the cap."""
    d = _wk_home_dir() / "bridge" / "chains"
    try:
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        f = d / f"{_bridge_hash(sid or 'unknown')}.json"
        with _exclusive_file_lock(d / f"{f.name}.lock", wait_s=wait_s):
            now = time.time()
            if strict and f.exists():
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    return False
                if not isinstance(data, dict) or not isinstance(data.get("at"), list):
                    return False
            else:
                data = read_json_safe(f, {})
            stamps = [float(t) for t in (data.get("at") if isinstance(data, dict) and isinstance(data.get("at"), list) else []) if isinstance(t, (int, float)) and now - float(t) < 3600]
            if len(stamps) >= _BRIDGE_CHAIN_CAP:
                return False
            stamps.append(now)
            atomic_write_json(f, {"at": stamps})
            try:
                os.chmod(f, 0o600)
            except OSError:
                pass
            return True
    except Exception:
        return False


def _bridge_context_line() -> str:
    """One line for SessionStart and UserPromptSubmit when a handoff waits for Claude; empty otherwise."""
    if _kill_switch_active() or not _bridge_on():
        return ""
    for it in _bridge_waiting_for_claude():
        if not _bridge_claimed_fresh(it["id"]):
            return f"Bridge: a handoff from Gemini waits: {it['title']}, {_bridge_age(it['at'])}. Take it with /wk-take-task when the owner's request allows."
    return ""


def _bridge_stop_reason(sid: str, cwd: str = "") -> str:
    """Stop hook: claim the first unclaimed handoff for Claude, within the chain cap; empty when nothing applies."""
    if _kill_switch_active() or not _bridge_on():
        return ""
    items = [it for it in _bridge_waiting_for_claude() if not _bridge_claimed_fresh(it["id"])]
    if not items:
        return ""
    # The handoff for this session's own folder first, then the rest in order.
    def _real(p: str) -> str:
        try:
            return os.path.realpath(os.path.expanduser(p.strip())) if p and p.strip() else ""
        except (OSError, ValueError):
            return ""
    here = _real(cwd)
    items.sort(key=lambda it: 0 if here and _real(str(it.get("repo") or "")) == here else 1)
    for it in items:
        if not _bridge_claim(it["id"], f"stop:{sid}"):
            continue
        # Claim first, then the chain slot: a lost claim race spends no slot; at the cap the claim is given back.
        if not _bridge_chain_take(sid):
            _bridge_release(it["id"])
            return ""
        repo = it.get("repo") or ""
        if repo and not re.search(r'["$`\\\n]', repo):
            return f'Bridge: a handoff from Gemini waits: {it["title"]}. Run /wk-take-task --handoff --cwd "{repo}" to take it.'
        return f"Bridge: a handoff from Gemini waits: {it['title']}. Run /wk-take-task --handoff to take it."
    return ""


# P2-279 Gemini chain: the Antigravity Stop hook offers the next queued task with the owner's Desk rules. Off by default
# (marker ~/.wk/bridge/gemini-chain-on, set by `wk-bridge gemini-chain on`). File reads only, plus one crossing line and
# the chain count; the hook never takes the task. Any exception means no offer, so Antigravity gets {}.
_GEMINI_DAY_CAP_DEFAULT = 12
_GEMINI_LOCK_WAIT_S = 0.3
_TASK_ID = re.compile(r"^\d{8}-\d{6}-[a-z0-9-]{1,40}$")


def _gemini_config() -> dict[str, Any]:
    raw = read_json_safe(ROOT / "config" / "gemini.json", {})
    return raw if isinstance(raw, dict) else {}


def _gemini_chain_on() -> bool:
    b = _wk_home_dir() / "bridge"
    return (b / "gemini-chain-on").exists() and not (b / "off").exists()


_GEMINI_SCAN_BUDGET_S = 0.5


def _gemini_tasks() -> list[dict[str, Any]]:
    """Every task meta.json, sorted by id (the order wk-task takes them in).

    The hook must answer within 1 s: a scan that runs past _GEMINI_SCAN_BUDGET_S raises, which means no offer."""
    d = _wk_home_dir() / "tasks"
    if not d.is_dir():
        return []
    deadline = time.monotonic() + _GEMINI_SCAN_BUDGET_S
    out: list[dict[str, Any]] = []
    for p in sorted(d.iterdir(), key=lambda x: x.name):
        if time.monotonic() > deadline:
            raise TimeoutError("task scan over budget")
        if not _TASK_ID.match(p.name):
            continue
        m = read_json_safe(p / "meta.json", None)
        if isinstance(m, dict) and m.get("id") == p.name:
            out.append(m)
    return out


def _gemini_held(task_id: str, now: float) -> bool:
    """Same rule as wk-bridge.mjs holdOf: a hold file whose `until` has passed counts as released."""
    h = read_json_safe(_wk_home_dir() / "tasks" / task_id / "hold", None)
    if not isinstance(h, dict):
        return False
    until = h.get("until")
    if until:
        try:
            if dt.datetime.fromisoformat(str(until).replace("Z", "+00:00")).timestamp() <= now:
                return False
        except (TypeError, ValueError):
            pass
    return True


def _gemini_same_local_day(iso: Any, today: dt.date) -> bool:
    """Same count as wk-task takeTask: stamp(d).slice(0, 8), the local calendar day."""
    try:
        t = dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if t.tzinfo is not None:
        t = t.astimezone()
    return t.date() == today


def _bridge_stop_reason_ag(payload: dict[str, Any]) -> str:
    """Antigravity Stop: the Desk rules plus the first queued task when every condition holds; empty otherwise."""
    try:
        if _kill_switch_active() or not _gemini_chain_on():
            return ""
        if payload.get("terminationReason") != "model_stop" or payload.get("fullyIdle") is not True or payload.get("continuationActive") is True:
            return ""
        cfg = _gemini_config()
        rules = _bridge_line(cfg.get("desk_rules"))
        if not rules:
            return ""
        cap = cfg.get("max_tasks_per_day")
        cap = cap if isinstance(cap, int) and not isinstance(cap, bool) and 0 < cap <= 1000 else _GEMINI_DAY_CAP_DEFAULT
        now = time.time()
        today = dt.datetime.fromtimestamp(now).date()
        all_tasks = _gemini_tasks()
        if sum(1 for m in all_tasks if m.get("taken_at") and _gemini_same_local_day(m.get("taken_at"), today)) >= cap:
            return ""
        queued = [m for m in all_tasks if m.get("status") == "queued" and not _gemini_held(str(m.get("id")), now)]
        if not queued:
            return ""
        conv = _bridge_line(payload.get("conversationId")) or "unknown"
        if not _bridge_chain_take(f"ag:{conv}", wait_s=_GEMINI_LOCK_WAIT_S, strict=True):
            return ""
        first = queued[0]
        tid, title = str(first.get("id")), _bridge_short(first.get("title"))
        line = {"at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "route": "G3", "kind": "task", "id": tid,
                "from": "watchkeeper", "to": "gemini", "event": "offered", "conversation_id": conv, "task_id": tid, "title": title}
        b = _wk_home_dir() / "bridge"
        b.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(b / "crossings.jsonl"), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.write(fd, (json.dumps(line) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        n = len(queued)
        return f"{rules} {n} proposal{'' if n == 1 else 's'} wait{'s' if n == 1 else ''}. First: {title} ({tid}). Begin with /wk-take-task {tid}."
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
        if not is_ag:
            b_line = _bridge_context_line()
            if b_line:
                outputs.append({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": b_line}})
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
            b_line = _bridge_context_line()
            if b_line:
                handoff_note = f"{handoff_note}\n\n{b_line}" if handoff_note else b_line

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
            # Gemini chain (P2-279): off by default; offers the next queued task with the Desk rules, never takes it.
            return _ag_stop_output(None if killed else _bridge_stop_reason_ag(payload), payload, msgs)
        # Bridge (P2-277), Claude only: chain to a waiting handoff, claimed first so two tabs never take one.
        b_reason = "" if killed else _bridge_stop_reason(sid, str(payload.get("cwd") or ""))
        if b_reason:
            out_b: dict[str, Any] = {"decision": "block", "reason": b_reason}
            if msgs:
                out_b["systemMessage"] = " | ".join(msgs)
            return 0, json.dumps(out_b) + "\n", ""
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
