"""Unit tests for Watchkeeper v0.8.0 daily GitHub skill discovery and Carbon High failover."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "server"))

import skill_vault  # noqa: E402
from orchestrator import Orchestrator, ProviderExecutionError, decide_route, read_watchkeeper_pace  # noqa: E402


DUAL_INTEGRATIONS = {
    "overall_status": "dual_ready",
    "gemini": {"available": True, "primary_channel": "agy_gemini", "channels": [{"id": "agy_gemini", "available": True}]},
    "claude": {"available": True, "primary_channel": "agy_claude", "channels": [{"id": "agy_claude", "available": True}]},
}


class V080FeaturesTests(unittest.TestCase):
    def test_daily_trending_discovery_sync_and_kill_switch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            wk_home = base / "wk"
            vault_dir = base / "vault"
            data_dir = base / "data"
            wk_home.mkdir()
            vault_dir.mkdir()
            data_dir.mkdir()

            def fake_fetcher(url: str, headers: dict) -> dict:
                return {
                    "items": [
                        {
                            "full_name": "acme-ai/agent-skills-pack",
                            "html_url": "https://github.com/acme-ai/agent-skills-pack",
                            "stargazers_count": 820,
                            "forks_count": 95,
                            "pushed_at": "2026-11-21T10:00:00Z",
                            "description": "Production agent skills and SKILL.md library for Claude Code and Gemini",
                            "topics": ["agent-skills", "claude-code"],
                        },
                        {
                            "full_name": "lowstar/noise",
                            "html_url": "https://github.com/lowstar/noise",
                            "stargazers_count": 3,
                            "forks_count": 0,
                            "pushed_at": "2026-11-21T10:00:00Z",
                            "description": "tiny skill note",
                            "topics": [],
                        },
                    ]
                }

            env = {
                "WK_HOME": str(wk_home),
                "REPROMPT_SKILL_VAULT_DIR": str(vault_dir),
                "REPROMPT_DATA_DIR": str(data_dir),
                "REPROMPT_INCLUDE_LOCAL_SKILLS": "0",
            }
            with mock.patch.dict(os.environ, env, clear=False):
                first = skill_vault.sync_trending_daily(do_clone=False, min_stars=20, max_new=4, fetcher=fake_fetcher, now_ts=1795340000.0)
                self.assertTrue(first["ok"])
                self.assertIn("acme-ai/agent-skills-pack", first["added_repos"])
                self.assertNotIn("lowstar/noise", first["added_repos"])
                sync_file = wk_home / "skill-sync.json"
                self.assertTrue(sync_file.is_file())
                saved = json.loads(sync_file.read_text(encoding="utf-8"))
                self.assertEqual(saved["added_repos"], ["acme-ai/agent-skills-pack"])

                # Same day skips GitHub calls unless force=True
                second = skill_vault.sync_trending_daily(do_clone=False, force=False, fetcher=fake_fetcher, now_ts=1795340600.0)
                self.assertEqual(second.get("skipped"), "already_synced_today")

                # KILL switch halts discovery cleanly
                (wk_home / "KILL").write_text("stop\n", encoding="utf-8")
                killed = skill_vault.sync_trending_daily(do_clone=False, force=True, fetcher=fake_fetcher, now_ts=1795341000.0)
                self.assertTrue(killed.get("killed"))

    def test_orchestrator_carbon_high_when_claude_exhausted_and_runtime_failover(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            wk_home = base / "wk"
            data_dir = base / "data"
            (wk_home / "steward").mkdir(parents=True)
            data_dir.mkdir()
            (wk_home / "steward" / "meter.json").write_text(
                json.dumps({"utilization": 0.99, "fiveHour": 0.99, "status": "rejected", "fetchedAt": "2026-11-22T12:00:00Z"}),
                encoding="utf-8",
            )

            with mock.patch.dict(os.environ, {"WK_HOME": str(wk_home), "REPROMPT_DATA_DIR": str(data_dir)}, clear=False):
                pace = read_watchkeeper_pace()
                self.assertTrue(pace["available"])
                self.assertTrue(pace.get("claude_limit_exhausted"))
                dec = Orchestrator(data_dir=str(data_dir), integrations=DUAL_INTEGRATIONS).preview_route(
                    task="Architect a distributed lock-free consensus manager across multiple services",
                    role="execution",
                    auto_skills=False,
                )
                self.assertEqual(dec["provider"], "gemini")
                self.assertEqual(dec["model"], "gemini-4-carbon-high")
                self.assertEqual(dec["effort"], "high")
                self.assertTrue(dec.get("carbon_high_failover"))

            # Simulate Claude raising a 429 limit error mid-run under healthy meter -> Carbon High takeover
            seen: list[tuple[str, str]] = []

            def failover_exec(provider: str, channel: str, model: str, prompt: str, system_prompt: str = "", **kwargs) -> dict:
                seen.append((provider, model))
                if provider == "claude":
                    raise ProviderExecutionError("API Error: 429 usage limit reached")
                return {"text": "Completed via Carbon High", "input_tokens": 120, "output_tokens": 45}

            with mock.patch.dict(os.environ, {"WK_HOME": str(wk_home / "fresh"), "REPROMPT_DATA_DIR": str(data_dir)}, clear=False):
                orch = Orchestrator(data_dir=str(data_dir), executor=failover_exec, integrations=DUAL_INTEGRATIONS)
                out = orch.run_task(
                    task="Architect a distributed lock-free consensus manager and verify failure safety",
                    role="execution",
                    auto_skills=False,
                )
                self.assertEqual(out["provider"], "gemini")
                self.assertEqual(out["model"], "gemini-4-carbon-high")
                self.assertIn(("gemini", "gemini-4-carbon-high"), seen)


if __name__ == "__main__":
    unittest.main()
