#!/usr/bin/env python3
"""P2-272 B-fix (should-fix 11): a golden test for the merged router.

tests/fixtures/skill-router-golden.json holds what the pre-merge core/skill_router.py selected for a fixed manifest
and fixed prompts (plain matches, +pin, @pin, -suppress, Gemini picks, ranking boosts, the quarantine role).
Today's core.skill_router.select_all_matching_skills must pick the same skills in the same order. An intended change
is recorded per case as "known_difference" (with "new" and "why"), never by loosening this test.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import skill_router as core_router  # noqa: E402

GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "skill-router-golden.json").read_text(encoding="utf-8"))


class RouterGoldenTests(unittest.TestCase):
    def test_fixture_covers_pins_suppress_gemini_boosts_and_quarantine(self) -> None:
        cases = GOLDEN["cases"]
        self.assertGreaterEqual(len(cases), 15)
        prompts = " ".join(c["prompt"] for c in cases)
        for mark in ("+skill:", "@skill:", "-skill:"):
            self.assertIn(mark, prompts)
        self.assertTrue(any(c.get("gemini_selected") for c in cases))
        self.assertTrue(any(c.get("ranking_boosts") for c in cases))
        self.assertTrue(any(c.get("agent_role") == "quarantine" for c in cases))

    def test_today_matches_the_pre_merge_router(self) -> None:
        manifest = {"skills": GOLDEN["skills"]}
        for c in GOLDEN["cases"]:
            kw = {k: c[k] for k in ("agent_role", "gemini_selected", "ranking_boosts") if k in c}
            got = [s["name"] for s in core_router.select_all_matching_skills(c["prompt"], manifest, **kw)]
            known = c.get("known_difference")
            want = known["new"] if known else c["old"]
            self.assertEqual(got, want, f"{c['prompt']!r} {kw}: old router picked {c['old']}")


if __name__ == "__main__":
    unittest.main()
