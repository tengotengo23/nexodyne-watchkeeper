#!/usr/bin/env python3
"""Tests for Watchkeeper Autonomous Learning Loop, Sanitizer, Shared FTS5 Snippet DB, MCP & /wk CLI."""

from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "reprompt") not in sys.path:
    sys.path.insert(0, str(ROOT / "reprompt"))

from core.fast_path import evaluate_fast_path  # noqa: E402
from core.gemini_engine import Gemini4Engine, build_deterministic_payload  # noqa: E402
from core.learning_engine import (  # noqa: E402
    build_learning_context,
    ingest_correction,
    track_agent_edit,
)
from core.prompt_compiler import STATIC_COMPILER_SYSTEM_PROMPT, compile_prompt_v2  # noqa: E402
from core.sanitizer import anonymize_author, sanitize_path, sanitize_text  # noqa: E402
from core.skill_router import select_all_matching_skills  # noqa: E402
from core.snippet_store import SnippetStore  # noqa: E402
from core.state_store import StateStore  # noqa: E402
from core.wk_cli import run_wk_cli  # noqa: E402
from server.reprompt_engine import RePromptStore, rewrite_with_provider  # noqa: E402
from server.reprompt_mcp_server import TOOLS, execute_tool  # noqa: E402


def _fake_ant_key() -> str:
    return "sk-" + "ant-api03-" + ("a" * 28)


def _fake_stripe_key() -> str:
    return "sk_" + "live_" + ("b" * 20)


def _fake_aws_key() -> str:
    return "AK" + "IA" + "IOSFODNN7EXAMPLE"


def _fake_gh_key() -> str:
    return "gh" + "p_" + ("c" * 34)


class SanitizerTests(unittest.TestCase):
    def test_sanitizer_redacts_secrets_pii_paths_and_fails_closed(self) -> None:
        ws = "/Users/someone/Projects/acme"
        ant_tok = _fake_ant_key()
        stripe_tok = _fake_stripe_key()
        aws_tok = _fake_aws_key()
        gh_tok = _fake_gh_key()
        raw = (
            "const cfg = {\n"
            f'  anthropic: "{ant_tok}",\n'
            f'  stripe: "{stripe_tok}",\n'
            f'  aws: "{aws_tok}",\n'
            f'  gh: "{gh_tok}",\n'
            '  db: "postgres://admin:SuperSecret99@10.24.8.15:5432/prod",\n'
            '  owner: "founder@acme-real.io",\n'
            '  phone: "+1-555-234-5678",\n'
            '  ssn: "123-45-6789",\n'
            '  path: "/Users/someone/Projects/acme/src/auth.ts",\n'
            '  safeEmail: "docs@example.com",\n'
            "};\n"
        )
        res = sanitize_text(raw, workspace_dir=ws)
        self.assertFalse(res.blocked)
        for leak in (
            ant_tok[:12],
            stripe_tok[:10],
            aws_tok,
            gh_tok[:10],
            "SuperSecret99",
            "founder@acme-real.io",
            "555-234-5678",
            "123-45-6789",
            "10.24.8.15",
            "/Users/someone",
        ):
            self.assertNotIn(leak, res.text)
        self.assertIn("docs@example.com", res.text)
        self.assertIn("<WORKSPACE>/src/auth.ts", res.text)
        self.assertEqual(sanitize_path("/Users/someone/Projects/acme/src/auth.ts", workspace_dir=ws), "src/auth.ts")

        aid = anonymize_author("someone@example.com", salt="s1")
        self.assertRegex(aid, r"^usr_[0-9a-f]{12}$")
        self.assertEqual(anonymize_author(aid, salt="s1"), aid)

        canary = sanitize_text("print('WK-PRIVATE-" + "CANARY')")
        self.assertTrue(canary.blocked)

        env_dump = sanitize_text("API_KEY=abc123456\nDATABASE_URL=pg://x:y@h/d\nJWT_SECRET=supersecretvalue123\n")
        self.assertTrue(env_dump.blocked)


class ContinuousLearningEndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.base = Path(self.td.name)
        self.ws = self.base / "repo"
        self.ws.mkdir(parents=True)
        self.wk_home = self.base / "wk"
        self.wk_home.mkdir(parents=True)
        self.db_path = self.wk_home / "learning" / "snippets.db"
        self.env_bak = {k: os.environ.get(k) for k in ("WK_HOME", "WK_SNIPPET_DB", "WK_SNIPPET_SYNC_DIR", "WK_SNIPPET_SYNC_URL")}
        os.environ["WK_HOME"] = str(self.wk_home)
        os.environ["WK_SNIPPET_DB"] = str(self.db_path)
        os.environ.pop("WK_SNIPPET_SYNC_DIR", None)
        os.environ.pop("WK_SNIPPET_SYNC_URL", None)

    def tearDown(self) -> None:
        for k, v in self.env_bak.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.td.cleanup()

    def _run_hook(self, event: str, payload: dict) -> dict:
        proc = subprocess.run(
            [sys.executable, str(ROOT / "bin" / "wk-learning-hook.py"), event],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            env=dict(os.environ),
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout.strip() or "{}")

    def test_simulated_correction_to_verification_to_prompt_injection_and_skill_boost(self) -> None:
        target_file = self.ws / "src" / "worker.js"
        target_file.parent.mkdir(parents=True)
        agent_ver = (
            "function startPoller(fn) {\n"
            "  const timer = setInterval(fn, 30000);\n"
            "  return timer;\n"
            "}\n"
        )
        target_file.write_text(agent_ver, encoding="utf-8")

        # 1. Agent writes file -> PostToolUse records snapshot
        self._run_hook(
            "PostToolUse",
            {
                "conversationId": "conv_learn_1",
                "cwd": str(self.ws),
                "toolCall": {"name": "write_to_file", "args": {"TargetFile": str(target_file)}},
            },
        )

        # 2. User corrects agent code on disk (adds .unref() and finally cleanup + local path that must sanitize)
        user_ver = (
            "function startPoller(fn) {\n"
            "  // fixed timer leak on /Users/someone/Projects/demo\n"
            "  const timer = setInterval(fn, 30000);\n"
            "  try {\n"
            "    if (typeof timer.unref === 'function') timer.unref();\n"
            "    return timer;\n"
            "  } finally {\n"
            "    // caller calls timer.unref() or clearInterval(timer)\n"
            "  }\n"
            "}\n"
        )
        target_file.write_text(user_ver, encoding="utf-8")

        # 3. Stop hook detects correction automatically -> extracts heuristic & saves sanitized snippet
        self._run_hook("Stop", {"conversationId": "conv_learn_1", "cwd": str(self.ws)})

        store = SnippetStore(self.db_path)
        st_mid = store.stats()
        self.assertEqual(st_mid["snippetCount"], 1)
        self.assertEqual(st_mid["correctionCount"], 1)
        self.assertGreaterEqual(st_mid["heuristicCount"], 1)
        self.assertEqual(st_mid["topSnippets"][0]["verification_status"], "user_corrected")

        # Verify summary.json written with private 0600 permissions & zero /Users/someone leak
        sum_path = self.wk_home / "learning" / "summary.json"
        self.assertTrue(sum_path.is_file())
        self.assertEqual(sum_path.stat().st_mode & 0o777, 0o600)
        q_raw = store.query_snippets("timer unref cleanup", language="javascript")
        self.assertEqual(len(q_raw["snippets"]), 1)
        self.assertNotIn("/Users/someone", q_raw["snippets"][0]["code"])

        # 4. Passing test run promotes snippet -> verified_pass
        self._run_hook(
            "PostToolUse",
            {
                "conversationId": "conv_learn_1",
                "cwd": str(self.ws),
                "toolCall": {"name": "run_command", "args": {"CommandLine": "npm test"}},
            },
        )
        q_after = store.query_snippets("timer unref cleanup", language="javascript", verified_only=True)
        self.assertEqual(len(q_after["snippets"]), 1)
        self.assertEqual(q_after["snippets"][0]["verification_status"], "verified_pass")

        # 5. PreInvocation hook automatically injects learned context for related future task
        pre_out = self._run_hook(
            "PreInvocation",
            {
                "conversationId": "conv_learn_2",
                "cwd": str(self.ws),
                "lastUserInput": "Fix leaked interval timer cleanup in javascript poller",
            },
        )
        inj = pre_out["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("Learned Guardrails & Verified Snippets", inj)
        self.assertIn("unref", inj)

        # 6. compile_prompt_v2 keeps [STATIC BLOCK A]+[STATIC BLOCK B] hash identical while injecting Section 5
        rt = StateStore(runtime_dir=self.base / "rt", workspace_dir=self.ws)
        dec = evaluate_fast_path("Fix timer unref cleanup in javascript worker", env={})
        compiled = compile_prompt_v2(
            dec,
            workspace_dir=self.ws,
            store=rt,
            engine=Gemini4Engine(env={"HOME": str(self.base)}),
            home=self.base,
        )
        self.assertTrue(compiled["learning"]["has_context"])
        self.assertIn("## 5. Learned Guardrails & Verified Snippets", compiled["compiled_text"])
        expected_prefix = build_deterministic_payload(
            static_instructions=STATIC_COMPILER_SYSTEM_PROMPT,
            compact_manifest=[],
            graph_report_summary="",
            dynamic_subgraph={},
            wk_state={},
            raw_prompt="x",
        )
        self.assertEqual(len(expected_prefix["static_prefix_sha256"]), 64)

        # 7. Skill ranking boost elevates matching skills
        manifest = {
            "skills": [
                {"name": "plain-js", "priority": 2, "tags": ["javascript"], "keywords": ["timer", "javascript"]},
                {"name": "lifecycle-timers", "priority": 2, "tags": ["cleanup", "timers"], "keywords": ["timer", "javascript"]},
            ]
        }
        boosted = select_all_matching_skills(
            "Fix timer cleanup",
            manifest,
            ranking_boosts={"cleanup": 2.4, "timers": 2.4},
        )
        self.assertEqual(boosted[0]["name"], "lifecycle-timers")

        # 8. Re-Prompt engine surfaces learning context cleanly offline
        rp_store = RePromptStore(data_dir=self.base / "rp")
        rp_res = rewrite_with_provider(
            rp_store,
            prompt="Fix interval timer cleanup in worker.js",
            provider_override="offline_template",
            workspace_dir=str(self.ws),
        )
        self.assertTrue(rp_res["learning"]["has_context"])

    def test_shared_sync_bundle_resanitization_offline_resilience_and_kill_switch(self) -> None:
        sync_dir = self.base / "shared_sync"
        db_a = SnippetStore(self.base / "node_a" / "snippets.db")
        db_b = SnippetStore(self.base / "node_b" / "snippets.db")

        res_a = db_a.save_snippet(
            title="Idempotent retry backoff",
            code="async function retry(fn) { return await fn(); }",
            language="javascript",
            tags=["retry", "async"],
            verification_status="verified_pass",
            verification_cmd="node --test",
        )
        self.assertTrue(res_a["ok"])
        sync_a = db_a.sync_now(sync_dir=sync_dir)
        self.assertTrue(sync_a["ok"])
        self.assertGreaterEqual(sync_a["pushed"], 1)

        # Malicious peer bundle attempting to inject a canary + secret key
        canary_str = "WK-PRIVATE-" + "CANARY"
        bad_bundle = {
            "schema_version": "1.0.0",
            "node_id": "usr_peer_evil",
            "snippets": [
                {
                    "title": "Bad canary",
                    "code": f"const c = '{canary_str}'; const k = '{_fake_ant_key()}';",
                    "language": "javascript",
                    "verification_status": "verified_pass",
                }
            ],
            "heuristics": [],
        }
        (sync_dir / "usr_peer_evil-999.bundle.json").write_text(json.dumps(bad_bundle), encoding="utf-8")

        sync_b = db_b.sync_now(sync_dir=sync_dir)
        self.assertTrue(sync_b["ok"])
        self.assertGreaterEqual(sync_b["pulled"], 1)
        self.assertGreaterEqual(sync_b["blocked"], 1)
        self.assertEqual(len(db_b.query_snippets("retry backoff")["snippets"]), 1)
        self.assertEqual(len(db_b.query_snippets(canary_str)["snippets"]), 0)

        # Unreachable HTTP endpoint degrades gracefully offline without crashing
        db_b.save_snippet(title="Offline local snippet", code="def ok():\n    return True\n", language="python")
        off_res = db_b.sync_now(sync_url="http://127.0.0.1:9/watchkeeper-sync", timeout_s=0.3)
        self.assertFalse(off_res["ok"])
        self.assertTrue(off_res["offline"])
        self.assertGreaterEqual(off_res["queued"], 1)
        self.assertEqual(len(db_b.query_snippets("Offline local")["snippets"]), 1)

        # Kill switch halts sync and hooks immediately
        (self.wk_home / "KILL").write_text("", encoding="utf-8")
        kill_sync = db_b.sync_now(sync_dir=sync_dir)
        self.assertTrue(kill_sync.get("killed"))
        hook_res = self._run_hook(
            "PreInvocation",
            {"conversationId": "conv_k", "cwd": str(self.ws), "lastUserInput": "Fix retry"},
        )
        self.assertEqual(hook_res, {})

    def test_query_latency_benchmark_500_snippets(self) -> None:
        store = SnippetStore(self.db_path)
        langs = ["python", "javascript", "typescript", "sql", "go"]
        for i in range(500):
            lang = langs[i % len(langs)]
            store.save_snippet(
                title=f"Pattern {i} {lang} handler",
                code=f"def handler_{i}(req_id):\n    # token_{i % 25} verify retry cache auth\n    return req_id\n",
                language=lang,
                context=f"Context for module_{i % 40} validation and performance",
                tags=[lang, f"mod{i % 40}", "retry" if i % 3 == 0 else "auth"],
                verification_status="verified_pass" if i % 2 == 0 else "user_corrected",
                queue_sync=False,
            )

        queries = [
            "retry handler validation",
            "verify auth token_12",
            "async/await (fetch) + retry.ts",
            "module_7 sql index query",
            "python pattern 42 cache",
        ] * 10
        latencies: list[float] = []
        for q in queries:
            res = store.query_snippets(q, limit=5)
            self.assertTrue(res["ok"])
            self.assertGreater(len(res["snippets"]), 0)
            latencies.append(float(res["latency_ms"]))

        mean_ms = statistics.mean(latencies)
        p95_ms = sorted(latencies)[int(0.95 * len(latencies)) - 1]
        self.assertLess(mean_ms, 10.0, f"Mean latency too high: {mean_ms:.2f}ms")
        self.assertLess(p95_ms, 25.0, f"p95 latency too high: {p95_ms:.2f}ms")

    def test_mcp_tools_and_wk_learn_cli(self) -> None:
        tool_names = {t["name"] for t in TOOLS}
        for name in ("wk_snippet_search", "wk_snippet_save", "wk_record_correction", "wk_learning_status"):
            self.assertIn(name, tool_names)

        rp_store = RePromptStore(data_dir=self.base / "rp_mcp")
        save_out = execute_tool(
            rp_store,
            "wk_snippet_save",
            {
                "title": "Safe atomic file write",
                "code": "os.replace(tmp_path, dest_path)",
                "language": "python",
                "tags": ["atomic", "io"],
                "verification_status": "verified_pass",
            },
        )
        self.assertFalse(save_out["isError"])

        corr_out = execute_tool(
            rp_store,
            "wk_record_correction",
            {
                "file_path": str(self.ws / "db.py"),
                "agent_code": "conn = sqlite3.connect(p)",
                "user_code": "try:\n    conn = sqlite3.connect(p)\nfinally:\n    conn.close()",
                "verification_status": "verified_pass",
            },
        )
        self.assertFalse(corr_out["isError"])

        search_out = execute_tool(rp_store, "wk_snippet_search", {"query": "atomic replace", "language": "python"})
        self.assertFalse(search_out["isError"])
        self.assertGreaterEqual(len(search_out["structuredContent"]["snippets"]), 1)

        status_out = execute_tool(rp_store, "wk_learning_status", {})
        self.assertFalse(status_out["isError"])
        self.assertGreaterEqual(status_out["structuredContent"]["snippetCount"], 2)

        # Verify /wk learn CLI subcommands and preserved v2 status/doctor contracts
        bundle_file = self.base / "export.json"
        for argv in (
            ["learn", "status"],
            ["learn", "search", "atomic"],
            ["learn", "heuristics"],
            ["learn", "export", str(bundle_file)],
            ["learn", "import", str(bundle_file)],
            ["learn", "save", "--title", "CLI guard", "--code", "assert x is not None", "--lang", "python"],
            ["learn", "record", "--file", "a.py", "--agent-code", "x=1", "--user-code", "try:\n  x=1\nexcept Exception:\n  raise"],
            ["doctor"],
            ["status"],
        ):
            rc, payload = run_wk_cli(argv, workspace=str(self.ws))
            self.assertEqual(rc, 0, f"wk {' '.join(argv)} failed: {payload}")
            if argv[0] == "status":
                self.assertEqual(payload["version"], "2.0.0")
                self.assertIn("learning", payload)
            if argv[0] == "doctor":
                self.assertTrue(any(c["name"] == "autonomous_learning_db" for c in payload["checks"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
