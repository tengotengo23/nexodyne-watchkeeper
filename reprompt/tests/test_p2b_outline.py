#!/usr/bin/env python3
"""P2-272 (B): outline-first loading.

A hook shows at most 2 skills per prompt, each as name, one-line description, a headings outline (about 600
characters) and the full path, never a whole SKILL.md. The shown state clears on Claude Code SessionStart with
source clear or compact. Every child runs through core/watchdog.run_in_group in a temp store and WK_HOME.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
REPROMPT = ROOT / "reprompt"
for p in (str(ROOT), str(REPROMPT), str(REPROMPT / "scripts"), str(Path(__file__).resolve().parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

import skill_router  # noqa: E402
from core.watchdog import run_in_group  # noqa: E402
from server.reprompt_engine import RePromptStore  # noqa: E402
from test_skill_autosync import _write_synthetic_vault  # noqa: E402

BIG_SIZE = 50920
BODY_MARK = "BODYTEXT-SHOULD-NEVER-APPEAR"


def _big_skill(path: Path, size: int = BIG_SIZE) -> None:
    """A SKILL.md of exactly `size` bytes: frontmatter, many headings, long bodies, a fenced block with a '#'."""
    path.parent.mkdir(parents=True, exist_ok=True)
    parts = ["---\nname: big\ndescription: A very large skill used to test the outline cap.\n---\n# Big skill\n"]
    i = 0
    while sum(len(x) for x in parts) < size - 2000:
        i += 1
        parts.append(f"## Section {i} about a careful step\n")
        parts.append(f"### Detail {i}\n")
        parts.append((BODY_MARK + " lorem ipsum dolor sit amet. ") * 12 + "\n")
        parts.append("```\n# not a heading inside a fence\n```\n")
    text = "".join(parts)
    text += "x" * (size - len(text.encode("utf-8")))
    path.write_text(text, encoding="utf-8")
    assert path.stat().st_size == size


def _skill(name: str, path: Path) -> dict:
    return {"id": f"r:{name}", "name": name, "domain": "design-ux", "repo": "o/r", "tier": 1,
            "description": f"{name} does one plain thing.\nSecond line that must not show.", "path": str(path)}


def _block_for(text: str, name: str) -> str:
    """The lines of one skill's entry in a directives block."""
    out, on = [], False
    for line in text.splitlines():
        if line.startswith("  - **"):
            on = line.startswith(f"  - **{name}**")
        elif not line.startswith("    "):
            on = False
        if on:
            out.append(line)
    return "\n".join(out)


class OutlineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="wk-p2b-outline-")
        # P2-272 B-fix (must-fix 1): skill_outline reads only files under the vault's repos and the local skills
        # folders, so the test skills live in a temp vault's repos/<slug>/ (the same place real skills live).
        vault = Path(self._tmp.name) / "vault"
        self.base = vault / "repos" / "o-r"
        self.base.mkdir(parents=True)
        # Only approved repos/<slug> are outline roots (must-fix 1), so the fixture source o-r is approved.
        (vault / "sources.json").write_text(json.dumps({"version": 2, "repos": [
            {"slug": "o-r", "repo": "o/r", "url": "https://github.com/o/r.git", "tier": 1, "approved": True,
             "status": "approved"}]}), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"REPROMPT_SKILL_VAULT_DIR": str(vault)})
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_largest_skill_injects_at_most_about_1000_chars(self) -> None:
        big = self.base / "big" / "SKILL.md"
        _big_skill(big)
        text = skill_router.format_skill_outline_directives({"load_skills": [_skill("big", big)]})
        block = _block_for(text, "big")
        self.assertLessEqual(len(block), 1000, block)
        self.assertNotIn(BODY_MARK, text)
        self.assertNotIn("not a heading inside a fence", text)
        # A multi-line description is collapsed to one capped line (never a second line of its own).
        about = [ln for ln in block.splitlines() if "one plain thing" in ln]
        self.assertEqual(len(about), 1, block)
        self.assertLessEqual(len(about[0].strip()), 200, about[0])
        self.assertIn(str(big), text)
        self.assertIn("Section 1 about a careful step", text)
        self.assertLessEqual(len(skill_router.skill_outline(big)), skill_router.OUTLINE_MAX_CHARS + 2)
        # Must-fix 2: third-party outlines are framed as reference, not as directives (old heading retired).
        self.assertTrue(text.startswith(skill_router.OUTLINE_HEADING))
        self.assertNotIn("Skill Directives", text)
        self.assertIn("**Load", text)

    def test_at_most_two_skills_per_prompt(self) -> None:
        skills = []
        for n in ("a1", "a2", "a3", "a4"):
            p = self.base / n / "SKILL.md"
            p.parent.mkdir(parents=True)
            p.write_text(f"# {n}\n## Use\nbody\n", encoding="utf-8")
            skills.append(_skill(n, p))
        text = skill_router.format_skill_outline_directives({"load_skills": skills})
        self.assertEqual(text.count("\n  - **"), 2)
        self.assertIn("**a1**", text)
        self.assertIn("**a2**", text)
        self.assertNotIn("**a3**", text)

    def test_record_injected_skills_writes_latest(self) -> None:
        wk = self.base / "wk"
        old = os.environ.get("WK_HOME")
        os.environ["WK_HOME"] = str(wk)
        try:
            skill_router.record_injected_skills("s/1", [{"id": "x:a"}, {"name": "b"}], host="claude")
        finally:
            if old is None:
                os.environ.pop("WK_HOME", None)
            else:
                os.environ["WK_HOME"] = old
        d = wk / "runtime" / "skills-injected"
        latest = json.loads((d / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["count"], 2)
        self.assertEqual(latest["ids"], ["x:a", "b"])
        self.assertTrue((d / "s_1.json").is_file())


class HookTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="wk-p2b-hooks-")
        root = Path(self._tmp.name)
        self.vault = root / "vault"
        self.data = root / "data"
        self.wk = root / "wk"
        self.wk.mkdir()
        # The hook's double-registration guard keeps markers in the temp folder; give each test its own.
        (root / "tmp").mkdir()
        _write_synthetic_vault(self.vault)
        index = json.loads((self.vault / "index.json").read_text(encoding="utf-8"))
        stitch = next(s for s in index["skills"] if s["name"] == "stitch-ui")
        _big_skill(Path(stitch["path"]))
        RePromptStore(self.data).save_settings(
            {"provider": "offline_template", "enableSkillRouting": True, "hookAutoAll": False}
        )
        env = os.environ.copy()
        env.pop("REPROMPT_INTERNAL_CALL", None)
        env.pop("WK_SUBAGENT_ACTIVE", None)
        env.update({"REPROMPT_SKILL_VAULT_DIR": str(self.vault), "REPROMPT_DATA_DIR": str(self.data),
                    "WK_HOME": str(self.wk), "PYTHONDONTWRITEBYTECODE": "1",
                    "TMPDIR": str(root / "tmp")})
        self.env = env

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, script: Path, payload: dict) -> dict:
        r = run_in_group([sys.executable, str(script)], timeout=30, env=self.env, input=json.dumps(payload),
                         register=False, wk_home=str(self.wk))
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout or "{}")

    def _latest(self) -> dict:
        return json.loads((self.wk / "runtime" / "skills-injected" / "latest.json").read_text(encoding="utf-8"))

    def test_hooks_inject_outline_not_body(self) -> None:
        prompt = "Design a responsive WCAG UI wireframe layout and typography scale"
        agy = self._run(REPROMPT / "scripts" / "reprompt_skill_hook.py", {"conversationId": "c1", "lastUserInput": prompt})
        msg = agy["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn(skill_router.OUTLINE_HEADING, msg)  # must-fix 2: the outline heading replaced it
        self.assertIn("stitch-ui", msg)
        self.assertNotIn(BODY_MARK, msg)
        self.assertLessEqual(len(_block_for(msg, "stitch-ui")), 1000)
        self.assertLessEqual(msg.count("\n  - **"), 2)
        self.assertGreaterEqual(self._latest()["count"], 1)

        cc = self._run(REPROMPT / "claude-code-plugin" / "bin" / "run-inline-hook.py", {"session_id": "s1", "prompt": prompt})
        ctx = json.dumps(cc)
        self.assertIn("stitch-ui", ctx)
        self.assertNotIn(BODY_MARK, ctx)
        self.assertEqual(self._latest()["session"], "s1")
        self.assertGreaterEqual(self._latest()["count"], 1)

    def test_session_reset_on_clear_and_compact_only(self) -> None:
        hook = REPROMPT / "claude-code-plugin" / "bin" / "run-inline-hook.py"
        reset = REPROMPT / "claude-code-plugin" / "bin" / "skill-session-reset.py"
        prompt = "Build a WCAG accessibility UI wireframe layout with typography and color palette"
        store = lambda: RePromptStore(self.data)  # noqa: E731

        self._run(hook, {"session_id": "s2", "prompt": prompt})
        self.assertTrue(store().get_session("s2").get("loaded_skills"))
        self.assertEqual(self._run(reset, {"session_id": "s2", "source": "startup"}), {})
        self.assertTrue(store().get_session("s2").get("loaded_skills"), "startup keeps the state")

        for source in ("clear", "compact"):
            self._run(hook, {"session_id": "s2", "prompt": prompt + " " + source})
            self.assertTrue(store().get_session("s2").get("loaded_skills"))
            self.assertEqual(self._run(reset, {"session_id": "s2", "source": source}), {})
            self.assertEqual(store().get_session("s2").get("loaded_skills"), [], source)
            self.assertEqual(self._latest()["count"], 0)

        # After a clear, the same skill shows again (new wording: an identical prompt within 30 s is the
        # hook's own double-registration guard, not the shown-state).
        again = json.dumps(self._run(hook, {"session_id": "s2", "prompt": prompt + " again"}))
        self.assertIn("stitch-ui", again)

    def test_reset_under_stop_switch_changes_nothing(self) -> None:
        hook = REPROMPT / "claude-code-plugin" / "bin" / "run-inline-hook.py"
        reset = REPROMPT / "claude-code-plugin" / "bin" / "skill-session-reset.py"
        self._run(hook, {"session_id": "s3", "prompt": "Design a responsive WCAG UI wireframe layout"})
        before = RePromptStore(self.data).get_session("s3")
        (self.wk / "KILL").write_text("", encoding="utf-8")
        self.assertEqual(self._run(reset, {"session_id": "s3", "source": "clear"}), {})
        self.assertEqual(RePromptStore(self.data).get_session("s3"), before)


if __name__ == "__main__":
    unittest.main()
