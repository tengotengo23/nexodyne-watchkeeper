from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import skill_vault as sv  # noqa: E402


def _mk_repo(base: Path, slug: str) -> None:
    d = base / "repos" / slug / "demo"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\nname: {slug}-demo\ndescription: Demo skill for {slug}.\n---\n# Demo\nBody text for {slug}.\n")


class SkillGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.old = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
        os.environ["REPROMPT_SKILL_VAULT_DIR"] = str(self.base)
        repos = []
        for slug, ok in (("ok-one", True), ("staged-one", False)):
            _mk_repo(self.base, slug)
            repos.append({"slug": slug, "repo": f"o/{slug}", "url": "x", "tier": 2, "stars": 5,
                          "approved": ok, "status": "approved" if ok else "staged"})
        (self.base / "sources.json").write_text(json.dumps({"version": 1, "repos": repos}))

    def tearDown(self):
        if self.old is None:
            os.environ.pop("REPROMPT_SKILL_VAULT_DIR", None)
        else:
            os.environ["REPROMPT_SKILL_VAULT_DIR"] = self.old
        self.tmp.cleanup()

    def test_load_sources_skips_unapproved(self):
        self.assertIn("ok-one", [r["slug"] for r in sv.load_sources()])
        self.assertNotIn("staged-one", [r["slug"] for r in sv.load_sources()])
        self.assertIn("staged-one", [r["slug"] for r in sv.load_sources(include_unapproved=True)])

    def test_index_skips_staged(self):
        idx = sv.build_index()
        slugs = {k["slug"] for k in idx["skills"]}
        self.assertIn("ok-one", slugs)
        self.assertNotIn("staged-one", slugs)

    def test_load_index_drops_stale_staged_entries(self):
        idx = sv.build_index()
        idx["skills"].append({"id": "staged-one/x", "slug": "staged-one", "name": "x", "domain": "d"})
        Path(sv._index_file()).write_text(json.dumps(idx))
        self.assertNotIn("staged-one", {k["slug"] for k in sv.load_index()["skills"]})

    def test_legacy_manifest_migrates(self):
        (self.base / "sources.json").write_text(json.dumps({"version": 1, "repos": [
            {"slug": "a", "repo": "o/a", "tier": 1}, {"slug": "b", "repo": "o/b", "discovered_trending": True}]}))
        self.assertIn("a", [r["slug"] for r in sv.load_sources()])
        self.assertNotIn("b", [r["slug"] for r in sv.load_sources()])
        raw = json.loads((self.base / "sources.json").read_text())
        st = {r["slug"]: r["status"] for r in raw["repos"]}
        self.assertEqual((st["a"], st["b"]), ("approved", "staged"))


if __name__ == "__main__":
    unittest.main()
