"""Unit and integration tests for the Gemini + Claude Quota & Spend-Aware Orchestrator."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.orchestrator import Orchestrator, ProviderExecutionError  # noqa: E402


DUAL_INTEGRATIONS = {
    "overall_status": "dual_ready",
    "gemini": {
        "available": True,
        "primary_channel": "agy_gemini",
        "channels": [{"id": "agy_gemini", "available": True, "detail": "agy"}],
        "setup_hint": "Ready via agy_gemini.",
    },
    "claude": {
        "available": True,
        "primary_channel": "agy_claude",
        "channels": [{"id": "agy_claude", "available": True, "detail": "agy"}],
        "setup_hint": "Ready via agy_claude.",
    },
}


class OrchestratorRoutingTests(unittest.TestCase):
    def test_high_token_easy_task_offloads_to_gemini(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, integrations=DUAL_INTEGRATIONS)
            large_log = ("INFO 2026-11-21 request processed in 12ms status=200\n" * 400)
            dec = orch.preview_route(
                task="Extract all unique error codes from these logs as a bullet list",
                context=large_log,
            )
            self.assertEqual(dec["provider"], "gemini")
            self.assertEqual(dec["reason_code"], "token_heavy_offload")
            self.assertGreater(dec["claude_savings_usd"], 0.0)

    def test_complex_reasoning_task_routes_to_claude(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, integrations=DUAL_INTEGRATIONS)
            dec = orch.preview_route(
                task=(
                    "Architect a distributed consensus lock manager with lease fencing, "
                    "prove deadlock freedom under network partitions, and audit race conditions."
                ),
                role="execution",
            )
            self.assertEqual(dec["provider"], "claude")
            self.assertEqual(dec["reason_code"], "high_complexity_claude")

    def test_orchestrator_subtask_and_workflow_delegation_to_gemini(self) -> None:
        calls: list[dict] = []

        def fake_executor(provider: str, channel: str, model: str, prompt: str, system_prompt: str = "") -> dict:
            calls.append({"provider": provider, "model": model})
            return {"text": f"[{provider}] handled step", "input_tokens": 200, "output_tokens": 80}

        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, executor=fake_executor, integrations=DUAL_INTEGRATIONS)

            # Direct orchestrator role subtask -> Gemini
            dec_orch = orch.preview_route(
                task="Summarize and synthesize the following design notes",
                context="Note line.\n" * 500,
                role="orchestrator",
            )
            self.assertEqual(dec_orch["provider"], "gemini")
            self.assertEqual(dec_orch["reason_code"], "orchestrator_token_offload")

            # Multi-step workflow: large context compression (Gemini) -> complex subtask (Claude) + easy subtask (Gemini) -> aggregate (Gemini)
            heavy_ctx = "Module dependency trace entry line.\n" * 450
            res = orch.orchestrate_workflow(
                task="Harden payment service concurrency and summarize module changes",
                context=heavy_ctx,
                subtasks=[
                    "Format the changelog bullet points cleanly",
                    "Architect a distributed idempotency key lock and audit race conditions across retries",
                ],
            )
            trace = res["trace"]
            steps_by_name = {t["step"]: t for t in trace}
            self.assertEqual(steps_by_name["context_compression"]["provider"], "gemini")
            self.assertEqual(steps_by_name["subtask_1"]["provider"], "gemini")
            self.assertEqual(steps_by_name["subtask_2"]["provider"], "claude")
            self.assertEqual(steps_by_name["aggregation"]["provider"], "gemini")
            self.assertGreater(res["status"]["claude_savings_usd"], 0.0)

    def test_spend_pacing_and_claude_preservation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, integrations=DUAL_INTEGRATIONS)
            # Simulate Claude spend at 75% of $10 budget
            orch.ledger.record_execution(
                provider="claude",
                model="claude-sonnet-5-5-high",
                input_tokens=5000,
                output_tokens=1000,
                decision_summary={"reason_code": "test", "reason_summary": "seed"},
            )
            orch.ledger.update_config({"claude": {"dailyBudgetUsd": 0.04}})
            st = orch.status()
            self.assertGreaterEqual(st["usage"]["claude"]["utilization"], 0.70)

            dec = orch.preview_route(task="Implement a small helper function to validate dates")
            self.assertEqual(dec["provider"], "gemini")
            self.assertIn(dec["reason_code"], ("claude_quota_preservation", "spend_pacing_balance"))

    def test_capability_guardrails_prevent_invalid_offload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, integrations=DUAL_INTEGRATIONS)
            dec = orch.preview_route(
                task="Summarize hook setup",
                context="log line\n" * 600,
                required_capabilities=["claude_code_hooks"],
            )
            self.assertEqual(dec["provider"], "claude")
            self.assertEqual(dec["guardrail"], "claude_only")

            # If Claude is unavailable, claude_only must refuse rather than silently downgrading to Gemini
            gemini_only_integ = {
                "overall_status": "single_provider_fallback",
                "gemini": DUAL_INTEGRATIONS["gemini"],
                "claude": {"available": False, "primary_channel": None, "channels": [], "setup_hint": "missing"},
            }
            orch2 = Orchestrator(data_dir=tmp, integrations=gemini_only_integ)
            blocked = orch2.preview_route(
                task="Run hook task",
                required_capabilities=["claude_code_hooks"],
            )
            self.assertIsNone(blocked["provider"])
            self.assertEqual(blocked["guardrail"], "claude_only")

            # Giant context > 180k tokens auto-pins to Gemini
            huge_text = "x" * 700_000
            dec_gem = orch.preview_route(task="Inspect huge repo", context=huge_text)
            self.assertEqual(dec_gem["provider"], "gemini")
            self.assertEqual(dec_gem["guardrail"], "gemini_only")

    def test_rate_limit_cooldown_and_automatic_fallback(self) -> None:
        attempts: list[str] = []

        def flaky_executor(provider: str, channel: str, model: str, prompt: str, system_prompt: str = "") -> dict:
            attempts.append(provider)
            if provider == "claude":
                raise ProviderExecutionError("HTTP 429 rate limit exceeded", rate_limited=True)
            return {"text": "Recovered cleanly on Gemini", "input_tokens": 50, "output_tokens": 12}

        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, executor=flaky_executor, integrations=DUAL_INTEGRATIONS)
            # High-complexity task initially targets Claude, hits 429, and falls back to Gemini
            res = orch.run_task(
                task="Architect distributed consensus state machine and prove deadlock safety",
                role="execution",
            )
            self.assertEqual(attempts, ["claude", "gemini"])
            self.assertEqual(res["provider"], "gemini")
            self.assertEqual(res["fallback_from"], "claude")
            self.assertEqual(res["reason_code"], "fallback_after_error")

            # Subsequent task sees Claude is in cooldown and routes straight to Gemini
            next_dec = orch.preview_route(task="Architect multi-region failover protocol")
            self.assertEqual(next_dec["provider"], "gemini")
            self.assertEqual(next_dec["reason_code"], "fallback_rate_limited")

    def test_unconfigured_providers_return_actionable_error(self) -> None:
        none_integ = {
            "overall_status": "unconfigured",
            "gemini": {"available": False, "primary_channel": None, "channels": [], "setup_hint": "Set GEMINI_API_KEY"},
            "claude": {"available": False, "primary_channel": None, "channels": [], "setup_hint": "Set ANTHROPIC_API_KEY"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            orch = Orchestrator(data_dir=tmp, integrations=none_integ)
            dec = orch.preview_route(task="hello")
            self.assertIsNone(dec["provider"])
            self.assertIn("GEMINI_API_KEY", dec["reason_summary"])
            self.assertIn("ANTHROPIC_API_KEY", dec["reason_summary"])


class OrchestratorCliAndMcpTests(unittest.TestCase):
    def test_cli_status_and_plan_dry_run(self) -> None:
        cli = ROOT / "scripts" / "orchestrate.py"
        with tempfile.TemporaryDirectory() as tmp:
            p_status = subprocess.run(
                [sys.executable, str(cli), "--data-dir", tmp, "--json", "status"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(p_status.returncode, 0, p_status.stderr)
            st = json.loads(p_status.stdout)
            self.assertIn("integrations", st)
            self.assertIn("usage", st)

            p_plan = subprocess.run(
                [
                    sys.executable,
                    str(cli),
                    "--data-dir",
                    tmp,
                    "--json",
                    "plan",
                    "--role",
                    "orchestrator",
                    "Summarize large workspace trace",
                ],
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(p_plan.returncode, 0, p_plan.stderr)
            dec = json.loads(p_plan.stdout)
            self.assertIn("reason_code", dec)

    def test_mcp_orchestrator_tools(self) -> None:
        server_path = ROOT / "server" / "reprompt_mcp_server.py"
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.Popen(
                [sys.executable, str(server_path), "--data-dir", tmp],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            assert proc.stdin and proc.stdout

            def send(obj: dict) -> None:
                proc.stdin.write(json.dumps(obj) + "\n")
                proc.stdin.flush()

            def recv() -> dict:
                line = proc.stdout.readline()
                self.assertTrue(line)
                return json.loads(line)

            try:
                send({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
                })
                recv()
                send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

                send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
                tool_names = {t["name"] for t in recv()["result"]["tools"]}
                self.assertIn("orchestrate_task", tool_names)
                self.assertIn("orchestrator_status", tool_names)
                self.assertIn("app_orchestrator_run", tool_names)

                send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "orchestrator_status", "arguments": {}}})
                st_res = recv()["result"]
                self.assertFalse(st_res["isError"])
                self.assertIn("integrations", st_res["structuredContent"])

                send({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "orchestrate_task",
                        "arguments": {"task": "Summarize logs", "role": "orchestrator", "dry_run": True},
                    },
                })
                dry_res = recv()["result"]
                self.assertFalse(dry_res["isError"])
                self.assertIn("reason_code", dry_res["structuredContent"])
            finally:
                proc.stdin.close()
                proc.wait(timeout=5)
                proc.stdout.close()
                proc.stderr.close()

    def test_agy_executor_passes_scoped_mcp_settings_and_errors_on_headless_denial(self) -> None:
        """P2-272 4B (changed): this test used to assert that agy_gemini starts agy with scoped MCP settings.
        Starting agy is forbidden now (canon line 65), so it asserts the rule: the lane queues a wk-task with
        --allow '**' and --from owner, and no agy command is ever built."""
        import os
        from unittest import mock
        from server.orchestrator import DefaultProviderExecutor

        captured_cmds: list[list[str]] = []

        def fake_run(cmd, **_kwargs):
            captured_cmds.append(list(cmd))
            if cmd[0] == "git":
                return subprocess.CompletedProcess(cmd, 0, stdout="/tmp/fake-repo\n", stderr="")
            return subprocess.CompletedProcess(cmd, 0, stdout="t-20261124-abc\n", stderr="")

        executor = DefaultProviderExecutor({})
        executor.workspace = "/tmp"
        env = {k: v for k, v in os.environ.items() if k not in ("WK_CALLER", "CLAUDECODE")}
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch("server.orchestrator.find_agy_binary", return_value="/usr/local/bin/agy"),
            mock.patch("server.orchestrator.subprocess.run", side_effect=fake_run),
        ):
            res = executor(provider="gemini", channel="agy_gemini", model="gemini-pro-orchestrator", prompt="Check status")

        self.assertEqual(res["queued_task"], "t-20261124-abc")
        self.assertIn("Queued for Antigravity as task t-20261124-abc.", res["text"])
        self.assertIn("/wk-take-task", res["text"])
        self.assertFalse(any("agy" in Path(c[0]).name for c in captured_cmds), captured_cmds)
        add = [c for c in captured_cmds if any(str(x).endswith("wk-task.mjs") for x in c)]
        self.assertEqual(len(add), 1)
        cmd = add[0]
        self.assertEqual(cmd[cmd.index("--allow") + 1], "**")
        self.assertEqual(cmd[cmd.index("--from") + 1], "owner")
        self.assertEqual(cmd[cmd.index("--repo") + 1], "/tmp/fake-repo")
        self.assertNotIn("--test", cmd)
        self.assertNotIn("--settings", cmd)

    def test_claudecode_with_real_home_refuses_agy(self) -> None:
        """P2-272 canon: CLAUDECODE=1 with the account's real HOME never starts agy, even without WK_CALLER.
        (4B, changed: the lane used to raise "never calls"; it now queues, and still starts no agy. Only git and
        wk-task are allowed, both mocked here, so nothing touches the real ~/.wk.)"""
        import os
        import pwd
        from unittest import mock
        from server.orchestrator import DefaultProviderExecutor, _called_from_claude_code

        started: list[list[str]] = []

        def only_queue(cmd, **_kwargs):
            started.append(list(cmd))
            if cmd[0] == "git":
                return subprocess.CompletedProcess(cmd, 0, stdout="/tmp/fake-repo\n", stderr="")
            if any(str(x).endswith("wk-task.mjs") for x in cmd):
                return subprocess.CompletedProcess(cmd, 0, stdout="t-1\n", stderr="")
            raise AssertionError(f"a process was started: {cmd!r}")

        real_home = pwd.getpwuid(os.getuid()).pw_dir
        env = {k: v for k, v in os.environ.items() if k != "WK_CALLER"}
        env.update({"CLAUDECODE": "1", "HOME": real_home})
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch("server.orchestrator.find_agy_binary", return_value="/usr/local/bin/agy"),
            mock.patch("server.orchestrator.subprocess.run", side_effect=only_queue),
        ):
            self.assertTrue(_called_from_claude_code())
            for channel in ("agy_gemini", "agy_claude", "gemini_cli"):
                ex = DefaultProviderExecutor({})
                ex.workspace = "/tmp"
                res = ex(provider="gemini", channel=channel, model="gemini-pro-orchestrator", prompt="x")
                self.assertEqual(res["queued_task"], "t-1")
        add = [c for c in started if any(str(x).endswith("wk-task.mjs") for x in c)]
        self.assertEqual(len(add), 3)
        for cmd in add:
            self.assertEqual(cmd[cmd.index("--from") + 1], "claude")
        self.assertFalse(any(Path(c[0]).name in ("agy", "gemini") for c in started))

    def test_claudecode_allows_only_a_stub_agy_inside_a_temporary_home(self) -> None:
        """P2-272 canon: the one exception is a stub agy inside a temporary HOME (checked only, never run here)."""
        import os
        from unittest import mock
        from server.orchestrator import _called_from_claude_code

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            stub = home / "bin" / "agy"
            stub.parent.mkdir(parents=True)
            stub.write_text("#!/bin/sh\necho stub\n")
            stub.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if k != "WK_CALLER"}
            env.update({"CLAUDECODE": "1", "HOME": str(home), "PATH": str(stub.parent), "WK_HOME": str(home / ".wk")})
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertFalse(_called_from_claude_code(str(stub)))
                self.assertTrue(_called_from_claude_code("/usr/local/bin/agy"))
                os.environ["WK_CALLER"] = "claude_code"
                self.assertTrue(_called_from_claude_code(str(stub)))


if __name__ == "__main__":
    unittest.main()



STUB_MARKER_SCRIPT = """#!/bin/sh
echo "$(basename "$0") $*" >> "{marker}"
echo "stub ran" 
"""


class GeminiLanesQueueWithStubMarkersTests(unittest.TestCase):
    """P2-272 4B (B2): with stub `agy` and `gemini` first on PATH in a temporary HOME, every Gemini lane queues a
    real wk-task in a temporary git repo (real node, real bin/wk-task.mjs, temporary WK_HOME), in the IDE context
    and the Claude Code context; no stub ever writes its marker. No network: wk-task add only writes files."""

    def _setup(self, tmp: str, claudecode: bool) -> tuple[dict[str, str], str, str]:
        import os as _os
        import shutil

        home = _os.path.join(tmp, "home")
        stub_bin = _os.path.join(home, "bin")
        _os.makedirs(stub_bin)
        marker = _os.path.join(tmp, "stub-marker.log")
        for name in ("agy", "gemini"):
            path = _os.path.join(stub_bin, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(STUB_MARKER_SCRIPT.format(marker=marker))
            _os.chmod(path, 0o755)
        repo = _os.path.join(tmp, "repo")
        _os.makedirs(repo)
        genv = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "HOME": home, "PATH": "/usr/bin:/bin"}
        for args in (["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(["git", "-C", repo, *args], check=True, env=genv, capture_output=True)
        node = shutil.which("node") or "/opt/homebrew/bin/node"
        env = {
            "HOME": home,
            "WK_HOME": _os.path.join(tmp, "wk-home"),
            "PATH": f"{stub_bin}:/usr/bin:/bin",
            "WK_NODE": node,
            "REPROMPT_DATA_DIR": _os.path.join(tmp, "data"),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        if claudecode:
            env["CLAUDECODE"] = "1"
        return env, repo, marker

    def _queued_task_files(self, wk_home: str) -> list[Path]:
        return [p for p in Path(wk_home).rglob("*.json") if "task" in str(p)]

    def test_every_gemini_lane_queues_and_no_stub_runs_in_both_contexts(self) -> None:
        import os as _os
        from unittest import mock

        from server.orchestrator import DefaultProviderExecutor

        for claudecode in (False, True):
            with self.subTest(claudecode=claudecode), tempfile.TemporaryDirectory() as tmp:
                env, repo, marker = self._setup(tmp, claudecode)
                with mock.patch.dict(_os.environ, env):
                    if not claudecode:
                        _os.environ.pop("CLAUDECODE", None)
                    _os.environ.pop("WK_CALLER", None)
                    ex = DefaultProviderExecutor({})
                    ex.workspace = repo
                    for channel in ("agy_gemini", "agy_claude", "gemini_cli"):
                        res = ex(
                            channel=channel,
                            provider="gemini",
                            model="gemini-3.8-flash-low",
                            prompt=f"Fix the login bug via {channel}\nmore detail",
                            system_prompt="",
                        )
                        task_id = res.get("queued_task")
                        self.assertTrue(task_id, res)
                        self.assertIn(f"Queued for Antigravity as task {task_id}.", res["text"])
                        self.assertIn("/wk-take-task", res["text"])
                    found = subprocess.run(
                        ["grep", "-rl", "Fix the login bug via gemini_cli", env["WK_HOME"]], capture_output=True, text=True
                    )
                    self.assertTrue(found.stdout.strip(), "the queued task is not under the temporary WK_HOME")
                    src_hits = subprocess.run(
                        ["grep", "-rh", '"from"', env["WK_HOME"]], capture_output=True, text=True
                    ).stdout
                    want = "claude" if claudecode else "owner"
                    self.assertIn(want, src_hits)
                    if not claudecode:
                        self.assertNotIn('"claude"', src_hits)
                self.assertFalse(_os.path.exists(marker), "a stub agy or gemini ran")

    def test_not_a_git_repo_queues_nothing(self) -> None:
        import os as _os
        from unittest import mock

        from server.orchestrator import DefaultProviderExecutor

        with tempfile.TemporaryDirectory() as tmp:
            env, _repo, marker = self._setup(tmp, False)
            plain = _os.path.join(tmp, "plain")
            _os.makedirs(plain)
            with mock.patch.dict(_os.environ, env):
                _os.environ.pop("CLAUDECODE", None)
                ex = DefaultProviderExecutor({})
                ex.workspace = plain
                res = ex(channel="gemini_cli", provider="gemini", model="m", prompt="do it", system_prompt="")
            self.assertIsNone(res.get("queued_task"))
            self.assertIn("is not a git repository", res["text"])
            self.assertFalse(_os.path.exists(_os.path.join(env["WK_HOME"], "tasks")))
            self.assertFalse(_os.path.exists(marker))


class DeadAgyBranchTests(unittest.TestCase):
    """S11 (P2-272): with the queue switched off by a patch, the old agy and gemini_cli branches refuse at their
    first line; no binary lookup and no subprocess happen."""

    def test_old_branches_raise_the_canon_line(self) -> None:
        import os
        from unittest import mock
        from server import orchestrator as orch_mod

        executor = orch_mod.DefaultProviderExecutor({})
        executor.workspace = "/tmp"
        env = {k: v for k, v in os.environ.items() if k not in ("WK_CALLER", "CLAUDECODE")}
        boom = AssertionError("must not be reached")
        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(orch_mod, "QUEUE_CHANNELS", frozenset()),
            # The owner's-terminal case (the Claude Code guard above the branches is a separate test).
            mock.patch.object(orch_mod, "_called_from_claude_code", return_value=False),
            mock.patch.object(orch_mod, "find_agy_binary", side_effect=boom),
            mock.patch.object(orch_mod, "find_gemini_binary", side_effect=boom),
            mock.patch.object(orch_mod.subprocess, "run", side_effect=boom),
            mock.patch.object(orch_mod.subprocess, "Popen", side_effect=boom),
        ):
            for channel in ("agy_gemini", "agy_claude", "gemini_cli"):
                with self.assertRaisesRegex(ProviderExecutionError, "never runs agy or Gemini"):
                    executor(provider="gemini", channel=channel, model="m", prompt="Check status")
        self.assertEqual(orch_mod.NEVER_AGY, "Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.")


class DecisionWordsFollowTheChannelTests(unittest.TestCase):
    """P2-272 open point 5: the routing words say where Gemini-lane work really goes. Only gemini_api outside
    Claude Code sends the prompt to Gemini, with the owner's own key; under Claude Code the prompt is queued for
    Antigravity (like the JS orchestrators, S10) and the words say so. No network, no agy, no gemini."""

    @staticmethod
    def _integ(channel: str, claude_ready: bool) -> dict:
        return {
            "gemini": {"available": True, "channels": [{"id": channel, "available": True}], "setup_hint": "g"},
            "claude": {
                "available": claude_ready,
                "channels": [{"id": "claude_cli", "available": True}] if claude_ready else [],
                "setup_hint": "c",
            },
        }

    def _decide(self, channel: str, under_claude: bool, claude_ready: bool = True, **kw) -> dict:
        from unittest import mock
        from server.orchestrator import decide_route

        with mock.patch("server.orchestrator._called_from_claude_code", return_value=under_claude):
            return decide_route("Fix the footer typo", integrations=self._integ(channel, claude_ready), **kw)

    def test_own_key_outside_claude_code_says_sent_to_gemini(self) -> None:
        d = self._decide("gemini_api", False, claude_ready=False)
        self.assertEqual((d["provider"], d["channel"], d["reason_code"]), ("gemini", "gemini_api", "fallback_unavailable"))
        self.assertEqual(d["reason_summary"], "Sent to Gemini with your own API key because Claude is not configured.")
        self.assertEqual(
            self._decide("gemini_api", False)["reason_summary"],
            "Sent this routine task to Gemini with your own API key to keep Claude limits in reserve.",
        )
        pace = self._decide("gemini_api", False, watchkeeper_pace={"available": True, "claude_limit_exhausted": True})
        self.assertEqual(
            pace["reason_summary"],
            "Claude Code limits exhausted (Watchkeeper meter); the task is sent to Gemini with your own API key.",
        )

    def test_under_claude_code_and_on_the_queue_channel_the_words_say_queued(self) -> None:
        for channel, under_claude in (("gemini_api", True), ("agy_gemini", False), ("agy_gemini", True)):
            with self.subTest(channel=channel, under_claude=under_claude):
                d = self._decide(channel, under_claude, claude_ready=False)
                self.assertEqual(d["reason_summary"], "Queued for Antigravity because Claude is not configured.")
                self.assertEqual(
                    self._decide(channel, under_claude)["reason_summary"],
                    "Queued this routine task for Antigravity (wk-task) to keep Claude limits in reserve.",
                )
                pace = self._decide(channel, under_claude, watchkeeper_pace={"available": True, "claude_limit_exhausted": True})
                self.assertEqual(
                    pace["reason_summary"],
                    "Claude Code limits exhausted (Watchkeeper meter); the task is queued for Antigravity (wk-task), never run here.",
                )

    def test_gemini_api_under_claude_code_is_queued_and_never_sent(self) -> None:
        import os
        import urllib.request
        from unittest import mock
        from server.orchestrator import DefaultProviderExecutor

        queued: list[tuple] = []

        def fake_queue(prompt, workspace=None, source=None):
            queued.append((prompt, workspace))
            return {"text": "Queued for Antigravity as task t-9. Antigravity takes it when you run /wk-take-task there.", "queued_task": "t-9"}

        def no_net(*_a, **_k):
            raise AssertionError("a network request was made")

        with (
            mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-not-a-key"}),
            mock.patch("server.orchestrator._called_from_claude_code", return_value=True),
            mock.patch("server.orchestrator.queue_for_antigravity", side_effect=fake_queue),
            mock.patch.object(urllib.request, "urlopen", side_effect=no_net),
            mock.patch("server.orchestrator.subprocess.run", side_effect=AssertionError("a process was started")),
            mock.patch("server.orchestrator.subprocess.Popen", side_effect=AssertionError("a process was started")),
        ):
            ex = DefaultProviderExecutor({"geminiApiKey": "test-not-a-key"})
            ex.workspace = "/tmp/fake-repo"
            res = ex(provider="gemini", channel="gemini_api", model="gemini-pro", prompt="Fix the footer")
            self.assertEqual(res["queued_task"], "t-9")
            self.assertEqual(queued, [("Fix the footer", "/tmp/fake-repo")])
            ex.no_queue = True
            self.assertEqual(ex(provider="gemini", channel="gemini_api", model="gemini-pro", prompt="x"), {"text": "", "queue_skipped": True})
            self.assertEqual(len(queued), 1)
