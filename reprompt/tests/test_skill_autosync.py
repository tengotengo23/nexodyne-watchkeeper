#!/usr/bin/env python3
"""Tests for v1.3.0 Gemini + Claude skill library auto-sync & Load/Keep/Unload judgment."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
sys.path.insert(0, str(PROJECT_ROOT / "server"))

import skill_router  # noqa: E402
import skill_vault  # noqa: E402
from orchestrator import Orchestrator  # noqa: E402
from reprompt_engine import RePromptStore, rewrite_with_provider  # noqa: E402


def _write_synthetic_vault(vault_dir: Path) -> Path:
    """Populate a deterministic synthetic index.json inside a temp vault directory."""
    vault_dir.mkdir(parents=True, exist_ok=True)
    repos_dir = vault_dir / "repos"
    skills = [
        {
            "id": "google-stitch-skills:stitch-ui",
            "name": "stitch-ui",
            "domain": "design-ux",
            "repo": "google-labs-code/stitch-skills",
            "ecosystem_focus": "gemini",
            "stars": 11310,
            "tier": 1,
            "description": "Design responsive UI screens WCAG accessibility typography color palette wireframe layout with Google Stitch.",
            "rel_path": "skills/stitch-ui/SKILL.md",
            "path": str(repos_dir / "google-stitch-skills" / "skills" / "stitch-ui" / "SKILL.md"),
            "has_scripts": False,
            "has_references": True,
        },
        {
            "id": "google-gemini-skills:gemini-live-api",
            "name": "gemini-live-api",
            "domain": "engineering-devops",
            "repo": "google-gemini/gemini-skills",
            "ecosystem_focus": "gemini",
            "stars": 4533,
            "tier": 1,
            "description": "Build multimodal streaming audio video agents using Gemini Interactions API SDK.",
            "rel_path": "skills/gemini-live-api/SKILL.md",
            "path": str(repos_dir / "google-gemini-skills" / "skills" / "gemini-live-api" / "SKILL.md"),
            "has_scripts": True,
            "has_references": True,
        },
        {
            "id": "wshobson-agents:stride-threat-model",
            "name": "stride-threat-model",
            "domain": "security",
            "repo": "wshobson/agents",
            "ecosystem_focus": "claude",
            "stars": 32000,
            "tier": 1,
            "description": "Perform OWASP STRIDE threat modeling vulnerability security audit checklist and remediation.",
            "rel_path": "skills/stride-threat-model/SKILL.md",
            "path": str(repos_dir / "wshobson-agents" / "skills" / "stride-threat-model" / "SKILL.md"),
            "has_scripts": False,
            "has_references": True,
        },
        {
            "id": "composio-awesome-claude-skills:composio-tdd-workflow",
            "name": "composio-tdd-workflow",
            "domain": "engineering-devops",
            "repo": "ComposioHQ/awesome-claude-skills",
            "ecosystem_focus": "claude",
            "stars": 79992,
            "tier": 2,
            "description": "Test-driven development TDD pytest unit testing code review workflow for Python services.",
            "rel_path": "tdd-workflow/SKILL.md",
            "path": str(repos_dir / "composio-awesome-claude-skills" / "tdd-workflow" / "SKILL.md"),
            "has_scripts": False,
            "has_references": False,
        },
        {
            "id": "community-small:basic-testing-notes",
            "name": "basic-testing-notes",
            "domain": "engineering-devops",
            "repo": "community/small-repo",
            "ecosystem_focus": "universal",
            "stars": 42,
            "tier": 3,
            "description": "Testing notes for Python unit tests and basic code review.",
            "rel_path": "basic-testing-notes/SKILL.md",
            "path": str(repos_dir / "community-small" / "basic-testing-notes" / "SKILL.md"),
            "has_scripts": False,
            "has_references": False,
        },
        {
            "id": "anthropics-financial-services:dcf-valuation-model",
            "name": "dcf-valuation-model",
            "domain": "finance",
            "repo": "anthropics/financial-services",
            "ecosystem_focus": "claude",
            "stars": 2800,
            "tier": 1,
            "description": "Build 3-statement DCF valuation LBO EBITDA WACC sensitivity financial model spreadsheet.",
            "rel_path": "dcf-valuation/SKILL.md",
            "path": str(repos_dir / "anthropics-financial-services" / "dcf-valuation" / "SKILL.md"),
            "has_scripts": True,
            "has_references": True,
        },
    ]
    # Real index entries carry their source's slug (build_index writes it); load_index keeps only
    # entries whose slug is an approved source (P2-272 B-fix, should-fix 3: fail closed).
    for s in skills:
        s.setdefault("slug", s["id"].split(":", 1)[0])
    # community-small is not a curated bundled source, so the owner's approval is written here, as
    # the panel would write it; without it the fail-closed index drops basic-testing-notes.
    (vault_dir / "sources.json").write_text(
        json.dumps({"version": 2, "repos": [{
            "slug": "community-small", "repo": "community/small-repo",
            "url": "https://github.com/community/small-repo.git", "tier": 3, "approved": True,
        }]}, indent=2),
        encoding="utf-8",
    )
    index_path = vault_dir / "index.json"
    index_path.write_text(
        json.dumps({"version": 1, "repo_count": 6, "cloned_repo_count": 6, "skill_count": len(skills), "skills": skills}, indent=2),
        encoding="utf-8",
    )
    return index_path


class SkillAutoSyncAndJudgmentTests(unittest.TestCase):
    def test_load_sources_auto_merges_v2_and_preserves_custom(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault_dir = Path(tmp) / "vault"
            vault_dir.mkdir(parents=True, exist_ok=True)
            v1_manifest = {
                "version": 1,
                "repos": [
                    {
                        "slug": "anthropics-skills",
                        "repo": "anthropics/skills",
                        "url": "https://github.com/anthropics/skills.git",
                        "stars": 115000,
                        "tier": 1,
                        "domains": ["office-productivity"],
                        "notes": "Existing v1 entry missing ecosystem_focus",
                    },
                    {
                        "slug": "custom-org-tools",
                        "repo": "custom-org/custom-repo",
                        "url": "https://github.com/custom-org/custom-repo.git",
                        "stars": 99,
                        "tier": 2,
                        "ecosystem_focus": "universal",
                        "domains": ["engineering-devops"],
                    },
                ],
            }
            sources_path = vault_dir / "sources.json"
            sources_path.write_text(json.dumps(v1_manifest, indent=2), encoding="utf-8")

            with mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault_dir)}):
                repos = skill_vault.load_sources()

            slugs = {r["slug"]: r for r in repos}
            self.assertIn("custom-org-tools", slugs)
            self.assertIn("google-gemini-skills", slugs)
            self.assertIn("google-stitch-skills", slugs)
            self.assertIn("composio-awesome-claude-skills", slugs)
            self.assertGreaterEqual(len(repos), 40)
            self.assertEqual(slugs["anthropics-skills"].get("ecosystem_focus"), "claude")

            persisted = json.loads(sources_path.read_text(encoding="utf-8"))
            self.assertGreaterEqual(int(persisted.get("version", 0)), 2)

    def test_star_praise_and_provider_ranking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault_dir = Path(tmp) / "vault"
            _write_synthetic_vault(vault_dir)
            with mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault_dir)}):
                idx = skill_vault.load_index()
                claude_hits = skill_vault.search_skills(
                    "python unit testing pytest tdd code review",
                    domain="engineering-devops",
                    limit=3,
                    index_data=idx,
                    target_provider="claude",
                )
                names = [s["name"] for _, s in claude_hits]
                self.assertGreaterEqual(len(names), 2)
                self.assertEqual(names[0], "composio-tdd-workflow")
                self.assertLess(names.index("composio-tdd-workflow"), names.index("basic-testing-notes"))

                gemini_hits = skill_vault.search_skills(
                    "gemini interactions api multimodal streaming agents",
                    domain="engineering-devops",
                    limit=2,
                    index_data=idx,
                    target_provider="gemini",
                )
                self.assertTrue(gemini_hits)
                self.assertEqual(gemini_hits[0][1]["name"], "gemini-live-api")

    def test_judge_skills_load_keep_unload_and_rewritten_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault_dir = Path(tmp) / "vault"
            _write_synthetic_vault(vault_dir)
            with mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault_dir)}):
                # Turn 1: vague received prompt clarified by rewritten_prompt
                j1, s1 = skill_router.judge_skills_for_prompt(
                    received_prompt="fix my page please",
                    rewritten_prompt=(
                        "## Goal\n"
                        "Redesign a responsive UI wireframe layout with typography, color palette, "
                        "and WCAG accessibility contrast using Google Stitch.\n"
                        "## Verification\nRun accessibility audit."
                    ),
                    session_state=skill_router.default_session_state(),
                    target_provider="gemini",
                    max_active_skills=2,
                )
                self.assertEqual(j1["action"], "load")
                self.assertEqual([x["name"] for x in j1["load_skills"]], ["stitch-ui"])
                self.assertEqual(j1["unload_skills"], [])

                # Turn 2: follow-up in same domain emits Keep
                j2, s2 = skill_router.judge_skills_for_prompt(
                    received_prompt="Refine the WCAG typography spacing and UI wireframe layout grid.",
                    session_state=s1,
                    target_provider="gemini",
                    max_active_skills=2,
                )
                self.assertEqual(j2["action"], "keep")
                self.assertEqual(j2["load_skills"], [])
                self.assertEqual(j2["unload_skills"], [])
                self.assertEqual([x["name"] for x in j2["keep_skills"]], ["stitch-ui"])

                # Turn 3: domain switch emits Swap (Load new + Unload stale)
                j3, s3 = skill_router.judge_skills_for_prompt(
                    received_prompt="Switch to performing an OWASP STRIDE threat model vulnerability security audit.",
                    session_state=s2,
                    target_provider="claude",
                    max_active_skills=2,
                )
                self.assertEqual(j3["action"], "swap")
                self.assertEqual([x["name"] for x in j3["load_skills"]], ["stride-threat-model"])
                self.assertEqual([x["name"] for x in j3["unload_skills"]], ["stitch-ui"])
                self.assertEqual([x["name"] for x in s3["loaded_skills"]], ["stride-threat-model"])
                self.assertTrue(any(u["name"] == "stitch-ui" for u in s3["unloaded_history"]))

    def test_rewrite_with_provider_embeds_load_and_unload_directives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault_dir = root / "vault"
            data_dir = root / "data"
            _write_synthetic_vault(vault_dir)
            store = RePromptStore(data_dir)
            store.save_settings({"provider": "offline_template", "enableSkillRouting": True})

            with mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault_dir)}):
                r1 = rewrite_with_provider(
                    store,
                    prompt="Build responsive WCAG UI wireframe layout typography with Stitch",
                    target="antigravity",
                    provider_override="offline_template",
                    session_id="rw-test",
                )
                self.assertIn("## Skill Directives (Auto-Selected)", r1["rewritten_prompt"])
                self.assertIn("**Load", r1["rewritten_prompt"])
                self.assertIn("stitch-ui", r1["rewritten_prompt"])
                self.assertEqual(r1["skill_judgment"]["action"], "load")

                r2 = rewrite_with_provider(
                    store,
                    prompt="Perform an OWASP STRIDE threat model security audit and vulnerability scan",
                    target="claude_code",
                    provider_override="offline_template",
                    session_id="rw-test",
                )
                self.assertIn("## Skill Directives (Auto-Selected)", r2["rewritten_prompt"])
                self.assertIn("**Load", r2["rewritten_prompt"])
                self.assertIn("**Unload", r2["rewritten_prompt"])
                self.assertIn("stride-threat-model", r2["rewritten_prompt"])
                self.assertIn("stitch-ui", r2["rewritten_prompt"])
                self.assertEqual(r2["skill_judgment"]["action"], "swap")

    def test_orchestrator_injects_load_and_unload_across_turns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault_dir = root / "vault"
            data_dir = root / "data"
            _write_synthetic_vault(vault_dir)

            captured_prompts: list[str] = []

            def fake_executor(provider: str, channel: str, model: str, prompt: str, system_prompt: str = "") -> dict[str, str]:
                captured_prompts.append(prompt)
                return {"text": f"[{provider}:{model}] completed"}

            integrations = {
                "overall_status": "dual_ready",
                "gemini": {
                    "available": True,
                    "primary_channel": "gemini_cli",
                    "channels": [{"id": "gemini_cli", "label": "Gemini CLI", "available": True, "detail": "ok"}],
                },
                "claude": {
                    "available": True,
                    "primary_channel": "claude_cli",
                    "channels": [{"id": "claude_cli", "label": "Claude CLI", "available": True, "detail": "ok"}],
                },
            }
            orch = Orchestrator(data_dir=data_dir, executor=fake_executor, integrations=integrations)

            with mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault_dir)}):
                preview = orch.preview_route(
                    task="Design responsive WCAG UI wireframe layout typography with Stitch",
                    session_id="orch-s1",
                )
                self.assertEqual(preview["skill_judgment"]["action"], "load")
                self.assertEqual(orch.ledger.get_session("orch-s1")["turn_count"], 0)

                r1 = orch.run_task(
                    task="Design responsive WCAG UI wireframe layout typography with Stitch",
                    session_id="orch-s1",
                )
                self.assertEqual(r1["skill_judgment"]["action"], "load")
                self.assertIn("## Skill Directives (Auto-Selected)", captured_prompts[0])
                self.assertIn("stitch-ui", captured_prompts[0])

                r2 = orch.run_task(
                    task="Audit authentication for OWASP STRIDE threat model vulnerabilities",
                    session_id="orch-s1",
                    override_provider="claude",
                    strict_override=True,
                )
                self.assertEqual(r2["skill_judgment"]["action"], "swap")
                self.assertIn("**Load", captured_prompts[1])
                self.assertIn("**Unload", captured_prompts[1])
                self.assertIn("stride-threat-model", captured_prompts[1])
                self.assertIn("stitch-ui", captured_prompts[1])

                # Internal orchestrator context compression must not inject task skill directives
                giant_ctx = "log line about wireframe accessibility\n" * 1800
                wf = orch.orchestrate_workflow(
                    task="Continue reviewing OWASP STRIDE threat mitigation plan",
                    context=giant_ctx,
                    session_id="orch-s1",
                    override_provider="claude",
                    strict_override=True,
                )
                self.assertTrue(any(step["step"] == "context_compression" for step in wf["trace"]))
                self.assertNotIn("## Skill Directives (Auto-Selected)", captured_prompts[2])

    def test_antigravity_and_claude_hooks_emit_load_and_unload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault_dir = root / "vault"
            data_dir = root / "data"
            _write_synthetic_vault(vault_dir)

            store = RePromptStore(data_dir)
            store.save_settings({"provider": "offline_template", "enableSkillRouting": True, "hookAutoAll": False})

            env = os.environ.copy()
            env.pop("REPROMPT_INTERNAL_CALL", None)
            env["REPROMPT_SKILL_VAULT_DIR"] = str(vault_dir)
            env["REPROMPT_DATA_DIR"] = str(data_dir)

            agy_hook = PROJECT_ROOT / "scripts" / "reprompt_skill_hook.py"
            claude_hook = PROJECT_ROOT / "claude-code-plugin" / "bin" / "run-inline-hook.py"

            # Antigravity PreInvocation Turn 1 -> Load stitch-ui
            p1 = subprocess.run(
                [sys.executable, str(agy_hook)],
                input=json.dumps(
                    {
                        "conversationId": "conv-auto-1",
                        "lastUserInput": "Design a responsive WCAG UI wireframe layout and typography scale",
                    }
                ),
                text=True,
                capture_output=True,
                env=env,
                timeout=20,
                check=True,
            )
            out1 = json.loads(p1.stdout)
            sys_msg1 = out1["injectSteps"][0]["systemMessage"]["systemMessage"]
            # Hooks now head third-party outlines as reference, not instructions (P2-272 B-fix, must-fix 2).
            self.assertIn(skill_router.OUTLINE_HEADING, sys_msg1)
            self.assertIn("**Load", sys_msg1)
            self.assertIn("stitch-ui", sys_msg1)

            # Antigravity PreInvocation Turn 2 -> Swap (Load stride-threat-model + Unload stitch-ui)
            p2 = subprocess.run(
                [sys.executable, str(agy_hook)],
                input=json.dumps(
                    {
                        "conversationId": "conv-auto-1",
                        "lastUserInput": "Now run an OWASP STRIDE threat model security vulnerability audit",
                    }
                ),
                text=True,
                capture_output=True,
                env=env,
                timeout=20,
                check=True,
            )
            out2 = json.loads(p2.stdout)
            sys_msg2 = out2["injectSteps"][0]["systemMessage"]["systemMessage"]
            summary2 = out2["injectSteps"][0]["systemMessage"]["metadata"]["user_markdown"]
            self.assertIn("**Load", sys_msg2)
            self.assertIn("**Unload", sys_msg2)
            self.assertIn("stride-threat-model", sys_msg2)
            self.assertIn("stitch-ui", sys_msg2)
            self.assertIn("Unloaded: stitch-ui", summary2)

            # Claude Code UserPromptSubmit non-rp Turn 1 -> Load stitch-ui
            c1 = subprocess.run(
                [sys.executable, str(claude_hook)],
                input=json.dumps(
                    {
                        "session_id": "claude-auto-1",
                        "prompt": "Build a WCAG accessibility UI wireframe layout with typography and color palette",
                    }
                ),
                text=True,
                capture_output=True,
                env=env,
                timeout=20,
                check=True,
            )
            cout1 = json.loads(c1.stdout)
            ctx1 = cout1["hookSpecificOutput"]["additionalContext"]
            # Hooks now head third-party outlines as reference, not instructions (P2-272 B-fix, must-fix 2).
            self.assertIn(skill_router.OUTLINE_HEADING, ctx1)
            self.assertIn("**Load", ctx1)
            self.assertIn("stitch-ui", ctx1)

            # Claude Code UserPromptSubmit non-rp Turn 2 -> Unload stitch-ui + Load stride-threat-model
            c2 = subprocess.run(
                [sys.executable, str(claude_hook)],
                input=json.dumps(
                    {
                        "session_id": "claude-auto-1",
                        "prompt": "Perform an OWASP STRIDE threat model security vulnerability audit",
                    }
                ),
                text=True,
                capture_output=True,
                env=env,
                timeout=20,
                check=True,
            )
            cout2 = json.loads(c2.stdout)
            ctx2 = cout2["hookSpecificOutput"]["additionalContext"]
            self.assertIn("**Load", ctx2)
            self.assertIn("**Unload", ctx2)
            self.assertIn("stride-threat-model", ctx2)
            self.assertIn("stitch-ui", ctx2)


if __name__ == "__main__":
    unittest.main()

