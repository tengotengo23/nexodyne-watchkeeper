#!/usr/bin/env python3
"""P2-272 package A: whole-repo graph cap and coverage file, ego-subgraph time budget, graph hook outputs.

Temp WK_HOME and temp workspaces only; nothing touches ~/.wk or a real repo.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
HOOK = ROOT / "bin" / "wk-graph-hook.py"
PY = "/usr/bin/python3" if Path("/usr/bin/python3").exists() else sys.executable


def make_tree(base: Path, n: int) -> None:
    for i in range(n):
        d = base / f"pkg{i % 20}"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"mod{i}.py").write_text(f"def func_{i}(x):\n    return x + {i}\n\nclass Thing{i}:\n    pass\n", encoding="utf-8")


def fixture_graph(ws: Path, files: int = 1800, per_file: int = 8) -> None:
    nodes, links = [], []
    for f in range(files):
        fid = f"f{f}"
        nodes.append({"id": fid, "label": f"module_{f}.py", "type": "file", "file": f"pkg{f % 20}/module_{f}.py"})
        for k in range(per_file):
            nid = f"f{f}_n{k}"
            nodes.append({"id": nid, "label": f"handler_{f}_{k}", "type": "function", "file": f"pkg{f % 20}/module_{f}.py"})
            links.append({"source": fid, "target": nid, "relation": "contains"})
            if f > 0:
                links.append({"source": nid, "target": f"f{f - 1}_n{k}", "relation": "calls"})
    out = ws / "graphify-out"
    out.mkdir(parents=True, exist_ok=True)
    (out / "graph.json").write_text(json.dumps({"nodes": nodes, "links": links}), encoding="utf-8")


def run_hook(event: str, payload: dict, home: Path, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    # the shared Re-Prompt settings live in a temp folder next to WK_HOME, never the owner's real file
    env = dict(os.environ, WK_HOME=str(home), REPROMPT_DATA_DIR=str(home / "rp"), **(extra_env or {}))
    return subprocess.run([PY, str(HOOK), event], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=30)


class CapAndCoverage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name) / "ws"
        self.ws.mkdir()

    def test_more_than_250_files_all_indexed(self):
        from core.graph_bridge import _lightweight_ast_graph
        make_tree(self.ws, 300)
        g = _lightweight_ast_graph(self.ws)
        cov = g["wk_coverage"]
        self.assertEqual(cov["files_indexed"], 300)
        self.assertEqual(cov["files_total"], 300)
        self.assertFalse(cov["truncated"])

    def test_ceiling_from_env_is_honest(self):
        from core.graph_bridge import _lightweight_ast_graph, write_coverage
        make_tree(self.ws, 40)
        os.environ["WK_GRAPH_MAX_FILES"] = "10"
        try:
            g = _lightweight_ast_graph(self.ws)
        finally:
            del os.environ["WK_GRAPH_MAX_FILES"]
        self.assertEqual(g["wk_coverage"]["files_indexed"], 10)
        self.assertTrue(g["wk_coverage"]["truncated"])
        write_coverage(self.ws, g, dirty_count=3, mode="build")
        c = json.loads((self.ws / "graphify-out" / "wk-coverage.json").read_text())
        for k in ("files_indexed", "files_total", "built_at", "dirty_count", "mode", "truncated"):
            self.assertIn(k, c)
        self.assertTrue(c["truncated"])
        self.assertEqual(c["dirty_count"], 3)

    def test_skips_ignored_folders(self):
        from core.graph_bridge import _lightweight_ast_graph
        make_tree(self.ws, 5)
        (self.ws / "node_modules").mkdir()
        (self.ws / "node_modules" / "x.py").write_text("def x(): pass\n")
        self.assertEqual(_lightweight_ast_graph(self.ws)["wk_coverage"]["files_indexed"], 5)


class EgoBudget(unittest.TestCase):
    def test_ego_under_50ms_on_realistic_graph(self):
        with tempfile.TemporaryDirectory() as t:
            ws = Path(t)
            fixture_graph(ws)
            from core.graph_ego import build_ego_index
            self.assertTrue(build_ego_index(ws, json.loads((ws / "graphify-out" / "graph.json").read_text())))
            size = (ws / "graphify-out" / "graph.json").stat().st_size
            from core.graph_ego import ego_context
            ego_context(ws, "handler_900_3 module_900")  # warm the page cache
            best = min(self._time(ego_context, ws) for _ in range(5))
            print(f"\nego time {best * 1000:.1f} ms on {size // 1024} KiB graph", file=sys.stderr)
            self.assertLess(best, 0.05)
            text = ego_context(ws, "handler_900_3 module_900")
            self.assertTrue(text.startswith("[Graphify Structural Context]"))

    @staticmethod
    def _time(fn, ws):
        t0 = time.monotonic()
        fn(ws, "handler_900_3 module_900")
        return time.monotonic() - t0

    def test_index_and_json_paths_agree(self):
        from core.graph_ego import build_ego_index, ego_context
        with tempfile.TemporaryDirectory() as t:
            ws = Path(t)
            fixture_graph(ws, files=60)
            slow = ego_context(ws, "handler_30_2 module_30", budget_s=5.0)  # no index yet: JSON path
            build_ego_index(ws, json.loads((ws / "graphify-out" / "graph.json").read_text()))
            fast = ego_context(ws, "handler_30_2 module_30", budget_s=5.0)
            self.assertTrue(slow.startswith("[Graphify Structural Context]"))
            self.assertEqual(slow.splitlines()[:2], fast.splitlines()[:2])
            self.assertEqual(set(slow.splitlines()[2].split(", ")), set(fast.splitlines()[2].split(", ")))

    def test_neutral_without_graph_or_over_budget(self):
        from core.graph_ego import ego_context
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(ego_context(t, "anything here"), "")
            fixture_graph(Path(t), files=50)
            self.assertEqual(ego_context(t, "handler_3_1", budget_s=0.0), "")


class HookOutputs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "wk"
        self.home.mkdir()
        self.ws = Path(self.tmp.name) / "ws"
        self.ws.mkdir()
        self.pl = {"cwd": str(self.ws), "lastUserInput": "handler_5_2 module_5"}

    def test_kill_gives_neutral_everywhere(self):
        fixture_graph(self.ws, files=30)
        self.opt_in_turn_context()  # opted in, so the Stop switch is what keeps every path neutral
        (self.home / "KILL").write_text("1")
        for ev in ("SessionStart", "PreInvocation", "PostToolUse", "Stop"):
            r = run_hook(ev, self.pl, self.home)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(json.loads(r.stdout), {}, ev)
        self.assertFalse((self.ws / "graphify-out" / "wk-coverage.json").exists())

    def test_no_graph_is_neutral_and_builds_nothing(self):
        self.opt_in_turn_context()
        r = run_hook("PreInvocation", self.pl, self.home)
        self.assertEqual((r.returncode, json.loads(r.stdout)), (0, {}))
        self.assertFalse((self.ws / "graphify-out").exists())

    def opt_in_turn_context(self, value=True):
        (self.home / "rp").mkdir(exist_ok=True)
        (self.home / "rp" / "settings.json").write_text(json.dumps({"graphTurnContext": value}))

    def test_quiet_by_default_no_turn_context(self):
        # P2-273: quiet AST Graphify; per-turn graph context only when the owner opts in
        fixture_graph(self.ws, files=30)
        for setting in (None, False, "true", 1):
            if setting is not None:
                self.opt_in_turn_context(setting)
            r = run_hook("PreInvocation", self.pl, self.home)
            self.assertEqual((r.returncode, json.loads(r.stdout)), (0, {}), setting)

    def test_injection_shape_and_raw_mode(self):
        fixture_graph(self.ws, files=30)
        self.opt_in_turn_context()
        for env in ({}, {"WK_PROMPT_MODE": "raw"}):
            r = run_hook("PreInvocation", dict(self.pl, lastUserInput=":raw handler_5_2 module_5"), self.home, env)
            out = json.loads(r.stdout)
            sm = out["injectSteps"][0]["systemMessage"]
            self.assertTrue(sm["systemMessage"].startswith("[Graphify Structural Context]"))
            self.assertEqual(sm["metadata"]["user_markdown"], "")
            self.assertNotIn("type", out["injectSteps"][0])

    def test_post_tool_use_records_and_stop_prints_empty(self):
        pl = dict(self.pl, toolCall={"name": "write_to_file", "args": {"TargetFile": str(self.ws / "a.py")}})
        self.assertEqual(json.loads(run_hook("PostToolUse", pl, self.home).stdout), {})
        states = list((self.home / "graph-hook").glob("*/changed.json"))
        self.assertEqual(len(states), 1)
        self.assertEqual(json.loads(states[0].read_text())["files"], ["a.py"])
        # a read tool is not recorded
        run_hook("PostToolUse", dict(self.pl, toolCall={"name": "view_file", "args": {"path": str(self.ws / "b.py")}}), self.home)
        self.assertEqual(json.loads(states[0].read_text())["files"], ["a.py"])


if __name__ == "__main__":
    unittest.main()
