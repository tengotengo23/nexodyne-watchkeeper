#!/usr/bin/env python3
"""Zero-dependency CLI & module for managing and searching the Profession Skill Vault."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proc_group import run_cli_isolated  # noqa: E402

VAULT_DIR = Path(os.environ.get("REPROMPT_SKILL_VAULT_DIR") or (Path.home() / ".gemini" / "skill-vault")).expanduser()
SOURCES_FILE = VAULT_DIR / "sources.json"
BUNDLED_SOURCES_FILE = Path(__file__).resolve().parent / "sources.json"
REPOS_DIR = VAULT_DIR / "repos"
INDEX_FILE = VAULT_DIR / "index.json"

# Index entries with this slug are the owner's own installed skills. No source may use it (P2-272 B-fix).
LOCAL_SLUG = "local-installed"
RESERVED_SLUG_MESSAGE = (
    "The source name 'local-installed' is reserved for skills installed on this computer; "
    "that source is ignored. Give it another slug in sources.json."
)
# The curated bundled sources as of 23 Nov 2026. A bundled entry not on this list joins as staged,
# so a future bundled addition still needs the owner's OK (P2-272 B-fix, nit 1).
CURATED_BUNDLED_SLUGS = frozenset({
    "addyosmani-agent-skills", "aipoch-medical-research", "alirezarezvani-claude-skills",
    "anthropics-financial-services", "anthropics-knowledge-work", "anthropics-life-sciences",
    "anthropics-skills", "awesome-finance-skills", "awesome-legal-skills", "blader-humanizer",
    "cloudflare-skills", "composio-awesome-claude-skills", "cybersecurity-skills", "diagram-design",
    "education-agent-skills", "emilkowalski-skills", "expo-skills", "getsentry-skills",
    "google-gemini-skills", "google-skills", "google-stitch-skills", "huggingface-skills", "impeccable",
    "jakubkrehel-skills", "k-dense-scientific", "marketingskills", "mattpocock-skills", "obra-superpowers",
    "obsidian-skills", "planning-with-files", "pm-skills-deanpeters", "remotion-skills", "semgrep-skills",
    "softaworks-toolkit", "supabase-agent-skills", "trailofbits-skills", "ui-ux-pro-max",
    "vercel-agent-skills", "wshobson-agents",
})
# Skill sources are cloned over https from these hosts only (P2-272 B-fix, should-fix 7).
CLONE_URL_RE = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+(\.git)?$")


def _watchkeeper_home() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser()


def _kill_switch_active() -> bool:
    return (_watchkeeper_home() / "KILL").exists()


def _sync_status_file() -> Path:
    return _watchkeeper_home() / "skill-sync.json"


def _vault_dir() -> Path:
    env = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
    return Path(env).expanduser() if env else VAULT_DIR


def _sources_file() -> Path:
    env = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
    return Path(env).expanduser() / "sources.json" if env else SOURCES_FILE


def _repos_dir() -> Path:
    env = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
    return Path(env).expanduser() / "repos" if env else REPOS_DIR


def _index_file() -> Path:
    env = os.environ.get("REPROMPT_SKILL_VAULT_DIR")
    return Path(env).expanduser() / "index.json" if env else INDEX_FILE

CANONICAL_DOMAINS = (
    "finance",
    "legal",
    "medicine-science",
    "marketing",
    "product",
    "sales-support",
    "hr-recruiting",
    "design-ux",
    "education",
    "writing-comms",
    "office-productivity",
    "data-ai",
    "security",
    "engineering-devops",
    "business-ops",
)

SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "tests",
    "test",
    "fixtures",
    "test-fixtures",
    "__tests__",
}

HIDDEN_MIRROR_DIRS = {
    ".agent",
    ".cursor",
    ".codex",
    ".github",
    ".opencode",
    ".windsurf",
    ".roo",
    ".cline",
    ".kiro",
    ".trae",
    ".gemini",
    ".factory",
    ".continue",
}

PATH_DOMAIN_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("legal", ("legal", "compliance", "gdpr", "privacy", "ai-act", "contract", "regulatory", "law")),
    ("finance", ("finance", "financial", "accounting", "investment-banking", "equity-research", "private-equity", "wealth-management", "tax", "treasury", "valuation")),
    ("medicine-science", ("clinical", "medical", "medsci", "biotech", "bioinformatics", "genomics", "pharma", "life-sciences", "scientific", "healthcare", "chemistry", "biology", "neuroscience", "pubmed", "astronomy", "physics", "materials")),
    ("marketing", ("marketing", "seo", "cro", "copywriting", "growth", "brand", "campaign", "ads", "social-media", "content-marketing", "gtm", "product-marketing")),
    ("product", ("product-management", "product-manager", "product-ops", "product", "roadmap", "discovery", "prioritization", "prd", "sprint")),
    ("sales-support", ("sales", "customer-support", "support", "crm", "outreach", "battlecard", "prospecting", "helpdesk")),
    ("hr-recruiting", ("hr", "human-resources", "recruiting", "recruiter", "talent", "hiring", "onboarding", "people-ops", "interview")),
    ("design-ux", ("design", "ui-ux", "ui", "ux", "typography", "accessibility", "a11y", "wcag", "animation", "diagram", "figma", "css", "impeccable", "brand-guidelines", "canvas-design", "theme-factory")),
    ("education", ("education", "teaching", "teacher", "pedagogy", "curriculum", "lesson", "assessment", "instructional", "learning", "teach")),
    ("writing-comms", ("writing", "humanizer", "prose", "editorial", "story", "comms", "communication", "doc-coauthoring", "technical-writing")),
    ("office-productivity", ("docx", "xlsx", "pptx", "pdf", "obsidian", "productivity", "planning-with-files", "spreadsheet", "office", "calendar", "notes")),
    ("data-ai", ("data", "analytics", "sql", "postgres", "supabase", "huggingface", "machine-learning", "ml", "llm", "ai-engineering", "bigquery", "etl", "rag")),
    ("security", ("security", "cybersecurity", "appsec", "threat", "audit", "vulnerability", "stride", "owasp", "pentest", "red-team", "mitre", "cryptography", "sentry", "trailofbits")),
    ("business-ops", ("small-business", "c-level", "executive", "operations", "ops", "strategy", "management", "consulting", "project-management", "business")),
    ("engineering-devops", ("engineering", "devops", "sre", "kubernetes", "terraform", "docker", "ci-cd", "cloud", "testing", "tdd", "debugging", "backend", "frontend", "react", "nextjs", "architecture", "refactoring", "code-review", "git")),
]

KEYWORD_DOMAIN_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("legal", ("contract", "nda", "gdpr", "ccpa", "hipaa", "eu ai act", "compliance", "litigation", "counsel", "statute", "clause", "redline", "due diligence", "governance", "liability", "patent", "trademark", "bylaw")),
    ("finance", ("dcf", "lbo", "3-statement", "ebitda", "valuation", "equity research", "investment banking", "private equity", "portfolio", "reconciliation", "journal entry", "month-end close", "sox", "cash flow", "balance sheet", "income statement", "stock", "earnings", "merger", "financial model", "wacc", "sensitivity")),
    ("medicine-science", ("pubmed", "clinical trial", "patient", "diagnosis", "ehr", "dicom", "genomics", "rna-seq", "protein", "molecule", "drug discovery", "admet", "prisma", "strobe", "stard", "biomedical", "pharmacology", "pathology", "epidemiology", "scientific", "laboratory", "arxiv")),
    ("marketing", ("seo", "cro", "conversion rate", "landing page", "copywriting", "ad copy", "email sequence", "funnel", "go-to-market", "gtm", "brand voice", "campaign", "paid ads", "keyword research", "organic traffic", "positioning")),
    ("product", ("prd", "product requirements", "roadmap", "user research", "rice", "jtbd", "north star", "product strategy", "backlog", "feature spec", "okr", "product-market fit", "persona", "discovery sprint")),
    ("sales-support", ("sales", "prospecting", "cold email", "battlecard", "pipeline", "deal review", "objection handling", "discovery call", "customer support", "ticket triage", "escalation", "helpdesk", "churn")),
    ("hr-recruiting", ("recruiting", "job description", "resume screening", "candidate", "interview rubric", "offer letter", "compensation", "salary benchmark", "onboarding", "performance review", "talent acquisition")),
    ("design-ux", ("ui/ux", "ui design", "ux design", "typography", "color palette", "wcag", "accessibility", "layout", "wireframe", "design system", "svg diagram", "flowchart", "mermaid", "animation", "micro-interaction", "aesthetic", "visual design")),
    ("education", ("lesson plan", "curriculum", "pedagogy", "rubric", "syllabus", "quiz", "formative assessment", "bloom", "student", "classroom", "tutoring", "instructional design", "scaffolding")),
    ("writing-comms", ("humanize", "ai writing", "copyedit", "proofread", "storytelling", "narrative", "blog post", "newsletter", "press release", "tone of voice", "co-authoring")),
    ("office-productivity", ("docx", "xlsx", "pptx", "pdf", "powerpoint", "excel", "word document", "spreadsheet", "slide deck", "obsidian", "markdown", "note-taking", "task management")),
    ("data-ai", ("sql", "postgres", "postgresql", "supabase", "bigquery", "data warehouse", "data analysis", "visualization", "pandas", "huggingface", "fine-tuning", "dataset", "embeddings", "vector", "machine learning", "model training")),
    ("security", ("threat model", "stride", "owasp", "cve", "vulnerability", "static analysis", "semgrep", "codeql", "fuzzing", "penetration", "mitre att&ck", "nist", "zero trust", "secrets", "xss", "sql injection", "smart contract audit", "security")),
    ("business-ops", ("ceo", "cfo", "cto", "coo", "board deck", "sop", "vendor", "procurement", "okr", "kpi", "quarterly review", "small business", "risk register", "change management")),
    ("engineering-devops", ("tdd", "test-driven", "debugging", "code review", "refactor", "react", "next.js", "typescript", "python", "kubernetes", "terraform", "docker", "ci/cd", "github actions", "observability", "opentelemetry", "incident response", "microservices")),
]

SYNONYM_MAP: dict[str, tuple[str, ...]] = {
    "dcf": ("valuation", "financial", "modeling"),
    "valuation": ("dcf", "comps", "lbo", "financial"),
    "financial": ("finance", "accounting", "modeling"),
    "accounting": ("reconciliation", "journal", "close", "finance"),
    "nda": ("contract", "agreement", "legal"),
    "contract": ("agreement", "redline", "clause", "legal"),
    "gdpr": ("privacy", "compliance", "data protection", "legal"),
    "pubmed": ("literature", "medical", "biomedical", "citation"),
    "clinical": ("trial", "medical", "protocol", "patient"),
    "bioinformatics": ("genomics", "rna", "sequence", "scientific"),
    "seo": ("search", "organic", "marketing", "audit"),
    "cro": ("conversion", "landing", "optimization", "funnel"),
    "prd": ("requirements", "spec", "product"),
    "roadmap": ("strategy", "prioritization", "product"),
    "battlecard": ("competitive", "sales", "positioning"),
    "ui": ("interface", "frontend", "design", "ux"),
    "ux": ("usability", "design", "user", "accessibility"),
    "a11y": ("accessibility", "wcag", "screen-reader"),
    "svg": ("diagram", "chart", "visual"),
    "diagram": ("architecture", "flowchart", "visual", "svg"),
    "curriculum": ("lesson", "syllabus", "pedagogy", "education"),
    "lesson": ("teaching", "curriculum", "education"),
    "humanize": ("ai", "writing", "prose", "humanizer"),
    "excel": ("xlsx", "spreadsheet", "financial"),
    "spreadsheet": ("xlsx", "excel", "csv"),
    "word": ("docx", "document"),
    "powerpoint": ("pptx", "slides", "presentation", "deck"),
    "pdf": ("document", "extract", "form"),
    "postgres": ("postgresql", "sql", "supabase", "database"),
    "k8s": ("kubernetes", "helm", "container"),
    "kubernetes": ("k8s", "helm", "cluster"),
    "owasp": ("security", "vulnerability", "appsec"),
    "stride": ("threat", "security", "modeling"),
    "tdd": ("test", "testing", "unit"),
    "hr": ("recruiting", "hiring", "talent", "interview"),
}


# P2-273 (owner, 24 Nov: "<= 20 approved high-signal skills"): at most MAX_SKILLS skills reach the router (load_index)
# and the IDEs (bin/skill-expose.mjs). Rank: the owner's own skills (0), skills from approved sources (1), skills synced
# from the owner's Claude account (2); index order within a rank. panel/src/skill-gate.js capSkills() is the JS twin
# (shared cap_cases in test/fixtures/skill-gate-vectors.json).
MAX_SKILLS = 20
SYNCED_PATH_RE = re.compile(r"[\\/]\.claude[\\/]skills[\\/]synced[\\/]")
OPEN_LICENCE_RE = re.compile(r"^\s*(?:Apache License\s+Version 2\.0\b|(?:The\s+)?MIT License\b)", re.IGNORECASE)


def _skill_folder(skill: Any) -> str:
    """The folder that holds a skill's SKILL.md, as written in the index."""
    if not isinstance(skill, dict):
        return ""
    if skill.get("dir"):
        return str(skill.get("dir"))
    p = str(skill.get("path") or "")
    return str(Path(p).expanduser().parent) if p else ""


def _real_folder(skill: Any) -> str:
    """The skill folder with links resolved (P2-273 review: a link must not hide a synced skill)."""
    folder = _skill_folder(skill)
    try:
        return os.path.realpath(os.path.expanduser(folder)) if folder else ""
    except (OSError, ValueError):
        return ""


def is_synced_skill(skill: Any) -> bool:
    if not isinstance(skill, dict):
        return False
    if skill.get("synced") is True or SYNCED_PATH_RE.search(str(skill.get("path") or skill.get("dir") or "")):
        return True
    real = _real_folder(skill)
    if not real:
        return False
    if SYNCED_PATH_RE.search(real + os.sep):
        return True
    try:
        syn = os.path.realpath(str(Path.home() / ".claude" / "skills" / "synced"))
    except (OSError, ValueError):
        return False
    return real == syn or real.startswith(syn + os.sep)


def skill_rank(skill: Any) -> int:
    if is_synced_skill(skill):
        return 2
    return 0 if isinstance(skill, dict) and skill.get("slug") == LOCAL_SLUG else 1


def cap_skills(skills: Any, max_skills: int = MAX_SKILLS) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(kept, over): the highest-signal max_skills skills first, the rest left out."""
    items = [k for k in (skills if isinstance(skills, list) else []) if isinstance(k, dict)]
    ranked = sorted(enumerate(items), key=lambda pair: (skill_rank(pair[1]), pair[0]))
    return [k for _, k in ranked[:max_skills]], [k for _, k in ranked[max_skills:]]


def synced_licence(skill: Any) -> str:
    """'open' (Apache 2.0 or MIT), 'restricted' or 'none' for the licence file next to a skill's SKILL.md
    (the same test as licenceOf in bin/skill-expose.mjs)."""
    folder = Path(_real_folder(skill) or _skill_folder(skill) or ".")
    for name in ("LICENSE.txt", "LICENSE", "LICENSE.md"):
        try:
            head = (folder / name).read_text(encoding="utf-8", errors="replace")[:300]
        except OSError:
            continue
        return "open" if OPEN_LICENCE_RE.match(head) else "restricted"
    return "none"


CLAUDE_TARGETS = ("claude", "claude_code", "claude-code")


def skill_allowed_for(skill: Any, target: Any) -> bool:
    """One licence rule for every path (search, pins, kept session skills): a skill synced from the owner's Claude
    account reaches any target other than Claude only under an open licence. Unknown targets ("auto", "general",
    empty) count as not Claude, so the rule fails closed."""
    if not is_synced_skill(skill):
        return True
    if str(target or "").strip().lower() in CLAUDE_TARGETS:
        return True
    return synced_licence(skill) == "open"


def _exposure_state() -> dict[str, list[str]]:
    """<WK_HOME>/skills-exposed.json, the owner's choices from `wk-skill-sync expose/unexpose` (bin/skill-expose.mjs
    loadState). A missing or broken file means no extras and nothing hidden."""
    try:
        raw = json.loads((_watchkeeper_home() / "skills-exposed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}

    def ids(key: str) -> list[str]:
        v = raw.get(key)
        return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []

    return {"extra": ids("extra"), "hidden": ids("hidden")}


def router_set(skills: Any, allowed_slugs: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """(kept, over, withheld ids) for the router, at most MAX_SKILLS in all (P2-273 review).

    First the IDE exposure, the same set as bin/skill-expose.mjs exposure(): the owner's own skills minus hidden ones,
    plus skills exposed by id, capped. Then other skills from approved sources fill the free places. So the skills
    linked into the IDEs are always routable and the router never holds more than MAX_SKILLS. A hidden skill is
    never routed; a synced skill without an open licence is withheld from both (Claude Code loads synced skills
    natively)."""
    items = [k for k in (skills if isinstance(skills, list) else []) if isinstance(k, dict) and k.get("slug") in allowed_slugs]
    st = _exposure_state()
    hidden = set(st["hidden"])
    by_id = {k.get("id"): k for k in items if k.get("id")}
    chosen: list[dict[str, Any]] = []
    withheld: list[str] = []
    seen: set[Any] = set()

    def add(k: Any) -> None:
        if not isinstance(k, dict):
            return
        kid = k.get("id")
        if kid in seen or kid in hidden:
            return
        seen.add(kid)
        if is_synced_skill(k) and synced_licence(k) != "open":
            withheld.append(str(kid or k.get("name") or ""))
            return
        chosen.append(k)

    for k in items:
        if k.get("slug") == LOCAL_SLUG:
            add(k)
    for kid in st["extra"]:
        add(by_id.get(kid))
    exposed, over = cap_skills(chosen)
    n_exposed = len(chosen)
    for k in items:
        add(k)
    fill, over_fill = cap_skills(chosen[n_exposed:], MAX_SKILLS - len(exposed))
    return exposed + fill, over + over_fill, withheld


def is_approved(entry: Any) -> bool:
    """Only a source with approved == True may be indexed, cloned or loaded. The reserved slug never is."""
    return isinstance(entry, dict) and entry.get("approved") is True and not _is_reserved_source(entry)


def _is_reserved_source(entry: Any) -> bool:
    return isinstance(entry, dict) and str(entry.get("slug") or "").strip().lower() == LOCAL_SLUG


def _safe_skill_file(fpath: Path, root_real: str) -> bool:
    """A SKILL.md counts only if it is a plain file (not a link) whose real path stays inside its root."""
    try:
        if fpath.is_symlink() or not fpath.is_file():
            return False
        real = os.path.realpath(fpath)
    except OSError:
        return False
    return real == root_real or real.startswith(root_real.rstrip(os.sep) + os.sep)


def _migrate_approval(data: dict[str, Any]) -> bool:
    """Legacy manifests carry no approval flags: curated entries become approved, auto-discovered ones staged."""
    repos = [r for r in data.get("repos", []) if isinstance(r, dict)]
    if not repos or any("approved" in r for r in repos):
        return False
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for r in repos:
        if r.get("discovered_trending"):
            r.update({"approved": False, "status": "staged", "staged_at": now})
        else:
            r.update({"approved": True, "status": "approved"})
    return True


def load_sources(include_unapproved: bool = False) -> list[dict[str, Any]]:
    src_path = _sources_file()
    v_dir = _vault_dir()
    bundled_data = (
        json.loads(BUNDLED_SOURCES_FILE.read_text(encoding="utf-8"))
        if BUNDLED_SOURCES_FILE.exists()
        else None
    )

    if not src_path.exists():
        if bundled_data is not None:
            try:
                v_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(BUNDLED_SOURCES_FILE, src_path)
            except OSError:
                src_path = BUNDLED_SOURCES_FILE
        else:
            print(f"Error: missing sources manifest at {src_path}", file=sys.stderr)
            sys.exit(1)

    data = json.loads(src_path.read_text(encoding="utf-8"))
    migrated = _migrate_approval(data) if src_path != BUNDLED_SOURCES_FILE else False
    if migrated:
        try:
            _write_json_atomic(src_path, data)
        except OSError:
            pass
    if bundled_data is not None and src_path != BUNDLED_SOURCES_FILE:
        existing_repos = data.get("repos", [])
        bundled_repos = bundled_data.get("repos", [])
        by_slug = {r["slug"]: r for r in existing_repos if isinstance(r, dict) and r.get("slug")}
        bundled_by_slug = {r["slug"]: r for r in bundled_repos if isinstance(r, dict) and r.get("slug")}
        changed = int(bundled_data.get("version", 1)) > int(data.get("version", 1))

        for slug, b_entry in bundled_by_slug.items():
            if slug not in by_slug:
                if slug not in CURATED_BUNDLED_SLUGS:
                    b_entry = {**b_entry, "approved": False, "status": "staged",
                               "staged_at": dt.datetime.now(dt.timezone.utc).isoformat()}
                existing_repos.append(b_entry)
                changed = True
            elif "ecosystem_focus" in b_entry and not by_slug[slug].get("ecosystem_focus"):
                by_slug[slug]["ecosystem_focus"] = b_entry["ecosystem_focus"]
                changed = True

        if changed:
            data["version"] = max(int(data.get("version", 1)), int(bundled_data.get("version", 1)))
            data["repos"] = existing_repos
            try:
                v_dir.mkdir(parents=True, exist_ok=True)
                _write_json_atomic(src_path, data)
            except OSError:
                pass

    repos = data.get("repos", [])
    if any(_is_reserved_source(r) for r in repos):
        print(RESERVED_SLUG_MESSAGE, file=sys.stderr)
        repos = [r for r in repos if not _is_reserved_source(r)]
    if not include_unapproved:
        repos = [r for r in repos if is_approved(r)]
    repos.sort(key=lambda r: (int(r.get("tier", 3)), -int(r.get("stars", 0)), r["slug"]))
    return repos


# https only, for clone and pull (file://, ext::, ssh and git:// are refused by git itself).
CLONE_PROTOCOL_ARGS = ("-c", "protocol.allow=never", "-c", "protocol.https.allow=always")


def run_git(args: list[str], cwd: Path | None = None, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    hardened = [
        "git",
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "submodule.recurse=false",
        *args,
    ]
    return run_cli_isolated(
        hardened,
        timeout=timeout,
        cwd=str(cwd) if cwd else None,
        env=env,
        label="skill_vault git " + (args[0] if args else ""),
        kind="skill-vault",
        sweep_group=True,
    )


def has_skill_files(repo_dir: Path) -> bool:
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            if fname.lower() == "skill.md":
                return True
    return False


def clone_url_allowed(url: Any) -> bool:
    """Only https://github.com/<owner>/<repo>[.git]; no other scheme, host or leading '-'."""
    return isinstance(url, str) and not url.startswith("-") and bool(CLONE_URL_RE.match(url))


STOPPED_MSG = "stopped: the Stop switch is on"


def clone_one(entry: dict[str, Any]) -> tuple[str, str, str]:
    slug = entry["slug"]
    url = entry.get("url")
    dest = _repos_dir() / slug
    sparse_paths: list[str] = entry.get("sparse_paths") or []

    if dest.exists() and (dest / ".git").is_dir():
        return (slug, "exists", "already cloned")
    if not clone_url_allowed(url):
        return (slug, "error", "refused: only https://github.com/<owner>/<repo> sources can be cloned")
    if any(not isinstance(p, str) or p.startswith("-") for p in sparse_paths):
        return (slug, "error", "refused: a sparse path starts with '-'")

    for attempt in range(2):
        if _kill_switch_active():
            return (slug, "stopped", STOPPED_MSG)
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        try:
            if sparse_paths:
                res = run_git(
                    [*CLONE_PROTOCOL_ARGS, "clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:none", "--sparse",
                     "--", url, str(dest)],
                    timeout=180,
                )
                if res.returncode != 0:
                    raise RuntimeError(res.stderr.strip() or res.stdout.strip() or "git clone failed")
                if _kill_switch_active():
                    return (slug, "stopped", STOPPED_MSG)
                sp_res = run_git(["-C", str(dest), "sparse-checkout", "set", "--no-cone", *sparse_paths], timeout=120)
                if sp_res.returncode != 0:
                    if _kill_switch_active():
                        return (slug, "stopped", STOPPED_MSG)
                    sp_res = run_git(["-C", str(dest), "sparse-checkout", "set", *sparse_paths], timeout=120)
                if sp_res.returncode != 0 or not has_skill_files(dest):
                    if _kill_switch_active():
                        return (slug, "stopped", STOPPED_MSG)
                    run_git(["-C", str(dest), "sparse-checkout", "disable"], timeout=180)
                return (slug, "cloned", "sparse ok" if has_skill_files(dest) else "cloned (no SKILL.md)")
            else:
                res = run_git(
                    [*CLONE_PROTOCOL_ARGS, "clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, str(dest)],
                    timeout=180,
                )
                if res.returncode != 0:
                    raise RuntimeError(res.stderr.strip() or res.stdout.strip() or "git clone failed")
                return (slug, "cloned", "ok")
        except Exception as exc:
            last_err = str(exc)
            if attempt == 0:
                continue
            shutil.rmtree(dest, ignore_errors=True)
            return (slug, "error", last_err[:200])
    return (slug, "error", "unknown error")


def update_one(entry: dict[str, Any]) -> tuple[str, str, str]:
    slug = entry["slug"]
    dest = _repos_dir() / slug
    if not (dest.exists() and (dest / ".git").is_dir()):
        return clone_one(entry)
    if _kill_switch_active():
        return (slug, "stopped", STOPPED_MSG)
    try:
        res = run_git(["-C", str(dest), *CLONE_PROTOCOL_ARGS, "pull", "--ff-only"], timeout=120)
        if res.returncode != 0:
            return (slug, "warn", (res.stderr or res.stdout).strip()[:160])
        msg = (res.stdout or "updated").strip().splitlines()[-1] if res.stdout.strip() else "updated"
        return (slug, "updated", msg[:120])
    except Exception as exc:
        return (slug, "error", str(exc)[:160])


def strip_quotes(val: str) -> str:
    val = val.strip()
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        return val[1:-1].replace('\\"', '"').strip()
    if len(val) >= 2 and val[0] == "'" and val[-1] == "'":
        return val[1:-1].replace("''", "'").strip()
    if val.startswith(("'", '"')) and len(val) > 1:
        return val[1:].strip()
    return val


def _is_quote_closed(text: str, quote: str) -> bool:
    if not text.startswith(quote):
        return True
    i = 1
    n = len(text)
    while i < n:
        ch = text[i]
        if quote == "'" and ch == "'":
            if i + 1 < n and text[i + 1] == "'":
                i += 2
                continue
            return text[i + 1 :].strip() == ""
        if quote == '"' and ch == "\\":
            i += 2
            continue
        if quote == '"' and ch == '"':
            return text[i + 1 :].strip() == ""
        i += 1
    return False


def clean_whitespace(text: str, max_len: int = 240) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_len:
        return text
    cut = text[: max_len - 1].rsplit(" ", 1)[0].rstrip(",.;:-")
    return (cut or text[: max_len - 1]) + "…"


def parse_skill_file(path: Path) -> tuple[str, str, str]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()
    meta: dict[str, str] = {}
    body_start = 0

    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, min(len(lines), 120)):
            if lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is not None:
            body_start = end_idx + 1
            fm_lines = lines[1:end_idx]
            idx = 0
            while idx < len(fm_lines):
                line = fm_lines[idx]
                m = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
                if not m:
                    idx += 1
                    continue
                key = m.group(1).strip().lower()
                val = m.group(2).strip()
                if val in (">", ">-", "|", "|-", ">+", "|+"):
                    block: list[str] = []
                    idx += 1
                    while idx < len(fm_lines):
                        nxt = fm_lines[idx]
                        if re.match(r"^[A-Za-z0-9_-]+\s*:", nxt) and not nxt.startswith((" ", "\t")):
                            break
                        if nxt.startswith((" ", "\t")) or nxt.strip() == "":
                            block.append(nxt.strip())
                            idx += 1
                        else:
                            break
                    meta[key] = " ".join(part for part in block if part)
                    continue
                if val == "":
                    block = []
                    idx += 1
                    while idx < len(fm_lines):
                        nxt = fm_lines[idx]
                        if re.match(r"^[A-Za-z0-9_-]+\s*:", nxt) and not nxt.startswith((" ", "\t")):
                            break
                        if nxt.startswith((" ", "\t")):
                            stripped = nxt.strip()
                            if not stripped.startswith("- "):
                                block.append(stripped)
                            idx += 1
                        else:
                            break
                    if block:
                        meta[key] = " ".join(block)
                    continue
                if val.startswith(("'", '"')) and not _is_quote_closed(val, val[0]):
                    qchar = val[0]
                    parts = [val]
                    idx += 1
                    while idx < len(fm_lines):
                        nxt = fm_lines[idx]
                        if re.match(r"^[A-Za-z0-9_-]+\s*:", nxt) and not nxt.startswith((" ", "\t")):
                            break
                        parts.append(nxt.strip())
                        idx += 1
                        if _is_quote_closed(" ".join(parts), qchar):
                            break
                    meta[key] = strip_quotes(" ".join(p for p in parts if p))
                    continue
                if not val.startswith(("'", '"')):
                    parts = [val]
                    idx += 1
                    while idx < len(fm_lines):
                        nxt = fm_lines[idx]
                        if re.match(r"^[A-Za-z0-9_-]+\s*:", nxt) and not nxt.startswith((" ", "\t")):
                            break
                        if nxt.startswith((" ", "\t")) and not nxt.lstrip().startswith("- "):
                            parts.append(nxt.strip())
                            idx += 1
                        else:
                            break
                    meta[key] = strip_quotes(" ".join(p for p in parts if p))
                    continue
                meta[key] = strip_quotes(val)
                idx += 1

    body = "\n".join(lines[body_start:]).strip()
    name = meta.get("name", "").strip()
    if not name or name.lower() == "skill":
        name = path.parent.name.strip()

    desc = meta.get("description", "").strip()
    if not desc:
        para: list[str] = []
        in_code = False
        for b_line in lines[body_start:]:
            s = b_line.strip()
            if s.startswith("```"):
                in_code = not in_code
                continue
            if in_code:
                continue
            if not s:
                if para:
                    break
                continue
            if s.startswith("#") or s.startswith("<!--"):
                continue
            s = re.sub(r"^[-*+]\s+", "", s)
            s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
            para.append(s)
            if sum(len(x) for x in para) >= 240:
                break
        desc = " ".join(para)

    return name, clean_whitespace(desc, 240), body


def path_preference_score(rel_path: str) -> int:
    parts = Path(rel_path).parts[:-1]
    has_hidden = any(p.startswith(".") for p in parts)
    lower_parts = [p.lower() for p in parts]

    if not has_hidden and ("skills" in lower_parts or (lower_parts and lower_parts[0] == "plugins")):
        return 0
    if not has_hidden:
        return 1
    if len(lower_parts) >= 2 and lower_parts[0] == ".agents" and lower_parts[1] == "skills":
        return 2
    if len(lower_parts) >= 2 and lower_parts[0] == ".claude" and lower_parts[1] == "skills":
        return 3
    if any(p in HIDDEN_MIRROR_DIRS for p in lower_parts) or has_hidden:
        return 4
    return 1


def classify_domain(rel_path: str, name: str, description: str, default_domain: str) -> str:
    path_tokens = set(re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", rel_path.lower()))
    path_str = rel_path.lower()

    for domain, markers in PATH_DOMAIN_RULES:
        for m in markers:
            if m in path_tokens or f"/{m}/" in f"/{path_str}/" or f"/{m}-" in f"/{path_str}":
                return domain

    haystack = f"{name} {description}".lower()
    scores: Counter[str] = Counter()
    for domain, keywords in KEYWORD_DOMAIN_RULES:
        for kw in keywords:
            if " " in kw or "-" in kw:
                if kw in haystack:
                    scores[domain] += 2
            else:
                if re.search(rf"\b{re.escape(kw)}\b", haystack):
                    scores[domain] += 1

    if scores:
        best_domain, best_score = scores.most_common(1)[0]
        if best_score >= 1:
            return best_domain

    return default_domain if default_domain in CANONICAL_DOMAINS else "business-ops"


def _scan_local_skill_dir(root_dir: Path, slug: str, repo_name: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if not root_dir.is_dir():
        return candidates
    root_real = os.path.realpath(root_dir)
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for fname in files:
            if fname.lower() != "skill.md":
                continue
            fpath = Path(root) / fname
            if not _safe_skill_file(fpath, root_real):
                continue
            rel_path = fpath.relative_to(root_dir).as_posix()
            try:
                size_bytes = fpath.stat().st_size
            except OSError:
                continue
            if size_bytes < 40:
                continue
            name, desc, body = parse_skill_file(fpath)
            if not name:
                continue
            norm_body = re.sub(r"\s+", " ", f"{name.lower()} {body}").strip()
            body_hash = hashlib.sha256(norm_body.encode("utf-8", errors="replace")).hexdigest()
            candidates.append(
                {
                    "name": name,
                    "norm_name": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
                    "description": desc,
                    "rel_path": rel_path,
                    "abs_path": str(fpath),
                    "size_bytes": size_bytes,
                    "body_hash": body_hash,
                    "pref": path_preference_score(rel_path),
                    "skill_dir": fpath.parent,
                    "slug": slug,
                    "repo": repo_name,
                }
            )
    return candidates


def discover_local_skills(extra_dirs: list[Path] | None = None) -> list[dict[str, Any]]:
    """Discover installed local skills across ~/.claude/skills, ~/.gemini/config/skills, and Watchkeeper."""
    scan_roots: list[tuple[Path, str, str]] = []
    home = Path.home()
    scan_roots.append((home / ".claude" / "skills", "local-installed", "local/claude-skills"))
    scan_roots.append((home / ".gemini" / "config" / "skills", "local-installed", "local/gemini-skills"))
    wk_skills = Path(__file__).resolve().parents[2] / "skills"
    if wk_skills.is_dir():
        scan_roots.append((wk_skills, "local-installed", "watchkeeper/skills"))
    if extra_dirs:
        for d in extra_dirs:
            scan_roots.append((Path(d), "local-installed", "local/custom"))

    raw_candidates: list[dict[str, Any]] = []
    for rdir, slug, repo_name in scan_roots:
        raw_candidates.extend(_scan_local_skill_dir(rdir, slug, repo_name))

    raw_candidates.sort(key=lambda c: (c["pref"], len(c["rel_path"]), c["rel_path"]))
    seen_hashes: set[str] = set()
    seen_names: set[str] = set()
    used_ids: set[str] = set()
    skills: list[dict[str, Any]] = []

    for c in raw_candidates:
        if c["body_hash"] in seen_hashes or c["norm_name"] in seen_names:
            continue
        seen_hashes.add(c["body_hash"])
        seen_names.add(c["norm_name"])

        domain = classify_domain(c["rel_path"], c["name"], c["description"], "engineering-devops")
        base_id = f"{c['slug']}/{c['norm_name'] or 'skill'}"
        skill_id = base_id
        suffix = 2
        while skill_id in used_ids:
            skill_id = f"{base_id}-{suffix}"
            suffix += 1
        used_ids.add(skill_id)

        sdir: Path = c["skill_dir"]
        has_scripts = (sdir / "scripts").is_dir() and any((sdir / "scripts").iterdir())
        has_references = any(
            (sdir / sub).is_dir() and any((sdir / sub).iterdir())
            for sub in ("references", "examples", "resources", "assets")
        )
        skills.append(
            {
                "id": skill_id,
                "name": c["name"],
                "repo": c["repo"],
                "slug": c["slug"],
                "ecosystem_focus": "universal",
                "tier": 1,
                "stars": 50000,
                "domain": domain,
                "description": c["description"],
                "path": c["abs_path"],
                "rel_path": c["rel_path"],
                "size_bytes": c["size_bytes"],
                "has_scripts": has_scripts,
                "has_references": has_references,
                "_body_hash": c["body_hash"],
            }
        )
    return skills


def _write_index_atomic(index_data: dict[str, Any]) -> None:
    v_dir = _vault_dir()
    idx_file = _index_file()
    v_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".index-", suffix=".json", dir=str(v_dir))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(index_data, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp_name, idx_file)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _scan_repo_entry(entry: dict[str, Any], seen_global_hashes: set[str], used_ids: set[str]) -> list[dict[str, Any]]:
    """Scan one cloned source for SKILL.md files. Callers pass only approved entries."""
    skills: list[dict[str, Any]] = []
    slug = entry["slug"]
    repo_name = entry["repo"]
    tier = int(entry.get("tier", 3))
    stars = int(entry.get("stars", 0))
    default_domain = entry.get("default_domain", "business-ops")
    ecosystem_focus = entry.get("ecosystem_focus", "universal")
    repo_dir = _repos_dir() / slug

    if not repo_dir.is_dir():
        return []

    candidates: list[dict[str, Any]] = []
    repo_real = os.path.realpath(repo_dir)
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for fname in files:
            if fname.lower() != "skill.md":
                continue
            fpath = Path(root) / fname
            if not _safe_skill_file(fpath, repo_real):
                continue
            rel_path = fpath.relative_to(repo_dir).as_posix()
            try:
                size_bytes = fpath.stat().st_size
            except OSError:
                continue
            if size_bytes < 40:
                continue
            name, desc, body = parse_skill_file(fpath)
            if not name:
                continue
            norm_body = re.sub(r"\s+", " ", f"{name.lower()} {body}").strip()
            body_hash = hashlib.sha256(norm_body.encode("utf-8", errors="replace")).hexdigest()
            pref = path_preference_score(rel_path)
            candidates.append(
                {
                    "name": name,
                    "norm_name": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
                    "description": desc,
                    "rel_path": rel_path,
                    "abs_path": str(fpath),
                    "size_bytes": size_bytes,
                    "body_hash": body_hash,
                    "pref": pref,
                    "skill_dir": fpath.parent,
                }
            )

    candidates.sort(key=lambda c: (c["pref"], len(c["rel_path"]), c["rel_path"]))
    kept_repo: list[dict[str, Any]] = []
    seen_names_repo: set[str] = set()
    seen_hashes_repo: set[str] = set()

    for c in candidates:
        if c["norm_name"] in seen_names_repo or c["body_hash"] in seen_hashes_repo:
            continue
        seen_names_repo.add(c["norm_name"])
        seen_hashes_repo.add(c["body_hash"])
        kept_repo.append(c)

    count_for_repo = 0
    for c in kept_repo:
        if c["body_hash"] in seen_global_hashes:
            continue
        seen_global_hashes.add(c["body_hash"])

        domain = classify_domain(c["rel_path"], c["name"], c["description"], default_domain)
        base_id = f"{slug}/{c['norm_name'] or 'skill'}"
        skill_id = base_id
        suffix = 2
        while skill_id in used_ids:
            skill_id = f"{base_id}-{suffix}"
            suffix += 1
        used_ids.add(skill_id)

        sdir: Path = c["skill_dir"]
        has_scripts = (sdir / "scripts").is_dir() and any((sdir / "scripts").iterdir())
        has_references = any(
            (sdir / sub).is_dir() and any((sdir / sub).iterdir())
            for sub in ("references", "examples", "resources", "assets")
        )

        skills.append(
            {
                "id": skill_id,
                "name": c["name"],
                "repo": repo_name,
                "slug": slug,
                "ecosystem_focus": ecosystem_focus,
                "tier": tier,
                "stars": stars,
                "forks": int(entry.get("forks", 0)),
                "trending": bool(entry.get("trending") or entry.get("discovered_trending")),
                "domain": domain,
                "description": c["description"],
                "path": c["abs_path"],
                "rel_path": c["rel_path"],
                "size_bytes": c["size_bytes"],
                "has_scripts": has_scripts,
                "has_references": has_references,
            }
        )
        count_for_repo += 1

    return skills


def build_index() -> dict[str, Any]:
    sources = load_sources()
    _repos_dir().mkdir(parents=True, exist_ok=True)

    seen_global_hashes: set[str] = set()
    used_ids: set[str] = set()
    skills: list[dict[str, Any]] = []
    repo_counts: dict[str, int] = {}
    domain_counts: Counter[str] = Counter()

    for entry in sources:
        if not is_approved(entry):
            continue
        found = _scan_repo_entry(entry, seen_global_hashes, used_ids)
        for sk in found:
            domain_counts[sk["domain"]] += 1
        skills.extend(found)
        repo_counts[entry["slug"]] = len(found)

    include_local = (not os.environ.get("REPROMPT_SKILL_VAULT_DIR")) or (
        os.environ.get("REPROMPT_INCLUDE_LOCAL_SKILLS") == "1"
    )
    if include_local:
        local_count = 0
        existing_names = {re.sub(r"[^a-z0-9]+", "-", s["name"].lower()).strip("-") for s in skills}
        for loc in discover_local_skills():
            bhash = loc.pop("_body_hash", "")
            nname = re.sub(r"[^a-z0-9]+", "-", loc["name"].lower()).strip("-")
            if (bhash and bhash in seen_global_hashes) or nname in existing_names:
                continue
            if bhash:
                seen_global_hashes.add(bhash)
            existing_names.add(nname)
            sid = loc["id"]
            suffix = 2
            while sid in used_ids:
                sid = f"{loc['id']}-{suffix}"
                suffix += 1
            loc["id"] = sid
            used_ids.add(sid)
            skills.append(loc)
            domain_counts[loc["domain"]] += 1
            local_count += 1
        if local_count:
            repo_counts["local-installed"] = local_count

    repos_dir = _repos_dir()
    cloned_cnt = sum(1 for s in sources if (repos_dir / s["slug"]).is_dir())
    index_data = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repo_count": len(sources),
        "cloned_repo_count": cloned_cnt,
        "skill_count": len(skills),
        "local_bootstrap": cloned_cnt == 0 and bool(skills),
        "domain_counts": dict(sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_counts": repo_counts,
        "skills": skills,
    }

    _write_index_atomic(index_data)
    return index_data


def index_source(slug: str) -> dict[str, Any]:
    """Index one approved source only and merge it into the existing index (P2-272).

    Staged or rejected sources raise ValueError: approval decides, never presence on disk.
    """
    entries = {r.get("slug"): r for r in load_sources(include_unapproved=True) if isinstance(r, dict)}
    entry = entries.get(slug)
    if entry is None:
        lowered = str(slug).lower()
        entry = next((r for r in entries.values() if str(r.get("repo", "")).lower() == lowered), None)
    if entry is None:
        raise ValueError(f"unknown source {slug}")
    if not is_approved(entry):
        raise ValueError(f"source {entry.get('slug')} is not approved")
    slug = entry["slug"]
    idx_file = _index_file()
    try:
        idx = json.loads(idx_file.read_text(encoding="utf-8")) if idx_file.is_file() else {}
    except (OSError, ValueError):
        idx = {}
    if not isinstance(idx, dict):
        idx = {}
    kept = [k for k in (idx.get("skills") or []) if isinstance(k, dict) and k.get("slug") != slug]
    used_ids = {str(k.get("id")) for k in kept if k.get("id")}
    found = _scan_repo_entry(entry, set(), used_ids)
    skills = kept + found
    domain_counts: Counter[str] = Counter(str(k.get("domain") or "business-ops") for k in skills)
    repo_counts = dict(idx.get("repo_counts") or {})
    repo_counts[slug] = len(found)
    approved = load_sources()
    repos_dir = _repos_dir()
    cloned_cnt = sum(1 for s in approved if (repos_dir / s["slug"]).is_dir())
    index_data = {
        **idx,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repo_count": len(approved),
        "cloned_repo_count": cloned_cnt,
        "skill_count": len(skills),
        "local_bootstrap": bool(idx.get("local_bootstrap")) and not found,
        "domain_counts": dict(sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_counts": repo_counts,
        "skills": skills,
    }
    _write_index_atomic(index_data)
    return {"slug": slug, "repo": entry.get("repo"), "indexed": len(found), "skill_count": len(skills),
            "cloned": (repos_dir / slug).is_dir()}


def drop_source(slug: str) -> dict[str, Any]:
    """Remove one source's skills from index.json (after a reject). Files on disk stay."""
    lowered = str(slug).lower()
    entry = next((r for r in load_sources(include_unapproved=True)
                  if isinstance(r, dict) and (str(r.get("slug", "")).lower() == lowered
                                              or str(r.get("repo", "")).lower() == lowered)), None)
    real = entry.get("slug") if entry else slug
    if str(real).lower() == LOCAL_SLUG:
        return {"slug": LOCAL_SLUG, "dropped": 0, "refused": RESERVED_SLUG_MESSAGE}
    idx_file = _index_file()
    try:
        idx = json.loads(idx_file.read_text(encoding="utf-8")) if idx_file.is_file() else {}
    except (OSError, ValueError):
        idx = {}
    if not isinstance(idx, dict) or not idx.get("skills"):
        return {"slug": real, "dropped": 0}
    skills = [k for k in idx["skills"] if isinstance(k, dict) and k.get("slug") != real]
    dropped = len(idx["skills"]) - len(skills)
    if dropped:
        repo_counts = {k: v for k, v in (idx.get("repo_counts") or {}).items() if k != real}
        domain_counts: Counter[str] = Counter(str(k.get("domain") or "business-ops") for k in skills)
        _write_index_atomic({**idx, "skills": skills, "skill_count": len(skills), "repo_counts": repo_counts,
                             "repo_count": len(load_sources()),
                             "domain_counts": dict(sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0])))})
    return {"slug": real, "dropped": dropped}


def cmd_drop_source(args: argparse.Namespace) -> int:
    if _stopped(args):
        return 0
    res = drop_source(args.slug)
    print(json.dumps({"ok": True, **res}) if getattr(args, "json", False) else f"Removed {res['dropped']} skills of {res['slug']} from the index.")
    return 0


CHECK_TEXT_SUFFIXES = {".md", ".txt", ".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".json", ".yaml", ".yml", ".toml"}
CHECK_FILE_CAP = 256 * 1024
CHECK_FILES_MAX = 200
# Key- and token-shaped finds refuse a skill anywhere in its folder.
CHECK_HARD_LABELS = {
    "private_key_block", "private_key_unclosed", "anthropic_key", "openai_key", "stripe_key", "aws_access_key",
    "github_token", "google_api_key", "slack_token", "jwt_token", "uri_credentials", "auth_header", "bearer_token",
    "credit_card", "policy_secret", "ssn",
}
# "NAME_TOKEN = value" style finds refuse only in SKILL.md (the text that reaches every session); in scripts
# and references they match ordinary code such as `token_budget = BUDGET`. Paths, emails and phones never refuse.
CHECK_SOFT_LABELS = {"env_secret_assignment", "env_secret_assignment_quoted", "code_secret_assignment", "yaml_unquoted_secret"}


def _load_sanitizer() -> Any:
    """Import Watchkeeper's core/sanitizer.py by path (no package install needed)."""
    import importlib.util

    path = Path(__file__).resolve().parents[2] / "core" / "sanitizer.py"
    spec = importlib.util.spec_from_file_location("wk_core_sanitizer", str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"sanitizer not found: {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("wk_core_sanitizer", mod)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def check_skill(skill_dir: str | Path) -> dict[str, Any]:
    """Run core/sanitizer.py over a skill folder before it is exposed.

    Fails on any blocked result, any key- or token-shaped find, and (in SKILL.md only) any
    secret-assignment find. Paths, emails and phone numbers are normal in skills and do not fail it.
    """
    root = Path(skill_dir)
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        return {"ok": False, "path": str(root), "reason": "no SKILL.md"}
    san = _load_sanitizer()
    checked = 0
    files = [skill_md] + sorted(
        f for f in root.rglob("*")
        if f.is_file() and not f.is_symlink() and f != skill_md and f.suffix.lower() in CHECK_TEXT_SUFFIXES
        and not any(part in SKIP_DIRS for part in f.relative_to(root).parts)
    )
    for f in files[:CHECK_FILES_MAX]:
        try:
            if f.stat().st_size > CHECK_FILE_CAP:
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        checked += 1
        res = san.sanitize_text(text)
        hard = CHECK_HARD_LABELS | (CHECK_SOFT_LABELS if f == skill_md else set())
        bad = [r for r in res.redactions if r in hard]
        if res.blocked or bad:
            return {"ok": False, "path": str(root), "file": f.relative_to(root).as_posix(),
                    "reason": res.block_reason or ("sanitizer found: " + ", ".join(sorted(set(bad))))}
    return {"ok": True, "path": str(root), "checked": checked}


def cmd_check_skill(args: argparse.Namespace) -> int:
    if _stopped(args):
        return 0
    res = check_skill(args.path)
    print(json.dumps(res) if getattr(args, "json", False) else (("passed: " if res["ok"] else "refused: ") + res.get("reason", res["path"])))
    return 0 if res["ok"] else 1


def pending_sources() -> list[dict[str, Any]]:
    """Sources waiting for the owner's OK: not approved and not rejected."""
    out: list[dict[str, Any]] = []
    repos_dir = _repos_dir()
    for r in load_sources(include_unapproved=True):
        if is_approved(r) or r.get("status") == "rejected":
            continue
        desc = re.sub(r"\s+", " ", str(r.get("description") or "")).strip()
        url = str(r.get("url") or f"https://github.com/{r.get('repo', '')}")
        if url.endswith(".git"):
            url = url[:-4]
        out.append({
            "slug": r.get("slug"),
            "repo": r.get("repo"),
            "name": str(r.get("repo") or r.get("slug") or "").split("/")[-1],
            "stars": int(r.get("stars", 0) or 0),
            "description": desc[:140] + ("..." if len(desc) > 140 else ""),
            "url": url,
            "cloned": (repos_dir / str(r.get("slug"))).is_dir(),
            "path": str(repos_dir / str(r.get("slug"))),
            "staged_at": r.get("staged_at"),
        })
    out.sort(key=lambda x: (-x["stars"], str(x["slug"])))
    return out


def _stopped(args: argparse.Namespace) -> bool:
    if not _kill_switch_active():
        return False
    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "stopped": True, "reason": "stop_switch"}))
    else:
        print("Skill library stopped: the Stop switch (~/.wk/KILL) is on.")
    return True


def cmd_pending(args: argparse.Namespace) -> int:
    if _stopped(args):
        return 0
    items = pending_sources()
    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "count": len(items), "pending": items}, ensure_ascii=False))
        return 0
    print(f"{len(items)} to review")
    for it in items:
        print(f"  {it['slug']}  {it['repo']}  {it['stars']} stars  {it['url']}")
        if it["description"]:
            print(f"      {it['description']}")
    return 0


def cmd_index_source(args: argparse.Namespace) -> int:
    if _stopped(args):
        return 0
    try:
        res = index_source(args.slug)
    except ValueError as exc:
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"Not indexed: {exc}", file=sys.stderr)
        return 1
    if getattr(args, "json", False):
        print(json.dumps({"ok": True, **res}, ensure_ascii=False))
    else:
        print(f"Indexed {res['indexed']} skills from {res['repo']} ({res['skill_count']} in the library).")
    return 0


def load_index() -> dict[str, Any]:
    idx_file = _index_file()
    if not idx_file.exists():
        return build_index()
    idx = json.loads(idx_file.read_text(encoding="utf-8"))
    # Allowlist, failing closed: approved sources plus the owner's own skills; on any error only the own skills.
    try:
        allowed = {r["slug"] for r in load_sources() if is_approved(r) and r.get("slug")}
    except BaseException as exc:  # SystemExit from a missing manifest counts too
        if isinstance(exc, KeyboardInterrupt):
            raise
        allowed = set()
    allowed.add(LOCAL_SLUG)
    skills = idx.get("skills")
    if isinstance(skills, list):
        kept, over, withheld = router_set(skills, allowed)
        idx["skills"] = kept
        idx["over_cap"] = [str(k.get("id") or k.get("name") or "") for k in over]
        idx["withheld"] = withheld
    return idx


def vault_status() -> dict[str, Any]:
    """Return fast vault status summary without triggering a rebuild if uninitialized."""
    idx_file = _index_file()
    v_dir = _vault_dir()
    if idx_file.is_file():
        try:
            idx = json.loads(idx_file.read_text(encoding="utf-8"))
            return {
                "ready": True,
                "repo_count": int(idx.get("repo_count", 0)),
                "cloned_repo_count": int(idx.get("cloned_repo_count", 0)),
                "skill_count": int(idx.get("skill_count", 0)),
                "local_bootstrap": bool(idx.get("local_bootstrap", False)),
                "domain_counts": idx.get("domain_counts", {}),
                "generated_at": idx.get("generated_at", ""),
                "index_path": str(idx_file),
                "vault_dir": str(v_dir),
            }
        except Exception:
            pass
    try:
        sources = load_sources()
        repo_count = len(sources)
    except SystemExit:
        repo_count = 0
    return {
        "ready": False,
        "repo_count": repo_count,
        "cloned_repo_count": 0,
        "skill_count": 0,
        "local_bootstrap": False,
        "domain_counts": {},
        "generated_at": "",
        "index_path": str(idx_file),
        "vault_dir": str(v_dir),
    }


def tokenize(text: str) -> list[str]:
    raw_tokens = re.findall(r"[a-z0-9]+", text.lower())
    out: list[str] = []
    for tok in raw_tokens:
        if len(tok) <= 1:
            continue
        out.append(tok)
        if tok.endswith("s") and len(tok) > 4 and not tok.endswith("ss"):
            out.append(tok[:-1])
        elif tok.endswith("ing") and len(tok) > 5:
            out.append(tok[:-3])
    return out


def expand_query(tokens: list[str]) -> tuple[list[str], list[str]]:
    base = list(dict.fromkeys(tokens))
    expanded: list[str] = []
    for t in base:
        for syn in SYNONYM_MAP.get(t, ()):
            for st in tokenize(syn):
                if st not in base and st not in expanded:
                    expanded.append(st)
    return base, expanded


def search_skills(
    query: str,
    domain: str | None = None,
    limit: int = 6,
    index_data: dict[str, Any] | None = None,
    target_provider: str | None = None,
) -> list[tuple[float, dict[str, Any]]]:
    """Search indexed skills and return sorted (score, skill) tuples."""
    idx = index_data if index_data is not None else load_index()
    skills = idx.get("skills", [])
    # P2-273: a skill synced from the owner's Claude account reaches anything but Claude only under an open licence,
    # the same rule as the Antigravity exposure (bin/skill-expose.mjs); unknown targets fail closed
    skills = [k for k in skills if skill_allowed_for(k, target_provider)]
    if domain:
        d_norm = domain.strip().lower()
        skills = [s for s in skills if s["domain"] == d_norm or d_norm in s["domain"]]

    raw_q = (query or "").strip().lower()
    base_tokens, syn_tokens = expand_query(tokenize(raw_q))
    if not base_tokens:
        return []

    n_docs = max(len(skills), 1)
    df: Counter[str] = Counter()
    doc_cache: list[tuple[dict[str, Any], set[str], set[str], set[str]]] = []
    for s in skills:
        name_toks = set(tokenize(s["name"].replace("-", " ").replace("_", " ")))
        desc_toks = set(tokenize(s.get("description", "")))
        path_toks = set(tokenize(f"{s.get('domain', '')} {s.get('rel_path') or s.get('path', '')} {s.get('repo', '')}"))
        all_toks = name_toks | desc_toks | path_toks
        for t in all_toks:
            df[t] += 1
        doc_cache.append((s, name_toks, desc_toks, path_toks))

    scored: list[tuple[float, dict[str, Any]]] = []
    slug_q = re.sub(r"[^a-z0-9]+", "-", raw_q).strip("-")

    for s, name_toks, desc_toks, path_toks in doc_cache:
        score = 0.0
        matched_base = 0
        s_name_lower = s["name"].lower()
        s_desc_lower = s["description"].lower()

        if raw_q in s_name_lower or (slug_q and slug_q in s_name_lower):
            score += 18.0
        elif raw_q in s_desc_lower:
            score += 7.0

        for t in base_tokens:
            idf = math.log(1.0 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
            hit = False
            if t in name_toks:
                score += 6.0 * idf
                hit = True
            elif any(t in nt for nt in name_toks if len(t) >= 3):
                score += 3.5 * idf
                hit = True
            if t in desc_toks:
                score += 2.6 * idf
                hit = True
            elif any(t in dt_tok for dt_tok in desc_toks if len(t) >= 4):
                score += 1.1 * idf
                hit = True
            if t in path_toks:
                score += 1.6 * idf
                hit = True
            if hit:
                matched_base += 1

        if matched_base == 0:
            syn_hits = 0
            for t in syn_tokens:
                idf = math.log(1.0 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
                if t in name_toks:
                    score += 2.2 * idf
                    syn_hits += 1
                elif t in desc_toks:
                    score += 1.0 * idf
                    syn_hits += 1
            if syn_hits == 0:
                continue
        else:
            coverage = matched_base / len(base_tokens)
            score *= 0.65 + 0.7 * coverage
            for t in syn_tokens:
                idf = math.log(1.0 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
                if t in name_toks:
                    score += 1.8 * idf
                elif t in desc_toks:
                    score += 0.7 * idf

        tier = int(s.get("tier", 3))
        auth_mult = 1.18 if tier == 1 else (1.08 if tier == 2 else 1.0)
        stars = int(s.get("stars", 0))
        star_mult = 1.0 + min(0.14, math.log10(max(stars, 10)) * 0.025)
        eco = str(s.get("ecosystem_focus", "universal")).lower()
        eco_mult = 1.06 if (target_provider in ("gemini", "claude") and eco == target_provider) else 1.0
        score *= auth_mult * star_mult * eco_mult
        scored.append((score, s))

    scored.sort(key=lambda item: (-item[0], int(item[1].get("tier", 3)), -int(item[1].get("stars", 0)), item[1]["name"]))
    return scored[: max(1, limit)]


def cmd_sync(_: argparse.Namespace) -> int:
    sources = load_sources()
    _repos_dir().mkdir(parents=True, exist_ok=True)
    results: list[tuple[str, str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for res in pool.map(clone_one, sources):
            results.append(res)
            slug, status, msg = res
            print(f"[{status:7s}] {slug:32s} {msg}", flush=True)

    errors = [r for r in results if r[1] == "error"]
    idx = build_index()
    print(f"\nIndexed {idx['skill_count']} deduplicated skills across {idx['cloned_repo_count']}/{idx['repo_count']} repos.")
    if errors:
        print(f"Warnings/errors ({len(errors)}): " + ", ".join(r[0] for r in errors), file=sys.stderr)
    return 0 if len(errors) < len(sources) else 1


def cmd_update(_: argparse.Namespace) -> int:
    sources = load_sources()
    _repos_dir().mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for slug, status, msg in pool.map(update_one, sources):
            print(f"[{status:7s}] {slug:32s} {msg}", flush=True)
    idx = build_index()
    print(f"\nRebuilt index: {idx['skill_count']} skills across {idx['cloned_repo_count']}/{idx['repo_count']} repos.")
    return 0


def cmd_index(_: argparse.Namespace) -> int:
    idx = build_index()
    print(f"Indexed {idx['skill_count']} skills across {idx['cloned_repo_count']}/{idx['repo_count']} repos -> {INDEX_FILE}")
    return 0


def cmd_domains(_: argparse.Namespace) -> int:
    idx = load_index()
    counts = idx.get("domain_counts", {})
    print(f"Total indexed skills: {idx.get('skill_count', 0)} across {len(counts)} domains")
    for dom, cnt in counts.items():
        print(f"  {dom:22s} {cnt}")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    if not tokenize(args.query):
        print("Empty query.", file=sys.stderr)
        return 1

    ranked = search_skills(args.query, domain=args.domain, limit=args.limit)
    top = [item[1] for item in ranked]

    if args.json:
        print(json.dumps(top, indent=2, ensure_ascii=False))
        return 0

    if not top:
        print(f"No matching skills found for '{args.query}'. Try broader keywords or run 'domains'.")
        return 0

    for i, s in enumerate(top, 1):
        extras = []
        if s.get("has_scripts"):
            extras.append("scripts")
        if s.get("has_references"):
            extras.append("refs")
        extra_str = f" [{','.join(extras)}]" if extras else ""
        print(f"[{i}] {s['name']} | {s['domain']} | {s['repo']} (T{s['tier']}){extra_str} (id: {s['id']})")
        print(f"    {s['description']}")
        print(f"    path: {s['path']}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    idx = load_index()
    target = args.skill.strip().lower()
    skills = idx.get("skills", [])

    matches = [s for s in skills if s["id"].lower() == target]
    if not matches:
        matches = [s for s in skills if s["name"].lower() == target]
    if not matches:
        matches = [s for s in skills if target in s["id"].lower() or target in s["name"].lower()]

    if not matches:
        print(f"Skill not found: {args.skill}", file=sys.stderr)
        return 1

    s = matches[0]
    sdir = Path(s["path"]).parent
    print(f"id: {s['id']}")
    print(f"name: {s['name']}")
    print(f"domain: {s['domain']} | repo: {s['repo']} (Tier {s['tier']}, {s['stars']}★)")
    print(f"path: {s['path']}")
    print(f"size_bytes: {s['size_bytes']}")
    print(f"description: {s['description']}")
    for sub in ("scripts", "references", "examples", "resources", "assets"):
        sub_dir = sdir / sub
        if sub_dir.is_dir():
            files = sorted(p.relative_to(sdir).as_posix() for p in sub_dir.rglob("*") if p.is_file())
            if files:
                print(f"{sub}/ ({len(files)}): " + ", ".join(files[:25]) + (" ..." if len(files) > 25 else ""))
    if len(matches) > 1:
        print(f"other_matches: {', '.join(m['id'] for m in matches[1:5])}")
    return 0


def dir_size_bytes(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def cmd_bootstrap_local(args: argparse.Namespace) -> int:
    idx_file = _index_file()
    if idx_file.is_file() and not getattr(args, "force", False):
        st = vault_status()
        if getattr(args, "json", False):
            print(json.dumps({"state": "exists", **st}, ensure_ascii=False))
        else:
            print(f"Skill vault index already exists at {idx_file} ({st['skill_count']} skills).")
        return 0

    try:
        sources = load_sources()
    except SystemExit:
        sources = []

    skills = discover_local_skills()
    domain_counts: Counter[str] = Counter()
    for s in skills:
        s.pop("_body_hash", None)
        domain_counts[s["domain"]] += 1

    index_data = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repo_count": len(sources),
        "cloned_repo_count": 0,
        "skill_count": len(skills),
        "local_bootstrap": True,
        "domain_counts": dict(sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "repo_counts": {"local-installed": len(skills)} if skills else {},
        "skills": skills,
    }
    _write_index_atomic(index_data)
    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "state": "bootstrapped",
                    "skill_count": len(skills),
                    "index_path": str(idx_file),
                },
                ensure_ascii=False,
            )
        )
    else:
        print(f"Bootstrapped local skill index with {len(skills)} skills -> {idx_file}")
    return 0


def _default_github_fetch(url: str, headers: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _infer_repo_ecosystem(item: dict[str, Any]) -> str:
    blob = " ".join(
        [
            str(item.get("full_name") or ""),
            str(item.get("description") or ""),
            " ".join(str(t) for t in (item.get("topics") or [])),
        ]
    ).lower()
    if any(k in blob for k in ("gemini", "antigravity")):
        return "gemini"
    if "claude" in blob:
        return "claude"
    return "universal"


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.stem}_", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def discover_trending_github_repos(
    *,
    min_stars: int = 20,
    max_new: int = 8,
    fetcher: Any = None,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Discover trending, highest-used, and highest-rated GitHub agent skill repositories."""
    if _kill_switch_active():
        return {"ok": False, "killed": True, "reason": "kill_switch", "added": [], "top_trending": []}
    if max_new <= 0:
        # P2-275: nothing may be added (`wk sync` passes --max-new 0), so the GitHub search is skipped: a search
        # that cannot change the result must not fail an index pass on a rate limit (HTTP 403) or offline.
        existing = load_sources(include_unapproved=True)
        return {"ok": True, "search": "skipped: max_new is 0", "queries_ok": 0, "errors": [], "discovered_total": 0,
                "updated_existing": 0, "added": [], "total_repos": len(existing), "top_trending": []}

    ts_now = float(now_ts if now_ts is not None else time.time())
    now_dt = dt.datetime.fromtimestamp(ts_now, tz=dt.timezone.utc)
    since_30d = (now_dt - dt.timedelta(days=30)).strftime("%Y-%m-%d")
    since_14d_epoch = ts_now - (14 * 86400)

    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "watchkeeper-skill-vault/0.8",
    }
    gh_tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if gh_tok:
        headers["Authorization"] = f"Bearer {gh_tok}"

    fetch_fn = fetcher or _default_github_fetch
    queries = [
        ("trending_30d", f'"SKILL.md" pushed:>={since_30d} stars:>={min(min_stars, 15)}', "stars", 20),
        ("highest_rated", f'("SKILL.md" in:readme,description OR topic:claude-code-skills OR topic:agent-skills) stars:>={max(min_stars, 50)}', "stars", 25),
        ("highest_used", f'("SKILL.md" in:readme,description OR topic:claude-code-skills OR topic:agent-skills) forks:>=15 stars:>={min_stars}', "forks", 20),
    ]

    by_repo: dict[str, dict[str, Any]] = {}
    queries_ok = 0
    errors: list[str] = []

    for label, q_str, sort_by, per_page in queries:
        qs = urllib.parse.urlencode({"q": q_str, "sort": sort_by, "order": "desc", "per_page": str(per_page)})
        url = f"https://api.github.com/search/repositories?{qs}"
        try:
            payload = fetch_fn(url, headers)
            queries_ok += 1
        except Exception as exc:
            errors.append(f"{label}: {str(exc)[:120]}")
            continue
        for item in payload.get("items") or []:
            if not isinstance(item, dict):
                continue
            if item.get("fork") or item.get("archived") or item.get("disabled"):
                continue
            full_name = str(item.get("full_name") or "").strip()
            html_url = str(item.get("html_url") or "").strip()
            if not full_name or "/" not in full_name or not html_url.startswith("https://github.com/"):
                continue
            stars = int(item.get("stargazers_count") or 0)
            forks = int(item.get("forks_count") or 0)
            if stars < min_stars and forks < 15:
                continue
            desc = str(item.get("description") or "").strip()
            topics = [str(t).lower() for t in (item.get("topics") or []) if isinstance(t, str)]
            hay = f"{full_name} {desc} {' '.join(topics)}".lower()
            if not any(kw in hay for kw in ("skill", "agent", "claude", "mcp", "antigravity", "gemini", "codex")):
                continue
            pushed_str = str(item.get("pushed_at") or "")
            recent_boost = 0.0
            try:
                if pushed_str:
                    p_epoch = dt.datetime.fromisoformat(pushed_str.replace("Z", "+00:00")).timestamp()
                    if p_epoch >= since_14d_epoch:
                        recent_boost = 150.0
            except ValueError:
                pass
            score = stars + (forks * 2.5) + recent_boost
            key = full_name.lower()
            prev = by_repo.get(key)
            if prev is None or score > prev["score"]:
                by_repo[key] = {
                    "full_name": full_name,
                    "html_url": html_url,
                    "stars": stars,
                    "forks": forks,
                    "pushed_at": pushed_str,
                    "description": clean_whitespace(desc, 220),
                    "topics": topics,
                    "score": round(score, 1),
                    "ecosystem_focus": _infer_repo_ecosystem(item),
                    "default_domain": classify_domain(full_name, full_name, desc, "engineering-devops"),
                }

    ranked = sorted(by_repo.values(), key=lambda x: (-x["score"], -x["stars"], x["full_name"].lower()))

    load_sources(include_unapproved=True)
    src_path = _sources_file()
    raw_sources = json.loads(src_path.read_text(encoding="utf-8"))
    existing = raw_sources.get("repos") or []
    by_repo_name = {str(r.get("repo") or "").lower(): r for r in existing if isinstance(r, dict) and r.get("repo")}
    used_slugs = {str(r.get("slug") or "") for r in existing if isinstance(r, dict) and r.get("slug")}
    used_slugs.add(LOCAL_SLUG)  # reserved: a discovered repo named local/installed gets local-installed-2

    updated_existing = 0
    added_entries: list[dict[str, Any]] = []
    now_iso = now_dt.isoformat()

    for idx, cand in enumerate(ranked):
        rkey = cand["full_name"].lower()
        is_top_trend = idx < 15
        if rkey in by_repo_name:
            entry = by_repo_name[rkey]
            entry["stars"] = max(int(entry.get("stars", 0)), cand["stars"])
            entry["forks"] = max(int(entry.get("forks", 0)), cand["forks"])
            if is_top_trend:
                entry["trending"] = True
            updated_existing += 1
            continue
        if len(added_entries) >= max(0, max_new):
            continue
        base_slug = re.sub(r"[^a-z0-9]+", "-", cand["full_name"].lower()).strip("-")[:48] or "trending-skills"
        slug = base_slug
        n_sfx = 2
        while slug in used_slugs:
            slug = f"{base_slug[:42]}-{n_sfx}"
            n_sfx += 1
        used_slugs.add(slug)
        new_entry = {
            "slug": slug,
            "repo": cand["full_name"],
            "url": f"https://github.com/{cand['full_name']}.git",
            "tier": 2 if cand["stars"] >= 200 else 3,
            "stars": cand["stars"],
            "forks": cand["forks"],
            "trending": True,
            "discovered_trending": True,
            "discovered_at": now_iso,
            "default_domain": cand["default_domain"],
            "ecosystem_focus": cand["ecosystem_focus"],
            "description": cand["description"],
            "approved": False,
            "status": "staged",
            "staged_at": now_iso,
        }
        existing.append(new_entry)
        added_entries.append(new_entry)

    raw_sources["repos"] = existing
    raw_sources["last_trending_discovery_at"] = now_iso
    _write_json_atomic(src_path, raw_sources)

    top_trending = [
        {
            "repo": c["full_name"],
            "stars": c["stars"],
            "forks": c["forks"],
            "domain": c["default_domain"],
            "score": c["score"],
        }
        for c in ranked[:10]
    ]
    return {
        "ok": queries_ok > 0 or bool(ranked),
        "queries_ok": queries_ok,
        "errors": errors,
        "discovered_total": len(ranked),
        "updated_existing": updated_existing,
        "added": added_entries,
        "total_repos": len(existing),
        "top_trending": top_trending,
    }


def sync_trending_daily(
    *,
    force: bool = False,
    do_clone: bool = True,
    max_new: int = 6,
    min_stars: int = 20,
    fetcher: Any = None,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Run daily (24h) trending GitHub skill discovery + optional clone/update + index rebuild."""
    if _kill_switch_active():
        return {"ok": False, "killed": True, "reason": "kill_switch"}

    ts_now = float(now_ts if now_ts is not None else time.time())
    sync_file = _sync_status_file()
    if not force and sync_file.is_file():
        try:
            prev = json.loads(sync_file.read_text(encoding="utf-8"))
            if isinstance(prev, dict) and ts_now - float(prev.get("last_sync_epoch") or 0) < 86400:
                return {"ok": True, "skipped": "already_synced_today", **prev}
        except Exception:
            pass

    disc = discover_trending_github_repos(min_stars=min_stars, max_new=max_new, fetcher=fetcher, now_ts=ts_now)
    added_repos = [e["repo"] for e in disc.get("added") or []]
    updated_repos = 0

    if do_clone and not disc.get("killed"):
        sources = [r for r in load_sources() if not r.get("no_skills")]
        _repos_dir().mkdir(parents=True, exist_ok=True)
        added_slugs = {e["slug"] for e in disc.get("added") or []}
        prune_slugs: set[str] = set()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for slug, status, _msg in pool.map(update_one, sources):
                if status in ("updated", "cloned"):
                    updated_repos += 1
                if slug in added_slugs:
                    dest = _repos_dir() / slug
                    if dest.is_dir() and not has_skill_files(dest):
                        shutil.rmtree(dest, ignore_errors=True)
                        prune_slugs.add(slug)
        if prune_slugs:
            raw_sources = json.loads(_sources_file().read_text(encoding="utf-8"))
            for r in raw_sources.get("repos") or []:
                if isinstance(r, dict) and r.get("slug") in prune_slugs:
                    r["no_skills"] = True
            _write_json_atomic(_sources_file(), raw_sources)

    idx = build_index()
    now_iso = dt.datetime.fromtimestamp(ts_now, tz=dt.timezone.utc).isoformat()
    payload = {
        "ok": bool(disc.get("ok", True)),
        "last_sync_at": now_iso,
        "last_sync_epoch": ts_now,
        "interval_hours": 24,
        "queries_ok": disc.get("queries_ok", 0),
        "discovered_total": disc.get("discovered_total", 0),
        "added_repos": added_repos,
        "updated_repos": updated_repos,
        "total_repos": idx.get("repo_count", 0),
        "cloned_repo_count": idx.get("cloned_repo_count", 0),
        "skill_count": idx.get("skill_count", 0),
        "top_trending": disc.get("top_trending", []),
        "errors": disc.get("errors", []),
    }
    _write_json_atomic(sync_file, payload)
    return payload


def cmd_discover_trending(args: argparse.Namespace) -> int:
    if getattr(args, "sync", False):
        res = sync_trending_daily(
            force=getattr(args, "force", False) or not getattr(args, "daily", False),
            do_clone=not getattr(args, "no_clone", False),
            max_new=getattr(args, "max_new", 6),
            min_stars=getattr(args, "min_stars", 20),
        )
    else:
        res = discover_trending_github_repos(
            min_stars=getattr(args, "min_stars", 20),
            max_new=getattr(args, "max_new", 6),
        )
    if getattr(args, "json", False):
        print(json.dumps(res, indent=2, ensure_ascii=False))
    elif res.get("killed"):
        print("Skill Vault trending discovery stopped: ~/.wk/KILL is active.")
    elif res.get("skipped"):
        print(f"Skill Vault daily trending sync already ran today ({res.get('last_sync_at', '')}); {res.get('skill_count', 0)} skills indexed.")
    else:
        print(
            f"Discovered {res.get('discovered_total', 0)} trending/top GitHub skill repos "
            f"(+{len(res.get('added_repos', res.get('added', [])))} new); total skills: {res.get('skill_count', 'n/a')}."
        )
    if res.get("killed"):
        return 3
    return 0 if res.get("ok", True) else 1


def cmd_sync_status(args: argparse.Namespace) -> int:
    st = vault_status()
    sf = _sync_status_file()
    sync_meta: dict[str, Any] = {}
    if sf.is_file():
        try:
            loaded = json.loads(sf.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                sync_meta = loaded
        except Exception:
            pass
    out = {"vault": st, "sync": sync_meta}
    if getattr(args, "json", False):
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print(f"Skill Vault: {st.get('skill_count', 0)} skills | Last trending sync: {sync_meta.get('last_sync_at') or 'never'}")
    return 0


def cmd_stats(_: argparse.Namespace) -> int:
    sources = load_sources()
    idx = load_index()
    repo_counts = idx.get("repo_counts", {})
    domain_counts = idx.get("domain_counts", {})
    v_dir = _vault_dir()
    total_mb = dir_size_bytes(v_dir) / (1024 * 1024) if v_dir.exists() else 0.0

    print(f"Vault: {v_dir} ({total_mb:.1f} MB)")
    print(f"Repos: {idx.get('cloned_repo_count', 0)}/{idx.get('repo_count', 0)} cloned | Total skills: {idx.get('skill_count', 0)}")
    print("\nDomains:")
    for dom, cnt in domain_counts.items():
        print(f"  {dom:22s} {cnt}")
    print("\nRepositories:")
    zero_repos: list[str] = []
    for s in sources:
        slug = s["slug"]
        cnt = repo_counts.get(slug, 0)
        flag = "  [ZERO]" if cnt == 0 else ""
        if cnt == 0:
            zero_repos.append(slug)
        print(f"  T{s['tier']} {s['repo']:40s} skills={cnt:4d}{flag}")
    if zero_repos:
        print(f"\nZero-skill repos ({len(zero_repos)}): {', '.join(zero_repos)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Profession Skill Vault CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sync", help="Clone missing repositories and rebuild index")
    sub.add_parser("update", help="Pull updates for cloned repositories and rebuild index")
    sub.add_parser("index", help="Rebuild index from local cloned repositories")
    sub.add_parser("domains", help="List available domains and skill counts")

    p_search = sub.add_parser("search", help="Search skills by keywords")
    p_search.add_argument("query", help="Search query keywords")
    p_search.add_argument("--domain", help="Filter by domain")
    p_search.add_argument("--limit", type=int, default=6, help="Max results (default: 6)")
    p_search.add_argument("--json", action="store_true", help="Output JSON")

    p_info = sub.add_parser("info", help="Show skill metadata and bundled resources")
    p_info.add_argument("skill", help="Skill id (<slug>/<name>) or skill name")

    sub.add_parser("stats", help="Show vault statistics")

    p_boot = sub.add_parser("bootstrap-local", help="Initialize index from locally installed skills if missing")
    p_boot.add_argument("--force", action="store_true", help="Overwrite existing index")
    p_boot.add_argument("--json", action="store_true", help="Output JSON")

    p_trend = sub.add_parser("discover-trending", help="Discover and optionally sync trending/top-rated GitHub skill libraries")
    p_trend.add_argument("--sync", action="store_true", help="Clone/update repos and rebuild vault index")
    p_trend.add_argument("--daily", action="store_true", help="Skip if already synced within the last 24h")
    p_trend.add_argument("--force", action="store_true", help="Ignore 24h daily interval and sync now")
    p_trend.add_argument("--no-clone", action="store_true", help="Update sources and rebuild index without git cloning")
    p_trend.add_argument("--max-new", type=int, default=6, help="Max newly discovered repos to add (default: 6)")
    p_trend.add_argument("--min-stars", type=int, default=20, help="Minimum GitHub stars (default: 20)")
    p_trend.add_argument("--json", action="store_true", help="Output JSON")

    p_pend = sub.add_parser("pending", help="List sources waiting for the owner's OK")
    p_pend.add_argument("--json", action="store_true", help="Output JSON")

    p_isrc = sub.add_parser("index-source", help="Index one approved source only")
    p_isrc.add_argument("slug", help="Source slug or owner/repo")
    p_isrc.add_argument("--json", action="store_true", help="Output JSON")

    p_drop = sub.add_parser("drop-source", help="Remove one source's skills from the index (files stay)")
    p_drop.add_argument("slug", help="Source slug or owner/repo")
    p_drop.add_argument("--json", action="store_true", help="Output JSON")

    p_chk = sub.add_parser("check-skill", help="Run the sanitizer over one skill folder (exit 1 when refused)")
    p_chk.add_argument("path", help="Skill folder holding SKILL.md")
    p_chk.add_argument("--json", action="store_true", help="Output JSON")

    p_sync_st = sub.add_parser("sync-status", help="Show Skill Vault trending sync status")
    p_sync_st.add_argument("--json", action="store_true", help="Output JSON")

    args = parser.parse_args()
    handlers = {
        "sync": cmd_sync,
        "update": cmd_update,
        "index": cmd_index,
        "domains": cmd_domains,
        "search": cmd_search,
        "info": cmd_info,
        "stats": cmd_stats,
        "bootstrap-local": cmd_bootstrap_local,
        "discover-trending": cmd_discover_trending,
        "sync-status": cmd_sync_status,
        "pending": cmd_pending,
        "index-source": cmd_index_source,
        "drop-source": cmd_drop_source,
        "check-skill": cmd_check_skill,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())

