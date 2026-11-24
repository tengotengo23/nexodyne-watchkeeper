"""P2-278 API drive: the MCP tools ask_gemini and ask_claude run bin/wk-ask.mjs against a fake server on 127.0.0.1.
Temporary HOME, WK_HOME and WK_KEYS_DIR; a fake key only; no live network; nothing starts claude, agy or Antigravity.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for p in (ROOT, ROOT / "reprompt", ROOT / "reprompt" / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from server.reprompt_mcp_server import TOOLS, execute_tool  # noqa: E402

GEMINI_FAKE = "AIza" + "FAKE" + "x" * 31 + "g7Q2"
CLAUDE_FAKE = "sk-ant-" + "FAKE" + "-" + "y" * 40 + "c9Z1"


def _leaks(text: str) -> bool:
    return GEMINI_FAKE in text or CLAUDE_FAKE in text or "FAKExxxx" in text or "FAKE-yyyy" in text


class _Fake(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        _Fake.seen.append({"path": self.path, "key": self.headers.get("x-goog-api-key") or self.headers.get("x-api-key"), "body": body})
        if self.path == "/v1/messages":
            out = json.dumps({
                "content": [{"type": "text", "text": "Claude answers the MCP tool."}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 1000, "output_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            }).encode()
        else:
            out = json.dumps({
                "candidates": [{"content": {"parts": [{"text": "Gemini answers the MCP tool."}]}}],
                "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 200, "cachedContentTokenCount": 0},
            }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):  # quiet
        pass


class ApiDriveMcpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.host = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wk-p2278-py-")
        base = Path(os.path.realpath(self.tmp.name))
        self.home, self.keys, self.proj = base / "home", base / "keys", base / "proj"
        self.elsewhere = base / "elsewhere"
        (self.home / ".wk").mkdir(parents=True)
        (self.proj / ".git").mkdir(parents=True)
        self.elsewhere.mkdir()
        (self.proj / "notes.md").write_text("PROJECT-NOTE-7731\n")
        env = {
            "HOME": str(self.home), "WK_HOME": str(self.home / ".wk"), "WK_KEYS_DIR": str(self.keys),
            "WK_GEMINI_API_HOST": self.host, "WK_ANTHROPIC_API_HOST": self.host,
            "WK_CALLER": "claude_code", "CLAUDE_PROJECT_DIR": str(self.proj), "WK_API_RETRY_MS": "10",
        }
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        os.environ.pop("WK_WORKSPACE", None)
        self.cwd = os.getcwd()
        # the review's S1: the MCP server runs outside the project (as an IDE starts it); wk-ask must still run in the project
        os.chdir(self.elsewhere)

    def tearDown(self):
        os.chdir(self.cwd)
        self.env.stop()
        self.tmp.cleanup()

    def _save_key(self, name="gemini.key", key=GEMINI_FAKE):
        self.keys.mkdir(mode=0o700, exist_ok=True)
        f = self.keys / name
        f.write_text(key + "\n")
        f.chmod(0o600)

    def test_tools_are_listed(self):
        names = {t["name"] for t in TOOLS}
        self.assertIn("ask_gemini", names)
        self.assertIn("ask_claude", names)
        for t in TOOLS:
            if t["name"] in ("ask_gemini", "ask_claude"):
                self.assertIn("task", t["inputSchema"]["required"])
                # the AI never passes a key: no key field in the tool's input
                self.assertFalse({"key", "api_key", "apikey"} & set(t["inputSchema"]["properties"]))

    def test_ask_gemini_answers_with_the_cost_line_and_no_key(self):
        self._save_key()
        before = len(_Fake.seen)
        res = execute_tool(None, "ask_gemini", {"task": "Say hello from the MCP test."})
        self.assertFalse(res["isError"], res)
        text = res["content"][0]["text"]
        self.assertTrue(text.startswith("Gemini answers the MCP tool."), text)
        self.assertRegex(text, r"gemini-3\.5-flash-lite · 1000 in \(0 cached\) · 200 out · about US\$0\.0008 · today US\$0\.0008 of 2\.00")
        sc = res["structuredContent"]
        self.assertTrue(sc["ok"])
        self.assertEqual(sc["provider"], "gemini")
        self.assertEqual(len(_Fake.seen), before + 1)
        seen = _Fake.seen[-1]
        self.assertEqual(seen["path"], "/v1beta/models/gemini-3.5-flash-lite:generateContent")
        self.assertEqual(seen["key"], GEMINI_FAKE)
        self.assertEqual(seen["body"]["contents"][0]["parts"][-1]["text"], "Say hello from the MCP test.")
        self.assertFalse(_leaks(json.dumps(res)))
        usage = (self.home / ".wk" / "api-drive" / "usage.jsonl").read_text().strip().splitlines()
        line = json.loads(usage[-1])
        self.assertEqual((line["provider"], line["caller"], line["in"], line["out"]), ("gemini", "claude_code", 1000, 200))
        for f in (self.home / ".wk").rglob("*"):
            if f.is_file():
                self.assertFalse(_leaks(f.read_text(errors="replace")), str(f))

    def test_no_key_is_an_error_and_sends_nothing(self):
        before = len(_Fake.seen)
        res = execute_tool(None, "ask_gemini", {"task": "Say hello."})
        self.assertTrue(res["isError"])
        self.assertEqual(len(_Fake.seen), before)
        self.assertFalse(_leaks(json.dumps(res)))

    def test_runs_in_the_project_from_outside_it(self):
        # S1: a relative file name resolves against CLAUDE_PROJECT_DIR, not the server's own folder
        self._save_key()
        res = execute_tool(None, "ask_gemini", {"task": "Summarize.", "files": ["notes.md"]})
        self.assertFalse(res["isError"], res)
        self.assertIn("PROJECT-NOTE-7731", json.dumps(_Fake.seen[-1]["body"]))

    def test_workspace_root_is_used_without_claude_project_dir(self):
        self._save_key()
        os.environ.pop("CLAUDE_PROJECT_DIR")
        os.environ["WK_WORKSPACE"] = str(self.proj)
        res = execute_tool(None, "ask_gemini", {"task": "Summarize.", "files": ["notes.md"]})
        self.assertFalse(res["isError"], res)
        self.assertIn("PROJECT-NOTE-7731", json.dumps(_Fake.seen[-1]["body"]))

    def test_no_known_project_needs_a_project_argument(self):
        self._save_key()
        os.environ.pop("CLAUDE_PROJECT_DIR")
        before = len(_Fake.seen)
        res = execute_tool(None, "ask_gemini", {"task": "Say hello."})
        self.assertTrue(res["isError"])
        self.assertIn("project", res["content"][0]["text"])
        self.assertEqual(len(_Fake.seen), before)
        # a project argument that is a git root works
        res = execute_tool(None, "ask_gemini", {"task": "Summarize.", "files": ["notes.md"], "project": str(self.proj)})
        self.assertFalse(res["isError"], res)
        self.assertIn("PROJECT-NOTE-7731", json.dumps(_Fake.seen[-1]["body"]))
        # a folder that is not a git root is refused when the IDE names no project
        res = execute_tool(None, "ask_gemini", {"task": "Say hello.", "project": str(self.elsewhere)})
        self.assertTrue(res["isError"])

    def test_root_and_home_are_refused(self):
        self._save_key()
        before = len(_Fake.seen)
        for proj in ("/", str(self.home), "~", str(self.home).upper() if sys.platform == "darwin" else str(self.home)):
            res = execute_tool(None, "ask_gemini", {"task": "Say hello.", "project": proj})
            self.assertTrue(res["isError"], proj)
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.home)
        res = execute_tool(None, "ask_gemini", {"task": "Say hello."})
        self.assertTrue(res["isError"])
        os.environ["CLAUDE_PROJECT_DIR"] = "/"
        res = execute_tool(None, "ask_gemini", {"task": "Say hello."})
        self.assertTrue(res["isError"])
        self.assertEqual(len(_Fake.seen), before)

    def test_project_outside_the_open_project_is_refused(self):
        self._save_key()
        other = self.elsewhere / "other"
        (other / ".git").mkdir(parents=True)
        before = len(_Fake.seen)
        res = execute_tool(None, "ask_gemini", {"task": "Say hello.", "project": str(other)})
        self.assertTrue(res["isError"])
        self.assertEqual(len(_Fake.seen), before)

    def test_ask_claude_end_to_end_with_footer_and_no_key(self):
        self._save_key("anthropic.key", CLAUDE_FAKE)
        before = len(_Fake.seen)
        res = execute_tool(None, "ask_claude", {"task": "Review this plan.", "files": ["notes.md"]})
        self.assertFalse(res["isError"], res)
        text = res["content"][0]["text"]
        self.assertTrue(text.startswith("Claude answers the MCP tool."), text)
        self.assertRegex(text, r"claude-sonnet-5-5 · 1000 in \(0 cached\) · 200 out · about US\$0\.0040 · today US\$0\.0040 of 2\.00")
        self.assertEqual(res["structuredContent"]["provider"], "claude")
        self.assertEqual(len(_Fake.seen), before + 1)
        seen = _Fake.seen[-1]
        self.assertEqual(seen["path"], "/v1/messages")
        self.assertEqual(seen["key"], CLAUDE_FAKE)
        self.assertIn("PROJECT-NOTE-7731", json.dumps(seen["body"]))
        self.assertFalse(_leaks(json.dumps(res)))
        for f in (self.home / ".wk").rglob("*"):
            if f.is_file():
                self.assertFalse(_leaks(f.read_text(errors="replace")), str(f))

    def test_missing_task_is_refused(self):
        res = execute_tool(None, "ask_claude", {"task": "  "})
        self.assertTrue(res["isError"])
        self.assertIn("task", res["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
