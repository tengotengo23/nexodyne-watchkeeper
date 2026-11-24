#!/usr/bin/env python3
"""P2-272 (B): the approved-only gate. Staged and rejected sources are never indexed, even when cloned.

Every case runs in a fresh temp vault (REPROMPT_SKILL_VAULT_DIR) and WK_HOME; no network (discovery is stubbed).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "reprompt" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import skill_vault  # noqa: E402
import skill_router  # noqa: E402

VECTORS = ROOT / "test" / "fixtures" / "skill-gate-vectors.json"


def _skill(repo_dir: Path, name: str, extra: str = "") -> None:
    d = repo_dir / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} helps with one plain task.\n---\n# {name}\n## Use\nStep one for {name}.\n{extra}",
        encoding="utf-8",
    )


class GateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="wk-p2b-gate-")
        base = Path(self._tmp.name)
        self.vault = base / "vault"
        self.wk = base / "wk"
        self.wk.mkdir()
        repos = self.vault / "repos"
        for slug, names in (("good", ["alpha", "beta"]), ("staged", ["gamma"]), ("nope", ["delta"]), ("later", ["eps"])):
            for n in names:
                _skill(repos / slug, n)
        self.sources = {
            "version": 2,
            "repos": [
                {"slug": "good", "repo": "o/good", "approved": True, "status": "approved", "stars": 50},
                {"slug": "staged", "repo": "o/staged", "approved": False, "status": "staged", "stars": 900,
                 "description": "A staged   library\nof skills", "staged_at": "2026-11-22T12:30:00+00:00"},
                {"slug": "nope", "repo": "o/nope", "approved": False, "status": "rejected", "stars": 10},
                {"slug": "later", "repo": "o/later", "approved": False, "status": "staged", "stars": 5},
            ],
        }
        (self.vault / "sources.json").write_text(json.dumps(self.sources), encoding="utf-8")
        self._env = mock.patch.dict(os.environ, {
            "REPROMPT_SKILL_VAULT_DIR": str(self.vault),
            "WK_HOME": str(self.wk),
            "REPROMPT_INCLUDE_LOCAL_SKILLS": "0",
        })
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def _names(self) -> set[str]:
        data = json.loads((self.vault / "index.json").read_text(encoding="utf-8"))
        return {s["name"] for s in data["skills"]}

    def test_staged_and_rejected_never_indexed_even_when_cloned(self) -> None:
        skill_vault.build_index()
        self.assertEqual(self._names(), {"alpha", "beta"})

    def test_index_source_indexes_one_approved_source_and_refuses_staged(self) -> None:
        skill_vault.build_index()
        with self.assertRaises(ValueError):
            skill_vault.index_source("staged")
        with self.assertRaises(ValueError):
            skill_vault.index_source("nope")
        self.assertEqual(self._names(), {"alpha", "beta"})
        # The owner approves "later": only that source joins the index.
        self.sources["repos"][3].update({"approved": True, "status": "approved"})
        (self.vault / "sources.json").write_text(json.dumps(self.sources), encoding="utf-8")
        skill_vault.index_source("later")
        self.assertEqual(self._names(), {"alpha", "beta", "eps"})

    def test_drop_source_removes_its_skills(self) -> None:
        skill_vault.build_index()
        skill_vault.drop_source("good")
        self.assertEqual(self._names(), set())

    def test_pending_lists_staged_not_rejected(self) -> None:
        items = skill_vault.pending_sources()
        self.assertEqual([i["slug"] for i in items], ["staged", "later"])
        first = items[0]
        self.assertEqual(first["name"], "staged")
        self.assertEqual(first["stars"], 900)
        self.assertEqual(first["description"], "A staged library of skills")
        self.assertEqual(first["url"], "https://github.com/o/staged")
        self.assertTrue(first["cloned"])

    def test_discovery_adds_new_repos_as_staged(self) -> None:
        def fake_fetch(_url: str, _headers: dict) -> dict:
            return {"items": [
                {"full_name": "x/new-skills", "html_url": "https://github.com/x/new-skills", "stargazers_count": 400,
                 "forks_count": 20, "description": "Agent skills", "topics": ["agent-skills"], "pushed_at": ""},
                {"full_name": "o/good", "html_url": "https://github.com/o/good", "stargazers_count": 60,
                 "forks_count": 20, "description": "skills", "topics": [], "pushed_at": ""},
            ]}
        out = skill_vault.discover_trending_github_repos(min_stars=20, max_new=5, fetcher=fake_fetch, now_ts=1_800_000_000)
        self.assertEqual([a["repo"] for a in out["added"]], ["x/new-skills"])
        data = json.loads((self.vault / "sources.json").read_text(encoding="utf-8"))
        new = [r for r in data["repos"] if r["repo"] == "x/new-skills"][0]
        self.assertIs(new["approved"], False)
        self.assertEqual(new["status"], "staged")
        self.assertTrue(new["staged_at"])
        self.assertFalse(skill_vault.is_approved(new))
        # The approved source stays approved, the rejected one stays rejected.
        by_slug = {r["slug"]: r for r in data["repos"]}
        self.assertTrue(by_slug["good"]["approved"])
        self.assertEqual(by_slug["nope"]["status"], "rejected")

    def test_stop_switch_pending_is_neutral_and_exits_0(self) -> None:
        (self.wk / "KILL").write_text("", encoding="utf-8")
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["skill_vault.py", "pending", "--json"]), contextlib.redirect_stdout(buf):
            code = skill_vault.main()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buf.getvalue()), {"ok": True, "stopped": True, "reason": "stop_switch"})
        self.assertFalse((self.vault / "index.json").exists())

    def test_check_skill_refuses_a_key(self) -> None:
        _skill(self.vault / "repos" / "good", "leaky", "token: sk-ant-" + "Q" * 40 + "\n")
        res = skill_vault.check_skill(self.vault / "repos" / "good" / "skills" / "leaky")
        self.assertFalse(res["ok"])
        self.assertTrue(skill_vault.check_skill(self.vault / "repos" / "good" / "skills" / "alpha")["ok"])

    def test_python_gate_matches_shared_vectors(self) -> None:
        cases = json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 3)
        for c in cases:
            self.assertEqual(skill_vault.is_approved(c["entry"]), c["approved"], json.dumps(c["entry"]))

    def test_python_index_gate_matches_shared_skill_vectors(self) -> None:
        # P2-272 B-fix (should-fix 4): load_index keeps an index entry by slug only, the same as JS skillAllowed.
        doc = json.loads(VECTORS.read_text(encoding="utf-8"))
        (self.vault / "sources.json").write_text(json.dumps(doc["skill_sources"]), encoding="utf-8")
        for c in doc["skill_cases"]:
            (self.vault / "index.json").write_text(json.dumps({"skills": [c["skill"]]}), encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                kept = skill_vault.load_index()["skills"]
            self.assertEqual(len(kept) == 1, c["approved"], json.dumps(c["skill"]))


    def test_python_cap_matches_shared_cap_vectors(self) -> None:
        # P2-273 (owner: "<= 20 approved high-signal skills"): the same ranking and cap as JS capSkills
        self.assertEqual(skill_vault.MAX_SKILLS, 20)
        for c in json.loads(VECTORS.read_text(encoding="utf-8"))["cap_cases"]:
            kept, over = skill_vault.cap_skills(c["skills"], c["max"])
            self.assertEqual([k["id"] for k in kept], c["kept"])
            self.assertEqual([k["id"] for k in over], c["over"])

    def test_load_index_caps_the_router_pool_at_20(self) -> None:
        own = [{"id": f"local-installed/o{i}", "name": f"o{i}", "slug": "local-installed",
                "path": f"/h/.claude/skills/o{i}/SKILL.md", "description": "x"} for i in range(1, 19)]
        # P2-273 review: synced skills without an open licence are withheld from the router, so these carry Apache 2.0
        syn_root = Path(self._tmp.name) / "home" / ".claude" / "skills" / "synced" / "u"
        syn = []
        for i in range(1, 5):
            d = syn_root / f"s{i}"
            d.mkdir(parents=True)
            (d / "LICENSE.txt").write_text("Apache License\nVersion 2.0, January 2004\n", encoding="utf-8")
            syn.append({"id": f"local-installed/s{i}", "name": f"s{i}", "slug": "local-installed",
                        "path": str(d / "SKILL.md"), "description": "x"})
        (self.vault / "index.json").write_text(json.dumps({"skills": syn + own}), encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            idx = skill_vault.load_index()
        self.assertEqual(len(idx["skills"]), 20)
        self.assertEqual([k["id"] for k in idx["skills"][:18]], [k["id"] for k in own])
        self.assertEqual(idx["over_cap"], ["local-installed/s3", "local-installed/s4"])

    def test_router_set_is_the_ide_exposure_first_then_approved_fill_at_most_20(self) -> None:
        # P2-273 review: the router and bin/skill-expose.mjs exposure() share one set; never more than 20 in all
        own = [{"id": f"local-installed/o{i}", "name": f"o{i}", "slug": "local-installed",
                "path": f"/h/.claude/skills/o{i}/SKILL.md", "description": "x"} for i in range(1, 16)]
        approved = [{"id": f"good/a{i}", "name": f"a{i}", "slug": "good",
                     "path": f"/v/repos/good/a{i}/SKILL.md", "description": "x"} for i in range(1, 11)]
        restricted = {"id": "local-installed/pdfreader", "name": "pdfreader", "slug": "local-installed",
                      "path": "/h/.claude/skills/synced/u/pdfreader/SKILL.md", "description": "x"}
        (self.vault / "index.json").write_text(json.dumps({"skills": [restricted] + own + approved}), encoding="utf-8")
        (self.wk / "skills-exposed.json").write_text(json.dumps(
            {"version": 1, "extra": ["good/a9", "good/a10"], "hidden": ["local-installed/o2"]}), encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            idx = skill_vault.load_index()
        ids = [k["id"] for k in idx["skills"]]
        self.assertEqual(len(ids), 20)
        self.assertNotIn("local-installed/o2", ids)              # hidden: never routed
        self.assertNotIn("local-installed/pdfreader", ids)       # synced, no open licence: withheld
        self.assertEqual(idx["withheld"], ["local-installed/pdfreader"])
        exposed = [k["id"] for k in own if k["id"] != "local-installed/o2"] + ["good/a9", "good/a10"]
        self.assertEqual(ids[:16], exposed)                      # the IDE exposure comes first, whole
        self.assertEqual(ids[16:], ["good/a1", "good/a2", "good/a3", "good/a4"])
        self.assertEqual(idx["over_cap"], [f"good/a{i}" for i in range(5, 9)])

    def test_licence_rule_covers_pins_kept_skills_and_unknown_targets(self) -> None:
        # P2-273 review: +skill: pins and kept session skills obey the same rule; "auto"/"general" fail closed
        base = Path(self._tmp.name) / "home" / ".claude" / "skills" / "synced" / "u"
        skills = []
        for name, lic in (("pdfmaker", "MIT License\n"), ("pdfreader", "(c) Anthropic. Users may not extract these.\n")):
            d = base / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: pdf tools\n---\n# {name}\n", encoding="utf-8")
            (d / "LICENSE.txt").write_text(lic, encoding="utf-8")
            skills.append({"id": f"local-installed/{name}", "name": name, "slug": "local-installed", "domain": "docs",
                           "repo": "local", "path": str(d / "SKILL.md"), "description": "pdf tools for documents"})
        # a link to the restricted folder from outside "synced" is still synced (real path)
        link = Path(self._tmp.name) / "elsewhere" / "pdfreader"
        link.parent.mkdir(parents=True)
        link.symlink_to(base / "pdfreader", target_is_directory=True)
        linked = dict(skills[1], id="good/pdfreader-link", slug="good", path=str(link / "SKILL.md"))
        self.assertTrue(skill_vault.is_synced_skill(linked))
        for target in ("gemini", "auto", "general", "", None):
            self.assertFalse(skill_vault.skill_allowed_for(skills[1], target), target)
            self.assertFalse(skill_vault.skill_allowed_for(linked, target), target)
            self.assertTrue(skill_vault.skill_allowed_for(skills[0], target), target)
        self.assertTrue(skill_vault.skill_allowed_for(skills[1], "claude"))
        idx = {"skills": skills + [linked]}
        kept = [dict(id=k["id"], name=k["name"], domain="docs", repo="local", path=k["path"]) for k in skills]
        for target in ("gemini", "auto", "general", "claude"):
            judgment, state = skill_router.judge_skills_for_prompt(
                "convert these pdf documents with the pdf tools", target_provider=target, index_data=idx,
                pinned_skills=["pdfreader"], session_state={"loaded_skills": kept, "turn_count": 1})
            names = {k["name"] for k in judgment["active_skills"]} | {k["name"] for k in state["loaded_skills"]}
            if target == "claude":
                self.assertIn("pdfreader", names, target)        # Claude may use the owner's synced skills
            else:
                self.assertNotIn("pdfreader", names, target)     # pinned or kept, it never reaches another target

    def test_gemini_gets_synced_skills_only_under_an_open_licence(self) -> None:
        # P2-273: the router follows the Antigravity exposure rule (P2-272 Phase 5) for synced skills
        base = Path(self._tmp.name) / "home" / ".claude" / "skills" / "synced" / "u"
        skills = []
        for name, lic in (("pdfmaker", "Apache License\nVersion 2.0, January 2004\n"),
                          ("pdfreader", "(c) Anthropic. Users may not extract these materials.\n"),
                          ("pdfnolicence", None)):
            d = base / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: pdf tools\n---\n# {name}\n", encoding="utf-8")
            if lic is not None:
                (d / "LICENSE.txt").write_text(lic, encoding="utf-8")
            skills.append({"id": f"local-installed/{name}", "name": name, "slug": "local-installed", "domain": "docs",
                           "path": str(d / "SKILL.md"), "description": "pdf tools for documents"})
        idx = {"skills": skills}
        names = lambda prov: sorted(s["name"] for _, s in skill_vault.search_skills("pdf documents", limit=6, index_data=idx, target_provider=prov))
        self.assertEqual(names("gemini"), ["pdfmaker"])
        self.assertEqual(names("antigravity"), ["pdfmaker"])
        self.assertEqual(names("claude"), ["pdfmaker", "pdfnolicence", "pdfreader"])


if __name__ == "__main__":
    unittest.main()
