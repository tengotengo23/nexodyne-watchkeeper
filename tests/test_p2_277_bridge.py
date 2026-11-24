"""P2-277 Bridge: the Claude Stop hook chains to a waiting handoff (claimed first, capped at 3 an hour per session),
Antigravity's Stop stays {}, the owner's hold stops automatic requeues, and the Re-Prompt note names queued tasks.
Everything runs in a temporary WK_HOME; nothing starts claude, agy or Antigravity.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
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

from core import hook_bus  # noqa: E402
from core.watchdog import recover_hanging_tasks  # noqa: E402
from test_p2_272_lifecycle import _TempHome, _dead_pid  # noqa: E402

STALE = 60_000


def _load_reprompt_hook():
    path = ROOT / "reprompt" / "scripts" / "reprompt_inline_hook.py"
    spec = importlib.util.spec_from_file_location("p2_277_reprompt_inline_hook", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _iso(offset_s: float = 0.0) -> str:
    return dt.datetime.fromtimestamp(time.time() + offset_s, dt.timezone.utc).isoformat().replace("+00:00", "Z")


class BridgeHookTests(_TempHome):
    def _handoffs(self, n: int) -> None:
        wss = {}
        for i in range(n):
            wss[f"/repo/{i}"] = {"workspace": f"/repo/{i}", "to_engine": "claude", "title": f"Handoff {i}", "updated_at": _iso(-60 * (i + 1))}
        (self.wk_home / "shared-workspace.json").write_text(json.dumps({"workspaces": wss}), encoding="utf-8")

    def test_two_sessions_one_handoff_only_one_takes_it(self) -> None:
        self._handoffs(1)
        r1 = hook_bus._bridge_stop_reason("s1")
        self.assertEqual(r1, 'Bridge: a handoff from Gemini waits: Handoff 0. Run /wk-take-task --handoff --cwd "/repo/0" to take it.')
        self.assertEqual(hook_bus._bridge_stop_reason("s2"), "")
        claims = list((self.wk_home / "bridge" / "claims").iterdir())
        self.assertEqual(len(claims), 1)
        self.assertEqual(json.loads(claims[0].read_text(encoding="utf-8"))["by"], "stop:s1")
        self.assertEqual(claims[0].stat().st_mode & 0o777, 0o600)

    def test_chain_cap_three_an_hour_per_session(self) -> None:
        self._handoffs(5)
        got = [hook_bus._bridge_stop_reason("s1") for _ in range(5)]
        self.assertEqual(sum(1 for g in got if g), 3, got)
        self.assertEqual(got[3:], ["", ""])
        # Another session has its own count and takes one of the two left.
        self.assertTrue(hook_bus._bridge_stop_reason("s2"))

    def test_stale_claim_can_be_taken_again(self) -> None:
        self._handoffs(1)
        self.assertTrue(hook_bus._bridge_stop_reason("s1"))
        claim = next((self.wk_home / "bridge" / "claims").iterdir())
        old = time.time() - 16 * 60
        os.utime(claim, (old, old))
        self.assertTrue(hook_bus._bridge_stop_reason("s2"))

    def test_kill_switch_and_off_give_nothing(self) -> None:
        self._handoffs(1)
        (self.wk_home / "KILL").write_text("", encoding="utf-8")
        self.assertEqual(hook_bus._bridge_stop_reason("s1"), "")
        self.assertEqual(hook_bus._bridge_context_line(), "")
        (self.wk_home / "KILL").unlink()
        (self.wk_home / "bridge").mkdir(parents=True, exist_ok=True)
        (self.wk_home / "bridge" / "off").write_text("", encoding="utf-8")
        self.assertEqual(hook_bus._bridge_stop_reason("s1"), "")
        self.assertEqual(hook_bus._bridge_context_line(), "")
        self.assertFalse((self.wk_home / "bridge" / "claims").exists())

    def test_context_line_until_claimed_and_consumed_ignored(self) -> None:
        self.assertEqual(hook_bus._bridge_context_line(), "")
        self._handoffs(1)
        line = hook_bus._bridge_context_line()
        self.assertTrue(line.startswith("Bridge: a handoff from Gemini waits: Handoff 0, 1 min ago."), line)
        hook_bus._bridge_stop_reason("s1")
        self.assertEqual(hook_bus._bridge_context_line(), "")
        data = {"workspaces": {"/r": {"workspace": "/r", "to_engine": "claude", "title": "x", "updated_at": _iso(), "consumed_by": "claude"},
                               "/g": {"workspace": "/g", "to_engine": "gemini", "title": "y", "updated_at": _iso()}}}
        (self.wk_home / "shared-workspace.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(hook_bus._bridge_context_line(), "")

    def test_title_control_characters_are_flattened(self) -> None:
        data = {"workspaces": {"/r": {"workspace": "/r", "to_engine": "claude", "title": "a\nb c\x07d", "updated_at": _iso()}}}
        (self.wk_home / "shared-workspace.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(hook_bus._bridge_stop_reason("s1"), 'Bridge: a handoff from Gemini waits: a b c d. Run /wk-take-task --handoff --cwd "/r" to take it.')

    def test_stop_event_claude_blocks_antigravity_prints_empty_object(self) -> None:
        self._handoffs(2)
        ag = json.dumps({"conversationId": "conv-1", "workspace": str(self.repo)})
        code, out, _ = hook_bus.handle_event("Stop", ag, bypass_subprocesses=True)
        self.assertEqual((code, out), (0, "{}\n"))
        self.assertNotIn("continue", out)
        self.assertFalse((self.wk_home / "bridge" / "claims").exists(), "Antigravity's Stop must not claim")
        cc = json.dumps({"session_id": "s1", "hook_event_name": "Stop", "cwd": str(self.repo)})
        code, out, _ = hook_bus.handle_event("Stop", cc, bypass_subprocesses=True)
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertEqual(parsed["decision"], "block")
        self.assertIn("Run /wk-take-task --handoff --cwd ", parsed["reason"])
        self.assertNotIn("--claim", parsed["reason"])
        (self.wk_home / "KILL").write_text("", encoding="utf-8")
        code, out, _ = hook_bus.handle_event("Stop", cc, bypass_subprocesses=True)
        self.assertNotIn("block", out)


class BridgeReviewFixTests(_TempHome):
    """The fresh review's fixes: racing claimers, cwd first, claim before chain slot, private crossings tmp file."""

    def _handoffs(self, repos: list[str]) -> None:
        wss = {r: {"workspace": r, "to_engine": "claude", "title": f"H {r}", "updated_at": _iso(-60 * (i + 1))} for i, r in enumerate(repos)}
        (self.wk_home / "shared-workspace.json").write_text(json.dumps({"workspaces": wss}), encoding="utf-8")

    def test_racing_claimers_on_a_stale_claim_exactly_one_wins(self) -> None:
        import subprocess
        d = self.wk_home / "bridge" / "claims"
        d.mkdir(parents=True, exist_ok=True)
        f = d / hook_bus._bridge_hash("ws@race")
        code = ("import sys,time; sys.path.insert(0, sys.argv[1]); from core import hook_bus\n"
                "t=float(sys.argv[2])\nwhile time.time()<t: pass\n"
                "print('won' if hook_bus._bridge_claim('ws@race', sys.argv[3]) else 'lost')")
        for rnd in range(8):
            f.write_text(json.dumps({"id": "ws@race", "by": "old"}) + "\n", encoding="utf-8")
            old = time.time() - 16 * 60
            os.utime(f, (old, old))
            start = time.time() + 0.6
            ps = [subprocess.Popen([sys.executable, "-c", code, str(ROOT), str(start), f"p{i}"], stdout=subprocess.PIPE, text=True,
                                   env=dict(os.environ)) for i in range(4)]
            got = [p.communicate(timeout=60)[0].strip() for p in ps]
            self.assertEqual(got.count("won"), 1, f"round {rnd}: {got}")
            self.assertNotEqual(json.loads(f.read_text(encoding="utf-8"))["by"], "old")
            self.assertEqual([n.name for n in d.iterdir() if n.name.endswith(".steal")], [])

    def test_handoff_for_the_sessions_own_folder_comes_first(self) -> None:
        self._handoffs(["/repo/a", "/repo/b", "/repo/c"])
        r = hook_bus._bridge_stop_reason("s1", "/repo/b")
        self.assertEqual(r, 'Bridge: a handoff from Gemini waits: H /repo/b. Run /wk-take-task --handoff --cwd "/repo/b" to take it.')
        self.assertIn("H /repo/a", hook_bus._bridge_stop_reason("s2", "/elsewhere"))

    def test_unsafe_repo_gets_no_cwd(self) -> None:
        self._handoffs(['/repo/x"; rm -rf ~'])
        self.assertTrue(hook_bus._bridge_stop_reason("s1").endswith("Run /wk-take-task --handoff to take it."))

    def test_a_lost_claim_spends_no_chain_slot_and_the_cap_gives_the_claim_back(self) -> None:
        self._handoffs(["/repo/a"])
        # A handoff already claimed by someone else gives nothing and spends no slot.
        for it in hook_bus._bridge_waiting_for_claude():
            hook_bus._bridge_claim(it["id"], "other")
        self.assertEqual(hook_bus._bridge_stop_reason("s1"), "")
        self.assertFalse((self.wk_home / "bridge" / "chains").exists() and any((self.wk_home / "bridge" / "chains").glob("*.json")),
                         "a lost claim must not take a chain slot")
        # At the cap: the claim is released, so another session can still take the handoff.
        for c in (self.wk_home / "bridge" / "claims").iterdir():
            c.unlink()
        for _ in range(3):
            self.assertTrue(hook_bus._bridge_chain_take("s1"))
        self.assertEqual(hook_bus._bridge_stop_reason("s1"), "")
        self.assertEqual(list((self.wk_home / "bridge" / "claims").iterdir()), [], "the claim is given back at the cap")
        self.assertTrue(hook_bus._bridge_stop_reason("s2"))

    def test_crossings_trim_tmp_file_is_private(self) -> None:
        from core import watchdog
        bdir = self.wk_home / "bridge"
        bdir.mkdir(parents=True, exist_ok=True)
        (bdir / "crossings.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(2100)), encoding="utf-8")
        seen: list[int] = []
        real_replace = os.replace

        def spy(a, b, *args, **kw):
            seen.append(os.stat(a).st_mode & 0o777)
            return real_replace(a, b, *args, **kw)
        prev = os.umask(0o022)
        try:
            watchdog.os.replace = spy
            watchdog._bridge_crossing(self.wk_home, "t1", "claude", "gemini", "queued", "x", int(time.time() * 1000))
        finally:
            watchdog.os.replace = real_replace
            os.umask(prev)
        self.assertEqual(seen, [0o600])
        self.assertEqual(len((bdir / "crossings.jsonl").read_text(encoding="utf-8").splitlines()), 2000)


class BridgeHoldTests(_TempHome):
    TID = "20261124-200000-p2-277-hold"

    def _task(self) -> int:
        wt = self.make_taken_task(self.TID, _dead_pid())
        t0 = time.time() - 3600
        for root, dirs, files in os.walk(wt):
            dirs[:] = [d for d in dirs if d != ".git"]
            for f in files:
                p = Path(root) / f
                if not p.is_symlink():
                    os.utime(p, (t0, t0))
        return int(t0 * 1000)

    def _actions(self, res: dict) -> list[str]:
        return [r["action"] for r in res.get("recovered", []) if r.get("id") == self.TID]

    def _run(self, t0: int) -> list[list[str]]:
        out, t = [], t0 + 2 * STALE
        while t <= t0 + 4 * STALE:
            out.append(self._actions(recover_hanging_tasks(self.wk_home, now_ms=t, task_stale_ms=STALE, record_learning=False)))
            t += STALE
        return out

    def test_held_task_is_not_requeued(self) -> None:
        t0 = self._task()
        (self.wk_home / "tasks" / self.TID / "hold").write_text(json.dumps({"at": _iso(), "until": None, "note": "mine"}), encoding="utf-8")
        runs = self._run(t0)
        self.assertTrue(all(r == ["held"] for r in runs), runs)
        self.assertEqual(self.meta(self.TID)["status"], "taken")
        self.assertTrue((self.wk_home / "worktrees" / self.TID).is_dir())

    def test_expired_hold_counts_as_released(self) -> None:
        t0 = self._task()
        (self.wk_home / "tasks" / self.TID / "hold").write_text(json.dumps({"at": _iso(-7200), "until": _iso(-7000), "note": ""}), encoding="utf-8")
        runs = self._run(t0)
        self.assertNotIn("held", sum(runs, []))
        self.assertEqual(runs[-1], ["auto_requeued"], runs)
        self.assertEqual(self.meta(self.TID)["status"], "queued")


class BridgeTaskNoteTests(_TempHome):
    TID = "20261124-200100-p2-277-note"

    def setUp(self) -> None:
        super().setUp()
        self.mod = _load_reprompt_hook()
        tdir = self.wk_home / "tasks" / self.TID
        tdir.mkdir(parents=True)
        (tdir / "meta.json").write_text(json.dumps({"id": self.TID, "status": "queued", "title": "Fix\nthe footer"}), encoding="utf-8")

    def test_normal_queued_task(self) -> None:
        self.assertEqual(self.mod.bridge_task_note(), f"Bridge: task {self.TID} waits: Fix the footer. Say /wk-take-task to take it.")

    def test_held_task_kill_and_off_give_nothing(self) -> None:
        hold = self.wk_home / "tasks" / self.TID / "hold"
        hold.write_text(json.dumps({"at": _iso(), "until": _iso(3600), "note": ""}), encoding="utf-8")
        self.assertEqual(self.mod.bridge_task_note(), "")
        hold.write_text(json.dumps({"at": _iso(-7200), "until": _iso(-60), "note": ""}), encoding="utf-8")
        self.assertTrue(self.mod.bridge_task_note())
        hold.unlink()
        (self.wk_home / "KILL").write_text("", encoding="utf-8")
        self.assertEqual(self.mod.bridge_task_note(), "")
        (self.wk_home / "KILL").unlink()
        (self.wk_home / "bridge").mkdir(parents=True, exist_ok=True)
        (self.wk_home / "bridge" / "off").write_text("", encoding="utf-8")
        self.assertEqual(self.mod.bridge_task_note(), "")

    def test_taken_task_gives_nothing(self) -> None:
        (self.wk_home / "tasks" / self.TID / "meta.json").write_text(json.dumps({"id": self.TID, "status": "taken", "title": "x"}), encoding="utf-8")
        self.assertEqual(self.mod.bridge_task_note(), "")


if __name__ == "__main__":
    unittest.main()
