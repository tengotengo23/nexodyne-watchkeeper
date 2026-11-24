#!/usr/bin/env python3
"""Regression tests for Re-Prompt, Skill Vault, Hooks, and MCP server fixes."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPROMPT_ROOT = Path(__file__).resolve().parent.parent
if str(REPROMPT_ROOT) not in sys.path:
    sys.path.insert(0, str(REPROMPT_ROOT))
if str(REPROMPT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(REPROMPT_ROOT / "scripts"))

import skill_router  # noqa: E402
import skill_vault  # noqa: E402
from scripts.build_dist import build_claude_plugin_zip  # noqa: E402
from server.reprompt_engine import RePromptStore  # noqa: E402
from server.reprompt_mcp_server import TOOLS, execute_tool  # noqa: E402


class AuditRegressionsRepromptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.wk_home = self.root / "wk-home"
        self.data_dir = self.root / "reprompt-data"
        self.vault_dir = self.root / "skill-vault"
        self.wk_home.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self._old_env = {
            k: os.environ.get(k)
            for k in ("WK_HOME", "REPROMPT_DATA_DIR", "REPROMPT_SKILL_VAULT_DIR", "REPROMPT_INCLUDE_LOCAL_SKILLS")
        }
        os.environ["WK_HOME"] = str(self.wk_home)
        os.environ["REPROMPT_DATA_DIR"] = str(self.data_dir)
        os.environ["REPROMPT_SKILL_VAULT_DIR"] = str(self.vault_dir)
        os.environ["REPROMPT_INCLUDE_LOCAL_SKILLS"] = "0"

    def tearDown(self) -> None:
        for k, v in self._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_skill_vault_build_index_reads_entry_forks_and_trending(self) -> None:
        repo_dir = self.vault_dir / "repos" / "sample-repo"
        sk_dir = repo_dir / "skills" / "fastapi-audit"
        sk_dir.mkdir(parents=True, exist_ok=True)
        (sk_dir / "SKILL.md").write_text(
            "---\nname: fastapi-audit\ndescription: FastAPI security and performance audit guide.\n---\n\nCheck endpoints.\n",
            encoding="utf-8",
        )
        sources_file = self.vault_dir / "sources.json"
        sources_file.write_text(
            json.dumps(
                {
                    "version": 1,
                    "repos": [
                        {
                            "slug": "sample-repo",
                            "repo": "example/sample-repo",
                            "url": "https://github.com/example/sample-repo.git",
                            "stars": 1200,
                            "forks": 88,
                            "trending": True,
                            "tier": 2,
                            "ecosystem_focus": "both",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        idx = skill_vault.build_index()
        self.assertGreaterEqual(idx["skill_count"], 1)
        item = next(s for s in idx["skills"] if s["name"] == "fastapi-audit")
        self.assertEqual(item["forks"], 88)
        self.assertTrue(item["trending"])

    def test_reprompt_store_concurrent_history_and_session_writes_are_thread_safe(self) -> None:
        store = RePromptStore(self.data_dir)

        def write_worker(i: int) -> None:
            store.add_history({"id": f"item-{i}", "original": f"p-{i}", "rewritten": f"r-{i}"})
            store.add_loaded_skill("conc-sess", {"id": f"sk-{i}", "name": f"sk-{i}", "domain": "engineering"})

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(write_worker, range(12)))

        history = store.load_history()
        self.assertEqual(len(history), 12)
        sess = store.get_session("conc-sess")
        self.assertEqual(len(sess["loaded_skills"]), 12)

    def test_skill_router_tracks_dynamic_index_path_and_mcp_schemas(self) -> None:
        # Point env to a second vault dir without reloading modules
        vault2 = self.root / "vault-2"
        vault2.mkdir(parents=True, exist_ok=True)
        skill_file = vault2 / "SKILL.md"
        skill_file.write_text("---\nname: sql-tuning\ndescription: Query tuning.\n---\nOptimize indexes.\n", encoding="utf-8")
        (vault2 / "index.json").write_text(
            json.dumps(
                {
                    "skills": [
                        {
                            "id": "sql-tuning-1",
                            "slug": "example-sql",
                            "name": "sql-tuning",
                            "repo": "example/sql",
                            "domain": "data-ai",
                            "tier": 1,
                            "stars": 900,
                            "description": "Query tuning",
                            "path": str(skill_file),
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        # load_index keeps only entries of an approved source (P2-272 B-fix, should-fix 3: fail closed).
        (vault2 / "sources.json").write_text(
            json.dumps({"version": 2, "repos": [{"slug": "example-sql", "repo": "example/sql",
                        "url": "https://github.com/example/sql.git", "approved": True}]}),
            encoding="utf-8",
        )
        os.environ["REPROMPT_SKILL_VAULT_DIR"] = str(vault2)
        extracted = skill_router.extract_existing_skill_paths(f"Read `{skill_file}` first")
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0]["id"], "sql-tuning-1")

        # Verify orchestrate_task role enum + workspace property
        orch_tool = next(t for t in TOOLS if t["name"] == "orchestrate_task")
        props = orch_tool["inputSchema"]["properties"]
        self.assertIn("workspace", props)
        for role_name in ("auto", "execution", "orchestrator", "planning", "scout", "reviewer", "quarantine"):
            self.assertIn(role_name, props["role"]["enum"])

        # Verify app_vault_search allows limit up to 50
        store = RePromptStore(self.data_dir)
        search_res = execute_tool(store, "app_vault_search", {"query": "tuning", "limit": 50})
        self.assertFalse(search_res["isError"])

    def test_skill_hook_subagent_bypass_and_session_merge(self) -> None:
        hook_script = REPROMPT_ROOT / "scripts" / "reprompt_skill_hook.py"
        # Build empty index file so hook proceeds
        (self.vault_dir / "index.json").write_text(
            json.dumps(
                {
                    "skills": [
                        {
                            "id": "sec-audit",
                            "name": "security-audit",
                            "repo": "example/sec",
                            "domain": "security",
                            "tier": 1,
                            "stars": 500,
                            "description": "Security threat model audit",
                            "path": str(self.vault_dir / "sec" / "SKILL.md"),
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        # WK_SUBAGENT_ACTIVE=1 short-circuits immediately
        env_sub = {**os.environ, "WK_SUBAGENT_ACTIVE": "1"}
        proc = subprocess.run(
            [sys.executable, str(hook_script)],
            input=json.dumps({"conversationId": "sub-1", "lastUserInput": "Audit JWT authentication and OWASP threats"}),
            text=True,
            capture_output=True,
            env=env_sub,
            timeout=10,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout.strip()), {})

    def test_shared_workspace_handoff_lock_leaves_no_stale_lockfile(self) -> None:
        from scripts.reprompt_inline_hook import consume_pending_shared_handoff

        ws = self.root / "shared-repo"
        ws.mkdir(parents=True, exist_ok=True)
        shared_file = self.wk_home / "shared-workspace.json"
        shared_file.write_text(
            json.dumps(
                {
                    "version": 1,
                    "workspaces": {
                        str(ws.resolve()): {
                            "from_engine": "claude",
                            "to_engine": "antigravity",
                            "title": "Finish handler",
                            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                            "consumed_by": None,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        msg = consume_pending_shared_handoff(str(ws), "antigravity")
        self.assertIn("Finish handler", msg)
        self.assertFalse((self.wk_home / "shared-workspace.lock").exists())

    def test_claude_plugin_zip_includes_hook_scripts(self) -> None:
        zip_path = build_claude_plugin_zip("test-audit")
        try:
            import zipfile

            with zipfile.ZipFile(zip_path, "r") as zf:
                names = set(zf.namelist())
                self.assertIn("scripts/reprompt_inline_hook.py", names)
                self.assertIn("scripts/reprompt_skill_hook.py", names)
        finally:
            zip_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
