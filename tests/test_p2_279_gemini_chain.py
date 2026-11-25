"""P2-279 Gemini Desk: the Antigravity Stop hook offers the next queued task with the owner's Desk rules,
only when the owner switched the chain on, the turn ended cleanly, a task waits and the caps allow it.
Every other case, and any error, gives Antigravity {}. Everything runs in a temporary WK_HOME;
nothing starts claude, agy or Antigravity.
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import hook_bus  # noqa: E402
from test_p2_272_lifecycle import _TempHome  # noqa: E402

RULES = json.loads((ROOT / "config" / "gemini.json").read_text(encoding="utf-8"))["desk_rules"]


def _payload(**over):
    p = {"conversationId": "conv-1", "terminationReason": "model_stop", "fullyIdle": True, "continuationActive": False}
    p.update(over)
    return p


class _ChainBase(_TempHome):
    def setUp(self) -> None:
        super().setUp()
        self.bridge = self.wk_home / "bridge"
        self.bridge.mkdir(parents=True, exist_ok=True)
        (self.bridge / "gemini-chain-on").write_text("on\n", encoding="utf-8")

    def task(self, tid: str, **meta) -> Path:
        d = self.wk_home / "tasks" / tid
        d.mkdir(parents=True, exist_ok=True)
        m = {"id": tid, "status": "queued", "title": f"Title {tid}"}
        m.update(meta)
        (d / "meta.json").write_text(json.dumps(m), encoding="utf-8")
        return d

    def crossings(self) -> list[dict]:
        f = self.bridge / "crossings.jsonl"
        return [json.loads(x) for x in f.read_text(encoding="utf-8").splitlines() if x.strip()] if f.exists() else []

    def ag_stop(self, payload: dict) -> tuple[int, str]:
        p = dict(payload)
        p.setdefault("workspace", str(self.repo))
        code, out, _ = hook_bus.handle_event("Stop", json.dumps(p), bypass_subprocesses=True)
        return code, out


class GeminiChainTests(_ChainBase):
    def test_desk_rules_stored_word_for_word(self) -> None:
        self.assertTrue(RULES.startswith("Gemini Desk rules (the owner's standing instruction). A proposal from Claude waits"))
        self.assertTrue(RULES.endswith("One task per turn. Never run agy. Stop when nothing waits."))

    def test_offers_first_queued_task_with_rules(self) -> None:
        self.task("20261125-090000-first-job", title="First job")
        self.task("20261125-090100-second-job")
        t0 = time.perf_counter()
        reason = hook_bus._bridge_stop_reason_ag(_payload())
        self.assertLess(time.perf_counter() - t0, 1.0)
        self.assertEqual(reason, f"{RULES} 2 proposals wait. First: First job (20261125-090000-first-job). Begin with /wk-take-task 20261125-090000-first-job.")
        c = self.crossings()
        self.assertEqual(len(c), 1)
        self.assertEqual({k: c[0][k] for k in ("route", "event", "to", "task_id", "conversation_id")},
                         {"route": "G3", "event": "offered", "to": "gemini", "task_id": "20261125-090000-first-job", "conversation_id": "conv-1"})
        meta = json.loads((self.wk_home / "tasks" / "20261125-090000-first-job" / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["status"], "queued", "the hook offers; it never takes")

    def test_one_task_singular_wording(self) -> None:
        self.task("20261125-090000-only")
        self.assertTrue(hook_bus._bridge_stop_reason_ag(_payload()).endswith("1 proposal waits. First: Title 20261125-090000-only (20261125-090000-only). Begin with /wk-take-task 20261125-090000-only."))

    def test_handle_event_answers_continue(self) -> None:
        self.task("20261125-090000-only")
        code, out = self.ag_stop(_payload())
        self.assertEqual(code, 0)
        got = json.loads(out)
        self.assertEqual(got["decision"], "continue")
        self.assertTrue(got["reason"].startswith(RULES))

    def assertEmpty(self, payload: dict | None = None) -> None:
        self.assertEqual(hook_bus._bridge_stop_reason_ag(payload or _payload()), "")
        self.assertEqual(self.ag_stop(payload or _payload()), (0, "{}\n"))

    def test_off_by_default(self) -> None:
        self.task("20261125-090000-only")
        (self.bridge / "gemini-chain-on").unlink()
        self.assertEmpty()

    def test_bridge_off_wins(self) -> None:
        self.task("20261125-090000-only")
        (self.bridge / "off").write_text("", encoding="utf-8")
        self.assertEmpty()

    def test_kill_switch(self) -> None:
        self.task("20261125-090000-only")
        (self.wk_home / "KILL").write_text("", encoding="utf-8")
        self.assertEmpty()

    def test_turn_conditions(self) -> None:
        self.task("20261125-090000-only")
        for over in ({"terminationReason": "error"}, {"terminationReason": "max_steps_exceeded"}, {"terminationReason": None},
                     {"fullyIdle": False}, {"fullyIdle": None}, {"continuationActive": True}):
            with self.subTest(over=over):
                self.assertEmpty(_payload(**over))
        self.assertEqual(self.crossings(), [])

    def test_nothing_queued_or_only_held(self) -> None:
        self.assertEmpty()
        self.task("20261125-090000-done", status="done")
        self.assertEmpty()
        d = self.task("20261125-090100-held")
        (d / "hold").write_text(json.dumps({"by": "owner"}), encoding="utf-8")
        self.assertEmpty()
        past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)).isoformat()
        (d / "hold").write_text(json.dumps({"by": "owner", "until": past}), encoding="utf-8")
        self.assertIn("(20261125-090100-held)", hook_bus._bridge_stop_reason_ag(_payload()))

    def test_day_cap(self) -> None:
        now = dt.datetime.now().astimezone().isoformat()
        for i in range(12):
            self.task(f"20261125-08{i:02d}00-taken", status="done", taken_at=now)
        self.task("20261125-090000-next")
        self.assertEmpty()

    def test_chain_cap_three_an_hour_per_conversation(self) -> None:
        self.task("20261125-090000-only")
        got = [hook_bus._bridge_stop_reason_ag(_payload()) for _ in range(4)]
        self.assertEqual([bool(g) for g in got], [True, True, True, False])
        self.assertTrue(hook_bus._bridge_stop_reason_ag(_payload(conversationId="conv-2")))
        self.assertEqual(len(self.crossings()), 4)

    def test_empty_rules_and_errors_fail_closed(self) -> None:
        self.task("20261125-090000-only")
        with mock.patch.object(hook_bus, "_gemini_config", return_value={"desk_rules": ""}):
            self.assertEmpty()
        with mock.patch.object(hook_bus, "_gemini_tasks", side_effect=RuntimeError("boom")):
            self.assertEmpty()
        (self.wk_home / "tasks" / "20261125-090000-only" / "meta.json").write_text("{not json", encoding="utf-8")
        self.assertEmpty()


class GeminiChainFixRoundTests(_ChainBase):
    """Review fix round: the dedicated Stop entry (M1), corrupt chains file (S1), held lock (S2)."""

    HOOKS = ROOT / "antigravity" / "plugins" / "watchkeeper" / "hooks.json"

    def _entry(self) -> dict:
        hooks = json.loads(self.HOOKS.read_text(encoding="utf-8"))
        block = hooks["watchkeeper-gemini-chain"]
        self.assertTrue(block.get("enabled"))
        stop = block["Stop"]
        self.assertIsInstance(stop, list)
        self.assertEqual(len(stop), 1)
        return stop[0]

    def _run_entry(self, payload: dict) -> tuple[subprocess.CompletedProcess, float]:
        e = self._entry()
        cmd = e["command"].replace("{{PYTHON}}", sys.executable).replace("{{WK_BIN_DIR}}", str(ROOT / "bin"))
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.base), "WK_HOME": str(self.wk_home)}
        t0 = time.perf_counter()
        r = subprocess.run(cmd, shell=True, input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=30)
        return r, time.perf_counter() - t0

    def test_hooks_json_structure_matches_the_documented_form(self) -> None:
        hooks = json.loads(self.HOOKS.read_text(encoding="utf-8"))
        e = self._entry()
        self.assertEqual(e["type"], "command")
        self.assertLessEqual(e["timeout"], 3)
        self.assertEqual(e["command"], '"{{PYTHON}}" "{{WK_BIN_DIR}}/wk-gemini-chain-hook.py"')
        self.assertNotIn("hooks", e, "handlers sit directly under Stop, with no matcher wrapper")
        self.assertNotIn("node", e["command"])
        self.assertTrue((ROOT / "bin" / "wk-gemini-chain-hook.py").is_file())
        self.assertNotIn("wk-gemini-chain-hook", json.dumps(hooks["watchkeeper"]), "the evidence entry stays as it was")

    def test_stop_entry_run_as_antigravity_runs_it_offers_the_task(self) -> None:
        self.task("20261125-090000-first-job", title="First job")
        r, took = self._run_entry(_payload(workspace=str(self.repo)))
        self.assertEqual(r.returncode, 0, r.stderr)
        got = json.loads(r.stdout)
        self.assertEqual(got["decision"], "continue")
        self.assertIn(RULES, got["reason"])
        self.assertTrue(got["reason"].endswith("Begin with /wk-take-task 20261125-090000-first-job."), got["reason"])
        self.assertLess(took, 3.0)

    def test_stop_entry_gives_empty_object_when_chain_off_or_input_bad(self) -> None:
        self.task("20261125-090000-first-job")
        (self.bridge / "gemini-chain-on").unlink()
        r, _ = self._run_entry(_payload(workspace=str(self.repo)))
        self.assertEqual((r.returncode, json.loads(r.stdout)), (0, {}))
        (self.bridge / "gemini-chain-on").write_text("on\n", encoding="utf-8")
        e = self._entry()
        cmd = e["command"].replace("{{PYTHON}}", sys.executable).replace("{{WK_BIN_DIR}}", str(ROOT / "bin"))
        r = subprocess.run(cmd, shell=True, input="not json", capture_output=True, text=True,
                           env={"PATH": "/usr/bin:/bin", "HOME": str(self.base), "WK_HOME": str(self.wk_home)}, timeout=30)
        self.assertEqual((r.returncode, json.loads(r.stdout)), (0, {}))

    def test_corrupt_chains_file_fails_closed_and_is_left_alone(self) -> None:
        self.task("20261125-090000-first-job")
        d = self.bridge / "chains"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{hook_bus._bridge_hash('ag:conv-1')}.json"
        for bad in ("{not json", json.dumps({"at": "x"}), json.dumps([1, 2])):
            f.write_text(bad, encoding="utf-8")
            self.assertEqual(hook_bus._bridge_stop_reason_ag(_payload()), "")
            self.assertEqual(f.read_text(encoding="utf-8"), bad, "nothing is written over a corrupt file")
        self.assertEqual(self.crossings(), [])

    def test_held_chain_lock_gives_up_within_a_second(self) -> None:
        self.task("20261125-090000-first-job")
        d = self.bridge / "chains"
        d.mkdir(parents=True, exist_ok=True)
        lock = d / f"{hook_bus._bridge_hash('ag:conv-1')}.json.lock"
        lock.write_text("someone-else\n", encoding="utf-8")
        t0 = time.perf_counter()
        self.assertEqual(hook_bus._bridge_stop_reason_ag(_payload()), "")
        self.assertLess(time.perf_counter() - t0, 1.0)
        self.assertTrue(lock.exists(), "a live lock is not taken over")
        self.assertEqual(self.crossings(), [])


if __name__ == "__main__":
    unittest.main()
