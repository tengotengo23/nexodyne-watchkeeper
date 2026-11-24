#!/usr/bin/env python3
"""Graphify bridge: schema validation, dirty-file incremental AST sync & <50ms 2-hop ego-subgraph query."""

from __future__ import annotations

import ast
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from core.state_store import StateStore, atomic_write_json, file_lock, read_json_safe
from core.watchdog import run_in_group

GRAPH_STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "when", "what", "make", "add", "fix",
    "update", "create", "build", "check", "test", "tests", "using", "across", "file", "files", "code", "please",
    "want", "need", "should", "all", "new", "only", "also", "then", "than", "more", "some",
})

PY_JS_EXTS = (".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx")


def _extract_tokens(text: str) -> list[str]:
    raw = re.findall(r"[A-Za-z0-9_./-]{2,}", text or "")
    out: list[str] = []
    seen: set[str] = set()
    for tok in raw:
        low = tok.lower().strip("./-")
        if len(low) < 2 or low in GRAPH_STOPWORDS or low in seen:
            continue
        seen.add(low)
        out.append(low)
        # Also split snake/camel/path components
        for part in re.split(r"[/._-]+", low):
            if len(part) >= 3 and part not in GRAPH_STOPWORDS and part not in seen:
                seen.add(part)
                out.append(part)
    return out


def _git_dirty_files(workspace_dir: Path) -> list[str]:
    if not (workspace_dir / ".git").exists():
        return []
    try:
        proc = run_in_group(
            [
                "git",
                "-c", "core.hooksPath=/dev/null",
                "-c", "core.fsmonitor=false",
                "-C", str(workspace_dir),
                "status", "--porcelain", "--untracked-files=normal",
            ],
            timeout=3,
            kind="graph",
            label="git status (graph)",
            sweep_group=True,
            register=False,
        )
        if proc.returncode != 0:
            return []
        files: list[str] = []
        for line in proc.stdout.splitlines():
            if len(line) >= 4:
                rel = line[3:].strip().split(" -> ")[-1].strip('"')
                if rel:
                    files.append(rel)
        return files
    except Exception:
        return []


GRAPH_SKIP_DIRS = frozenset({
    ".git", "node_modules", ".wk", ".watchkeeper", "dist", "build", "__pycache__", "graphify-out",
    "venv", ".venv", "site-packages", "coverage", "target",
})
DEFAULT_GRAPH_MAX_FILES = 20000
DEFAULT_GRAPH_BUDGET_S = 45.0


def graph_max_files() -> int:
    """Safety ceiling on indexed files (env WK_GRAPH_MAX_FILES, default 20000)."""
    try:
        v = int((os.environ.get("WK_GRAPH_MAX_FILES") or "").strip() or DEFAULT_GRAPH_MAX_FILES)
    except ValueError:
        v = DEFAULT_GRAPH_MAX_FILES
    return max(1, v)


def graph_budget_s() -> float:
    """Time budget for one build (env WK_GRAPH_BUDGET_S, default 45 s)."""
    try:
        v = float((os.environ.get("WK_GRAPH_BUDGET_S") or "").strip() or DEFAULT_GRAPH_BUDGET_S)
    except ValueError:
        v = DEFAULT_GRAPH_BUDGET_S
    return max(0.05, v)


def _walk_sources(workspace_dir: Path, *, max_files: int, deadline: float) -> tuple[list[Path], int, bool]:
    """Walk the whole workspace. Returns (files to index, files_total, truncated)."""
    candidates: list[Path] = []
    total = 0
    truncated = False
    for root_dir, dirnames, filenames in os.walk(workspace_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in GRAPH_SKIP_DIRS and not d.startswith("."))
        for fname in sorted(filenames):
            if fname.endswith(PY_JS_EXTS):
                total += 1
                if len(candidates) < max_files:
                    candidates.append(Path(root_dir) / fname)
                else:
                    truncated = True
        if time.monotonic() > deadline:
            truncated = True
            break
    return candidates, total, truncated


def coverage_path(workspace_dir: str | Path) -> Path:
    return Path(workspace_dir).expanduser() / "graphify-out" / "wk-coverage.json"


def write_coverage(
    workspace_dir: str | Path,
    graph_data: dict[str, Any] | None,
    *,
    dirty_count: int = 0,
    mode: str = "cached",
) -> dict[str, Any]:
    """Write graphify-out/wk-coverage.json beside the graph (P2-272). Honest about truncation."""
    ws = Path(workspace_dir).expanduser().resolve()
    cov = (graph_data or {}).get("wk_coverage") if isinstance(graph_data, dict) else None
    if isinstance(cov, dict) and "files_indexed" in cov:
        indexed = int(cov.get("files_indexed") or 0)
        total = int(cov.get("files_total") or indexed)
        truncated = bool(cov.get("truncated"))
    else:
        # Graph from the graphify CLI: count distinct files in the graph, and count sources on disk.
        files = {str(n.get("file") or n.get("source_file") or "") for n in ((graph_data or {}).get("nodes") or []) if isinstance(n, dict)}
        files.discard("")
        indexed = len(files)
        total = max(indexed, _walk_sources(ws, max_files=0, deadline=time.monotonic() + 10.0)[1])
        truncated = indexed < total
    out = {
        "files_indexed": indexed,
        "files_total": total,
        "built_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dirty_count": int(dirty_count),
        "mode": mode,
        "truncated": bool(truncated),
    }
    try:
        (ws / "graphify-out").mkdir(parents=True, exist_ok=True)
        atomic_write_json(coverage_path(ws), out)
    except OSError:
        pass
    try:
        if isinstance(graph_data, dict) and graph_data.get("nodes"):
            from core.graph_ego import build_ego_index
            build_ego_index(ws, graph_data)
    except Exception:
        pass
    return out


def _lightweight_ast_graph(
    workspace_dir: Path,
    max_files: int | None = None,
    budget_s: float | None = None,
) -> dict[str, Any]:
    """Deterministic zero-cost AST node/edge builder matching graphify-out/graph.json schema.

    P2-272: no fixed 250-file cap. The whole workspace is walked with a time budget and a
    configurable ceiling (WK_GRAPH_MAX_FILES, default 20000). The result carries ``wk_coverage``
    and says ``truncated`` honestly when the ceiling or the budget cut the build short.
    """
    t_start = time.monotonic()
    ceiling = int(max_files) if max_files else graph_max_files()
    budget = float(budget_s) if budget_s else graph_budget_s()
    deadline = t_start + budget
    nodes: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    node_ids: set[str] = set()
    file_count = 0
    parsed = 0

    def add_node(nid: str, label: str, ntype: str, file_path: str) -> None:
        if nid not in node_ids:
            node_ids.add(nid)
            nodes.append({"id": nid, "label": label, "type": ntype, "file": file_path})

    candidates, files_total, truncated = _walk_sources(workspace_dir, max_files=ceiling, deadline=deadline)

    by_stem: dict[str, str] = {}
    for fp in candidates:
        rel = fp.relative_to(workspace_dir).as_posix()
        nid = f"file:{rel}"
        add_node(nid, fp.name, "module", rel)
        by_stem[fp.stem.lower()] = nid
        file_count += 1

    for fp in candidates:
        if time.monotonic() > deadline:
            truncated = True
            break
        parsed += 1
        rel = fp.relative_to(workspace_dir).as_posix()
        src_id = f"file:{rel}"
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")[:64000]
        except OSError:
            continue

        if fp.suffix == ".py":
            try:
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        sym_id = f"sym:{rel}#{node.name}"
                        add_node(sym_id, node.name, "symbol", rel)
                        links.append({"source": src_id, "target": sym_id, "type": "defines"})
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        mod_leaf = node.module.split(".")[-1].lower()
                        tgt = by_stem.get(mod_leaf)
                        if tgt and tgt != src_id:
                            links.append({"source": src_id, "target": tgt, "type": "imports"})
            except SyntaxError:
                pass
        else:
            for m in re.finditer(r"(?:import\s+[^'\"]*from\s+|require\()['\"]([^'\"]+)['\"]", text):
                imp = m.group(1)
                stem = Path(imp).stem.lower()
                tgt = by_stem.get(stem)
                if tgt and tgt != src_id:
                    links.append({"source": src_id, "target": tgt, "type": "imports"})
            for m in re.finditer(r"^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_][A-Za-z0-9_]*)", text, re.MULTILINE):
                sym_id = f"sym:{rel}#{m.group(1)}"
                add_node(sym_id, m.group(1), "symbol", rel)
                links.append({"source": src_id, "target": sym_id, "type": "defines"})

    return {
        "schema_version": 1,
        "graphify_version": "watchkeeper-ast-2.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "file_count": file_count,
        "wk_coverage": {
            "files_indexed": parsed,
            "files_total": max(files_total, file_count),
            "truncated": bool(truncated),
            "build_seconds": round(time.monotonic() - t_start, 2),
        },
        "nodes": nodes,
        "links": links,
    }


def _is_bootstrappable_workspace(workspace_dir: Path) -> bool:
    """Return True for non-root, non-$HOME workspaces that contain source files."""
    try:
        ws = workspace_dir.resolve()
        if ws == Path(ws.anchor) or ws == Path.home().resolve() or not ws.is_dir():
            return False
    except OSError:
        return False
    skip_dirs = GRAPH_SKIP_DIRS
    for root_dir, dirnames, filenames in os.walk(ws):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
        for fname in filenames:
            if fname.endswith(PY_JS_EXTS):
                return True
        if len(Path(root_dir).parts) - len(ws.parts) >= 3:
            dirnames[:] = []
    return False


_WS_TOKEN_CACHE: dict[str, tuple[float, int]] = {}


def _dirty_signature(ws: Path, dirty: list[str]) -> str:
    if not dirty:
        return ""
    parts: list[str] = []
    for rel in sorted(set(dirty))[:100]:
        p = ws / rel
        try:
            st = p.stat()
            parts.append(f"{rel}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{rel}:missing")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _estimate_workspace_tokens(workspace_dir: Path, max_files: int | None = None) -> int:
    """Fast bounded stat-based estimate of raw workspace tokens (cached briefly per workspace)."""
    ws_key = str(workspace_dir)
    now = time.monotonic()
    cached = _WS_TOKEN_CACHE.get(ws_key)
    if cached and (now - cached[0]) < 30.0:
        return cached[1]
    skip_dirs = GRAPH_SKIP_DIRS
    max_files = int(max_files) if max_files else graph_max_files()
    total_bytes = 0
    seen_files = 0
    try:
        for root_dir, dirnames, filenames in os.walk(workspace_dir):
            dirnames[:] = sorted(d for d in dirnames if d not in skip_dirs and not d.startswith("."))
            for fname in sorted(filenames):
                if not fname.endswith(PY_JS_EXTS):
                    continue
                fp = Path(root_dir) / fname
                try:
                    total_bytes += min(256000, fp.stat().st_size)
                    seen_files += 1
                except OSError:
                    pass
                if seen_files >= max_files:
                    est = max(0, int(total_bytes / 3.2))
                    _WS_TOKEN_CACHE[ws_key] = (now, est)
                    return est
    except OSError:
        return 0
    est = max(0, int(total_bytes / 3.2))
    _WS_TOKEN_CACHE[ws_key] = (now, est)
    return est


def format_graphify_context_block(subgraph: dict[str, Any]) -> str:
    """Render a compact Graphify structural grounding + token-saving block for prompts."""
    if not subgraph or not subgraph.get("available"):
        return ""
    sav = subgraph.get("token_savings") or {}
    nodes = subgraph.get("nodes") or []
    edges = subgraph.get("edges") or []
    files: list[str] = []
    for n in nodes:
        f = str(n.get("file") or "").strip()
        if f and f not in files:
            files.append(f)
    lines = [
        "## Graphify 2-Hop Context (Token-Saving Layer)",
        f"- Graph coverage: {subgraph.get('total_nodes', 0)} nodes, {subgraph.get('total_edges', 0)} edges ({subgraph.get('freshness', 'fresh')}).",
    ]
    if sav.get("full_repo_est_tokens"):
        lines.append(
            f"- Estimated context saved: ~{sav.get('saved_tokens', 0):,} tokens ({sav.get('saved_pct', 0)}% smaller than raw scan)."
        )
    if files:
        lines.append(f"- Focus files: {', '.join(f'`{f}`' for f in files[:8])}")
    if edges:
        edge_str = ", ".join(f"{e['source']}->{e['target']}" for e in edges[:6])
        lines.append(f"- Key 2-hop edges: {edge_str}")
    lines.append("- Token-Saving Rule: Read only the focused graph files/callers above first before any broad search.")
    return "\n".join(lines)


def _load_graph_json(graph_path: Path) -> dict[str, Any] | None:
    if not graph_path.is_file():
        return None
    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("nodes"), list):
            return data
    except (OSError, ValueError):
        return None
    return None


def sync_and_load_graph(
    workspace_dir: str | Path,
    *,
    store: StateStore | None = None,
    bootstrap: bool = False,
    force: bool = False,
    dirty_paths: list[str] | None = None,
    prefer_cli: bool = True,
    cli_timeout: float = 12.0,
) -> dict[str, Any]:
    """Validate Graphify schema/freshness and perform flock-guarded incremental AST update when needed."""
    ws = Path(workspace_dir).expanduser().resolve()
    rt = store or StateStore(workspace_dir=ws)
    graph_dir = ws / "graphify-out"
    graph_file = graph_dir / "graph.json"
    report_file = graph_dir / "GRAPH_REPORT.md"
    sync_state_file = rt.root / "graph_sync_state.json"

    graph_data = _load_graph_json(graph_file)
    dirty = list(dirty_paths or [])
    if not dirty and graph_data is not None:
        dirty = _git_dirty_files(ws)

    prev_sync = read_json_safe(sync_state_file, {})
    prev_mtime = float(prev_sync.get("graph_mtime") or 0.0) if isinstance(prev_sync, dict) else 0.0
    prev_dirty_sig = str(prev_sync.get("dirty_sig") or "") if isinstance(prev_sync, dict) else ""
    cur_mtime = graph_file.stat().st_mtime if graph_file.is_file() else 0.0
    cur_dirty_sig = _dirty_signature(ws, dirty)
    dirty_changed = bool(dirty_paths) or (bool(dirty) and cur_dirty_sig != prev_dirty_sig)

    effective_bootstrap = bool(
        bootstrap
        and os.environ.get("WK_GRAPHIFY_DEFAULT", "1") != "0"
        and _is_bootstrappable_workspace(ws)
    )
    needs_update = bool(force or (graph_data is None and effective_bootstrap) or (graph_data is not None and dirty_changed) or cur_mtime > prev_mtime + 1.0)
    updated = False
    mode = "cached" if graph_data is not None else "absent"

    if needs_update:
        with file_lock(rt.locks_dir / "graphify.lock", timeout_s=8.0):
            # Re-read inside lock in case another worker just finished syncing
            graph_data = _load_graph_json(graph_file)
            cli = shutil.which("graphify") if prefer_cli else None
            if cli and graph_data is not None and (dirty or force):
                try:
                    # P2-272: own process group + sweep, so graphify's worker pools never outlive it.
                    proc = run_in_group(
                        [cli, "update", str(ws)],
                        cwd=str(ws),
                        timeout=cli_timeout,
                        kind="graphify",
                        label="graphify update",
                        sweep_group=True,
                    )
                    if proc.returncode == 0:
                        graph_data = _load_graph_json(graph_file)
                        updated = True
                        mode = "graphify-cli"
                except Exception:
                    pass

            if not updated and (effective_bootstrap or force or (graph_data is not None and dirty_changed)):
                if graph_data is None or str(graph_data.get("graphify_version") or "").startswith("watchkeeper-ast"):
                    graph_data = _lightweight_ast_graph(ws)
                    graph_dir.mkdir(parents=True, exist_ok=True)
                    atomic_write_json(graph_file, graph_data)
                    if not report_file.is_file():
                        report_file.write_text(
                            f"# Graph Report (Watchkeeper AST v2.0)\nNodes: {len(graph_data['nodes'])}\nEdges: {len(graph_data['links'])}\n",
                            encoding="utf-8",
                        )
                    updated = True
                    mode = "ast-incremental"

            _WS_TOKEN_CACHE.pop(str(ws), None)
            atomic_write_json(
                sync_state_file,
                {
                    "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "graph_mtime": graph_file.stat().st_mtime if graph_file.is_file() else 0.0,
                    "dirty_count": len(dirty),
                    "dirty_sig": cur_dirty_sig,
                    "mode": mode,
                },
            )
            if updated and graph_data is not None:
                write_coverage(ws, graph_data, dirty_count=len(dirty), mode=mode)

    nodes = (graph_data or {}).get("nodes") or []
    edges = (graph_data or {}).get("links") or (graph_data or {}).get("edges") or []
    report_summary = ""
    if report_file.is_file():
        try:
            report_summary = report_file.read_text(encoding="utf-8", errors="replace")[:2500]
        except OSError:
            report_summary = ""

    return {
        "exists": graph_data is not None,
        "freshness": "synced" if updated else ("fresh" if graph_data is not None else "none"),
        "mode": mode,
        "schema_version": (graph_data or {}).get("schema_version"),
        "graphify_version": (graph_data or {}).get("graphify_version"),
        "total_nodes": len(nodes),
        "total_edges": len(edges),
        "dirty_files": dirty[:30],
        "graph": graph_data,
        "report_summary": report_summary,
    }


def _build_adjacency(graph_data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]], dict[str, set[str]]]:
    by_id: dict[str, dict[str, Any]] = {}
    inbound: dict[str, set[str]] = defaultdict(set)
    outbound: dict[str, set[str]] = defaultdict(set)

    for n in graph_data.get("nodes") or []:
        if not isinstance(n, dict) or not n.get("id"):
            continue
        nid = str(n["id"])
        by_id[nid] = n

    raw_edges = graph_data.get("links") or graph_data.get("edges") or []
    for e in raw_edges:
        if not isinstance(e, dict):
            continue
        src = str(e.get("source") or e.get("src") or "")
        tgt = str(e.get("target") or e.get("dst") or "")
        if src and tgt and src in by_id and tgt in by_id:
            outbound[src].add(tgt)
            inbound[tgt].add(src)
    return by_id, inbound, outbound


def query_ego_subgraph(
    workspace_dir: str | Path,
    prompt: str,
    *,
    graph_info: dict[str, Any] | None = None,
    max_nodes: int = 24,
) -> dict[str, Any]:
    """Extract a surgical 2-hop ego-network subgraph locally in <50ms."""
    t0 = time.monotonic()
    ws = Path(workspace_dir).expanduser().resolve()
    info = graph_info or sync_and_load_graph(ws, bootstrap=False)
    graph_data = info.get("graph")
    if not isinstance(graph_data, dict):
        return {
            "available": False,
            "query_ms": round((time.monotonic() - t0) * 1000, 2),
            "nodes": [],
            "edges": [],
            "node_count": 0,
            "edge_count": 0,
            "freshness": info.get("freshness", "none"),
            "report_summary": info.get("report_summary", ""),
        }

    by_id, inbound, outbound = _build_adjacency(graph_data)
    tokens = _extract_tokens(prompt)
    dirty = {d.lower() for d in info.get("dirty_files") or []}

    scored: list[tuple[float, str]] = []
    for nid, node in by_id.items():
        nfile = str(node.get("source_file") or node.get("file") or "")
        hay = f"{nid} {node.get('label', '')} {nfile}".lower()
        score = 0.0
        for tok in tokens:
            if tok == str(node.get("label") or "").lower():
                score += 6.0
            elif tok in hay:
                score += 2.5
        if nfile.lower() in dirty:
            score += 1.5
        if score > 0:
            centrality = len(inbound[nid]) + 0.5 * len(outbound[nid])
            scored.append((score + min(3.0, centrality * 0.25), nid))

    scored.sort(key=lambda x: (-x[0], x[1]))
    seeds = [nid for _sc, nid in scored[:6]]

    # 2-hop BFS (inbound + outbound callers/callees/tests/configs)
    kept: list[str] = []
    seen: set[str] = set()
    frontier = list(seeds)
    for _hop in range(2):
        next_frontier: list[str] = []
        for cur in frontier:
            if cur not in seen:
                seen.add(cur)
                kept.append(cur)
                if len(kept) >= max_nodes:
                    break
            neighbors = sorted(inbound[cur] | outbound[cur], key=lambda x: -(len(inbound[x]) + len(outbound[x])))
            for nb in neighbors[:8]:
                if nb not in seen:
                    next_frontier.append(nb)
        frontier = next_frontier
        if len(kept) >= max_nodes:
            break

    kept_set = set(kept[:max_nodes])
    sub_nodes = [
        {
            "id": nid,
            "label": by_id[nid].get("label", nid),
            "type": by_id[nid].get("type", "node"),
            "file": by_id[nid].get("source_file") or by_id[nid].get("file", ""),
            "in_degree": len(inbound[nid]),
            "out_degree": len(outbound[nid]),
        }
        for nid in kept[:max_nodes]
    ]
    sub_edges = []
    for e in (graph_data.get("links") or graph_data.get("edges") or []):
        if not isinstance(e, dict):
            continue
        s = str(e.get("source") or e.get("src") or "")
        t = str(e.get("target") or e.get("dst") or "")
        if s in kept_set and t in kept_set:
            sub_edges.append({"source": s, "target": t, "type": e.get("type", "edge")})

    full_est = _estimate_workspace_tokens(ws)
    total_nodes_cnt = info.get("total_nodes", len(by_id))
    if full_est <= 0 and total_nodes_cnt > 0:
        full_est = max(total_nodes_cnt * 180, len(sub_nodes) * 45)
    sub_payload = json.dumps({"nodes": sub_nodes, "edges": sub_edges[:60]}, separators=(",", ":"))
    sub_est = max(1, int(len(sub_payload.encode("utf-8")) / 3.2)) if sub_nodes else 0
    saved_tokens = max(0, full_est - sub_est) if full_est > 0 else 0
    saved_pct = round((saved_tokens / full_est) * 100.0, 1) if full_est > 0 else 0.0

    return {
        "available": True,
        "query_ms": round((time.monotonic() - t0) * 1000, 2),
        "seeds": seeds,
        "nodes": sub_nodes,
        "edges": sub_edges[:60],
        "node_count": len(sub_nodes),
        "edge_count": len(sub_edges[:60]),
        "total_nodes": total_nodes_cnt,
        "total_edges": info.get("total_edges", len(sub_edges)),
        "freshness": info.get("freshness", "fresh"),
        "report_summary": info.get("report_summary", ""),
        "token_savings": {
            "full_repo_est_tokens": full_est,
            "subgraph_est_tokens": sub_est,
            "saved_tokens": saved_tokens,
            "saved_pct": saved_pct,
        },
    }


def check_blast_radius(
    workspace_dir: str | Path,
    target_file: str,
    *,
    min_callers: int = 5,
) -> dict[str, Any]:
    """Evaluate inbound caller degree for PreToolUse high-impact edit warnings."""
    ws = Path(workspace_dir).expanduser().resolve()
    graph_file = ws / "graphify-out" / "graph.json"
    graph_data = _load_graph_json(graph_file)
    if not graph_data or not target_file:
        return {"high_impact": False, "callers": 0, "node_id": None}

    rel_target = target_file
    try:
        tp = Path(target_file).expanduser().resolve()
        if ws in tp.parents:
            rel_target = tp.relative_to(ws).as_posix()
    except Exception:
        pass

    by_id, inbound, _outbound = _build_adjacency(graph_data)
    best_callers = 0
    best_node: str | None = None
    low_rel = rel_target.lower()
    low_base = Path(rel_target).name.lower()

    for nid, node in by_id.items():
        n_file = str(node.get("source_file") or node.get("file") or "").lower()
        n_lbl = str(node.get("label") or "").lower()
        if n_file == low_rel or (low_base and (n_lbl == low_base or n_file.endswith("/" + low_base))):
            c = len(inbound[nid])
            if c > best_callers:
                best_callers = c
                best_node = nid

    if best_callers >= max(1, min_callers):
        return {
            "high_impact": True,
            "callers": best_callers,
            "node_id": best_node,
            "message": f"Graphify Blast-Radius Alert: {rel_target} has {best_callers} inbound graph callers; verify all callers & test suites.",
        }
    return {"high_impact": False, "callers": best_callers, "node_id": best_node}
