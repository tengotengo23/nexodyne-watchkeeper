#!/usr/bin/env python3
"""P2-272 (spec section 3.5): the one skill router: pin grammar, pin resolution and the vault index as source."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import skill_router  # noqa: E402
from core.skill_router import (  # noqa: E402
    PIN_PLUS_RE,
    build_skills_manifest,
    extract_skill_overrides,
    select_all_matching_skills,
)
from core.state_store import StateStore  # noqa: E402


def _skill(name: str, priority: int = 2, sid: str = "") -> dict:
    return {"name": name, "id": sid, "priority": priority, "keywords": [], "tags": [], "scope": "watchkeeper_core"}


class PinGrammarTests(unittest.TestCase):
    def test_pin_regex_superset(self) -> None:
        self.assertEqual(PIN_PLUS_RE.findall("use +skill:owner/repo/pdf now"), ["owner/repo/pdf"])
        self.assertEqual(PIN_PLUS_RE.findall("@Skill:API-Designer"), ["API-Designer"])
        self.assertEqual(PIN_PLUS_RE.findall("a+skill:x"), [])
        pins, sup = extract_skill_overrides("+skill:A +SKILL:a -skill:B")
        self.assertEqual(pins, ["a"])
        self.assertEqual(sup, ["b"])

    def test_resolution_exact_then_normalised_then_substring(self) -> None:
        manifest = {"skills": [_skill("api-designer"), _skill("API Designer Pro", 4), _skill("sql-migrator"), _skill("pdf", 4, "owner/repo/pdf")]}
        names = lambda p: [s["name"] for s in select_all_matching_skills(p, manifest, min_score=999)]  # noqa: E731
        self.assertEqual(names("+skill:api-designer"), ["api-designer"])
        self.assertEqual(names("+skill:API_Designer_Pro"), ["API Designer Pro"])
        self.assertEqual(names("+skill:migrat"), ["sql-migrator"])
        self.assertEqual(names("+skill:owner/repo/pdf"), ["pdf"])
        self.assertEqual(names("+skill:nothing-like-it"), [])

    def test_suppression_resolves_too(self) -> None:
        sk = _skill("sql-migrator")
        sk["keywords"] = ["sql", "migration", "schema"]
        manifest = {"skills": [sk]}
        self.assertTrue(select_all_matching_skills("sql migration schema", manifest))
        self.assertEqual(select_all_matching_skills("sql migration schema -skill:SQL_Migrator", manifest), [])

    def test_auto_floor_matches_grammar(self) -> None:
        sys.path.insert(0, str(ROOT / "reprompt" / "scripts"))
        try:
            import prompt_prefix
        finally:
            sys.path.pop(0)
        self.assertEqual(skill_router.AUTO_FLOOR_CHARS, prompt_prefix.AUTO_FLOOR_CHARS)
        self.assertEqual(skill_router.AUTO_FLOOR_CHARS, 8)


class VaultSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="wk-p1b-router-")
        self.base = Path(self._tmp.name)
        self.home = self.base / "home"
        self.ws = self.base / "ws"
        self.vault = self.base / "vault"
        for d in (self.home, self.ws, self.vault):
            d.mkdir(parents=True)
        skill_md = self.vault / "repos" / "acme" / "ledger" / "SKILL.md"
        skill_md.parent.mkdir(parents=True)
        skill_md.write_text("---\nname: ledger-close\ndescription: Close the books\n---\nBody text here.\n", encoding="utf-8")
        (self.vault / "index.json").write_text(json.dumps({"skills": [
            {"id": "acme/ledger-close", "name": "ledger-close", "slug": "acme", "domain": "finance",
             "description": "Close the books", "path": str(skill_md)},
        ]}), encoding="utf-8")
        # P2-272 B-fix (should-fix 3): the index fails closed, so the vault source must be approved in sources.json.
        (self.vault / "sources.json").write_text(json.dumps({"version": 2, "repos": [
            {"slug": "acme", "repo": "acme/ledger", "url": "https://github.com/acme/ledger", "approved": True,
             "status": "approved"},
        ]}), encoding="utf-8")
        env = {"HOME": str(self.home), "WK_HOME": str(self.home / ".wk"), "REPROMPT_SKILL_VAULT_DIR": str(self.vault)}
        self._env = mock.patch.dict(os.environ, env)
        self._env.start()
        self.store = StateStore(workspace_dir=self.ws, runtime_dir=self.base / "rt")

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def test_vault_index_is_the_source(self) -> None:
        m = build_skills_manifest(workspace_dir=self.ws, plugin_root=self.base, home=self.home, store=self.store, force_reload=True)
        vault = [s for s in m["skills"] if s["scope"] == "skill_vault"]
        self.assertEqual([s["name"] for s in vault], ["ledger-close"])
        self.assertEqual(vault[0]["id"], "acme/ledger-close")
        self.assertFalse(m["cache_hit"])
        self.assertTrue(Path(m["manifest_file"]).is_file())
        hit = select_all_matching_skills("+skill:acme/ledger-close", m)
        self.assertEqual(hit[0]["name"], "ledger-close")

    def test_no_index_means_no_build(self) -> None:
        (self.vault / "index.json").unlink()
        with mock.patch.object(skill_router, "_load_vault_module", side_effect=AssertionError("must not load")):
            m = build_skills_manifest(workspace_dir=self.ws, plugin_root=self.base, home=self.home, store=self.store, force_reload=True)
        self.assertEqual([s for s in m["skills"] if s["scope"] == "skill_vault"], [])
        self.assertFalse((self.vault / "index.json").exists())

    def test_cached_manifest_is_only_a_fallback(self) -> None:
        build_skills_manifest(workspace_dir=self.ws, plugin_root=self.base, home=self.home, store=self.store, force_reload=True)
        with mock.patch.object(skill_router, "_load_vault_module", side_effect=RuntimeError("vault broken")):
            m = build_skills_manifest(workspace_dir=self.ws, plugin_root=self.base, home=self.home, store=self.store, force_reload=True)
        self.assertEqual([s["name"] for s in m["skills"] if s["scope"] == "skill_vault"], ["ledger-close"])
        self.assertEqual(os.environ.get("REPROMPT_SKILL_VAULT_DIR"), str(self.vault))


if __name__ == "__main__":
    unittest.main()
