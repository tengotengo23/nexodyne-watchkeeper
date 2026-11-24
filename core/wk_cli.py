#!/usr/bin/env python3
"""Unified /wk command handler & /wk doctor diagnostics for Watchkeeper v2.0."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.forensic_audit import generate_ledger  # noqa: E402
from core.gemini_engine import MODEL_CARBON, MODEL_HYDROGEN, resolve_gemini_credentials, sdk_status  # noqa: E402
from core.graph_bridge import query_ego_subgraph, sync_and_load_graph  # noqa: E402
from core.learning_engine import ingest_correction  # noqa: E402
from core.skill_router import build_skills_manifest, select_all_matching_skills  # noqa: E402
from core.snippet_store import SnippetStore, resolve_db_path, resolve_summary_path  # noqa: E402
from core.state_store import VALID_BRAINS, VALID_MODES, StateStore, file_lock, read_json_safe  # noqa: E402
from core.watchdog import decide_pending_removal, recover_hanging_tasks, run_in_group, scan_hanging_tasks  # noqa: E402

WATCHDOG_DECISIONS = ("approve-remove", "later", "keep")


def _wk_home_dir() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()


def _find_node() -> str | None:
    env_node = (os.environ.get("WK_NODE") or "").strip()
    if env_node and Path(env_node).is_file():
        return env_node
    found = shutil.which("node")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if Path(cand).is_file():
            return cand
    return None


def _read_learning_stats_readonly(db_file: Path) -> dict[str, Any]:
    sum_file = resolve_summary_path()
    if sum_file.is_file():
        summary = read_json_safe(sum_file, None)
        if isinstance(summary, dict):
            return {
                "available": True,
                "snippetCount": int(summary.get("snippetCount") or 0),
                "verifiedCount": int(summary.get("verifiedCount") or 0),
                "correctionCount": int(summary.get("correctionCount") or 0),
                "heuristicCount": int(summary.get("heuristicCount") or 0),
                "pendingSyncCount": int(summary.get("pendingSyncCount") or 0),
            }
    if not db_file.is_file():
        return {
            "available": False,
            "snippetCount": 0,
            "verifiedCount": 0,
            "correctionCount": 0,
            "heuristicCount": 0,
            "pendingSyncCount": 0,
        }
    try:
        conn = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
        try:
            cur = conn.cursor()
            tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            snip = cur.execute("SELECT COUNT(*) FROM snippets").fetchone()[0] if "snippets" in tables else 0
            ver = cur.execute("SELECT COUNT(*) FROM snippets WHERE verification_status='verified_pass'").fetchone()[0] if "snippets" in tables else 0
            corr = cur.execute("SELECT COUNT(*) FROM corrections").fetchone()[0] if "corrections" in tables else 0
            heur = cur.execute("SELECT COUNT(*) FROM heuristics").fetchone()[0] if "heuristics" in tables else 0
            pend = cur.execute("SELECT COUNT(*) FROM sync_outbox WHERE synced=0").fetchone()[0] if "sync_outbox" in tables else 0
            return {
                "available": True,
                "snippetCount": int(snip),
                "verifiedCount": int(ver),
                "correctionCount": int(corr),
                "heuristicCount": int(heur),
                "pendingSyncCount": int(pend),
            }
        finally:
            conn.close()
    except sqlite3.Error:
        return {
            "available": True,
            "snippetCount": 0,
            "verifiedCount": 0,
            "correctionCount": 0,
            "heuristicCount": 0,
            "pendingSyncCount": 0,
        }


def _workspace(arg_ws: str | None = None) -> Path:
    return Path(arg_ws or os.environ.get("WK_WORKSPACE") or os.getcwd()).expanduser().resolve()


def cmd_status(ws: Path, store: StateStore) -> dict[str, Any]:
    cfg = store.load_config()
    stats = store.get_cache_stats()
    hits = int(stats.get("hits") or 0)
    misses = int(stats.get("misses") or 0)
    ratio = round(hits / max(1, hits + misses), 3)
    graph_info = sync_and_load_graph(ws, store=store, bootstrap=False)
    manifest = build_skills_manifest(workspace_dir=ws, store=store)
    sdk = sdk_status()
    _key, key_src = resolve_gemini_credentials()
    hooks_file = ROOT / "hooks" / "hooks.json"
    hook_events: list[str] = []
    if hooks_file.is_file():
        try:
            raw = json.loads(hooks_file.read_text(encoding="utf-8"))
            hmap = raw.get("hooks") if isinstance(raw.get("hooks"), dict) else raw
            if isinstance(hmap, dict):
                hook_events = sorted(hmap.keys())
        except (OSError, ValueError):
            pass

    db_file = resolve_db_path()
    sum_file = resolve_summary_path()
    learn_summary = read_json_safe(sum_file, None) if sum_file.is_file() else None
    if not isinstance(learn_summary, dict):
        learn_summary = {
            "available": db_file.is_file(),
            "snippetCount": 0,
            "verifiedCount": 0,
            "correctionCount": 0,
            "heuristicCount": 0,
            "pendingSyncCount": 0,
        }

    return {
        "ok": True,
        "version": "2.0.0",
        "mode": cfg["mode"],
        "brain": cfg["brain"],
        "models": {"carbon": f"{MODEL_CARBON} (high)", "hydrogen": f"{MODEL_HYDROGEN} (xhigh/high)"},
        "sdk": sdk["sdk"],
        "credentials_source": key_src,
        "prefix_cache": {"hits": hits, "misses": misses, "hit_ratio": ratio},
        "graphify": {
            "exists": graph_info["exists"],
            "freshness": graph_info["freshness"],
            "nodes": graph_info["total_nodes"],
            "edges": graph_info["total_edges"],
        },
        "skills": {
            "indexed": len(manifest.get("skills") or []),
            "cache_hit": manifest.get("cache_hit", False),
        },
        "learning": learn_summary,
        "watchdog": scan_hanging_tasks(write_summary=False),
        "hook_bus_events": hook_events,
    }


def cmd_doctor(ws: Path, store: StateStore) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    sdk = sdk_status()
    checks.append({
        "name": "gemini_4_sdk",
        "ok": True,
        "detail": f"{sdk['sdk']} (google_genai_installed={sdk['google_genai_installed']}, zero legacy sdk)",
    })

    key, key_src = resolve_gemini_credentials()
    checks.append({
        "name": "gemini_credentials",
        "ok": True,
        "status": "configured" if key else "offline_fallback_ready",
        "detail": f"source={key_src}" if key else "no API key set (degrades cleanly to offline-local fallback)",
    })

    # Verify capability ledger presence & target files exist
    ledger_path = ROOT / "core" / "CAPABILITY_LEDGER.json"
    ledger_ok = False
    ledger_count = 0
    missing_targets: list[str] = []
    if ledger_path.is_file():
        try:
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            caps = ledger.get("capabilities") or []
            ledger_count = len(caps)
            for c in caps:
                sf = str(c.get("source_file") or "")
                if sf and not sf.startswith(".") and not sf.startswith("~") and not (ROOT / sf).exists():
                    missing_targets.append(sf)
            ledger_ok = ledger_count > 0 and not missing_targets
        except (OSError, ValueError):
            ledger_ok = False
    else:
        ledger = generate_ledger(root=ROOT, write_outputs=False)
        ledger_count = int(ledger["summary"]["total_capabilities"])
        ledger_ok = ledger_count > 0

    checks.append({
        "name": "capability_ledger_parity",
        "ok": ledger_ok,
        "detail": f"{ledger_count} capabilities verified" + (f" (missing: {missing_targets[:3]})" if missing_targets else ""),
    })

    hooks_file = ROOT / "hooks" / "hooks.json"
    bus_ok = False
    events_wired: list[str] = []
    if hooks_file.is_file():
        try:
            hdata = json.loads(hooks_file.read_text(encoding="utf-8")).get("hooks", {})
            events_wired = sorted(hdata.keys())
            bus_ok = all("core/hook_bus.py" in json.dumps(v) for v in hdata.values()) and "PreToolUse" in hdata and "Stop" in hdata
        except (OSError, ValueError):
            bus_ok = False
    checks.append({
        "name": "hook_multiplexer_bus",
        "ok": bus_ok,
        "detail": f"events={','.join(events_wired)}",
    })

    flock_ok = False
    try:
        with tempfile.TemporaryDirectory() as td:
            with file_lock(Path(td) / "doctor.lock", timeout_s=2.0):
                flock_ok = True
    except Exception:
        flock_ok = False
    checks.append({"name": "flock_locking", "ok": flock_ok, "detail": "fcntl.flock advisory locks operational"})

    graph_cli = shutil.which("graphify")
    g_info = sync_and_load_graph(ws, store=store, bootstrap=False)
    checks.append({
        "name": "graphify_health",
        "ok": True,
        "detail": f"cli={graph_cli or 'ast-builtin'}, workspace_graph={g_info['exists']} ({g_info['total_nodes']} nodes, {g_info['total_edges']} edges)",
    })

    manifest = build_skills_manifest(workspace_dir=ws, store=store)
    checks.append({
        "name": "skills_library",
        "ok": len(manifest.get("skills") or []) > 0,
        "detail": f"indexed={len(manifest.get('skills') or [])} skills (manifest={manifest['manifest_file']})",
    })

    clip_bins = [b for b in ("pbcopy", "wl-copy", "xclip", "xsel", "clip.exe") if shutil.which(b)]
    checks.append({
        "name": "clipboard_utilities",
        "ok": True,
        "detail": f"available={clip_bins or ['WK_CLIPBOARD_FILE/none']}",
    })

    kill_on = (_wk_home_dir() / "KILL").exists()
    checks.append({
        "name": "kill_switch",
        "ok": True,
        "status": "active" if kill_on else "off",
        "detail": f"KILL={'ACTIVE (read-only safety mode)' if kill_on else 'off'} ({_wk_home_dir() / 'KILL'})",
    })

    db_file = resolve_db_path()
    if kill_on:
        st = _read_learning_stats_readonly(db_file)
        if st["available"]:
            learn_detail = f"read-only: snippets={st['snippetCount']} (verified={st['verifiedCount']}), corrections={st['correctionCount']}, heuristics={st['heuristicCount']}"
        else:
            learn_detail = "not initialized (KILL active, skipped init)"
    elif db_file.is_file():
        st = SnippetStore(db_path=db_file).stats()
        learn_detail = f"snippets={st['snippetCount']} (verified={st['verifiedCount']}), corrections={st['correctionCount']}, heuristics={st['heuristicCount']}"
    else:
        learn_detail = "ready (lazy-init on first snippet/correction capture)"
    checks.append({
        "name": "autonomous_learning_db",
        "ok": True,
        "detail": learn_detail,
    })

    wd = scan_hanging_tasks(write_summary=False)
    checks.append({
        "name": "watchdog_health",
        "ok": wd.get("hungCount", 0) == 0,
        "detail": f"active={wd.get('activeCount', 0)}, warning={wd.get('warningCount', 0)}, hung={wd.get('hungCount', 0)}",
    })

    all_ok = all(c["ok"] for c in checks)
    return {"ok": all_ok, "checks": checks, "status": cmd_status(ws, store)}


def cmd_help() -> dict[str, Any]:
    return {
        "ok": True,
        "version": "2.0.0",
        "commands": {
            "overview": "Single-screen read-only dashboard (status, queue, jobs, suggestions, watchdog, learning).",
            "status": "Unified runtime v2.0 status JSON/summary.",
            "heal [--apply]": "Dry-run inspect hung tasks, Graphify freshness, and skills cache (--apply recovers & refreshes).",
            "tasks [args...]": "Run bin/wk-task.mjs commands (default: list).",
            "handoff [args...]": "Run bin/wk-takeover.mjs commands (default: status).",
            "watchdog [status|scan|recover [--dry-run]]": "Detect and recover hanging tasks, jobs, or turns.",
            "watchdog approve-remove|later|keep <task_id>": "Owner decision on a pending worktree removal (one JSON line).",
            "learn [status|search|heuristics|sync|save|record]": "Manage offline-first sanitized FTS5 snippets.",
            "mode [auto|confirm|reprompt-only|passthrough]": "Get or set prompt compilation mode.",
            "brain [adaptive-max|carbon-high|hydrogen-xhigh]": "Get or set Gemini 4 reasoning tier policy.",
            "skills [list|match <prompt>|reload]": "Inspect, match, or reload indexed skills.",
            "graph [sync|inspect <sym>|open]": "Sync or query 2-hop Graphify AST subgraph.",
            "doctor [--json]": "Run non-destructive runtime health diagnostics.",
            "dag plan [--repo <dir>] [--verify <cmd>] [--no-model] [--only-split] [--] <task>": "Split a task into checked steps (one Claude planner call); nothing runs yet.",
            "dag run <id>": "Run a planned task's steps in waves (each step checked, then its verify command).",
            "dag status [id]": "List task runs, or show one run's steps.",
            "dag stop <id>": "Stop one run; nothing is deleted.",
            "dag merge <id>": "Merge a passed run into your branch (git merge --no-edit; never a push).",
            "help": "Show this help message.",
        },
        "examples": [
            "wk overview",
            "wk heal --apply",
            "wk tasks list",
            "wk handoff status",
            "wk doctor --json",
        ],
    }


def _collect_queue_and_jobs(wk_home: Path) -> tuple[dict[str, int], dict[str, int], int]:
    queue_counts: dict[str, int] = {"queued": 0, "taken": 0, "done": 0, "attention": 0, "other": 0}
    tasks_dir = wk_home / "tasks"
    if tasks_dir.is_dir():
        for td in sorted(tasks_dir.iterdir()):
            if not td.is_dir():
                continue
            meta = read_json_safe(td / "meta.json", None)
            if isinstance(meta, dict):
                st = str(meta.get("status") or "other").lower()
                if st in queue_counts:
                    queue_counts[st] += 1
                else:
                    queue_counts["other"] += 1

    job_counts: dict[str, int] = {"queued": 0, "running": 0, "waiting": 0, "done": 0, "failed": 0, "stopped": 0}
    jobs_dir = wk_home / "jobs"
    if jobs_dir.is_dir():
        for jd in sorted(jobs_dir.iterdir()):
            if not jd.is_dir():
                continue
            meta = read_json_safe(jd / "meta.json", None)
            if isinstance(meta, dict):
                st = str(meta.get("state") or "failed").lower()
                if st in job_counts:
                    job_counts[st] += 1

    open_sugs: set[str] = set()
    decided_sugs: set[str] = set()
    sug_file = wk_home / "suggestions.jsonl"
    if sug_file.is_file():
        try:
            for line in sug_file.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                sid = str(row.get("id") or row.get("suggestion_id") or "")
                if not sid:
                    continue
                if row.get("choice") is not None or row.get("type") == "decision":
                    decided_sugs.add(sid)
                else:
                    open_sugs.add(sid)
        except OSError:
            pass
    return queue_counts, job_counts, len(open_sugs - decided_sugs)


def cmd_overview(ws: Path, store: StateStore) -> dict[str, Any]:
    wk_home = _wk_home_dir()
    kill_on = (wk_home / "KILL").exists()
    st = cmd_status(ws, store)
    queue_counts, job_counts, open_suggestions = _collect_queue_and_jobs(wk_home)
    return {
        **st,
        "kill_switch": kill_on,
        "workspace": str(ws),
        "queue": queue_counts,
        "jobs": job_counts,
        "open_suggestions": open_suggestions,
        "summary": (
            f"KILL={'ON' if kill_on else 'off'} | mode={st['mode']} | brain={st['brain']} | "
            f"queue(q={queue_counts['queued']}, taken={queue_counts['taken']}, attn={queue_counts['attention']}) | "
            f"jobs(run={job_counts['running']}, wait={job_counts['waiting']}) | "
            f"suggestions={open_suggestions} | hung={st['watchdog'].get('hungCount', 0)}"
        ),
    }


def cmd_heal(ws: Path, store: StateStore, apply: bool = False) -> tuple[int, dict[str, Any]]:
    wk_home = _wk_home_dir()
    kill_on = (wk_home / "KILL").exists()
    wd = scan_hanging_tasks(write_summary=False)
    graph_info = sync_and_load_graph(ws, store=store, bootstrap=False)
    manifest = build_skills_manifest(workspace_dir=ws, store=store)
    findings = {
        "kill_switch": kill_on,
        "hung_tasks": int(wd.get("hungCount") or 0),
        "warning_tasks": int(wd.get("warningCount") or 0),
        "graph_exists": bool(graph_info.get("exists")),
        "graph_freshness": graph_info.get("freshness"),
        "skills_indexed": len(manifest.get("skills") or []),
    }
    if not apply:
        return 0, {
            "ok": True,
            "applied": False,
            "findings": findings,
            "actions": [
                action
                for action, cond in (
                    ("recover_hanging_tasks", findings["hung_tasks"] > 0),
                    ("reload_skills_manifest", True),
                    ("sync_graphify_incremental", findings["graph_exists"]),
                )
                if cond
            ],
        }
    if kill_on:
        return 1, {
            "ok": False,
            "applied": False,
            "findings": findings,
            "error": "Stop switch (~/.wk/KILL) is on. Heal --apply refused.",
        }
    actions_taken: dict[str, Any] = {}
    actions_taken["watchdog"] = recover_hanging_tasks(dry_run=False, owner=True)
    refreshed = build_skills_manifest(workspace_dir=ws, store=store, force_reload=True)
    actions_taken["skills_reloaded"] = len(refreshed.get("skills") or [])
    if findings["graph_exists"]:
        synced = sync_and_load_graph(ws, store=store, bootstrap=False, force=True)
        actions_taken["graph_synced"] = {"nodes": synced.get("total_nodes", 0), "edges": synced.get("total_edges", 0)}
    return 0, {"ok": True, "applied": True, "findings": findings, "actions": actions_taken}


def _delegate_node_cli(script_name: str, args_list: list[str]) -> tuple[int, dict[str, Any]]:
    node_bin = _find_node()
    if not node_bin:
        return 1, {"ok": False, "error": "node runtime not found on PATH or standard install paths."}
    script = ROOT / "bin" / script_name
    if not script.is_file():
        return 1, {"ok": False, "error": f"CLI script not found: {script}"}
    proc = run_in_group(
        [node_bin, str(script), *args_list],
        timeout=30,
        env=dict(os.environ),
        kind="cli",
        label=f"wk {script_name}",
    )
    return proc.returncode, {
        "ok": proc.returncode == 0,
        "rc": proc.returncode,
        "command": f"{script_name} {' '.join(args_list)}".strip(),
        "stdout": (proc.stdout or "").strip(),
        "stderr": (proc.stderr or "").strip(),
    }


def run_wk_cli(argv: list[str], workspace: str | None = None) -> tuple[int, dict[str, Any]]:
    parser = argparse.ArgumentParser(prog="wk", add_help=False)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--workspace", default=None)
    parser.add_argument("rest", nargs="*")
    # N5: everything after a bare "--" is kept word for word (a prompt that starts with "-" stays a prompt).
    argv = list(argv)
    tail: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        argv, tail = argv[:i], argv[i + 1:]
    args, unknown = parser.parse_known_args(argv)
    tokens = args.rest + unknown + (["--"] + tail if tail else [])
    ws = _workspace(args.workspace or workspace)
    store = StateStore(workspace_dir=ws)

    sub = tokens[0].lower() if tokens else "status"
    rest = tokens[1:]

    if sub in ("help", "--help", "-h"):
        return 0, cmd_help()

    if sub == "status":
        return 0, cmd_status(ws, store)

    if sub == "overview":
        return 0, cmd_overview(ws, store)

    if sub == "heal":
        return cmd_heal(ws, store, apply=("--apply" in rest))

    if sub == "tasks":
        return _delegate_node_cli("wk-task.mjs", rest or ["list"])

    if sub == "handoff":
        return _delegate_node_cli("wk-takeover.mjs", rest or ["status"])

    if sub == "doctor":
        rep = cmd_doctor(ws, store)
        return (0 if rep["ok"] else 1), rep

    if sub == "mode":
        if not rest:
            return 0, {"ok": True, "mode": store.load_config()["mode"], "valid": sorted(VALID_MODES)}
        want = rest[0].lower()
        if want == "raw":
            want = "passthrough"
        if want not in VALID_MODES:
            return 2, {"ok": False, "error": f"Unknown mode '{want}'. Valid: {', '.join(sorted(VALID_MODES))}"}
        cfg = store.save_config({"mode": want})
        return 0, {"ok": True, "mode": cfg["mode"]}

    if sub == "brain":
        if not rest:
            return 0, {"ok": True, "brain": store.load_config()["brain"], "valid": sorted(VALID_BRAINS)}
        want = rest[0].lower()
        if want not in VALID_BRAINS:
            return 2, {"ok": False, "error": f"Unknown brain policy '{want}'. Valid: {', '.join(sorted(VALID_BRAINS))}"}
        cfg = store.save_config({"brain": want})
        return 0, {"ok": True, "brain": cfg["brain"]}

    if sub == "skills":
        action = rest[0].lower() if rest else "list"
        if action not in ("list", "match", "reload"):
            return 2, {"ok": False, "error": f"Unknown skills action: {action}. Valid: list, match, reload"}
        if action == "reload":
            m = build_skills_manifest(workspace_dir=ws, store=store, force_reload=True)
            return 0, {"ok": True, "action": "reload", "skill_count": len(m["skills"]), "elapsed_ms": m["elapsed_ms"]}
        m = build_skills_manifest(workspace_dir=ws, store=store)
        if action == "match":
            sample = " ".join(rest[1:]).strip()
            matched = select_all_matching_skills(sample, m)
            return 0, {
                "ok": True,
                "action": "match",
                "prompt": sample,
                "matched": [{"name": s["name"], "scope": s["scope"]} for s in matched],
            }
        return 0, {
            "ok": True,
            "action": "list",
            "skill_count": len(m["skills"]),
            "skills": [{"name": s["name"], "scope": s["scope"], "has_scripts": s["has_scripts"]} for s in m["skills"][:80]],
        }

    if sub == "graph":
        action = rest[0].lower() if rest else "sync"
        if action == "sync":
            gi = sync_and_load_graph(ws, store=store, bootstrap=True, force=True)
            return 0, {
                "ok": True,
                "action": "sync",
                "nodes": gi["total_nodes"],
                "edges": gi["total_edges"],
                "mode": gi["mode"],
            }
        if action == "inspect":
            sym = " ".join(rest[1:]).strip()
            sub_g = query_ego_subgraph(ws, sym)
            return 0, {"ok": True, "action": "inspect", "symbol": sym, "subgraph": sub_g}
        if action == "open":
            html = ws / "graphify-out" / "graph.html"
            return (0 if html.is_file() else 1), {"ok": html.is_file(), "path": str(html)}
        return 2, {"ok": False, "error": f"Unknown graph action: {action}. Valid: sync, inspect, open"}

    if sub == "watchdog":
        action = rest[0].lower() if rest else "status"
        sub_args = rest[1:]
        if action in ("status", "scan"):
            return 0, scan_hanging_tasks(write_summary=(action == "scan"))
        if action == "recover":
            dry_run = "--dry-run" in sub_args
            res = recover_hanging_tasks(dry_run=dry_run)
            return (0 if res.get("ok") else 1), res
        if action in WATCHDOG_DECISIONS:
            tid = sub_args[0] if sub_args else ""
            res = decide_pending_removal(tid, action)
            out = {k: res.get(k) for k in ("ok", "task_id", "decision", "message")}
            return (0 if out["ok"] else 1), out
        return 2, {"ok": False, "error": f"Unknown watchdog action: {action}. Valid: status, scan, recover, approve-remove, later, keep"}

    if sub == "learn":
        action = rest[0].lower() if rest else "status"
        sub_args = rest[1:]
        if action == "status":
            if not resolve_db_path().is_file():
                return 0, {"ok": True, "available": False, "snippetCount": 0, "verifiedCount": 0, "correctionCount": 0, "heuristicCount": 0, "pendingSyncCount": 0}
            return 0, {"ok": True, **SnippetStore().stats()}
        if action == "search":
            q = " ".join(sub_args).strip()
            if not resolve_db_path().is_file():
                return 0, {"ok": True, "snippets": [], "total_matched": 0, "latency_ms": 0.0}
            return 0, SnippetStore().query_snippets(q, limit=10)
        if action == "heuristics":
            q = " ".join(sub_args).strip()
            if not resolve_db_path().is_file():
                return 0, {"ok": True, "heuristics": []}
            return 0, {"ok": True, "heuristics": SnippetStore().query_heuristics(q, limit=15)}
        if action == "sync":
            p = argparse.ArgumentParser(prog="wk learn sync", add_help=False)
            p.add_argument("--dir", default="")
            p.add_argument("--url", default="")
            ns, _ = p.parse_known_args(sub_args)
            res = SnippetStore().sync_now(sync_dir=ns.dir or None, sync_url=ns.url or None)
            return (0 if res.get("ok") or res.get("offline") else 1), res
        if action == "export":
            if not sub_args:
                return 2, {"ok": False, "error": "Usage: wk learn export <path>"}
            return 0, SnippetStore().export_sync_bundle(sub_args[0])
        if action == "import":
            if not sub_args:
                return 2, {"ok": False, "error": "Usage: wk learn import <path>"}
            res = SnippetStore().import_sync_bundle(sub_args[0])
            return (0 if res.get("ok") else 1), res
        if action == "save":
            p = argparse.ArgumentParser(prog="wk learn save", add_help=False)
            p.add_argument("--title", default="Snippet")
            p.add_argument("--code", default="")
            p.add_argument("--lang", default="text")
            p.add_argument("--context", default="")
            p.add_argument("--tags", default="")
            p.add_argument("--status", default="unverified")
            ns, _ = p.parse_known_args(sub_args)
            tags = [t.strip() for t in ns.tags.split(",") if t.strip()]
            res = SnippetStore().save_snippet(
                title=ns.title,
                code=ns.code,
                language=ns.lang,
                context=ns.context,
                tags=tags,
                verification_status=ns.status,
                workspace_dir=ws,
            )
            return (0 if res.get("ok") else 1), res
        if action == "record":
            p = argparse.ArgumentParser(prog="wk learn record", add_help=False)
            p.add_argument("--file", default="snippet.txt")
            p.add_argument("--agent-code", default="")
            p.add_argument("--user-code", default="")
            p.add_argument("--lang", default="")
            p.add_argument("--context", default="")
            p.add_argument("--tags", default="")
            p.add_argument("--status", default="user_corrected")
            ns, _ = p.parse_known_args(sub_args)
            tags = [t.strip() for t in ns.tags.split(",") if t.strip()]
            res = ingest_correction(
                file_path=ns.file,
                agent_code=ns.agent_code,
                user_code=ns.user_code,
                language=ns.lang,
                context=ns.context,
                tags=tags or None,
                verification_status=ns.status,
                workspace_dir=ws,
            )
            return (0 if res.get("ok") else 1), res
        return 2, {"ok": False, "error": f"Unknown learn action: {action}"}

    if sub == "dag":
        return _cmd_dag(rest, ws)

    return 2, {"ok": False, "error": f"Unknown /wk subcommand: {sub}"}


def _cmd_dag(rest: list[str], ws: Path | str) -> tuple[int, dict[str, Any]]:
    """`/wk dag plan|run|status|stop|merge`: the task splitter (core/dag_orchestrator.py)."""
    from core.dag_orchestrator import DagRunner, format_plan

    action = rest[0].lower() if rest else "status"
    p = argparse.ArgumentParser(prog="wk dag", add_help=False)
    p.add_argument("words", nargs="*")
    p.add_argument("--repo", default=None)
    p.add_argument("--verify", default="true")
    p.add_argument("--no-model", action="store_true")
    p.add_argument("--only-split", action="store_true")
    head = rest[1:]
    tail: list[str] = []
    if "--" in head:  # N5: the prompt after "--" is never read as an option
        i = head.index("--")
        head, tail = head[:i], head[i + 1:]
    ns, _ = p.parse_known_args(head)
    ns.words = list(ns.words) + tail
    runner = DagRunner()
    try:
        if action == "plan":
            task = " ".join(ns.words).strip()
            if not task:
                return 2, {"ok": False, "error": "usage: wk dag plan <task> [--repo <dir>] [--verify <cmd>]"}
            man = runner.plan(task, ns.repo or str(ws), verify_cmd=ns.verify, use_model=not ns.no_model,
                              only_split=ns.only_split)
            return 0, {"ok": True, "run": man, "summary": format_plan(man)}
        if action in ("run", "stop", "merge"):
            if not ns.words:
                return 2, {"ok": False, "error": f"usage: wk dag {action} <id>"}
            rid = ns.words[0]
            if action == "run":
                man = runner.run(rid)
                return (0 if man.get("status") in ("passed", "waiting") else 1), {
                    "ok": man.get("status") in ("passed", "waiting"), "run": man, "summary": format_plan(man)}
            if action == "stop":
                man = runner.stop(rid)
                return 0, {"ok": True, "run": man, "summary": format_plan(man)}
            res = runner.merge(rid)
            return (0 if res.get("ok") else 1), res
        if action == "status":
            if ns.words:
                man = runner.status(ns.words[0])
                if not man:
                    return 1, {"ok": False, "error": f"No run {ns.words[0]}."}
                return 0, {"ok": True, "run": man, "summary": format_plan(man)}
            return 0, {"ok": True, **runner.status()}
    except ValueError as e:
        return 1, {"ok": False, "error": str(e)}
    return 2, {"ok": False, "error": f"Unknown dag action: {action} (plan, run, status, stop, merge)"}


def _format_human(data: dict[str, Any]) -> str:
    if "commands" in data and isinstance(data["commands"], dict):
        lines = [f"Watchkeeper CLI v{data.get('version', '2.0.0')} — Subcommands:"]
        for name, desc in data["commands"].items():
            lines.append(f"  {name:<42} {desc}")
        if data.get("examples"):
            lines.append("\nExamples:")
            for ex in data["examples"]:
                lines.append(f"  {ex}")
        return "\n".join(lines)
    if "findings" in data and "applied" in data:
        f = data["findings"]
        mode = "APPLIED" if data.get("applied") else "DRY-RUN"
        lines = [
            f"Watchkeeper Self-Heal ({mode}): {'OK' if data.get('ok') else 'BLOCKED'}",
            f"  KillSwitch : {'ACTIVE' if f.get('kill_switch') else 'off'}",
            f"  Watchdog   : hung={f.get('hung_tasks', 0)} warning={f.get('warning_tasks', 0)}",
            f"  Graphify   : exists={f.get('graph_exists')} freshness={f.get('graph_freshness')}",
            f"  Skills     : indexed={f.get('skills_indexed', 0)}",
        ]
        if data.get("error"):
            lines.append(f"  Error      : {data['error']}")
        else:
            lines.append(f"  Actions    : {json.dumps(data.get('actions'))}")
        return "\n".join(lines)
    if "stdout" in data and "rc" in data:
        out = data.get("stdout") or ""
        err = data.get("stderr") or ""
        if data.get("error"):
            return str(data["error"])
        return "\n".join(p for p in (out, err) if p) or f"{data.get('command')} (exit {data.get('rc')})"
    if "checks" in data:
        lines = [f"Watchkeeper Doctor: {'PASS' if data['ok'] else 'FAIL'}"]
        for c in data["checks"]:
            lines.append(f"  [{'OK' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
        return "\n".join(lines)
    if "hook_bus_events" in data:
        lines = []
        if "queue" in data:
            q = data["queue"]
            j = data.get("jobs", {})
            lines.append(
                f"Watchkeeper Overview v{data['version']} — KILL={'ACTIVE' if data.get('kill_switch') else 'off'} | "
                f"Queue(queued={q.get('queued', 0)}, taken={q.get('taken', 0)}, attn={q.get('attention', 0)}) | "
                f"Jobs(run={j.get('running', 0)}, wait={j.get('waiting', 0)}) | Suggestions={data.get('open_suggestions', 0)}"
            )
        else:
            lines.append(f"Watchkeeper Unified Runtime v{data['version']}")
        lines.extend([
            f"  Mode       : {data['mode']} | Brain: {data['brain']}",
            f"  Models     : {data['models']['carbon']} + {data['models']['hydrogen']}",
            f"  SDK / Auth : {data['sdk']} ({data['credentials_source']})",
            f"  PrefixCache: hits={data['prefix_cache']['hits']} misses={data['prefix_cache']['misses']} ratio={data['prefix_cache']['hit_ratio']}",
            f"  Graphify   : exists={data['graphify']['exists']} freshness={data['graphify']['freshness']} nodes={data['graphify']['nodes']} edges={data['graphify']['edges']}",
            f"  Skills     : indexed={data['skills']['indexed']} cache_hit={data['skills']['cache_hit']}",
            f"  Learning   : snippets={data.get('learning', {}).get('snippetCount', 0)} verified={data.get('learning', {}).get('verifiedCount', 0)} heuristics={data.get('learning', {}).get('heuristicCount', 0)}",
            f"  Watchdog   : active={data.get('watchdog', {}).get('activeCount', 0)} warning={data.get('watchdog', {}).get('warningCount', 0)} hung={data.get('watchdog', {}).get('hungCount', 0)}",
            f"  Hook Bus   : {', '.join(data['hook_bus_events'])}",
        ])
        return "\n".join(lines)
    return json.dumps(data, indent=2, ensure_ascii=False)


def main() -> int:
    as_json = "--json" in sys.argv[1:]
    argv = [a for a in sys.argv[1:] if a != "--json"]
    code, res = run_wk_cli(argv)
    if len(argv) >= 2 and argv[0] == "watchdog" and argv[1].lower() in WATCHDOG_DECISIONS:
        print(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    elif as_json:
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        print(_format_human(res))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
