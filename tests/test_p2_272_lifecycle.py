#!/usr/bin/env python3
"""P2-272 lifecycle tests: Antigravity hook output, watchdog pending removals (owner approval),
the wk CLI decision line, and run_in_group leaving no orphan processes.

Everything runs in a temporary WK_HOME and a temporary git repo; nothing touches ~/.wk.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "reprompt") not in sys.path:
    sys.path.insert(0, str(ROOT / "reprompt"))

from core import hook_bus  # noqa: E402
from core.watchdog import (  # noqa: E402
    decide_pending_removal,
    load_pending_removals,
    recover_hanging_tasks,
    run_in_group,
    task_liveness,
)

DAY_MS = 24 * 3600 * 1000


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True)
    return r.stdout.strip()


def _dead_pid() -> int:
    p = subprocess.Popen(["/usr/bin/true"])
    p.wait()
    return p.pid


class _TempHome(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name).resolve()
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
        keys = ("WK_HOME", "WK_SNIPPET_DB", "WK_AUTO_RECOVER_HANGS", "WK_HOST")
        self._prev_env = {k: os.environ.get(k) for k in keys}
        os.environ["WK_HOME"] = str(self.wk_home)
        os.environ["WK_SNIPPET_DB"] = str(self.wk_home / "learning" / "snippets.db")
        os.environ.pop("WK_AUTO_RECOVER_HANGS", None)
        os.environ.pop("WK_HOST", None)

    def tearDown(self) -> None:
        for k, v in self._prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def make_taken_task(self, tid: str, pid: int, *, dirty: bool = False) -> Path:
        wt = self.wk_home / "worktrees" / tid
        wt.parent.mkdir(parents=True, exist_ok=True)
        _git(self.repo, "worktree", "add", "--detach", str(wt), self.base_sha)
        if dirty:
            (wt / "app.py").write_text("print('changed')\n", encoding="utf-8")
            (wt / "new.txt").write_text("untracked\n", encoding="utf-8")
        tdir = self.wk_home / "tasks" / tid
        tdir.mkdir(parents=True, exist_ok=True)
        (tdir / "claim").write_text(str(pid), encoding="utf-8")
        (tdir / "meta.json").write_text(json.dumps({
            "id": tid, "title": "Lifecycle test", "status": "taken", "repo": str(self.repo),
            "base": self.base_sha, "worktree": str(wt), "taken_at": "2020-01-01T00:00:00+00:00",
        }), encoding="utf-8")
        return wt

    def meta(self, tid: str) -> dict:
        return json.loads((self.wk_home / "tasks" / tid / "meta.json").read_text(encoding="utf-8"))


class AntigravityHookOutputTests(_TempHome):
    def test_inject_shape_has_no_type_key(self) -> None:
        out = json.loads(hook_bus._ag_inject("Hello", "badge"))
        step = out["injectSteps"][0]
        self.assertEqual(list(step.keys()), ["systemMessage"])
        self.assertNotIn("type", step)
        self.assertEqual(step["systemMessage"]["systemMessage"], "Hello")
        self.assertEqual(step["systemMessage"]["metadata"]["user_markdown"], "badge")

    def test_session_start_with_conversation_id_answers_json(self) -> None:
        rc, out, _ = hook_bus.handle_event("SessionStart", json.dumps({"conversationId": "c1", "cwd": str(self.repo)}), bypass_subprocesses=True)
        self.assertEqual(rc, 0)
        parsed = json.loads(out)
        self.assertTrue(parsed == {} or "injectSteps" in parsed, out)
        self.assertNotIn("hookSpecificOutput", parsed)

    def test_stop_plain_is_empty_object(self) -> None:
        rc, out, _ = hook_bus.handle_event("Stop", json.dumps({"conversationId": "c1", "cwd": str(self.repo)}), bypass_subprocesses=True)
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {})

    def _blocking_gate(self) -> mock._patch:
        cp = subprocess.CompletedProcess(args=["node"], returncode=2, stdout='{"decision":"block","reason":"x"}', stderr="")
        return mock.patch.object(hook_bus, "_run_node_script", return_value=cp)

    def test_stop_block_becomes_continue(self) -> None:
        with self._blocking_gate():
            rc, out, _ = hook_bus.handle_event("Stop", json.dumps({"conversationId": "c1", "cwd": str(self.repo)}))
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {"decision": "continue", "reason": "x"})

    def test_stop_block_with_continuation_active_is_empty(self) -> None:
        with self._blocking_gate():
            rc, out, _ = hook_bus.handle_event("Stop", json.dumps({"conversationId": "c1", "cwd": str(self.repo), "continuationActive": True}))
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {})

    def test_claude_stop_output_unchanged(self) -> None:
        with self._blocking_gate():
            rc, out, _ = hook_bus.handle_event("Stop", json.dumps({"session_id": "s1", "hook_event_name": "Stop", "cwd": str(self.repo)}))
        self.assertNotIn("continue", out)
        self.assertNotIn("injectSteps", out)
        self.assertIn("block", out + str(rc))


class PendingRemovalTests(_TempHome):
    TID = "20261123-120000-p2-272-life"

    def future(self) -> int:
        return int(time.time() * 1000) + 3 * DAY_MS

    def test_quiet_dead_task_is_recorded_once_and_nothing_deleted(self) -> None:
        wt = self.make_taken_task(self.TID, _dead_pid())
        now = self.future()
        r1 = recover_hanging_tasks(self.wk_home, now_ms=now, record_learning=False)
        acts = [x for x in r1.get("recovered", []) if x.get("id") == self.TID]
        self.assertEqual(len(acts), 1, r1)
        self.assertEqual(acts[0]["action"], "recorded_pending_removal")
        items = load_pending_removals(self.wk_home)["items"]
        self.assertIn(self.TID, items)
        first_notice = items[self.TID]["notified_at"]
        r2 = recover_hanging_tasks(self.wk_home, now_ms=now + 60_000, record_learning=False)
        self.assertEqual([x for x in r2.get("recovered", []) if x.get("id") == self.TID and x.get("suggestion_id") and x.get("suggestion_id") != acts[0].get("suggestion_id")], [])
        self.assertEqual(load_pending_removals(self.wk_home)["items"][self.TID]["notified_at"], first_notice)
        sugs = (self.wk_home / "suggestions.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(sum(1 for s in sugs if self.TID in s), 1, "one notice per hung task")
        self.assertTrue(wt.exists(), "the worktree is never deleted without the owner")

    def test_live_pid_means_alive_and_approve_is_refused(self) -> None:
        proc = subprocess.Popen(["/bin/sleep", "30"])
        try:
            wt = self.make_taken_task(self.TID, proc.pid)
            m = self.meta(self.TID)
            m["pid"] = proc.pid
            (self.wk_home / "tasks" / self.TID / "meta.json").write_text(json.dumps(m), encoding="utf-8")
            life = task_liveness(self.wk_home, self.TID, m, now_ms=self.future())
            self.assertTrue(life["alive"], life)
            # Record it by hand as pending (a scan would not, since it is alive).
            from core.watchdog import _record_pending_removal
            _record_pending_removal(self.wk_home, {"id": self.TID, "worktree": str(wt), "repo": str(self.repo)}, self.future())
            res = decide_pending_removal(self.TID, "approve-remove", wk_home=self.wk_home, now_ms=self.future())
            self.assertFalse(res["ok"])
            self.assertIn("Still working", res["message"])
            self.assertTrue(wt.exists())
        finally:
            proc.kill()
            proc.wait()

    def test_approve_when_dead_backs_up_removes_and_requeues(self) -> None:
        wt = self.make_taken_task(self.TID, _dead_pid(), dirty=True)
        now = self.future()
        recover_hanging_tasks(self.wk_home, now_ms=now, record_learning=False)
        self.assertIn(self.TID, load_pending_removals(self.wk_home)["items"])
        res = decide_pending_removal(self.TID, "approve-remove", wk_home=self.wk_home, now_ms=now + 1000)
        self.assertTrue(res["ok"], res)
        self.assertFalse(wt.exists(), "worktree removed after approval")
        backups = list((self.wk_home / "backups" / "worktrees").glob(self.TID + "-*"))
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / "changes.patch").exists())
        self.assertIn("changed", (backups[0] / "changes.patch").read_text(encoding="utf-8"))
        self.assertTrue((backups[0] / "untracked.tar").exists())
        m = self.meta(self.TID)
        self.assertEqual(m["status"], "queued")
        self.assertFalse((self.wk_home / "tasks" / self.TID / "claim").exists())
        self.assertTrue(load_pending_removals(self.wk_home)["items"][self.TID]["removed_at"])

    def test_later_and_keep(self) -> None:
        self.make_taken_task(self.TID, _dead_pid())
        now = self.future()
        recover_hanging_tasks(self.wk_home, now_ms=now, record_learning=False)
        res = decide_pending_removal(self.TID, "later", wk_home=self.wk_home, now_ms=now)
        self.assertTrue(res["ok"], res)
        entry = load_pending_removals(self.wk_home)["items"][self.TID]
        from core.watchdog import _parse_ts_ms
        self.assertAlmostEqual(_parse_ts_ms(entry["later_until"]) - now, DAY_MS, delta=2000)
        res = decide_pending_removal(self.TID, "keep", wk_home=self.wk_home, now_ms=now)
        self.assertTrue(res["ok"], res)
        self.assertEqual(load_pending_removals(self.wk_home)["items"][self.TID]["decision"], "kept")

    def test_kill_switch_refuses_approve(self) -> None:
        wt = self.make_taken_task(self.TID, _dead_pid())
        now = self.future()
        recover_hanging_tasks(self.wk_home, now_ms=now, record_learning=False)
        (self.wk_home / "KILL").write_text("stop\n", encoding="utf-8")
        res = decide_pending_removal(self.TID, "approve-remove", wk_home=self.wk_home, now_ms=now)
        self.assertFalse(res["ok"])
        self.assertIn("Stop switch is on", res["message"])
        self.assertTrue(wt.exists())

    def test_cli_prints_one_json_line(self) -> None:
        self.make_taken_task(self.TID, _dead_pid())
        recover_hanging_tasks(self.wk_home, now_ms=self.future(), record_learning=False)
        env = dict(os.environ)
        r = subprocess.run([sys.executable, str(ROOT / "core" / "wk_cli.py"), "watchdog", "later", self.TID],
                           capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=60)
        lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, r.stdout + r.stderr)
        parsed = json.loads(lines[0])
        for k in ("ok", "task_id", "decision", "message"):
            self.assertIn(k, parsed)
        self.assertTrue(parsed["ok"])
        self.assertEqual(r.returncode, 0)
        bad = subprocess.run([sys.executable, str(ROOT / "core" / "wk_cli.py"), "watchdog", "later", "nope"],
                             capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=60)
        self.assertEqual(bad.returncode, 1)
        self.assertFalse(json.loads(bad.stdout.strip().splitlines()[-1])["ok"])


class RunInGroupOrphanTests(_TempHome):
    def test_timeout_kills_the_whole_group(self) -> None:
        marker = "p2272orphan%d" % os.getpid()
        cmd = ["/bin/sh", "-c", f"/bin/sleep 300 & /bin/sleep 301 & echo {marker}; wait"]
        start = time.time()
        with self.assertRaises(subprocess.TimeoutExpired):
            run_in_group(cmd, timeout=1.0, grace_ms=300, register=False, wk_home=self.wk_home)
        self.assertLess(time.time() - start, 15)
        time.sleep(0.3)
        left = subprocess.run(["/usr/bin/pgrep", "-f", "^/bin/sleep 30[01]$"], capture_output=True, text=True)
        # Any matching sleep must not be an orphan from this test (PPID 1).
        orphans = []
        for pid in left.stdout.split():
            pp = subprocess.run(["/bin/ps", "-o", "ppid=", "-p", pid], capture_output=True, text=True).stdout.strip()
            if pp == "1":
                orphans.append(pid)
        self.assertEqual(orphans, [], "run_in_group left orphan sleeps")


if __name__ == "__main__":
    unittest.main()
