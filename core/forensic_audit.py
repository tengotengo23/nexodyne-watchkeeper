#!/usr/bin/env python3
"""Phase 0 Forensic Reconnaissance & Capability Ledger Generator for Watchkeeper v2.0."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def sanitize_path(p: str | Path, home: Path | None = None, root: Path | None = None) -> str:
    """Convert workspace paths to repo-relative and home paths to portable ~/ form."""
    s = str(p)
    r = str((root or ROOT).resolve())
    if s == r:
        return "."
    if s.startswith(r + os.sep):
        return s[len(r) + 1 :].replace(os.sep, "/")
    h = str((home or Path.home()).resolve())
    if s == h:
        return "~"
    if s.startswith(h + os.sep):
        return "~/" + s[len(h) + 1 :].replace(os.sep, "/")
    return s.replace(os.sep, "/")


def _extract_frontmatter_name(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return path.parent.name
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if m:
        nm = re.search(r"^name:\s*(.+)$", m.group(1), re.MULTILINE)
        if nm:
            return nm.group(1).strip().strip("\"'")
    return path.parent.name


def _extract_js_exports(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    syms: list[str] = []
    for m in re.finditer(r"^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)", text, re.MULTILINE):
        syms.append(m.group(1))
    mod = re.search(r"module\.exports\s*=\s*\{([^}]+)\}", text)
    if mod:
        for tok in mod.group(1).split(","):
            name = tok.strip().split(":")[0].strip()
            if name and re.match(r"^[A-Za-z0-9_]+$", name):
                syms.append(name)
    return syms[:12]


def _extract_py_symbols(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    syms: list[str] = []
    for m in re.finditer(r"^(?:def|class)\s+([A-Za-z][A-Za-z0-9_]*)", text, re.MULTILINE):
        syms.append(m.group(1))
    return syms[:12]


def _entry(
    cid: str,
    origin: str,
    source_file: str,
    symbols: list[str],
    trigger: str,
    target: str,
    assertion: str,
) -> dict[str, Any]:
    return {
        "id": cid,
        "origin_component": origin,
        "source_file": source_file,
        "symbols_or_entrypoints": symbols,
        "lifecycle_trigger": trigger,
        "target_unified_module": target,
        "verification_assertion": assertion,
    }


def _scan_watchkeeper_core(root: Path, entries: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"bin": 0, "hooks": 0, "commands": 0, "agents": 0, "skills": 0, "panel": 0, "antigravity": 0}

    bin_dir = root / "bin"
    if bin_dir.is_dir():
        for p in sorted(bin_dir.iterdir()):
            if not p.is_file():
                continue
            rel = sanitize_path(p)
            syms = _extract_js_exports(p) or [p.stem]
            origin = "graphify" if "graphify" in p.name else "watchkeeper"
            trigger = (
                "HookBus:SessionStart|PreToolUse|PostToolUse|Stop"
                if any(k in p.name for k in ("guard", "evidence", "start", "handoff", "gemini-log"))
                else "CLI/Panel/Scheduler"
            )
            target = (
                "core/graph_bridge.py"
                if "graphify" in p.name
                else f"bin/{p.name} (preserved + unified)"
            )
            entries.append(
                _entry(
                    f"wk-bin-{p.name}",
                    origin,
                    rel,
                    syms,
                    trigger,
                    target,
                    f"file_exists('{rel}')",
                )
            )
            counts["bin"] += 1

    hooks_json = root / "hooks" / "hooks.json"
    if hooks_json.is_file():
        try:
            data = json.loads(hooks_json.read_text(encoding="utf-8"))
            hooks_map = data.get("hooks") if isinstance(data.get("hooks"), dict) else data
            for event_name, matchers in hooks_map.items():
                if not isinstance(matchers, list):
                    continue
                entries.append(
                    _entry(
                        f"wk-hook-{event_name}",
                        "watchkeeper",
                        "hooks/hooks.json",
                        [event_name],
                        f"HookEvent:{event_name}",
                        f"core/hook_bus.py:{event_name}",
                        f"hook_registered('{event_name}')",
                    )
                )
                counts["hooks"] += 1
        except (OSError, ValueError):
            pass

    cmd_dir = root / "commands"
    if cmd_dir.is_dir():
        for p in sorted(cmd_dir.glob("*.md")):
            rel = sanitize_path(p)
            entries.append(
                _entry(
                    f"wk-cmd-{p.stem}",
                    "watchkeeper",
                    rel,
                    [f"/watchkeeper:{p.stem}"],
                    f"SlashCommand:/watchkeeper:{p.stem}",
                    f"{rel} + core/wk_cli.py",
                    f"file_exists('{rel}')",
                )
            )
            counts["commands"] += 1

    agents_dir = root / "agents"
    if agents_dir.is_dir():
        for p in sorted(agents_dir.glob("*.md")):
            rel = sanitize_path(p)
            entries.append(
                _entry(
                    f"wk-agent-{p.stem}",
                    "watchkeeper",
                    rel,
                    [_extract_frontmatter_name(p)],
                    "SubagentStart/SubagentStop",
                    f"{rel} + core/fast_path.py",
                    f"file_exists('{rel}')",
                )
            )
            counts["agents"] += 1

    skills_dir = root / "skills"
    if skills_dir.is_dir():
        for p in sorted(skills_dir.glob("*/SKILL.md")):
            rel = sanitize_path(p)
            sname = _extract_frontmatter_name(p)
            origin = "graphify" if sname == "graphify" else "watchkeeper"
            entries.append(
                _entry(
                    f"wk-skill-{sname}",
                    origin,
                    rel,
                    [f"/{sname}", sname],
                    "SkillRouter/SlashCommand",
                    f"core/skill_router.py + {rel}",
                    f"skill_indexed('{sname}')",
                )
            )
            counts["skills"] += 1

    agy_dir = root / "antigravity" / "plugins" / "watchkeeper"
    if agy_dir.is_dir():
        for p in sorted(agy_dir.rglob("*")):
            if not p.is_file() or p.name.startswith("."):
                continue
            rel = sanitize_path(p)
            origin = "graphify" if "graphify" in rel else ("re-prompt-v1.3.0" if "re-prompt" in rel else "watchkeeper")
            entries.append(
                _entry(
                    f"agy-{rel}",
                    origin,
                    rel,
                    [p.name],
                    "AntigravityPluginInstall",
                    rel,
                    f"file_exists('{rel}')",
                )
            )
            counts["antigravity"] += 1

    panel_dir = root / "panel"
    if panel_dir.is_dir():
        for p in sorted(panel_dir.rglob("*")):
            if not p.is_file() or "node_modules" in p.parts or p.name.startswith("."):
                continue
            if p.suffix not in (".js", ".json", ".css", ".html", ".md", ".svg"):
                continue
            rel = sanitize_path(p)
            entries.append(
                _entry(
                    f"panel-{rel}",
                    "watchkeeper",
                    rel,
                    _extract_js_exports(p) if p.suffix == ".js" else [p.name],
                    "FullIDEWorkspace/Panel",
                    rel,
                    f"file_exists('{rel}')",
                )
            )
            counts["panel"] += 1

    srv = root / "server.json"
    if srv.is_file():
        entries.append(
            _entry(
                "wk-mcp-registry-server",
                "watchkeeper",
                "server.json",
                ["io.github.tengotengo23/nexodyne-watchkeeper"],
                "MCPRegistry",
                "server.json",
                "file_exists('server.json')",
            )
        )

    return counts


def _scan_reprompt_tree(root: Path, staging_dir: Path, entries: list[dict[str, Any]]) -> int:
    reprompt_dir = staging_dir / "re-prompt-v1.3.0"
    if not reprompt_dir.is_dir():
        reprompt_dir = staging_dir if staging_dir.is_dir() else root / "reprompt"
    count = 0
    embedded_root = root / "reprompt"
    if not reprompt_dir.is_dir():
        return 0
    for p in sorted(reprompt_dir.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.name == ".DS_Store":
            continue
        rel_sub = p.relative_to(reprompt_dir).as_posix()
        target_rel = f"reprompt/{rel_sub}" if (embedded_root / rel_sub).is_file() else "core/ + reprompt/"
        syms = _extract_py_symbols(p) if p.suffix == ".py" else ([p.stem] if p.suffix == ".md" else [p.name])
        if "inline_hook" in rel_sub or "skill_hook" in rel_sub:
            trg = "HookEvent:UserPromptSubmit|PreInvocation"
        elif "skill_" in rel_sub or rel_sub.startswith("skills/"):
            trg = "SkillRouter"
        elif "mcp" in rel_sub:
            trg = "MCPServer"
        elif "orchestr" in rel_sub:
            trg = "Orchestrator"
        elif "reprompt_engine" in rel_sub or "reprompt_app" in rel_sub:
            trg = "PromptCompiler"
        else:
            trg = "Distribution/Docs"
        entries.append(
            _entry(
                f"reprompt-v130-{rel_sub}",
                "re-prompt-v1.3.0",
                f"reprompt/{rel_sub}" if (embedded_root / rel_sub).is_file() else f".watchkeeper/staging/re-prompt-v1.3.0/{rel_sub}",
                syms,
                trg,
                target_rel,
                f"file_exists('{target_rel.split(' ')[0]}')" if (embedded_root / rel_sub).is_file() else "symbol_exists('core.clipboard_io', 'extract_fenced_rewrite')",
            )
        )
        count += 1
    # Explicitly track standalone clipboard handlers & nested fence rubric from v1.3.0 + v2.0
    entries.append(
        _entry(
            "reprompt-v130-standalone-clipboard",
            "re-prompt-v1.3.0",
            "reprompt/server/reprompt_engine.py",
            ["extract_fenced_rewrite", "copy_to_clipboard", "wl-copy", "xclip", "xsel", "pbcopy", "clip.exe"],
            "Stop:standalone_reprompt",
            "core/clipboard_io.py",
            "symbol_exists('core.clipboard_io', 'copy_to_clipboard')",
        )
    )
    return count


def _scan_external_skills(root: Path, home: Path) -> list[dict[str, Any]]:
    roots = [
        ("project_local", root / ".claude" / "skills"),
        ("watchkeeper_core", root / "skills"),
        ("antigravity_plugin", root / "antigravity" / "plugins" / "watchkeeper" / "skills"),
        ("user_global_skills", home / ".claude" / "skills"),
        ("user_global_commands", home / ".claude" / "commands"),
    ]
    found: list[dict[str, Any]] = []
    for scope, base in roots:
        if not base.is_dir():
            continue
        if base.name == "commands":
            for p in sorted(base.glob("*.md")):
                found.append({"scope": scope, "name": p.stem, "path": sanitize_path(p, home), "has_aux": False})
        else:
            for p in sorted(base.glob("*/SKILL.md")):
                folder = p.parent
                has_aux = any((folder / sub).is_dir() for sub in ("scripts", "references", "templates", "assets"))
                found.append({"scope": scope, "name": _extract_frontmatter_name(p), "path": sanitize_path(p, home), "has_aux": has_aux})
    return found


def generate_ledger(
    root: Path = ROOT,
    home: Path | None = None,
    staging_dir: Path | None = None,
    write_outputs: bool = True,
) -> dict[str, Any]:
    h = (home or Path.home()).resolve()
    stg = staging_dir or (root / ".watchkeeper" / "staging" / "re-prompt-v1.3.0")
    entries: list[dict[str, Any]] = []
    wk_counts = _scan_watchkeeper_core(root, entries)
    rp_count = _scan_reprompt_tree(root, stg, entries)
    ext_skills = _scan_external_skills(root, h)

    # Deduplicate by id preserving order
    seen: set[str] = set()
    unique_entries: list[dict[str, Any]] = []
    for e in entries:
        if e["id"] not in seen:
            seen.add(e["id"])
            unique_entries.append(e)

    vault_index = h / ".gemini" / "skill-vault" / "index.json"
    vault_count = 0
    if vault_index.is_file():
        try:
            vault_count = int(json.loads(vault_index.read_text(encoding="utf-8")).get("skill_count") or 0)
        except (OSError, ValueError):
            vault_count = 0

    graph_file = root / "graphify-out" / "graph.json"
    graph_status = {"exists": graph_file.is_file(), "schema_version": None, "graphify_version": None, "nodes": 0, "edges": 0}
    if graph_file.is_file():
        try:
            gd = json.loads(graph_file.read_text(encoding="utf-8"))
            graph_status["schema_version"] = gd.get("schema_version")
            graph_status["graphify_version"] = gd.get("graphify_version")
            graph_status["nodes"] = len(gd.get("nodes") or [])
            graph_status["edges"] = len(gd.get("links") or gd.get("edges") or [])
        except (OSError, ValueError):
            pass

    ledger = {
        "schema_version": "2.0.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "summary": {
            "total_capabilities": len(unique_entries),
            "watchkeeper_counts": wk_counts,
            "reprompt_v130_files": rp_count,
            "graphify_status": graph_status,
            "local_skills_discovered": len(ext_skills),
            "skill_vault_indexed": vault_count,
        },
        "external_skills_catalog": ext_skills,
        "capabilities": unique_entries,
    }

    if write_outputs:
        p_repo = root / "core" / "CAPABILITY_LEDGER.json"
        p_audit = root / ".watchkeeper" / "audit" / "CAPABILITY_LEDGER.json"
        p_repo.parent.mkdir(parents=True, exist_ok=True)
        p_audit.parent.mkdir(parents=True, exist_ok=True)
        p_audit.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        def _is_public_cap(entry: dict[str, Any]) -> bool:
            src_f = str(entry.get("source_file") or "")
            return not (src_f.startswith("panel/install/") or "wk-duty" in src_f)

        pub_caps = [e for e in unique_entries if _is_public_cap(e)]
        pub_ext = [x for x in ext_skills if x.get("scope") in ("watchkeeper_core", "antigravity_plugin")]
        pub_summary = {
            **ledger["summary"],
            "total_capabilities": len(pub_caps),
            "local_skills_discovered": len(pub_ext),
        }
        pub_ledger = {
            **ledger,
            "summary": pub_summary,
            "external_skills_catalog": pub_ext,
            "capabilities": pub_caps,
        }
        p_repo.write_text(json.dumps(pub_ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return ledger


def main() -> int:
    ledger = generate_ledger(write_outputs=True)
    s = ledger["summary"]
    wc = s["watchkeeper_counts"]
    print(
        f"Phase 0 Reconnaissance Digest: {s['total_capabilities']} capabilities | "
        f"Watchkeeper (bin={wc['bin']}, hooks={wc['hooks']}, cmds={wc['commands']}, agents={wc['agents']}, "
        f"skills={wc['skills']}, panel={wc['panel']}, agy={wc['antigravity']}) | "
        f"re-prompt-v1.3.0 files={s['reprompt_v130_files']} | "
        f"local_skills={s['local_skills_discovered']} | vault_indexed={s['skill_vault_indexed']} | "
        f"graphify_present={s['graphify_status']['exists']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
