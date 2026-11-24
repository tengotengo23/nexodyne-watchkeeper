#!/usr/bin/env python3
"""The task splitter (P2-272 Phase 4, spec 3.9): fast triage, plan checks, waves, the evidence gate and the run engine.

Pure functions first (triage, validate_plan, find_cycle, plan_waves, globs_may_overlap, gate_check); then DagRunner,
which takes its process runner as an argument (default: core.watchdog.run_in_group, so every child process runs in its
own process group and is listed in the watchdog registry). The JS twin of the pure parts is bin/dag-lib.mjs; both read
test/fixtures/dag-triage-vectors.json.

Canon (line 65): Watchkeeper never runs agy or Gemini. A Gemini step only queues a wk-task for Antigravity.
Worktrees: every run lists what it made in WK_HOME/dag/<id>/manifest.json. Cleanup removes only manifest paths under
WK_HOME/worktrees/dag-<id>, only with `git worktree remove` and `git branch -d`, and only after the run passed.
The Stop switch (WK_HOME/KILL) and the run's own STOP are read before each wave and each step; mid-run they stop the running groups
and delete nothing. A 'running' manifest whose process ended is reported as stopped (M4).
"""
from __future__ import annotations

import json
import os
import copy
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"
VECTORS = ROOT / "test" / "fixtures" / "dag-triage-vectors.json"

PROVIDERS = ("claude", "gemini")
CLAUDE_MODELS = ("sonnet", "opus", "fable", "haiku")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
NODE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
RUN_ID = re.compile(r"^\d{8}-\d{6}-[a-f0-9]{4}$")
RESERVED_IDS = ("integration",)
MAX_NODES = 20
INTEGRATION = "integration"
LIMITS_FILE = ROOT / "core" / "dag-limits.json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
BAD_MODES = ("160000", "120000")


def planner_timeout_s(path: str | Path = LIMITS_FILE) -> float:
    """S7: the one time limit for the planner, read by the engine and the panel (core/dag-limits.json)."""
    try:
        v = float(json.loads(Path(path).read_text(encoding="utf-8")).get("plannerTimeoutS", 300))
        return v if 5 <= v <= 3600 else 300.0
    except Exception:
        return 300.0


def proc_start(pid: int) -> str:
    """M4: the process start time as `ps -o lstart=` prints it; '' when the process is gone."""
    try:
        r = subprocess.run(["ps", "-o", "lstart=", "-p", str(int(pid))], capture_output=True, text=True, timeout=5)
        return (r.stdout or "").strip() if r.returncode == 0 else ""
    except Exception:
        return ""

# ---------------------------------------------------------------- fast triage (pure, no model call; same rules as bin/dag-lib.mjs)
_FILE_RE = re.compile(
    r"(?:^|[\s`'\"(])([A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)*\.(?:py|mjs|cjs|js|ts|tsx|jsx|json|md|css|html|sh|yml|yaml|toml|swift|kt|go|rs|rb|java|c|h|cpp|txt))(?![A-Za-z0-9_])"
)
_LIST_RE = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+\S")
_SEQ_RE = re.compile(r"\b(?:then|after that|afterwards|finally|end-to-end|step by step|followed by)\b")
_VERB_RE = re.compile(
    r"\b(add|build|create|implement|fix|refactor|rename|migrate|update|change|write|remove|delete|move|replace|wire|port|split|integrate|deploy|test|make|show)\b"
)
_AREAS = (
    ("ui", re.compile(r"\b(?:ui|frontend|front-end|panel|css|html|page|screen|webview)\b")),
    ("backend", re.compile(r"\b(?:server|backend|back-end|api|endpoint|route)\b")),
    ("db", re.compile(r"\b(?:database|db|schema|migration|sql|sqlite)\b")),
    ("tests", re.compile(r"\b(?:tests?|test suite)\b")),
    ("docs", re.compile(r"\b(?:docs|documentation|readme)\b")),
    ("cli", re.compile(r"\b(?:cli|command line|terminal)\b")),
)
_QWORDS = ("what", "why", "how", "where", "when", "who", "which", "is", "are", "can", "could", "does", "do",
           "should", "would", "explain", "whats")


def triage(prompt: Any) -> dict[str, Any]:
    """'single' (one route) or 'plan' (multi-step or cross-area). Pure and fast: a few regular expressions."""
    text = str(prompt or "").strip()
    low = text.lower()
    if not low:
        return {"route": "single", "reason": "empty"}
    first = re.sub(r"[^a-z']", "", low.split()[0]) if low.split() else ""
    question = low.endswith("?") or first in _QWORDS
    files = sorted(set(_FILE_RE.findall(text)))
    items = sum(1 for line in text.splitlines() if _LIST_RE.match(line))
    seq = len(_SEQ_RE.findall(low))
    verbs = len(set(_VERB_RE.findall(low)))
    areas = [name for name, rx in _AREAS if rx.search(low)]
    if question and items < 2:
        return {"route": "single", "reason": "question"}
    if items >= 2 and verbs >= 1:
        return {"route": "plan", "reason": "list of steps"}
    if len(files) >= 2 and verbs >= 1:
        return {"route": "plan", "reason": "several files"}
    if len(areas) >= 2 and verbs >= 1:
        return {"route": "plan", "reason": "several areas"}
    if seq >= 1 and verbs >= 2:
        return {"route": "plan", "reason": "several steps"}
    return {"route": "single", "reason": "one file" if len(files) == 1 else "simple task"}


def load_vectors(path: str | Path = VECTORS) -> list[dict[str, Any]]:
    return json.loads(Path(path).read_text(encoding="utf-8"))["vectors"]


# ---------------------------------------------------------------- globs (the same reading as bin/lib.mjs globBody)
def glob_body(g: str) -> str:
    s, i = "", 0
    while i < len(g):
        c = g[i]
        if c == "*" and g[i + 1:i + 2] == "*":
            if g[i + 2:i + 3] == "/":
                s += "(?:.*/)?"
                i += 3
                continue
            s += ".*"
            i += 2
            continue
        if c == "*":
            s += "[^/]*"
        elif c == "?":
            s += "[^/]"
        else:
            s += re.escape(c)
        i += 1
    return s


def owned_re(g: str) -> re.Pattern:
    """An owned glob is anchored at the repository root (as wk-task --allow)."""
    return re.compile("^" + glob_body(g) + "$")


def deny_re(g: str) -> re.Pattern:
    """A deny glob matches at any folder level (as bin/lib.mjs glob2re)."""
    body = glob_body(g)
    if body.startswith("(?:.*/)?"):
        body = body[len("(?:.*/)?"):]
    return re.compile("(^|/)" + body + "$", re.IGNORECASE)


def _literal_prefix(g: str) -> str:
    m = re.search(r"[*?\[]", g)
    return g if m is None else g[:m.start()]


def globs_may_overlap(a: str, b: str) -> bool:
    """Conservative: two anchored globs may match one path unless their literal prefixes part ways."""
    pa, pb = _literal_prefix(a), _literal_prefix(b)
    return pa.startswith(pb) or pb.startswith(pa)


def nodes_may_overlap(x: dict[str, Any], y: dict[str, Any]) -> bool:
    return any(globs_may_overlap(a, b) for a in x.get("ownedGlobs", []) for b in y.get("ownedGlobs", []))


# ---------------------------------------------------------------- the plan: schema, cycles, waves
def _bad_glob(g: Any) -> bool:
    return (not isinstance(g, str) or not g.strip() or len(g) > 200 or g.startswith("/") or "\\" in g
            or "\n" in g or ".." in g.split("/"))


def validate_plan(nodes: Any) -> dict[str, Any]:
    """Check every node's fields; returns {ok, errors[], nodes} with nodes cleaned (strings trimmed)."""
    errs: list[str] = []
    if not isinstance(nodes, list) or not nodes:
        return {"ok": False, "errors": ["The plan has no steps."], "nodes": []}
    if len(nodes) > MAX_NODES:
        return {"ok": False, "errors": [f"The plan has {len(nodes)} steps; the most is {MAX_NODES}."], "nodes": []}
    out: list[dict[str, Any]] = []
    ids: set[str] = set()
    for i, n in enumerate(nodes):
        where = f"Step {i + 1}"
        if not isinstance(n, dict):
            errs.append(f"{where} is not an object.")
            continue
        nid = n.get("id")
        if not isinstance(nid, str) or not NODE_ID.match(nid) or nid in RESERVED_IDS:
            errs.append(f"{where} has a bad id (lower-case letters, digits and hyphens, at most 40).")
            continue
        where = f"Step {nid}"
        if nid in ids:
            errs.append(f"{where} appears twice.")
        ids.add(nid)
        title = n.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            errs.append(f"{where} needs a title of 1 to 200 characters.")
        deps = n.get("dependsOn", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            errs.append(f"{where}: dependsOn must be a list of step ids.")
            deps = []
        prov = n.get("provider")
        if prov not in PROVIDERS:
            errs.append(f"{where}: provider must be claude or gemini.")
        model = n.get("model")
        if prov == "claude" and model not in CLAUDE_MODELS:
            errs.append(f"{where}: a Claude step's model must be one of {', '.join(CLAUDE_MODELS)}.")
        if prov == "gemini" and (not isinstance(model, str) or not model.strip() or len(model) > 60):
            errs.append(f"{where}: a Gemini step needs a model name.")
        if n.get("effort") not in EFFORTS:
            errs.append(f"{where}: effort must be one of {', '.join(EFFORTS)}.")
        globs = n.get("ownedGlobs")
        if not isinstance(globs, list) or not globs or len(globs) > 20 or any(_bad_glob(g) for g in globs):
            errs.append(f"{where}: ownedGlobs must list 1 to 20 relative paths or globs inside the repository.")
            globs = []
        contract = n.get("interfaceContract", "")
        if not isinstance(contract, str) or len(contract) > 2000:
            errs.append(f"{where}: interfaceContract must be text of at most 2000 characters.")
            contract = ""
        vcmd = n.get("verifyCmd")
        if not isinstance(vcmd, str) or not vcmd.strip() or len(vcmd) > 500 or "\n" in vcmd or "\r" in vcmd:
            errs.append(f"{where}: verifyCmd must be one line of 1 to 500 characters.")
        out.append({"id": nid, "title": str(title or "").strip(), "dependsOn": list(dict.fromkeys(deps)),
                    "provider": prov, "model": str(model or "").strip(), "effort": n.get("effort"),
                    "ownedGlobs": [g.strip() for g in globs], "interfaceContract": contract,
                    "verifyCmd": str(vcmd or "").strip()})
    for n in out:
        for d in n["dependsOn"]:
            if d == n["id"]:
                errs.append(f"Step {n['id']} depends on itself.")
            elif d not in ids:
                errs.append(f"Step {n['id']} depends on {d}, which is not in the plan.")
    if not errs:
        cyc = find_cycle(out)
        if cyc:
            errs.append("The steps wait for each other in a circle: " + " -> ".join(cyc) + ".")
    return {"ok": not errs, "errors": errs, "nodes": out if not errs else []}


def find_cycle(nodes: list[dict[str, Any]]) -> list[str] | None:
    deps = {n["id"]: [d for d in n.get("dependsOn", [])] for n in nodes}
    color: dict[str, int] = {k: 0 for k in deps}
    stack: list[str] = []

    def visit(u: str) -> list[str] | None:
        color[u] = 1
        stack.append(u)
        for v in deps.get(u, []):
            if v not in color:
                continue
            if color[v] == 1:
                return stack[stack.index(v):] + [v]
            if color[v] == 0:
                c = visit(v)
                if c:
                    return c
        stack.pop()
        color[u] = 2
        return None

    for k in deps:
        if color[k] == 0:
            c = visit(k)
            if c:
                return c
    return None


def plan_waves(nodes: list[dict[str, Any]]) -> list[list[str]]:
    """Topological levels; inside a level, steps whose owned files could meet go to the next sub-wave (serialize)."""
    by = {n["id"]: n for n in nodes}
    level: dict[str, int] = {}

    def lv(u: str) -> int:
        if u not in level:
            level[u] = 1 + max((lv(d) for d in by[u]["dependsOn"]), default=-1)
        return level[u]

    for n in nodes:
        lv(n["id"])
    waves: list[list[str]] = []
    for L in range(max(level.values(), default=-1) + 1):
        subs: list[list[str]] = []
        for n in nodes:
            if level[n["id"]] != L:
                continue
            for s in subs:
                if not any(nodes_may_overlap(n, by[o]) for o in s):
                    s.append(n["id"])
                    break
            else:
                subs.append([n["id"]])
        waves.extend(subs)
    return waves


def single_node(task: str, verify_cmd: str = "true", globs: list[str] | None = None) -> list[dict[str, Any]]:
    """The plan when there is no model answer: one Claude step that owns the repository."""
    title = (str(task or "").strip().splitlines() or ["Task"])[0][:200] or "Task"
    return [{"id": "main-step", "title": title, "dependsOn": [], "provider": "claude", "model": "opus", "effort": "high",
             "ownedGlobs": globs or ["**"], "interfaceContract": "", "verifyCmd": verify_cmd}]


# ---------------------------------------------------------------- the evidence gate
def load_deny_globs(gates_file: str | Path | None = None) -> list[str]:
    f = Path(gates_file) if gates_file else ROOT / "config" / "gates.json"
    try:
        g = json.loads(f.read_text(encoding="utf-8")).get("denyPathGlobs", [])
        return [x for x in g if isinstance(x, str)]
    except Exception:
        return ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/.ssh/**", "**/keys/**"]


def gate_check(changed: list[str], owned_globs: list[str], deny_globs: list[str], *, step: str = "") -> dict[str, Any]:
    """Every changed file must lie inside the step's own globs and outside the deny list."""
    who = f"Step {step}" if step else "The step"
    owned = [owned_re(g) for g in owned_globs]
    deny = [deny_re(g) for g in deny_globs]
    outside, denied, odd = [], [], []
    for f in changed:
        p = str(f).replace("\\", "/")
        if not p or p.startswith("/") or ".." in p.split("/"):
            odd.append(p)
            continue
        if any(r.search(p) for r in deny):
            denied.append(p)
        if not any(r.match(p) for r in owned):
            outside.append(p)
    reasons = []
    if odd:
        reasons.append(f"{who} named files outside the repository: {', '.join(odd[:10])}.")
    if denied:
        reasons.append(f"{who} changed protected files (gates.json deny list): {', '.join(denied[:10])}.")
    if outside:
        reasons.append(f"{who} changed files outside its own files ({', '.join(owned_globs)}): {', '.join(outside[:10])}.")
    return {"ok": not reasons, "outside": outside, "denied": denied, "odd": odd, "reason": " ".join(reasons)}


# ---------------------------------------------------------------- files of a run
def _iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def wk_home(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()


def new_run_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()


def run_dir(home: Path, run_id: str) -> Path:
    if not RUN_ID.match(str(run_id)):
        raise ValueError("bad run id")
    return home / "dag" / run_id


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def list_runs(home: Path) -> list[str]:
    d = home / "dag"
    if not d.is_dir():
        return []
    return sorted([p.name for p in d.iterdir() if RUN_ID.match(p.name) and (p / "manifest.json").is_file()])


ProcRunner = Callable[..., subprocess.CompletedProcess]


def _default_runner() -> ProcRunner:
    from core.watchdog import run_in_group
    return run_in_group


class DagRunner:
    """Plans and runs one task as steps in waves. proc_runner(cmd, *, timeout, cwd, env, input, kind, label, wk_home)."""

    def __init__(self, *, wk_home_dir: str | Path | None = None, proc_runner: ProcRunner | None = None,
                 env: dict[str, str] | None = None, bin_dir: str | Path | None = None,
                 node_timeout_s: float | None = None, poll_s: float = 0.2):
        self.env = dict(env if env is not None else os.environ)
        self.home = Path(wk_home_dir).expanduser().resolve() if wk_home_dir else wk_home(self.env)
        self.env["WK_HOME"] = str(self.home)
        self.run_proc = proc_runner or _default_runner()
        self.bin = Path(bin_dir) if bin_dir else BIN
        self.node_timeout = float(node_timeout_s or self.env.get("WK_DAG_NODE_TIMEOUT_S") or 1800)
        self.poll_s = poll_s
        self._lock = threading.Lock()
        self._merge_lock = threading.Lock()
        self._stop = threading.Event()

    # ------------------------------------------------------------ helpers
    def _proc(self, cmd: list[str], *, run_id: str, what: str, cwd: str | Path | None = None, timeout: float = 120,
              input: str | None = None) -> subprocess.CompletedProcess:
        try:
            return self.run_proc([str(c) for c in cmd], timeout=timeout, cwd=str(cwd) if cwd else None, env=self.env,
                                 input=input, kind="dag", label=f"dag:{run_id}:{what}", wk_home=str(self.home))
        except subprocess.TimeoutExpired as e:
            return subprocess.CompletedProcess(cmd, 124, e.output or "", (e.stderr or "") + f"\nTimed out after {int(timeout)} s.")

    def _git(self, run_id: str, cwd: str | Path, *args: str, timeout: float = 120) -> subprocess.CompletedProcess:
        return self._proc(["git", "-C", str(cwd), *args], run_id=run_id, what="git", timeout=timeout)

    def killed(self, run_id: str | None = None) -> bool:
        if (self.home / "KILL").exists():
            return True
        return bool(run_id) and (run_dir(self.home, run_id) / "STOP").exists()

    def manifest(self, run_id: str) -> dict[str, Any]:
        return _read_json(run_dir(self.home, run_id) / "manifest.json", {})

    def _save(self, run_id: str, man: dict[str, Any]) -> None:
        with self._lock:
            man["updatedAt"] = _iso()
            _write_json(run_dir(self.home, run_id) / "manifest.json", man)

    def _node(self, man: dict[str, Any], nid: str) -> dict[str, Any]:
        return man["steps"][nid]

    def _set(self, run_id: str, man: dict[str, Any], nid: str, **kv: Any) -> None:
        with self._lock:
            man["steps"][nid].update(kv)
        self._save(run_id, man)

    def worktrees_root(self) -> Path:
        return self.home / "worktrees"

    # ------------------------------------------------------------ plan
    def plan(self, task: str, repo: str | Path, *, verify_cmd: str = "true", use_model: bool = True,
             only_split: bool = False) -> dict[str, Any]:
        """Triage, then (for 'plan') one Claude call; writes the manifest with status 'planned'. Nothing runs yet.
        N2: the run folder is made only after the repository checks. N4: with only_split, a plan of fewer than
        two steps is returned unsaved (no folder at all), because the panel then takes the one-route path."""
        repo_p = Path(repo).expanduser().resolve()
        run_id = new_run_id()
        rdir = run_dir(self.home, run_id)
        top = self._git(run_id, repo_p, "rev-parse", "--show-toplevel")
        if top.returncode != 0:
            raise ValueError(f"{repo_p} is not a git repository.")
        repo_p = Path(top.stdout.strip()).resolve()
        branch = self._git(run_id, repo_p, "symbolic-ref", "--short", "HEAD").stdout.strip()
        head = self._git(run_id, repo_p, "rev-parse", "HEAD")
        if head.returncode != 0:
            raise ValueError("The repository has no commit yet.")
        tri = triage(task)
        nodes: list[dict[str, Any]] = []
        planner_note = ""
        if tri["route"] == "plan" and use_model and not self.killed(run_id):
            nodes, planner_note = self._ask_planner(run_id, task, repo_p)
        if not nodes:
            nodes = single_node(task, verify_cmd)
            planner_note = planner_note or ("One step: " + tri["reason"] + ".")
        waves = plan_waves(nodes)
        man = {"id": run_id, "task": task, "repo": str(repo_p), "branch": branch, "base": head.stdout.strip(),
               "triage": tri, "plannerNote": planner_note, "nodes": nodes, "waves": waves, "status": "planned",
               "createdAt": _iso(), "worktrees": [], "branches": [], "steps": {n["id"]: {"state": "planned"} for n in nodes},
               "message": "Waiting for the click: Run these steps / Not now." if len(nodes) > 1
               else "One step: it runs when you press Run."}
        if only_split and len(nodes) < 2:
            man["saved"] = False
            return man
        rdir.mkdir(parents=True, exist_ok=False)
        self._save(run_id, man)
        return man

    def _ask_planner(self, run_id: str, task: str, repo: Path) -> tuple[list[dict[str, Any]], str]:
        try:
            from core.graph_ego import ego_context
            ctx = ego_context(str(repo), task)
        except Exception:
            ctx = ""
        # The planner reads its text from stdin, so no run folder exists before there is a plan (N2, N4).
        # N7: while the planner runs, a watcher stops its process group as soon as the Stop switch is on.
        # S7: one time limit (core/dag-limits.json); on timeout run_in_group ends the whole process group.
        done = threading.Event()

        def watch() -> None:
            while not done.wait(self.poll_s):
                if self.killed(run_id):
                    self._kill_groups(run_id)
                    return
        w = threading.Thread(target=watch, daemon=True)
        w.start()
        try:
            r = self._proc(["node", self.bin / "wk-dag-lane.mjs", "plan", "--cwd", repo, "--prompt-file", "/dev/stdin"],
                           run_id=run_id, what="planner", cwd=repo, timeout=planner_timeout_s(),
                           input=task + ("\n\n" + ctx if ctx else ""))
        finally:
            done.set()
            w.join(timeout=2)
        if self.killed(run_id):
            return [], "The Stop switch is on, so the planner stopped and the task stays as one step."
        try:
            out = json.loads((r.stdout or "").strip().splitlines()[-1])
        except Exception:
            out = {}
        if not out.get("ok") or not isinstance(out.get("nodes"), list):
            return [], "The planner gave no plan, so the task runs as one step."
        v = validate_plan(out["nodes"])
        if not v["ok"]:
            return [], "The planner's plan was refused (" + " ".join(v["errors"][:3]) + "), so the task runs as one step."
        return v["nodes"], f"The planner made {len(v['nodes'])} steps."

    # ------------------------------------------------------------ run
    def run(self, run_id: str) -> dict[str, Any]:
        """The click 'Run these steps'. Waves in order; steps of one wave run side by side."""
        man = self._reconcile(run_id, self.manifest(run_id))
        if not man:
            raise ValueError(f"No run {run_id}.")
        if man.get("status") in ("passed", "merged", "running"):
            return man
        # M4: starting again clears this run's own Stop (never the global Stop switch).
        if man.get("status") in ("stopped", "waiting", "failed"):
            try:
                (run_dir(self.home, run_id) / "STOP").unlink()
            except FileNotFoundError:
                pass
        self._stop.clear()
        man["status"] = "running"
        man["message"] = "Running."
        man["runnerPid"] = os.getpid()
        man["runnerStart"] = proc_start(os.getpid())
        self._save(run_id, man)
        if self.killed(run_id):
            return self._mark_stopped(run_id, man)
        repo = Path(man["repo"])
        integ = self.worktrees_root() / f"dag-{run_id}"
        ibranch = f"dag/{run_id}/{INTEGRATION}"
        if not integ.exists():
            self.worktrees_root().mkdir(parents=True, exist_ok=True)
            with self._lock:
                man["worktrees"].append(str(integ))
                man["branches"].append(ibranch)
            self._save(run_id, man)
            r = self._git(run_id, repo, "worktree", "add", "-b", ibranch, str(integ), man["base"])
            if r.returncode != 0:
                return self._finish(run_id, man, "failed", "Could not make the run's work folder: " + _tail(r.stderr))
        man["integration"] = str(integ)
        self._save(run_id, man)
        monitor = threading.Thread(target=self._watch_stop, args=(run_id,), daemon=True)
        monitor.start()
        try:
            by = {n["id"]: n for n in man["nodes"]}
            for wave in man["waves"]:
                if self.killed(run_id) or self._stop.is_set():
                    return self._mark_stopped(run_id, man)
                todo = []
                for nid in wave:
                    st = man["steps"][nid]["state"]
                    if st == "passed":
                        continue
                    blocked = [d for d in by[nid]["dependsOn"] if man["steps"][d]["state"] != "passed"]
                    if blocked:
                        if st != "queued":
                            self._set(run_id, man, nid, state="skipped",
                                      reason="Waits for " + ", ".join(blocked) + ", which did not pass.")
                        continue
                    todo.append(by[nid])
                if not todo:
                    continue
                with ThreadPoolExecutor(max_workers=min(4, len(todo))) as ex:
                    list(ex.map(lambda n: self._run_node(run_id, man, n, integ), todo))
                if self.killed(run_id) or self._stop.is_set():
                    return self._mark_stopped(run_id, man)
        finally:
            self._stop.set()
            monitor.join(timeout=5)
            self._stop.clear()
        states = [man["steps"][n["id"]]["state"] for n in man["nodes"]]
        if all(s == "passed" for s in states):
            self._finish(run_id, man, "passed",
                         f"Every step passed. Nothing reached {man.get('branch') or 'your branch'} yet: "
                         f"the next click is 'Merge into {man.get('branch') or 'your branch'}'.")
            self.cleanup(run_id, keep_integration=True)
            return self.manifest(run_id)
        if any(s == "stopped" for s in states):
            return self._mark_stopped(run_id, man)
        if any(s == "failed" for s in states):
            bad = [f"{n['id']}: {man['steps'][n['id']].get('reason', '')}" for n in man["nodes"]
                   if man["steps"][n["id"]]["state"] == "failed"]
            return self._finish(run_id, man, "failed",
                                "A step failed, so its branch of the plan stopped. Everything is kept in "
                                f"{integ} and the step folders listed in {run_dir(self.home, run_id) / 'manifest.json'}. "
                                + " ".join(bad))
        return self._finish(run_id, man, "waiting",
                            "Some steps are queued for Antigravity (wk-task). Watchkeeper does not run them; "
                            "run `dag run " + run_id + "` again after Antigravity has verified them.")

    def _finish(self, run_id: str, man: dict[str, Any], status: str, msg: str) -> dict[str, Any]:
        man["status"] = status
        man["message"] = msg
        man["endedAt"] = _iso()
        self._save(run_id, man)
        return man

    def _mark_stopped(self, run_id: str, man: dict[str, Any]) -> dict[str, Any]:
        self._stop.set()
        self._kill_groups(run_id)
        for nid, st in man["steps"].items():
            if st.get("state") in ("planned", "running"):
                st["state"] = "stopped"
        lead = ("The Stop switch is on, so the run stopped." if (self.home / "KILL").exists()
                else "This run was stopped.")
        return self._finish(run_id, man, "stopped",
                            lead + " Nothing was deleted; the work folders are listed in "
                            f"{run_dir(self.home, run_id) / 'manifest.json'}.")

    def _stop_words(self) -> str:
        """S1: the global switch keeps its name; this run's own Stop says so."""
        return "The Stop switch is on." if (self.home / "KILL").exists() else "This run was stopped."

    def _reconcile(self, run_id: str, man: dict[str, Any]) -> dict[str, Any]:
        """M4: a 'running' manifest whose process ended (pid gone, or a new process with the same pid) counts as stopped."""
        if not man or man.get("status") != "running" or not man.get("runnerPid"):
            return man
        pid = man["runnerPid"]
        alive = False
        try:
            os.kill(int(pid), 0)
            alive = True
        except ProcessLookupError:
            alive = False
        except PermissionError:
            alive = True
        except Exception:
            alive = False
        if alive and man.get("runnerStart") and proc_start(int(pid)) != man["runnerStart"]:
            alive = False
        if alive:
            return man
        for st in man.get("steps", {}).values():
            if st.get("state") in ("running", "planned"):
                st["state"] = "stopped"
        where = man.get("integration") or str(run_dir(self.home, run_id))
        return self._finish(run_id, man, "stopped",
                            f"Stopped: the window closed or the process ended. Your work is kept in {where}.")

    def _watch_stop(self, run_id: str) -> None:
        while not self._stop.is_set():
            if self.killed(run_id):
                self._stop.set()
                self._kill_groups(run_id)
                return
            time.sleep(self.poll_s)

    def _kill_groups(self, run_id: str) -> list[int]:
        """Stops every registered process group whose label belongs to this run (the watchdog registry)."""
        try:
            from core.watchdog import kill_process_group
        except Exception:
            return []
        reg = _read_json(self.home / "watchdog" / "processes.json", {})
        procs = reg.get("processes", {}) if isinstance(reg, dict) else {}
        hit = []
        for pid, e in list(procs.items()):
            if isinstance(e, dict) and str(e.get("label", "")).startswith(f"dag:{run_id}:"):
                try:
                    kill_process_group(int(pid), e.get("pgid"), grace_ms=500)
                    hit.append(int(pid))
                except Exception:
                    pass
        return hit

    def _changed_files(self, run_id: str, wt: Path) -> list[str]:
        r = self._git(run_id, wt, "status", "--porcelain=v1", "-uall", "-z")
        out = []
        parts = (r.stdout or "").split("\0")
        i = 0
        while i < len(parts):
            p = parts[i]
            if len(p) > 3:
                code, name = p[:2], p[3:]
                out.append(name)
                if code[0] in "RC":
                    i += 1
                    if i < len(parts) and parts[i]:
                        out.append(parts[i])
            i += 1
        return sorted(set(out))

    def _z(self, r: subprocess.CompletedProcess) -> list[str]:
        return [x for x in (r.stdout or "").split("\0") if x]

    def _bad_modes(self, run_id: str, cwd: Path, *rng: str) -> list[str]:
        """Paths whose mode is a gitlink (160000) or a symlink (120000) in `git diff --raw --no-renames -z`."""
        r = self._git(run_id, cwd, "diff", "--raw", "--no-renames", "-z", *rng)
        parts = (r.stdout or "").split("\0")
        bad = []
        i = 0
        while i < len(parts):
            head = parts[i]
            if head.startswith(":"):
                f = head[1:].split()
                path = parts[i + 1] if i + 1 < len(parts) else ""
                if len(f) >= 2 and (f[0] in BAD_MODES or f[1] in BAD_MODES):
                    bad.append(path)
                i += 2
                continue
            i += 1
        return bad

    def _changed_since(self, run_id: str, wt: Path, start: str) -> tuple[list[str], str]:
        """M1: every file the step touched since its start commit: commits, unstaged, staged and untracked.
        Refuses a history that does not descend from the start, and links or sub-repositories."""
        if not SHA_RE.match(str(start or "")):
            return [], "The step's start point is not recorded, so nothing is taken."
        if self._git(run_id, wt, "merge-base", "--is-ancestor", start, "HEAD").returncode != 0:
            return [], "The step's history does not start from the run's own commit, so nothing is taken."
        files: set[str] = set()
        files.update(self._z(self._git(run_id, wt, "diff", "--name-only", "--no-renames", "-z", f"{start}..HEAD")))
        files.update(self._z(self._git(run_id, wt, "diff", "--name-only", "--no-renames", "-z")))
        files.update(self._z(self._git(run_id, wt, "diff", "--name-only", "--no-renames", "-z", "--cached")))
        untracked = self._z(self._git(run_id, wt, "ls-files", "--others", "--exclude-standard", "-z"))
        files.update(untracked)
        bad = self._bad_modes(run_id, wt, f"{start}..HEAD") + self._bad_modes(run_id, wt, start)
        bad += [u for u in untracked if u.endswith("/") or os.path.islink(str(wt / u))]
        if bad:
            return sorted(files), ("The step added a link or a sub-repository (" + ", ".join(sorted(set(bad))[:10])
                                   + "); Watchkeeper does not take those, so nothing is taken.")
        return sorted(files), ""

    def _run_node(self, run_id: str, man: dict[str, Any], n: dict[str, Any], integ: Path) -> None:
        nid = n["id"]
        if self.killed(run_id) or self._stop.is_set():
            self._set(run_id, man, nid, state="stopped", reason=self._stop_words())
            return
        if n["provider"] == "gemini":
            self._gemini_node(run_id, man, n, integ)
            return
        repo = Path(man["repo"])
        wt = self.worktrees_root() / f"dag-{run_id}-{nid}"
        br = f"dag/{run_id}/{nid}"
        if not wt.exists():
            with self._lock:
                man["worktrees"].append(str(wt))
                man["branches"].append(br)
            self._set(run_id, man, nid, state="running", worktree=str(wt), branch=br, startedAt=_iso())
            r = self._git(run_id, repo, "worktree", "add", "-b", br, str(wt), f"dag/{run_id}/{INTEGRATION}")
            if r.returncode != 0:
                self._set(run_id, man, nid, state="failed", reason="Could not make the step's work folder: " + _tail(r.stderr))
                return
            sc = self._git(run_id, wt, "rev-parse", "HEAD").stdout.strip()
            self._set(run_id, man, nid, startCommit=sc)
        else:
            self._set(run_id, man, nid, state="running", startedAt=_iso())
        pf = run_dir(self.home, run_id) / f"step-{nid}.txt"
        pf.write_text(_step_prompt(man, n), encoding="utf-8")
        r = self._proc(["node", self.bin / "wk-dag-lane.mjs", "claude", "--cwd", wt, "--model", n["model"],
                        "--effort", n["effort"], "--prompt-file", pf, "--id", f"{run_id}-{nid}"],
                       run_id=run_id, what=nid, cwd=wt, timeout=self.node_timeout)
        if self._stop.is_set() or self.killed(run_id):
            self._set(run_id, man, nid, state="stopped", reason=self._stop_words()[:-1] + "; the step's folder is kept: " + str(wt))
            return
        lane = _last_json(r.stdout)
        if r.returncode != 0 or not lane.get("ok"):
            self._set(run_id, man, nid, state="failed",
                      reason="Claude Code did not finish the step: " + str(lane.get("reason") or _tail(r.stderr) or f"exit {r.returncode}"))
            return
        changed, why = self._changed_since(run_id, wt, man["steps"][nid].get("startCommit", ""))
        if why:
            self._set(run_id, man, nid, state="failed", reason=why, changed=changed)
            return
        g = gate_check(changed, n["ownedGlobs"], load_deny_globs(self.env.get("WK_GATES_FILE")), step=nid)
        if not g["ok"]:
            self._set(run_id, man, nid, state="failed", reason=g["reason"], changed=changed)
            return
        if self._changed_files(run_id, wt):
            self._git(run_id, wt, "add", "-A")
            c = self._git(run_id, wt, "-c", "user.name=Watchkeeper", "-c", "user.email=watchkeeper@localhost",
                          "commit", "-q", "-m", f"dag {run_id}: {nid} {n['title']}"[:200])
            if c.returncode != 0:
                self._set(run_id, man, nid, state="failed", reason="Could not record the step's changes: " + _tail(c.stderr or c.stdout))
                return
        self._merge_and_verify(run_id, man, n, integ, br, changed)

    def _merge_and_verify(self, run_id: str, man: dict[str, Any], n: dict[str, Any], integ: Path, ref: str,
                          changed: list[str]) -> None:
        nid = n["id"]
        with self._merge_lock:
            if self._stop.is_set() or self.killed(run_id):
                self._set(run_id, man, nid, state="stopped", reason=self._stop_words())
                return
            m = self._git(run_id, integ, "-c", "user.name=Watchkeeper", "-c", "user.email=watchkeeper@localhost",
                          "merge", "--no-edit", "-q", ref)
            if m.returncode != 0:
                self._git(run_id, integ, "merge", "--abort")
                joined = [k for k, v in man["steps"].items() if v.get("state") == "passed" and k != nid]
                self._set(run_id, man, nid, state="failed",
                          reason=f"Step {nid} did not fit with the steps already joined ({', '.join(joined) or 'none'}); "
                                 f"its merge was undone, so {integ} is as it was before step {nid}. "
                                 + _tail(m.stdout or m.stderr))
                return
            v = self._proc([self.bin / "wk-run", "sh", "-c", f"cd {_shq(str(integ))} && {n['verifyCmd']}"],
                           run_id=run_id, what=f"{nid}:verify", cwd=run_dir(self.home, run_id), timeout=self.node_timeout)
            log = _grab(v.stdout, r"WK_LOG=(\S+)")
            if self._stop.is_set() or self.killed(run_id):
                self._set(run_id, man, nid, state="stopped", reason=self._stop_words())
                return
            if v.returncode != 0:
                self._set(run_id, man, nid, state="failed", changed=changed,
                          verifyLog=str(run_dir(self.home, run_id) / log) if log else "",
                          reason=f"The check `{n['verifyCmd']}` failed (exit {v.returncode}); the log is "
                                 f"{run_dir(self.home, run_id) / log if log else 'not available'}.")
                return
            self._set(run_id, man, nid, state="passed", changed=changed, endedAt=_iso(),
                      verifyLog=str(run_dir(self.home, run_id) / log) if log else "")

    def _gemini_node(self, run_id: str, man: dict[str, Any], n: dict[str, Any], integ: Path) -> None:
        """Queues a wk-task for Antigravity (never runs agy). A later run takes a verified task's commit."""
        nid = n["id"]
        st = man["steps"][nid]
        tid = str(st.get("taskId") or "")
        if tid:
            # S4: a step that already has a task never queues a second one.
            if not TASK_ID_RE.match(tid) or ".." in tid:
                self._set(run_id, man, nid, state="failed", reason="The step's task id is not valid; nothing is merged.")
                return
            meta = _read_json(self.home / "tasks" / tid / "meta.json", {})
            status = str(meta.get("status") or "")
            if status in ("verified", "merged"):
                self._take_task(run_id, man, n, integ, meta)
                return
            if status in ("queued", "taken", ""):
                self._set(run_id, man, nid, state="queued",
                          reason=f"Queued for Antigravity as wk-task {tid}; Antigravity takes it when the owner runs it.")
                return
            self._set(run_id, man, nid, state="failed",
                      reason=f"The Antigravity task {tid} ended as {status}; nothing is merged. It stays in the wk-task list.")
            return
        text = _step_prompt(man, n)
        # S5 + M2: the task starts from the run's integration commit, recorded here as the step's own base.
        tb = self._git(run_id, man["repo"], "rev-parse", "--verify", "-q", f"refs/heads/dag/{run_id}/{INTEGRATION}").stdout.strip()
        if not SHA_RE.match(tb):
            self._set(run_id, man, nid, state="failed", reason="Could not read the run's own commit, so nothing was queued.")
            return
        self._set(run_id, man, nid, taskBase=tb)
        cmd = ["node", self.bin / "wk-task.mjs", "add", "--repo", man["repo"], "--base", tb, "--title", n["title"][:200]]
        for g in n["ownedGlobs"]:
            cmd += ["--allow", g]
        # P2-272 4B: --from names the real source; the panel sets WK_DAG_FROM=owner when the owner clicked "Run these steps".
        src = self.env.get("WK_DAG_FROM", "claude")
        src = src if src in ("claude", "owner") else "claude"
        cmd += ["--test", n["verifyCmd"], "--from", src, "--text", text]
        r = self._proc(cmd, run_id=run_id, what=f"{nid}:queue", timeout=60)
        tid = (r.stdout or "").strip().splitlines()[-1].strip() if (r.stdout or "").strip() else ""
        if r.returncode != 0 or not tid or not TASK_ID_RE.match(tid):
            self._set(run_id, man, nid, state="failed", reason="Could not queue the step for Antigravity: " + _tail(r.stderr))
            return
        self._set(run_id, man, nid, state="queued", taskId=tid,
                  reason=f"Queued for Antigravity as wk-task {tid}; Antigravity takes it when the owner runs it.")

    def _take_task(self, run_id: str, man: dict[str, Any], n: dict[str, Any], integ: Path, meta: dict[str, Any]) -> None:
        """M2: trusts nothing in meta.json except the commit id, which must be a real commit descending from the
        step's own taskBase; the files come from git itself and pass the same gate as a Claude step."""
        nid = n["id"]
        repo = man["repo"]
        base = str(man["steps"][nid].get("taskBase") or "")
        c = str(meta.get("commit") or "")
        fail = lambda why: self._set(run_id, man, nid, state="failed", reason=why)  # noqa: E731
        if not SHA_RE.match(base):
            return fail("The step has no recorded start commit, so the Antigravity task is not taken.")
        if not SHA_RE.match(c):
            return fail("The Antigravity task's commit is not a full commit id, so nothing is merged.")
        if self._git(run_id, repo, "cat-file", "-e", f"{c}^{{commit}}").returncode != 0:
            return fail("The Antigravity task's commit is not in the repository, so nothing is merged.")
        if c == base or self._git(run_id, repo, "merge-base", "--is-ancestor", base, c).returncode != 0:
            if c == base:
                return fail("The Antigravity task changed no files.")
            return fail("The Antigravity task's commit does not start from the step's own commit, so nothing is merged.")
        changed = sorted(set(self._z(self._git(run_id, repo, "diff", "--no-renames", "--name-only", "-z", base, c))))
        if not changed:
            return fail("The Antigravity task changed no files.")
        bad = self._bad_modes(run_id, Path(repo), base, c)
        if bad:
            return fail("The Antigravity task added a link or a sub-repository (" + ", ".join(bad[:10]) + "), so nothing is merged.")
        g = gate_check(changed, n["ownedGlobs"], load_deny_globs(self.env.get("WK_GATES_FILE")), step=nid)
        if not g["ok"]:
            self._set(run_id, man, nid, state="failed", reason=g["reason"], changed=changed)
            return
        self._merge_and_verify(run_id, man, n, integ, c, changed)

    # ------------------------------------------------------------ stop, merge, cleanup
    def stop(self, run_id: str) -> dict[str, Any]:
        """Asks a running run to stop (this run only); deletes nothing."""
        rd = run_dir(self.home, run_id)
        if not (rd / "manifest.json").is_file():
            raise ValueError(f"No run {run_id}.")
        (rd / "STOP").write_text(_iso() + "\n", encoding="utf-8")
        man = self.manifest(run_id)
        if man.get("status") in ("planned", "waiting"):
            return self._mark_stopped(run_id, man)
        self._kill_groups(run_id)
        return man

    def merge(self, run_id: str) -> dict[str, Any]:
        """The click 'Merge into <branch>': git merge --no-edit of the run's branch. Never a push."""
        man = self.manifest(run_id)
        if man.get("status") != "passed":
            return {"ok": False, "message": f"Run {run_id} is {man.get('status') or 'unknown'}; only a passed run can be merged."}
        if (self.home / "KILL").exists():
            return {"ok": False, "message": "The Stop switch is on, so nothing is merged."}
        if self.killed(run_id):
            return {"ok": False, "message": "This run was stopped, so nothing is merged."}
        repo = Path(man["repo"])
        ibranch = f"dag/{run_id}/{INTEGRATION}"
        cur = self._git(run_id, repo, "symbolic-ref", "--short", "-q", "HEAD").stdout.strip()
        if not cur:
            return {"ok": False, "message": "Your repo is on a detached HEAD. Check out a branch, then press Merge."}
        if man.get("branch") and cur != man["branch"]:
            return {"ok": False, "message": f"The repository is on {cur or 'no branch'}, not {man['branch']}; nothing is merged."}
        gd = self._git(run_id, repo, "rev-parse", "--git-dir").stdout.strip()
        gdp = Path(gd) if os.path.isabs(gd) else repo / gd
        if (gdp / "MERGE_HEAD").exists():
            return {"ok": False, "message": "Another merge is open in the repository; nothing is merged."}
        if self._git(run_id, repo, "diff", "--cached", "--quiet").returncode != 0:
            return {"ok": False, "message": "The repository has staged changes; nothing is merged."}
        touched = sorted({f for s in man["steps"].values() for f in s.get("changed", [])})
        dirty = set(self._changed_files(run_id, repo))
        clash = [f for f in touched if f in dirty]
        if clash:
            return {"ok": False, "message": "These files have unsaved changes in the repository: " + ", ".join(clash[:10]) + ". Nothing is merged."}
        m = self._git(run_id, repo, "-c", "user.name=Watchkeeper", "-c", "user.email=watchkeeper@localhost",
                      "merge", "--no-edit", ibranch)
        if m.returncode != 0:
            self._git(run_id, repo, "merge", "--abort")
            integ = man.get("integration") or str(self.worktrees_root() / f"dag-{run_id}")
            return {"ok": False, "message": f"The merge did not fit; your branch is as it was; the work is in {integ}."}
        man["status"] = "merged"
        man["message"] = f"Merged into {cur}. Nothing was pushed."
        man["mergedAt"] = _iso()
        self._save(run_id, man)
        cl = self.cleanup(run_id)
        return {"ok": True, "message": man["message"], "cleanup": cl}

    def cleanup(self, run_id: str, *, keep_integration: bool = False) -> dict[str, Any]:
        """Removes only this run's manifest worktrees (git worktree remove) and branches (git branch -d), only after a pass."""
        man = self.manifest(run_id)
        if man.get("status") not in ("passed", "merged"):
            return {"ok": False, "removed": [], "kept": man.get("worktrees", []),
                    "message": f"Run {run_id} did not pass, so everything is kept: {', '.join(man.get('worktrees', []))}."}
        prefix = str(self.worktrees_root() / f"dag-{run_id}")
        integ = str(self.worktrees_root() / f"dag-{run_id}")
        ibranch = f"dag/{run_id}/{INTEGRATION}"
        repo = man["repo"]
        removed, kept, notes = [], [], []
        for wt in list(man.get("worktrees", [])):
            p = str(Path(wt))
            if not (p == prefix or p.startswith(prefix + "-")) or ".." in Path(p).parts:
                kept.append(p)
                notes.append(f"{p} is not this run's folder; left alone.")
                continue
            if keep_integration and p == integ:
                kept.append(p)
                continue
            if not Path(p).exists():
                removed.append(p)
                continue
            r = self._git(run_id, repo, "worktree", "remove", p)
            (removed if r.returncode == 0 else kept).append(p)
            if r.returncode != 0:
                notes.append(f"{p} kept: " + _tail(r.stderr))
        for br in list(man.get("branches", [])):
            if not br.startswith(f"dag/{run_id}/"):
                notes.append(f"Branch {br} is not this run's; left alone.")
                continue
            if keep_integration and br == ibranch:
                continue
            where = integ if (keep_integration and Path(integ).exists()) else repo
            r = self._git(run_id, where, "branch", "-d", br)
            if r.returncode != 0:
                notes.append(f"Branch {br} kept: " + _tail(r.stderr))
        with self._lock:
            man["worktrees"] = [w for w in man.get("worktrees", []) if w not in removed]
            man["removed"] = sorted(set(man.get("removed", []) + removed))
        self._save(run_id, man)
        return {"ok": True, "removed": removed, "kept": kept, "notes": notes}

    def status(self, run_id: str | None = None) -> dict[str, Any]:
        if run_id:
            m = copy.deepcopy(self._reconcile(run_id, self.manifest(run_id)))
            # M3: the panel's "Check again" needs to know when Antigravity has finished a queued task. Read-only;
            # never saved into the manifest.
            for st in (m.get("steps") or {}).values():
                tid = str((st or {}).get("taskId") or "")
                if st.get("state") == "queued" and tid and TASK_ID_RE.match(tid) and ".." not in tid:
                    meta = _read_json(self.home / "tasks" / tid / "meta.json", {})
                    ts = str(meta.get("status") or "") if isinstance(meta, dict) else ""
                    st["taskStatus"] = ts if re.match(r"^[a-z_-]{1,20}$", ts) else ""
            return m
        out = []
        for r in list_runs(self.home)[-20:]:
            m = self._reconcile(r, self.manifest(r))
            out.append({"id": r, "status": m.get("status"), "task": str(m.get("task", ""))[:80]})
        return {"runs": out}


# ---------------------------------------------------------------- small helpers
def _step_prompt(man: dict[str, Any], n: dict[str, Any]) -> str:
    return (f"Task: {man.get('task', '')}\n\nYour step ({n['id']}): {n['title']}\n"
            f"Change only files matching: {', '.join(n['ownedGlobs'])}.\n"
            + (f"Interface contract: {n['interfaceContract']}\n" if n.get("interfaceContract") else "")
            + f"The step passes when this command succeeds: {n['verifyCmd']}\n"
            "Do not commit, push or delete anything; Watchkeeper records the changes.")


def _tail(s: Any, n: int = 300) -> str:
    t = str(s or "").strip().splitlines()
    return (t[-1] if t else "")[:n]


def _last_json(s: Any) -> dict[str, Any]:
    for line in reversed(str(s or "").strip().splitlines()):
        try:
            o = json.loads(line)
            if isinstance(o, dict):
                return o
        except Exception:
            continue
    return {}


def _grab(s: Any, rx: str) -> str:
    m = re.search(rx, str(s or ""))
    return m.group(1) if m else ""


def _shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def format_plan(man: dict[str, Any]) -> str:
    """Plain text of a plan, for the CLI (the panel card comes in Stage 4B)."""
    lines = [f"Run {man.get('id')}: {man.get('status')}. {man.get('message', '')}".rstrip()]
    if man.get("plannerNote"):
        lines.append(man["plannerNote"])
    by = {n["id"]: n for n in man.get("nodes", [])}
    for i, wave in enumerate(man.get("waves", []), 1):
        lines.append(f"Wave {i}:")
        for nid in wave:
            n = by.get(nid, {})
            st = man.get("steps", {}).get(nid, {})
            lane = "Antigravity queue" if n.get("provider") == "gemini" else "Claude Code"
            lines.append(f"  - {nid}: {n.get('title', '')} [{lane}, {n.get('model')}, {n.get('effort')}] "
                         f"owns {', '.join(n.get('ownedGlobs', []))} [{st.get('state', '')}]")
            if st.get("reason"):
                lines.append(f"      {st['reason']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """`python3 core/dag_orchestrator.py triage "<text>"`: the triage as JSON."""
    import sys
    a = list(sys.argv[1:] if argv is None else argv)
    if a[:1] == ["triage"]:
        t0 = time.perf_counter()
        r = triage(" ".join(a[1:]))
        r["ms"] = round((time.perf_counter() - t0) * 1000, 3)
        print(json.dumps(r))
        return 0
    print("usage: dag_orchestrator.py triage <text>")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
