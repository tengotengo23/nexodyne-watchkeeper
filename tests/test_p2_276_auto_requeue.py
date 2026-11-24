"""P2-276: heartbeat as a sign of life, and automatic recovery of dead tasks.

A clean dead task is requeued after the watcher itself saw it quiet for 2 x the stale window, pass after
pass (passes at most 120 s apart; a longer gap, such as a sleeping Mac, resets the count); one with changes
waits 3 x, is backed up (verified) and then requeued; after 3 automatic requeues the owner decides again; KILL stops all of it; a fresh
heartbeat or a live process means the task is never touched. Everything runs in a temporary WK_HOME.
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core.watchdog import (  # noqa: E402
    load_pending_removals,
    recover_hanging_tasks,
    task_heartbeat_ms,
    task_liveness,
)
from test_p2_272_lifecycle import _TempHome, _dead_pid, _git  # noqa: E402

STALE = 60_000


class AutoRequeueTests(_TempHome):
    TID = "20261124-180000-p2-276-auto"

    def _age_worktree(self, wt: Path, t_sec: float) -> None:
        for root, dirs, files in os.walk(wt):
            dirs[:] = [d for d in dirs if d != ".git"]
            for f in files:
                p = Path(root) / f
                if not p.is_symlink():
                    os.utime(p, (t_sec, t_sec))

    def _task(self, *, dirty: bool = False, requeue_count: int = 0, commit: bool = False) -> tuple[Path, int]:
        wt = self.make_taken_task(self.TID, _dead_pid(), dirty=dirty, requeue_count=requeue_count)
        if commit:
            (wt / "committed.txt").write_text("made after base\n", encoding="utf-8")
            _git(wt, "add", "committed.txt")
            _git(wt, "commit", "-q", "-m", "work after base")
        t0 = time.time() - 3600
        self._age_worktree(wt, t0)
        return wt, int(t0 * 1000)

    def _passes(self, start: int, end: int, step: int = STALE) -> list[dict]:
        """One recover pass every `step` ms from start to end (inclusive), as the 30 s watcher would."""
        out = []
        t = start
        while t <= end:
            out.append(recover_hanging_tasks(self.wk_home, now_ms=t, task_stale_ms=STALE, record_learning=False))
            t += step
        return out

    def _actions(self, res: dict) -> list[str]:
        return [r["action"] for r in res.get("recovered", []) if r.get("id") == self.TID]

    def test_heartbeat_is_a_sign_of_life(self) -> None:
        wt, t0 = self._task()
        hb = self.wk_home / "tasks" / self.TID / "heartbeat"
        hb.write_text("", encoding="utf-8")
        os.utime(hb, ((t0 + 5 * STALE) / 1000, (t0 + 5 * STALE) / 1000))
        self.assertEqual(task_heartbeat_ms(self.wk_home, self.TID), t0 + 5 * STALE)
        life = task_liveness(self.wk_home, self.TID, self.meta(self.TID), now_ms=t0 + 5 * STALE + 1000, stale_ms=STALE)
        self.assertTrue(life["alive"], life)
        self.assertIn("heartbeat", life["signs"])
        old = task_liveness(self.wk_home, self.TID, self.meta(self.TID), now_ms=t0 + 7 * STALE, stale_ms=STALE)
        self.assertNotIn("heartbeat", old["signs"])

    def test_symlinked_heartbeat_is_ignored(self) -> None:
        self._task()
        target = self.base / "elsewhere"
        target.write_text("", encoding="utf-8")
        (self.wk_home / "tasks" / self.TID / "heartbeat").symlink_to(target)
        self.assertIsNone(task_heartbeat_ms(self.wk_home, self.TID))

    def test_fresh_heartbeat_blocks_recovery(self) -> None:
        wt, t0 = self._task()
        now = t0 + 10 * STALE
        hb = self.wk_home / "tasks" / self.TID / "heartbeat"
        hb.write_text("", encoding="utf-8")
        os.utime(hb, ((now - 1000) / 1000, (now - 1000) / 1000))
        res = recover_hanging_tasks(self.wk_home, now_ms=now, task_stale_ms=STALE, record_learning=False)
        self.assertEqual(self._actions(res), [], res)
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")

    def test_clean_dead_task_is_requeued_and_worktree_gone(self) -> None:
        wt, t0 = self._task()
        # P2-276 review: the first passes only start the watched quiet count (2 x STALE needed).
        runs = self._passes(t0 + 2 * STALE, t0 + 4 * STALE)
        for early in runs[:-1]:
            self.assertNotIn("auto_requeued", self._actions(early), early)
        res = runs[-1]
        self.assertEqual(self._actions(res), ["auto_requeued"], res)
        self.assertFalse(wt.exists())
        m = self.meta(self.TID)
        self.assertEqual(m["status"], "queued")
        self.assertEqual(m["requeue_count"], 1)

    def test_dirty_task_waits_three_windows_then_is_backed_up_and_requeued(self) -> None:
        wt, t0 = self._task(dirty=True, commit=True)
        # Watched quiet 0, 1 and 2 x STALE: not yet (a task with changes needs 3 x).
        for before in self._passes(t0 + 2 * STALE, t0 + 4 * STALE):
            self.assertNotIn("auto_requeued", self._actions(before), before)
        self.assertTrue(wt.is_dir(), "untouched before 3 x the stale window")
        self.assertEqual(self.meta(self.TID)["status"], "taken")
        self.assertFalse((self.wk_home / "backups" / "worktrees").exists())

        after = recover_hanging_tasks(self.wk_home, now_ms=t0 + 5 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertEqual(self._actions(after), ["auto_requeued"], after)
        self.assertFalse(wt.exists())
        backups = list((self.wk_home / "backups" / "worktrees").glob(self.TID + "-*"))
        self.assertEqual(len(backups), 1)
        b = backups[0]
        self.assertIn("changed", (b / "changes.patch").read_text(encoding="utf-8"))
        self.assertIn("made after base", (b / "commits.patch").read_text(encoding="utf-8"))
        self.assertTrue((b / "untracked.tar").exists())
        info = json.loads((b / "backup.json").read_text(encoding="utf-8"))
        self.assertTrue(info["commits_after_base"])
        m = self.meta(self.TID)
        self.assertEqual(m["status"], "queued")
        self.assertEqual(m["removal_backup"], str(b))

    def test_backup_failure_removes_nothing(self) -> None:
        wt, t0 = self._task(dirty=True)
        (self.wk_home / "backups").write_text("not a folder\n", encoding="utf-8")
        res = self._passes(t0 + 2 * STALE, t0 + 5 * STALE)[-1]
        acts = [r for r in res.get("recovered", []) if r.get("id") == self.TID]
        self.assertEqual(acts[0]["action"], "auto_recovery_refused", res)
        self.assertIn("Backup failed", acts[0]["message"])
        self.assertTrue(wt.is_dir())
        self.assertIn("changed", (wt / "app.py").read_text(encoding="utf-8"))
        self.assertEqual(self.meta(self.TID)["status"], "taken")
        self.assertIsNone(load_pending_removals(self.wk_home)["items"][self.TID].get("removed_at"))

    def _failing_verify(self):
        from unittest import mock

        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise RuntimeError("verify failed")

        return mock.patch("core.watchdog._verify_worktree_backup", side_effect=boom), calls

    def test_backup_failure_removes_partial_folder_and_waits_an_hour(self) -> None:
        wt, t0 = self._task(dirty=True)
        patcher, calls = self._failing_verify()
        bdir = self.wk_home / "backups" / "worktrees"
        with patcher:
            res = self._passes(t0 + 2 * STALE, t0 + 5 * STALE)
            self.assertEqual(len(calls), 1)
            first = [r for r in res[-1].get("recovered", []) if r.get("id") == self.TID][0]
            self.assertEqual(first["action"], "auto_recovery_refused", res[-1])
            self.assertIn("Backup failed", first["message"])
            self.assertIn("Next try after", first["message"])
            self.assertEqual(list(bdir.iterdir()) if bdir.is_dir() else [], [], "the partial backup folder is gone")
            m = self.meta(self.TID)
            self.assertEqual(m["removal_backup_failures"], 1)
            self.assertEqual(m["removal_backup_failed_error"], "RuntimeError")
            self.assertEqual(m["removal_backup_failed_at"], t0 + 5 * STALE)
            # The next 59 minutes of passes do not try again; each says when the next try is.
            waits = self._passes(t0 + 6 * STALE, t0 + 64 * STALE)
            self.assertEqual(len(calls), 1)
            for w in waits:
                self.assertEqual(self._actions(w), ["auto_recovery_waiting"], w)
            self.assertIn("next try after", [r for r in waits[0]["recovered"] if r.get("id") == self.TID][0]["message"])
            # Sixty minutes after the failure: one more try.
            again = self._passes(t0 + 65 * STALE, t0 + 65 * STALE)[-1]
            self.assertEqual(len(calls), 2)
            self.assertEqual(self._actions(again), ["auto_recovery_refused"], again)
            self.assertEqual(self.meta(self.TID)["removal_backup_failures"], 2)
        self.assertTrue(wt.is_dir())
        self.assertEqual(list(bdir.iterdir()), [])
        self.assertEqual(self.meta(self.TID)["status"], "taken")

    def test_third_backup_failure_stops_and_tells_the_owner_once(self) -> None:
        wt, t0 = self._task()
        mpath = self.wk_home / "tasks" / self.TID / "meta.json"
        m = self.meta(self.TID)
        m.update({"removal_backup_failures": 2, "removal_backup_failed_at": t0 - 2 * 3600_000, "removal_backup_failed_error": "OSError"})
        mpath.write_text(json.dumps(m), encoding="utf-8")
        patcher, calls = self._failing_verify()
        with patcher:
            res = self._passes(t0 + STALE, t0 + 3 * STALE)
            self.assertEqual(len(calls), 1)
            refused = [r for r in res[-1].get("recovered", []) if r.get("id") == self.TID]
            self.assertEqual(refused[0]["action"], "auto_recovery_refused", res[-1])
            self.assertIn("stopped trying", refused[0]["message"])
            m = self.meta(self.TID)
            self.assertEqual(m["removal_backup_failures"], 3)
            sid = m.get("stalled_suggestion_id")
            self.assertTrue(sid, "one owner notice")
            sug = (self.wk_home / "suggestions.jsonl").read_text(encoding="utf-8") if (self.wk_home / "suggestions.jsonl").is_file() else ""
            self.assertIn("stopped trying", sug)
            # Later passes, even hours later: no new try, no second notice.
            later = self._passes(t0 + 4 * STALE, t0 + 8 * STALE) + self._passes(t0 + 200 * STALE, t0 + 205 * STALE)
            self.assertEqual(len(calls), 1)
            for r in later:
                self.assertNotIn("auto_requeued", self._actions(r), r)
                self.assertNotIn("auto_recovery_refused", self._actions(r), r)
            self.assertEqual(self.meta(self.TID)["stalled_suggestion_id"], sid)
            notices = [ln for ln in (self.wk_home / "suggestions.jsonl").read_text(encoding="utf-8").splitlines()
                       if self.TID in ln and '"title"' in ln]
            self.assertEqual(len(notices), 1, notices)
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")

    def test_cap_of_three_returns_to_the_owner(self) -> None:
        wt, t0 = self._task(requeue_count=3)
        res = recover_hanging_tasks(self.wk_home, now_ms=t0 + 10 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertNotIn("auto_requeued", self._actions(res), res)
        self.assertIn("recorded_pending_removal", self._actions(res))
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")
        self.assertIsNone(load_pending_removals(self.wk_home)["items"][self.TID]["decision"])
        notified = load_pending_removals(self.wk_home)["items"][self.TID]["notified_at"]
        sid = self.meta(self.TID)["stalled_suggestion_id"]
        # A second pass: still the owner's call, still one notice, notified_at unchanged.
        res2 = recover_hanging_tasks(self.wk_home, now_ms=t0 + 11 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertNotIn("auto_requeued", self._actions(res2), res2)
        self.assertNotIn("recorded_pending_removal", self._actions(res2), res2)
        self.assertTrue(wt.is_dir())
        self.assertEqual(load_pending_removals(self.wk_home)["items"][self.TID]["notified_at"], notified)
        self.assertEqual(self.meta(self.TID)["stalled_suggestion_id"], sid)

    def test_requeue_count_reaches_three_over_three_rounds(self) -> None:
        for n in (1, 2, 3):
            wt, t0 = self._task(requeue_count=n - 1) if n == 1 else (None, None)
            if n > 1:
                # Take it again, the way wk-task take would, keeping the count.
                m = self.meta(self.TID)
                (self.wk_home / "tasks" / self.TID / "meta.json").unlink()
                (self.wk_home / "tasks" / self.TID / "claim").unlink(missing_ok=True)
                load = load_pending_removals(self.wk_home)
                self.assertTrue(load["items"][self.TID]["removed_at"])
                wt, t0 = self._task(requeue_count=int(m["requeue_count"]))
            res = self._passes(t0 + 2 * STALE, t0 + 4 * STALE)[-1]
            self.assertEqual(self._actions(res), ["auto_requeued"], (n, res))
            self.assertEqual(self.meta(self.TID)["requeue_count"], n)

    def test_kill_switch_means_no_recovery(self) -> None:
        wt, t0 = self._task()
        (self.wk_home / "KILL").write_text("stop\n", encoding="utf-8")
        res = recover_hanging_tasks(self.wk_home, now_ms=t0 + 10 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertTrue(res.get("killed"), res)
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")


class ReviewFixTests(_TempHome):
    """P2-276 review: watched quiet time, kills during removal, concurrency, owner holds, surfaces."""

    TID = AutoRequeueTests.TID
    _age_worktree = AutoRequeueTests._age_worktree
    _task = AutoRequeueTests._task
    _passes = AutoRequeueTests._passes
    _actions = AutoRequeueTests._actions

    def test_sleep_gap_resets_the_quiet_count(self) -> None:
        wt, t0 = self._task()
        for r in self._passes(t0 + 2 * STALE, t0 + 3 * STALE):
            self.assertNotIn("auto_requeued", self._actions(r), r)
        # The Mac slept for 5 minutes (gap > 120 s): the count starts again.
        wake = t0 + 3 * STALE + 300_000
        for r in self._passes(wake, wake + STALE):
            self.assertNotIn("auto_requeued", self._actions(r), r)
        self.assertTrue(wt.is_dir())
        last = self._passes(wake + 2 * STALE, wake + 2 * STALE)[0]
        self.assertEqual(self._actions(last), ["auto_requeued"], last)

    def test_concurrent_passes_requeue_once_with_one_backup(self) -> None:
        import threading

        wt, t0 = self._task(dirty=True)
        self._passes(t0 + 2 * STALE, t0 + 4 * STALE)
        results: list[dict] = []
        errors: list[BaseException] = []

        def run() -> None:
            try:
                results.append(recover_hanging_tasks(self.wk_home, now_ms=t0 + 5 * STALE, task_stale_ms=STALE, record_learning=False))
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        th = [threading.Thread(target=run) for _ in range(2)]
        for t in th:
            t.start()
        for t in th:
            t.join(60)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        acts = [a for r in results for a in self._actions(r)]
        self.assertEqual(acts.count("auto_requeued"), 1, results)
        self.assertEqual(len(list((self.wk_home / "backups" / "worktrees").glob(self.TID + "-*"))), 1)
        self.assertFalse(wt.exists())
        self.assertEqual(self.meta(self.TID)["requeue_count"], 1)

    def test_kill_during_removal_is_resumed_without_a_new_backup(self) -> None:
        from unittest import mock

        import core.watchdog as wd

        wt, t0 = self._task(dirty=True)
        self._passes(t0 + 2 * STALE, t0 + 4 * STALE)
        real = wd.run_in_group

        def killed(args, *a, **kw):
            if "worktree" in args and "remove" in args:
                raise KeyboardInterrupt("killed mid-removal")
            return real(args, *a, **kw)

        with mock.patch.object(wd, "run_in_group", side_effect=killed):
            with self.assertRaises(KeyboardInterrupt):
                recover_hanging_tasks(self.wk_home, now_ms=t0 + 5 * STALE, task_stale_ms=STALE, record_learning=False)
        m = self.meta(self.TID)
        self.assertTrue(m.get("removing"), m)
        backups = list((self.wk_home / "backups" / "worktrees").glob(self.TID + "-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(m["removal_backup_pending"], str(backups[0]))
        pend = load_pending_removals(self.wk_home)["items"][self.TID]
        self.assertTrue(pend.get("removing"))
        self.assertEqual(pend.get("backup"), str(backups[0]))
        self.assertTrue(wt.is_dir(), "the kill came before anything was removed")

        res = recover_hanging_tasks(self.wk_home, now_ms=t0 + 6 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertEqual(self._actions(res), ["removal_resumed"], res)
        self.assertFalse(wt.exists())
        self.assertEqual(len(list((self.wk_home / "backups" / "worktrees").glob(self.TID + "-*"))), 1, "no new backup")
        m = self.meta(self.TID)
        self.assertEqual(m["status"], "queued")
        self.assertNotIn("removing", m)
        self.assertEqual(m["removal_backups"], [str(backups[0])])
        self.assertEqual(m["attempt"], 2)
        self.assertFalse(load_pending_removals(self.wk_home)["items"][self.TID].get("removing"))

    def test_folder_without_git_is_never_removed(self) -> None:
        wt, t0 = self._task()
        git_marker = wt / ".git"
        if git_marker.is_dir():
            import shutil as _sh
            _sh.rmtree(git_marker)
        else:
            git_marker.unlink()
        runs = self._passes(t0 + 2 * STALE, t0 + 5 * STALE)
        for r in runs:
            self.assertNotIn("auto_requeued", self._actions(r), r)
        msgs = [x.get("message", "") for r in runs for x in r.get("recovered", []) if x.get("action") == "auto_recovery_refused"]
        self.assertTrue(msgs and all("not a git worktree" in m for m in msgs), runs)
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")
        self.assertFalse((self.wk_home / "backups" / "worktrees").exists())

    def test_no_worktree_path_waits_and_keeps_the_cap(self) -> None:
        wt, t0 = self._task(requeue_count=3)
        _git(self.repo, "worktree", "remove", "--force", str(wt))
        for r in self._passes(t0 + 2 * STALE, t0 + 6 * STALE):
            self.assertNotIn("requeued_clean_task", self._actions(r), r)
            self.assertNotIn("auto_requeued", self._actions(r), r)
        self.assertEqual(self.meta(self.TID)["status"], "taken")

    def test_no_worktree_path_needs_watched_quiet_time(self) -> None:
        wt, t0 = self._task()
        _git(self.repo, "worktree", "remove", "--force", str(wt))
        runs = self._passes(t0 + 2 * STALE, t0 + 4 * STALE)
        for r in runs[:-1]:
            self.assertNotIn("requeued_clean_task", self._actions(r), r)
        self.assertEqual(self._actions(runs[-1]), ["requeued_clean_task"], runs[-1])
        m = self.meta(self.TID)
        self.assertEqual((m["status"], m["requeue_count"], m["attempt"]), ("queued", 1, 2))

    def test_expired_later_still_waits_for_the_owner(self) -> None:
        from core.watchdog import LATER_HIDE_MS, decide_pending_removal

        wt, t0 = self._task()
        recover_hanging_tasks(self.wk_home, now_ms=t0 + 2 * STALE, task_stale_ms=STALE, record_learning=False)
        self.assertIn(self.TID, load_pending_removals(self.wk_home)["items"])
        res = decide_pending_removal(self.TID, "later", wk_home=self.wk_home, now_ms=t0 + 2 * STALE, stale_ms=STALE)
        self.assertTrue(res.get("ok"), res)
        start = t0 + 2 * STALE + LATER_HIDE_MS + STALE
        for r in self._passes(start, start + 6 * STALE):
            self.assertNotIn("auto_requeued", self._actions(r), r)
        entry = load_pending_removals(self.wk_home)["items"][self.TID]
        self.assertIsNone(entry["decision"])
        self.assertTrue(entry.get("owner_decided"))
        self.assertTrue(wt.is_dir())
        self.assertEqual(self.meta(self.TID)["status"], "taken")

    def test_task_surface_leaves_jobs_alone(self) -> None:
        wt, t0 = self._task()
        jid = "J-20261124-0100-aaaa"
        jd = self.wk_home / "jobs" / jid
        jd.mkdir(parents=True)
        ev = jd / "events.jsonl"
        ev.write_text(json.dumps({"n": 1, "at": t0, "type": "init"}) + "\n", encoding="utf-8")
        os.utime(ev, (t0 / 1000, t0 / 1000))
        (jd / "meta.json").write_text(json.dumps({
            "id": jid, "project": "p1", "state": "running", "runner_pid": _dead_pid(), "events": 1,
            "queued_at": t0, "started_at": t0,
        }), encoding="utf-8")
        for r in [recover_hanging_tasks(self.wk_home, now_ms=t, task_stale_ms=STALE, job_stall_ms=1000,
                                        record_learning=False, surface="task")
                  for t in range(t0 + 2 * STALE, t0 + 4 * STALE + 1, STALE)]:
            self.assertEqual({x["surface"] for x in r.get("recovered", [])} - {"task"}, set(), r)
        self.assertEqual(json.loads((jd / "meta.json").read_text(encoding="utf-8"))["state"], "running")
        self.assertFalse(wt.exists(), "the task itself was still recovered")
        # Without the surface limit the same job is recovered (the test would catch a no-op).
        r_all = recover_hanging_tasks(self.wk_home, now_ms=t0 + 5 * STALE, task_stale_ms=STALE, job_stall_ms=1000, record_learning=False)
        self.assertIn("job", {x["surface"] for x in r_all.get("recovered", [])}, r_all)


if __name__ == "__main__":
    unittest.main()
