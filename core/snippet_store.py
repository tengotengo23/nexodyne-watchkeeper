#!/usr/bin/env python3
"""Local-first, offline-resilient, sync-ready SQLite + FTS5 shared store for verified Watchkeeper snippets & heuristics."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from core.sanitizer import (
    anonymize_author,
    anonymize_workspace,
    sanitize_path,
    sanitize_snippet_payload,
    sanitize_text,
)
from core.state_store import atomic_write_json, file_lock

VERIFICATION_RANK = {
    "quarantined": 0,
    "unverified": 1,
    "user_corrected": 2,
    "verified_pass": 3,
}


def resolve_wk_home() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser().resolve()


def resolve_db_path() -> Path:
    override = (os.environ.get("WK_SNIPPET_DB") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return resolve_wk_home() / "learning" / "snippets.db"


def resolve_learning_dir() -> Path:
    return resolve_db_path().parent


def resolve_summary_path() -> Path:
    return resolve_learning_dir() / "summary.json"


def resolve_sync_dir() -> Path | None:
    raw = (os.environ.get("WK_SNIPPET_SYNC_DIR") or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def is_kill_switch_active() -> bool:
    return (resolve_wk_home() / "KILL").exists()


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _node_id() -> str:
    return anonymize_author(os.environ.get("HOSTNAME") or os.environ.get("COMPUTERNAME") or str(Path.home()), salt="wk-node")


def _fingerprint_code(language: str, code: str) -> str:
    norm_code = re.sub(r"\s+", " ", (code or "").strip())
    return hashlib.sha256(f"{(language or 'text').lower()}:{norm_code}".encode("utf-8", errors="replace")).hexdigest()


def _build_fts_query(raw_query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", (raw_query or "").lower())
    seen: list[str] = []
    for tok in tokens:
        if len(tok) < 2 and len(tokens) > 2:
            continue
        if tok not in seen:
            seen.append(tok)
        if len(seen) >= 10:
            break
    if not seen:
        return ""
    return " OR ".join(f'"{t}"' for t in seen)


def _query_tokens(raw_query: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9_]{2,}", (raw_query or "").lower())}


class SnippetStore:
    """Thread/process-safe local-first SQLite + FTS5 repository for snippets, corrections, heuristics, and sync outbox."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path).expanduser().resolve() if db_path else resolve_db_path()
        self.learning_dir = self.db_path.parent
        self.summary_path = self.learning_dir / "summary.json"
        self.lock_path = self.learning_dir / "db.lock"
        self.fts5_enabled = True
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        self.learning_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.learning_dir, 0o700)
        except OSError:
            pass
        conn = sqlite3.connect(str(self.db_path), timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=3000;")
        return conn

    def _secure_db_permissions(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            p = Path(f"{self.db_path}{suffix}")
            if p.exists():
                try:
                    os.chmod(p, 0o600)
                except OSError:
                    pass

    def _init_schema(self) -> None:
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS snippets (
                        id TEXT PRIMARY KEY,
                        fingerprint TEXT UNIQUE NOT NULL,
                        title TEXT NOT NULL,
                        language TEXT NOT NULL,
                        code TEXT NOT NULL,
                        context TEXT NOT NULL DEFAULT '',
                        tags_json TEXT NOT NULL DEFAULT '[]',
                        verification_status TEXT NOT NULL DEFAULT 'unverified',
                        verification_cmd TEXT NOT NULL DEFAULT '',
                        author_id TEXT NOT NULL,
                        source TEXT NOT NULL DEFAULT 'manual',
                        workspace_hash TEXT NOT NULL DEFAULT 'ws_global',
                        redactions_json TEXT NOT NULL DEFAULT '[]',
                        quality_score REAL NOT NULL DEFAULT 1.0,
                        use_count INTEGER NOT NULL DEFAULT 0,
                        correction_count INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        sync_state TEXT NOT NULL DEFAULT 'pending',
                        origin_node TEXT NOT NULL DEFAULT ''
                    );
                    CREATE INDEX IF NOT EXISTS idx_snippets_lang ON snippets(language);
                    CREATE INDEX IF NOT EXISTS idx_snippets_ver ON snippets(verification_status);

                    CREATE TABLE IF NOT EXISTS corrections (
                        id TEXT PRIMARY KEY,
                        snippet_id TEXT,
                        file_path TEXT NOT NULL DEFAULT '',
                        language TEXT NOT NULL DEFAULT 'text',
                        category TEXT NOT NULL DEFAULT 'general',
                        agent_code TEXT NOT NULL DEFAULT '',
                        user_code TEXT NOT NULL DEFAULT '',
                        diff_summary TEXT NOT NULL DEFAULT '',
                        context TEXT NOT NULL DEFAULT '',
                        session_id TEXT NOT NULL DEFAULT 'default',
                        workspace_hash TEXT NOT NULL DEFAULT 'ws_global',
                        author_id TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_corrections_cat ON corrections(category);

                    CREATE TABLE IF NOT EXISTS heuristics (
                        id TEXT PRIMARY KEY,
                        scope TEXT NOT NULL DEFAULT 'global',
                        language TEXT NOT NULL DEFAULT 'all',
                        rule_text TEXT NOT NULL,
                        category TEXT NOT NULL DEFAULT 'general',
                        confidence REAL NOT NULL DEFAULT 0.65,
                        evidence_count INTEGER NOT NULL DEFAULT 1,
                        ranking_weight REAL NOT NULL DEFAULT 1.0,
                        tags_json TEXT NOT NULL DEFAULT '[]',
                        active INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_heuristics_lang ON heuristics(language);

                    CREATE TABLE IF NOT EXISTS sync_outbox (
                        id TEXT PRIMARY KEY,
                        entity_type TEXT NOT NULL,
                        entity_id TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL,
                        synced_at TEXT
                    );
                    CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status);

                    CREATE TABLE IF NOT EXISTS meta (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    """
                )
                try:
                    conn.executescript(
                        """
                        CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                            title,
                            language,
                            code,
                            context,
                            tags,
                            tokenize='porter unicode61'
                        );
                        CREATE TRIGGER IF NOT EXISTS snippets_ai AFTER INSERT ON snippets BEGIN
                            INSERT INTO snippets_fts(rowid, title, language, code, context, tags)
                            VALUES (new.rowid, new.title, new.language, new.code, new.context, new.tags_json);
                        END;
                        CREATE TRIGGER IF NOT EXISTS snippets_au AFTER UPDATE ON snippets BEGIN
                            DELETE FROM snippets_fts WHERE rowid = old.rowid;
                            INSERT INTO snippets_fts(rowid, title, language, code, context, tags)
                            VALUES (new.rowid, new.title, new.language, new.code, new.context, new.tags_json);
                        END;
                        CREATE TRIGGER IF NOT EXISTS snippets_ad AFTER DELETE ON snippets BEGIN
                            DELETE FROM snippets_fts WHERE rowid = old.rowid;
                        END;
                        """
                    )
                    self.fts5_enabled = True
                except sqlite3.OperationalError:
                    self.fts5_enabled = False
                conn.commit()
                self._cached_node_id = self._ensure_node_id_locked(conn)
                conn.commit()
            finally:
                conn.close()
            self._secure_db_permissions()

    def _ensure_node_id_locked(self, conn: sqlite3.Connection) -> str:
        row = conn.execute("SELECT value FROM meta WHERE key = 'node_id'").fetchone()
        if row and row["value"]:
            return str(row["value"])
        nid = f"node_{uuid.uuid4().hex[:12]}"
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('node_id', ?)", (nid,))
        return nid

    def get_node_id(self) -> str:
        if getattr(self, "_cached_node_id", None):
            return str(self._cached_node_id)
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                nid = self._ensure_node_id_locked(conn)
                conn.commit()
                self._cached_node_id = nid
                return nid
            finally:
                conn.close()

    def _row_to_snippet(self, row: sqlite3.Row) -> dict[str, Any]:
        tags: list[str] = []
        redactions: list[str] = []
        try:
            tags = json.loads(row["tags_json"] or "[]")
        except Exception:
            tags = []
        try:
            redactions = json.loads(row["redactions_json"] or "[]")
        except Exception:
            redactions = []
        return {
            "id": row["id"],
            "fingerprint": row["fingerprint"],
            "title": row["title"],
            "language": row["language"],
            "code": row["code"],
            "context": row["context"],
            "tags": tags,
            "verification_status": row["verification_status"],
            "verification_cmd": row["verification_cmd"],
            "author_id": row["author_id"],
            "source": row["source"],
            "workspace_hash": row["workspace_hash"],
            "redactions": redactions,
            "quality_score": float(row["quality_score"] or 1.0),
            "use_count": int(row["use_count"] or 0),
            "correction_count": int(row["correction_count"] or 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "sync_state": row["sync_state"],
            "origin_node": row["origin_node"],
        }

    def _row_to_heuristic(self, row: sqlite3.Row) -> dict[str, Any]:
        try:
            tags = json.loads(row["tags_json"] or "[]")
        except Exception:
            tags = []
        return {
            "id": row["id"],
            "scope": row["scope"],
            "language": row["language"],
            "rule_text": row["rule_text"],
            "category": row["category"],
            "confidence": float(row["confidence"] or 0.6),
            "evidence_count": int(row["evidence_count"] or 1),
            "ranking_weight": float(row["ranking_weight"] or 1.0),
            "tags": tags,
            "active": bool(row["active"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _enqueue_outbox(
        self,
        conn: sqlite3.Connection,
        *,
        entity_type: str,
        entity_id: str,
        payload: dict[str, Any],
        now: str,
    ) -> None:
        out_id = f"sync_{uuid.uuid4().hex[:14]}"
        conn.execute(
            """
            INSERT INTO sync_outbox(id, entity_type, entity_id, payload_json, status, attempts, last_error, created_at)
            VALUES (?, ?, ?, ?, 'pending', 0, '', ?)
            """,
            (out_id, entity_type, entity_id, json.dumps(payload, ensure_ascii=False), now),
        )

    def _write_summary_locked(self, conn: sqlite3.Connection) -> dict[str, Any]:
        counts = conn.execute(
            """
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN verification_status = 'verified_pass' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN verification_status = 'user_corrected' THEN 1 ELSE 0 END) AS user_corrected
            FROM snippets
            """
        ).fetchone()
        corr_cnt = conn.execute("SELECT COUNT(*) AS c FROM corrections").fetchone()["c"]
        heur_cnt = conn.execute("SELECT COUNT(*) AS c FROM heuristics WHERE active = 1").fetchone()["c"]
        pend_cnt = conn.execute("SELECT COUNT(*) AS c FROM sync_outbox WHERE status = 'pending'").fetchone()["c"]

        top_snips_rows = conn.execute(
            """
            SELECT * FROM snippets
            WHERE verification_status IN ('verified_pass', 'user_corrected')
            ORDER BY
              CASE verification_status WHEN 'verified_pass' THEN 3 WHEN 'user_corrected' THEN 2 ELSE 1 END DESC,
              quality_score DESC,
              use_count DESC,
              updated_at DESC
            LIMIT 15
            """
        ).fetchall()
        top_heur_rows = conn.execute(
            """
            SELECT * FROM heuristics
            WHERE active = 1
            ORDER BY confidence DESC, evidence_count DESC, updated_at DESC
            LIMIT 10
            """
        ).fetchall()

        last_sync_row = conn.execute("SELECT value FROM meta WHERE key = 'last_sync_at'").fetchone()
        summary = {
            "available": True,
            "updated_at": _utc_now(),
            "db_path": str(self.db_path),
            "snippetCount": int((counts["total"] if counts else 0) or 0),
            "verifiedCount": int((counts["verified"] if counts else 0) or 0),
            "userCorrectedCount": int((counts["user_corrected"] if counts else 0) or 0),
            "correctionCount": int(corr_cnt or 0),
            "heuristicCount": int(heur_cnt or 0),
            "pendingSyncCount": int(pend_cnt or 0),
            "lastSyncAt": last_sync_row["value"] if last_sync_row else None,
            "topSnippets": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "language": r["language"],
                    "verification_status": r["verification_status"],
                    "quality_score": round(float(r["quality_score"] or 1.0), 2),
                    "use_count": int(r["use_count"] or 0),
                    "tags": json.loads(r["tags_json"] or "[]"),
                }
                for r in top_snips_rows
            ],
            "topHeuristics": [
                {
                    "id": r["id"],
                    "language": r["language"],
                    "category": r["category"],
                    "rule_text": r["rule_text"],
                    "confidence": round(float(r["confidence"] or 0.6), 2),
                    "evidence_count": int(r["evidence_count"] or 1),
                }
                for r in top_heur_rows
            ],
        }
        atomic_write_json(self.summary_path, summary)
        return summary

    def save_snippet(
        self,
        *,
        title: str,
        code: str,
        language: str = "text",
        context: str = "",
        tags: list[str] | None = None,
        verification_status: str = "unverified",
        verification_cmd: str = "",
        author_id: str | None = None,
        source: str = "manual",
        workspace_dir: str | Path | None = None,
        queue_sync: bool = True,
        origin_node: str | None = None,
    ) -> dict[str, Any]:
        """Sanitize, deduplicate, and persist a code snippet in the local FTS5 store."""
        raw_payload = {
            "title": (title or "Code snippet").strip()[:160],
            "code": str(code or ""),
            "language": (language or "text").strip().lower()[:32] or "text",
            "context": str(context or "")[:2000],
            "tags": list(tags or []),
            "verification_status": verification_status if verification_status in VERIFICATION_RANK else "unverified",
            "verification_cmd": str(verification_cmd or "")[:200],
            "author_id": author_id or "",
            "source": (source or "manual").strip()[:40],
            "workspace_hash": anonymize_workspace(workspace_dir),
        }
        clean, redactions, block_reason = sanitize_snippet_payload(raw_payload, workspace_dir=workspace_dir)
        if clean is None:
            return {"ok": False, "blocked": True, "reason": block_reason, "redactions": redactions}

        if not str(clean.get("code") or "").strip():
            return {"ok": False, "blocked": False, "reason": "Empty snippet code.", "redactions": redactions}

        fp = _fingerprint_code(clean["language"], clean["code"])
        now = _utc_now()
        node = origin_node or self.get_node_id()
        init_quality = 1.6 if clean["verification_status"] == "verified_pass" else (1.25 if clean["verification_status"] == "user_corrected" else 1.0)

        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                existing = conn.execute("SELECT * FROM snippets WHERE fingerprint = ?", (fp,)).fetchone()
                if existing:
                    cur_tags = json.loads(existing["tags_json"] or "[]")
                    merged_tags = sorted(set(cur_tags + list(clean["tags"] or [])))[:16]
                    cur_ver = existing["verification_status"]
                    next_ver = (
                        clean["verification_status"]
                        if VERIFICATION_RANK.get(clean["verification_status"], 0) >= VERIFICATION_RANK.get(cur_ver, 0)
                        else cur_ver
                    )
                    next_cmd = clean["verification_cmd"] or existing["verification_cmd"]
                    next_quality = min(5.0, max(float(existing["quality_score"] or 1.0), init_quality) + 0.1)
                    next_corr = int(existing["correction_count"] or 0) + (1 if clean["source"] == "user_correction" else 0)
                    cur_red = json.loads(existing["redactions_json"] or "[]")
                    merged_red = sorted(set(cur_red + redactions))
                    conn.execute(
                        """
                        UPDATE snippets
                        SET title = ?, context = ?, tags_json = ?, verification_status = ?, verification_cmd = ?,
                            redactions_json = ?, quality_score = ?, correction_count = ?, updated_at = ?, sync_state = 'pending'
                        WHERE id = ?
                        """,
                        (
                            clean["title"] or existing["title"],
                            clean["context"] or existing["context"],
                            json.dumps(merged_tags, ensure_ascii=False),
                            next_ver,
                            next_cmd,
                            json.dumps(merged_red, ensure_ascii=False),
                            next_quality,
                            next_corr,
                            now,
                            existing["id"],
                        ),
                    )
                    row = conn.execute("SELECT * FROM snippets WHERE id = ?", (existing["id"],)).fetchone()
                    snip = self._row_to_snippet(row)
                else:
                    snip_id = f"snp_{uuid.uuid4().hex[:14]}"
                    conn.execute(
                        """
                        INSERT INTO snippets (
                            id, fingerprint, title, language, code, context, tags_json,
                            verification_status, verification_cmd, author_id, source, workspace_hash,
                            redactions_json, quality_score, use_count, correction_count,
                            created_at, updated_at, sync_state, origin_node
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?)
                        """,
                        (
                            snip_id,
                            fp,
                            clean["title"],
                            clean["language"],
                            clean["code"],
                            clean["context"],
                            json.dumps(clean["tags"], ensure_ascii=False),
                            clean["verification_status"],
                            clean["verification_cmd"],
                            clean["author_id"],
                            clean["source"],
                            clean["workspace_hash"],
                            json.dumps(redactions, ensure_ascii=False),
                            init_quality,
                            1 if clean["source"] == "user_correction" else 0,
                            now,
                            now,
                            node,
                        ),
                    )
                    row = conn.execute("SELECT * FROM snippets WHERE id = ?", (snip_id,)).fetchone()
                    snip = self._row_to_snippet(row)

                if queue_sync:
                    self._enqueue_outbox(conn, entity_type="snippet", entity_id=snip["id"], payload=snip, now=now)
                self._write_summary_locked(conn)
                conn.commit()
            finally:
                conn.close()
            self._secure_db_permissions()
        return {"ok": True, "blocked": False, "snippet": snip, "redactions": redactions}

    def mark_verified(
        self,
        snippet_ids: list[str],
        *,
        verification_cmd: str = "",
        status: str = "verified_pass",
    ) -> int:
        ids = [str(x).strip() for x in (snippet_ids or []) if str(x).strip()]
        if not ids:
            return 0
        cmd_res = sanitize_text(verification_cmd)
        clean_cmd = "" if cmd_res.blocked else cmd_res.text[:200]
        target_status = status if status in VERIFICATION_RANK else "verified_pass"
        now = _utc_now()
        updated = 0
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                for sid in ids:
                    row = conn.execute("SELECT * FROM snippets WHERE id = ?", (sid,)).fetchone()
                    if not row:
                        continue
                    next_q = min(5.0, float(row["quality_score"] or 1.0) + 0.3)
                    conn.execute(
                        """
                        UPDATE snippets
                        SET verification_status = ?, verification_cmd = ?, quality_score = ?, updated_at = ?, sync_state = 'pending'
                        WHERE id = ?
                        """,
                        (target_status, clean_cmd or row["verification_cmd"], next_q, now, sid),
                    )
                    refreshed = conn.execute("SELECT * FROM snippets WHERE id = ?", (sid,)).fetchone()
                    if refreshed:
                        self._enqueue_outbox(
                            conn,
                            entity_type="snippet",
                            entity_id=sid,
                            payload=self._row_to_snippet(refreshed),
                            now=now,
                        )
                        updated += 1
                if updated:
                    self._write_summary_locked(conn)
                conn.commit()
            finally:
                conn.close()
            self._secure_db_permissions()
        return updated

    def record_correction_entry(
        self,
        *,
        snippet_id: str | None,
        file_path: str,
        language: str,
        category: str,
        agent_code: str,
        user_code: str,
        diff_summary: str,
        context: str = "",
        session_id: str = "default",
        workspace_dir: str | Path | None = None,
        author_id: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "file_path": sanitize_path(file_path, workspace_dir=workspace_dir),
            "agent_code": agent_code[:6000],
            "user_code": user_code[:6000],
            "diff_summary": diff_summary[:2000],
            "context": context[:1500],
            "author_id": author_id or "",
            "workspace_hash": anonymize_workspace(workspace_dir),
        }
        clean, redactions, block_reason = sanitize_snippet_payload(payload, workspace_dir=workspace_dir)
        if clean is None:
            return {"ok": False, "blocked": True, "reason": block_reason, "redactions": redactions}

        corr_id = f"cor_{uuid.uuid4().hex[:14]}"
        now = _utc_now()
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO corrections (
                        id, snippet_id, file_path, language, category, agent_code, user_code,
                        diff_summary, context, session_id, workspace_hash, author_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        corr_id,
                        snippet_id,
                        clean["file_path"],
                        (language or "text").lower()[:32],
                        (category or "general").lower()[:40],
                        clean["agent_code"],
                        clean["user_code"],
                        clean["diff_summary"],
                        clean["context"],
                        str(session_id or "default")[:96],
                        clean["workspace_hash"],
                        clean["author_id"],
                        now,
                    ),
                )
                self._write_summary_locked(conn)
                conn.commit()
            finally:
                conn.close()
            self._secure_db_permissions()
        return {"ok": True, "correction_id": corr_id, "redactions": redactions}

    def upsert_heuristic(
        self,
        *,
        rule_text: str,
        category: str = "general",
        language: str = "all",
        scope: str = "global",
        tags: list[str] | None = None,
        confidence_delta: float = 0.08,
        ranking_delta: float = 0.15,
        queue_sync: bool = True,
    ) -> dict[str, Any]:
        res = sanitize_text(rule_text)
        if res.blocked or not res.text.strip():
            return {"ok": False, "blocked": res.blocked, "reason": res.block_reason or "Empty heuristic."}
        clean_rule = res.text.strip()[:500]
        clean_cat = (category or "general").strip().lower()[:40]
        clean_lang = (language or "all").strip().lower()[:32]
        clean_scope = (scope or "global").strip().lower()[:32]
        clean_tags = sorted({str(t).strip().lower()[:40] for t in (tags or []) if str(t).strip()})[:16]
        now = _utc_now()

        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                existing = conn.execute(
                    """
                    SELECT * FROM heuristics
                    WHERE LOWER(category) = ? AND LOWER(language) = ? AND LOWER(rule_text) = LOWER(?)
                    LIMIT 1
                    """,
                    (clean_cat, clean_lang, clean_rule),
                ).fetchone()
                if existing:
                    next_conf = min(0.99, max(0.2, float(existing["confidence"] or 0.6) + confidence_delta))
                    next_rank = min(3.0, max(0.5, float(existing["ranking_weight"] or 1.0) + ranking_delta))
                    next_ev = int(existing["evidence_count"] or 1) + 1
                    merged_tags = sorted(set(json.loads(existing["tags_json"] or "[]") + clean_tags))[:16]
                    conn.execute(
                        """
                        UPDATE heuristics
                        SET confidence = ?, ranking_weight = ?, evidence_count = ?, tags_json = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (next_conf, next_rank, next_ev, json.dumps(merged_tags, ensure_ascii=False), now, existing["id"]),
                    )
                    row = conn.execute("SELECT * FROM heuristics WHERE id = ?", (existing["id"],)).fetchone()
                else:
                    hid = f"heu_{hashlib.sha256(f'{clean_cat}:{clean_lang}:{clean_rule.lower()}'.encode()).hexdigest()[:14]}"
                    conn.execute(
                        """
                        INSERT INTO heuristics (
                            id, scope, language, rule_text, category, confidence,
                            evidence_count, ranking_weight, tags_json, active, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 0.68, 1, 1.15, ?, 1, ?, ?)
                        """,
                        (hid, clean_scope, clean_lang, clean_rule, clean_cat, json.dumps(clean_tags, ensure_ascii=False), now, now),
                    )
                    row = conn.execute("SELECT * FROM heuristics WHERE id = ?", (hid,)).fetchone()
                heur = self._row_to_heuristic(row)
                if queue_sync:
                    self._enqueue_outbox(conn, entity_type="heuristic", entity_id=heur["id"], payload=heur, now=now)
                self._write_summary_locked(conn)
                conn.commit()
            finally:
                conn.close()
            self._secure_db_permissions()
        return {"ok": True, "heuristic": heur}

    def query_heuristics(
        self,
        query: str = "",
        *,
        language: str = "",
        tags: list[str] | None = None,
        min_confidence: float = 0.45,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        q_tokens = _query_tokens(query) | {str(t).strip().lower() for t in (tags or []) if str(t).strip()}
        lang_l = (language or "").strip().lower()
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM heuristics WHERE active = 1 AND confidence >= ? ORDER BY confidence DESC, evidence_count DESC LIMIT 80",
                (min_confidence,),
            ).fetchall()
        finally:
            conn.close()

        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            h = self._row_to_heuristic(row)
            score = h["confidence"] * 2.0 + min(h["evidence_count"], 10) * 0.15
            if lang_l and h["language"] in (lang_l, "all"):
                score += 1.2 if h["language"] == lang_l else 0.4
            h_tokens = _query_tokens(f"{h['rule_text']} {h['category']} {' '.join(h['tags'])}")
            overlap = q_tokens & h_tokens
            if q_tokens:
                if not overlap and h["language"] not in (lang_l, "all"):
                    continue
                score += len(overlap) * 1.1
            if not q_tokens or overlap or (lang_l and h["language"] == lang_l) or h["confidence"] >= 0.78:
                scored.append((score, h))

        scored.sort(key=lambda item: (-item[0], -item[1]["evidence_count"]))
        return [h for _sc, h in scored[: max(1, limit)]]

    def query_snippets(
        self,
        query: str = "",
        *,
        language: str = "",
        tags: list[str] | None = None,
        verified_only: bool = False,
        limit: int = 5,
    ) -> dict[str, Any]:
        """Query verified and user-corrected snippets with FTS5 BM25 + learned ranking weights."""
        t0 = time.perf_counter()
        lang_l = (language or "").strip().lower()
        want_tags = {str(t).strip().lower() for t in (tags or []) if str(t).strip()}
        fts_q = _build_fts_query(query)
        q_tokens = _query_tokens(query) | want_tags

        conn = self._connect()
        try:
            rows_with_rank: list[tuple[sqlite3.Row, float]] = []
            if fts_q and self.fts5_enabled:
                try:
                    sql = """
                        SELECT s.*, bm25(snippets_fts) AS rank
                        FROM snippets_fts
                        JOIN snippets s ON s.rowid = snippets_fts.rowid
                        WHERE snippets_fts MATCH ?
                    """
                    params: list[Any] = [fts_q]
                    if verified_only:
                        sql += " AND s.verification_status = 'verified_pass'"
                    if lang_l:
                        sql += " AND LOWER(s.language) = ?"
                        params.append(lang_l)
                    sql += " ORDER BY rank ASC LIMIT ?"
                    params.append(max(25, limit * 8))
                    for r in conn.execute(sql, params).fetchall():
                        rows_with_rank.append((r, float(r["rank"] or 0.0)))
                except sqlite3.OperationalError:
                    rows_with_rank = []

            if not rows_with_rank:
                sql = "SELECT * FROM snippets WHERE 1=1"
                params = []
                if verified_only:
                    sql += " AND verification_status = 'verified_pass'"
                if lang_l:
                    sql += " AND LOWER(language) = ?"
                    params.append(lang_l)
                sql += " ORDER BY quality_score DESC, use_count DESC, updated_at DESC LIMIT ?"
                params.append(max(40, limit * 10))
                for r in conn.execute(sql, params).fetchall():
                    rows_with_rank.append((r, 0.0))

            heur_rows = conn.execute("SELECT tags_json, language, ranking_weight FROM heuristics WHERE active = 1").fetchall()
        finally:
            conn.close()

        tag_boosts: dict[str, float] = {}
        for hr in heur_rows:
            w = float(hr["ranking_weight"] or 1.0)
            for t in json.loads(hr["tags_json"] or "[]"):
                tag_boosts[t] = max(tag_boosts.get(t, 1.0), w)

        scored: list[tuple[float, dict[str, Any]]] = []
        for row, bm25_rank in rows_with_rank:
            s = self._row_to_snippet(row)
            if s["verification_status"] == "quarantined":
                continue
            s_tokens = _query_tokens(f"{s['title']} {s['language']} {s['code'][:400]} {s['context']} {' '.join(s['tags'])}")
            overlap = q_tokens & s_tokens
            if q_tokens and not overlap and bm25_rank == 0.0:
                continue

            # bm25() in SQLite FTS5 returns negative values where more-negative = stronger match
            lex_score = min(6.0, -bm25_rank) if bm25_rank < 0 else len(overlap) * 1.15
            ver_bonus = 1.6 if s["verification_status"] == "verified_pass" else (0.95 if s["verification_status"] == "user_corrected" else 0.1)
            lang_bonus = 1.4 if (lang_l and s["language"] == lang_l) else 0.0
            tag_overlap = len(want_tags & set(s["tags"])) * 0.9 if want_tags else 0.0
            heur_mult = max([tag_boosts.get(t, 1.0) for t in s["tags"]] or [1.0])
            total_score = (lex_score + ver_bonus + lang_bonus + tag_overlap + s["quality_score"] * 0.45 + min(s["use_count"], 20) * 0.06) * min(2.0, heur_mult)
            s["score"] = round(total_score, 4)
            scored.append((total_score, s))

        scored.sort(key=lambda item: (-item[0], -VERIFICATION_RANK.get(item[1]["verification_status"], 0)))
        results = [item[1] for item in scored[: max(1, limit)]]
        latency_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        return {
            "ok": True,
            "snippets": results,
            "total_matched": len(scored),
            "latency_ms": latency_ms,
        }

    def record_snippet_feedback(self, snippet_id: str, *, helpful: bool = True) -> dict[str, Any]:
        now = _utc_now()
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                row = conn.execute("SELECT * FROM snippets WHERE id = ?", (snippet_id,)).fetchone()
                if not row:
                    return {"ok": False, "error": f"Snippet {snippet_id} not found."}
                next_uses = int(row["use_count"] or 0) + (1 if helpful else 0)
                delta = 0.12 if helpful else -0.25
                next_q = max(0.2, min(5.0, float(row["quality_score"] or 1.0) + delta))
                conn.execute(
                    "UPDATE snippets SET use_count = ?, quality_score = ?, updated_at = ? WHERE id = ?",
                    (next_uses, next_q, now, snippet_id),
                )
                updated = conn.execute("SELECT * FROM snippets WHERE id = ?", (snippet_id,)).fetchone()
                self._write_summary_locked(conn)
                conn.commit()
                return {"ok": True, "snippet": self._row_to_snippet(updated)}
            finally:
                conn.close()

    def stats(self) -> dict[str, Any]:
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                return self._write_summary_locked(conn)
            finally:
                conn.close()

    def export_sync_bundle(self, dest_path: str | Path | None = None, *, only_pending: bool = False) -> dict[str, Any]:
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                if only_pending:
                    snip_rows = conn.execute("SELECT * FROM snippets WHERE sync_state = 'pending'").fetchall()
                else:
                    snip_rows = conn.execute("SELECT * FROM snippets WHERE verification_status != 'quarantined'").fetchall()
                heur_rows = conn.execute("SELECT * FROM heuristics WHERE active = 1").fetchall()
            finally:
                conn.close()

        sanitized_snippets: list[dict[str, Any]] = []
        for r in snip_rows:
            s = self._row_to_snippet(r)
            clean, _red, _blk = sanitize_snippet_payload(s)
            if clean is not None:
                sanitized_snippets.append(clean)

        sanitized_heuristics: list[dict[str, Any]] = []
        for r in heur_rows:
            h = self._row_to_heuristic(r)
            res = sanitize_text(h["rule_text"])
            if not res.blocked and res.text.strip():
                h["rule_text"] = res.text.strip()
                sanitized_heuristics.append(h)

        bundle = {
            "schema_version": "1.0.0",
            "node_id": self.get_node_id(),
            "exported_at": _utc_now(),
            "snippets": sanitized_snippets,
            "heuristics": sanitized_heuristics,
        }
        if dest_path is not None:
            out = Path(dest_path).expanduser().resolve()
            atomic_write_json(out, bundle)
            return {"ok": True, "path": str(out), "snippets": len(sanitized_snippets), "heuristics": len(sanitized_heuristics)}
        return {"ok": True, "bundle": bundle, "snippets": len(sanitized_snippets), "heuristics": len(sanitized_heuristics)}

    def import_sync_bundle(self, src_path_or_dict: str | Path | dict[str, Any]) -> dict[str, Any]:
        if isinstance(src_path_or_dict, dict):
            bundle = src_path_or_dict
        else:
            p = Path(src_path_or_dict).expanduser().resolve()
            if not p.is_file():
                return {"ok": False, "error": f"Bundle file not found: {p}", "imported_snippets": 0, "blocked_snippets": 0}
            bundle = json.loads(p.read_text(encoding="utf-8"))

        imported_snips = 0
        blocked_snips = 0
        imported_heur = 0
        origin = str(bundle.get("node_id") or "remote")[:40]
        for s in bundle.get("snippets") or []:
            if not isinstance(s, dict):
                continue
            res = self.save_snippet(
                title=str(s.get("title") or "Shared snippet"),
                code=str(s.get("code") or ""),
                language=str(s.get("language") or "text"),
                context=str(s.get("context") or ""),
                tags=list(s.get("tags") or []),
                verification_status=str(s.get("verification_status") or "unverified"),
                verification_cmd=str(s.get("verification_cmd") or ""),
                author_id=anonymize_author(str(s.get("author_id") or "")),
                source=str(s.get("source") or "sync"),
                workspace_dir=str(s.get("workspace_hash") or "ws_shared"),
                queue_sync=False,
                origin_node=str(s.get("origin_node") or origin),
            )
            if res.get("ok"):
                imported_snips += 1
            elif res.get("blocked"):
                blocked_snips += 1

        for h in bundle.get("heuristics") or []:
            if not isinstance(h, dict):
                continue
            hres = self.upsert_heuristic(
                rule_text=str(h.get("rule_text") or ""),
                category=str(h.get("category") or "general"),
                language=str(h.get("language") or "all"),
                scope=str(h.get("scope") or "shared"),
                tags=list(h.get("tags") or []),
                confidence_delta=0.04,
                ranking_delta=0.08,
                queue_sync=False,
            )
            if hres.get("ok"):
                imported_heur += 1

        return {
            "ok": True,
            "imported_snippets": imported_snips,
            "blocked_snippets": blocked_snips,
            "imported_heuristics": imported_heur,
        }

    def sync_now(
        self,
        *,
        sync_dir: str | Path | None = None,
        sync_url: str | None = None,
        timeout_s: float = 3.0,
    ) -> dict[str, Any]:
        """Offline-first sync across shared directory bundles and/or optional HTTP sync endpoint."""
        if is_kill_switch_active():
            return {
                "ok": False,
                "killed": True,
                "offline": False,
                "pushed": 0,
                "pulled": 0,
                "error": "Kill switch active (~/.wk/KILL); sync skipped.",
            }

        target_dir = Path(sync_dir).expanduser().resolve() if sync_dir else resolve_sync_dir()
        target_url = (sync_url or os.environ.get("WK_SNIPPET_SYNC_URL") or "").strip()

        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                pending_rows = conn.execute("SELECT * FROM sync_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 200").fetchall()
            finally:
                conn.close()

        pending_ids = [r["id"] for r in pending_rows]
        if not target_dir and not target_url:
            return {
                "ok": True,
                "offline": True,
                "mode": "local_only",
                "queued": len(pending_ids),
                "pushed": 0,
                "pulled": 0,
            }

        pushed = 0
        pulled = 0
        blocked_on_pull = 0

        if target_dir:
            try:
                my_node = self.get_node_id()
                target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                if pending_ids:
                    out_file = target_dir / f"{my_node}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}.bundle.json"
                    exp = self.export_sync_bundle(out_file, only_pending=True)
                    pushed += int(exp.get("snippets") or 0)

                seen_key_prefix = "sync_seen_"
                with file_lock(self.lock_path):
                    conn = self._connect()
                    try:
                        seen_rows = conn.execute("SELECT key FROM meta WHERE key LIKE ?", (f"{seen_key_prefix}%",)).fetchall()
                        seen_names = {r["key"][len(seen_key_prefix):] for r in seen_rows}
                    finally:
                        conn.close()

                for bf in sorted(target_dir.glob("*.bundle.json")):
                    if bf.name.startswith(f"{my_node}-") or bf.name in seen_names:
                        continue
                    imp = self.import_sync_bundle(bf)
                    pulled += int(imp.get("imported_snippets") or 0)
                    blocked_on_pull += int(imp.get("blocked_snippets") or 0)
                    with file_lock(self.lock_path):
                        conn = self._connect()
                        try:
                            conn.execute(
                                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                                (f"{seen_key_prefix}{bf.name}", _utc_now()),
                            )
                            conn.commit()
                        finally:
                            conn.close()

                self._mark_outbox_synced(pending_ids)
                return {
                    "ok": True,
                    "offline": False,
                    "mode": "shared_dir",
                    "pushed": pushed,
                    "pulled": pulled,
                    "blocked": blocked_on_pull,
                    "queued": 0,
                }
            except Exception as exc:
                return {
                    "ok": False,
                    "offline": True,
                    "mode": "shared_dir",
                    "pushed": 0,
                    "pulled": 0,
                    "queued": len(pending_ids),
                    "error": str(exc),
                }

        # HTTP sync endpoint (never crashes when offline/unreachable)
        export_res = self.export_sync_bundle(only_pending=True)
        bundle = export_res["bundle"]
        headers = {"Content-Type": "application/json"}
        token = (os.environ.get("WK_SNIPPET_SYNC_TOKEN") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            target_url,
            data=json.dumps(bundle, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw_resp = resp.read().decode("utf-8", errors="replace")
            pushed = len(bundle.get("snippets") or [])
            try:
                peer_data = json.loads(raw_resp) if raw_resp.strip() else {}
            except Exception:
                peer_data = {}
            if isinstance(peer_data, dict) and (peer_data.get("snippets") or peer_data.get("heuristics")):
                imp = self.import_sync_bundle(peer_data)
                pulled = int(imp.get("imported_snippets") or 0)
                blocked_on_pull = int(imp.get("blocked_snippets") or 0)
            self._mark_outbox_synced(pending_ids)
            return {
                "ok": True,
                "offline": False,
                "mode": "http",
                "pushed": pushed,
                "pulled": pulled,
                "blocked": blocked_on_pull,
                "queued": 0,
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
            now = _utc_now()
            if pending_ids:
                with file_lock(self.lock_path):
                    conn = self._connect()
                    try:
                        for oid in pending_ids:
                            conn.execute(
                                "UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?",
                                (str(exc)[:240], oid),
                            )
                        conn.commit()
                    finally:
                        conn.close()
            return {
                "ok": False,
                "offline": True,
                "mode": "http",
                "pushed": 0,
                "pulled": 0,
                "queued": len(pending_ids),
                "error": str(exc),
            }

    def _mark_outbox_synced(self, outbox_ids: list[str]) -> None:
        if not outbox_ids:
            return
        now = _utc_now()
        with file_lock(self.lock_path):
            conn = self._connect()
            try:
                snippet_ids: list[str] = []
                for oid in outbox_ids:
                    row = conn.execute(
                        "SELECT entity_type, entity_id FROM sync_outbox WHERE id = ?",
                        (oid,),
                    ).fetchone()
                    if row and row["entity_type"] == "snippet" and row["entity_id"]:
                        snippet_ids.append(str(row["entity_id"]))
                    conn.execute(
                        "UPDATE sync_outbox SET status = 'synced', synced_at = ? WHERE id = ?",
                        (now, oid),
                    )
                for sid in snippet_ids:
                    conn.execute(
                        "UPDATE snippets SET sync_state = 'synced' WHERE id = ?",
                        (sid,),
                    )
                conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_sync_at', ?)", (now,))
                self._write_summary_locked(conn)
                conn.commit()
            finally:
                conn.close()
