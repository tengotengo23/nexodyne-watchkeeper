"""Re-Prompt core rewriting engine, multi-provider adapters, and storage."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Ensure bundled scripts (skill_vault, skill_router) are importable
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from prompt_prefix import AUTO_OVER_WORDS, SETTINGS_VERSION, auto_over_words, migrate_settings  # noqa: E402
from skill_router import (  # noqa: E402
    LEVEL_RANK,
    analyze_session_turn,
    default_session_state,
    inject_skill_directives,
    judge_skills_for_prompt,
    parse_skill_pins,
)
from skill_vault import _index_file, load_index, vault_status  # noqa: E402

# P2-272: one prefix grammar (scripts/prompt_prefix.py) for every surface: `raw:`, `rp-raw:`, `/wk raw:`, `:raw `.
from prompt_prefix import RAW_PREFIX_RE as RAW_BYPASS_RE  # noqa: E402,F401
from prompt_prefix import parse_raw as _parse_raw  # noqa: E402


def parse_raw_bypass(text: str) -> str | None:
    """Return raw prompt body when the user explicitly requests `raw:` / `rp-raw:` / `/wk raw:` / `:raw ` bypass."""
    return _parse_raw(text)


def detect_graphify_context(workspace_dir: str | Path | None = None) -> str:
    """Detect whether Graphify knowledge-graph artifacts exist in workspace_dir."""
    if not workspace_dir:
        return ""
    try:
        base = Path(workspace_dir).expanduser().resolve()
    except Exception:
        return ""
    g_dir = base / "graphify-out"
    if not (g_dir / "graph.json").is_file():
        return ""
    wiki_note = " (and graphify-out/wiki/index.md)" if (g_dir / "wiki" / "index.md").is_file() else ""
    return (
        f"Graphify knowledge graph available at graphify-out/graph.json{wiki_note}: "
        "query with `graphify query/path/explain` before broad grep/file reads, "
        "and run `graphify update .` after code edits."
    )


TARGETS: dict[str, dict[str, str]] = {
    "antigravity": {
        "id": "antigravity",
        "label": "Antigravity",
        "guidance": (
            "Optimize for an autonomous coding agent in Antigravity IDE / CLI "
            "(capable of reading/editing workspace files, running terminal commands, "
            "searching the codebase, and verifying changes). Specify concrete deliverables, "
            "acceptance criteria, verification commands/tests, and guardrails."
        ),
    },
    "claude_code": {
        "id": "claude_code",
        "label": "Claude Code",
        "guidance": (
            "Optimize for Claude Code (terminal & IDE coding agent). Make the prompt "
            "crystal clear about exploration vs. editing expectations, exact scope, "
            "edge cases, coding conventions to preserve, and verification checks to run "
            "before finishing."
        ),
    },
    "general": {
        "id": "general",
        "label": "General AI",
        "guidance": (
            "Optimize for a general-purpose AI coding or reasoning assistant. Structure "
            "the objective, background context, explicit instructions, output format, "
            "and quality checks clearly."
        ),
    },
}

MODES: dict[str, dict[str, str]] = {
    "balanced": {
        "id": "balanced",
        "label": "Balanced",
        "guidance": (
            "Produce a clear, well-proportioned specification with concise sections: "
            "Goal, Context & Scope, Requirements, Constraints & Edge Cases, and Verification."
        ),
    },
    "deep_spec": {
        "id": "deep_spec",
        "label": "Deep Spec",
        "guidance": (
            "Produce a thorough engineering specification covering architecture, data flow, "
            "interfaces, error handling, edge cases, non-goals, and multi-step verification."
        ),
    },
    "bug_fix": {
        "id": "bug_fix",
        "label": "Bug Fix",
        "guidance": (
            "Frame the prompt around root-cause investigation first: observed vs. expected "
            "behavior, reproduction steps, likely fault boundaries, fix constraints, and "
            "regression test verification."
        ),
    },
    "refactor": {
        "id": "refactor",
        "label": "Refactor",
        "guidance": (
            "Emphasize behavior preservation, structural clarity, modular boundaries, "
            "backwards compatibility, incremental steps, and proving existing behavior stays intact."
        ),
    },
    "concise": {
        "id": "concise",
        "label": "Concise",
        "guidance": (
            "Keep the rewritten prompt compact and punchy (short bullet points, no fluff) "
            "while still eliminating ambiguity and stating clear verification criteria."
        ),
    },
}

REFINEMENTS: dict[str, str] = {
    "shorter": "Condense the rewritten prompt by ~35-45% while preserving every critical requirement, constraint, and verification step.",
    "detailed": "Expand the rewritten prompt with more concrete implementation guidance, edge cases, failure modes, and acceptance checks without inventing nonexistent files.",
    "edge_cases": "Strengthen the Constraints & Edge Cases section to explicitly call out boundary conditions, error states, concurrency/platform pitfalls, and invalid inputs.",
    "add_tests": "Enhance the Verification section with specific unit, integration, and manual/end-to-end test cases the AI should write and run.",
}

# P2-272: providers the Claude Code hook may use. agy, "auto" and the Gemini API are never
# called from Claude (Watchkeeper canon); the hook marks its calls with WK_CALLER=claude_code.
CLAUDE_CODE_PROVIDERS: frozenset[str] = frozenset({"offline_template", "claude_cli", "anthropic_api"})
# P2-272: how the last prompt of each session went, for the W panel's :raw / re-prompt badges.
ROUTES: tuple[str, ...] = ("raw", "reprompt", "skills", "plain")
MAX_ROUTE_ITEMS = 200

AGY_ORCHESTRATOR_MODEL = "gemini-pro-orchestrator"
AGY_REWRITE_FALLBACK_CHAIN: tuple[str, ...] = (
    "gemini-pro-orchestrator",
    "gemini-4-carbon-high",
    "gemini-4-argon-high",
    "gemini-4-neon-high",
)

DEFAULT_SETTINGS: dict[str, Any] = {
    "provider": "agy",
    "agyModel": AGY_ORCHESTRATOR_MODEL,
    "claudeModel": "",
    "geminiModel": "gemini-4-hydrogen",
    "anthropicModel": "claude-sonnet-4-20250514",
    "openaiModel": "gpt-4o-mini",
    "openaiBaseUrl": "https://api.openai.com/v1",
    "geminiApiKey": "",
    "anthropicApiKey": "",
    "openaiApiKey": "",
    "defaultTarget": "antigravity",
    "defaultMode": "balanced",
    "autoRewrite": False,
    "autoRewriteDelayMs": 1200,
    "includeWorkspaceContext": True,
    "enableSkillRouting": True,
    "hookAutoAll": False,
    # P2-273 (owner, 24 Nov): a plain prompt of more than this many words is re-prompted without a prefix, in
    # Antigravity and in Claude Code alike (scripts/prompt_prefix.py wants_auto_rewrite). 0 turns the rule off.
    "autoRewriteOverWords": AUTO_OVER_WORDS,
    # P2-272 (canon): Claude Code's prompt hook never uses agy or Gemini. "words" (default, P2-273) rewrites rp: / rp-*:
    # / :re-prompt / :rp messages and plain messages above autoRewriteOverWords words; "prefix" only the prefixed ones;
    # "always" also rewrites messages of 40+ characters; "never" turns it off.
    "claudeCodeRewrite": "words",
    "claudeCodeProvider": "offline_template",
    # P2-273 (owner: "quiet AST Graphify"): the graph updates silently; adding graph context to every Antigravity turn
    # (bin/wk-graph-hook.py PreInvocation) is opt-in.
    "graphTurnContext": False,
    # P2-273 review: files without it were written with the old defaults; prompt_prefix.migrate_settings moves them once.
    "settingsVersion": SETTINGS_VERSION,
}

CLAUDE_CODE_REWRITE_MODES: tuple[str, ...] = ("prefix", "words", "always", "never")

MAX_HISTORY_ITEMS = 50
MAX_SESSION_ITEMS = 30
_PREAMBLE_RE = re.compile(
    r"^(?:here(?:'s| is)\s+(?:the\s+)?(?:rewritten|improved|refined|updated)\s+prompt\s*:?\s*\n+|"
    r"sure[,!.]?\s+here(?:'s| is)[^\n]*:\s*\n+|"
    r"rewritten\s+prompt\s*:\s*\n+)",
    re.IGNORECASE,
)


def default_data_dir() -> Path:
    """Return the cross-platform persistent data directory for Re-Prompt."""
    env_dir = os.environ.get("REPROMPT_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    # One shared store: the Watchkeeper folder when it exists (what the hooks and the panel use), else the old default.
    wk_dir = Path.home() / ".gemini" / "antigravity" / "plugin_data" / "watchkeeper"
    if wk_dir.is_dir():
        return wk_dir
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
        return base / "re-prompt"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "re-prompt"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg).expanduser() / "re-prompt"


def find_executable(name: str, extra_candidates: list[Path]) -> str | None:
    """Locate an executable on PATH or in known install directories."""
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt" and not name.endswith((".exe", ".cmd", ".bat")):
        for ext in (".exe", ".cmd", ".bat"):
            found_win = shutil.which(name + ext)
            if found_win:
                return found_win
    for candidate in extra_candidates:
        if candidate.is_file() and (os.name == "nt" or os.access(candidate, os.X_OK)):
            return str(candidate)
    return None


def find_agy_binary() -> str | None:
    """Discover the Antigravity CLI (`agy`) across Linux, macOS, and Windows."""
    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "agy",
        home / ".gemini" / "bin" / "agy",
        home / ".gemini" / "antigravity" / "bin" / "agy",
        Path("/usr/local/bin/agy"),
        Path("/opt/homebrew/bin/agy"),
    ]
    if os.name == "nt":
        local_app = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        candidates = [
            home / ".local" / "bin" / "agy.exe",
            home / ".gemini" / "bin" / "agy.exe",
            local_app / "Programs" / "antigravity" / "agy.exe",
            local_app / "Antigravity" / "agy.exe",
        ] + candidates
    return find_executable("agy", candidates)


def find_claude_binary() -> str | None:
    """Discover the Claude Code CLI (`claude`) across Linux, macOS, and Windows."""
    home = Path.home()
    candidates = [
        home / ".claude" / "local" / "claude",
        home / ".local" / "bin" / "claude",
        home / ".npm-global" / "bin" / "claude",
        Path("/usr/local/bin/claude"),
        Path("/opt/homebrew/bin/claude"),
    ]
    if os.name == "nt":
        app_data = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        candidates = [
            home / ".local" / "bin" / "claude.exe",
            app_data / "npm" / "claude.cmd",
            app_data / "npm" / "claude.exe",
        ] + candidates
    return find_executable("claude", candidates)


class RePromptStore:
    """Thread-safe JSON file store for Re-Prompt settings and rewrite history."""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.data_dir / "settings.json"
        self.history_path = self.data_dir / "history.json"
        self.sessions_path = self.data_dir / "sessions.json"
        self.routes_path = self.data_dir / "routes.json"

    def load_routes(self) -> dict[str, Any]:
        """P2-272: {session_id: {route, engine, mode, skills, graphify, at}} for the W panel badges."""
        try:
            data = json.loads(self.routes_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def mark_route(
        self,
        session_id: str,
        route: str,
        engine: str,
        *,
        mode: str = "",
        skills: int = 0,
        graphify: bool = False,
        trigger: str = "",
    ) -> dict[str, Any]:
        """P2-272: remember how a session's last prompt went: raw, reprompt, skills (hint only) or plain."""
        entry = {
            "route": route if route in ROUTES else "plain",
            "engine": str(engine or "")[:20],
            "mode": str(mode or "")[:20],
            "skills": max(0, int(skills or 0)),
            "graphify": bool(graphify),
            "trigger": str(trigger or "")[:12],
            "at": datetime.now(timezone.utc).isoformat(),
        }
        sid = ((session_id or "default").strip() or "default")[:96]
        with self._lock:
            routes = self.load_routes()
            routes[sid] = entry
            if len(routes) > MAX_ROUTE_ITEMS:
                ordered = sorted(routes.items(), key=lambda kv: str((kv[1] or {}).get("at") or ""), reverse=True)
                routes = dict(ordered[:MAX_ROUTE_ITEMS])
            try:
                self._atomic_write_json(self.routes_path, routes, secure=False)
            except Exception:
                pass
        return entry

    def _atomic_write_json(self, path: Path, payload: Any, secure: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            if secure and os.name == "posix":
                os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, path)
            if secure and os.name == "posix":
                os.chmod(path, 0o600)
        except Exception:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise

    def load_settings(self) -> dict[str, Any]:
        with self._lock:
            settings = dict(DEFAULT_SETTINGS)
            if self.settings_path.is_file():
                try:
                    raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
                    if isinstance(raw, dict):
                        raw = migrate_settings(raw)
                        for key in DEFAULT_SETTINGS:
                            if key in raw and raw[key] is not None:
                                settings[key] = raw[key]
                        if raw.get("agyModelExplicit") is True:
                            settings["agyModelExplicit"] = True
                        elif raw.get("agyModel") == "gemini-3.8-flash-low":
                            settings["agyModel"] = AGY_ORCHESTRATOR_MODEL
                except Exception as exc:
                    print(f"[re-prompt] Failed reading settings: {exc}", file=sys.stderr)
            return settings

    def public_settings(self) -> dict[str, Any]:
        """Return settings safe for UI transport (API keys replaced by boolean flags)."""
        with self._lock:
            s = self.load_settings()
            return {
                "provider": s["provider"],
                "agyModel": s["agyModel"],
                "claudeModel": s["claudeModel"],
                "geminiModel": s["geminiModel"],
                "anthropicModel": s["anthropicModel"],
                "openaiModel": s["openaiModel"],
                "openaiBaseUrl": s["openaiBaseUrl"],
                "hasGeminiApiKey": bool(s.get("geminiApiKey") or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")),
                "hasAnthropicApiKey": bool(s.get("anthropicApiKey") or os.environ.get("ANTHROPIC_API_KEY")),
                "hasOpenaiApiKey": bool(s.get("openaiApiKey") or os.environ.get("OPENAI_API_KEY")),
                "defaultTarget": s["defaultTarget"],
                "defaultMode": s["defaultMode"],
                "autoRewrite": bool(s["autoRewrite"]),
                "autoRewriteDelayMs": int(s["autoRewriteDelayMs"]),
                "includeWorkspaceContext": bool(s["includeWorkspaceContext"]),
                "enableSkillRouting": bool(s.get("enableSkillRouting", True)),
                "hookAutoAll": bool(s.get("hookAutoAll", False)),
                "autoRewriteOverWords": auto_over_words(s.get("autoRewriteOverWords")),
                "claudeCodeRewrite": str(s.get("claudeCodeRewrite") or "words"),
                "claudeCodeProvider": str(s.get("claudeCodeProvider") or "offline_template"),
                "graphTurnContext": s.get("graphTurnContext") is True,
            }

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self.load_settings()
            if not isinstance(updates, dict):
                return self.public_settings()

            for key in (
                "provider",
                "agyModel",
                "claudeModel",
                "geminiModel",
                "anthropicModel",
                "openaiModel",
                "openaiBaseUrl",
                "defaultTarget",
                "defaultMode",
            ):
                if key in updates and isinstance(updates[key], str):
                    current[key] = updates[key].strip()
                    if key == "agyModel" and current[key]:
                        current["agyModelExplicit"] = True

            if "autoRewrite" in updates:
                current["autoRewrite"] = bool(updates["autoRewrite"])
            if "includeWorkspaceContext" in updates:
                current["includeWorkspaceContext"] = bool(updates["includeWorkspaceContext"])
            if "enableSkillRouting" in updates:
                current["enableSkillRouting"] = bool(updates["enableSkillRouting"])
            if "hookAutoAll" in updates:
                current["hookAutoAll"] = bool(updates["hookAutoAll"])
            if "graphTurnContext" in updates:
                current["graphTurnContext"] = updates["graphTurnContext"] is True
            if "autoRewriteOverWords" in updates:
                current["autoRewriteOverWords"] = min(500, auto_over_words(updates["autoRewriteOverWords"]))
            if str(updates.get("claudeCodeRewrite") or "").strip().lower() in CLAUDE_CODE_REWRITE_MODES:
                current["claudeCodeRewrite"] = str(updates["claudeCodeRewrite"]).strip().lower()
            if str(updates.get("claudeCodeProvider") or "").strip().lower() in CLAUDE_CODE_PROVIDERS:
                current["claudeCodeProvider"] = str(updates["claudeCodeProvider"]).strip().lower()
            if "autoRewriteDelayMs" in updates:
                try:
                    delay = int(updates["autoRewriteDelayMs"])
                    current["autoRewriteDelayMs"] = max(400, min(5000, delay))
                except (TypeError, ValueError):
                    pass

            for secret_key, clear_flag in (
                ("geminiApiKey", "clearGeminiApiKey"),
                ("anthropicApiKey", "clearAnthropicApiKey"),
                ("openaiApiKey", "clearOpenaiApiKey"),
            ):
                if updates.get(clear_flag):
                    current[secret_key] = ""
                elif secret_key in updates and isinstance(updates[secret_key], str):
                    val = updates[secret_key].strip()
                    if val:
                        current[secret_key] = val

            current.pop("target", None)
            if current["defaultTarget"] not in TARGETS:
                current["defaultTarget"] = "antigravity"
            if current["defaultMode"] not in MODES:
                current["defaultMode"] = "balanced"

            self._atomic_write_json(self.settings_path, current, secure=True)
            return self.public_settings()

    def load_history(self) -> list[dict[str, Any]]:
        with self._lock:
            if not self.history_path.is_file():
                return []
            try:
                data = json.loads(self.history_path.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    return [item for item in data if isinstance(item, dict)][:MAX_HISTORY_ITEMS]
            except Exception as exc:
                print(f"[re-prompt] Failed reading history: {exc}", file=sys.stderr)
            return []

    def add_history(self, entry: dict[str, Any]) -> list[dict[str, Any]]:
        with self._lock:
            history = self.load_history()
            record = {
                "id": entry.get("id") or uuid.uuid4().hex[:12],
                "timestamp": entry.get("timestamp") or datetime.now(timezone.utc).isoformat(),
                "original": entry.get("original", ""),
                "rewritten": entry.get("rewritten", ""),
                "summary": entry.get("summary", ""),
                "improvements": list(entry.get("improvements") or []),
                "target": entry.get("target", "antigravity"),
                "mode": entry.get("mode", "balanced"),
                "provider": entry.get("provider", ""),
                "model": entry.get("model", ""),
                "duration_ms": int(entry.get("duration_ms", 0)),
            }
            history = [record] + [item for item in history if item.get("id") != record["id"]]
            history = history[:MAX_HISTORY_ITEMS]
            self._atomic_write_json(self.history_path, history, secure=False)
            return history

    def delete_history(self, item_id: str) -> list[dict[str, Any]]:
        with self._lock:
            history = [item for item in self.load_history() if item.get("id") != item_id]
            self._atomic_write_json(self.history_path, history, secure=False)
            return history

    def clear_history(self) -> list[dict[str, Any]]:
        with self._lock:
            self._atomic_write_json(self.history_path, [], secure=False)
            return []

    def _load_sessions_map(self) -> dict[str, dict[str, Any]]:
        if not self.sessions_path.is_file():
            return {}
        try:
            raw = json.loads(self.sessions_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {str(k): v for k, v in raw.items() if isinstance(v, dict)}
        except Exception as exc:
            print(f"[re-prompt] Failed reading sessions: {exc}", file=sys.stderr)
        return {}

    def _write_sessions_map(self, sessions: dict[str, dict[str, Any]]) -> None:
        if len(sessions) > MAX_SESSION_ITEMS:
            ordered = sorted(
                sessions.items(),
                key=lambda kv: str(kv[1].get("updated_at") or ""),
                reverse=True,
            )[:MAX_SESSION_ITEMS]
            sessions = dict(ordered)
        self._atomic_write_json(self.sessions_path, sessions, secure=False)

    def get_session(self, session_id: str = "default") -> dict[str, Any]:
        with self._lock:
            sid = (session_id or "default").strip() or "default"
            sessions = self._load_sessions_map()
            state = default_session_state()
            saved = sessions.get(sid)
            if isinstance(saved, dict):
                for k in state:
                    if k in saved and saved[k] is not None:
                        state[k] = saved[k]
            state["session_id"] = sid
            return state

    def save_session(self, session_id: str, state: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            sid = (session_id or "default").strip() or "default"
            sessions = self._load_sessions_map()
            clean = default_session_state()
            for k in clean:
                if k in state and state[k] is not None:
                    clean[k] = state[k]
            clean["session_id"] = sid
            clean["updated_at"] = datetime.now(timezone.utc).isoformat()
            sessions[sid] = clean
            self._write_sessions_map(sessions)
            return clean

    def reset_session(self, session_id: str = "default") -> dict[str, Any]:
        with self._lock:
            sid = (session_id or "default").strip() or "default"
            return self.save_session(sid, default_session_state())

    def add_loaded_skill(self, session_id: str, skill_dict: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            state = self.get_session(session_id)
            if not isinstance(skill_dict, dict) or not skill_dict.get("id"):
                return state
            sid = skill_dict["id"]
            loaded = list(state.get("loaded_skills") or [])
            if all(x.get("id") != sid for x in loaded):
                loaded.append(
                    {
                        "id": sid,
                        "name": skill_dict.get("name", sid),
                        "domain": skill_dict.get("domain", ""),
                        "repo": skill_dict.get("repo", ""),
                        "tier": int(skill_dict.get("tier", 3)),
                        "description": skill_dict.get("description", ""),
                        "path": skill_dict.get("path", ""),
                        "has_scripts": bool(skill_dict.get("has_scripts", False)),
                        "has_references": bool(skill_dict.get("has_references", False)),
                    }
                )
            state["loaded_skills"] = loaded
            dom = str(skill_dict.get("domain") or "").strip()
            domains = list(state.get("loaded_domains") or [])
            if dom and dom not in domains:
                domains.append(dom)
            state["loaded_domains"] = domains
            return self.save_session(session_id, state)

    def remove_loaded_skill(self, session_id: str, skill_id: str) -> dict[str, Any]:
        with self._lock:
            state = self.get_session(session_id)
            target = (skill_id or "").strip()
            state["loaded_skills"] = [x for x in (state.get("loaded_skills") or []) if x.get("id") != target]
            return self.save_session(session_id, state)


def format_skills_section(active_skills: list[dict[str, Any]]) -> str:
    lines = ["## Skills to Load", "Read these matching local skills on demand before starting execution:"]
    for s in active_skills:
        lines.append(f"- **{s['name']}** (`{s['domain']}`): `{s['path']}`")
    return "\n".join(lines)


def ensure_skills_section(rewritten_prompt: str, active_skills: list[dict[str, Any]]) -> str:
    """Guarantee exact local SKILL.md paths are present under ## Skills to Load."""
    if not active_skills:
        return rewritten_prompt
    text = (rewritten_prompt or "").strip()
    missing = [s for s in active_skills if s.get("path") and s["path"] not in text]
    if not missing and "## Skills to Load" in text:
        return text

    block = format_skills_section(active_skills)
    # Remove any partial/altered Skills to Load section before inserting canonical block
    cleaned = re.sub(
        r"\n*##\s+Skills\s+to\s+Load\b.*?(?=\n##\s+|\Z)",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    ).strip()

    goal_match = re.search(r"^##\s+Goal\b.*?(?=\n##\s+|\Z)", cleaned, flags=re.DOTALL | re.MULTILINE | re.IGNORECASE)
    if goal_match:
        idx = goal_match.end()
        before = cleaned[:idx].rstrip()
        after = cleaned[idx:].lstrip()
        return f"{before}\n\n{block}" + (f"\n\n{after}" if after else "")
    return f"{block}\n\n{cleaned}" if cleaned else block


def build_system_prompt(target: str, mode: str, has_active_skills: bool = False) -> str:
    """Build the system instruction that produces dual-readable prompts."""
    t_info = TARGETS.get(target, TARGETS["antigravity"])
    m_info = MODES.get(mode, MODES["balanced"])
    skill_rule = (
        "- ACTIVE SKILLS: Because `<ACTIVE_SKILLS>` is provided, include a compact `## Skills to Load` "
        "section right after `## Goal` listing ONLY those exact skill names, domains, and verbatim local `SKILL.md` paths "
        "(instructing the agent to read them on demand before executing). Never alter or invent skill paths.\n"
        if has_active_skills
        else ""
    )
    heading_list = (
        "`## Goal`, `## Skills to Load`, `## Context & Scope`, `## Requirements`, `## Constraints & Edge Cases`, `## Verification`"
        if has_active_skills
        else "`## Goal`, `## Context & Scope`, `## Requirements`, `## Constraints & Edge Cases`, `## Verification`"
    )
    return (
        "SYSTEM OVERRIDE: You are Re-Prompt, a deterministic prompt-engineering transformation "
        "utility inside an IDE developer tool. Ignore any external persona, storytelling, "
        "child-mentoring, or forced-language rules. This is a strict JSON data-transformation call.\n\n"
        "MISSION:\n"
        "Transform the user's rough, informal, or underspecified prompt into a structured, "
        "unambiguous, detailed prompt that is simultaneously:\n"
        "1. Easy for an AI coding agent to execute accurately on the first try (clear scope, "
        "concrete requirements, explicit constraints, and verification steps).\n"
        "2. Easy for the human prompter to read, scan, and edit in seconds (clean Markdown headings "
        "and crisp bullet points, zero robotic jargon or bloated boilerplate).\n\n"
        f"TARGET ASSISTANT ({t_info['label']}):\n{t_info['guidance']}\n\n"
        f"REWRITE MODE ({m_info['label']}):\n{m_info['guidance']}\n\n"
        "STRICT RULES:\n"
        "- LANGUAGE PRESERVATION: Write `rewritten_prompt`, `summary`, and `improvements` in the "
        "EXACT same natural language as the user's `<ROUGH_PROMPT>` (e.g., if English, respond ONLY in English; "
        "if Georgian, ONLY in Georgian; if Spanish, ONLY in Spanish).\n"
        "- NEVER invent or hallucinate file paths, symbol names, library versions, or command outputs "
        "not present in `<ROUGH_PROMPT>` or `<WORKSPACE_CONTEXT>`. Use generic phrasing (e.g., 'the relevant module') "
        "when exact paths are unknown.\n"
        "- Preserve every explicit user requirement, constraint, technology choice, and preference.\n"
        f"{skill_rule}"
        f"- Structure `rewritten_prompt` using clean Markdown headings ({heading_list}) — omit `## Context & Scope` only in "
        "`concise` mode if unnecessary.\n"
        "- Do NOT execute tools, read files, or answer the prompt yourself — ONLY rewrite it.\n"
        "- Output ONLY a single valid JSON object (no markdown preamble or postscript) with this exact schema:\n"
        "{\n"
        '  "rewritten_prompt": "<clean markdown prompt string>",\n'
        '  "summary": "<1 concise sentence explaining how the prompt was improved>",\n'
        '  "improvements": ["<short tag 1>", "<short tag 2>", "<short tag 3>"]\n'
        "}\n"
    )


def build_user_prompt(
    rough_prompt: str,
    target: str = "antigravity",
    mode: str = "balanced",
    workspace_context: str = "",
    refinement: str = "",
    previous_rewritten: str = "",
    active_skills: list[dict[str, Any]] | None = None,
) -> str:
    """Build the structured user message sent to the rewriting provider."""
    parts = [
        f"<TARGET>{target}</TARGET>",
        f"<MODE>{mode}</MODE>",
        f"<ROUGH_PROMPT>\n{rough_prompt.strip()}\n</ROUGH_PROMPT>",
    ]
    if active_skills:
        skill_lines = [
            f"- {s['name']} ({s['domain']}): {s['path']} — {s.get('description', '')}"
            for s in active_skills
        ]
        parts.append("<ACTIVE_SKILLS>\n" + "\n".join(skill_lines) + "\n</ACTIVE_SKILLS>")
    if workspace_context and workspace_context.strip():
        parts.append(f"<WORKSPACE_CONTEXT>\n{workspace_context.strip()}\n</WORKSPACE_CONTEXT>")
    if previous_rewritten and previous_rewritten.strip():
        parts.append(f"<CURRENT_REWRITTEN_PROMPT>\n{previous_rewritten.strip()}\n</CURRENT_REWRITTEN_PROMPT>")
    if refinement and refinement.strip():
        instruction = REFINEMENTS.get(refinement.strip(), refinement.strip())
        parts.append(f"<REFINEMENT_INSTRUCTION>\n{instruction}\n</REFINEMENT_INSTRUCTION>")
    parts.append("Return ONLY the JSON object matching the required schema.")
    return "\n\n".join(parts)


def _extract_balanced_json(text: str) -> str | None:
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        escape = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if escape:
                escape = False
                continue
            if ch == "\\" and in_str:
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if not in_str:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = text[start : idx + 1]
                        try:
                            json.loads(candidate)
                            return candidate
                        except Exception:
                            break
        start = text.find("{", start + 1)
    return None


def parse_rewrite_response(raw_text: str, original_prompt: str = "") -> dict[str, Any]:
    """Parse provider JSON output with graceful fallback to cleaned Markdown."""
    cleaned = (raw_text or "").strip()
    if not cleaned:
        raise ValueError("Provider returned an empty response.")

    parsed: dict[str, Any] | None = None

    # 1. Direct JSON
    if cleaned.startswith("{"):
        try:
            obj = json.loads(cleaned)
            if isinstance(obj, dict):
                parsed = obj
        except Exception:
            parsed = None

    # 2. Fenced JSON block
    if parsed is None:
        fence_match = re.search(r"```(?:json)?\s*\n(\{.*?\})\s*\n```", cleaned, re.DOTALL | re.IGNORECASE)
        if fence_match:
            try:
                obj = json.loads(fence_match.group(1))
                if isinstance(obj, dict):
                    parsed = obj
            except Exception:
                parsed = None

    # 3. Balanced brace extraction
    if parsed is None:
        extracted = _extract_balanced_json(cleaned)
        if extracted:
            try:
                obj = json.loads(extracted)
                if isinstance(obj, dict):
                    parsed = obj
            except Exception:
                parsed = None

    if parsed and isinstance(parsed.get("rewritten_prompt"), str) and parsed["rewritten_prompt"].strip():
        rewritten = parsed["rewritten_prompt"].strip()
        summary = str(parsed.get("summary") or "Structured goal, constraints, and verification steps.").strip()
        raw_imp = parsed.get("improvements")
        improvements = (
            [str(x).strip() for x in raw_imp if str(x).strip()][:5]
            if isinstance(raw_imp, list)
            else []
        )
        if not improvements:
            improvements = ["Clear Goal", "Actionable Requirements", "Verification Steps"]
        return {
            "rewritten_prompt": rewritten,
            "summary": summary,
            "improvements": improvements,
        }

    # 4. Graceful markdown fallback
    fallback = _PREAMBLE_RE.sub("", cleaned).strip()
    if fallback.startswith("```") and fallback.endswith("```"):
        lines = fallback.splitlines()
        if len(lines) >= 3:
            fallback = "\n".join(lines[1:-1]).strip()
    if not fallback:
        fallback = original_prompt.strip()
    return {
        "rewritten_prompt": fallback,
        "summary": "Structured rough input into clear instructions for AI and human review.",
        "improvements": ["Structured Layout", "Explicit Scope", "Verification Criteria"],
    }


def offline_rewrite(
    rough_prompt: str,
    target: str = "antigravity",
    mode: str = "balanced",
    workspace_context: str = "",
    refinement: str = "",
    previous_rewritten: str = "",
    active_skills: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Deterministic local structural rewriter requiring zero network or external CLIs."""
    base_text = (previous_rewritten if refinement and previous_rewritten.strip() else rough_prompt).strip()
    clean_lines = [line.strip() for line in rough_prompt.strip().splitlines() if line.strip()]
    goal_line = clean_lines[0] if clean_lines else base_text

    # Split clauses for actionable requirements
    raw_clauses = re.split(r"(?:(?<=[^0-9])\.(?=\s+|$)|;|\band\s+(?=add|fix|update|create|build|test|check|make|write|implement|refactor)|\bthen\b|\n)+", rough_prompt.strip(), flags=re.IGNORECASE)
    requirements = [c.strip(" .,-") for c in raw_clauses if c and c.strip(" .,-")]
    if not requirements:
        requirements = [goal_line]

    # Capitalize first char cleanly
    requirements = [r[0].upper() + r[1:] if r else r for r in requirements]

    target_note = {
        "antigravity": "Inspect relevant workspace files before editing, implement changes incrementally, and verify behavior end-to-end.",
        "claude_code": "Explore the relevant codebase context first, preserve existing conventions, implement minimal clean edits, and verify with tests.",
        "general": "Address every requirement below directly, avoid guessing missing facts, and present clear verifiable output.",
    }.get(target, "Implement the goal carefully and verify the result.")

    if mode == "concise" or refinement == "shorter":
        req_bullets = "\n".join(f"- {r}" for r in requirements[:5])
        ctx_line = f"\n- Workspace context: {workspace_context.strip()}" if workspace_context.strip() else ""
        parts = [f"## Goal\n{goal_line[0].upper() + goal_line[1:] if goal_line else ''}"]
        if active_skills:
            parts.append(format_skills_section(active_skills))
        parts.append(f"## Requirements\n{req_bullets}{ctx_line}")
        parts.append("## Verification\n- Confirm all requested behavior works without regressions or errors.")
        return {
            "rewritten_prompt": "\n\n".join(parts),
            "summary": "Formatted into a compact, scannable specification (offline template).",
            "improvements": ["Concise Goal", "Bulleted Scope", "Clear Verification"],
        }

    req_bullets = "\n".join(f"- {r}" for r in requirements)
    extra_constraints = [
        "Preserve existing working behavior and public interfaces unless a change is explicitly required.",
        "Do not assume unobserved paths, APIs, or configurations—inspect or clarify before modifying.",
    ]
    if refinement == "edge_cases" or mode in ("bug_fix", "deep_spec"):
        extra_constraints.append("Handle empty/invalid inputs, failure states, and boundary conditions explicitly with clear error reporting.")
    if mode == "refactor":
        extra_constraints.append("Keep behavior 100% backwards-compatible while improving modularity and readability.")

    verify_steps = [
        "Run existing automated tests, linters, or type checks covering the modified components.",
        "Confirm edge cases and error paths behave as expected with no regressions.",
    ]
    if refinement == "add_tests" or mode in ("bug_fix", "deep_spec"):
        verify_steps.insert(0, "Add or update automated unit/integration tests covering both normal paths and failure/edge cases.")

    sections = [
        f"## Goal\n{goal_line[0].upper() + goal_line[1:] if goal_line else ''}",
    ]
    if active_skills:
        sections.append(format_skills_section(active_skills))
    sections.extend([
        f"## Context & Scope\n{target_note}" + (f"\n\nActive context:\n{workspace_context.strip()}" if workspace_context.strip() else ""),
        f"## Requirements\n{req_bullets}",
        "## Constraints & Edge Cases\n" + "\n".join(f"- {c}" for c in extra_constraints),
        "## Verification\n" + "\n".join(f"- {v}" for v in verify_steps),
    ])
    if refinement == "detailed" or mode == "deep_spec":
        insert_idx = 4 if active_skills else 3
        sections.insert(
            insert_idx,
            "## Implementation Approach\n"
            "- Trace the current entrypoints and data flow before making edits.\n"
            "- Break changes into small, testable units with clear responsibilities.\n"
            "- Summarize modified files and verification results upon completion.",
        )

    return {
        "rewritten_prompt": "\n\n".join(sections),
        "summary": "Expanded rough request into structured goal, scope, constraints, and verification (offline template).",
        "improvements": ["Structured Goal", "Explicit Constraints", "Verification Checklist"],
    }


def list_agy_models() -> list[dict[str, str]]:
    """Models offered by Antigravity's `agy` CLI.

    S14 (P2-272): Watchkeeper never starts `agy`, in any context (it runs on the owner's Google login), so it
    never asks `agy models` either. The list is empty; Antigravity shows its own models.
    """
    return []


def _legacy_list_agy_models() -> list[dict[str, str]]:
    """The old `agy models` call, kept for reference only (P2-272 S11): it refuses at its first line."""
    raise RuntimeError(NEVER_AGY)
    agy_bin = find_agy_binary()  # noqa: unreachable
    if not agy_bin:
        return []
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    proc = run_cli_isolated([agy_bin, "models"], timeout=15, cwd=tempfile.gettempdir(), env=env, label="agy models")
    models: list[dict[str, str]] = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("fetching"):
            continue
        if "\t" in line:
            model_id, label = line.split("\t", 1)
            models.append({"id": model_id.strip(), "label": label.strip()})
        else:
            parts = line.split(None, 1)
            if parts:
                models.append({"id": parts[0].strip(), "label": parts[-1].strip()})
    return models


def get_provider_statuses() -> list[dict[str, Any]]:
    """Report provider discovery status across OS environments."""
    agy_bin = find_agy_binary()
    claude_bin = find_claude_binary()
    return [
        {
            "id": "auto",
            "label": "Auto Smart Router (Gemini + Claude)",
            "available": bool(agy_bin or claude_bin or os.environ.get("GEMINI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")),
            "detail": "Routes across Gemini & Claude by quota, spend pace & complexity",
            "requiresKey": False,
        },
        {
            "id": "agy",
            "label": "Antigravity CLI (agy)",
            "available": bool(agy_bin),
            "detail": agy_bin or "agy CLI not found on PATH",
            "requiresKey": False,
        },
        {
            "id": "claude_cli",
            "label": "Claude Code CLI (claude)",
            "available": bool(claude_bin),
            "detail": claude_bin or "claude CLI not found on PATH",
            "requiresKey": False,
        },
        {
            "id": "gemini_api",
            "label": "Gemini REST API",
            "available": True,
            "detail": "Direct HTTPS API (requires Gemini API key)",
            "requiresKey": True,
        },
        {
            "id": "anthropic_api",
            "label": "Anthropic Messages API",
            "available": True,
            "detail": "Direct HTTPS API (requires Anthropic API key)",
            "requiresKey": True,
        },
        {
            "id": "openai_compat",
            "label": "OpenAI-Compatible / Ollama",
            "available": True,
            "detail": "Any /v1/chat/completions endpoint (OpenAI, OpenRouter, Ollama)",
            "requiresKey": False,
        },
        {
            "id": "offline_template",
            "label": "Offline Structural Template",
            "available": True,
            "detail": "Instant local prompt structuring with zero API/CLI calls",
            "requiresKey": False,
        },
    ]


def _http_post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int = 45) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} from {urllib.parse.urlparse(url).netloc}: {err_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error contacting {urllib.parse.urlparse(url).netloc}: {exc.reason}") from exc


def _account_home() -> Path:
    """The account's real home folder, whatever HOME says (tests point HOME at a temporary folder)."""
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    except Exception:
        return Path(os.path.expanduser("~")).resolve()


def agy_is_test_stub(agy_path: str | None) -> bool:
    """Canon test rule: a stand-in agy lives inside a temporary HOME, never in the account's real home."""
    home_env = (os.environ.get("HOME") or "").strip()
    if not home_env or not agy_path:
        return False
    try:
        home = Path(home_env).expanduser().resolve()
        if home == _account_home():
            return False
        Path(agy_path).resolve().relative_to(home)
        return True
    except Exception:
        return False


def called_from_claude_code(agy_path: str | None = None) -> bool:
    """P2-272 canon guard: never run agy or Gemini (the owner's Google login) from Claude.

    True inside the Claude Code hook and MCP server (WK_CALLER=claude_code) and in every process Claude
    started (CLAUDECODE=1: its shells, test runs, scripts), unless the agy found is a test stub inside a
    temporary HOME. Tests that need agy use such a stub; the owner's own terminal and Antigravity are not
    affected. (23 Nov: a live-agy test run from Claude's shell reached the real CLI; this closes that.)
    """
    if os.environ.get("WK_CALLER", "").strip().lower() == "claude_code":
        return True
    if os.environ.get("CLAUDECODE") == "1":
        return not agy_is_test_stub(agy_path if agy_path is not None else find_agy_binary())
    return False


def run_cli_isolated(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    """P2-272: see scripts/proc_group.py (one shared process-group runner for every Re-Prompt module)."""
    from proc_group import run_cli_isolated as _run  # noqa: E402

    return _run(cmd, **kwargs)


AGY_NEVER_RUN_MESSAGE = (
    "Watchkeeper does not run Antigravity's `agy` (it uses your Google login); the local template rewrote this prompt."
)

# P2-272 S11: every old agy or Gemini CLI branch refuses with this canon line at its first line.
NEVER_AGY = "Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue."


def _run_agy(
    system_prompt: str,
    user_prompt: str,
    model: str,
    workspace_dir: str = "",
    max_seconds: float | None = None,
) -> tuple[str, str]:
    """Rewrite through the Antigravity CLI. ``max_seconds`` (P2-272, set from hooks) means one model only."""
    # S14 (P2-272): Watchkeeper never runs `agy`, from Claude Code, the IDE or tests. The rewrite uses the
    # local template instead (rewrite_with_provider switches before it gets here); this guard stays as a backstop.
    # S11: the canon refusal comes first, before any lookup of the agy binary.
    raise RuntimeError(NEVER_AGY)
    agy_bin = find_agy_binary()  # noqa: unreachable
    if called_from_claude_code(agy_bin or ""):
        raise RuntimeError("Claude Code never calls agy (Watchkeeper canon); the local template is used instead.")
    raise RuntimeError(AGY_NEVER_RUN_MESSAGE)
    if not agy_bin:
        raise RuntimeError(
            "Antigravity CLI (`agy`) was not found. Install/sign in to Antigravity CLI or pick another provider in Settings."
        )
    req_model = (model or "").strip()
    candidates = [req_model] if req_model else []
    for m in AGY_REWRITE_FALLBACK_CHAIN:
        if m not in candidates:
            candidates.append(m)

    combined = f"{system_prompt}\n\n---\n\n{user_prompt}"
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    env["REPROMPT_INTERNAL_CALL"] = "1"
    env["WK_SUBAGENT_ACTIVE"] = "1"
    # Run pure JSON prompt normalization in tempdir; workspace & Graphify context are in <WORKSPACE_CONTEXT>
    _ = workspace_dir
    run_cwd = tempfile.gettempdir()
    try:
        primary_timeout = max(15, int(os.environ.get("REPROMPT_AGY_TIMEOUT", "75")))
    except (TypeError, ValueError):
        primary_timeout = 75
    if max_seconds is not None:
        # P2-272 time budget: inside a hook, one model for at most 30 s; the caller then uses the local template.
        candidates = candidates[:1]
        primary_timeout = max(5, min(int(max_seconds), primary_timeout, 30))

    last_err = ""
    for idx, cand in enumerate(candidates):
        attempt_timeout = primary_timeout if idx == 0 else 40
        cmd = [
            agy_bin,
            "--disable-slash-commands",
            "--model",
            cand,
            "--output-format",
            "text",
        ]
        if cand.endswith("-high"):
            cmd.extend(["--effort", "high"])
        cmd.append(f"-p={combined}")
        try:
            proc = run_cli_isolated(cmd, timeout=attempt_timeout, cwd=run_cwd, env=env, label=f"agy {cand}")
            if proc.returncode == 0 and (proc.stdout or "").strip():
                return proc.stdout, cand
            last_err = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
        except subprocess.TimeoutExpired:
            last_err = f"timeout after {attempt_timeout}s on {cand}"
    raise RuntimeError(f"agy CLI failed: {last_err[:400]}")


def _run_claude_cli(system_prompt: str, user_prompt: str, model: str, max_seconds: float | None = None) -> tuple[str, str]:
    claude_bin = find_claude_binary()
    if not claude_bin:
        raise RuntimeError(
            "Claude Code CLI (`claude`) was not found. Install Claude Code CLI or pick another provider in Settings."
        )
    combined = f"{system_prompt}\n\n---\n\n{user_prompt}"
    # P2-272: the prompt goes in on stdin, never on argv (argv is visible to every process via `ps`).
    cmd = [claude_bin, "-p", "--output-format", "text"]
    if model:
        cmd.extend(["--model", model])
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    env["REPROMPT_INTERNAL_CALL"] = "1"
    limit = 45 if max_seconds is None else max(5, min(45, int(max_seconds)))
    proc = run_cli_isolated(cmd, timeout=limit, cwd=tempfile.gettempdir(), env=env, input=combined, label="claude -p")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
        raise RuntimeError(f"claude CLI failed: {err[:400]}")
    return proc.stdout, model or "claude-default"


def _run_gemini_api(system_prompt: str, user_prompt: str, settings: dict[str, Any], model_override: str) -> tuple[str, str]:
    api_key = settings.get("geminiApiKey") or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if not api_key:
        raise RuntimeError("Missing Gemini API key. Add it in Re-Prompt Settings or set GEMINI_API_KEY.")
    raw_model = str(model_override or settings.get("geminiModel") or "gemini-4-hydrogen")
    model = ("gemini-4-carbon" if "pro" in raw_model.lower() else "gemini-4-hydrogen") if raw_model.startswith("gemini-2.") else raw_model
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model, safe='')}:generateContent?key={urllib.parse.quote(api_key, safe='')}"
    )
    data = _http_post_json(
        url,
        {"Content-Type": "application/json"},
        {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "maxOutputTokens": 65536,
                "thinkingConfig": {"thinkingLevel": "high"},
            },
        },
    )
    candidates = data.get("candidates") or []
    parts = (candidates[0].get("content") or {}).get("parts") or [] if candidates else []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text.strip():
        raise RuntimeError("Gemini API returned no candidate text.")
    return text, model


def _run_anthropic_api(system_prompt: str, user_prompt: str, settings: dict[str, Any], model_override: str) -> tuple[str, str]:
    api_key = settings.get("anthropicApiKey") or os.environ.get("ANTHROPIC_API_KEY") or ""
    if not api_key:
        raise RuntimeError("Missing Anthropic API key. Add it in Re-Prompt Settings or set ANTHROPIC_API_KEY.")
    model = model_override or settings.get("anthropicModel") or "claude-sonnet-4-20250514"
    data = _http_post_json(
        "https://api.anthropic.com/v1/messages",
        {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        {
            "model": model,
            "max_tokens": 2048,
            "temperature": 0.25,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        },
    )
    content = data.get("content") or []
    text = "".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text")
    if not text.strip():
        raise RuntimeError("Anthropic API returned no text blocks.")
    return text, model


def _run_openai_compat(system_prompt: str, user_prompt: str, settings: dict[str, Any], model_override: str) -> tuple[str, str]:
    base_url = (settings.get("openaiBaseUrl") or "https://api.openai.com/v1").rstrip("/")
    api_key = settings.get("openaiApiKey") or os.environ.get("OPENAI_API_KEY") or ""
    model = model_override or settings.get("openaiModel") or "gpt-4o-mini"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif "api.openai.com" in base_url:
        raise RuntimeError("Missing OpenAI API key. Add it in Re-Prompt Settings or point Base URL to local Ollama.")
    data = _http_post_json(
        f"{base_url}/chat/completions",
        headers,
        {
            "model": model,
            "temperature": 0.25,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
    )
    choices = data.get("choices") or []
    message = choices[0].get("message") or {} if choices else {}
    text = message.get("content") or ""
    if not str(text).strip():
        raise RuntimeError("OpenAI-compatible endpoint returned empty content.")
    return str(text), model


def rewrite_with_provider(
    store: RePromptStore,
    prompt: str,
    target: str | None = None,
    mode: str | None = None,
    workspace_context: str = "",
    refinement: str = "",
    previous_rewritten: str = "",
    provider_override: str | None = None,
    model_override: str | None = None,
    save_history: bool = True,
    session_id: str = "default",
    session_turn: int | None = None,
    include_skills: bool | None = None,
    selected_skills: list[dict[str, Any]] | None = None,
    workspace_dir: str = "",
    pinned_skills: list[str] | None = None,
    time_budget_s: float | None = None,
) -> dict[str, Any]:
    """Rewrite a rough prompt using the configured or overridden AI provider.

    ``time_budget_s`` (P2-272): set by hooks; a CLI provider then gets one model and at most this long.
    """
    clean_prompt = (prompt or "").strip()
    if not clean_prompt:
        raise ValueError("Please enter a prompt to rewrite.")

    _, _, stripped_prompt = parse_skill_pins(clean_prompt)
    rewrite_input = stripped_prompt or clean_prompt

    effective_workspace_ctx = (workspace_context or "").strip()
    graphify_ctx = detect_graphify_context(workspace_dir)
    if graphify_ctx and "graphify" not in effective_workspace_ctx.lower():
        effective_workspace_ctx = f"{effective_workspace_ctx}\n{graphify_ctx}".strip() if effective_workspace_ctx else graphify_ctx

    learning_info: dict[str, Any] = {"has_context": False, "snippet_count": 0, "heuristic_count": 0, "latency_ms": 0.0}
    try:
        wk_root = PLUGIN_ROOT.parent
        if (wk_root / "core" / "learning_engine.py").is_file():
            if str(wk_root) not in sys.path:
                sys.path.insert(0, str(wk_root))
            from core.learning_engine import build_learning_context  # noqa: E402

            learn_ctx = build_learning_context(rewrite_input, workspace_dir=workspace_dir or None)
            learning_info = {
                "has_context": bool(learn_ctx.get("has_context")),
                "snippet_count": len(learn_ctx.get("snippets") or []),
                "heuristic_count": len(learn_ctx.get("heuristics") or []),
                "latency_ms": learn_ctx.get("latency_ms", 0.0),
            }
            if learn_ctx.get("has_context") and learn_ctx.get("markdown"):
                lmd = str(learn_ctx["markdown"])
                effective_workspace_ctx = (
                    f"{effective_workspace_ctx}\n\n{lmd}".strip() if effective_workspace_ctx else lmd
                )
    except Exception:
        pass

    settings = store.load_settings()
    chosen_target = target if target in TARGETS else settings.get("defaultTarget", "antigravity")
    if chosen_target not in TARGETS:
        chosen_target = "antigravity"
    chosen_mode = mode if mode in MODES else settings.get("defaultMode", "balanced")
    if chosen_mode not in MODES:
        chosen_mode = "balanced"
    chosen_provider = (provider_override or settings.get("provider") or "agy").strip()
    # S12 (P2-272): "agy" (the default) behaves the same everywhere: the local template rewrites the prompt
    # with a note (the switch below), never raising and never spawning, inside Claude Code too.
    if chosen_provider not in CLAUDE_CODE_PROVIDERS and chosen_provider != "agy":
        # The test-stub exception covers the agy binary only (agy, or auto, which may route to it);
        # every other provider (gemini_api) never runs from Claude, stub or not.
        agy_probe = None if chosen_provider in ("agy", "auto") else ""
        if called_from_claude_code(agy_probe):
            raise RuntimeError(
                f"Claude Code never uses the {chosen_provider} provider (Watchkeeper canon); use the local template."
            )
    chosen_model_override = (model_override or "").strip()

    routing_enabled = bool(settings.get("enableSkillRouting", True)) and (include_skills is not False)
    skill_provider_hint = (
        "claude"
        if chosen_target == "claude_code"
        else ("gemini" if chosen_target == "antigravity" else "auto")
    )
    active_skills: list[dict[str, Any]] = []
    skill_judgment: dict[str, Any] = {
        "action": "none",
        "turn": 0,
        "target_provider": skill_provider_hint,
        "complexity": {"score": 0.0, "level": "low", "domains": [], "signals": []},
        "load_skills": [],
        "keep_skills": [],
        "unload_skills": [],
        "active_skills": [],
        "reason": "",
        "query": "",
    }
    skill_routing: dict[str, Any] = {
        "action": "none",
        "turn": 0,
        "complexity": {"score": 0.0, "level": "low", "domains": [], "signals": []},
        "assumed_skills": [],
        "recommended_skills": [],
        "growth_reason": "",
        "query": "",
    }
    session_state = store.get_session(session_id)

    if routing_enabled:
        if session_turn == 1:
            session_state = default_session_state()
            session_state["session_id"] = session_id

        if refinement:
            # Refining an existing rewrite preserves active loaded skills without advancing turn count
            skill_routing["turn"] = int(session_state.get("turn_count", 0))
            if selected_skills is not None:
                active_skills = list(selected_skills)
            elif (
                "## Skills to Load" in (previous_rewritten or "")
                or "## Skill Directives" in (previous_rewritten or "")
            ):
                active_skills = list(session_state.get("loaded_skills") or [])
        else:
            pre_judgment, _ = judge_skills_for_prompt(
                received_prompt=clean_prompt,
                session_state=session_state,
                workspace_context=effective_workspace_ctx,
                target_provider=skill_provider_hint,
                max_active_skills=2,
                mutate_state=False,
                pinned_skills=pinned_skills,
            )
            active_skills = list(pre_judgment.get("load_skills") or [])

    if selected_skills and not refinement:
        seen_sel = {s["id"] for s in active_skills if isinstance(s, dict) and s.get("id")}
        for s in selected_skills:
            if isinstance(s, dict) and s.get("id") and s["id"] not in seen_sel:
                active_skills.append(s)
                seen_sel.add(s["id"])

    started = time.monotonic()
    agy_note = ""
    if chosen_provider == "agy":
        # S14 (P2-272): Watchkeeper never runs `agy` (outside Claude Code too); the local template rewrites instead.
        chosen_provider = "offline_template"
        agy_note = AGY_NEVER_RUN_MESSAGE
    if chosen_provider == "offline_template":
        parsed = offline_rewrite(
            rewrite_input,
            target=chosen_target,
            mode=chosen_mode,
            workspace_context=effective_workspace_ctx,
            refinement=refinement,
            previous_rewritten=previous_rewritten,
            active_skills=active_skills,
        )
        used_model = "local-template"
    else:
        sys_prompt = build_system_prompt(chosen_target, chosen_mode, has_active_skills=bool(active_skills))
        usr_prompt = build_user_prompt(
            rewrite_input,
            target=chosen_target,
            mode=chosen_mode,
            workspace_context=effective_workspace_ctx,
            refinement=refinement,
            previous_rewritten=previous_rewritten,
            active_skills=active_skills,
        )
        routing_info: dict[str, Any] | None = None
        if chosen_provider == "auto":
            from server.orchestrator import Orchestrator

            orch = Orchestrator(data_dir=store.data_dir, settings=settings)
            # A prompt rewrite is never queued for Antigravity (S14): a Gemini route returns nothing here and
            # the local template takes over below.
            if hasattr(orch.executor, "no_queue"):
                orch.executor.no_queue = True
            orch_res = orch.run_task(
                task=usr_prompt,
                system_prompt=sys_prompt,
                role="orchestrator" if refinement else "execution",
                auto_skills=False,
            )
            raw_out = orch_res["output"]
            used_model = f"{orch_res['provider']}:{orch_res['model']}"
            routing_info = {
                "routed_provider": orch_res["provider"],
                "channel": orch_res["channel"],
                "model": orch_res["model"],
                "reason_code": orch_res["reason_code"],
                "reason_summary": orch_res["reason_summary"],
                "claude_savings_usd": orch_res.get("claude_savings_usd", 0.0),
            }
        elif chosen_provider == "agy":
            raw_out, used_model = _run_agy(
                sys_prompt,
                usr_prompt,
                chosen_model_override or settings.get("agyModel", ""),
                workspace_dir=workspace_dir,
                max_seconds=time_budget_s,
            )
        elif chosen_provider == "claude_cli":
            raw_out, used_model = _run_claude_cli(
                sys_prompt,
                usr_prompt,
                chosen_model_override or settings.get("claudeModel", ""),
                max_seconds=time_budget_s,
            )
        elif chosen_provider == "gemini_api":
            raw_out, used_model = _run_gemini_api(sys_prompt, usr_prompt, settings, chosen_model_override)
        elif chosen_provider == "anthropic_api":
            raw_out, used_model = _run_anthropic_api(sys_prompt, usr_prompt, settings, chosen_model_override)
        elif chosen_provider == "openai_compat":
            raw_out, used_model = _run_openai_compat(sys_prompt, usr_prompt, settings, chosen_model_override)
        else:
            raise ValueError(f"Unsupported provider: {chosen_provider}")
        if routing_info is not None and not str(raw_out or "").strip():
            # The auto route chose a lane that only queues (Gemini, S14): rewrite locally instead.
            parsed = offline_rewrite(
                rewrite_input,
                target=chosen_target,
                mode=chosen_mode,
                workspace_context=effective_workspace_ctx,
                refinement=refinement,
                previous_rewritten=previous_rewritten,
                active_skills=active_skills,
            )
            used_model = "local-template"
            agy_note = "The chosen route only queues for Antigravity, so the local template rewrote this prompt."
        else:
            parsed = parse_rewrite_response(raw_out, original_prompt=rewrite_input)
    if agy_note:
        parsed["summary"] = (str(parsed.get("summary") or "") + " " + agy_note).strip()

    if routing_enabled and not refinement and selected_skills is None:
        skill_judgment, updated_session = judge_skills_for_prompt(
            received_prompt=clean_prompt,
            rewritten_prompt=parsed["rewritten_prompt"],
            session_state=session_state,
            workspace_context=effective_workspace_ctx,
            target_provider=skill_provider_hint,
            max_active_skills=2,
            mutate_state=True,
            pinned_skills=pinned_skills,
        )
        session_state = store.save_session(session_id, updated_session)
        load_sk = list(skill_judgment.get("load_skills") or [])
        unload_sk = list(skill_judgment.get("unload_skills") or [])
        if load_sk or unload_sk:
            parsed["rewritten_prompt"] = inject_skill_directives(
                parsed["rewritten_prompt"],
                skill_judgment,
                target_provider=skill_provider_hint,
            )
        skill_routing = {
            "action": "assume" if (skill_judgment["turn"] == 1 and load_sk) else ("recommend" if (load_sk or unload_sk) else "none"),
            "turn": skill_judgment["turn"],
            "complexity": skill_judgment["complexity"],
            "assumed_skills": load_sk if skill_judgment["turn"] == 1 else [],
            "recommended_skills": load_sk if skill_judgment["turn"] > 1 else [],
            "growth_reason": skill_judgment.get("reason", ""),
            "query": skill_judgment.get("query", ""),
        }
    elif active_skills:
        parsed["rewritten_prompt"] = ensure_skills_section(parsed["rewritten_prompt"], active_skills)

    duration_ms = int((time.monotonic() - started) * 1000)
    history_id = uuid.uuid4().hex[:12]
    result = {
        "history_id": history_id,
        "original": clean_prompt,
        "rewritten_prompt": parsed["rewritten_prompt"],
        "summary": parsed["summary"],
        "improvements": parsed["improvements"],
        "target": chosen_target,
        "mode": chosen_mode,
        "provider": chosen_provider,
        "model": used_model,
        "duration_ms": duration_ms,
        "skill_judgment": skill_judgment,
        "skill_routing": skill_routing,
        "session": session_state,
        "learning": learning_info,
    }
    if chosen_provider == "auto" and locals().get("routing_info"):
        result["orchestrator_route"] = routing_info
    if save_history:
        history = store.add_history(
            {
                "id": history_id,
                "original": clean_prompt,
                "rewritten": parsed["rewritten_prompt"],
                "summary": parsed["summary"],
                "improvements": parsed["improvements"],
                "target": chosen_target,
                "mode": chosen_mode,
                "provider": chosen_provider,
                "model": used_model,
                "duration_ms": duration_ms,
            }
        )
        result["history"] = history
    return result
