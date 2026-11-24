#!/usr/bin/env python3
"""P2-272 Phase 4 (stage 4A): the task splitter (core/dag_orchestrator.py).

Pure parts: triage vectors and timing, plan checks, cycles, waves, the evidence gate.
Runs: a stub `claude` (WK_CLAUDE_BIN) in temp git repos with a temp HOME and WK_HOME; no network, no real ~/.wk.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import dag_orchestrator as dag  # noqa: E402


def _node(nid: str, globs: list[str], deps: list[str] | None = None, **kv) -> dict:
    n = {"id": nid, "title": f"Step {nid}", "dependsOn": deps or [], "provider": "claude", "model": "sonnet",
         "effort": "medium", "ownedGlobs": globs, "interfaceContract": "", "verifyCmd": "true"}
    n.update(kv)
    return n


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=60)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # a zombie still answers kill(0); ask ps for the state (state column only, no arguments)
    r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")


def _remove_own_tmp(path: Path) -> None:
    """A6: remove only a folder this test made with mkdtemp, after checking that it lies inside the temporary folder."""
    import shutil
    base = Path(os.path.realpath(tempfile.gettempdir()))
    real = Path(os.path.realpath(path))
    if real == base or base not in real.parents or not real.name.startswith("wk-dag-test-"):
        raise AssertionError(f"not a folder this test made: {path}")
    shutil.rmtree(real)


class PureParts(unittest.TestCase):
    def test_triage_vectors_match_and_fast(self):
        vecs = dag.load_vectors()
        self.assertGreaterEqual(len(vecs), 10)
        for v in vecs:
            t0 = time.perf_counter()
            got = dag.triage(v["prompt"])
            ms = (time.perf_counter() - t0) * 1000
            self.assertEqual(got["route"], v["route"], v["prompt"])
            self.assertEqual(got["reason"], v["reason"], v["prompt"])
            self.assertLess(ms, 50, v["prompt"])
        long = "Refactor the panel and the server API, then update the tests.\n" * 400
        t0 = time.perf_counter()
        dag.triage(long)
        self.assertLess((time.perf_counter() - t0) * 1000, 50)

    def test_validate_plan_refuses_bad_schema(self):
        self.assertFalse(dag.validate_plan([])["ok"])
        self.assertFalse(dag.validate_plan("nodes")["ok"])
        bad = [_node("A", ["src/**"]), _node("b", ["/etc/**"]), _node("c", ["../x"]), _node("d", ["x"], provider="openai"),
               _node("e", ["x"], model="gpt"), _node("f", ["x"], effort="huge"), _node("g", ["x"], verifyCmd="a\nb"),
               _node("integration", ["x"])]
        v = dag.validate_plan(bad)
        self.assertFalse(v["ok"])
        self.assertEqual(v["nodes"], [])
        self.assertGreaterEqual(len(v["errors"]), 7)
        self.assertFalse(dag.validate_plan([_node("a", ["x"]), _node("a", ["y"])])["ok"])
        self.assertFalse(dag.validate_plan([_node("a", ["x"], ["zz"])])["ok"])
        self.assertFalse(dag.validate_plan([_node(f"n{i}", [f"d{i}/**"]) for i in range(21)])["ok"])
        ok = dag.validate_plan([_node("a", ["src/a.py"]), _node("b", ["docs/**"], ["a"], provider="gemini", model="gemini-3-pro")])
        self.assertTrue(ok["ok"], ok["errors"])
        self.assertEqual([n["id"] for n in ok["nodes"]], ["a", "b"])

    def test_cycles_refused(self):
        v = dag.validate_plan([_node("a", ["a/**"], ["c"]), _node("b", ["b/**"], ["a"]), _node("c", ["c/**"], ["b"])])
        self.assertFalse(v["ok"])
        self.assertIn("circle", " ".join(v["errors"]))
        self.assertFalse(dag.validate_plan([_node("a", ["a/**"], ["a"])])["ok"])
        self.assertIsNone(dag.find_cycle([_node("a", ["a"]), _node("b", ["b"], ["a"])]))

    def test_overlap_serialized_disjoint_parallel(self):
        nodes = dag.validate_plan([_node("a", ["src/**"]), _node("b", ["src/a.py"]), _node("c", ["docs/**"])])["nodes"]
        waves = dag.plan_waves(nodes)
        where = {nid: i for i, w in enumerate(waves) for nid in w}
        self.assertNotEqual(where["a"], where["b"], waves)
        self.assertEqual(where["a"], where["c"], waves)
        # when unsure (a glob at the top), serialize
        self.assertTrue(dag.globs_may_overlap("**", "docs/x.md"))
        self.assertTrue(dag.globs_may_overlap("src/*.py", "src/a.py"))
        self.assertFalse(dag.globs_may_overlap("src/**", "docs/**"))
        dep = dag.validate_plan([_node("a", ["a/**"]), _node("b", ["b/**"], ["a"])])["nodes"]
        self.assertEqual(dag.plan_waves(dep), [["a"], ["b"]])

    def test_gate_refuses_outside_and_deny(self):
        deny = dag.load_deny_globs()
        self.assertTrue(dag.gate_check(["src/a.py", "src/sub/b.py"], ["src/**"], deny)["ok"])
        g = dag.gate_check(["src/a.py", "README.md"], ["src/**"], deny, step="x")
        self.assertFalse(g["ok"])
        self.assertEqual(g["outside"], ["README.md"])
        self.assertIn("outside its own files", g["reason"])
        g = dag.gate_check(["src/.env"], ["src/**"], deny)
        self.assertFalse(g["ok"])
        self.assertEqual(g["denied"], ["src/.env"])
        self.assertIn("protected", g["reason"])
        self.assertFalse(dag.gate_check(["../etc/passwd"], ["**"], deny)["ok"])

    def test_gate_deny_ignores_letter_case(self):
        # N8: .ENV is denied like .env
        g = dag.gate_check([".ENV", "src/.Env"], ["**"], dag.load_deny_globs())
        self.assertFalse(g["ok"])
        self.assertEqual(g["denied"], [".ENV", "src/.Env"])

    def test_single_node_without_model(self):
        n = dag.single_node("Fix the typo\nmore", "npm test")
        self.assertEqual(n[0]["id"], "main-step")
        self.assertEqual(n[0]["ownedGlobs"], ["**"])
        self.assertTrue(dag.validate_plan(n)["ok"])

    def test_wk_cli_lists_dag(self):
        from core.wk_cli import run_wk_cli
        rc, out = run_wk_cli(["help"], str(ROOT))
        self.assertEqual(rc, 0)
        self.assertIn("dag", json.dumps(out))


class Runs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wk-dag-test-")).resolve()
        self.addCleanup(_remove_own_tmp, self.tmp)
        self.home = self.tmp / "home"
        self.wk = self.home / ".wk"
        self.wk.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("hello\n")
        _git(self.repo, "add", "README.md")
        c = _git(self.repo, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "first")
        self.assertEqual(c.returncode, 0, c.stderr)
        self.stub = self.tmp / "stub-claude.sh"
        self.pidfile = self.tmp / "stub.pid"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WK_")}
        self.env.update({"HOME": str(self.home), "WK_HOME": str(self.wk), "WK_CLAUDE_BIN": str(self.stub),
                         "WK_STEWARD_DIR": str(self.wk / "steward")})

    def _stub(self, body: str):
        self.stub.write_text("#!/bin/sh\ncat >/dev/null\n" + body)
        self.stub.chmod(self.stub.stat().st_mode | stat.S_IXUSR)

    def _ok_stub(self, rel: str = "src/a.py"):
        self._stub(f"mkdir -p \"$(dirname '{rel}')\"\necho 'print(1)' > '{rel}'\n"
                   "echo '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"changed one file\",\"total_cost_usd\":0}'\n")

    def _runner(self, **kv) -> dag.DagRunner:
        return dag.DagRunner(wk_home_dir=self.wk, env=self.env, poll_s=0.05, node_timeout_s=60, **kv)

    def test_not_a_repo(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        with self.assertRaises(ValueError):
            self._runner().plan("Fix a.py", plain, use_model=False)

    def test_full_pass_then_merge_by_click_and_decoys_survive(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, verify_cmd="test -f src/a.py", use_model=False)
        rid = man["id"]
        self.assertEqual(man["status"], "planned")
        self.assertTrue((self.wk / "dag" / rid / "manifest.json").is_file())
        # merge before the run: refused
        self.assertFalse(r.merge(rid)["ok"])
        # decoys under WK_HOME/worktrees: a task worktree, a dag-other-* folder, a plain folder
        wts = self.wk / "worktrees"
        wts.mkdir()
        task_wt = wts / "task-x"
        self.assertEqual(_git(self.repo, "worktree", "add", "-q", "-b", "wk/task-x", str(task_wt)).returncode, 0)
        other = wts / "dag-other-x"
        other.mkdir()
        (other / "keep.txt").write_text("keep")
        plain = wts / "plain"
        plain.mkdir()
        (plain / "keep.txt").write_text("keep")
        out = r.run(rid)
        self.assertEqual(out["status"], "passed", json.dumps(out, indent=1)[:2000])
        self.assertEqual(out["steps"]["main-step"]["state"], "passed")
        self.assertEqual(out["steps"]["main-step"]["changed"], ["src/a.py"])
        # nothing reached the owner's branch before the click
        self.assertFalse((self.repo / "src" / "a.py").exists())
        self.assertEqual(_git(self.repo, "symbolic-ref", "--short", "HEAD").stdout.strip(), "main")
        # the step folder is gone, the integration folder waits for the click
        self.assertFalse((wts / f"dag-{rid}-main-step").exists())
        self.assertTrue((wts / f"dag-{rid}").is_dir())
        # a manifest that names a foreign folder: cleanup leaves it alone
        man = r.manifest(rid)
        man["worktrees"].append(str(other))
        man["worktrees"].append(str(task_wt))
        man["branches"].append("wk/task-x")
        dag._write_json(self.wk / "dag" / rid / "manifest.json", man)
        m = r.merge(rid)
        self.assertTrue(m["ok"], m)
        self.assertTrue((self.repo / "src" / "a.py").is_file())
        self.assertEqual(r.manifest(rid)["status"], "merged")
        self.assertFalse((wts / f"dag-{rid}").exists())
        self.assertIn(str(other), m["cleanup"]["kept"])
        self.assertIn(str(task_wt), m["cleanup"]["kept"])
        for d in (task_wt, other, plain):
            self.assertTrue(d.is_dir(), d)
        self.assertTrue((other / "keep.txt").is_file())
        self.assertTrue((plain / "keep.txt").is_file())
        self.assertIn(str(task_wt), _git(self.repo, "worktree", "list").stdout)
        self.assertIn("wk/task-x", _git(self.repo, "branch", "--list", "wk/task-x").stdout)
        self.assertEqual(_git(self.repo, "branch", "--list", f"dag/{rid}/*").stdout.strip(), "")
        # never a push: the repo has no remote and merge did not ask for one
        self.assertEqual(_git(self.repo, "remote").stdout.strip(), "")

    def test_gate_failure_keeps_everything(self):
        self._stub("echo x > README.md\necho '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"r\"}'\n")
        r = self._runner()
        man = r.plan("Fix src/a.py", self.repo, use_model=False)
        man["nodes"][0]["ownedGlobs"] = ["src/**"]
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        out = r.run(man["id"])
        self.assertEqual(out["status"], "failed")
        self.assertIn("outside its own files", out["steps"]["main-step"]["reason"])
        self.assertTrue((self.wk / "worktrees" / f"dag-{man['id']}-main-step").is_dir())
        self.assertFalse(r.cleanup(man["id"])["ok"])
        self.assertTrue((self.wk / "worktrees" / f"dag-{man['id']}").is_dir())

    def test_stop_switch_mid_run_stops_groups_deletes_nothing(self):
        self._stub(f"echo $$ > '{self.pidfile}'\nexec sleep 30\n")
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, use_model=False)
        rid = man["id"]

        def flip():
            for _ in range(400):
                if self.pidfile.exists() and self.pidfile.read_text().strip():
                    break
                time.sleep(0.05)
            (self.wk / "KILL").write_text("stop\n")

        t = threading.Thread(target=flip)
        t.start()
        t0 = time.time()
        out = r.run(rid)
        t.join()
        self.assertLess(time.time() - t0, 25, "the run waited for the sleeping stub")
        self.assertEqual(out["status"], "stopped", out.get("message"))
        self.assertEqual(out["steps"]["main-step"]["state"], "stopped")
        pid = int(self.pidfile.read_text().strip())
        for _ in range(40):
            if not _alive(pid):
                break
            time.sleep(0.05)
        self.assertFalse(_alive(pid), "the stub claude still runs")
        self.assertTrue((self.wk / "worktrees" / f"dag-{rid}").is_dir())
        self.assertTrue((self.wk / "worktrees" / f"dag-{rid}-main-step").is_dir())
        self.assertTrue((self.wk / "dag" / rid / "manifest.json").is_file())
        self.assertIn(f"dag/{rid}/main-step", _git(self.repo, "branch", "--list", f"dag/{rid}/*").stdout)
        # the Stop switch still holds: no new run, no merge
        self.assertEqual(r.run(rid)["status"], "stopped")
        self.assertFalse(r.merge(rid)["ok"])

    def test_stop_switch_before_run(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, use_model=False)
        (self.wk / "KILL").write_text("stop\n")
        out = r.run(man["id"])
        self.assertEqual(out["status"], "stopped")
        self.assertFalse((self.wk / "worktrees" / f"dag-{man['id']}").exists())

    def test_planner_without_answer_gives_one_node(self):
        self._stub("echo 'not json'\n")
        r = self._runner()
        man = r.plan("Update panel/a.js and server/b.py, then add tests in test/c.mjs", self.repo)
        self.assertEqual(man["triage"]["route"], "plan")
        self.assertEqual([n["id"] for n in man["nodes"]], ["main-step"])
        self.assertIn("one step", man["plannerNote"])

    def test_planner_plan_is_checked_and_serialized(self):
        plan = {"nodes": [_node("api", ["server/**"]), _node("ui", ["server/ui/**"]), _node("docs", ["docs/**"]),
                          _node("lite", ["notes/**"], provider="gemini", model="gemini-3-pro")]}
        line = json.dumps({"type": "result", "subtype": "success", "result": json.dumps(plan)})
        (self.tmp / "answer.jsonl").write_text(line + "\n")
        self._stub(f"cat '{self.tmp / 'answer.jsonl'}'\n")
        r = self._runner()
        man = r.plan("Update panel/a.js and server/b.py, then add tests in test/c.mjs", self.repo)
        self.assertEqual(sorted(n["id"] for n in man["nodes"]), ["api", "docs", "lite", "ui"], man["plannerNote"])
        where = {nid: i for i, w in enumerate(man["waves"]) for nid in w}
        self.assertNotEqual(where["api"], where["ui"])
        self.assertEqual(where["api"], where["docs"])
        self.assertIn("Waiting for the click", man["message"])

    def test_gemini_step_is_queued_never_run(self):
        bindir = self.tmp / "stubbin"
        bindir.mkdir()
        marker = self.tmp / "agy-called"
        agy = bindir / "agy"
        agy.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        agy.chmod(0o755)
        self.env["PATH"] = f"{bindir}{os.pathsep}{self.env.get('PATH', '')}"
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add notes", self.repo, use_model=False)
        man["nodes"] = [_node("lite", ["notes/**"], provider="gemini", model="gemini-3-pro", verifyCmd="test -d notes")]
        man["waves"] = [["lite"]]
        man["steps"] = {"lite": {"state": "planned"}}
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        out = r.run(man["id"])
        self.assertEqual(out["status"], "waiting", out.get("message"))
        st = out["steps"]["lite"]
        self.assertEqual(st["state"], "queued")
        meta = json.loads((self.wk / "tasks" / st["taskId"] / "meta.json").read_text())
        self.assertIn("notes/**", json.dumps(meta))
        self.assertIn("test -d notes", json.dumps(meta))
        self.assertFalse(marker.exists(), "agy was called")


    # ---------------------------------------------------------------- P4 review fixes
    def _commit_stub(self, body: str):
        """A stub that commits in its own step folder (as a model might), then reports success."""
        self._stub(body + "\ngit add -A >/dev/null 2>&1\ngit -c user.name=t -c user.email=t@x commit -q -m x >/dev/null 2>&1\n"
                   "echo '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\",\"total_cost_usd\":0}'\n")

    def _plan_src(self, r):
        man = r.plan("Fix src/a.py", self.repo, use_model=False)
        man["nodes"][0]["ownedGlobs"] = ["src/**"]
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        return man["id"]

    def test_m1_committed_files_outside_or_denied_are_refused(self):
        self._commit_stub("mkdir -p src other\necho 'print(1)' > src/a.py\necho SECRET=1 > .env\necho x > other/x.txt")
        r = self._runner()
        rid = self._plan_src(r)
        out = r.run(rid)
        self.assertEqual(out["status"], "failed", out.get("message"))
        why = out["steps"]["main-step"]["reason"]
        self.assertIn(".env", why)
        self.assertIn("other/x.txt", why)
        integ = self.wk / "worktrees" / f"dag-{rid}"
        self.assertFalse((integ / ".env").exists())
        self.assertFalse((integ / "other").exists())

    def test_m1_in_scope_commit_passes(self):
        self._commit_stub("mkdir -p src\necho 'print(1)' > src/a.py")
        r = self._runner()
        rid = self._plan_src(r)
        out = r.run(rid)
        self.assertEqual(out["status"], "passed", out.get("message"))
        self.assertEqual(out["steps"]["main-step"]["changed"], ["src/a.py"])

    def test_m1_history_not_from_start_is_refused(self):
        self._commit_stub("git checkout -q --orphan z\ngit rm -rqf . >/dev/null 2>&1\nmkdir -p src\necho 'print(1)' > src/a.py")
        r = self._runner()
        rid = self._plan_src(r)
        out = r.run(rid)
        self.assertEqual(out["status"], "failed", out.get("message"))
        self.assertIn("does not start from the run's own commit", out["steps"]["main-step"]["reason"])

    def test_m1_link_is_refused(self):
        self._commit_stub("mkdir -p src\nln -s /etc/hosts src/l")
        r = self._runner()
        rid = self._plan_src(r)
        out = r.run(rid)
        self.assertEqual(out["status"], "failed", out.get("message"))
        self.assertIn("link or a sub-repository", out["steps"]["main-step"]["reason"])

    def _queued_gemini(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add notes", self.repo, use_model=False)
        man["nodes"] = [_node("lite", ["notes/**"], provider="gemini", model="gemini-3-pro", verifyCmd="test -f notes/a.md")]
        man["waves"] = [["lite"]]
        man["steps"] = {"lite": {"state": "planned"}}
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        out = r.run(man["id"])
        self.assertEqual(out["status"], "waiting", out.get("message"))
        return r, man["id"], out["steps"]["lite"]

    def _task_commit(self, base: str, body: str, *, orphan: bool = False) -> str:
        tw = self.tmp / f"tw-{len(list(self.tmp.glob('tw-*')))}"
        if orphan:
            tree = subprocess.run(["git", "-C", str(self.repo), "mktree"], input="", capture_output=True,
                                  text=True).stdout.strip()
            return _git(self.repo, "-c", "user.name=t", "-c", "user.email=t@x", "commit-tree", tree, "-m", "orphan").stdout.strip()
        self.assertEqual(_git(self.repo, "worktree", "add", "-q", "--detach", str(tw), base).returncode, 0)
        subprocess.run(["sh", "-c", body], cwd=tw, check=True)
        _git(tw, "add", "-A")
        self.assertEqual(_git(tw, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "task").returncode, 0)
        return _git(tw, "rev-parse", "HEAD").stdout.strip()

    def _set_meta(self, tid: str, **kv):
        p = self.wk / "tasks" / tid / "meta.json"
        meta = json.loads(p.read_text())
        meta.update(kv)
        p.write_text(json.dumps(meta))

    def test_m2_forged_task_metas_are_refused_and_a_real_commit_merges(self):
        r, rid, st = self._queued_gemini()
        tid, base = st["taskId"], st["taskBase"]
        self.assertRegex(base, r"^[0-9a-f]{40}$")
        cases = [
            ({"commit": base, "base": base}, "changed no files"),
            ({"commit": "abc"}, "not a full commit id"),
            ({"commit": "1" * 40}, "not in the repository"),
            ({"commit": self._task_commit(base, "", orphan=True), "base": "0" * 40}, "does not start from"),
            ({"commit": self._task_commit(base, "git mv README.md .env"), "base": base}, ".env"),
        ]
        for meta, want in cases:
            self._set_meta(tid, status="verified", **meta)
            out = r.run(rid)
            self.assertEqual(out["status"], "failed", (meta, out.get("message")))
            self.assertIn(want, out["steps"]["lite"]["reason"], meta)
        self.assertFalse((self.wk / "worktrees" / f"dag-{rid}" / ".env").exists())
        # meta.base is ignored: a forged base that equals the forged commit does not let a foreign commit in
        good = self._task_commit(base, "mkdir -p notes && echo hi > notes/a.md")
        self._set_meta(tid, status="verified", commit=good, base=good)
        out = r.run(rid)
        self.assertEqual(out["status"], "passed", out.get("message"))
        self.assertEqual(out["steps"]["lite"]["changed"], ["notes/a.md"])
        self.assertTrue((self.wk / "worktrees" / f"dag-{rid}" / "notes" / "a.md").is_file())

    def test_status_reports_task_status_but_never_saves_it(self):
        r, rid, st = self._queued_gemini()
        self.assertEqual(r.status(rid)["steps"]["lite"]["taskStatus"], "queued")
        saved = json.loads((self.wk / "dag" / rid / "manifest.json").read_text())
        self.assertNotIn("taskStatus", saved["steps"]["lite"])

    def test_m4_dead_runner_means_stopped(self):
        p = subprocess.Popen(["true"])
        p.wait()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, use_model=False)
        man["status"] = "running"
        man["runnerPid"] = p.pid
        man["steps"]["main-step"]["state"] = "running"
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        out = r.status(man["id"])
        self.assertEqual(out["status"], "stopped")
        self.assertIn("Stopped: the window closed or the process ended. Your work is kept in", out["message"])
        self.assertEqual(out["steps"]["main-step"]["state"], "stopped")

    def test_m4_new_run_clears_this_runs_stop(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, verify_cmd="test -f src/a.py", use_model=False)
        rid = man["id"]
        self.assertEqual(r.stop(rid)["status"], "stopped")
        self.assertTrue((self.wk / "dag" / rid / "STOP").exists())
        out = r.run(rid)
        self.assertEqual(out["status"], "passed", out.get("message"))
        self.assertFalse((self.wk / "dag" / rid / "STOP").exists())
        # the global Stop switch is never cleared by a run
        (self.wk / "KILL").write_text("stop\n")
        man2 = r.plan("Add src/b.py", self.repo, use_model=False)
        self.assertEqual(r.run(man2["id"])["status"], "stopped")
        self.assertTrue((self.wk / "KILL").exists())

    def test_s2_failed_integration_merge_is_undone_and_names_both_steps(self):
        self._stub("case \"$PWD\" in\n"
                   "  *-a) mkdir -p src; echo 'print(1)' > src/a.py ;;\n"
                   "  *-b) I=\"${PWD%-b}\"; echo side > \"$I/README.md\"; git -C \"$I\" -c user.name=t -c user.email=t@x commit -qam side;"
                   " echo mine > README.md ;;\nesac\n"
                   "echo '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\",\"total_cost_usd\":0}'\n")
        r = self._runner()
        man = r.plan("Two steps", self.repo, use_model=False)
        man["nodes"] = [_node("a", ["src/**"]), _node("b", ["README.md"], ["a"])]
        man["waves"] = [["a"], ["b"]]
        man["steps"] = {"a": {"state": "planned"}, "b": {"state": "planned"}}
        dag._write_json(self.wk / "dag" / man["id"] / "manifest.json", man)
        out = r.run(man["id"])
        self.assertEqual(out["steps"]["a"]["state"], "passed", out.get("message"))
        self.assertEqual(out["steps"]["b"]["state"], "failed")
        self.assertIn("Step b did not fit with the steps already joined (a)", out["steps"]["b"]["reason"])
        integ = self.wk / "worktrees" / f"dag-{man['id']}"
        self.assertNotEqual(_git(integ, "rev-parse", "-q", "--verify", "MERGE_HEAD").returncode, 0)
        self.assertEqual((integ / "README.md").read_text(), "side\n")

    def test_s3_failed_owner_merge_is_undone(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, verify_cmd="test -f src/a.py", use_model=False)
        self.assertEqual(r.run(man["id"])["status"], "passed")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "a.py").write_text("print(2)\n")
        _git(self.repo, "add", "src/a.py")
        self.assertEqual(_git(self.repo, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "mine").returncode, 0)
        head = _git(self.repo, "rev-parse", "HEAD").stdout.strip()
        out = r.merge(man["id"])
        self.assertFalse(out["ok"])
        self.assertIn("The merge did not fit; your branch is as it was; the work is in", out["message"])
        self.assertNotEqual(_git(self.repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").returncode, 0)
        self.assertEqual(_git(self.repo, "rev-parse", "HEAD").stdout.strip(), head)
        self.assertEqual((self.repo / "src" / "a.py").read_text(), "print(2)\n")
        self.assertEqual(_git(self.repo, "status", "--porcelain").stdout.strip(), "")

    def test_merge_refuses_detached_head(self):
        self._ok_stub()
        r = self._runner()
        man = r.plan("Add src/a.py", self.repo, verify_cmd="test -f src/a.py", use_model=False)
        self.assertEqual(r.run(man["id"])["status"], "passed")
        _git(self.repo, "checkout", "-q", "--detach")
        out = r.merge(man["id"])
        self.assertFalse(out["ok"])
        self.assertIn("detached HEAD", out["message"])


if __name__ == "__main__":
    unittest.main()
