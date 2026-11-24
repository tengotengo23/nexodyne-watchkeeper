"""P2-272: the one prompt-prefix grammar (reprompt/scripts/prompt_prefix.py) against the shared vectors.

panel/src/prompt-prefix.js is checked against the same file by test/prompt-prefix.test.mjs.
"""
from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VECTORS = REPO / "test" / "fixtures" / "prompt-prefix-vectors.json"
MODULE = REPO / "reprompt" / "scripts" / "prompt_prefix.py"


def _load():
    spec = importlib.util.spec_from_file_location("prompt_prefix_under_test", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class PromptPrefixVectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pp = _load()
        cls.data = json.loads(VECTORS.read_text(encoding="utf-8"))

    def test_constants_match_vectors(self):
        self.assertEqual(self.pp.AUTO_FLOOR_CHARS, self.data["auto_floor_chars"])
        self.assertEqual(self.pp.SHORT_REPLY_CHARS, self.data["short_reply_chars"])

    def test_every_vector(self):
        cases = self.data["cases"]
        self.assertGreaterEqual(len(cases), 40)
        for case in cases:
            expected = {k: case[k] for k in ("kind", "prefix", "body", "mode", "task_id")}
            with self.subTest(text=case["input"]):
                self.assertEqual(self.pp.classify(case["input"]), expected)

    def test_helpers_agree_with_classify(self):
        for case in self.data["cases"]:
            text = case["input"]
            with self.subTest(text=text):
                raw = self.pp.parse_raw(text)
                rw = self.pp.parse_rewrite(text)
                if case["kind"] == "raw":
                    self.assertEqual(raw, case["body"])
                if case["kind"] == "rewrite":
                    self.assertEqual(rw, (case["prefix"], case["body"], case["mode"]))
                if case["kind"] in ("none", "empty"):
                    self.assertIsNone(raw)
                    self.assertIsNone(rw)

    def test_every_prefix_has_a_vector(self):
        seen = {c["prefix"] for c in self.data["cases"] if c["kind"] == "rewrite"}
        self.assertEqual(seen, set(self.pp.PREFIX_MODE_MAP))
        raw_seen = {c["prefix"] for c in self.data["cases"] if c["kind"] == "raw"}
        self.assertEqual(raw_seen, {"raw", "rp-raw", "/wk raw"})

    def test_word_rule_vectors(self):
        """P2-273: more than 30 words rewrites a plain prompt; the same answers as panel/src/prompt-prefix.js."""
        self.assertEqual(self.pp.AUTO_OVER_WORDS, self.data["auto_over_words"])
        cases = self.data["word_cases"]
        self.assertGreaterEqual(len(cases), 20)
        for case in cases:
            with self.subTest(note=case["note"]):
                self.assertEqual(self.pp.word_count(case["input"]), case["words"])
                self.assertEqual(self.pp.wants_auto_rewrite(case["input"], self.data["auto_over_words"]), case["auto"])

    def test_word_rule_threshold_setting(self):
        long_text = " ".join(["word"] * 31)
        self.assertTrue(self.pp.wants_auto_rewrite(long_text))
        self.assertFalse(self.pp.wants_auto_rewrite(long_text, 0))
        self.assertFalse(self.pp.wants_auto_rewrite(long_text, 31))
        self.assertTrue(self.pp.wants_auto_rewrite(long_text, "30"))
        for value, want in ((None, 30), (True, 30), ("", 30), ("x", 30), (-1, 30), ("12.7", 12), (0, 0), (float("inf"), 30)):
            with self.subTest(value=value):
                self.assertEqual(self.pp.auto_over_words(value), want)

    def test_over_words_vectors(self):
        cases = self.data["over_words_cases"]
        self.assertGreaterEqual(len(cases), 20)
        for case in cases:
            with self.subTest(note=case["note"]):
                self.assertEqual(self.pp.auto_over_words(case["value"]), case["want"])

    def test_migrate_vectors(self):
        self.assertEqual(self.pp.SETTINGS_VERSION, 2)
        for case in self.data["migrate_cases"]:
            with self.subTest(note=case["note"]):
                before = json.dumps(case["in"], sort_keys=True)
                self.assertEqual(self.pp.migrate_settings(case["in"]), case["out"])
                self.assertEqual(json.dumps(case["in"], sort_keys=True), before)  # the input is not changed
        self.assertEqual(self.pp.migrate_settings({"settingsVersion": 2.0, "hookAutoAll": True})["hookAutoAll"], True)
        self.assertEqual(self.pp.migrate_settings(None), {"settingsVersion": 2})

    def test_store_moves_old_settings_once_and_keeps_later_choices(self):
        import sys
        import tempfile
        sys.path.insert(0, str(REPO / "reprompt"))
        from server.reprompt_engine import RePromptStore
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "settings.json").write_text(json.dumps({"claudeCodeRewrite": "prefix", "hookAutoAll": True}), encoding="utf-8")
            store = RePromptStore(tmp)
            got = store.load_settings()
            self.assertEqual((got["claudeCodeRewrite"], got["hookAutoAll"], got["settingsVersion"]), ("words", False, 2))
            store.save_settings({"hookAutoAll": True, "claudeCodeRewrite": "prefix"})
            on_disk = json.loads(Path(tmp, "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(on_disk["settingsVersion"], 2)
            got = store.load_settings()
            self.assertEqual((got["claudeCodeRewrite"], got["hookAutoAll"]), ("prefix", True))

    def test_cap_injected(self):
        cap = self.pp.cap_injected
        self.assertEqual(self.pp.INJECT_CAP_CHARS, 4000)
        self.assertEqual(cap("short"), "short")
        self.assertEqual(cap(None), "")
        exact = "x" * 4000
        self.assertEqual(cap(exact), exact)
        lines = "\n".join("line %04d " % i + "y" * 40 for i in range(200))   # about 10,000 characters
        out = cap(lines)
        body, _, note = out.partition("\n\n[")
        self.assertLessEqual(len(body), 4000)
        self.assertGreaterEqual(len(body), 2000)
        self.assertTrue(lines.startswith(body) and body.endswith("y"))         # cut at a line end
        self.assertIn("cut at 4,000 characters", note)
        one_line = "z" * 9000
        out = cap(one_line)
        self.assertTrue(out.startswith("z" * 4000) and not out.startswith("z" * 4001))

    def test_skill_labels_show_names_not_records(self):
        rec = {"id": "local-installed/graphify", "name": "graphify", "path": "/x/SKILL.md", "description": "d"}
        self.assertEqual(self.pp.skill_labels([rec, {"id": "good/a1"}, "plain", None, {"name": "  two\nlines "}]),
                         ["graphify", "good/a1", "plain"])
        self.assertEqual(self.pp.skill_labels([rec, {"name": "  two\nlines "}], limit=5), ["graphify", "two lines"])
        self.assertEqual(self.pp.skill_labels(None), [])
        self.assertNotIn("{", ", ".join(self.pp.skill_labels([rec] * 4)))

    def test_pasted_content_is_not_a_machine_turn(self):
        self.assertFalse(self.pp.is_machine_turn("<pasted_content>hello</pasted_content>"))
        self.assertTrue(self.pp.is_machine_turn("<task-notification>x"))


if __name__ == "__main__":
    unittest.main()
