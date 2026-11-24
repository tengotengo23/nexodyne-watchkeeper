"""Automated test suite for Re-Prompt."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.reprompt_engine import (  # noqa: E402
    MODES,
    TARGETS,
    RePromptStore,
    build_system_prompt,
    agy_is_test_stub,
    build_user_prompt,
    called_from_claude_code,
    find_agy_binary,
    list_agy_models,
    offline_rewrite,
    parse_rewrite_response,
    rewrite_with_provider,
)


class EngineUnitTests(unittest.TestCase):
    def test_prompt_builders_all_targets_and_modes(self) -> None:
        for target in TARGETS:
            for mode in MODES:
                sp = build_system_prompt(target, mode)
                up = build_user_prompt(
                    "fix login timeout",
                    target=target,
                    mode=mode,
                    workspace_context="Active file: auth.py",
                )
                self.assertIn("LANGUAGE PRESERVATION", sp)
                self.assertIn(f"<TARGET>{target}</TARGET>", up)
                self.assertIn(f"<MODE>{mode}</MODE>", up)
                self.assertIn("Active file: auth.py", up)

    def test_parse_rewrite_response_variants(self) -> None:
        direct = parse_rewrite_response(
            json.dumps(
                {
                    "rewritten_prompt": "## Goal\nFix timeout",
                    "summary": "Added scope.",
                    "improvements": ["Goal", "Verification"],
                }
            )
        )
        self.assertEqual(direct["rewritten_prompt"], "## Goal\nFix timeout")
        self.assertEqual(direct["improvements"], ["Goal", "Verification"])

        fenced = parse_rewrite_response(
            "Some text\n```json\n{\"rewritten_prompt\": \"## Goal\\nClean\", \"summary\": \"ok\", \"improvements\": [\"A\"]}\n```\n"
        )
        self.assertEqual(fenced["rewritten_prompt"], "## Goal\nClean")

        preamble = parse_rewrite_response(
            "Here is the rewritten prompt:\n\n## Goal\nShip tests", original_prompt="ship tests"
        )
        self.assertTrue(preamble["rewritten_prompt"].startswith("## Goal"))

        with self.assertRaises(ValueError):
            parse_rewrite_response("   ")

    def test_offline_template_modes_and_refinements(self) -> None:
        for mode in MODES:
            res = offline_rewrite(
                "fix the login bug and add unit tests",
                target="claude_code",
                mode=mode,
                workspace_context="src/login.ts",
            )
            self.assertIn("## Goal", res["rewritten_prompt"])
            self.assertIn("## Verification", res["rewritten_prompt"])
            if mode != "concise":
                self.assertIn("src/login.ts", res["rewritten_prompt"])

        shorter = offline_rewrite("a. b. c.", refinement="shorter", previous_rewritten="old")
        self.assertNotIn("## Constraints & Edge Cases", shorter["rewritten_prompt"])

        tests_ref = offline_rewrite("fix bug", refinement="add_tests", previous_rewritten="old")
        self.assertIn("unit/integration tests", tests_ref["rewritten_prompt"])

    def test_store_settings_secrets_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RePromptStore(tmp)
            store.save_settings({"provider": "gemini_api", "geminiApiKey": "secret-123", "autoRewrite": True})
            pub = store.public_settings()
            self.assertTrue(pub["hasGeminiApiKey"])
            self.assertNotIn("geminiApiKey", pub)
            self.assertTrue(pub["autoRewrite"])
            if os.name == "posix":
                mode = store.settings_path.stat().st_mode & 0o777
                self.assertEqual(mode, 0o600)

            store.save_settings({"clearGeminiApiKey": True})
            raw = store.load_settings()
            self.assertEqual(raw["geminiApiKey"], "")

            for i in range(55):
                store.add_history({"id": f"id-{i}", "original": f"p{i}", "rewritten": f"r{i}"})
            hist = store.load_history()
            self.assertEqual(len(hist), 50)
            self.assertEqual(hist[0]["id"], "id-54")
            store.delete_history("id-54")
            self.assertEqual(len(store.load_history()), 49)
            store.clear_history()
            self.assertEqual(store.load_history(), [])


class LiveAgyTests(unittest.TestCase):
    def test_live_agy_rewrite_preserves_english_and_structure(self) -> None:
        # S14 (P2-272, changed in 4B): this test used to run the real agy from the owner's terminal. Watchkeeper
        # now never runs agy in any context (it uses the owner's Google login), so it asserts the rule instead:
        # provider "agy" outside Claude Code rewrites with the local template, keeps English and structure, and
        # a stub agy first on PATH (in a temporary HOME) is never called.
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            stub = _write_agy_stub(os.path.join(home, "bin"))
            env = {
                "HOME": home,
                "PATH": f"{os.path.join(home, 'bin')}:/usr/bin:/bin",
                "WK_HOME": os.path.join(tmp, "wk-home"),
                "REPROMPT_DATA_DIR": os.path.join(tmp, "data"),
            }
            with mock.patch.dict(os.environ, env):
                os.environ.pop("CLAUDECODE", None)
                os.environ.pop("WK_CALLER", None)
                store = RePromptStore(os.path.join(tmp, "data"))
                res = rewrite_with_provider(
                    store,
                    prompt="fix the login timeout bug and add regression unit tests",
                    target="antigravity",
                    mode="balanced",
                    provider_override="agy",
                    model_override="gemini-3.8-flash-low",
                )
                self.assertEqual(list_agy_models(), [])
            text = res["rewritten_prompt"]
            self.assertTrue(len(text) > 40)
            self.assertIn("##", text)
            # Ensure zero Georgian bleed-through from global mentor rule
            self.assertIsNone(re.search(r"[\u10A0-\u10FF]", text), f"Unexpected Georgian characters in output: {text}")
            self.assertNotIn("Sure, here", text)
            self.assertIn("does not run Antigravity", res.get("summary", ""))
            self.assertEqual(_stub_calls(stub), [])

AGY_STUB = """#!/bin/sh
p=no
for a in "$@"; do case "$a" in -p=*) p=yes;; esac; done
printf 'called model=%s prompt=%s\\n' "$3" "$p" >> "$(dirname "$0")/calls.log"
cat <<'EOF'
## Goal
Fix the login timeout bug and add regression unit tests.

## Steps
1. Find where the login timeout is set and fix it.
2. Add regression unit tests for the timeout.

## Verification
Run the unit tests; the new ones pass.
EOF
"""


def _write_agy_stub(bin_dir: str) -> str:
    os.makedirs(bin_dir, exist_ok=True)
    path = os.path.join(bin_dir, "agy")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(AGY_STUB)
    os.chmod(path, 0o755)
    return path


def _stub_calls(stub: str) -> list[str]:
    log = os.path.join(os.path.dirname(stub), "calls.log")
    if not os.path.exists(log):
        return []
    with open(log, encoding="utf-8") as fh:
        return [line for line in fh.read().splitlines() if line.strip()]


class AgyCanonGuardTests(unittest.TestCase):
    """P2-272 canon: agy (Gemini on the owner's Google login) never runs from Claude. Under Claude only a stub
    inside a temporary HOME may stand in for it. No test here can reach the real agy: PATH and HOME point at
    temporary folders, or the guard refuses before anything runs."""

    def _env(self, tmp: str, *, home: str, claudecode: bool, wk_caller: str = "") -> dict[str, str]:
        env = {
            "HOME": home,
            "PATH": f"{os.path.join(tmp, 'bin')}:{os.path.join(home, 'bin')}:/usr/bin:/bin",
            "WK_HOME": os.path.join(tmp, "wk-home"),
            "REPROMPT_DATA_DIR": os.path.join(tmp, "data"),
        }
        if claudecode:
            env["CLAUDECODE"] = "1"
        if wk_caller:
            env["WK_CALLER"] = wk_caller
        return env

    def _patched(self, env: dict[str, str]) -> None:
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ("CLAUDECODE", "WK_CALLER"):
            if key not in env:
                os.environ.pop(key, None)

    def test_stub_in_temporary_home_runs_under_claude(self) -> None:
        # S14 (P2-272, changed in 4B): this test used to assert that a stub agy in a temporary HOME runs under
        # Claude. Watchkeeper now never runs agy in any context, stub or not: the rewrite uses the local template
        # and the stub is never called. The name stays so the history reads.
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            stub = _write_agy_stub(os.path.join(home, "bin"))
            self._patched(self._env(tmp, home=home, claudecode=True))
            found = find_agy_binary()
            self.assertEqual(Path(found).resolve(), Path(stub).resolve())
            self.assertTrue(agy_is_test_stub(found))
            self.assertFalse(called_from_claude_code(found))
            store = RePromptStore(os.path.join(tmp, "data"))
            res = rewrite_with_provider(
                store,
                prompt="fix the login timeout bug and add regression unit tests",
                target="antigravity",
                mode="balanced",
                provider_override="agy",
                model_override="gemini-3.8-flash-low",
                include_skills=False,
            )
            self.assertTrue(res["rewritten_prompt"].strip())
            self.assertIn("does not run Antigravity", res.get("summary", ""))
            self.assertEqual(list_agy_models(), [])
            self.assertEqual(_stub_calls(stub), [])

    def test_real_home_refuses_agy_under_claude(self) -> None:
        import pwd

        real_home = pwd.getpwuid(os.getuid()).pw_dir
        with tempfile.TemporaryDirectory() as tmp:
            # The stub sits first on PATH, so even a broken guard could only ever run the stub, never the real agy.
            stub = _write_agy_stub(os.path.join(tmp, "bin"))
            self._patched(self._env(tmp, home=real_home, claudecode=True))
            self.assertEqual(Path(find_agy_binary()).resolve(), Path(stub).resolve())
            self.assertFalse(agy_is_test_stub(stub))
            self.assertTrue(called_from_claude_code(stub))
            self.assertTrue(called_from_claude_code())
            store = RePromptStore(os.path.join(tmp, "data"))
            # S12 (P2-272, changed): "agy" used to raise here; it now rewrites on the local template with the
            # note, the same as outside Claude Code. "auto" and "gemini_api" still refuse. Nothing spawns.
            res = rewrite_with_provider(store, prompt="fix the login bug", provider_override="agy", include_skills=False)
            self.assertTrue(res["rewritten_prompt"].strip())
            self.assertIn("does not run Antigravity", res.get("summary", ""))
            self.assertEqual(res.get("model"), "local-template")
            for provider in ("auto", "gemini_api"):
                with self.assertRaisesRegex(RuntimeError, "Watchkeeper canon"):
                    rewrite_with_provider(store, prompt="fix the login bug", provider_override=provider)
            self.assertEqual(list_agy_models(), [])
            self.assertEqual(_stub_calls(stub), [])

    def test_wk_caller_claude_code_always_refuses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            stub = _write_agy_stub(os.path.join(home, "bin"))
            self._patched(self._env(tmp, home=home, claudecode=False, wk_caller="claude_code"))
            self.assertTrue(agy_is_test_stub(stub))
            self.assertTrue(called_from_claude_code(stub))
            store = RePromptStore(os.path.join(tmp, "data"))
            # S12 (P2-272, changed): the default provider "agy" no longer raises under Claude Code; it uses the
            # local template with the note. "auto" still refuses. The stub is still never called.
            res = rewrite_with_provider(store, prompt="fix the login bug", provider_override="agy", include_skills=False)
            self.assertIn("does not run Antigravity", res.get("summary", ""))
            self.assertEqual(res.get("model"), "local-template")
            with self.assertRaisesRegex(RuntimeError, "Watchkeeper canon"):
                rewrite_with_provider(store, prompt="fix the login bug", provider_override="auto")
            self.assertEqual(list_agy_models(), [])
            self.assertEqual(_stub_calls(stub), [])

    def test_dead_agy_branches_refuse_when_called_directly(self) -> None:
        """S11 (P2-272): the old agy code refuses at its first line, before it even looks for the binary."""
        from server import reprompt_engine as eng

        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            stub = _write_agy_stub(os.path.join(home, "bin"))
            self._patched(self._env(tmp, home=home, claudecode=False))
            with mock.patch.object(eng, "find_agy_binary", side_effect=AssertionError("looked for agy")):
                with self.assertRaisesRegex(RuntimeError, "never runs agy or Gemini"):
                    eng._run_agy("sys", "user", "")
                with self.assertRaisesRegex(RuntimeError, "never runs agy or Gemini"):
                    eng._legacy_list_agy_models()
            self.assertEqual(eng.NEVER_AGY, "Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue.")
            self.assertEqual(_stub_calls(stub), [])

    def test_gemini_api_refused_under_claude_even_with_a_stub_home(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            _write_agy_stub(os.path.join(home, "bin"))
            self._patched(self._env(tmp, home=home, claudecode=True))
            store = RePromptStore(os.path.join(tmp, "data"))
            with self.assertRaisesRegex(RuntimeError, "Watchkeeper canon"):
                rewrite_with_provider(store, prompt="fix the login bug", provider_override="gemini_api")

    def test_owner_terminal_is_not_affected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self._patched(self._env(tmp, home=os.path.join(tmp, "home"), claudecode=False))
            self.assertFalse(called_from_claude_code("/any/agy"))
            self.assertFalse(called_from_claude_code(""))

    def test_local_template_still_works_under_claude(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self._patched(self._env(tmp, home=os.path.join(tmp, "home"), claudecode=True))
            store = RePromptStore(os.path.join(tmp, "data"))
            res = rewrite_with_provider(store, prompt="fix the login timeout bug", provider_override="offline_template")
            self.assertTrue(res["rewritten_prompt"].strip())


class McpProtocolTests(unittest.TestCase):
    def test_mcp_stdio_lifecycle_and_apps_protocol(self) -> None:
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
                self.assertTrue(line, "Unexpected EOF from MCP server")
                return json.loads(line)

            try:
                # 1. Initialize
                send({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}},
                })
                init_res = recv()
                self.assertEqual(init_res["id"], 1)
                self.assertEqual(init_res["result"]["protocolVersion"], "2025-06-18")
                self.assertIn("resources", init_res["result"]["capabilities"])

                send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

                # 2. Ping
                send({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}})
                self.assertEqual(recv()["id"], 2)

                # 3. tools/list
                send({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}})
                tools = recv()["result"]["tools"]
                names = {t["name"]: t for t in tools}
                self.assertIn("open_reprompt", names)
                self.assertIn("rewrite_prompt", names)
                self.assertIn("app_rewrite", names)
                self.assertEqual(
                    names["open_reprompt"]["_meta"]["ui"]["resourceUri"],
                    "ui://re-prompt/app.html",
                )
                self.assertEqual(names["app_rewrite"]["_meta"]["ui"]["visibility"], ["app"])

                # 4. resources/list & resources/read
                send({"jsonrpc": "2.0", "id": 4, "method": "resources/list", "params": {}})
                resources = recv()["result"]["resources"]
                self.assertEqual(resources[0]["uri"], "ui://re-prompt/app.html")
                self.assertEqual(resources[0]["mimeType"], "text/html;profile=mcp-app")

                send({"jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": {"uri": "ui://re-prompt/app.html"}})
                read_res = recv()["result"]["contents"][0]
                self.assertEqual(read_res["mimeType"], "text/html;profile=mcp-app")
                self.assertIn("Re-Prompt", read_res["text"])

                # 5. open_reprompt with empty args {}
                send({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "open_reprompt", "arguments": {}}})
                open_res = recv()["result"]
                self.assertFalse(open_res["isError"])
                self.assertIn("settings", open_res["structuredContent"])

                # 6. app_save_settings (switch to offline_template) + app_rewrite
                send({
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/call",
                    "params": {"name": "app_save_settings", "arguments": {"provider": "offline_template"}},
                })
                save_res = recv()["result"]
                self.assertEqual(save_res["structuredContent"]["settings"]["provider"], "offline_template")

                send({
                    "jsonrpc": "2.0",
                    "id": 8,
                    "method": "tools/call",
                    "params": {"name": "app_rewrite", "arguments": {"prompt": "add dark mode toggle", "target": "claude_code"}},
                })
                rw_res = recv()["result"]
                self.assertFalse(rw_res["isError"])
                self.assertIn("## Goal", rw_res["structuredContent"]["rewritten_prompt"])

                # 7. app_get_state confirms history recorded
                send({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "app_get_state", "arguments": {}}})
                state_res = recv()["result"]["structuredContent"]
                self.assertEqual(len(state_res["history"]), 1)

                # 8. app_clear_history
                send({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "app_clear_history", "arguments": {}}})
                clr_res = recv()["result"]["structuredContent"]
                self.assertEqual(clr_res["history"], [])
            finally:
                proc.stdin.close()
                proc.wait(timeout=5)
                proc.stdout.close()
                proc.stderr.close()


class InlineHooksTests(unittest.TestCase):
    def _run_hook(self, script_path: Path, payload: dict, env_extra: dict | None = None) -> dict:
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run(
            [sys.executable, str(script_path)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout.strip() or "{}")

    def test_antigravity_inline_hook_prefixes_and_dedup(self) -> None:
        hook_script = ROOT / "scripts" / "reprompt_inline_hook.py"
        with tempfile.TemporaryDirectory() as tmp:
            store = RePromptStore(tmp)
            store.save_settings({"provider": "offline_template", "hookAutoAll": False})
            # Own WK_HOME: the owner's real Stop switch must never decide this test.
            env = {"REPROMPT_DATA_DIR": tmp, "PLUGIN_DATA": tmp, "WK_HOME": os.path.join(tmp, "wk-home")}

            # Normal prompt without prefix -> fast-path {}
            res_plain = self._run_hook(
                hook_script,
                {"conversationId": "conv-1", "lastUserInput": "explain how asyncio works"},
                env,
            )
            self.assertEqual(res_plain, {})

            # rp: prefix -> rewrites and injects systemMessage + user_markdown
            res_rp = self._run_hook(
                hook_script,
                {"conversationId": "conv-1", "lastUserInput": "rp: fix login bug and add tests"},
                env,
            )
            steps = res_rp.get("injectSteps", [])
            self.assertEqual(len(steps), 1)
            sys_msg = steps[0]["systemMessage"]
            self.assertIn("## Goal", sys_msg["systemMessage"])
            self.assertIn("## Verification", sys_msg["systemMessage"])
            # P2-272 (owner, A4): the chat shows one line; the full rewrite stays in the system message.
            md_rp = sys_msg["metadata"]["user_markdown"]
            self.assertTrue(md_rp.startswith("✨ Re-prompted · "), md_rp)
            self.assertNotIn("\n", md_rp)
            self.assertNotIn("## Goal", md_rp)
            self.assertIn("stays authoritative", sys_msg["systemMessage"])
            self.assertNotIn("Do NOT pause", sys_msg["systemMessage"])
            # Antigravity PreInvocation shape (owner, 23 Nov): no "type" key anywhere in the step.
            self.assertEqual(set(steps[0].keys()), {"systemMessage"})
            self.assertEqual(set(sys_msg.keys()), {"systemMessage", "metadata"})
            routes = store.load_routes()
            self.assertEqual(routes["conv-1"]["route"], "reprompt")
            self.assertEqual(routes["conv-1"]["engine"], "antigravity")

            # Repeated identical invocation in same conversation -> deduplicated {}
            res_dup = self._run_hook(
                hook_script,
                {"conversationId": "conv-1", "lastUserInput": "rp: fix login bug and add tests"},
                env,
            )
            self.assertEqual(res_dup, {})

            # Mode prefixes
            for prefix, expected_mode in (
                ("rp-bug", "bug_fix"),
                ("rp-spec", "deep_spec"),
                ("rp-concise", "concise"),
            ):
                res_mode = self._run_hook(
                    hook_script,
                    {"conversationId": "conv-2", "lastUserInput": f"{prefix}: inspect cache invalidation"},
                    env,
                )
                md = res_mode["injectSteps"][0]["systemMessage"]["metadata"]["user_markdown"]
                self.assertIn(expected_mode, md)

            # P2-272: ":rp ", ":re-prompt " and "re-prompt:" work like "rp:"
            for i, text in enumerate(
                (":rp inspect cache invalidation", ":re-prompt inspect cache invalidation", "re-prompt: inspect cache")
            ):
                res_colon = self._run_hook(
                    hook_script, {"conversationId": f"conv-colon-{i}", "lastUserInput": text}, env
                )
                self.assertIn("## Goal", res_colon["injectSteps"][0]["systemMessage"]["systemMessage"], text)

            # Recursion guard
            res_guard = self._run_hook(
                hook_script,
                {"conversationId": "conv-3", "lastUserInput": "rp: should be skipped"},
                {**env, "REPROMPT_INTERNAL_CALL": "1"},
            )
            self.assertEqual(res_guard, {})

            # P2-272 (owner's spec): the Stop switch (WK_HOME/KILL) halts the hook in every folder.
            kill_home = os.path.join(tmp, "wk-home")
            os.makedirs(kill_home, exist_ok=True)
            kill_file = os.path.join(kill_home, "KILL")
            with open(kill_file, "w", encoding="utf-8") as fh:
                fh.write("test\n")
            payload_kill = {"conversationId": "conv-kill", "lastUserInput": "rp: tidy the readme", "cwd": tmp}
            self.assertEqual(self._run_hook(hook_script, payload_kill, env), {})
            # The older, narrower scope stays available as an opt-in: outside Watchkeeper's folders it rewrites.
            res_scoped = self._run_hook(hook_script, payload_kill, {**env, "WK_KILL_SCOPE": "worktrees"})
            self.assertIn("## Goal", res_scoped["injectSteps"][0]["systemMessage"]["systemMessage"])
            os.remove(kill_file)

            # hookAutoAll skips bare acks, respects raw: bypass, and auto-rewrites short & Georgian prompts directly
            store.save_settings({"provider": "offline_template", "hookAutoAll": True})
            self.assertEqual(
                self._run_hook(hook_script, {"conversationId": "conv-4", "lastUserInput": "ok"}, env),
                {},
            )
            res_raw = self._run_hook(
                hook_script,
                {"conversationId": "conv-4", "lastUserInput": "raw: just say hi"},
                env,
            )
            self.assertIn("Raw Mode", res_raw["injectSteps"][0]["systemMessage"]["systemMessage"])
            self.assertEqual(
                res_raw["injectSteps"][0]["systemMessage"]["metadata"]["user_markdown"], "⚡ Raw · sent as typed"
            )
            self.assertEqual(store.load_routes()["conv-4"]["route"], "raw")
            res_colon_raw = self._run_hook(
                hook_script, {"conversationId": "conv-4b", "lastUserInput": ":raw just say hi"}, env
            )
            self.assertIn("just say hi", res_colon_raw["injectSteps"][0]["systemMessage"]["systemMessage"])
            for short_prompt in (
                "fix login bug",
                "Values-compass გვერდის ტექსტი",
                "build a retry wrapper for http calls",
            ):
                res_auto = self._run_hook(
                    hook_script,
                    {"conversationId": "conv-4", "lastUserInput": short_prompt},
                    env,
                )
                sys_auto = res_auto["injectSteps"][0]["systemMessage"]["systemMessage"]
                self.assertIn("## Goal", sys_auto)
                # P2-272 (owner's spec): never "Do NOT pause to ask"; the owner's own message stays authoritative.
                self.assertNotIn("Do NOT pause to ask", sys_auto)
                self.assertIn("stays authoritative", sys_auto)

    def test_claude_inline_hook(self) -> None:
        hook_script = ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py"
        with tempfile.TemporaryDirectory() as tmp:
            store = RePromptStore(tmp)
            store.save_settings({"provider": "offline_template", "hookAutoAll": False})
            env = {"REPROMPT_DATA_DIR": tmp, "TMPDIR": tmp, "WK_HOME": os.path.join(tmp, "wk-home")}

            self.assertEqual(self._run_hook(hook_script, {"prompt": "list files"}, env), {})

            res = self._run_hook(hook_script, {"prompt": "rp-refactor: split parser module"}, env)
            out = res.get("hookSpecificOutput", {})
            self.assertEqual(out.get("hookEventName"), "UserPromptSubmit")
            self.assertIn("## Goal", out.get("additionalContext", ""))
            # P2-272 (owner's spec): the owner's own message stays authoritative; never "Do NOT pause to ask".
            self.assertIn("stays authoritative", out.get("additionalContext", ""))
            self.assertNotIn("Do NOT pause", out.get("additionalContext", ""))
            self.assertTrue(res.get("systemMessage", "").startswith("✨ Re-prompted locally"))

            # P2-272 (canon): hookAutoAll is Antigravity's switch; Claude Code rewrites only on an rp: prefix,
            # never through agy, and leaves short replies and task reports alone.
            store.save_settings({"provider": "agy", "hookAutoAll": True})
            self.assertEqual(self._run_hook(hook_script, {"prompt": "ok"}, env), {})
            res_raw = self._run_hook(hook_script, {"prompt": "raw: just say hi"}, env)
            self.assertIn("raw marker", res_raw.get("hookSpecificOutput", {}).get("additionalContext", ""))
            self.assertEqual(res_raw.get("systemMessage"), "⚡ Raw · sent as typed")
            res_short = self._run_hook(hook_script, {"prompt": "fix login bug"}, env)
            self.assertNotIn("## Goal", res_short.get("hookSpecificOutput", {}).get("additionalContext", ""))
            task_turn = {"prompt": "<task-notification><status>completed</status></task-notification>"}
            self.assertEqual(self._run_hook(hook_script, task_turn, env), {})
            # Opt-in "always": long requests are rewritten, on the local template even though the provider is agy.
            store.save_settings({"claudeCodeRewrite": "always"})
            res_long = self._run_hook(hook_script, {"prompt": "please split the parser module into lexer and parser files"}, env)
            self.assertIn("## Goal", res_long.get("hookSpecificOutput", {}).get("additionalContext", ""))
            self.assertIn("locally", res_long.get("systemMessage", ""))

    def test_takeover_command_and_shared_handoff_hooks(self) -> None:
        import shutil
        agy_hook = ROOT / "scripts" / "reprompt_inline_hook.py"
        claude_hook = ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py"
        takeover_cli = ROOT.parent / "bin" / "wk-takeover.mjs"
        node_bin = os.environ.get("WK_NODE") or shutil.which("node") or "/opt/homebrew/bin/node"
        if not Path(node_bin).is_file() or not takeover_cli.is_file():
            self.skipTest("node or wk-takeover.mjs unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            data_dir = base / "data"
            wk_home = base / "wk"
            ws_dir = base / "shared-ws"
            data_dir.mkdir()
            wk_home.mkdir()
            ws_dir.mkdir()
            store = RePromptStore(data_dir)
            store.save_settings({"provider": "offline_template", "hookAutoAll": True})

            env = {
                "REPROMPT_DATA_DIR": str(data_dir),
                "PLUGIN_DATA": str(data_dir),
                "WK_HOME": str(wk_home),
            }

            # Publish a shared handoff from Antigravity -> Claude
            pub = subprocess.run(
                [
                    node_bin,
                    str(takeover_cli),
                    "publish",
                    "--cwd",
                    str(ws_dir),
                    "--from",
                    "antigravity",
                    "--to",
                    "claude",
                    "--title",
                    "Finish API router migration",
                    "--summary",
                    "Updated routes.py and verified 3 tests.",
                    "--next",
                    "Update client.ts to match /v2/routes.",
                ],
                env={**os.environ, **env},
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(pub.returncode, 0, pub.stderr)

            # 1. /wk-take-task in Claude Code UserPromptSubmit claims & injects takeover brief
            cc_take = self._run_hook(
                claude_hook,
                {"session_id": "cc-take-1", "cwd": str(ws_dir), "prompt": "/wk-take-task"},
                env,
            )
            cc_ctx = cc_take.get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn("[Watchkeeper /wk-take-task", cc_ctx)
            self.assertIn("Finish API router migration", cc_ctx)

            # 2. Publish fresh Claude -> Antigravity handoff and verify automatic pickup in Antigravity hook
            pub2 = subprocess.run(
                [
                    node_bin,
                    str(takeover_cli),
                    "publish",
                    "--cwd",
                    str(ws_dir),
                    "--from",
                    "claude",
                    "--to",
                    "antigravity",
                    "--title",
                    "Continue UI polish",
                    "--summary",
                    "Completed /v2/routes backend changes.",
                ],
                env={**os.environ, **env},
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(pub2.returncode, 0, pub2.stderr)

            agy_normal = self._run_hook(
                agy_hook,
                {"conversationId": "agy-take-1", "cwd": str(ws_dir), "lastUserInput": "continue styling the header"},
                env,
            )
            agy_sys = agy_normal["injectSteps"][0]["systemMessage"]["systemMessage"]
            self.assertIn("Shared Workspace Handoff from claude", agy_sys)
            self.assertIn("Continue UI polish", agy_sys)

            # 3. Publish another handoff and test explicit /wk-take-task in Antigravity PreInvocation hook
            subprocess.run(
                [
                    node_bin,
                    str(takeover_cli),
                    "publish",
                    "--cwd",
                    str(ws_dir),
                    "--from",
                    "claude",
                    "--to",
                    "antigravity",
                    "--title",
                    "Direct slash takeover",
                    "--summary",
                    "Ready for Antigravity.",
                ],
                env={**os.environ, **env},
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
            agy_slash = self._run_hook(
                agy_hook,
                {"conversationId": "agy-take-2", "cwd": str(ws_dir), "lastUserInput": "/wk-take-task"},
                env,
            )
            agy_slash_sys = agy_slash["injectSteps"][0]["systemMessage"]["systemMessage"]
            self.assertIn("[Watchkeeper /wk-take-task", agy_slash_sys)
            self.assertIn("Direct slash takeover", agy_slash_sys)

    def test_pasted_back_rewrite_is_never_rewritten_again(self) -> None:
        # P2-272: the loop guard knows the new "[Re-Prompt · <mode>]" header as well as the old "[Re-Prompt Inline]".
        import importlib.util

        def load(path: Path, name: str):
            spec = importlib.util.spec_from_file_location(name, path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod

        agy_hook = load(ROOT / "scripts" / "reprompt_inline_hook.py", "p2272_agy_inline_hook")
        claude_hook = load(ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py", "p2272_claude_inline_hook")
        pasted = [
            "rp: [Re-Prompt · balanced] Below is a structured version of the user's message.\nfix the login",
            "rp: [Re-Prompt Inline] fix the login",
        ]
        for mod in (agy_hook, claude_hook):
            for text in pasted:
                self.assertIsNone(mod.parse_inline_trigger(text, auto_all=True), (mod.__name__, text[:40]))
            self.assertIsNotNone(mod.parse_inline_trigger("rp: fix the login", auto_all=False), mod.__name__)


class WordRuleTests(unittest.TestCase):
    """P2-273 (owner, 24 Nov): a plain prompt of more than 30 words is re-prompted in Antigravity and Claude Code."""

    W31 = " ".join(["please", "split", "the", "parser", "module", "into", "lexer", "and", "parser", "files"] * 3 + ["now"])
    W30 = " ".join(W31.split()[:30])

    def _run(self, script: Path, payload: dict, env: dict) -> dict:
        proc = subprocess.run(
            [sys.executable, str(script)], input=json.dumps(payload), capture_output=True, text=True,
            env={**os.environ, **env}, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout.strip() or "{}")

    @staticmethod
    def _load(path: Path, name: str):
        import importlib.util

        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_counts(self) -> None:
        self.assertEqual(len(self.W31.split()), 31)
        self.assertEqual(len(self.W30.split()), 30)

    def test_defaults_turn_the_rule_on_and_every_prompt_off(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            s = RePromptStore(tmp).public_settings()
            self.assertEqual(s["autoRewriteOverWords"], 30)
            self.assertEqual(s["claudeCodeRewrite"], "words")
            self.assertFalse(s["hookAutoAll"])
            self.assertFalse(s["graphTurnContext"])  # quiet AST Graphify: per-turn graph context is opt-in
            store = RePromptStore(tmp)
            self.assertTrue(store.save_settings({"graphTurnContext": True})["graphTurnContext"])
            self.assertFalse(store.save_settings({"graphTurnContext": "yes"})["graphTurnContext"])
            self.assertEqual(store.save_settings({"autoRewriteOverWords": 0})["autoRewriteOverWords"], 0)
            self.assertEqual(store.save_settings({"autoRewriteOverWords": "x"})["autoRewriteOverWords"], 30)
            self.assertEqual(store.save_settings({"claudeCodeRewrite": "prefix"})["claudeCodeRewrite"], "prefix")

    def test_both_hooks_follow_the_shared_vectors(self) -> None:
        data = json.loads((ROOT.parent / "test" / "fixtures" / "prompt-prefix-vectors.json").read_text(encoding="utf-8"))
        agy = self._load(ROOT / "scripts" / "reprompt_inline_hook.py", "p2273_agy_hook")
        claude = self._load(ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py", "p2273_claude_hook")
        for case in data["word_cases"]:
            for mod in (agy, claude):
                with self.subTest(hook=mod.__name__, note=case["note"]):
                    got = mod.parse_inline_trigger(case["input"], over_words=data["auto_over_words"])
                    if case["auto"]:
                        self.assertEqual(got, (case["input"].strip(), None))
                    elif case["input"].lstrip().lower().startswith(("rp:",)):
                        self.assertIsNotNone(got)  # an explicit prefix is still a request
                    else:
                        self.assertIsNone(got)
        for mod in (agy, claude):
            self.assertIsNone(mod.parse_inline_trigger(self.W31), "the rule is off unless the hook passes over_words")
            self.assertIsNone(mod.parse_inline_trigger(self.W31, over_words=0))

    def test_antigravity_hook_rewrites_above_30_words(self) -> None:
        hook = ROOT / "scripts" / "reprompt_inline_hook.py"
        with tempfile.TemporaryDirectory() as tmp:
            store = RePromptStore(tmp)
            store.save_settings({"provider": "offline_template", "hookAutoAll": False})
            env = {"REPROMPT_DATA_DIR": tmp, "PLUGIN_DATA": tmp, "WK_HOME": os.path.join(tmp, "wk-home")}
            res = self._run(hook, {"conversationId": "w-31", "lastUserInput": self.W31}, env)
            step = res["injectSteps"][0]["systemMessage"]
            self.assertIn("[Re-Prompt ·", step["systemMessage"])
            self.assertTrue(step["metadata"]["user_markdown"].startswith("✨ Re-prompted · 31 words ·"), step["metadata"])
            self.assertNotIn("type", res["injectSteps"][0])
            self.assertEqual(store.load_routes()["w-31"]["trigger"], "words")
            self.assertEqual(self._run(hook, {"conversationId": "w-30", "lastUserInput": self.W30}, env), {})
            raw = self._run(hook, {"conversationId": "w-raw", "lastUserInput": "raw: " + self.W31 + " " + self.W31}, env)
            raw_msg = raw["injectSteps"][0]["systemMessage"]["systemMessage"]
            self.assertIn("Raw Mode", raw_msg)
            self.assertNotIn("structured version", raw_msg)
            self.assertEqual(store.load_routes()["w-raw"]["route"], "raw")
            self.assertEqual(self._run(hook, {"conversationId": "w-cmd", "lastUserInput": "/loop " + self.W31}, env), {})
            store.save_settings({"autoRewriteOverWords": 0})
            self.assertEqual(self._run(hook, {"conversationId": "w-off", "lastUserInput": self.W31}, env), {})

    def test_claude_hook_rewrites_above_30_words_by_default(self) -> None:
        hook = ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py"
        with tempfile.TemporaryDirectory() as tmp:
            store = RePromptStore(tmp)
            store.save_settings({"provider": "agy", "hookAutoAll": False})
            env = {"REPROMPT_DATA_DIR": tmp, "TMPDIR": tmp, "WK_HOME": os.path.join(tmp, "wk-home")}
            res = self._run(hook, {"prompt": self.W31, "session_id": "c-31"}, env)
            self.assertIn("## Goal", res.get("hookSpecificOutput", {}).get("additionalContext", ""))
            self.assertRegex(res.get("systemMessage", ""), r"^✨ Re-prompted locally in [0-9.]+ s · 31 words ·")
            res30 = self._run(hook, {"prompt": self.W30, "session_id": "c-30"}, env)
            self.assertNotIn("## Goal", res30.get("hookSpecificOutput", {}).get("additionalContext", ""))
            res_raw = self._run(hook, {"prompt": "raw: " + self.W31, "session_id": "c-raw"}, env)
            self.assertEqual(res_raw.get("systemMessage"), "⚡ Raw · sent as typed")
            self.assertEqual(self._run(hook, {"prompt": "<task-notification>" + self.W31, "session_id": "c-t"}, env), {})
            store.save_settings({"claudeCodeRewrite": "prefix"})
            res_p = self._run(hook, {"prompt": self.W31 + " again", "session_id": "c-p"}, env)
            self.assertNotIn("## Goal", res_p.get("hookSpecificOutput", {}).get("additionalContext", ""))
            store.save_settings({"claudeCodeRewrite": "words", "autoRewriteOverWords": 0})
            res_o = self._run(hook, {"prompt": self.W31 + " once more", "session_id": "c-o"}, env)
            self.assertNotIn("## Goal", res_o.get("hookSpecificOutput", {}).get("additionalContext", ""))


class PackagingAndCspTests(unittest.TestCase):
    def test_ui_html_has_no_external_csp_violations(self) -> None:
        html = (ROOT / "ui" / "reprompt_app.html").read_text(encoding="utf-8")
        self.assertNotRegex(html, r'<script[^>]+src\s*=')
        self.assertNotRegex(html, r'<link[^>]+href\s*=\s*["\']https?:')
        self.assertNotRegex(html, r'<form[\s>]')
        self.assertIn("ui/initialize", html)
        self.assertIn("acquireVsCodeApi", html)
        for dom_id in ("popOutBtn", "sendAgyNewBtn", "setOpenInWindow", "setHookAutoAll", "tabOrchBtn", "orchRunBtn"):
            self.assertIn(dom_id, html)
        self.assertIn("com.google.antigravity/message", html)

    def test_dist_packages_exist_and_valid(self) -> None:
        plugin_meta = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
        version = plugin_meta["version"]
        vsix = ROOT / "dist" / f"re-prompt-{version}.vsix"
        agy_zip = ROOT / "dist" / f"re-prompt-antigravity-plugin-{version}.zip"
        claude_zip = ROOT / "dist" / f"re-prompt-claude-plugin-{version}.zip"
        self.assertTrue(vsix.is_file(), f"Missing {vsix}")
        self.assertTrue(agy_zip.is_file(), f"Missing {agy_zip}")
        self.assertTrue(claude_zip.is_file(), f"Missing {claude_zip}")

        with zipfile.ZipFile(vsix, "r") as zf:
            names = set(zf.namelist())
            for req in (
                "[Content_Types].xml",
                "extension.vsixmanifest",
                "extension/package.json",
                "extension/extension.js",
                "extension/repromptEngine.js",
                "extension/orchestrator.js",
                "extension/media/icon.png",
                "extension/media/icon.svg",
                "extension/media/reprompt_app.html",
            ):
                self.assertIn(req, names)

        with zipfile.ZipFile(agy_zip, "r") as zf:
            names = set(zf.namelist())
            for req in (
                "plugin.json",
                "mcp_config.json",
                "hooks.json",
                "rules/AGENTS.md",
                "assets/logo.svg",
                "skills/re-prompt/SKILL.md",
                "skills/duo-orchestrator/SKILL.md",
                "skills/profession-skill-vault/SKILL.md",
                "scripts/reprompt_skill_hook.py",
                "scripts/reprompt_inline_hook.py",
                "scripts/orchestrate.py",
                "server/orchestrator.py",
                "server/reprompt_mcp_server.py",
                "ui/reprompt_app.html",
            ):
                self.assertIn(req, names)

        with zipfile.ZipFile(claude_zip, "r") as zf:
            names = set(zf.namelist())
            for req in (
                ".claude-plugin/plugin.json",
                ".mcp.json",
                "hooks/hooks.json",
                "bin/run-mcp.py",
                "bin/run-inline-hook.py",
                "commands/re-prompt.md",
                "commands/orchestrate.md",
                "scripts/orchestrate.py",
                "server/orchestrator.py",
                "server/reprompt_mcp_server.py",
                "ui/reprompt_app.html",
            ):
                self.assertIn(req, names)


if __name__ == "__main__":
    unittest.main()
