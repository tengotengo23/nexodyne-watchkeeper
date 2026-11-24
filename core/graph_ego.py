"""Lean 2-hop ego subgraph for the PreInvocation hook (P2-272).

Standard library only, so the hook starts fast. Reads the existing graphify-out/graph.json; never builds.
Returns "" (neutral) when there is no graph, the graph is unreadable, or the time budget is spent.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

STOP = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "when", "what", "make", "add", "fix",
    "update", "create", "build", "check", "test", "tests", "using", "across", "file", "files", "code", "please",
    "want", "need", "should", "all", "new", "only", "also", "then", "than", "more", "some", "raw",
})
HEADER = "[Graphify Structural Context]"
DEFAULT_BUDGET_S = 0.05

INDEX_NAME = "wk-ego.sqlite"


def build_ego_index(workspace_dir: str | Path, graph_data: dict[str, Any]) -> bool:
    """Write graphify-out/wk-ego.sqlite beside graph.json so the PreInvocation hook never parses the big JSON.

    Called after a build or update (never on the hook path). Best effort; returns False on any failure."""
    try:
        out = Path(workspace_dir).expanduser() / "graphify-out"
        out.mkdir(parents=True, exist_ok=True)
        tmp = out / (INDEX_NAME + ".tmp")
        if tmp.exists():
            tmp.unlink()
        con = sqlite3.connect(str(tmp))
        try:
            con.execute("CREATE TABLE nodes(id TEXT PRIMARY KEY, label TEXT, file TEXT, hay TEXT, deg INTEGER)")
            con.execute("CREATE TABLE edges(a TEXT, b TEXT)")
            nodes = {str(n["id"]): n for n in (graph_data.get("nodes") or []) if isinstance(n, dict) and n.get("id")}
            deg: dict[str, int] = defaultdict(int)
            pairs = set()
            for e in (graph_data.get("links") or graph_data.get("edges") or []):
                if isinstance(e, dict):
                    a, b = str(e.get("source") or ""), str(e.get("target") or "")
                    if a in nodes and b in nodes and a != b and (a, b) not in pairs:
                        pairs.add((a, b))
                        pairs.add((b, a))
            for a, _b in pairs:
                deg[a] += 1
            rows = []
            for nid, n in nodes.items():
                label = str(n.get("label") or "")
                nfile = str(n.get("source_file") or n.get("file") or "")
                rows.append((nid, label, nfile, f"{nid} {label} {nfile}".lower(), deg[nid]))
            con.executemany("INSERT INTO nodes VALUES(?,?,?,?,?)", rows)
            con.executemany("INSERT INTO edges VALUES(?,?)", list(pairs))
            con.execute("CREATE INDEX edges_a ON edges(a)")
            con.commit()
        finally:
            con.close()
        os.replace(tmp, out / INDEX_NAME)
        return True
    except Exception:
        return False


def _render(n_nodes: int, kept: list[dict[str, str]], edges: list[str]) -> str:
    files: list[str] = []
    for k in kept:
        if k["file"] and k["file"] not in files:
            files.append(k["file"])
    lines = [HEADER, f"Graph: {n_nodes} nodes. Start with these files before any broad search:", ", ".join(files[:10])]
    if edges:
        lines.append("Links: " + "; ".join(edges))
    return "\n".join(lines)


def _ego_from_index(out: Path, toks: list[str], t0: float, budget_s: float, max_nodes: int, dirty: list[str] | None) -> str | None:
    """Fast path. Returns text, "" (neutral) or None (index missing or stale: use the JSON path)."""
    ip, gp = out / INDEX_NAME, out / "graph.json"
    try:
        if not ip.is_file() or ip.stat().st_mtime + 2 < gp.stat().st_mtime:
            return None
        con = sqlite3.connect(f"file:{ip}?mode=ro", uri=True)
    except Exception:
        return None
    try:
        total = con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        cond = " OR ".join(["instr(hay, ?) > 0"] * len(toks))
        rows = con.execute(f"SELECT id,label,file,hay,deg FROM nodes WHERE {cond} LIMIT 3000", toks).fetchall()
        dirty_set = {d.lower() for d in (dirty or [])}
        scored = []
        for nid, label, nfile, hay, deg in rows:
            ll = label.lower()
            sc = 0.0
            for tok in toks:
                if tok == ll:
                    sc += 6.0
                elif tok in hay:
                    sc += 2.5
            if sc and nfile.lower() in dirty_set:
                sc += 1.5
            if sc:
                scored.append((sc + min(3.0, deg * 0.25), nid))
        if not scored or time.monotonic() - t0 > budget_s:
            return ""
        scored.sort(key=lambda x: (-x[0], x[1]))
        info: dict[str, dict[str, Any]] = {}

        def get(nid: str) -> dict[str, Any]:
            if nid not in info:
                r = con.execute("SELECT label,file,deg FROM nodes WHERE id=?", (nid,)).fetchone()
                info[nid] = {"label": r[0], "file": r[1], "deg": r[2]}
            return info[nid]

        def nbrs(nid: str) -> list[str]:
            ids = [r[0] for r in con.execute("SELECT b FROM edges WHERE a=?", (nid,))]
            return sorted(ids, key=lambda x: (-get(x)["deg"], x))[:6]

        kept: list[str] = []
        seen: set[str] = set()
        frontier = [nid for _s, nid in scored[:6]]
        for _hop in range(3):
            nxt: list[str] = []
            for cur in frontier:
                if cur in seen:
                    continue
                seen.add(cur)
                kept.append(cur)
                if len(kept) >= max_nodes:
                    break
                nxt.extend(nbrs(cur))
            frontier = nxt
            if len(kept) >= max_nodes or time.monotonic() - t0 > budget_s:
                break
        if time.monotonic() - t0 > budget_s:
            return ""
        kset = set(kept)
        edges = []
        for a in kept:
            for (b,) in con.execute("SELECT b FROM edges WHERE a=? ORDER BY b", (a,)):
                if b in kset and a < b:
                    edges.append(f"{get(a)['label'] or a} -> {get(b)['label'] or b}")
        return _render(total, [{"file": get(k)["file"]} for k in kept], edges[:8])
    except Exception:
        return None
    finally:
        con.close()


def _tokens(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for tok in re.findall(r"[A-Za-z0-9_./-]{3,}", text or ""):
        for t in [tok.lower().strip("./-")] + [p for p in re.split(r"[/._-]+", tok.lower()) if len(p) >= 4]:
            if len(t) >= 3 and t not in STOP and t not in seen:
                seen.add(t)
                out.append(t)
    return out[:24]


def ego_context(workspace_dir: str | Path, prompt: str, *, budget_s: float = DEFAULT_BUDGET_S,
                max_nodes: int = 18, dirty: list[str] | None = None) -> str:
    """Return the "[Graphify Structural Context]" text, or "" for neutral. Never raises."""
    t0 = time.monotonic()
    try:
        gp = Path(workspace_dir).expanduser() / "graphify-out" / "graph.json"
        toks = _tokens(prompt)
        if not toks or not gp.is_file():
            return ""
        fast = _ego_from_index(gp.parent, toks, t0, budget_s, max_nodes, dirty)
        if fast is not None:
            return fast
        data = json.loads(gp.read_text(encoding="utf-8"))
        if time.monotonic() - t0 > budget_s:
            return ""
        nodes = data.get("nodes") or []
        links = data.get("links") or data.get("edges") or []
        by_id: dict[str, dict[str, Any]] = {}
        for n in nodes:
            if isinstance(n, dict) and n.get("id"):
                by_id[str(n["id"])] = n
        adj: dict[str, set[str]] = defaultdict(set)
        for e in links:
            if isinstance(e, dict):
                s, t = str(e.get("source") or ""), str(e.get("target") or "")
                if s in by_id and t in by_id:
                    adj[s].add(t)
                    adj[t].add(s)
        if time.monotonic() - t0 > budget_s:
            return ""
        dirty_set = {d.lower() for d in (dirty or [])}
        scored: list[tuple[float, str]] = []
        for nid, n in by_id.items():
            label = str(n.get("label") or "").lower()
            nfile = str(n.get("source_file") or n.get("file") or "")
            hay = f"{nid} {label} {nfile}".lower()
            sc = 0.0
            for tok in toks:
                if tok == label:
                    sc += 6.0
                elif tok in hay:
                    sc += 2.5
            if sc and nfile.lower() in dirty_set:
                sc += 1.5
            if sc:
                scored.append((sc + min(3.0, len(adj[nid]) * 0.25), nid))
        if not scored:
            return ""
        scored.sort(key=lambda x: (-x[0], x[1]))
        kept: list[str] = []
        seen: set[str] = set()
        frontier = [nid for _s, nid in scored[:6]]
        for _hop in range(3):  # seeds, hop 1, hop 2
            nxt: list[str] = []
            for cur in frontier:
                if cur in seen:
                    continue
                seen.add(cur)
                kept.append(cur)
                if len(kept) >= max_nodes:
                    break
                nxt.extend(sorted(adj[cur], key=lambda x: (-len(adj[x]), x))[:6])
            frontier = nxt
            if len(kept) >= max_nodes or time.monotonic() - t0 > budget_s:
                break
        if time.monotonic() - t0 > budget_s:
            return ""
        files: list[str] = []
        for nid in kept:
            f = str(by_id[nid].get("source_file") or by_id[nid].get("file") or "")
            if f and f not in files:
                files.append(f)
        kset = set(kept)
        edges = [f"{by_id[a].get('label', a)} -> {by_id[b].get('label', b)}"
                 for a in kept for b in sorted(adj[a]) if b in kset and a < b][:8]
        lines = [HEADER, f"Graph: {len(by_id)} nodes. Start with these files before any broad search:"]
        lines.append(", ".join(files[:10]))
        if edges:
            lines.append("Links: " + "; ".join(edges))
        return "\n".join(lines)
    except Exception:
        return ""
