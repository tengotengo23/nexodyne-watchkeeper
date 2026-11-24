#!/usr/bin/env python3
"""Regression tests covering root-cause bugs and workflows from Watchkeeper E2E audit."""

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

from core.clipboard_io import extract_fenced_rewrite  # noqa: E402
from core.fast_path import evaluate_fast_path  # noqa: E402
import core.hook_bus as hook_bus  # noqa: E402
from core.learning_engine import (  # noqa: E402
    detect_and_record_correction,
    promote_session_snippets_on_test_pass,
    track_agent_edit,
)
from core.sanitizer import anonymize_workspace, sanitize_path, sanitize_text  # noqa: E402
from core.snippet_store import SnippetStore  # noqa: E402
from core.state_store import StateStore, atomic_write_json  # noqa: E402
from core.watchdog import (  # noqa: E402
    _parse_ts_ms,
    decide_pending_removal,
    load_pending_removals,
    recover_hanging_tasks,
    scan_hanging_tasks,
)
from core.wk_cli import run_wk_cli  # noqa: E402


class AuditRegressionsPythonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir(parents=True, exist_ok=True)
        self.wk_home = self.root / "wk-home"
        self.wk_home.mkdir(parents=True, exist_ok=True)
        self._old_env = {k: os.environ.get(k) for k in ("WK_HOME", "WK_LEARNING_DB", "WK_LEARNING_SUMMARY")}
        os.environ["WK_HOME"] = str(self.wk_home)
        os.environ["WK_LEARNING_DB"] = str(self.wk_home / "learning.sqlite")
        os.environ["WK_LEARNING_SUMMARY"] = str(self.wk_home / "learning-summary.json")

    def tearDown(self) -> None:
        for k, v in self._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_sanitizer_catches_new_secrets_without_false_positive_env_dumps(self) -> None:
        pem_hdr = "-----" + "BEGIN RSA PRIVATE " + "KEY-----\n" + "MIIEowIBAAKCAQEA"
        pem_res = sanitize_text(pem_hdr)
        self.assertFalse(pem_res.blocked)
        self.assertIn("private_key_unclosed", pem_res.redactions)
        self.assertNotIn("MIIEowIBAAKCAQEA", pem_res.text)

        quoted_sample = "API_" + "SECRET=" + '"example_value_' + ('x' * 16) + '"'
        quoted_res = sanitize_text(quoted_sample)
        self.assertIn("env_secret_assignment_quoted", quoted_res.redactions)
        self.assertNotIn("example_value_", quoted_res.text)

        yaml_sample = "api_" + "key: example_yaml_" + ('y' * 16)
        yaml_res = sanitize_text(yaml_sample)
        self.assertIn("yaml_unquoted_secret", yaml_res.redactions)
        self.assertNotIn("example_yaml_", yaml_res.text)

        # Actual 3-line env credential dump is blocked fail-closed
        dump_sample = "\n".join([
            "API_" + "KEY=val_a_" + ("a" * 16),
            "AUTH_" + "TOKEN=val_b_" + ("b" * 16),
            "APP_" + "SECRET=val_c_" + ("c" * 16),
        ])
        dump_res = sanitize_text(dump_sample)
        self.assertTrue(dump_res.blocked)
        self.assertIn("env_dump_blocked", dump_res.redactions)

        # Normal 3-line Python assignment block should NOT trip ENV_DUMP_LINE_RE
        benign = "retries = 3\ntimeout = 10\nbatch_size = 50\n"
        ok_res = sanitize_text(benign)
        self.assertFalse(ok_res.blocked, f"Unexpected block on benign Python code: {ok_res.block_reason}")

        self.assertEqual(anonymize_workspace("ws_global"), "ws_global")
        self.assertEqual(anonymize_workspace("ws_shared"), "ws_shared")
        rel = sanitize_path(str(self.ws / "src" / "app.py"), workspace_dir=self.ws)
        self.assertEqual(rel, "src/app.py")

    def test_snippet_store_fts_language_case_insensitive_and_unique_sync_bundles(self) -> None:
        db = SnippetStore(db_path=self.wk_home / "learning.sqlite")
        r1 = db.save_snippet(
            title="Retry helper",
            code="def retry_once(fn):\n    return fn()\n",
            language="python",
            context="Retry utility",
            verification_status="verified_pass",
        )
        self.assertTrue(r1["ok"])
        res = db.query_snippets("retry", language="PYTHON", limit=5)
        self.assertGreaterEqual(len(res["snippets"]), 1)
        self.assertEqual(res["snippets"][0]["language"], "python")

        sync_dir = self.wk_home / "sync-out"
        s1 = db.sync_now(sync_dir=sync_dir)
        db.save_snippet(
            title="Second helper",
            code="def helper_two():\n    return 42\n",
            language="python",
            context="Helper",
            verification_status="verified_pass",
        )
        s2 = db.sync_now(sync_dir=sync_dir)
        self.assertTrue(s1["ok"] and s2["ok"])
        bundles = sorted(sync_dir.glob("*.json"))
        self.assertEqual(len(bundles), 2)

    def test_learning_promotions_are_scoped_to_session_id(self) -> None:
        db_path = self.wk_home / "learning.sqlite"
        db = SnippetStore(db_path=db_path)
        fa = self.ws / "mod_a.py"
        fb = self.ws / "mod_b.py"
        fa.write_text("def fn_a():\n    return 1\n", encoding="utf-8")
        fb.write_text("def fn_b():\n    return 1\n", encoding="utf-8")
        track_agent_edit(file_path=fa, session_id="sess-A", workspace_dir=self.ws)
        track_agent_edit(file_path=fb, session_id="sess-B", workspace_dir=self.ws)
        fa.write_text("def fn_a():\n    return 100\n", encoding="utf-8")
        fb.write_text("def fn_b():\n    return 200\n", encoding="utf-8")
        ra = detect_and_record_correction(file_path=fa, session_id="sess-A", workspace_dir=self.ws, store=db)
        rb = detect_and_record_correction(file_path=fb, session_id="sess-B", workspace_dir=self.ws, store=db)
        self.assertTrue(ra["ok"] and rb["ok"])

        promoted = promote_session_snippets_on_test_pass(
            session_id="sess-A",
            workspace_dir=self.ws,
            test_command="python3 -m unittest",
            store=db,
        )
        self.assertEqual(promoted.get("promoted"), 1)
        self.assertEqual(promoted.get("snippet_ids"), [ra["snippet"]["id"]])
        ver_a = db.query_snippets("fn_a", verified_only=True)["snippets"]
        ver_b = db.query_snippets("fn_b", verified_only=True)["snippets"]
        self.assertEqual(len(ver_a), 1)
        self.assertEqual(len(ver_b), 0)

    def test_clipboard_fenced_rewrite_stops_at_matching_closing_fence(self) -> None:
        sample = (
            "Preamble\n"
            "```markdown\n"
            "## Goal\nFix issue cleanly.\n"
            "```\n\n"
            "Trailing chat commentary.\n"
            "```python\n"
            "print('unrelated')\n"
            "```\n"
        )
        extracted = extract_fenced_rewrite(sample)
        self.assertIn("Fix issue cleanly.", extracted)
        self.assertNotIn("Trailing chat commentary", extracted)
        self.assertNotIn("unrelated", extracted)

    def test_watchdog_ts_parser_dry_scan_and_clean_requeue(self) -> None:
        self.assertGreater(_parse_ts_ms("1700000000000"), 0)
        self.assertGreater(_parse_ts_ms("2026-11-22T10:00:00Z"), 0)
        self.assertIsNone(_parse_ts_ms("not-a-ts"))

        sum_file = self.wk_home / "watchdog" / "summary.json"
        wd = scan_hanging_tasks(write_summary=False)
        self.assertTrue(wd["ok"])
        self.assertFalse(sum_file.exists())

        subprocess.run(["git", "init", "-q"], cwd=str(self.ws), check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(self.ws), check=True)
        subprocess.run(["git", "config", "user.name", "Audit Test"], cwd=str(self.ws), check=True)
        (self.ws / "README.md").write_text("hi\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=str(self.ws), check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(self.ws), check=True)
        head_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(self.ws), text=True).strip()
        wt = self.wk_home / "worktrees" / "20261122-010101-requeue"
        subprocess.run(["git", "worktree", "add", "-q", "-b", "wk/requeue-test", str(wt)], cwd=str(self.ws), check=True)

        task_dir = self.wk_home / "tasks" / "20261122-010101-requeue"
        task_dir.mkdir(parents=True, exist_ok=True)
        stale_meta = {
            "id": "20261122-010101-requeue",
            "status": "taken",
            "repo": str(self.ws),
            "worktree": str(wt),
            "taken_at": "2026-01-01T00:00:00Z",
            "base": head_sha,
            "stalled_at": "2026-01-01T00:01:00Z",
            "stall_note": "old stall",
            "stalled_suggestion_id": "S-1",
            "last_activity_at": "2026-01-01T00:00:30Z",
        }
        (task_dir / "meta.json").write_text(json.dumps(stale_meta), encoding="utf-8")
        now = int(time.time() * 1000) + 120_000
        # P2-276 review: only quiet time the watcher saw counts (2 x the stale window, passes at most
        # 120 s apart), so a first pass starts the count and changes nothing.
        first = recover_hanging_tasks(self.wk_home, now_ms=now - 1000, task_stale_ms=100, dry_run=False)
        self.assertNotIn("20261122-010101-requeue", [r.get("id") for r in first.get("recovered", [])])
        self.assertTrue(wt.is_dir())
        res = recover_hanging_tasks(
            self.wk_home,
            now_ms=now,
            task_stale_ms=100,
            dry_run=False,
        )
        self.assertTrue(res["ok"])
        # P2-276 (replaces the P2-272 wait for the owner's OK): a dead clean task is requeued automatically
        # through decide_pending_removal (life re-checked, backup, removal); its stall fields are cleared.
        auto = [r for r in res["recovered"] if r.get("id") == "20261122-010101-requeue"]
        self.assertEqual(auto[0]["action"], "auto_requeued", res)
        self.assertIn("20261122-010101-requeue", load_pending_removals(self.wk_home)["items"])
        approved = decide_pending_removal(
            "20261122-010101-requeue", "approve-remove", wk_home=self.wk_home, now_ms=now + 1000, stale_ms=100
        )
        self.assertTrue(approved["ok"], approved)   # a second OK is harmless: "Already removed."
        self.assertFalse(wt.exists())
        updated = json.loads((task_dir / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(updated["status"], "queued")
        for cleared_key in ("base", "stalled_at", "stall_note", "stalled_suggestion_id", "last_activity_at"):
            self.assertIsNone(updated.get(cleared_key))
        # The removed worktree's backup is recorded for undo (P2-272) and exists on disk.
        self.assertTrue(updated.get("removal_backup"))
        self.assertTrue(os.path.isdir(updated["removal_backup"]))
        self.assertEqual(approved.get("backup"), updated["removal_backup"])

    def test_fast_path_and_hook_bus_fail_closed_and_subagent_reset(self) -> None:
        for cmd in ("/wk-status", "/wk-tasks", "/wk-heal"):
            dec = evaluate_fast_path(cmd, env=dict(os.environ))
            self.assertTrue(dec.bypass, f"Expected bypass for {cmd}")

        # Hook scripts now run through the shared process-group runner (P2-272), so the failure is injected there.
        with mock.patch.object(hook_bus, "run_in_group", side_effect=OSError("boom")):
            rc, _out, err = hook_bus.handle_event(
                "PreToolUse",
                json.dumps({"tool_name": "Write", "tool_input": {"file_path": "/tmp/x"}, "cwd": str(self.ws)}),
            )
            self.assertEqual(rc, 2)
            self.assertIn("failed", err.lower())

        rt = StateStore(workspace_dir=self.ws)
        rt.update_session("sid-reset", lambda st: st.__setitem__("subagent_depth", 3))
        rc_s, _out_s, _ = hook_bus.handle_event(
            "SessionStart",
            json.dumps({"session_id": "sid-reset", "cwd": str(self.ws), "source": "startup"}),
            store=rt,
            bypass_subprocesses=True,
        )
        self.assertEqual(rc_s, 0)
        self.assertEqual(rt.get_session("sid-reset").get("subagent_depth"), 0)

        paths = hook_bus._extract_edited_paths({"toolCall": {"name": "write_file", "args": {"Path": str(self.ws / "a.py")}}})
        self.assertTrue(any(str(self.ws / "a.py") in p for p in paths))
        paths2 = hook_bus._extract_edited_paths({"tool_name": "edit_file", "tool_input": {"Path": str(self.ws / "b.py")}})
        self.assertTrue(any(str(self.ws / "b.py") in p for p in paths2))

    def test_wk_cli_new_workflows_errors_and_doctor_under_kill(self) -> None:
        rc_h, help_res = run_wk_cli(["help"], workspace=str(self.ws))
        self.assertEqual(rc_h, 0)
        self.assertIn("overview", help_res["commands"])

        rc_o, ov = run_wk_cli(["overview"], workspace=str(self.ws))
        self.assertEqual(rc_o, 0)
        self.assertEqual(ov["version"], "2.0.0")
        self.assertIn("queue", ov)
        self.assertIn("jobs", ov)
        self.assertIn("open_suggestions", ov)

        rc_bad_sk, bad_sk = run_wk_cli(["skills", "nonexistent"], workspace=str(self.ws))
        self.assertEqual(rc_bad_sk, 2)
        self.assertFalse(bad_sk["ok"])

        rc_bad_gf, bad_gf = run_wk_cli(["graph", "nonexistent"], workspace=str(self.ws))
        self.assertEqual(rc_bad_gf, 2)
        self.assertFalse(bad_gf["ok"])

        (self.wk_home / "KILL").write_text("stop\n", encoding="utf-8")
        db_file = self.wk_home / "learning.sqlite"
        rc_doc, doc = run_wk_cli(["doctor"], workspace=str(self.ws))
        self.assertIn("checks", doc)
        self.assertTrue(any(c["name"] == "kill_switch" and c["status"] == "active" for c in doc["checks"]))
        self.assertFalse(db_file.exists())

        rc_heal_dry, heal_dry = run_wk_cli(["heal"], workspace=str(self.ws))
        self.assertEqual(rc_heal_dry, 0)
        self.assertFalse(heal_dry["applied"])

        rc_heal_apply, heal_apply = run_wk_cli(["heal", "--apply"], workspace=str(self.ws))
        self.assertEqual(rc_heal_apply, 1)
        self.assertFalse(heal_apply["ok"])

    def test_atomic_write_json_clean_without_tmp_leftovers(self) -> None:
        target = self.wk_home / "atomic-check.json"
        atomic_write_json(target, {"hello": "world", "n": 7})
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["n"], 7)
        leftovers = [p.name for p in self.wk_home.iterdir() if ".tmp" in p.name]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
