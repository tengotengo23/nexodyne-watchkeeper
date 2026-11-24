"""P2-272 P1-D: default_data_dir() resolves one shared store (temp HOME only)."""
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import reprompt_engine  # noqa: E402


class DataDirTest(unittest.TestCase):
    def test_order(self):
        with tempfile.TemporaryDirectory() as home:
            env = {k: v for k, v in os.environ.items() if k not in ("REPROMPT_DATA_DIR", "PLUGIN_DATA")}
            env["HOME"] = home
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(Path, "home", return_value=Path(home)):
                old = reprompt_engine.default_data_dir()
                self.assertTrue(str(old).endswith("re-prompt"))
                wk = Path(home) / ".gemini" / "antigravity" / "plugin_data" / "watchkeeper"
                wk.mkdir(parents=True)
                self.assertEqual(reprompt_engine.default_data_dir(), wk)
                with mock.patch.dict(os.environ, {"REPROMPT_DATA_DIR": str(Path(home) / "x")}):
                    self.assertEqual(reprompt_engine.default_data_dir(), Path(home) / "x")


if __name__ == "__main__":
    unittest.main()
