#!/usr/bin/env python3
"""Autonomous continuous correction-detection, heuristic extraction & snippet learning engine."""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from core.sanitizer import anonymize_author, sanitize_path, sanitize_text
from core.snippet_store import (
    SnippetStore,
    is_kill_switch_active,
    resolve_db_path,
    resolve_learning_dir,
)
from core.state_store import atomic_write_json, file_lock, read_json_safe

EXT_LANG_MAP: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".kt": "kotlin",
    ".swift": "swift",
    ".sh": "bash",
    ".zsh": "bash",
    ".sql": "sql",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
    ".html": "html",
    ".css": "css",
}

SENSITIVE_PATH_RE = re.compile(
    r"(?:^|/)(?:\.env(?:\.|$)|\.ssh/|keys?/|id_rsa|id_ed25519|\.wk/gates\.json$|config/gates\.json$|policy\.sha256$|\.git/)",
    re.IGNORECASE,
)

MAX_SNAPSHOT_BYTES = 256 * 1024
MAX_SNAPSHOTS = 60
SNAPSHOT_TTL_SEC = 2 * 3600

TEST_CMD_RE = re.compile(
    r"(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bunittest\b|\bgo\s+test\b|\bcargo\s+test\b|\bswift\s+test\b|\bvitest\b|\bjest\b|\bwk-run\b)",
    re.IGNORECASE,
)


def infer_language(file_path: str | Path) -> str:
    ext = Path(str(file_path or "")).suffix.lower()
    return EXT_LANG_MAP.get(ext, "text")


def is_sensitive_file(file_path: str | Path) -> bool:
    p = str(file_path or "").strip()
    if not p:
        return True
    if SENSITIVE_PATH_RE.search(p.replace("\\", "/")):
        return True
    if p.endswith((".pem", ".key", ".p12", ".pfx")):
        return True
    return False


def _snapshots_path() -> Path:
    return resolve_learning_dir() / "agent_snapshots.json"


def _snapshots_lock() -> Path:
    return resolve_learning_dir() / "snapshots.lock"


def _sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", errors="replace")).hexdigest()


def track_agent_edit(
    *,
    file_path: str | Path,
    content: str | None = None,
    session_id: str = "default",
    workspace_dir: str | Path | None = None,
    tool_name: str = "",
) -> dict[str, Any]:
    """Snapshot an agent-modified file so later user corrections can be detected automatically."""
    if is_kill_switch_active():
        return {"ok": False, "skipped": True, "reason": "kill_switch"}
    raw_path = str(file_path or "").strip()
    if not raw_path or is_sensitive_file(raw_path):
        return {"ok": False, "skipped": True, "reason": "sensitive_or_empty_path"}

    try:
        resolved = Path(raw_path).expanduser().resolve()
    except Exception:
        return {"ok": False, "skipped": True, "reason": "invalid_path"}

    if content is None:
        if not resolved.is_file():
            return {"ok": False, "skipped": True, "reason": "missing_file"}
        try:
            if resolved.stat().st_size > MAX_SNAPSHOT_BYTES:
                return {"ok": False, "skipped": True, "reason": "file_too_large"}
            content_str = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return {"ok": False, "skipped": True, "reason": "unreadable_file"}
    else:
        if len(content.encode("utf-8", errors="replace")) > MAX_SNAPSHOT_BYTES:
            return {"ok": False, "skipped": True, "reason": "content_too_large"}
        content_str = content

    san = sanitize_text(content_str, workspace_dir=workspace_dir)
    if san.blocked:
        return {"ok": False, "skipped": True, "reason": san.block_reason}

    now_ts = time.time()
    key = str(resolved)
    snap_entry = {
        "file_path": key,
        "rel_path": sanitize_path(resolved, workspace_dir=workspace_dir),
        "language": infer_language(resolved),
        "session_id": str(session_id or "default")[:96],
        "tool_name": str(tool_name or "")[:48],
        "workspace_dir": str(Path(workspace_dir).expanduser().resolve()) if workspace_dir else "",
        "agent_hash": _sha256(content_str),
        "agent_code": san.text[:16000],
        "snippet_ids": [],
        "updated_at": now_ts,
    }

    with file_lock(_snapshots_lock()):
        data = read_json_safe(_snapshots_path(), {"snapshots": {}})
        snaps = data.get("snapshots") if isinstance(data, dict) and isinstance(data.get("snapshots"), dict) else {}
        # Expire stale entries and cap size
        fresh = {
            k: v
            for k, v in snaps.items()
            if isinstance(v, dict) and (now_ts - float(v.get("updated_at") or 0)) <= SNAPSHOT_TTL_SEC
        }
        prev = fresh.get(key)
        if isinstance(prev, dict) and prev.get("snippet_ids"):
            snap_entry["snippet_ids"] = list(prev["snippet_ids"])[-10:]
        fresh[key] = snap_entry
        if len(fresh) > MAX_SNAPSHOTS:
            ordered = sorted(fresh.items(), key=lambda kv: float(kv[1].get("updated_at") or 0), reverse=True)[:MAX_SNAPSHOTS]
            fresh = dict(ordered)
        atomic_write_json(_snapshots_path(), {"version": 1, "snapshots": fresh})

    return {"ok": True, "tracked": key, "language": snap_entry["language"]}


def extract_focused_snippet(agent_code: str, user_code: str, *, max_lines: int = 60) -> tuple[str, str]:
    """Extract the focused corrected code region plus a compact unified diff summary."""
    a_lines = (agent_code or "").splitlines()
    u_lines = (user_code or "").splitlines()
    if not u_lines:
        return "", ""

    sm = difflib.SequenceMatcher(None, a_lines, u_lines)
    changed_u_ranges: list[tuple[int, int]] = []
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            changed_u_ranges.append((j1, j2))

    if not changed_u_ranges:
        focused = "\n".join(u_lines[:max_lines])
    else:
        start = max(0, changed_u_ranges[0][0] - 4)
        end = min(len(u_lines), changed_u_ranges[-1][1] + 6)
        if end - start > max_lines:
            end = start + max_lines
        focused = "\n".join(u_lines[start:end])

    diff_lines = list(
        difflib.unified_diff(
            a_lines,
            u_lines,
            fromfile="agent_output",
            tofile="user_corrected",
            lineterm="",
            n=2,
        )
    )
    return focused.strip(), "\n".join(diff_lines[:80]).strip()


def analyze_correction_diff(
    agent_code: str,
    user_code: str,
    *,
    language: str = "",
    file_path: str = "",
    context: str = "",
) -> dict[str, Any]:
    """Classify the root cause of a developer correction and synthesize an actionable heuristic rule."""
    a_low = (agent_code or "").lower()
    u_low = (user_code or "").lower()
    diff_added = "\n".join(
        line[1:]
        for line in difflib.unified_diff((agent_code or "").splitlines(), (user_code or "").splitlines(), lineterm="")
        if line.startswith("+") and not line.startswith("+++")
    ).lower()

    lang = (language or infer_language(file_path) or "text").lower()
    stem = Path(file_path).stem if file_path else "snippet"

    category = "general"
    tags: list[str] = [lang] if lang and lang != "text" else []
    rule_text = f"In {lang} code, preserve explicit edge-case guards and clean resource handling matching developer corrections."
    title = f"Verified {lang} pattern ({stem})"

    if any(k in diff_added for k in ("finally", "dispose", "unref", "close(", "cleanup", "clearinterval", "cleartimeout")):
        category = "cleanup_lifecycle"
        tags.extend(["cleanup", "lifecycle", "timers"])
        rule_text = f"Always release timers/handles in finally/dispose (e.g. .unref() or explicit stop()) in {lang} so tests and processes never leak."
        title = f"Safe lifecycle cleanup in {lang} ({stem})"
    elif any(k in diff_added for k in ("try", "except", "catch", "raise ", "throw ", "error", "fallback")):
        category = "error_handling"
        tags.extend(["error-handling", "resilience"])
        rule_text = f"Guard failure paths explicitly with typed error handling and graceful fallback in {lang}."
        title = f"Resilient error handling in {lang} ({stem})"
    elif any(k in diff_added for k in ("async ", "await ", "promise", "lock", "flock", "timeout", "retry", "backoff")):
        category = "async_reliability"
        tags.extend(["async", "concurrency", "timeout"])
        rule_text = f"Enforce bounded timeouts, concurrency locks, and await completion on async/IO paths in {lang}."
        title = f"Bounded async/concurrency pattern in {lang} ({stem})"
    elif any(k in diff_added for k in ("sanitize", "escape", "esc(", "redact", "csrf", "hmac", "sha256", "chmod", "0o600", "validate")):
        category = "security_sanitization"
        tags.extend(["security", "sanitization", "validation"])
        rule_text = f"Sanitize/escape untrusted inputs and enforce strict permissions before persisting or rendering in {lang}."
        title = f"Sanitized & validated {lang} pattern ({stem})"
    elif any(k in diff_added for k in ("assert", "test", "expect(", "unittest", "mock")):
        category = "testing"
        tags.extend(["testing", "verification"])
        rule_text = f"Verify side effects, cache isolation, and failure cleanup in automated {lang} tests."
        title = f"Verified test pattern in {lang} ({stem})"
    elif any(k in diff_added for k in ("isinstance", "typeof", "schema", "pydantic", "typing", "null", "none", "undefined")):
        category = "typing_validation"
        tags.extend(["validation", "types"])
        rule_text = f"Validate nullable inputs and runtime types explicitly before dereferencing in {lang}."
        title = f"Defensive type & null check in {lang} ({stem})"
    elif "require.cache" in diff_added or "import " in diff_added or "from " in diff_added:
        category = "api_usage"
        tags.extend(["imports", "module-cache"])
        rule_text = f"Keep module cache/import resolution clean and explicit when wiring {lang} components."
        title = f"Clean module/import pattern in {lang} ({stem})"
    elif "cache" in diff_added or "memo" in diff_added or "fts5" in diff_added or "index" in diff_added:
        category = "performance"
        tags.extend(["performance", "caching"])
        rule_text = f"Prefer indexed lookups and bounded caches on hot paths in {lang}."
        title = f"Fast indexed/cached {lang} pattern ({stem})"
    elif a_low != u_low:
        category = "logic_bug"
        tags.append("correction")
        rule_text = f"Follow the corrected {lang} logic pattern verified in {Path(file_path).name if file_path else 'recent edits'}."

    if context:
        ctx_words = [w for w in re.findall(r"[a-z0-9_-]{3,}", context.lower()) if w not in ("the", "and", "for", "with")][:4]
        tags.extend(ctx_words)

    dedup_tags = []
    for t in tags:
        if t and t not in dedup_tags:
            dedup_tags.append(t)

    return {
        "category": category,
        "language": lang,
        "title": title[:140],
        "rule_text": rule_text,
        "tags": dedup_tags[:12],
    }


def ingest_correction(
    *,
    file_path: str | Path,
    agent_code: str,
    user_code: str,
    language: str = "",
    context: str = "",
    tags: list[str] | None = None,
    session_id: str = "default",
    workspace_dir: str | Path | None = None,
    verification_status: str = "user_corrected",
    verification_cmd: str = "",
    author_id: str | None = None,
    store: SnippetStore | None = None,
) -> dict[str, Any]:
    """Record a user correction over agent output, extract a heuristic, and store the sanitized snippet."""
    if is_sensitive_file(file_path):
        return {"ok": False, "blocked": True, "reason": "Refused correction capture on sensitive file."}

    lang = (language or infer_language(file_path) or "text").lower()
    focused_code, diff_summary = extract_focused_snippet(agent_code, user_code)
    if not focused_code:
        return {"ok": False, "blocked": False, "reason": "No user code content to learn from."}

    analysis = analyze_correction_diff(
        agent_code,
        user_code,
        language=lang,
        file_path=str(file_path),
        context=context,
    )
    merged_tags = sorted(set(analysis["tags"] + [str(t).strip().lower() for t in (tags or []) if str(t).strip()]))

    db = store or SnippetStore()
    rel_file = sanitize_path(file_path, workspace_dir=workspace_dir)
    ctx_full = f"Corrected in {rel_file}. {context}".strip()

    snip_res = db.save_snippet(
        title=analysis["title"],
        code=focused_code,
        language=lang,
        context=ctx_full,
        tags=merged_tags,
        verification_status=verification_status,
        verification_cmd=verification_cmd,
        author_id=author_id or anonymize_author(),
        source="user_correction",
        workspace_dir=workspace_dir,
    )
    if not snip_res.get("ok"):
        return snip_res

    snippet = snip_res["snippet"]
    corr_res = db.record_correction_entry(
        snippet_id=snippet["id"],
        file_path=str(file_path),
        language=lang,
        category=analysis["category"],
        agent_code=agent_code,
        user_code=focused_code,
        diff_summary=diff_summary,
        context=ctx_full,
        session_id=session_id,
        workspace_dir=workspace_dir,
        author_id=author_id,
    )
    heur_res = db.upsert_heuristic(
        rule_text=analysis["rule_text"],
        category=analysis["category"],
        language=lang,
        scope="global",
        tags=merged_tags,
        confidence_delta=0.10 if verification_status == "verified_pass" else 0.06,
        ranking_delta=0.18 if verification_status == "verified_pass" else 0.10,
    )

    return {
        "ok": True,
        "blocked": False,
        "snippet": snippet,
        "correction_id": corr_res.get("correction_id"),
        "heuristic": heur_res.get("heuristic"),
        "category": analysis["category"],
        "redactions": sorted(set((snip_res.get("redactions") or []) + (corr_res.get("redactions") or []))),
    }


def detect_and_record_correction(
    *,
    file_path: str | Path,
    new_content: str | None = None,
    session_id: str = "default",
    workspace_dir: str | Path | None = None,
    verification_status: str = "user_corrected",
    verification_cmd: str = "",
    context: str = "",
    store: SnippetStore | None = None,
) -> dict[str, Any]:
    """Compare a saved file against an earlier agent snapshot and record a correction if user changed it."""
    if is_kill_switch_active():
        return {"ok": False, "detected": False, "reason": "kill_switch"}
    if not _snapshots_path().is_file():
        return {"ok": True, "detected": False, "reason": "no_snapshots"}

    try:
        resolved = str(Path(file_path).expanduser().resolve())
    except Exception:
        return {"ok": False, "detected": False, "reason": "invalid_path"}

    with file_lock(_snapshots_lock()):
        data = read_json_safe(_snapshots_path(), {"snapshots": {}})
        snaps = data.get("snapshots") if isinstance(data, dict) and isinstance(data.get("snapshots"), dict) else {}
        snap = snaps.get(resolved)
        if not isinstance(snap, dict):
            return {"ok": True, "detected": False, "reason": "not_agent_tracked"}
        agent_hash = str(snap.get("agent_hash") or "")
        agent_code = str(snap.get("agent_code") or "")
        snap_ws = snap.get("workspace_dir") or workspace_dir

        if new_content is None:
            p = Path(resolved)
            if not p.is_file():
                return {"ok": True, "detected": False, "reason": "deleted"}
            try:
                if p.stat().st_size > MAX_SNAPSHOT_BYTES:
                    return {"ok": True, "detected": False, "reason": "too_large"}
                cur_text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                return {"ok": False, "detected": False, "reason": "unreadable"}
        else:
            cur_text = new_content

        cur_hash = _sha256(cur_text)
        if cur_hash == agent_hash:
            return {"ok": True, "detected": False, "reason": "unchanged"}

        cur_san = sanitize_text(cur_text, workspace_dir=snap_ws)
        if cur_san.blocked:
            return {"ok": False, "detected": False, "blocked": True, "reason": cur_san.block_reason}

        cur_san_cmp = cur_san.text[:16000]
        if re.sub(r"\s+", "", cur_san_cmp) == re.sub(r"\s+", "", agent_code):
            return {"ok": True, "detected": False, "reason": "whitespace_only"}

        ing = ingest_correction(
            file_path=resolved,
            agent_code=agent_code,
            user_code=cur_san.text,
            language=snap.get("language") or infer_language(resolved),
            context=context or f"Detected manual developer edit after {snap.get('tool_name') or 'agent'} write.",
            session_id=session_id or snap.get("session_id") or "default",
            workspace_dir=snap_ws,
            verification_status=verification_status,
            verification_cmd=verification_cmd,
            store=store,
        )

        if ing.get("ok") and ing.get("snippet"):
            snip_id = ing["snippet"]["id"]
            # Re-read inside lock so concurrent edits to other snapshots are preserved
            latest_data = read_json_safe(_snapshots_path(), {"snapshots": {}})
            latest_snaps = latest_data.get("snapshots") if isinstance(latest_data, dict) and isinstance(latest_data.get("snapshots"), dict) else snaps
            if resolved in latest_snaps and isinstance(latest_snaps[resolved], dict):
                latest_snaps[resolved]["agent_hash"] = cur_hash
                latest_snaps[resolved]["agent_code"] = cur_san_cmp
                latest_snaps[resolved]["updated_at"] = time.time()
                ids = list(latest_snaps[resolved].get("snippet_ids") or [])
                if snip_id not in ids:
                    ids.append(snip_id)
                latest_snaps[resolved]["snippet_ids"] = ids[-10:]
                atomic_write_json(_snapshots_path(), {"version": 1, "snapshots": latest_snaps})

        return {"ok": bool(ing.get("ok")), "detected": True, **ing}


def scan_workspace_for_corrections(
    *,
    workspace_dir: str | Path | None = None,
    session_id: str = "default",
    store: SnippetStore | None = None,
) -> list[dict[str, Any]]:
    """Fast scan of agent-tracked files in this workspace to catch user edits made outside IDE save hooks."""
    if is_kill_switch_active() or not _snapshots_path().is_file():
        return []
    data = read_json_safe(_snapshots_path(), {"snapshots": {}})
    snaps = data.get("snapshots") if isinstance(data, dict) and isinstance(data.get("snapshots"), dict) else {}
    if not snaps:
        return []

    ws_resolved = ""
    if workspace_dir:
        try:
            ws_resolved = str(Path(workspace_dir).expanduser().resolve())
        except Exception:
            ws_resolved = ""

    recorded: list[dict[str, Any]] = []
    for fpath, snap in list(snaps.items()):
        if not isinstance(snap, dict):
            continue
        if ws_resolved and snap.get("workspace_dir") and snap.get("workspace_dir") != ws_resolved:
            if not str(fpath).startswith(ws_resolved + os.sep):
                continue
        res = detect_and_record_correction(
            file_path=fpath,
            session_id=session_id,
            workspace_dir=workspace_dir or snap.get("workspace_dir"),
            store=store,
        )
        if res.get("detected") and res.get("ok"):
            recorded.append(res)
    return recorded


def promote_session_snippets_on_test_pass(
    *,
    session_id: str = "default",
    workspace_dir: str | Path | None = None,
    test_command: str = "",
    store: SnippetStore | None = None,
) -> dict[str, Any]:
    """When a test command passes, promote recent session snippets to verified_pass and reinforce heuristics."""
    if is_kill_switch_active():
        return {"ok": False, "promoted": 0, "reason": "kill_switch"}
    if test_command and not TEST_CMD_RE.search(test_command):
        return {"ok": True, "promoted": 0, "reason": "not_test_command"}
    if not _snapshots_path().is_file():
        return {"ok": True, "promoted": 0, "reason": "no_snapshots"}

    data = read_json_safe(_snapshots_path(), {"snapshots": {}})
    snaps = data.get("snapshots") if isinstance(data, dict) and isinstance(data.get("snapshots"), dict) else {}
    ws_resolved = ""
    if workspace_dir:
        try:
            ws_resolved = str(Path(workspace_dir).expanduser().resolve())
        except Exception:
            ws_resolved = ""

    req_sid = (session_id or "").strip()
    candidate_ids: list[str] = []
    for fpath, snap in snaps.items():
        if not isinstance(snap, dict):
            continue
        if ws_resolved and not (snap.get("workspace_dir") == ws_resolved or str(fpath).startswith(ws_resolved + os.sep)):
            continue
        snap_sid = str(snap.get("session_id") or "").strip()
        if req_sid and req_sid != "default" and snap_sid and snap_sid != "default" and snap_sid != req_sid:
            continue
        for sid in snap.get("snippet_ids") or []:
            if sid not in candidate_ids:
                candidate_ids.append(sid)

    if not candidate_ids:
        return {"ok": True, "promoted": 0, "reason": "no_pending_session_snippets"}

    db = store or SnippetStore()
    promoted = db.mark_verified(candidate_ids, verification_cmd=test_command, status="verified_pass")
    return {"ok": True, "promoted": promoted, "snippet_ids": candidate_ids}


def build_learning_context(
    prompt_text: str,
    *,
    workspace_dir: str | Path | None = None,
    language: str = "",
    max_snippets: int = 3,
    max_heuristics: int = 4,
    store: SnippetStore | None = None,
) -> dict[str, Any]:
    """Zero-overhead retrieval of relevant verified snippets & learned heuristics for prompt enrichment."""
    t0 = time.perf_counter()
    db_file = store.db_path if store else resolve_db_path()
    if not db_file.is_file():
        return {
            "has_context": False,
            "snippets": [],
            "heuristics": [],
            "ranking_boosts": {},
            "markdown": "",
            "latency_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        }

    db = store or SnippetStore(db_path=db_file)
    snip_res = db.query_snippets(prompt_text, language=language, verified_only=False, limit=max_snippets)
    snippets = snip_res.get("snippets") or []
    heuristics = db.query_heuristics(prompt_text, language=language, min_confidence=0.45, limit=max_heuristics)

    ranking_boosts: dict[str, float] = {}
    for h in heuristics:
        for t in h.get("tags") or []:
            ranking_boosts[t] = max(ranking_boosts.get(t, 0.0), float(h.get("ranking_weight") or 1.0))

    if not snippets and not heuristics:
        return {
            "has_context": False,
            "snippets": [],
            "heuristics": [],
            "ranking_boosts": {},
            "markdown": "",
            "latency_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        }

    lines: list[str] = ["## Learned Guardrails & Verified Snippets (Watchkeeper Memory)"]
    if heuristics:
        lines.append("**Learned Heuristics from Prior Corrections:**")
        for h in heuristics[:max_heuristics]:
            lines.append(f"- [{h['category']} | {h['language']} | conf {h['confidence']:.2f}] {h['rule_text']}")
    if snippets:
        lines.append("**Verified Reusable Snippets:**")
        for s in snippets[:max_snippets]:
            badge = "verified" if s["verification_status"] == "verified_pass" else s["verification_status"]
            code_preview = "\n".join((s.get("code") or "").splitlines()[:18])
            lines.append(f"- **{s['title']}** (`{s['language']}`, `{badge}`, id `{s['id']}`)\n```{s['language']}\n{code_preview}\n```")

    md = "\n".join(lines)[:1800]
    return {
        "has_context": True,
        "snippets": snippets,
        "heuristics": heuristics,
        "ranking_boosts": ranking_boosts,
        "markdown": md,
        "latency_ms": round((time.perf_counter() - t0) * 1000.0, 3),
    }
