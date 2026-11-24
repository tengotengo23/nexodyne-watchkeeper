#!/usr/bin/env python3
"""Tests for Watchkeeper dynamic hanging-task watchdog & auto-recovery across core, CLI, hooks, and MCP."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "reprompt") not in sys.path:
    sys.path.insert(0, str(ROOT / "reprompt"))

from core.hook_bus import handle_event  # noqa: E402
from core.snippet_store import SnippetStore  # noqa: E402
from core.watchdog import (  # noqa: E402
    _classify_process_signal,
    _pid_alive,
    decide_pending_removal,
    inspect_process_tree,
    load_pending_removals,
    recover_hanging_tasks,
    register_process,
    scan_hanging_tasks,
)
from core.wk_cli import run_wk_cli  # noqa: E402
from server.reprompt_engine import RePromptStore  # noqa: E402
from server.reprompt_mcp_server import TOOLS, execute_tool  # noqa: E402


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True)
    return r.stdout.strip()


class DynamicWatchdogTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.wk_home = self.base / "wk_state"
        self.wk_home.mkdir(parents=True, exist_ok=True)
        self.repo = self.base / "repo"
        self.repo.mkdir(parents=True, exist_ok=True)
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.name", "Watchkeeper Test")
        _git(self.repo, "config", "user.email", "wk-test@example.com")
        (self.repo / "app.py").write_text("print('ok')\n", encoding="utf-8")
        _git(self.repo, "add", "app.py")
        _git(self.repo, "commit", "-q", "-m", "init")
        self.base_sha = _git(self.repo, "rev-parse", "HEAD")

        self._prev_env = {k: os.environ.get(k) for k in ("WK_HOME", "WK_SNIPPET_DB", "WK_AUTO_RECOVER_HANGS")}
        os.environ["WK_HOME"] = str(self.wk_home)
        os.environ["WK_SNIPPET_DB"] = str(self.wk_home / "learning" / "snippets.db")
        os.environ.pop("WK_AUTO_RECOVER_HANGS", None)
        self._procs: list[subprocess.Popen[str]] = []

    def tearDown(self) -> None:
        for p in self._procs:
            if p.poll() is None:
                try:
                    os.killpg(os.getpgid(p.pid), 9)
                except Exception:
                    try:
                        p.kill()
                    except Exception:
                        pass
                try:
                    p.wait(timeout=2)
                except Exception:
                    pass
        for k, v in self._prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def test_cpu_override_prevents_false_positive_and_process_tree_kill_has_no_orphans(self) -> None:
        # 1. Dynamic signal classifier extends active CPU-bound tasks beyond idle stall window
        cls_busy, reason_busy = _classify_process_signal(
            alive=True,
            zombie=False,
            stopped=False,
            total_cpu=18.5,
            idle_ms=900_000,
            elapsed_ms=900_000,
            stall_ms=300_000,
            max_wall_ms=3_600_000,
        )
        self.assertEqual(cls_busy, "active")
        self.assertEqual(reason_busy, "active_cpu_override")

        # 2. Real sleeping parent + grandchild process group is detected & killed without leaving orphans
        pid_file = self.base / "grandchild.pid"
        cmd = f"sleep 30 & echo $! > {json.dumps(str(pid_file))}; wait"
        proc = subprocess.Popen(
            ["/bin/sh", "-c", cmd],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._procs.append(proc)

        deadline = time.monotonic() + 3.0
        grandchild_pid = 0
        while time.monotonic() < deadline:
            if pid_file.is_file() and pid_file.read_text(encoding="utf-8").strip().isdigit():
                grandchild_pid = int(pid_file.read_text(encoding="utf-8").strip())
                break
            time.sleep(0.05)
        self.assertGreater(grandchild_pid, 1)
        self.assertTrue(_pid_alive(proc.pid))
        self.assertTrue(_pid_alive(grandchild_pid))

        register_process(proc.pid, pgid=os.getpgid(proc.pid), kind="test_runner", label="hung-shell", stall_ms=100, wk_home=self.wk_home)
        tree = inspect_process_tree(proc.pid, os.getpgid(proc.pid))
        self.assertIn(proc.pid, tree["pids"])
        self.assertIn(grandchild_pid, tree["pids"])

        now_ms = int(time.time() * 1000) + 10_000
        scan = scan_hanging_tasks(self.wk_home, now_ms=now_ms, proc_stall_ms=100, write_summary=True)
        self.assertEqual(scan["hungCount"], 1)
        self.assertEqual(scan["items"][0]["surface"], "process")

        rec = recover_hanging_tasks(self.wk_home, now_ms=now_ms, proc_stall_ms=100, grace_ms=400)
        self.assertTrue(rec["ok"])
        self.assertEqual(rec["recoveredCount"], 1)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.fail("Stalled process did not exit after recovery")
        time.sleep(0.1)
        self.assertFalse(_pid_alive(proc.pid))
        self.assertFalse(_pid_alive(grandchild_pid))

        # Learning loop recorded a cleanup_lifecycle heuristic from recovery
        heurs = SnippetStore().query_heuristics("process groups unref watchdogs")
        self.assertGreaterEqual(len(heurs), 1)
        self.assertEqual(heurs[0]["category"], "cleanup_lifecycle")

    def test_recover_jobs_clean_and_dirty_tasks_chat_turns_and_kill_switch(self) -> None:
        now_ms = int(time.time() * 1000)
        old_ms = now_ms - 60 * 60 * 1000

        # 1. Dead-runner job + live silent job
        j_dead = "J-20261122-0100-aaaa"
        j_live = "J-20261122-0101-bbbb"
        old_mtime = time.time() - 7200
        for jid in (j_dead, j_live):
            d = self.wk_home / "jobs" / jid
            d.mkdir(parents=True, exist_ok=True)
            ev_p = d / "events.jsonl"
            ev_p.write_text(json.dumps({"n": 1, "at": old_ms, "type": "init"}) + "\n", encoding="utf-8")
            os.utime(ev_p, (old_mtime, old_mtime))

        (self.wk_home / "jobs" / j_dead / "meta.json").write_text(
            json.dumps({"id": j_dead, "project": "p1", "state": "running", "runner_pid": 999999, "events": 1, "queued_at": old_ms, "started_at": old_ms}),
            encoding="utf-8",
        )

        silent_job_proc = subprocess.Popen(
            ["/bin/sh", "-c", "sleep 30"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._procs.append(silent_job_proc)
        (self.wk_home / "jobs" / j_live / "meta.json").write_text(
            json.dumps({
                "id": j_live,
                "project": "p2",
                "state": "running",
                "runner_pid": silent_job_proc.pid,
                "pgid": os.getpgid(silent_job_proc.pid),
                "events": 1,
                "queued_at": old_ms,
                "started_at": old_ms,
                "last_activity_at": old_ms,
            }),
            encoding="utf-8",
        )

        # 2. Clean stalled task -> auto requeued, worktree + claim removed
        tid_clean = "20261122-010200-clean-task"
        wt_clean = self.wk_home / "worktrees" / tid_clean
        wt_clean.parent.mkdir(parents=True, exist_ok=True)
        _git(self.repo, "worktree", "add", "--detach", str(wt_clean), self.base_sha)
        tdir_clean = self.wk_home / "tasks" / tid_clean
        tdir_clean.mkdir(parents=True, exist_ok=True)
        (tdir_clean / "claim").write_text("99999\n", encoding="utf-8")
        (tdir_clean / "meta.json").write_text(
            json.dumps({
                "id": tid_clean,
                "title": "Clean stalled task",
                "status": "taken",
                "repo": str(self.repo),
                "base": self.base_sha,
                "worktree": str(wt_clean),
                "taken_at": "2020-01-01T00:00:00+00:00",
            }),
            encoding="utf-8",
        )
        old_mtime = time.time() - 7200
        os.utime(wt_clean / "app.py", (old_mtime, old_mtime))

        # 3. Dirty stalled task -> preserves worktree, writes change.diff, adds one idempotent suggestion
        tid_dirty = "20261122-010300-dirty-task"
        wt_dirty = self.wk_home / "worktrees" / tid_dirty
        _git(self.repo, "worktree", "add", "--detach", str(wt_dirty), self.base_sha)
        (wt_dirty / "app.py").write_text("print('unsaved-work')\n", encoding="utf-8")
        os.utime(wt_dirty / "app.py", (old_mtime, old_mtime))
        tdir_dirty = self.wk_home / "tasks" / tid_dirty
        tdir_dirty.mkdir(parents=True, exist_ok=True)
        (tdir_dirty / "meta.json").write_text(
            json.dumps({
                "id": tid_dirty,
                "title": "Dirty stalled task",
                "status": "taken",
                "repo": str(self.repo),
                "base": self.base_sha,
                "worktree": str(wt_dirty),
                "taken_at": "2020-01-01T00:00:00+00:00",
            }),
            encoding="utf-8",
        )

        # 4. Stuck chat session turn
        (self.wk_home / "chat-sessions.json").write_text(
            json.dumps({
                "version": 1,
                "sessions": [{
                    "id": "WKS-20261122-010000-abcd",
                    "title": "Hung session",
                    "updatedAt": old_ms,
                    "turns": [{"id": "T-abc12345", "rawPrompt": "Fix", "status": "running", "createdAt": old_ms, "updatedAt": old_ms}],
                }],
            }),
            encoding="utf-8",
        )

        # Verify KILL refuses recovery while allowing scan
        kill_file = self.wk_home / "KILL"
        kill_file.write_text("", encoding="utf-8")
        scan_only = scan_hanging_tasks(self.wk_home, now_ms=now_ms, job_stall_ms=60_000, task_stale_ms=60_000, chat_stall_ms=60_000)
        self.assertEqual(scan_only["hungCount"], 5)
        blocked = recover_hanging_tasks(self.wk_home, now_ms=now_ms, job_stall_ms=60_000, task_stale_ms=60_000, chat_stall_ms=60_000)
        self.assertFalse(blocked["ok"])
        self.assertTrue(blocked["killed"])

        kill_file.unlink()
        rec = recover_hanging_tasks(self.wk_home, now_ms=now_ms, job_stall_ms=60_000, task_stale_ms=60_000, chat_stall_ms=60_000, grace_ms=400)
        self.assertTrue(rec["ok"])
        self.assertEqual(rec["recoveredCount"], 5)

        silent_job_proc.wait(timeout=2)
        self.assertEqual(json.loads((self.wk_home / "jobs" / j_dead / "meta.json").read_text())["state"], "failed")
        self.assertEqual(json.loads((self.wk_home / "jobs" / j_live / "meta.json").read_text())["state"], "failed")

        # P2-272 (owner's spec, Phase 0 item 4): no worktree is deleted by the clock alone. The quiet clean task
        # waits as a pending removal with its worktree intact until the owner presses OK in the W panel; after
        # that OK the old outcome holds (requeued, claim and worktree gone).
        clean_wait = json.loads((tdir_clean / "meta.json").read_text())
        self.assertEqual(clean_wait["status"], "taken")
        self.assertTrue(wt_clean.is_dir())
        pending = load_pending_removals(self.wk_home)["items"]
        self.assertIn(tid_clean, pending)
        self.assertIsNone(pending[tid_clean]["decision"])
        approved = decide_pending_removal(tid_clean, "approve-remove", wk_home=self.wk_home, now_ms=now_ms + 1000)
        self.assertTrue(approved["ok"], approved)

        clean_after = json.loads((tdir_clean / "meta.json").read_text())
        self.assertEqual(clean_after["status"], "queued")
        self.assertEqual(clean_after["requeue_count"], 1)
        self.assertFalse((tdir_clean / "claim").exists())
        self.assertFalse(wt_clean.exists())

        dirty_after = json.loads((tdir_dirty / "meta.json").read_text())
        self.assertEqual(dirty_after["status"], "taken")
        self.assertTrue(wt_dirty.is_dir())
        self.assertTrue((tdir_dirty / "change.diff").is_file())
        self.assertIn("unsaved-work", (tdir_dirty / "change.diff").read_text(encoding="utf-8"))
        self.assertTrue(dirty_after.get("stalled_suggestion_id", "").startswith("S-"))

        # Re-running recover must NOT duplicate the suggestion line for dirty task
        rec2 = recover_hanging_tasks(self.wk_home, now_ms=now_ms, job_stall_ms=60_000, task_stale_ms=60_000, chat_stall_ms=60_000)
        # P2-272: the clean task's removal question is a suggestion too, and the owner's OK closed it with an "ok"
        # event (the panel's own format). Still exactly one suggestion per stalled task: none duplicated by the re-run.
        rows = [json.loads(l) for l in (self.wk_home / "suggestions.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        items = [r for r in rows if "title" in r]
        events = [r for r in rows if "status" in r]
        item_ids = [r["id"] for r in items]
        clean_sug = clean_wait["stalled_suggestion_id"]
        self.assertEqual(len(items), 2)
        self.assertEqual(len(set(item_ids)), 2)
        self.assertIn(dirty_after["stalled_suggestion_id"], item_ids)
        self.assertIn(clean_sug, item_ids)
        self.assertEqual([(e["id"], e["status"]) for e in events], [(clean_sug, "ok")])
        self.assertGreaterEqual(rec2["remainingHungCount"], 1)

        chat_after = json.loads((self.wk_home / "chat-sessions.json").read_text())
        self.assertEqual(chat_after["sessions"][0]["turns"][0]["status"], "error")

    def test_cli_hook_bus_and_mcp_wk_watchdog(self) -> None:
        self.assertIn("wk_watchdog", {t["name"] for t in TOOLS})

        old_ms = int(time.time() * 1000) - 3_600_000
        (self.wk_home / "chat-sessions.json").write_text(
            json.dumps({
                "version": 1,
                "sessions": [{
                    "id": "WKS-20261122-020000-ef12",
                    "title": "CLI hang test",
                    "updatedAt": old_ms,
                    "turns": [{"id": "T-hang1234", "rawPrompt": "Run", "status": "running", "createdAt": old_ms, "updatedAt": old_ms}],
                }],
            }),
            encoding="utf-8",
        )

        # CLI status/doctor/watchdog
        rc_s, st = run_wk_cli(["watchdog", "scan"], workspace=str(self.repo))
        self.assertEqual(rc_s, 0)
        self.assertEqual(st["hungCount"], 1)

        rc_doc, doc = run_wk_cli(["doctor"], workspace=str(self.repo))
        self.assertEqual(rc_doc, 1)  # watchdog_health reports hung=1
        self.assertTrue(any(c["name"] == "watchdog_health" and not c["ok"] for c in doc["checks"]))

        # Hook Bus Stop warns non-destructively when hung items exist
        rc_h, out_h, _ = handle_event("Stop", json.dumps({"cwd": str(self.repo), "session_id": "s_wd"}), bypass_subprocesses=True)
        self.assertEqual(rc_h, 0)
        self.assertIn("Watchkeeper Watchdog", out_h)

        # MCP wk_watchdog recover resolves hung item
        rp_store = RePromptStore(data_dir=self.base / "rp_wd")
        m_out = execute_tool(rp_store, "wk_watchdog", {"action": "recover"})
        self.assertFalse(m_out["isError"])
        self.assertEqual(m_out["structuredContent"]["recoveredCount"], 1)
        self.assertEqual(m_out["structuredContent"]["remainingHungCount"], 0)

        rc_doc2, doc2 = run_wk_cli(["doctor"], workspace=str(self.repo))
        self.assertEqual(rc_doc2, 0, doc2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
