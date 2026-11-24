#!/usr/bin/env python3
"""P2-272 (B-fix): the security review's fixes on the Python side of the skills library.

Every case runs in a fresh temp vault, WK_HOME and HOME (mock.patch.dict). git is never run: skill_vault.run_git is
stubbed, so nothing is cloned over the network or from file://. Discovery uses a fake fetcher.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
for p in (str(ROOT), str(ROOT / "reprompt"), str(ROOT / "reprompt" / "scripts")):
    if p not in sys.path:
        sys.path.insert(0, p)

import skill_router  # noqa: E402
import skill_vault  # noqa: E402


def _skill(repo_dir: Path, name: str, extra: str = "") -> Path:
    d = repo_dir / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    f = d / "SKILL.md"
    f.write_text(f"---\nname: {name}\ndescription: {name} helps with one plain task.\n---\n# {name}\n## Use\n"
                 f"Step one for {name}.\n{extra}", encoding="utf-8")
    return f


class FixesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="wk-p2b-fixes-")
        base = Path(os.path.realpath(self._tmp.name))
        self.base = base
        self.vault = base / "vault"
        self.wk = base / "wk"
        self.home = base / "home"
        self.wk.mkdir()
        self.home.mkdir()
        self.repos = self.vault / "repos"
        _skill(self.repos / "good", "alpha")
        _skill(self.repos / "staged", "gamma")
        self.sources = {"version": 2, "repos": [
            {"slug": "good", "repo": "o/good", "url": "https://github.com/o/good.git", "approved": True,
             "status": "approved"},
            {"slug": "staged", "repo": "o/staged", "url": "https://github.com/o/staged.git", "approved": False,
             "status": "staged"},
        ]}
        self._write_sources()
        env = mock.patch.dict(os.environ, {
            "REPROMPT_SKILL_VAULT_DIR": str(self.vault), "WK_HOME": str(self.wk), "HOME": str(self.home),
            "REPROMPT_INCLUDE_LOCAL_SKILLS": "0",
        })
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self._tmp.cleanup)

    def _write_sources(self) -> None:
        (self.vault / "sources.json").write_text(json.dumps(self.sources), encoding="utf-8")

    def _names(self) -> set[str]:
        return {s["name"] for s in json.loads((self.vault / "index.json").read_text(encoding="utf-8"))["skills"]}

    # Should-fix: a linked SKILL.md in an approved repo is not indexed.
    def test_build_index_skips_a_linked_skill_file(self) -> None:
        secret = self.base / "outside.md"
        secret.write_text("---\nname: linky\ndescription: private\n---\n# private\n", encoding="utf-8")
        d = self.repos / "good" / "skills" / "linky"
        d.mkdir(parents=True)
        (d / "SKILL.md").symlink_to(secret)
        with contextlib.redirect_stderr(io.StringIO()):
            skill_vault.build_index()
        self.assertEqual(self._names(), {"alpha"})

    # Must-fix 1: the outline reads only approved repos and refuses links.
    def test_skill_outline_reads_only_approved_repos_and_no_links(self) -> None:
        good = self.repos / "good" / "skills" / "alpha" / "SKILL.md"
        staged = self.repos / "staged" / "skills" / "gamma" / "SKILL.md"
        self.assertIn("Use", skill_router.skill_outline(good))
        self.assertEqual(skill_router.skill_outline(staged), "", "a staged repo is not a root")
        outside = self.base / "private" / "SKILL.md"
        outside.parent.mkdir()
        outside.write_text("# Private\n## Secret heading\n", encoding="utf-8")
        self.assertEqual(skill_router.skill_outline(outside), "", "outside every root")
        link = self.repos / "good" / "skills" / "linked" / "SKILL.md"
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)
        self.assertEqual(skill_router.skill_outline(link), "", "a link out of an approved repo")
        inner = self.repos / "good" / "skills" / "inner" / "SKILL.md"
        inner.parent.mkdir(parents=True)
        inner.symlink_to(good)
        self.assertEqual(skill_router.skill_outline(inner), "", "a link is refused even inside the repo")

    # Must-fix 2: third-party names and paths lose control and bidi characters; the reference heading is used.
    def test_outline_block_strips_controls_and_uses_reference_heading(self) -> None:
        good = self.repos / "good" / "skills" / "alpha" / "SKILL.md"
        text = skill_router.format_skill_outline_directives({"load_skills": [{
            "id": "good:alpha", "name": "al‮pha\x1b[31m", "domain": "d", "repo": "o/good", "tier": 1,
            "description": "One​ line\x07 only", "path": str(good)}]})
        self.assertTrue(text.startswith(skill_router.OUTLINE_HEADING))
        self.assertNotIn("Skill Directives", text)
        for ch in ("‮", "\x1b", "​", "\x07"):
            self.assertNotIn(ch, text)

    # Should-fix 3: load_index fails closed (local skills only) when sources.json is broken or missing.
    def test_load_index_fails_closed_on_bad_or_missing_sources(self) -> None:
        (self.vault / "index.json").write_text(json.dumps({"skills": [
            {"id": "good:alpha", "name": "alpha", "slug": "good", "repo": "o/good", "path": "x"},
            {"id": "local-installed:own", "name": "own", "slug": "local-installed", "repo": "local/x", "path": "y"},
        ]}), encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual({s["name"] for s in skill_vault.load_index()["skills"]}, {"alpha", "own"})
            (self.vault / "sources.json").write_text('{"version": 2, "repos": [', encoding="utf-8")
            self.assertEqual({s["name"] for s in skill_vault.load_index()["skills"]}, {"own"}, "broken")
            (self.vault / "sources.json").unlink()
            self.assertEqual({s["name"] for s in skill_vault.load_index()["skills"]}, {"own"}, "missing")

    # Should-fix: the slug local-installed is reserved everywhere.
    def test_reserved_slug_is_refused(self) -> None:
        self.sources["repos"].append({"slug": " Local-Installed ", "repo": "x/y", "url": "https://github.com/x/y",
                                      "approved": True, "status": "approved"})
        self._write_sources()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            slugs = [r["slug"] for r in skill_vault.load_sources(include_unapproved=True)]
        self.assertNotIn(" Local-Installed ", slugs)
        self.assertIn(skill_vault.RESERVED_SLUG_MESSAGE, err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            res = skill_vault.drop_source("local-installed")
        self.assertEqual(res.get("refused"), skill_vault.RESERVED_SLUG_MESSAGE)
        self.assertEqual(res.get("dropped"), 0)

    def test_discovery_never_hands_out_the_reserved_slug(self) -> None:
        def fake_fetch(_url: str, _headers: dict) -> dict:
            return {"items": [{"full_name": "local/installed", "html_url": "https://github.com/local/installed",
                               "stargazers_count": 400, "forks_count": 20, "description": "Agent skills",
                               "topics": ["agent-skills"], "pushed_at": ""}]}
        with contextlib.redirect_stderr(io.StringIO()):
            out = skill_vault.discover_trending_github_repos(min_stars=20, max_new=5, fetcher=fake_fetch,
                                                             now_ts=1_800_000_000)
        self.assertEqual([a["slug"] for a in out["added"]], ["local-installed-2"])

    # Should-fix 7: only https://github.com/<owner>/<repo> is cloned, with protocols pinned and "--" before the URL.
    def test_clone_one_refuses_other_urls_without_running_git(self) -> None:
        calls: list[list[str]] = []

        def fake_git(args, cwd=None, timeout=180):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        with mock.patch.object(skill_vault, "run_git", fake_git):
            for url in ("file:///etc", "ext::sh -c touch% /tmp/pwned", "-uhttps://github.com/o/r",
                        "--upload-pack=touch /tmp/x", "https://gitlab.com/o/r.git", "http://github.com/o/r",
                        "https://github.com/o/r/../../x", "https://github.com.evil.example/o/r",
                        "ssh://git@github.com/o/r.git", None):
                slug, status, msg = skill_vault.clone_one({"slug": "s1", "repo": "o/r", "url": url})
                self.assertEqual(status, "error", url)
                self.assertIn("refused", msg)
            self.assertEqual(calls, [], "git never ran for a refused URL")
            slug, status, _ = skill_vault.clone_one({"slug": "s2", "repo": "o/r", "url": "https://github.com/o/r.git"})
        self.assertEqual(len(calls), 1)
        args = calls[0]
        self.assertEqual(tuple(args[:len(skill_vault.CLONE_PROTOCOL_ARGS)]), skill_vault.CLONE_PROTOCOL_ARGS)
        self.assertIn("clone", args)
        dd = args.index("--")
        self.assertEqual(args[dd + 1], "https://github.com/o/r.git")
        self.assertGreater(dd, args.index("clone"))

    # Should-fix: the Stop switch stops a running sync between clones.
    def test_kill_during_sync_stops_the_remaining_clones(self) -> None:
        for i in range(20):
            self.sources["repos"].append({"slug": f"r{i}", "repo": f"o/r{i}", "url": f"https://github.com/o/r{i}",
                                          "approved": True, "status": "approved"})
        self._write_sources()
        calls: list[list[str]] = []
        lock = threading.Lock()

        def fake_git(args, cwd=None, timeout=180):
            with lock:
                calls.append(list(args))
                (self.wk / "KILL").write_text("", encoding="utf-8")
            return subprocess.CompletedProcess(args, 1, "", "fail")

        out = io.StringIO()
        with mock.patch.object(skill_vault, "run_git", fake_git), \
                mock.patch.object(skill_vault, "build_index",
                                  lambda *a, **k: {"skill_count": 0, "cloned_repo_count": 0, "repo_count": 0}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            skill_vault.cmd_sync(None)
        # The bundled curated sources join the list too, so there are well over 20 sources; at most the 6 workers
        # already past their check run git once, everything else stops.
        self.assertGreaterEqual(len(calls), 1)
        self.assertLessEqual(len(calls), 6, f"{len(calls)} git calls after the Stop switch")
        self.assertIn("stopped", out.getvalue())

    # Should-fix: a source rejected after its skills loaded drops them from the session.
    def test_regate_drops_a_rejected_sources_skills(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            skill_vault.build_index()
        idx = json.loads((self.vault / "index.json").read_text(encoding="utf-8"))
        alpha_id = next(s["id"] for s in idx["skills"] if s["name"] == "alpha")
        state = {"loaded_skills": [{"id": alpha_id, "name": "alpha"}, {"id": "gone:x", "name": "x"}],
                 "recommended_skill_ids": [alpha_id, "gone:x"]}
        with contextlib.redirect_stderr(io.StringIO()):
            kept = skill_router.regate_session_skills(json.loads(json.dumps(state)))
        self.assertEqual([s["id"] for s in kept["loaded_skills"]], [alpha_id])
        self.sources["repos"][0].update({"approved": False, "status": "rejected"})
        self._write_sources()
        with contextlib.redirect_stderr(io.StringIO()):
            after = skill_router.regate_session_skills(json.loads(json.dumps(state)))
        self.assertEqual(after["loaded_skills"], [])
        self.assertEqual(after["recommended_skill_ids"], [])


if __name__ == "__main__":
    unittest.main()
