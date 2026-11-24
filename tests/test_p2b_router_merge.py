#!/usr/bin/env python3
"""P2-272 (B), Task 0: one matching path. core/skill_router and the Re-Prompt router pick the same skills."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import skill_router as core_router  # noqa: E402

rp_router = core_router._load_router_module()

SKILLS = [
    {"name": "sql-migrator", "id": "o/r/sql-migrator", "priority": 2, "keywords": ["sql", "migration", "schema"], "tags": ["database"]},
    {"name": "pdf", "id": "owner/repo/pdf", "priority": 4, "keywords": ["pdf", "extract"], "tags": ["documents"]},
    {"name": "api-designer", "id": "a/api-designer", "priority": 2, "keywords": ["api", "rest", "endpoint"], "tags": ["design"]},
    {"name": "API Designer Pro", "id": "b/api-designer-pro", "priority": 4, "keywords": ["api", "openapi"], "tags": []},
    {"name": "graphify", "id": "local-installed/graphify", "priority": 3, "keywords": ["graph", "knowledge", "codebase"], "tags": ["graph"]},
]
PROMPTS = [
    "write a sql migration for the schema",
    "extract text from this pdf",
    "design a rest api endpoint",
    "+skill:api-designer please",
    "+skill:API_Designer_Pro and the openapi file",
    "@skill:migrat now",
    "sql migration schema -skill:SQL_Migrator",
    "build a knowledge graph of the codebase +skill:pdf",
    "hello there",
    "",
]


def _names(skills: list) -> list:
    return [s["name"] for s in skills]


class RouterMergeTests(unittest.TestCase):
    def test_same_selection_for_same_prompts(self) -> None:
        manifest = {"skills": SKILLS}
        for p in PROMPTS:
            for role in ("main", "worker", "quarantine"):
                core_pick = _names(core_router.select_all_matching_skills(p, manifest, agent_role=role))
                rp_pick = _names(rp_router.select_manifest_skills(
                    p, SKILLS, core_router._tokenize(p), agent_role=role, rank_key=core_router._manifest_rank))
                self.assertEqual(core_pick, rp_pick, f"{role}: {p!r}")

    def test_same_pin_grammar(self) -> None:
        for p in PROMPTS:
            pins, excl, _ = rp_router.parse_skill_pins(p)
            core_pins, core_excl = core_router.extract_skill_overrides(p)
            self.assertEqual(core_pins, list(dict.fromkeys(x.lower() for x in pins)), p)
            self.assertEqual(core_excl, list(dict.fromkeys(x.lower() for x in excl)), p)

    def test_same_pin_resolution(self) -> None:
        for tok in ("api-designer", "API_Designer_Pro", "migrat", "owner/repo/pdf", "GRAPHIFY", "nothing-like-it", ""):
            core_hit = core_router.resolve_skill_token(tok, SKILLS)
            rp_hit = rp_router.resolve_skill_token(tok, SKILLS, core_router._manifest_rank)
            self.assertEqual(core_hit, (rp_hit or {}).get("name", "").lower() or None, tok)

    def test_hook_pins_resolve_like_core(self) -> None:
        # The hook path (_resolve_pinned_skills, used by judge_skills_for_prompt) uses the same resolver.
        for tok in ("api-designer", "migrat", "owner/repo/pdf", "graphify"):
            vault_like = [dict(s, domain="engineering-devops", repo="o/r", description=s["name"], path="/x/SKILL.md") for s in SKILLS]
            hook = rp_router._resolve_pinned_skills([tok], vault_like)
            self.assertEqual([h["name"].lower() for h in hook], [core_router.resolve_skill_token(tok, SKILLS)], tok)


if __name__ == "__main__":
    unittest.main()
