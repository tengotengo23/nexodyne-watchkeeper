#!/usr/bin/env python3
"""Fail-closed privacy, secret, PII, and local-path sanitizer for Watchkeeper learning & shared snippets."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
GATES_FILE = ROOT / "config" / "gates.json"

# Fallback secret regexes mirrored defensively in case config/gates.json is unavailable in isolated envs.
BUILTIN_SECRET_PATTERNS: tuple[str, ...] = (
    r"sk-ant-[A-Za-z0-9_-]{20,}",
    r"sk_live_[A-Za-z0-9]{16,}",
    r"AKIA[0-9A-Z]{16}",
    r"ghp_[A-Za-z0-9]{30,}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
)

SECRET_REPLACEMENTS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "private_key_block",
        re.compile(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            re.IGNORECASE,
        ),
        "[REDACTED_PRIVATE_KEY]",
    ),
    (
        "private_key_unclosed",
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*", re.IGNORECASE),
        "[REDACTED_PRIVATE_KEY]",
    ),
    (
        "anthropic_key",
        re.compile(r"\bsk-ant-[A-Za-z0-9_-]{12,}\b"),
        "[REDACTED_ANTHROPIC_KEY]",
    ),
    (
        "openai_key",
        re.compile(r"\bsk-(?:proj-|svcacct-|live-|test-)?[A-Za-z0-9_-]{20,}\b"),
        "[REDACTED_OPENAI_KEY]",
    ),
    (
        "stripe_key",
        re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b"),
        "[REDACTED_STRIPE_KEY]",
    ),
    (
        "aws_access_key",
        re.compile(r"\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b"),
        "[REDACTED_AWS_KEY]",
    ),
    (
        "github_token",
        re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
        "[REDACTED_GITHUB_TOKEN]",
    ),
    (
        "google_api_key",
        re.compile(r"\bAIza[0-9A-Za-z\-_]{25,}\b"),
        "[REDACTED_GOOGLE_KEY]",
    ),
    (
        "slack_token",
        re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"),
        "[REDACTED_SLACK_TOKEN]",
    ),
    (
        "jwt_token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
        "[REDACTED_JWT]",
    ),
    (
        "uri_credentials",
        re.compile(r"([a-z][a-z0-9+.-]*://)([^/\s:@\"']{1,64}):([^/\s@\"']{1,128})@([^\s/\"']+)"),
        r"\1[REDACTED_USER]:[REDACTED_PASS]@\4",
    ),
    (
        "auth_header",
        re.compile(r"(?i)\b(authorization\s*[:=]\s*['\"]?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/-]{8,}=*"),
        r"\1[REDACTED_TOKEN]",
    ),
    (
        "bearer_token",
        re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*"),
        "Bearer [REDACTED_TOKEN]",
    ),
    (
        "env_secret_assignment_quoted",
        re.compile(
            r"(?im)^(\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_SECRET|WEBHOOK_SECRET|SIGNING_KEY)[A-Z0-9_]*\s*=\s*)(['\"])(?!\[REDACTED_)([^'\"\n]{6,})\2"
        ),
        r"\1\2[REDACTED_SECRET]\2",
    ),
    (
        "env_secret_assignment",
        re.compile(
            r"(?im)^(\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_SECRET|WEBHOOK_SECRET|SIGNING_KEY)[A-Z0-9_]*\s*=\s*)(['\"]?)(?!\[REDACTED_)([^\s'\"#\n]{6,})\2"
        ),
        r"\1\2[REDACTED_SECRET]\2",
    ),
    (
        "code_secret_assignment",
        re.compile(
            r"(?i)(['\"]?(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|password|passwd|private[_-]?key|stripe[_-]?key)['\"]?\s*[:=]\s*)(['\"])(?!\[REDACTED_)([^'\"\n]{8,})\2"
        ),
        r"\1\2[REDACTED_SECRET]\2",
    ),
    (
        "yaml_unquoted_secret",
        re.compile(
            r"(?im)^(\s*(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|password|passwd|private[_-]?key)\s*:\s*)(?!\[REDACTED_|https?://|true\b|false\b|null\b)([^\s'\"#\n{}[\]]{8,})\s*(?:#.*)?$"
        ),
        r"\1[REDACTED_SECRET]",
    ),
)

PII_REPLACEMENTS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "email",
        re.compile(
            r"\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|localhost\b|test\.local\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
        ),
        "[REDACTED_EMAIL]",
    ),
    (
        "ssn",
        re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
        "[REDACTED_SSN]",
    ),
    (
        "phone",
        re.compile(r"(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?![\w.])"),
        "[REDACTED_PHONE]",
    ),
    (
        "ipv4_private_or_public",
        re.compile(
            r"\b(?!(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)\b)"
            r"(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"
        ),
        "[REDACTED_IP]",
    ),
)

PATH_REPLACEMENTS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "macos_user_path",
        re.compile(r"/Users/[A-Za-z0-9._-]+"),
        "~",
    ),
    (
        "linux_home_path",
        re.compile(r"/home/[A-Za-z0-9._-]+"),
        "~",
    ),
    (
        "windows_user_path",
        re.compile(r"[A-Za-z]:\\Users\\[A-Za-z0-9._-]+"),
        "~",
    ),
    (
        "macos_tmp_var_folder",
        re.compile(r"(?:/private)?/var/folders/[A-Za-z0-9_/-]+/T/[A-Za-z0-9_.-]+"),
        "<TMP_DIR>",
    ),
)

CANDIDATE_CC_RE = re.compile(r"\b(?:\d[ -]*?){13,16}\b")
ENV_DUMP_LINE_RE = re.compile(
    r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(?!\s)\S+",
    re.MULTILINE,
)
ENV_SECRET_KEY_TOKENS = ("API_KEY", "SECRET", "PASSWORD", "PASSWD", "TOKEN", "PRIVATE_KEY", "DATABASE_URL", "AUTH_KEY")
CANARY_RE = re.compile(r"WK-PRIVATE-CANARY")


@dataclass
class SanitizeResult:
    """Result of sanitizing code, diff, or context text prior to persistence or sharing."""

    text: str
    redactions: list[str] = field(default_factory=list)
    blocked: bool = False
    block_reason: str = ""
    original_hash: str = ""


def _luhn_valid(digits: str) -> bool:
    if len(digits) < 13 or len(digits) > 19 or not digits.isdigit():
        return False
    total = 0
    rev = digits[::-1]
    for idx, ch in enumerate(rev):
        val = int(ch)
        if idx % 2 == 1:
            val *= 2
            if val > 9:
                val -= 9
        total += val
    return total % 10 == 0


def _load_gate_secret_patterns() -> list[re.Pattern[str]]:
    patterns = list(BUILTIN_SECRET_PATTERNS)
    if GATES_FILE.is_file():
        try:
            raw = json.loads(GATES_FILE.read_text(encoding="utf-8"))
            for pat in raw.get("secretPatterns") or []:
                if isinstance(pat, str) and pat not in patterns:
                    patterns.append(pat)
        except Exception:
            pass
    compiled: list[re.Pattern[str]] = []
    for pat in patterns:
        try:
            compiled.append(re.compile(pat))
        except re.error:
            pass
    return compiled


def anonymize_author(raw_author: str | None = None, salt: str | None = None) -> str:
    """Return an irreversible pseudonymous author ID (`usr_<12hex>`)."""
    cand = str(raw_author or "").strip()
    if re.fullmatch(r"usr_[0-9a-f]{8,24}", cand):
        return cand
    seed = cand or os.environ.get("USER") or os.environ.get("USERNAME") or "watchkeeper-local"
    salt_val = salt or os.environ.get("WK_AUTHOR_SALT") or str(Path.home())
    digest = hashlib.sha256(f"{salt_val}:{seed}".encode("utf-8", errors="replace")).hexdigest()
    return f"usr_{digest[:12]}"


def anonymize_workspace(workspace_dir: str | Path | None = None) -> str:
    """Return a non-identifying workspace hash (`ws_<12hex>`)."""
    raw = str(workspace_dir or "").strip()
    if not raw or raw in ("ws_global", "ws_shared"):
        return raw or "ws_global"
    if re.fullmatch(r"ws_[0-9a-f]{8,24}", raw):
        return raw
    try:
        resolved = str(Path(raw).expanduser().resolve())
    except Exception:
        resolved = raw
    digest = hashlib.sha256(resolved.encode("utf-8", errors="replace")).hexdigest()
    return f"ws_{digest[:12]}"


def sanitize_path(file_path: str | Path, workspace_dir: str | Path | None = None) -> str:
    """Convert an absolute filesystem path into a workspace-relative or anonymized path."""
    raw = str(file_path or "").strip()
    if not raw:
        return ""
    if workspace_dir:
        try:
            ws = Path(workspace_dir).expanduser().resolve()
            fp = Path(raw).expanduser().resolve()
            try:
                rel = fp.relative_to(ws)
                return rel.as_posix()
            except ValueError:
                pass
        except Exception:
            pass
    out = raw
    for _name, rx, repl in PATH_REPLACEMENTS:
        out = rx.sub(repl, out)
    return out


def sanitize_text(
    text: str,
    *,
    workspace_dir: str | Path | None = None,
    extra_secret_patterns: list[str] | None = None,
) -> SanitizeResult:
    """Scrub secrets, credentials, PII, and local environment paths; fail closed on canary or .env dumps."""
    raw = str(text or "")
    orig_hash = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()
    if not raw.strip():
        return SanitizeResult(text=raw, original_hash=orig_hash)

    if CANARY_RE.search(raw):
        return SanitizeResult(
            text="",
            redactions=["canary_blocked"],
            blocked=True,
            block_reason="Blocked content matching WK-PRIVATE-CANARY privacy sentinel.",
            original_hash=orig_hash,
        )

    env_keys = ENV_DUMP_LINE_RE.findall(raw)
    if len(env_keys) >= 3 and any(
        tok in k.upper() for k in env_keys for tok in ENV_SECRET_KEY_TOKENS
    ):
        return SanitizeResult(
            text="",
            redactions=["env_dump_blocked"],
            blocked=True,
            block_reason="Blocked raw .env / credential dump from snippet storage.",
            original_hash=orig_hash,
        )

    cleaned = raw
    redactions: list[str] = []

    if workspace_dir:
        try:
            ws_str = str(Path(workspace_dir).expanduser().resolve())
            if len(ws_str) > 3 and ws_str in cleaned:
                cleaned = cleaned.replace(ws_str, "<WORKSPACE>")
                redactions.append("workspace_root")
        except Exception:
            pass
    home_str = str(Path.home())
    if len(home_str) > 3 and home_str in cleaned:
        cleaned = cleaned.replace(home_str, "~")
        redactions.append("home_dir")

    for label, rx, repl in SECRET_REPLACEMENTS:
        next_txt, count = rx.subn(repl, cleaned)
        if count:
            cleaned = next_txt
            redactions.append(label)

    for label, rx, repl in PATH_REPLACEMENTS:
        next_txt, count = rx.subn(repl, cleaned)
        if count and label not in redactions:
            cleaned = next_txt
            redactions.append(label)

    for label, rx, repl in PII_REPLACEMENTS:
        next_txt, count = rx.subn(repl, cleaned)
        if count:
            cleaned = next_txt
            redactions.append(label)

    def _cc_sub(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if _luhn_valid(digits):
            if "credit_card" not in redactions:
                redactions.append("credit_card")
            return "[REDACTED_CARD]"
        return match.group(0)

    cleaned = CANDIDATE_CC_RE.sub(_cc_sub, cleaned)

    gate_patterns = _load_gate_secret_patterns()
    for pat_str in extra_secret_patterns or []:
        try:
            gate_patterns.append(re.compile(pat_str))
        except re.error:
            pass

    for gate_rx in gate_patterns:
        next_txt, count = gate_rx.subn("[REDACTED_POLICY_SECRET]", cleaned)
        if count:
            cleaned = next_txt
            if "policy_secret" not in redactions:
                redactions.append("policy_secret")

    # Fail closed if any gate secret pattern still matches after redaction pass.
    for gate_rx in gate_patterns:
        if gate_rx.search(cleaned):
            return SanitizeResult(
                text="",
                redactions=redactions + ["residual_secret_blocked"],
                blocked=True,
                block_reason="Sanitizer fail-closed: residual secret pattern detected after redaction.",
                original_hash=orig_hash,
            )

    return SanitizeResult(
        text=cleaned,
        redactions=sorted(set(redactions)),
        blocked=False,
        block_reason="",
        original_hash=orig_hash,
    )


def sanitize_snippet_payload(
    payload: dict[str, Any],
    *,
    workspace_dir: str | Path | None = None,
) -> tuple[dict[str, Any] | None, list[str], str]:
    """Sanitize every text/path field in a snippet or sync record. Returns (clean_dict, redactions, block_reason)."""
    if not isinstance(payload, dict):
        return None, [], "Invalid snippet payload type."

    all_redactions: list[str] = []
    out = dict(payload)

    for field_name in ("title", "code", "context", "agent_code", "user_code", "diff_summary", "rule_text", "verification_cmd"):
        if field_name in out and out[field_name] is not None:
            res = sanitize_text(str(out[field_name]), workspace_dir=workspace_dir)
            if res.blocked:
                return None, sorted(set(all_redactions + res.redactions)), res.block_reason
            out[field_name] = res.text
            all_redactions.extend(res.redactions)

    if "file_path" in out and out["file_path"] is not None:
        out["file_path"] = sanitize_path(str(out["file_path"]), workspace_dir=workspace_dir)
        fp_res = sanitize_text(out["file_path"], workspace_dir=workspace_dir)
        if fp_res.blocked:
            return None, sorted(set(all_redactions + fp_res.redactions)), fp_res.block_reason
        out["file_path"] = fp_res.text
        all_redactions.extend(fp_res.redactions)

    if "author_id" in out:
        out["author_id"] = anonymize_author(str(out.get("author_id") or ""))
    else:
        out["author_id"] = anonymize_author()

    if "workspace_hash" in out or workspace_dir is not None:
        out["workspace_hash"] = anonymize_workspace(out.get("workspace_hash") or workspace_dir)

    raw_tags = out.get("tags")
    if isinstance(raw_tags, list):
        clean_tags: list[str] = []
        for t in raw_tags[:16]:
            t_res = sanitize_text(str(t).strip(), workspace_dir=workspace_dir)
            if t_res.blocked:
                return None, sorted(set(all_redactions + t_res.redactions)), t_res.block_reason
            val = t_res.text.strip().lower()[:40]
            if val and val not in clean_tags:
                clean_tags.append(val)
        out["tags"] = clean_tags

    return out, sorted(set(all_redactions)), ""
