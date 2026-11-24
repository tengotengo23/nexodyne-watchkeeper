"""P2-272: the Gemini canon guard, one model call inside a hook's time budget, and no double rewrite in Claude Code.

Canon: Watchkeeper never calls Google's Gemini service from Claude (the Claude Code hook, or any process Claude
started). The owner's own terminal and Antigravity keep their behaviour. Every test here is offline: the network
function is replaced and checked, and only fake keys are used.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import core.gemini_engine as ge  # noqa: E402
from core.fast_path import evaluate_fast_path  # noqa: E402
from core.gemini_engine import GEMINI_CANON_MESSAGE, MODEL_CARBON, Gemini4Engine, gemini_blocked_for_claude  # noqa: E402
from core.hook_bus import handle_event  # noqa: E402
from core.prompt_compiler import compile_prompt_v2  # noqa: E402
from core.state_store import StateStore  # noqa: E402

CLAUDE_MARKERS = ("CLAUDECODE", "WK_CALLER")
KEY_NAMES = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "WATCHKEEPER_GEMINI_API_KEY")
FAKE_KEY = "fake-key-for-tests"


def owner_env(**extra: str) -> dict[str, str]:
    """os.environ as in the owner's own terminal: no Claude markers and no Gemini keys, plus `extra`."""
    env = {k: v for k, v in os.environ.items() if k not in CLAUDE_MARKERS + KEY_NAMES}
    env.update(extra)
    return env


class FakeRestResponse:
    def __init__(self, text: str) -> None:
        self._raw = json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]}).encode("utf-8")

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> "FakeRestResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class GeminiCanonGuardTests(unittest.TestCase):
    def test_rule_cases(self) -> None:
        with mock.patch.dict(os.environ, owner_env(), clear=True):
            self.assertFalse(gemini_blocked_for_claude({}))
            self.assertFalse(gemini_blocked_for_claude(None))
            self.assertTrue(gemini_blocked_for_claude({"WK_CALLER": "claude_code"}))
            self.assertTrue(gemini_blocked_for_claude({"WK_CALLER": " Claude_Code "}))
            self.assertTrue(gemini_blocked_for_claude({"CLAUDECODE": "1"}))
        with mock.patch.dict(os.environ, owner_env(CLAUDECODE="1"), clear=True):
            # A process Claude started stays blocked even when the engine is handed a clean env.
            self.assertTrue(gemini_blocked_for_claude({"HOME": "/nonexistent"}))

    def test_refuses_under_claude_before_any_key_is_read(self) -> None:
        cases = (
            (owner_env(CLAUDECODE="1"), {"HOME": "/nonexistent", "GEMINI_API_KEY": FAKE_KEY}),
            (owner_env(), {"HOME": "/nonexistent", "WK_CALLER": "claude_code", "GEMINI_API_KEY": FAKE_KEY}),
        )
        for os_env, engine_env in cases:
            with mock.patch.dict(os.environ, os_env, clear=True), \
                    mock.patch.object(ge, "resolve_gemini_credentials", side_effect=AssertionError("key read")) as creds, \
                    mock.patch("urllib.request.urlopen") as net:
                out = Gemini4Engine(env=engine_env).generate(prompt_payload="refactor engine")
            creds.assert_not_called()
            net.assert_not_called()
            self.assertFalse(out["ok"])
            self.assertTrue(out["canon_blocked"])
            self.assertEqual(out["backend"], "offline-local")
            self.assertEqual(out["fallback"], "offline-local")
            self.assertEqual(out["key_source"], "not-read")
            self.assertEqual(out["error"], GEMINI_CANON_MESSAGE)

    def test_injected_client_still_works_under_claude(self) -> None:
        class FakeClient:
            class models:
                @staticmethod
                def generate_content(*, model: str, contents: str, config: object) -> object:
                    return types.SimpleNamespace(text='{"objective": "ok"}', candidates=[])

        with mock.patch.dict(os.environ, owner_env(CLAUDECODE="1"), clear=True):
            eng = Gemini4Engine(env={"WK_CALLER": "claude_code"}, client_factory=lambda **_kw: FakeClient())
            out = eng.generate(prompt_payload="x")
        self.assertTrue(out["ok"])
        self.assertNotIn("canon_blocked", out)

    def test_owner_terminal_unchanged_one_rest_call_with_the_given_timeout(self) -> None:
        timeouts: list[float] = []

        def fake_urlopen(req: object, timeout: float | None = None) -> FakeRestResponse:
            timeouts.append(timeout)
            return FakeRestResponse('{"objective": "ok"}')

        with mock.patch.dict(os.environ, owner_env(), clear=True), \
                mock.patch.object(ge, "_try_import_genai", return_value=None), \
                mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            eng = Gemini4Engine(env={"HOME": "/nonexistent", "GEMINI_API_KEY": FAKE_KEY})
            out = eng.generate(prompt_payload="x", timeout_s=12.5, max_attempts=1)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["backend"], "gemini-4-rest")
        self.assertEqual(timeouts, [12.5])

    def test_max_attempts_limits_the_retry_chain(self) -> None:
        calls: list[str] = []

        class FlakyClient:
            class models:
                @staticmethod
                def generate_content(*, model: str, contents: str, config: object) -> object:
                    calls.append(model)
                    raise RuntimeError("429 Too Many Requests overloaded")

        eng = Gemini4Engine(env={}, client_factory=lambda **_kw: FlakyClient())
        with mock.patch.object(ge.time, "sleep"):
            one = eng.generate(prompt_payload="x", model=MODEL_CARBON, max_attempts=1)
            self.assertFalse(one["ok"])
            self.assertEqual(len(calls), 1)
            calls.clear()
            chain = eng.generate(prompt_payload="x", model=MODEL_CARBON)
        self.assertFalse(chain["ok"])
        self.assertEqual(len(calls), 3)  # outside hooks the default chain is unchanged

    def test_sdk_client_gets_the_timeout_and_a_hook_call_makes_one_request(self) -> None:
        seen: dict[str, object] = {"kwargs": None, "calls": 0}

        class FakeSdkClient:
            def __init__(self, **kwargs: object) -> None:
                seen["kwargs"] = kwargs
                self.models = self

            def generate_content(self, *, model: str, contents: str, config: object) -> object:
                seen["calls"] = int(seen["calls"]) + 1
                return types.SimpleNamespace(text="partial", candidates=[types.SimpleNamespace(finish_reason="MAX_TOKENS")])

        class OldSdkClient:
            def __init__(self, api_key: str) -> None:  # an SDK without http_options still works
                self.models = self

            def generate_content(self, *, model: str, contents: str, config: object) -> object:
                return types.SimpleNamespace(text="ok", candidates=[])

        with mock.patch.dict(os.environ, owner_env(), clear=True), \
                mock.patch("urllib.request.urlopen") as net:
            eng = Gemini4Engine(env={"HOME": "/nonexistent", "GEMINI_API_KEY": FAKE_KEY})
            with mock.patch.object(ge, "_try_import_genai", return_value=types.SimpleNamespace(Client=FakeSdkClient)):
                out = eng.generate(prompt_payload="x", timeout_s=12.0, max_attempts=1)
            with mock.patch.object(ge, "_try_import_genai", return_value=types.SimpleNamespace(Client=OldSdkClient)):
                old = eng.generate(prompt_payload="x", timeout_s=12.0, max_attempts=1)
        net.assert_not_called()
        self.assertTrue(out["ok"])
        self.assertEqual(seen["kwargs"], {"api_key": FAKE_KEY, "http_options": {"timeout": 12000}})
        self.assertEqual(seen["calls"], 1)  # no continuation request inside a hook's budget
        self.assertTrue(old["ok"])


class SpyEngine(Gemini4Engine):
    def __init__(self) -> None:
        super().__init__(env={})
        self.calls: list[dict[str, object]] = []

    def generate(self, **kwargs: object) -> dict[str, object]:  # type: ignore[override]
        self.calls.append(kwargs)
        return {"ok": False, "fallback": "offline-local", "backend": "offline-local", "text": "", "error": "spy"}


class CompilerHookBudgetTests(unittest.TestCase):
    def _compile(self, td: str, eng: Gemini4Engine, **kw: object) -> dict[str, object]:
        ws = Path(td) / "ws"
        ws.mkdir()
        (ws / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")
        store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
        dec = evaluate_fast_path("Refactor app entrypoint with tests", env={})
        with mock.patch.dict(os.environ, owner_env(WK_GRAPHIFY_DEFAULT="0", HOME=td), clear=True):
            return compile_prompt_v2(dec, workspace_dir=ws, store=store, engine=eng, home=Path(td), **kw)

    def test_one_attempt_with_a_timeout_inside_the_budget(self) -> None:
        eng = SpyEngine()
        with tempfile.TemporaryDirectory() as td:
            res = self._compile(td, eng)
        self.assertTrue(res["ok"])
        self.assertEqual(len(eng.calls), 1)
        self.assertEqual(eng.calls[0]["max_attempts"], 1)
        self.assertGreaterEqual(float(eng.calls[0]["timeout_s"]), 3.0)
        self.assertLessEqual(float(eng.calls[0]["timeout_s"]), 25.0)

    def test_no_model_call_when_the_budget_is_used_up(self) -> None:
        eng = SpyEngine()
        with tempfile.TemporaryDirectory() as td:
            res = self._compile(td, eng, hook_budget_s=12.0)  # 12 s minus 10 s headroom leaves under 3 s
        self.assertEqual(eng.calls, [])
        self.assertTrue(res["ok"])
        self.assertEqual(res["backend"], "offline-local")
        self.assertIn("[WK-SPEC-V2:", res["compiled_text"])


class HookBusNoDoubleRewriteTests(unittest.TestCase):
    PROMPT = "Implement API rate limiter with unit tests"

    def _run(self, td: str, event: str, payload: dict[str, object], *, settings_hook: bool, with_key: bool = True) -> tuple[str, list[dict], mock.MagicMock]:
        home = Path(td) / "home"
        (home / ".claude").mkdir(parents=True)
        if settings_hook:
            cmd = 'REPROMPT_DATA_DIR="$HOME/x" /usr/bin/python3 "/x/reprompt/claude-code-plugin/bin/run-inline-hook.py"'
            settings = {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": cmd}]}]}}
            (home / ".claude" / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
        ws = Path(td) / "ws"
        ws.mkdir()
        (ws / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")
        store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
        engine_envs: list[dict] = []

        def spy_engine(*args: object, **kwargs: object) -> Gemini4Engine:
            engine_envs.append(dict(kwargs.get("env") or {}))
            return Gemini4Engine(*args, **kwargs)

        # With a fake key, the engine would try the network here unless the canon marking stops it.
        env = owner_env(HOME=str(home), WK_HOME=str(Path(td) / "wkhome"), WK_GRAPHIFY_DEFAULT="0")
        if with_key:
            env["GEMINI_API_KEY"] = FAKE_KEY
        env.pop("WK_HOST", None)
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("core.hook_bus.Gemini4Engine", side_effect=spy_engine), \
                mock.patch.object(ge, "_try_import_genai", return_value=None), \
                mock.patch("urllib.request.urlopen") as net:
            rc, out, _ = handle_event(event, json.dumps({**payload, "cwd": str(ws)}), store=store, bypass_subprocesses=True)
        self.assertEqual(rc, 0)
        return out, engine_envs, net

    def test_claude_code_inline_prompt_is_left_to_the_settings_hook(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out, engine_envs, net = self._run(td, "UserPromptSubmit", {"session_id": "s1", "prompt": self.PROMPT}, settings_hook=True)
        self.assertEqual(json.loads(out), {})
        self.assertEqual(engine_envs, [])  # nothing compiled, so nothing could reach Gemini
        net.assert_not_called()

    def test_claude_code_reprompt_command_stays_with_the_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out, engine_envs, net = self._run(td, "UserPromptSubmit", {"session_id": "s2", "prompt": "/reprompt Build OAuth PKCE proxy"}, settings_hook=True)
        self.assertIn("STANDALONE `/reprompt` MODE ACTIVE", out)
        self.assertEqual([e.get("WK_CALLER") for e in engine_envs], ["claude_code"])
        net.assert_not_called()

    def test_claude_code_without_the_settings_hook_compiles_locally_never_gemini(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out, engine_envs, net = self._run(td, "UserPromptSubmit", {"session_id": "s3", "prompt": self.PROMPT}, settings_hook=False)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertRegex(ctx, r"\[WK-SPEC-V2:[0-9a-f]{12}\]")
        self.assertEqual([e.get("WK_CALLER") for e in engine_envs], ["claude_code"])
        net.assert_not_called()

    def test_antigravity_prompt_is_not_deferred(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            # No key here: Antigravity keeps its own Gemini path, which an offline test must not exercise.
            out, engine_envs, net = self._run(
                td, "PreInvocation", {"conversationId": "c1", "lastUserInput": self.PROMPT}, settings_hook=True, with_key=False
            )
        self.assertIn("injectSteps", json.loads(out))
        self.assertEqual(engine_envs, [])  # no Claude marking on the Antigravity path
        net.assert_not_called()


if __name__ == "__main__":
    unittest.main()
