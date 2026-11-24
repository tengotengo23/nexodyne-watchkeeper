#!/usr/bin/env python3
"""3-Tier Skill Library Indexer, Unrestricted Multi-Skill Composer & Resource Loader.

P2-272 (spec section 3.5): one skill router. The vault index (~/.gemini/skill-vault/index.json, or
$REPROMPT_SKILL_VAULT_DIR/index.json) is the one source for vault skills, read through
reprompt/scripts/skill_vault.load_index (which drops unapproved sources). The index file is checked first
(`_index_file().is_file()`), so this adapter never triggers an expensive index build. Core's local scans
(project .claude/skills, Watchkeeper skills, the Antigravity plugin, ~/.claude/skills and commands) stay, with
SCOPE_PRIORITY deciding name collisions. ~/.wk/runtime/skills-manifest.json is a cache and, for vault skills,
only a fallback when the vault cannot be loaded.

Pin grammar (case-insensitive; "/" allowed so `owner/repo/skill` ids work):
  pin:       `+skill:<name>` or `@skill:<name>`   -> PIN_PLUS_RE  = (?:^|\s)[+@]skill:([A-Za-z0-9_./:-]+)
  suppress:  `-skill:<name>`                       -> PIN_MINUS_RE = (?:^|\s)-skill:([A-Za-z0-9_./:-]+)
Each pin resolves to one skill: exact name or id first, then the normalised name
(re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")), then a substring of the name or id; ties go to the
better scope (SCOPE_PRIORITY), then the name. A pin that resolves nowhere is ignored.
Automatic (unprefixed) rewriting starts at AUTO_FLOOR_CHARS = 8 (reprompt/scripts/prompt_prefix.py).
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path
from typing import Any

from core.state_store import StateStore, atomic_write_json, read_json_safe

ROOT = Path(__file__).resolve().parent.parent

# Priority 1 beats 2 beats 3 beats 4 on colliding skill names
SCOPE_PRIORITY = {
    "project_local": 1,
    "watchkeeper_core": 2,
    "antigravity_plugin": 2,
    "user_global": 3,
    "skill_vault": 4,
}

PIN_PLUS_RE = re.compile(r"(?:^|\s)[+@]skill:([A-Za-z0-9_./:-]+)", re.IGNORECASE)
PIN_MINUS_RE = re.compile(r"(?:^|\s)-skill:([A-Za-z0-9_./:-]+)", re.IGNORECASE)
AUTO_FLOOR_CHARS = 8  # mirrors reprompt/scripts/prompt_prefix.AUTO_FLOOR_CHARS
_VAULT_SCRIPTS_DIR = ROOT / "reprompt" / "scripts"
REL_LINK_RE = re.compile(r"(?:\(([^()\s]+\.(?:md|sh|py|mjs|js|json|yaml|yml))\)|`((?:scripts|references|templates|assets)/[^`\s]+)`)", re.IGNORECASE)

DOMAIN_SYNONYMS: dict[str, tuple[str, ...]] = {
    "api": ("endpoint", "rest", "graphql", "route", "handler", "openapi", "http", "backend"),
    "sql": ("database", "postgres", "sqlite", "migration", "schema", "query", "table"),
    "security": ("auth", "oauth", "jwt", "csrf", "xss", "secret", "vulnerability", "hardening", "audit", "owasp", "threat"),
    "ui": ("frontend", "css", "layout", "design", "component", "react", "webview", "screen", "ux"),
    "test": ("testing", "unit", "pytest", "vitest", "jest", "assert", "verify", "coverage", "evidence"),
    "graph": ("graphify", "ast", "dependency", "architecture", "module", "refactor"),
    "token": ("tokens", "compact", "context", "cost", "lean", "cache"),
    "orchestrate": ("gemini", "claude", "routing", "workflow", "multi-agent", "handoff"),
}

STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "when", "what", "make", "add",
    "fix", "update", "create", "build", "check", "using", "across", "file", "files", "also", "then",
})


def _tokenize(text: str) -> set[str]:
    base = {t for t in re.findall(r"[a-z0-9]{2,}", (text or "").lower()) if t not in STOPWORDS}
    expanded = set(base)
    for tok in base:
        for grp, words in DOMAIN_SYNONYMS.items():
            if tok == grp or tok in words:
                expanded.add(grp)
                expanded.update(words[:3])
    return expanded


def _parse_frontmatter(text: str, fallback_name: str) -> tuple[str, str, list[str], str]:
    name = fallback_name
    desc = ""
    tags: list[str] = []
    body = text
    m = re.match(r"^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$", text)
    if m:
        fm = m.group(1)
        body = m.group(2)
        nm = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
        if nm:
            name = nm.group(1).strip().strip("\"'")
        dm = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
        if dm:
            desc = dm.group(1).strip().strip("\"'")
        tg = re.search(r"^tags:\s*\[([^\]]*)\]", fm, re.MULTILINE)
        if tg:
            tags = [x.strip().strip("\"'").lower() for x in tg.group(1).split(",") if x.strip()]
    if not desc:
        for line in body.splitlines():
            line_s = line.strip()
            if line_s and not line_s.startswith("#"):
                desc = line_s[:240]
                break
    return name, desc, tags, body


def _discover_aux_files(skill_dir: Path, body: str) -> dict[str, list[str]]:
    aux: dict[str, list[str]] = {"scripts": [], "references": [], "templates": [], "assets": []}
    for sub in aux:
        sub_dir = skill_dir / sub
        if sub_dir.is_dir():
            for p in sorted(sub_dir.rglob("*")):
                if p.is_file() and not p.name.startswith("."):
                    aux[sub].append(str(p))

    for m in REL_LINK_RE.finditer(body):
        rel = m.group(1) or m.group(2)
        if not rel or rel.startswith("http"):
            continue
        cand = (skill_dir / rel).resolve()
        if cand.is_file() and skill_dir.resolve() in cand.parents:
            if cand.parent.name in aux:
                if str(cand) not in aux[cand.parent.name]:
                    aux[cand.parent.name].append(str(cand))
            elif cand.suffix in (".py", ".sh", ".mjs", ".js"):
                if str(cand) not in aux["scripts"]:
                    aux["scripts"].append(str(cand))
            elif str(cand) not in aux["references"]:
                aux["references"].append(str(cand))
    return aux


def _load_vault_module() -> Any:
    """skill_vault, loaded lazily by file path (it puts reprompt/scripts on sys.path when imported)."""
    import importlib.util
    import sys

    mod = sys.modules.get("skill_vault")
    if mod is not None and hasattr(mod, "load_index") and hasattr(mod, "_index_file"):
        return mod
    path = _VAULT_SCRIPTS_DIR / "skill_vault.py"
    spec = importlib.util.spec_from_file_location("skill_vault", str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["skill_vault"] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop("skill_vault", None)
        raise
    return mod


def _load_vault_skills(vault_file: Path) -> list[dict[str, Any]] | None:
    """Vault skills from the one vault index; [] when there is no index; None when it cannot be read."""
    if not vault_file.is_file():
        return []
    prev = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
    try:
        # Point skill_vault at the same vault this manifest fingerprints (it may use another HOME).
        os.environ["REPROMPT_SKILL_VAULT_DIR"] = str(vault_file.parent)
        sv = _load_vault_module()
        if not sv._index_file().is_file():
            return []
        data = sv.load_index()
        skills = data.get("skills") if isinstance(data, dict) else None
        return [sk for sk in skills if isinstance(sk, dict)] if isinstance(skills, list) else []
    except (Exception, SystemExit):
        return None
    finally:
        if prev is None:
            os.environ.pop("REPROMPT_SKILL_VAULT_DIR", None)
        else:
            os.environ["REPROMPT_SKILL_VAULT_DIR"] = prev


def build_skills_manifest(
    *,
    workspace_dir: str | Path | None = None,
    plugin_root: str | Path = ROOT,
    home: str | Path | None = None,
    store: StateStore | None = None,
    force_reload: bool = False,
) -> dict[str, Any]:
    """Tier-0 cached index of all project-local, Watchkeeper, user-global & vault skills (<10ms warm)."""
    t0 = time.monotonic()
    ws = Path(workspace_dir).expanduser().resolve() if workspace_dir else Path(plugin_root).expanduser().resolve()
    pr = Path(plugin_root).expanduser().resolve()
    hm = Path(home or os.environ.get("HOME") or Path.home()).expanduser().resolve()
    rt = store or StateStore(workspace_dir=ws)
    manifest_file = rt.root / "skills-manifest.json"

    scan_roots: list[tuple[str, Path]] = [
        ("project_local", ws / ".claude" / "skills"),
        ("watchkeeper_core", pr / "skills"),
        ("antigravity_plugin", pr / "antigravity" / "plugins" / "watchkeeper" / "skills"),
        ("user_global", hm / ".claude" / "skills"),
        ("user_global", hm / ".claude" / "commands"),
    ]

    candidate_files: list[tuple[str, Path, float, str]] = []
    for scope, base in scan_roots:
        if not base.is_dir():
            continue
        if base.name == "commands":
            for p in sorted(base.glob("*.md")):
                st = p.stat()
                candidate_files.append((scope, p, st.st_mtime, p.stem))
        else:
            for p in sorted(base.glob("*/SKILL.md")):
                st = p.stat()
                candidate_files.append((scope, p, st.st_mtime, p.parent.name))

    vault_file = Path(os.environ.get("REPROMPT_SKILL_VAULT_DIR") or (hm / ".gemini" / "skill-vault")).expanduser() / "index.json"
    vault_mtime = vault_file.stat().st_mtime if vault_file.is_file() else 0.0
    fingerprint_src = "|".join(f"{sc}:{p}:{mt:.3f}" for sc, p, mt, _ in candidate_files) + f"|vault:{vault_mtime:.3f}"
    root_fp = hashlib.sha256(fingerprint_src.encode("utf-8")).hexdigest()

    if not force_reload:
        cached = read_json_safe(manifest_file, None)
        if isinstance(cached, dict) and cached.get("fingerprint") == root_fp and isinstance(cached.get("skills"), list):
            return {
                "fingerprint": root_fp,
                "skills": cached["skills"],
                "cache_hit": True,
                "elapsed_ms": round((time.monotonic() - t0) * 1000, 2),
                "manifest_file": str(manifest_file),
            }

    by_name: dict[str, dict[str, Any]] = {}

    def register(entry: dict[str, Any]) -> None:
        key = entry["name"].lower()
        cur = by_name.get(key)
        if cur is None or entry["priority"] < cur["priority"]:
            by_name[key] = entry

    for scope, md_path, mtime, fallback_name in candidate_files:
        raw = md_path.read_text(encoding="utf-8", errors="replace")
        sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        name, desc, tags, body = _parse_frontmatter(raw, fallback_name)
        aux = _discover_aux_files(md_path.parent, body)
        kw = sorted(_tokenize(f"{name} {desc} {' '.join(tags)}"))[:80]
        register({
            "name": name,
            "scope": scope,
            "priority": SCOPE_PRIORITY.get(scope, 9),
            "description": desc,
            "keywords": kw,
            "tags": tags,
            "path": str(md_path),
            "sha256": sha,
            "mtime": mtime,
            "aux": aux,
            "has_scripts": bool(aux["scripts"]),
            "has_references": bool(aux["references"] or aux["templates"]),
        })

    vault_entries = _load_vault_skills(vault_file)
    if vault_entries is None:
        # Fallback only: the vault could not be read, so keep the vault skills of the last good manifest.
        cached = read_json_safe(manifest_file, None)
        cached_skills = cached.get("skills") if isinstance(cached, dict) else None
        for sk in cached_skills if isinstance(cached_skills, list) else []:
            if isinstance(sk, dict) and sk.get("name") and sk.get("scope") == "skill_vault":
                register(dict(sk))
    else:
        for sk in vault_entries[:500]:
            if not isinstance(sk, dict) or not sk.get("name"):
                continue
            v_path = Path(str(sk.get("path") or ""))
            if not v_path.is_file():
                continue
            name = str(sk["name"])
            desc = str(sk.get("description") or "")[:240]
            register({
                "name": name,
                "id": str(sk.get("id") or ""),
                "scope": "skill_vault",
                "priority": SCOPE_PRIORITY["skill_vault"],
                "description": desc,
                "keywords": sorted(_tokenize(f"{name} {sk.get('domain', '')} {desc}"))[:40],
                "tags": [str(sk.get("domain") or "general")],
                "path": str(v_path),
                "sha256": hashlib.sha256(str(v_path).encode("utf-8")).hexdigest(),
                "mtime": vault_mtime,
                "aux": None,
                "has_scripts": bool(sk.get("has_scripts")),
                "has_references": bool(sk.get("has_references")),
            })

    skills = sorted(by_name.values(), key=lambda s: (s["priority"], s["name"].lower()))
    out = {
        "fingerprint": root_fp,
        "skill_count": len(skills),
        "skills": skills,
    }
    atomic_write_json(manifest_file, out)
    return {
        **out,
        "cache_hit": False,
        "elapsed_ms": round((time.monotonic() - t0) * 1000, 2),
        "manifest_file": str(manifest_file),
    }


def _load_router_module() -> Any:
    """reprompt/scripts/skill_router.py, the one matching path (P2-272 Phase 2 B), loaded by file path."""
    import importlib.util
    import sys

    mod = sys.modules.get("skill_router")
    if mod is not None and hasattr(mod, "select_manifest_skills") and hasattr(mod, "parse_skill_pins"):
        return mod
    _load_vault_module()
    path = _VAULT_SCRIPTS_DIR / "skill_router.py"
    spec = importlib.util.spec_from_file_location("skill_router", str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["skill_router"] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop("skill_router", None)
        raise
    return mod


def extract_skill_overrides(prompt: str) -> tuple[list[str], list[str]]:
    """Pins and exclusions, lower-cased; the grammar lives in the Re-Prompt router (parse_skill_pins)."""
    pins, suppressed, _clean = _load_router_module().parse_skill_pins(prompt or "")
    return (
        list(dict.fromkeys(m.strip().lower() for m in pins if m.strip())),
        list(dict.fromkeys(m.strip().lower() for m in suppressed if m.strip())),
    )


def _norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def _manifest_rank(sk: dict[str, Any]) -> tuple:
    name = str(sk.get("name") or "").lower()
    return (int(sk.get("priority", 9) or 9), len(name), name)


def resolve_skill_token(token: str, skills: list[dict[str, Any]]) -> str | None:
    """Lower-cased name of the one skill a pin names: exact name/id, then normalised name, then substring."""
    best = _load_router_module().resolve_skill_token(token, skills, _manifest_rank)
    return str(best.get("name") or "").lower() if best else None


def select_all_matching_skills(
    prompt: str,
    manifest: dict[str, Any],
    *,
    agent_role: str = "main",
    gemini_selected: list[str] | None = None,
    min_score: float = 2.0,
    ranking_boosts: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """Tier-1 unrestricted multi-skill selection; matching runs in the Re-Prompt router (one path)."""
    if (agent_role or "").lower() == "quarantine":
        return []
    return _load_router_module().select_manifest_skills(
        prompt,
        list(manifest.get("skills") or []),
        _tokenize(prompt),
        agent_role=agent_role,
        gemini_selected=gemini_selected,
        min_score=min_score,
        ranking_boosts=ranking_boosts,
        rank_key=_manifest_rank,
    )


def load_composed_skill_bundle(
    selected_skills: list[dict[str, Any]],
    *,
    max_ref_bytes: int = 3200,
) -> list[dict[str, Any]]:
    """Tier-2 loader: read full SKILL.md + sibling references/templates & expose helper script paths."""
    bundle: list[dict[str, Any]] = []
    for sk in selected_skills:
        p = Path(str(sk.get("path") or ""))
        body = ""
        if p.is_file():
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
                _, _, _, body = _parse_frontmatter(raw, sk["name"])
            except OSError:
                body = ""

        aux = sk.get("aux") or _discover_aux_files(p.parent, body)
        ref_snippets: list[dict[str, str]] = []
        for r_path_str in (list(aux.get("references") or []) + list(aux.get("templates") or []))[:4]:
            rp = Path(r_path_str)
            if rp.is_file():
                try:
                    snippet = rp.read_text(encoding="utf-8", errors="replace")[:max_ref_bytes].strip()
                    ref_snippets.append({"file": rp.name, "path": str(rp), "excerpt": snippet})
                except OSError:
                    pass

        bundle.append({
            "name": sk["name"],
            "scope": sk.get("scope", "watchkeeper_core"),
            "priority": sk.get("priority", 2),
            "path": str(p),
            "description": sk.get("description", ""),
            "instructions": body.strip(),
            "scripts": list(aux.get("scripts") or []),
            "references": ref_snippets,
        })
    return bundle
