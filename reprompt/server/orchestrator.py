"""Quota, rate-limit, and spend-aware orchestrator routing tasks across Gemini and Claude."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
for p in (str(PLUGIN_ROOT), str(SCRIPTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from server.reprompt_engine import (  # noqa: E402
    _http_post_json,
    called_from_claude_code as _engine_called_from_claude_code,
    default_data_dir,
    find_agy_binary,
    find_claude_binary,
    find_executable,
)
from proc_group import run_cli_isolated  # noqa: E402  (P2-272: process-group cleanup)
from skill_router import (  # noqa: E402
    default_session_state,
    inject_skill_directives,
    judge_skills_for_prompt,
    score_complexity,
)

CLAUDE_ONLY_CAPABILITIES = frozenset(
    {
        "claude_code_hooks",
        "anthropic_prompt_cache",
        "claude_extended_thinking",
        "claude_plugin_exclusive",
    }
)

GEMINI_ONLY_CAPABILITIES = frozenset(
    {
        "gemini_1m_context",
        "multimodal_video",
        "google_search_grounding",
        "gemini_plugin_exclusive",
    }
)

RATE_LIMIT_PATTERNS = re.compile(
    r"(?:429|rate[_\s-]*limit|quota|resource[_\s-]*exhausted|too\s+many\s+requests|"
    r"overloaded|insufficient_quota|credit\s+balance|limit\s+reached)",
    re.IGNORECASE,
)

ORCHESTRATOR_VERBS_RE = re.compile(
    r"\b(?:summarize|summary|compress|condense|digest|triage|fan[- ]?out|"
    r"aggregate|merge\s+outputs|synthesize\s+logs|extract\s+context|chunk)\b",
    re.IGNORECASE,
)

HIGH_REASONING_RE = re.compile(
    r"\b(?:architect|architecture|concurrency|race\s+condition|deadlock|distributed|"
    r"security\s+audit|cryptograph|zero[- ]trust|kernel|compiler|prove|"
    r"root\s+cause|multi[- ]file\s+refactor|memory\s+leak|migration\s+plan)\b",
    re.IGNORECASE,
)

BULK_TOKEN_RE = re.compile(
    r"\b(?:logs?|transcript|corpus|entire\s+repo|codebase|dump|bundle|bulk|"
    r"hundreds|thousands|all\s+files|diff|changelog)\b",
    re.IGNORECASE,
)

DEFAULT_ORCHESTRATOR_CONFIG: dict[str, Any] = {
    "gemini": {
        "dailyBudgetUsd": 10.0,
        "dailyTokenLimit": 4_000_000,
        "rpmLimit": 30,
        "tpmLimit": 500_000,
        "fastModel": "gemini-3.8-flash-low",
        "strongModel": "gemini-4-neon-medium",
        "carbonHighModel": "gemini-4-carbon-high",
        "carbonFallbackModels": [
            "gemini-4-carbon-high",
            "gemini-4-argon-high",
            "gemini-4-neon-high",
        ],
        "apiFastModel": "gemini-4-hydrogen",
        "apiStrongModel": "gemini-4-carbon",
        "cliFastModel": "gemini-4-hydrogen",
        "cliStrongModel": "gemini-4-carbon",
        "preferredChannel": "auto",
    },
    "claude": {
        "dailyBudgetUsd": 10.0,
        "dailyTokenLimit": 800_000,
        "rpmLimit": 15,
        "tpmLimit": 120_000,
        "fastModel": "claude-sonnet-5-5-low",
        "strongModel": "claude-sonnet-5-5-high",
        "apiModel": "claude-sonnet-4-20250514",
        "cliModel": "",
        "preferredChannel": "auto",
    },
    "claudePreserveThreshold": 0.70,
    "spendPaceLeadThreshold": 0.15,
    "tokenOffloadThreshold": 3000,
    "orchestratorOffloadThreshold": 1500,
    "cooldownSeconds": 60,
}

# Approximate blended $/1M token rates for spend pacing & savings estimates
MODEL_PRICING_PER_1M: dict[str, tuple[float, float]] = {
    "gemini-3.8-flash-low": (0.10, 0.40),
    "gemini-3.8-flash-medium": (0.15, 0.60),
    "gemini-4-hydrogen": (0.15, 0.60),
    "gemini-4-hydrogen-high": (0.15, 0.60),
    "gemini-4-hydrogen-xhigh": (0.15, 0.60),
    "gemini-4-neon-medium": (1.25, 5.00),
    "gemini-4-neon-high": (1.25, 5.00),
    "gemini-4-argon-high": (1.75, 7.00),
    "gemini-4-carbon": (2.50, 10.00),
    "gemini-4-carbon-high": (2.50, 10.00),
    "claude-sonnet-5-5-low": (3.00, 15.00),
    "claude-sonnet-5-5-medium": (3.00, 15.00),
    "claude-sonnet-5-5-high": (3.00, 15.00),
    "claude-sonnet-4-20250514": (3.00, 15.00),
    "claude-opus-5-5-medium": (15.00, 75.00),
    "claude-default": (3.00, 15.00),
}

DEFAULT_PROVIDER_PRICING: dict[str, tuple[float, float]] = {
    "gemini": (0.15, 0.60),
    "claude": (3.00, 15.00),
}


def find_gemini_binary() -> str | None:
    """Locate the standalone Gemini CLI (`gemini`) across OS platforms."""
    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "gemini",
        home / ".npm-global" / "bin" / "gemini",
        Path("/usr/local/bin/gemini"),
        Path("/opt/homebrew/bin/gemini"),
    ]
    if os.name == "nt":
        app_data = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        candidates = [
            home / ".local" / "bin" / "gemini.exe",
            app_data / "npm" / "gemini.cmd",
            app_data / "npm" / "gemini.exe",
        ] + candidates
    return find_executable("gemini", candidates)


def _detect_ide_claude_extension() -> bool:
    home = Path.home()
    for ext_root in (
        home / ".antigravity-ide" / "extensions",
        home / ".vscode" / "extensions",
        home / ".cursor" / "extensions",
    ):
        if ext_root.is_dir():
            for child in ext_root.iterdir():
                if child.name.lower().startswith("anthropic.claude-code"):
                    return True
    return False


def detect_integrations(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """Detect available Gemini and Claude plugin/CLI/API integrations."""
    cfg = settings or {}
    agy_bin = find_agy_binary()
    gemini_bin = find_gemini_binary()
    claude_bin = find_claude_binary()

    gemini_key = bool(
        cfg.get("geminiApiKey")
        or os.environ.get("GEMINI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
    )
    anthropic_key = bool(
        cfg.get("anthropicApiKey")
        or os.environ.get("ANTHROPIC_API_KEY")
    )

    home = Path.home()
    has_gemini_plugins_dir = (home / ".gemini" / "config" / "plugins").is_dir()
    has_claude_plugins_dir = (home / ".claude" / "plugins").is_dir()
    has_claude_ide_ext = _detect_ide_claude_extension()

    gemini_channels: list[dict[str, Any]] = [
        {
            "id": "gemini_cli",
            "label": "Gemini CLI (gemini)",
            "available": bool(gemini_bin),
            # P2-272 4B (canon line 65): Watchkeeper never starts `gemini`; the channel stays listed and queues.
            "detail": QUEUE_DETAIL,
            "queues": True,
        },
        {
            "id": "agy_gemini",
            "label": "Antigravity queue (wk-task)",
            "available": bool(agy_bin),
            "detail": QUEUE_DETAIL if agy_bin else "Antigravity not found; nothing to queue for",
            "queues": True,
        },
        {
            "id": "gemini_api",
            "label": "Gemini REST API",
            "available": gemini_key,
            "detail": "API key configured" if gemini_key else "Set GEMINI_API_KEY or add key in Settings",
        },
    ]

    claude_channels: list[dict[str, Any]] = [
        {
            "id": "claude_cli",
            "label": "Claude Code CLI (claude)",
            "available": bool(claude_bin),
            "detail": claude_bin or "claude CLI not installed",
        },
        {
            "id": "agy_claude",
            "label": "Antigravity queue (wk-task)",
            "available": bool(agy_bin),
            "detail": QUEUE_DETAIL if agy_bin else "Antigravity not found; nothing to queue for",
            "queues": True,
        },
        {
            "id": "anthropic_api",
            "label": "Anthropic Messages API",
            "available": anthropic_key,
            "detail": "API key configured" if anthropic_key else "Set ANTHROPIC_API_KEY or add key in Settings",
        },
    ]

    gemini_ready = any(c["available"] for c in gemini_channels)
    claude_ready = any(c["available"] for c in claude_channels)
    gemini_primary = next((c["id"] for c in gemini_channels if c["available"]), None)
    claude_primary = next((c["id"] for c in claude_channels if c["available"]), None)

    if gemini_ready and claude_ready:
        overall = "dual_ready"
    elif gemini_ready or claude_ready:
        overall = "single_provider_fallback"
    else:
        overall = "unconfigured"

    return {
        "overall_status": overall,
        "gemini": {
            "available": gemini_ready,
            "primary_channel": gemini_primary,
            "channels": gemini_channels,
            "plugin_dir_detected": has_gemini_plugins_dir,
            "setup_hint": (
                f"Ready via {gemini_primary}."
                if gemini_ready
                else "Set GEMINI_API_KEY in Re-Prompt Settings, or install Antigravity: Gemini work is queued for it (Watchkeeper never runs `agy` or `gemini`)."
            ),
        },
        "claude": {
            "available": claude_ready,
            "primary_channel": claude_primary,
            "channels": claude_channels,
            "plugin_dir_detected": has_claude_plugins_dir,
            "ide_extension_detected": has_claude_ide_ext,
            "setup_hint": (
                f"Ready via {claude_primary}."
                if claude_ready
                else "Install the `claude` CLI, or set ANTHROPIC_API_KEY in Re-Prompt Settings."
            ),
        },
    }


def select_channel(
    provider: str,
    integration_info: dict[str, Any],
    preferred_channel: str = "auto",
) -> str | None:
    """Select the active execution channel for a provider."""
    channels = integration_info.get("channels") or []
    available_ids = [c["id"] for c in channels if c.get("available")]
    if not available_ids:
        return None
    if preferred_channel and preferred_channel != "auto" and preferred_channel in available_ids:
        return preferred_channel
    return available_ids[0]


def estimate_tokens(text: str) -> int:
    """Fast deterministic token estimator (~3.8 chars per token)."""
    cleaned = (text or "").strip()
    if not cleaned:
        return 0
    return max(1, math.ceil(len(cleaned) / 3.8))


def estimate_cost_usd(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate USD cost for a request."""
    in_rate, out_rate = MODEL_PRICING_PER_1M.get(
        model,
        DEFAULT_PROVIDER_PRICING.get(provider, (1.0, 3.0)),
    )
    cost = (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000.0
    return round(cost, 6)


def classify_task(
    task: str,
    context: str = "",
    role: str = "auto",
    required_capabilities: list[str] | None = None,
) -> dict[str, Any]:
    """Classify task complexity, token volume, orchestrator role, and capability guardrails."""
    clean_task = (task or "").strip()
    clean_ctx = (context or "").strip()
    in_tokens = estimate_tokens(clean_task) + estimate_tokens(clean_ctx)

    chosen_role = (role or "auto").strip().lower()
    if chosen_role not in ("auto", "execution", "orchestrator", "planning"):
        chosen_role = "execution"
    if chosen_role == "auto":
        if ORCHESTRATOR_VERBS_RE.search(clean_task):
            chosen_role = "orchestrator"
        elif re.search(r"\b(?:plan|roadmap|breakdown|decompose)\b", clean_task, re.IGNORECASE):
            chosen_role = "planning"
        else:
            chosen_role = "execution"

    if chosen_role == "orchestrator":
        out_tokens = max(220, min(1800, int(in_tokens * 0.25)))
    elif chosen_role == "planning":
        out_tokens = max(450, min(2200, int(in_tokens * 0.40)))
    else:
        out_tokens = max(350, min(2800, int(in_tokens * 0.45)))
    total_tokens = in_tokens + out_tokens

    comp = score_complexity(clean_task, workspace_context=clean_ctx[:2000])
    comp_score = float(comp["score"])
    if HIGH_REASONING_RE.search(clean_task):
        comp_score = max(comp_score + 20.0, 58.0)

    is_orchestrator_bulk = chosen_role == "orchestrator" or bool(ORCHESTRATOR_VERBS_RE.search(clean_task))
    if is_orchestrator_bulk and not HIGH_REASONING_RE.search(clean_task):
        comp_score = min(comp_score, 44.0)

    if comp_score >= 52.0:
        complexity_level = "high"
    elif comp_score >= 24.0:
        complexity_level = "medium"
    else:
        complexity_level = "low"

    if total_tokens >= 10_000 or in_tokens >= 8_000 or (BULK_TOKEN_RE.search(clean_task) and in_tokens >= 1_500):
        token_volume = "high"
    elif total_tokens >= 2_500:
        token_volume = "medium"
    else:
        token_volume = "low"

    caps = [str(c).strip() for c in (required_capabilities or []) if str(c).strip()]
    if in_tokens >= 180_000 and "gemini_1m_context" not in caps:
        caps.append("gemini_1m_context")

    requires_claude = bool(set(caps) & CLAUDE_ONLY_CAPABILITIES)
    requires_gemini = bool(set(caps) & GEMINI_ONLY_CAPABILITIES)

    return {
        "role": chosen_role,
        "complexity": complexity_level,
        "complexity_score": round(comp_score, 1),
        "domains": comp.get("domains", []),
        "token_volume": token_volume,
        "estimated_input_tokens": in_tokens,
        "estimated_output_tokens": out_tokens,
        "estimated_total_tokens": total_tokens,
        "required_capabilities": caps,
        "requires_claude": requires_claude,
        "requires_gemini": requires_gemini,
        "is_orchestrator_bulk": is_orchestrator_bulk,
    }


def _deep_merge_config(base: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    if not isinstance(updates, dict):
        return out
    for k, v in updates.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            for sub_k, sub_v in v.items():
                if sub_v is not None:
                    out[k][sub_k] = sub_v
        elif v is not None and k in out:
            out[k] = v
    return out


class UsageLedger:
    """Thread-safe atomic JSON ledger for Gemini & Claude rate-limits, tokens, and spend pacing."""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.ledger_path = self.data_dir / "orchestrator_usage.json"
        self._lock = threading.Lock()

    @staticmethod
    def _today_utc() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    @staticmethod
    def _empty_provider_usage() -> dict[str, Any]:
        return {
            "tokens_used": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "spend_usd": 0.0,
            "requests": 0,
            "rate_limit_hits": 0,
            "cooldown_until": 0.0,
            "cooldown_reason": "",
            "recent_window": [],
        }

    def _empty_state(self, config: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "date": self._today_utc(),
            "config": copy.deepcopy(config or DEFAULT_ORCHESTRATOR_CONFIG),
            "providers": {
                "gemini": self._empty_provider_usage(),
                "claude": self._empty_provider_usage(),
            },
            "claude_savings_usd": 0.0,
            "decisions": [],
            "sessions": {},
        }

    def _write_locked(self, data: dict[str, Any]) -> None:
        fd, tmp_name = tempfile.mkstemp(prefix=".orch_", dir=str(self.data_dir))
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            if os.name == "posix":
                os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self.ledger_path)
            if os.name == "posix":
                os.chmod(self.ledger_path, 0o600)
        except Exception:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            raise

    def _load_locked(self) -> dict[str, Any]:
        state = self._empty_state()
        if self.ledger_path.is_file():
            try:
                raw = json.loads(self.ledger_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    state["config"] = _deep_merge_config(DEFAULT_ORCHESTRATOR_CONFIG, raw.get("config") or {})
                    if raw.get("date") == self._today_utc():
                        for p in ("gemini", "claude"):
                            p_raw = (raw.get("providers") or {}).get(p)
                            if isinstance(p_raw, dict):
                                state["providers"][p].update(p_raw)
                        state["claude_savings_usd"] = float(raw.get("claude_savings_usd") or 0.0)
                        if isinstance(raw.get("decisions"), list):
                            state["decisions"] = raw["decisions"][:100]
                        if isinstance(raw.get("sessions"), dict):
                            state["sessions"] = dict(list(raw["sessions"].items())[-50:])
            except Exception as exc:
                print(f"[re-prompt-orch] Failed reading ledger: {exc}", file=sys.stderr)
        return state

    def load(self) -> dict[str, Any]:
        with self._lock:
            return self._load_locked()

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            state = self._load_locked()
            state["config"] = _deep_merge_config(state["config"], updates)
            self._write_locked(state)
            return copy.deepcopy(state["config"])

    def reset_usage(self) -> dict[str, Any]:
        with self._lock:
            state = self._load_locked()
            fresh = self._empty_state(config=state["config"])
            self._write_locked(fresh)
            return fresh

    def get_session(self, session_id: str = "default") -> dict[str, Any]:
        sid = (session_id or "default").strip() or "default"
        with self._lock:
            state = self._load_locked()
            sess = (state.get("sessions") or {}).get(sid)
            if isinstance(sess, dict):
                merged = default_session_state()
                merged.update(sess)
                return merged
            return default_session_state()

    def save_session(self, session_id: str, sess_state: dict[str, Any]) -> dict[str, Any]:
        sid = (session_id or "default").strip() or "default"
        with self._lock:
            state = self._load_locked()
            sessions = state.setdefault("sessions", {})
            sessions[sid] = copy.deepcopy(sess_state)
            if len(sessions) > 50:
                for old_key in list(sessions.keys())[:-50]:
                    sessions.pop(old_key, None)
            self._write_locked(state)
            return copy.deepcopy(sessions[sid])

    def get_provider_snapshot(
        self,
        state: dict[str, Any],
        provider: str,
        now: float | None = None,
    ) -> dict[str, Any]:
        ts = time.time() if now is None else float(now)
        cfg = (state.get("config") or {}).get(provider) or DEFAULT_ORCHESTRATOR_CONFIG[provider]
        u = (state.get("providers") or {}).get(provider) or self._empty_provider_usage()

        budget = max(0.01, float(cfg.get("dailyBudgetUsd", 10.0)))
        tok_limit = max(1, int(cfg.get("dailyTokenLimit", 1_000_000)))
        rpm_limit = max(1, int(cfg.get("rpmLimit", 20)))
        tpm_limit = max(1, int(cfg.get("tpmLimit", 100_000)))

        spend = float(u.get("spend_usd", 0.0))
        tokens = int(u.get("tokens_used", 0))
        spend_ratio = spend / budget
        token_ratio = tokens / tok_limit
        utilization = max(spend_ratio, token_ratio)
        headroom = max(0.0, 1.0 - utilization)

        window = [
            item
            for item in (u.get("recent_window") or [])
            if isinstance(item, dict) and ts - float(item.get("ts", 0.0)) < 60.0
        ]
        rpm_used = len(window)
        tpm_used = sum(int(item.get("tokens", 0)) for item in window)

        cooldown_until = float(u.get("cooldown_until", 0.0))
        in_cooldown = cooldown_until > ts
        cooldown_remaining_s = max(0, int(math.ceil(cooldown_until - ts))) if in_cooldown else 0

        is_saturated = (
            spend_ratio >= 1.0
            or token_ratio >= 1.0
            or rpm_used >= rpm_limit
            or tpm_used >= tpm_limit
        )

        return {
            "provider": provider,
            "spend_usd": round(spend, 6),
            "daily_budget_usd": budget,
            "remaining_budget_usd": round(max(0.0, budget - spend), 4),
            "tokens_used": tokens,
            "daily_token_limit": tok_limit,
            "remaining_tokens": max(0, tok_limit - tokens),
            "requests": int(u.get("requests", 0)),
            "rate_limit_hits": int(u.get("rate_limit_hits", 0)),
            "spend_ratio": round(spend_ratio, 4),
            "token_ratio": round(token_ratio, 4),
            "utilization": round(utilization, 4),
            "headroom": round(headroom, 4),
            "rpm_used": rpm_used,
            "rpm_limit": rpm_limit,
            "tpm_used": tpm_used,
            "tpm_limit": tpm_limit,
            "in_cooldown": in_cooldown,
            "cooldown_remaining_s": cooldown_remaining_s,
            "cooldown_reason": str(u.get("cooldown_reason") or "") if in_cooldown else "",
            "is_saturated": is_saturated,
        }

    def record_execution(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        decision_summary: dict[str, Any],
        now: float | None = None,
    ) -> dict[str, Any]:
        ts = time.time() if now is None else float(now)
        with self._lock:
            state = self._load_locked()
            p_usage = state["providers"][provider]
            total_tok = int(input_tokens) + int(output_tokens)
            cost = estimate_cost_usd(provider, model, int(input_tokens), int(output_tokens))

            p_usage["input_tokens"] = int(p_usage.get("input_tokens", 0)) + int(input_tokens)
            p_usage["output_tokens"] = int(p_usage.get("output_tokens", 0)) + int(output_tokens)
            p_usage["tokens_used"] = int(p_usage.get("tokens_used", 0)) + total_tok
            p_usage["spend_usd"] = round(float(p_usage.get("spend_usd", 0.0)) + cost, 6)
            p_usage["requests"] = int(p_usage.get("requests", 0)) + 1

            recent = [
                item
                for item in (p_usage.get("recent_window") or [])
                if isinstance(item, dict) and ts - float(item.get("ts", 0.0)) < 60.0
            ]
            recent.append({"ts": ts, "tokens": total_tok})
            p_usage["recent_window"] = recent[-200:]

            savings = float(decision_summary.get("claude_savings_usd") or 0.0)
            if provider == "gemini" and savings > 0:
                state["claude_savings_usd"] = round(float(state.get("claude_savings_usd", 0.0)) + savings, 6)

            log_entry = {
                "timestamp": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                "provider": provider,
                "channel": decision_summary.get("channel", ""),
                "model": model,
                "reason_code": decision_summary.get("reason_code", ""),
                "reason_summary": decision_summary.get("reason_summary", ""),
                "tokens": total_tok,
                "cost_usd": cost,
                "claude_savings_usd": savings,
            }
            state["decisions"] = ([log_entry] + (state.get("decisions") or []))[:100]
            self._write_locked(state)
            return state

    def record_rate_limit(self, provider: str, reason: str, now: float | None = None) -> dict[str, Any]:
        ts = time.time() if now is None else float(now)
        with self._lock:
            state = self._load_locked()
            cooldown_s = int((state.get("config") or {}).get("cooldownSeconds", 60))
            p_usage = state["providers"][provider]
            p_usage["rate_limit_hits"] = int(p_usage.get("rate_limit_hits", 0)) + 1
            p_usage["cooldown_until"] = ts + max(5, cooldown_s)
            p_usage["cooldown_reason"] = str(reason)[:240]
            self._write_locked(state)
            return state


def _pick_model_for(
    provider: str,
    channel: str | None,
    complexity: str,
    config: dict[str, Any],
    *,
    carbon_failover: bool = False,
) -> str:
    p_cfg = config.get(provider) or DEFAULT_ORCHESTRATOR_CONFIG[provider]
    if provider == "gemini":
        if channel == "gemini_api":
            return p_cfg.get("apiStrongModel" if (complexity == "high" or carbon_failover) else "apiFastModel", "gemini-4-hydrogen")
        if channel == "gemini_cli":
            return p_cfg.get("cliStrongModel" if (complexity == "high" or carbon_failover) else "cliFastModel", "gemini-4-hydrogen")
        if carbon_failover:
            return p_cfg.get("carbonHighModel", "gemini-4-carbon-high")
        return p_cfg.get("strongModel" if complexity == "high" else "fastModel", "gemini-3.8-flash-low")

    if channel == "anthropic_api":
        return p_cfg.get("apiModel", "claude-sonnet-4-20250514")
    if channel == "claude_cli":
        return p_cfg.get("cliModel", "") or "claude-default"
    return p_cfg.get("strongModel" if complexity == "high" else "fastModel", "claude-sonnet-5-5-low")


def _norm_watchkeeper_util(raw: Any) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if val < 0:
        return None
    return val / 100.0 if val > 1.0 else val


def watchkeeper_home() -> Path:
    return Path(os.environ.get("WK_HOME") or (Path.home() / ".wk")).expanduser()


def read_watchkeeper_pace() -> dict[str, Any] | None:
    """Read Watchkeeper's weekly/session plan meter (~/.wk/steward/meter.json) and KILL switch."""
    wk_dir = watchkeeper_home()
    kill_switch = (wk_dir / "KILL").exists()
    meter_path = wk_dir / "steward" / "meter.json"

    data: dict[str, Any] | None = None
    if meter_path.is_file():
        try:
            loaded = json.loads(meter_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            data = None

    if data is None and not kill_switch:
        return None

    seven_day = _norm_watchkeeper_util(data.get("utilization")) if data else None
    five_hour_obj = data.get("fiveHour") if isinstance(data, dict) and isinstance(data.get("fiveHour"), dict) else {}
    five_hour = _norm_watchkeeper_util(five_hour_obj.get("utilization"))
    status = str(data.get("status") or "").strip() if isinstance(data, dict) else ""
    five_status = str(five_hour_obj.get("status") or "").strip() if isinstance(five_hour_obj, dict) else ""
    claude_limit_exhausted = bool(
        status.lower() == "rejected"
        or five_status.lower() == "rejected"
        or (seven_day is not None and seven_day >= 0.98)
        or (five_hour is not None and five_hour >= 0.98)
    )
    available = bool(
        data is not None
        and status not in ("error", "unavailable")
        and (seven_day is not None or five_hour is not None or claude_limit_exhausted)
    )
    return {
        "available": available,
        "kill_switch": kill_switch,
        "status": status or None,
        "seven_day_utilization": seven_day,
        "five_hour_utilization": five_hour,
        "claude_limit_exhausted": claude_limit_exhausted,
        "fetched_at": data.get("fetchedAt") if isinstance(data, dict) else None,
        "resets_at": data.get("resetsAt") if isinstance(data, dict) else None,
        "source": data.get("source") if isinstance(data, dict) else None,
    }


def decide_route(
    task: str,
    context: str = "",
    role: str = "auto",
    required_capabilities: list[str] | None = None,
    override_provider: str | None = None,
    strict_override: bool = False,
    integrations: dict[str, Any] | None = None,
    ledger_state: dict[str, Any] | None = None,
    now: float | None = None,
    watchkeeper_pace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pure quota, spend-pacing, capability, and complexity router for Gemini & Claude."""
    ts = time.time() if now is None else float(now)
    integ = integrations or detect_integrations()
    state = ledger_state or {
        "config": copy.deepcopy(DEFAULT_ORCHESTRATOR_CONFIG),
        "providers": {
            "gemini": UsageLedger._empty_provider_usage(),
            "claude": UsageLedger._empty_provider_usage(),
        },
    }
    config = _deep_merge_config(DEFAULT_ORCHESTRATOR_CONFIG, state.get("config") or {})

    # Recompute snapshots using a transient UsageLedger-style helper without disk I/O
    tmp_ledger = object.__new__(UsageLedger)
    g_snap = tmp_ledger.get_provider_snapshot(state, "gemini", now=ts)
    c_snap = tmp_ledger.get_provider_snapshot(state, "claude", now=ts)

    watchkeeper_limit_exhausted = False
    if isinstance(watchkeeper_pace, dict) and watchkeeper_pace.get("available"):
        pace_vals = [
            float(v)
            for v in (
                watchkeeper_pace.get("seven_day_utilization"),
                watchkeeper_pace.get("five_hour_utilization"),
            )
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        ]
        if pace_vals:
            max_pace = max(pace_vals)
            if max_pace >= 0.75 and max_pace > float(c_snap.get("utilization", 0.0)):
                c_snap = dict(c_snap)
                c_snap["utilization"] = round(max_pace, 4)
                c_snap["watchkeeper_pace_applied"] = True
        if watchkeeper_pace.get("claude_limit_exhausted"):
            watchkeeper_limit_exhausted = True
            c_snap = dict(c_snap)
            c_snap["is_saturated"] = True
            c_snap["watchkeeper_limit_exhausted"] = True

    g_info = integ.get("gemini") or {}
    c_info = integ.get("claude") or {}
    g_channel = select_channel("gemini", g_info, config["gemini"].get("preferredChannel", "auto"))
    c_channel = select_channel("claude", c_info, config["claude"].get("preferredChannel", "auto"))
    # P2-272 open point 5: the words say where Gemini-lane work really goes. Only gemini_api outside Claude Code sends
    # the prompt to Gemini, with the owner's own key; every other channel, and gemini_api under Claude Code, queues a wk-task.
    g_direct = g_channel == "gemini_api" and not _called_from_claude_code()
    g_verb = "Sent" if g_direct else "Queued"
    g_where = "to Gemini with your own API key" if g_direct else "for Antigravity (wk-task)"

    g_healthy = bool(g_info.get("available")) and not g_snap["in_cooldown"] and not g_snap["is_saturated"]
    c_healthy = bool(c_info.get("available")) and not c_snap["in_cooldown"] and not c_snap["is_saturated"] and not watchkeeper_limit_exhausted

    cls = classify_task(task, context=context, role=role, required_capabilities=required_capabilities)
    in_tok = cls["estimated_input_tokens"]
    out_tok = cls["estimated_output_tokens"]
    tot_tok = cls["estimated_total_tokens"]

    def _build_decision(
        provider: str | None,
        reason_code: str,
        reason_summary: str,
        guardrail: str | None = None,
        override_applied: bool = False,
        error: str | None = None,
        carbon_failover: bool = False,
    ) -> dict[str, Any]:
        if provider is None:
            return {
                "provider": None,
                "channel": None,
                "model": None,
                "fallback_provider": None,
                "reason_code": reason_code,
                "reason_summary": reason_summary,
                "classification": cls,
                "estimated_tokens": tot_tok,
                "estimated_cost_usd": 0.0,
                "claude_savings_usd": 0.0,
                "guardrail": guardrail,
                "override_applied": override_applied,
                "snapshots": {"gemini": g_snap, "claude": c_snap},
                "error": error or reason_summary,
            }
        ch = g_channel if provider == "gemini" else c_channel
        use_carbon = provider == "gemini" and (
            carbon_failover
            or reason_code in ("fallback_rate_limited", "override_fallback", "watchkeeper_claude_limit_exhausted")
            or (not c_healthy and cls["complexity"] == "high")
        )
        model = _pick_model_for(provider, ch, cls["complexity"], config, carbon_failover=use_carbon)
        est_cost = estimate_cost_usd(provider, model, in_tok, out_tok)
        claude_ref_model = _pick_model_for("claude", c_channel, cls["complexity"], config)
        claude_ref_cost = estimate_cost_usd("claude", claude_ref_model, in_tok, out_tok)
        savings = round(max(0.0, claude_ref_cost - est_cost), 6) if provider == "gemini" else 0.0

        other = "claude" if provider == "gemini" else "gemini"
        other_healthy = c_healthy if other == "claude" else g_healthy
        fallback = other if (other_healthy and guardrail is None) else None

        return {
            "provider": provider,
            "channel": ch,
            "model": model,
            "effort": "high" if (use_carbon or model.endswith("-high")) else None,
            "carbon_high_failover": use_carbon,
            "fallback_provider": fallback,
            "reason_code": reason_code,
            "reason_summary": reason_summary,
            "classification": cls,
            "estimated_tokens": tot_tok,
            "estimated_cost_usd": est_cost,
            "claude_savings_usd": savings,
            "guardrail": guardrail,
            "override_applied": override_applied,
            "snapshots": {"gemini": g_snap, "claude": c_snap},
            "error": None,
        }

    # 1. Capability Guardrails
    if cls["requires_claude"] and cls["requires_gemini"]:
        return _build_decision(
            None,
            "guardrail_conflict",
            "Task specifies conflicting Gemini-only and Claude-only capabilities.",
            guardrail="conflict",
            error="Conflicting required capabilities for Gemini and Claude.",
        )

    if cls["requires_claude"]:
        if c_healthy:
            return _build_decision(
                "claude",
                "guardrail_claude_only",
                "Pinned to Claude due to required Claude-exclusive capability.",
                guardrail="claude_only",
            )
        return _build_decision(
            None,
            "guardrail_claude_unavailable",
            f"Claude-only capability required, but Claude is unavailable ({c_info.get('setup_hint') or 'quota/cooldown'}).",
            guardrail="claude_only",
            error=f"Task requires Claude-only capability ({', '.join(cls['required_capabilities'])}), and Claude is unavailable or saturated.",
        )

    if cls["requires_gemini"]:
        if g_healthy:
            return _build_decision(
                "gemini",
                "guardrail_gemini_only",
                "Pinned to Gemini due to Gemini-exclusive capability or >180k context size.",
                guardrail="gemini_only",
            )
        return _build_decision(
            None,
            "guardrail_gemini_unavailable",
            f"Gemini-only capability required, but Gemini is unavailable ({g_info.get('setup_hint') or 'quota/cooldown'}).",
            guardrail="gemini_only",
            error=f"Task requires Gemini-only capability ({', '.join(cls['required_capabilities'])}), and Gemini is unavailable or saturated.",
        )

    # 2. Explicit User Override
    if override_provider in ("gemini", "claude"):
        target_healthy = g_healthy if override_provider == "gemini" else c_healthy
        if target_healthy:
            return _build_decision(
                override_provider,
                "user_override",
                f"Routed to {override_provider.title()} per explicit user override.",
                override_applied=True,
            )
        if strict_override:
            hint = (g_info if override_provider == "gemini" else c_info).get("setup_hint", "")
            return _build_decision(
                None,
                "override_unavailable",
                f"Strict override to {override_provider.title()} failed: unavailable or rate-limited. {hint}",
                override_applied=True,
                error=f"{override_provider.title()} is unavailable, in cooldown, or saturated.",
            )
        other = "claude" if override_provider == "gemini" else "gemini"
        if (c_healthy if other == "claude" else g_healthy):
            return _build_decision(
                other,
                "override_fallback",
                f"Requested {override_provider.title()} is unavailable/rate-limited; automatically fell back to {other.title()}.",
                override_applied=True,
            )

    # 3. Availability & Rate-Limit Graceful Degradation
    if not g_healthy and not c_healthy:
        return _build_decision(
            None,
            "no_provider_available",
            f"Neither Gemini nor Claude is currently ready. Gemini: {g_info.get('setup_hint')} Claude: {c_info.get('setup_hint')}",
            error="No healthy provider available (unconfigured, in cooldown, or daily quota saturated).",
        )

    if g_healthy and not c_healthy:
        if watchkeeper_limit_exhausted:
            return _build_decision(
                "gemini",
                "fallback_rate_limited",
                "Claude Code limits exhausted (Watchkeeper meter); "
                + ("the task is sent to Gemini with your own API key." if g_direct else "the task is queued for Antigravity (wk-task), never run here."),
                carbon_failover=True,
            )
        reason = "fallback_rate_limited" if (c_snap["in_cooldown"] or c_snap["is_saturated"]) else "fallback_unavailable"
        return _build_decision(
            "gemini",
            reason,
            f"{g_verb} {g_where if g_direct else 'for Antigravity'} because Claude is {'in cooldown/quota cap' if reason == 'fallback_rate_limited' else 'not configured'}.",
            carbon_failover=(reason == "fallback_rate_limited"),
        )

    if c_healthy and not g_healthy:
        reason = "fallback_rate_limited" if (g_snap["in_cooldown"] or g_snap["is_saturated"]) else "fallback_unavailable"
        return _build_decision(
            "claude",
            reason,
            f"Routed to Claude because Gemini is {'in cooldown/quota cap' if reason == 'fallback_rate_limited' else 'not configured'}.",
        )

    # Both Gemini and Claude are healthy below!
    # 4. Orchestrator-Level Delegation (summarizing, compressing, fan-out, aggregation)
    orch_thresh = int(config.get("orchestratorOffloadThreshold", 1500))
    if cls["role"] in ("orchestrator", "planning") and (
        cls["complexity"] != "high" or (tot_tok >= orch_thresh and cls["is_orchestrator_bulk"])
    ):
        return _build_decision(
            "gemini",
            "orchestrator_token_offload",
            f"{g_verb} {cls['role']} subtask (~{tot_tok:,} tokens) {g_where} to preserve Claude capacity.",
        )

    # 5. Token-Heavy Easier Task Offload
    tok_thresh = int(config.get("tokenOffloadThreshold", 3000))
    if cls["complexity"] in ("low", "medium") and (cls["token_volume"] in ("medium", "high") or tot_tok >= tok_thresh):
        return _build_decision(
            "gemini",
            "token_heavy_offload",
            f"{g_verb} {cls['complexity']}-complexity, {cls['token_volume']}-token (~{tot_tok:,} tok) task {g_where} to save Claude limits.",
        )

    # 6. Claude Quota Preservation & Spend Pacing
    preserve_thresh = float(config.get("claudePreserveThreshold", 0.70))
    pace_lead = float(config.get("spendPaceLeadThreshold", 0.15))

    if c_snap["utilization"] >= preserve_thresh and cls["complexity"] != "high":
        return _build_decision(
            "gemini",
            "claude_quota_preservation",
            f"Claude utilization at {int(c_snap['utilization'] * 100)}% (>= {int(preserve_thresh * 100)}%); preserving Claude for complex tasks.",
        )

    if (c_snap["utilization"] - g_snap["utilization"]) > pace_lead and cls["complexity"] != "high":
        return _build_decision(
            "gemini",
            "spend_pacing_balance",
            f"Claude spend/quota pace ({int(c_snap['utilization'] * 100)}%) leads Gemini ({int(g_snap['utilization'] * 100)}%); {g_verb.lower()} {g_where} to balance spend.",
        )

    # 7. High-Complexity Reasoning -> Claude
    if cls["complexity"] == "high":
        return _build_decision(
            "claude",
            "high_complexity_claude",
            "Routed high-complexity reasoning/architecture task to Claude.",
        )

    # 8. Balanced Spend Pacing for remaining low/medium tasks
    if (g_snap["utilization"] - c_snap["utilization"]) > pace_lead:
        return _build_decision(
            "claude",
            "spend_pacing_balance",
            f"Gemini spend/quota pace ({int(g_snap['utilization'] * 100)}%) leads Claude ({int(c_snap['utilization'] * 100)}%); balancing to Claude.",
        )

    return _build_decision(
        "gemini",
        "cost_efficient_default",
        f"{g_verb} this routine task {g_where} to keep Claude limits in reserve.",
    )


class ProviderExecutionError(RuntimeError):
    """Raised when a provider invocation fails; flags rate-limit errors."""

    def __init__(self, message: str, rate_limited: bool = False) -> None:
        super().__init__(message)
        self.rate_limited = rate_limited or bool(RATE_LIMIT_PATTERNS.search(message or ""))


_ORIGINAL_SUBPROCESS_RUN = subprocess.run


def _called_from_claude_code(agy_path: str | None = None) -> bool:
    """P2-272 canon guard, one rule in one place: delegates to reprompt_engine.called_from_claude_code.

    Passes the agy path this module is about to run (found through this module's find_agy_binary, so a
    test that patches it is honoured); only a stub inside a temporary HOME passes when CLAUDECODE=1.
    """
    return _engine_called_from_claude_code(agy_path if agy_path is not None else find_agy_binary())


def _run_provider_cli(cmd: list[str], *, timeout: float, cwd: str, env: dict[str, str], label: str) -> subprocess.CompletedProcess:
    """Run a provider CLI in its own process group (P2-272), so a timeout never leaves orphans.

    When a test double replaces ``subprocess.run`` it is honoured, so existing mocks keep intercepting the call
    and no real CLI is started from a test.
    """
    if subprocess.run is not _ORIGINAL_SUBPROCESS_RUN:
        return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return run_cli_isolated(cmd, timeout=timeout, cwd=cwd, env=env, label=label, kind="orchestrator")


QUEUE_DETAIL = "Not run by Watchkeeper; queued for Antigravity"
QUEUE_CHANNELS = frozenset({"agy_gemini", "agy_claude", "gemini_cli"})
# P2-272 S11: the old agy and gemini_cli branches below the queue refuse with this canon line at their first line.
NEVER_AGY = "Watchkeeper never runs agy or Gemini (canon); the task goes to the wk-task queue."
QUEUE_TITLE_MAX = 120
QUEUE_TEXT_MAX = 20000


def _find_node() -> str:
    import shutil

    for cand in (os.environ.get("WK_NODE"), shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "node"


def _git_root(folder: str) -> str | None:
    if not folder or not os.path.isdir(folder):
        return None
    try:
        proc = subprocess.run(
            ["git", "-C", folder, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    root = (proc.stdout or "").strip()
    return root if proc.returncode == 0 and root else None


def queue_for_antigravity(prompt: str, workspace: str | None = None, source: str | None = None) -> dict[str, Any]:
    """P2-272 4B (canon line 65): the Gemini lanes only queue a wk-task; nothing here runs agy or gemini.

    Runs ``node bin/wk-task.mjs add --repo <git root> --title <first line> --text <prompt> --allow ** --from <source>``.
    Returns {"text", "queued_task"} on success, or {"text", "queued_task": None} with a plain reason.
    """
    folder = str(workspace or os.environ.get("WK_WORKSPACE") or os.getcwd())
    root = _git_root(folder)
    if not root:
        return {"text": f"Not queued: {folder} is not a git repository, so Antigravity has nothing to take. Nothing was run.", "queued_task": None}
    lines = [ln.strip() for ln in str(prompt or "").splitlines() if ln.strip()]
    title = (lines[0] if lines else "Re-Prompt task")
    if len(title) > QUEUE_TITLE_MAX:
        title = title[: QUEUE_TITLE_MAX - 1].rstrip() + "\u2026"
    text = str(prompt or "").strip()[:QUEUE_TEXT_MAX] or title
    # --from names the real caller: Claude Code sets CLAUDECODE=1 (or the hook sets WK_CALLER=claude_code);
    # everything else here acts for the owner. The agy stub exception plays no part in this.
    caller_is_claude = os.environ.get("CLAUDECODE") == "1" or os.environ.get("WK_CALLER", "").strip().lower() == "claude_code"
    src = source if source in ("claude", "owner", "gemini") else ("claude" if caller_is_claude else "owner")
    wk_task = PLUGIN_ROOT.parent / "bin" / "wk-task.mjs"
    if not wk_task.is_file():
        return {"text": "Not queued: bin/wk-task.mjs was not found. Nothing was run.", "queued_task": None}
    cmd = [_find_node(), str(wk_task), "add", "--repo", root, "--title", title, "--text", text, "--allow", "**", "--from", src]
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    proc = _run_provider_cli(cmd, cwd=str(PLUGIN_ROOT.parent), env=env, timeout=30, label="wk-task add")
    out = (proc.stdout or "").strip().splitlines()
    task_id = out[-1].strip() if out else ""
    if proc.returncode != 0 or not re.match(r"^[A-Za-z0-9._-]{1,80}$", task_id):
        msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip().splitlines()
        return {"text": f"Not queued: wk-task said {(msg[-1] if msg else 'nothing')[:300]}. Nothing was run.", "queued_task": None}
    return {
        "text": f"Queued for Antigravity as task {task_id}. Antigravity takes it when you run /wk-take-task there.",
        "queued_task": task_id,
    }


class DefaultProviderExecutor:
    """Adapter executing prompts against Gemini/Claude CLIs, Antigravity `agy`, or HTTPS APIs."""

    def __init__(self, settings: dict[str, Any] | None = None) -> None:
        self.settings = settings or {}
        self.workspace: str | None = None
        # Internal steps (context compression, aggregation) set this so they never queue a junk task.
        self.no_queue = False

    def __call__(
        self,
        provider: str,
        channel: str,
        model: str,
        prompt: str,
        system_prompt: str = "",
    ) -> dict[str, Any]:
        full_prompt = f"{system_prompt.strip()}\n\n---\n\n{prompt.strip()}" if system_prompt.strip() else prompt.strip()
        env = dict(os.environ)
        env["NO_COLOR"] = "1"
        env["REPROMPT_INTERNAL_CALL"] = "1"

        if channel in QUEUE_CHANNELS:
            # P2-272 4B: agy_gemini, agy_claude and gemini_cli only queue a wk-task for Antigravity, in every context.
            if self.no_queue:
                return {"text": "", "queue_skipped": True}
            return queue_for_antigravity(
                prompt.strip() or full_prompt,
                self.workspace or self.settings.get("workspace"),
            )

        if channel == "gemini_api" and _called_from_claude_code():
            # P2-272 open point 5: like the JS orchestrators (S10), under Claude Code the owner's Gemini key is never used;
            # the prompt is queued for Antigravity, as the routing words say. Nothing is sent to Gemini.
            if self.no_queue:
                return {"text": "", "queue_skipped": True}
            return queue_for_antigravity(
                prompt.strip() or full_prompt,
                self.workspace or self.settings.get("workspace"),
            )

        if _called_from_claude_code() and (channel in ("agy_gemini", "agy_claude", "gemini_cli", "gemini_api") or provider == "gemini"):
            # P2-272 canon: a Claude Code-hosted process never calls agy and never sends prompts to Gemini.
            raise ProviderExecutionError(
                f"Claude Code never calls {channel} (Watchkeeper canon); pick a Claude channel instead."
            )

        if channel == "agy_gemini" or channel == "agy_claude":
            raise ProviderExecutionError(NEVER_AGY)
            agy_bin = find_agy_binary()  # noqa: unreachable (kept for reference)
            if not agy_bin:
                raise ProviderExecutionError("`agy` binary not found.")
            headless_settings = json.dumps(
                {"permissions": {"allow": ["mcp(watchkeeper_re-prompt/*)"]}},
                separators=(",", ":"),
            )
            model_chain = [model]
            if channel == "agy_gemini" and model == "gemini-4-carbon-high":
                model_chain = ["gemini-4-carbon-high", "gemini-4-argon-high", "gemini-4-neon-high"]
            last_msg = ""
            for idx, m_try in enumerate(model_chain):
                cmd = [agy_bin, "--disable-slash-commands", "--model", m_try]
                if m_try.endswith("-high"):
                    cmd.extend(["--effort", "high"])
                cmd.extend(["--settings", headless_settings, "--output-format", "text", f"-p={full_prompt}"])
                proc = _run_provider_cli(
                    cmd,
                    cwd=tempfile.gettempdir(),
                    env=env,
                    timeout=90 if m_try.endswith("-high") else 60,
                    label=f"agy {m_try}",
                )
                if proc.returncode == 0:
                    out_txt = (proc.stdout or "").strip()
                    err_txt = (proc.stderr or "").strip()
                    if not out_txt and re.search(r"no output produced.*permission|auto-denied", err_txt, re.IGNORECASE):
                        raise ProviderExecutionError(f"agy ({m_try}) produced no output: {err_txt[:300]}")
                    return {"text": out_txt, "model": m_try}
                last_msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
                if idx + 1 < len(model_chain) and re.search(
                    r"(?:model.*not\s+(?:found|available|supported)|invalid\s+model|entitlement|not\s+entitled)",
                    last_msg,
                    re.IGNORECASE,
                ):
                    continue
                raise ProviderExecutionError(f"agy ({m_try}) failed: {last_msg[:400]}")
            raise ProviderExecutionError(f"agy ({model}) failed: {last_msg[:400]}")

        if channel == "gemini_cli":
            raise ProviderExecutionError(NEVER_AGY)
            gem_bin = find_gemini_binary()  # noqa: unreachable (kept for reference)
            if not gem_bin:
                raise ProviderExecutionError("`gemini` CLI binary not found.")
            cmd = [gem_bin, "-p", full_prompt]
            if model:
                cmd.extend(["-m", model])
            proc = _run_provider_cli(cmd, cwd=tempfile.gettempdir(), env=env, timeout=60, label="gemini cli")
            if proc.returncode != 0:
                msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
                raise ProviderExecutionError(f"gemini CLI failed: {msg[:400]}")
            return {"text": proc.stdout.strip()}

        if channel == "claude_cli":
            claude_bin = find_claude_binary()
            if not claude_bin:
                raise ProviderExecutionError("`claude` CLI binary not found.")
            cmd = [claude_bin, "-p", full_prompt, "--output-format", "text"]
            if model and model != "claude-default":
                cmd.extend(["--model", model])
            proc = _run_provider_cli(cmd, cwd=tempfile.gettempdir(), env=env, timeout=60, label="claude cli")
            if proc.returncode != 0:
                msg = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
                raise ProviderExecutionError(f"claude CLI failed: {msg[:400]}")
            return {"text": proc.stdout.strip()}

        if channel == "gemini_api":
            api_key = (
                self.settings.get("geminiApiKey")
                or os.environ.get("GEMINI_API_KEY")
                or os.environ.get("GOOGLE_API_KEY")
                or ""
            )
            if not api_key:
                raise ProviderExecutionError("Missing GEMINI_API_KEY.")
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{urllib.parse.quote(model, safe='')}:generateContent?key={urllib.parse.quote(api_key, safe='')}"
            )
            body: dict[str, Any] = {
                "contents": [{"role": "user", "parts": [{"text": prompt.strip()}]}],
                "generationConfig": {
                    "maxOutputTokens": 65536,
                    "thinkingConfig": {"thinkingLevel": "high"},
                },
            }
            if system_prompt.strip():
                body["systemInstruction"] = {"parts": [{"text": system_prompt.strip()}]}
            try:
                data = _http_post_json(url, {"Content-Type": "application/json"}, body, timeout=60)
            except Exception as exc:
                raise ProviderExecutionError(str(exc)) from exc
            parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
            return {"text": text}

        if channel == "anthropic_api":
            api_key = self.settings.get("anthropicApiKey") or os.environ.get("ANTHROPIC_API_KEY") or ""
            if not api_key:
                raise ProviderExecutionError("Missing ANTHROPIC_API_KEY.")
            body = {
                "model": model,
                "max_tokens": 2048,
                "temperature": 0.25,
                "messages": [{"role": "user", "content": prompt.strip()}],
            }
            if system_prompt.strip():
                body["system"] = system_prompt.strip()
            try:
                data = _http_post_json(
                    "https://api.anthropic.com/v1/messages",
                    {
                        "Content-Type": "application/json",
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    body,
                    timeout=60,
                )
            except Exception as exc:
                raise ProviderExecutionError(str(exc)) from exc
            content = data.get("content") or []
            text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
            return {"text": text}

        raise ProviderExecutionError(f"Unsupported channel: {channel}")


class Orchestrator:
    """Single-entrypoint Gemini + Claude orchestrator coordinating routing, fallbacks, and workflows."""

    def __init__(
        self,
        data_dir: str | Path | None = None,
        settings: dict[str, Any] | None = None,
        executor: Callable[..., dict[str, Any]] | None = None,
        integrations: dict[str, Any] | None = None,
    ) -> None:
        self.ledger = UsageLedger(data_dir)
        self.settings = settings or {}
        self.executor = executor or DefaultProviderExecutor(self.settings)
        self._fixed_integrations = integrations

    def get_integrations(self) -> dict[str, Any]:
        return copy.deepcopy(self._fixed_integrations) if self._fixed_integrations is not None else detect_integrations(self.settings)

    def status(self, now: float | None = None) -> dict[str, Any]:
        ts = time.time() if now is None else float(now)
        state = self.ledger.load()
        integ = self.get_integrations()
        res = {
            "date": state["date"],
            "overall_status": integ["overall_status"],
            "integrations": integ,
            "config": state["config"],
            "usage": {
                "gemini": self.ledger.get_provider_snapshot(state, "gemini", now=ts),
                "claude": self.ledger.get_provider_snapshot(state, "claude", now=ts),
            },
            "claude_savings_usd": round(float(state.get("claude_savings_usd", 0.0)), 6),
            "recent_decisions": list(state.get("decisions") or [])[:15],
        }
        if self._fixed_integrations is None or os.environ.get("WK_HOME"):
            res["watchkeeper_pace"] = read_watchkeeper_pace()
        return res

    def preview_route(
        self,
        task: str,
        context: str = "",
        role: str = "auto",
        required_capabilities: list[str] | None = None,
        override_provider: str | None = None,
        strict_override: bool = False,
        now: float | None = None,
        auto_skills: bool = True,
        session_id: str = "default",
        pinned_skills: list[str] | None = None,
    ) -> dict[str, Any]:
        state = self.ledger.load()
        integ = self.get_integrations()
        pace = read_watchkeeper_pace() if (self._fixed_integrations is None or os.environ.get("WK_HOME")) else None
        dec = decide_route(
            task=task,
            context=context,
            role=role,
            required_capabilities=required_capabilities,
            override_provider=override_provider,
            strict_override=strict_override,
            integrations=integ,
            ledger_state=state,
            now=now,
            watchkeeper_pace=pace,
        )
        if pace is not None:
            dec["watchkeeper_pace"] = pace
            if pace.get("kill_switch"):
                dec["watchkeeper_kill_switch"] = True
        if auto_skills and dec.get("provider"):
            sess = self.ledger.get_session(session_id)
            judgment, _ = judge_skills_for_prompt(
                received_prompt=task,
                session_state=sess,
                workspace_context=context,
                target_provider=dec["provider"],
                max_active_skills=2,
                mutate_state=False,
                pinned_skills=pinned_skills,
                agent_role=role,
            )
            dec["skill_judgment"] = judgment
        return dec

    def run_task(
        self,
        task: str,
        context: str = "",
        system_prompt: str = "",
        role: str = "auto",
        required_capabilities: list[str] | None = None,
        override_provider: str | None = None,
        strict_override: bool = False,
        now: float | None = None,
        auto_skills: bool = True,
        session_id: str = "default",
        pinned_skills: list[str] | None = None,
    ) -> dict[str, Any]:
        ts = time.time() if now is None else float(now)
        decision = self.preview_route(
            task=task,
            context=context,
            role=role,
            required_capabilities=required_capabilities,
            override_provider=override_provider,
            strict_override=strict_override,
            now=ts,
            auto_skills=False,
            pinned_skills=pinned_skills,
        )
        if decision.get("watchkeeper_kill_switch"):
            raise ProviderExecutionError("Watchkeeper kill switch (~/.wk/KILL) is active.")
        if not decision.get("provider"):
            raise ProviderExecutionError(decision.get("error") or decision.get("reason_summary") or "No provider available.")

        provider = decision["provider"]
        channel = decision["channel"]
        model = decision["model"]
        fallback_from = None
        fallback_reason = None

        skill_judgment: dict[str, Any] | None = None
        task_with_skills = task.strip()
        if auto_skills and role != "orchestrator":
            sess = self.ledger.get_session(session_id)
            skill_judgment, updated_sess = judge_skills_for_prompt(
                received_prompt=task_with_skills,
                session_state=sess,
                workspace_context=context,
                target_provider=provider,
                max_active_skills=2,
                mutate_state=True,
                pinned_skills=pinned_skills,
                agent_role=role,
            )
            self.ledger.save_session(session_id, updated_sess)
            if skill_judgment.get("load_skills") or skill_judgment.get("unload_skills"):
                task_with_skills = inject_skill_directives(
                    task_with_skills,
                    skill_judgment,
                    target_provider=provider,
                )

        full_prompt = f"{task_with_skills}\n\nContext:\n{context.strip()}" if context.strip() else task_with_skills
        in_tok = decision["classification"]["estimated_input_tokens"]

        started = time.monotonic()
        try:
            exec_res = self.executor(
                provider=provider,
                channel=channel,
                model=model,
                prompt=full_prompt,
                system_prompt=system_prompt,
            )
        except Exception as exc:
            err_msg = str(exc)
            is_rl = getattr(exc, "rate_limited", False) or bool(RATE_LIMIT_PATTERNS.search(err_msg))
            self.ledger.record_rate_limit(provider, err_msg, now=ts)

            fb_provider = decision.get("fallback_provider")
            if not fb_provider or strict_override or decision.get("guardrail") is not None:
                raise ProviderExecutionError(
                    f"{provider.title()} failed ({err_msg}) and no fallback is permitted/available.",
                    rate_limited=is_rl,
                ) from exc

            # Recompute route with updated cooldown state to select the healthy fallback cleanly
            fb_decision = self.preview_route(
                task=task,
                context=context,
                role=role,
                required_capabilities=required_capabilities,
                override_provider=fb_provider,
                strict_override=True,
                now=ts,
            )
            if not fb_decision.get("provider"):
                raise ProviderExecutionError(
                    f"{provider.title()} failed ({err_msg}) and fallback {fb_provider.title()} is unavailable.",
                    rate_limited=is_rl,
                ) from exc

            fallback_from = provider
            fallback_reason = err_msg
            provider = fb_decision["provider"]
            channel = fb_decision["channel"]
            g_cfg = (self.ledger.load().get("config") or {}).get("gemini") or {}
            if provider == "gemini" and channel == "agy_gemini":
                model = g_cfg.get("carbonHighModel", "gemini-4-carbon-high")
            else:
                model = fb_decision["model"]
            decision = fb_decision
            decision["model"] = model
            decision["carbon_high_failover"] = bool(provider == "gemini" and model == g_cfg.get("carbonHighModel", "gemini-4-carbon-high"))
            decision["reason_code"] = "fallback_after_error"
            decision["reason_summary"] = (
                f"{fallback_from.title()} failed ({'rate limit' if is_rl else 'error'}); "
                f"automatically fell back to {provider.title()} ({model})."
            )
            exec_res = self.executor(
                provider=provider,
                channel=channel,
                model=model,
                prompt=full_prompt,
                system_prompt=system_prompt,
            )

        if isinstance(exec_res, dict) and exec_res.get("model"):
            model = str(exec_res["model"])

        out_text = str((exec_res or {}).get("text") or "").strip()
        actual_in = int((exec_res or {}).get("input_tokens") or in_tok)
        actual_out = int((exec_res or {}).get("output_tokens") or estimate_tokens(out_text))

        self.ledger.record_execution(
            provider=provider,
            model=model,
            input_tokens=actual_in,
            output_tokens=actual_out,
            decision_summary=decision,
            now=ts,
        )

        res_payload = {
            "output": out_text,
            "provider": provider,
            "channel": channel,
            "model": model,
            "reason_code": decision["reason_code"],
            "reason_summary": decision["reason_summary"],
            "fallback_from": fallback_from,
            "fallback_reason": fallback_reason,
            "classification": decision["classification"],
            "tokens": {"input": actual_in, "output": actual_out, "total": actual_in + actual_out},
            "cost_usd": estimate_cost_usd(provider, model, actual_in, actual_out),
            "claude_savings_usd": decision["claude_savings_usd"],
            "duration_ms": int((time.monotonic() - started) * 1000),
            "status": self.status(now=ts),
        }
        if isinstance(exec_res, dict) and exec_res.get("queued_task"):
            res_payload["queued_task"] = str(exec_res["queued_task"])
        if isinstance(exec_res, dict) and exec_res.get("queue_skipped"):
            res_payload["queue_skipped"] = True
        if skill_judgment is not None:
            res_payload["skill_judgment"] = skill_judgment
        return res_payload

    def orchestrate_workflow(
        self,
        task: str,
        context: str = "",
        subtasks: list[str] | None = None,
        role: str = "auto",
        required_capabilities: list[str] | None = None,
        override_provider: str | None = None,
        strict_override: bool = False,
        compress_context: bool = True,
        now: float | None = None,
        auto_skills: bool = True,
        session_id: str = "default",
        pinned_skills: list[str] | None = None,
        workspace: str | None = None,
        use_graphify: bool = True,
    ) -> dict[str, Any]:
        """Execute a single task or multi-step workflow with automatic Gemini orchestrator offload."""
        ts = time.time() if now is None else float(now)
        trace: list[dict[str, Any]] = []
        working_context = context or ""
        if workspace and hasattr(self.executor, "workspace"):
            self.executor.workspace = workspace

        def _internal_step(**kw: Any) -> dict[str, Any]:
            # P2-272 4B: an internal step never queues a wk-task of its own.
            had = hasattr(self.executor, "no_queue")
            prev = getattr(self.executor, "no_queue", False)
            if had:
                self.executor.no_queue = True
            try:
                return self.run_task(**kw)
            finally:
                if had:
                    self.executor.no_queue = prev

        if use_graphify and workspace and os.environ.get("WK_GRAPHIFY_DEFAULT", "1") != "0":
            try:
                wk_root = PLUGIN_ROOT.parent
                if (wk_root / "core" / "graph_bridge.py").is_file():
                    if str(wk_root) not in sys.path:
                        sys.path.insert(0, str(wk_root))
                    from core.graph_bridge import format_graphify_context_block, query_ego_subgraph, sync_and_load_graph  # noqa: E402

                    g_info = sync_and_load_graph(workspace, bootstrap=True)
                    sub_g = query_ego_subgraph(workspace, task, graph_info=g_info)
                    g_block = format_graphify_context_block(sub_g)
                    if g_block:
                        working_context = f"{g_block}\n\n{working_context}".strip() if working_context.strip() else g_block
                    sav = sub_g.get("token_savings") or {}
                    trace.append(
                        {
                            "step": "graphify_token_saver",
                            "role": "graphify",
                            "provider": "graphify",
                            "model": "Graphify AST · 2-Hop",
                            "reason_code": "graphify_default_layer",
                            "reason_summary": f"Focused {sub_g.get('node_count', 0)}/{sub_g.get('total_nodes', 0)} nodes (~{sav.get('saved_pct', 0)}% saved).",
                            "tokens": sav.get("subgraph_est_tokens", 0),
                            "saved_tokens": sav.get("saved_tokens", 0),
                        }
                    )
            except Exception:
                pass

        # Step 1: Compress giant/heavy context via orchestrator step (offloads to Gemini)
        if compress_context and estimate_tokens(working_context) >= 3000 and not (
            set(required_capabilities or []) & CLAUDE_ONLY_CAPABILITIES
        ):
            comp_res = _internal_step(
                task="Summarize and compress the context below while preserving all technical details relevant to the goal.",
                context=f"Goal: {task}\n\n{working_context}",
                role="orchestrator",
                now=ts,
                auto_skills=False,
            )
            trace.append(
                {
                    "step": "context_compression",
                    "role": "orchestrator",
                    "provider": comp_res["provider"],
                    "model": comp_res["model"],
                    "reason_code": comp_res["reason_code"],
                    "reason_summary": comp_res["reason_summary"],
                    "tokens": comp_res["tokens"]["total"],
                }
            )
            if not comp_res.get("queue_skipped") and str(comp_res.get("output") or "").strip():
                working_context = comp_res["output"]

        clean_subtasks = [str(s).strip() for s in (subtasks or []) if str(s).strip()]
        if not clean_subtasks:
            main_res = self.run_task(
                task=task,
                context=working_context,
                role=role,
                required_capabilities=required_capabilities,
                override_provider=override_provider,
                strict_override=strict_override,
                now=ts,
                auto_skills=auto_skills,
                session_id=session_id,
                pinned_skills=pinned_skills,
            )
            trace.append(
                {
                    "step": "main_task",
                    "role": main_res["classification"]["role"],
                    "provider": main_res["provider"],
                    "model": main_res["model"],
                    "reason_code": main_res["reason_code"],
                    "reason_summary": main_res["reason_summary"],
                    "tokens": main_res["tokens"]["total"],
                }
            )
            main_res["trace"] = trace
            return main_res

        # Step 2: Execute each subtask across Gemini / Claude according to its own complexity & quota
        sub_outputs: list[str] = []
        for idx, sub in enumerate(clean_subtasks, start=1):
            sub_res = self.run_task(
                task=sub,
                context=working_context,
                role="auto",
                override_provider=override_provider,
                strict_override=strict_override,
                now=ts,
                auto_skills=auto_skills,
                session_id=session_id,
                pinned_skills=pinned_skills,
            )
            trace.append(
                {
                    "step": f"subtask_{idx}",
                    "task": sub[:80],
                    "role": sub_res["classification"]["role"],
                    "provider": sub_res["provider"],
                    "model": sub_res["model"],
                    "reason_code": sub_res["reason_code"],
                    "reason_summary": sub_res["reason_summary"],
                    "tokens": sub_res["tokens"]["total"],
                    **({"queued_task": sub_res["queued_task"]} if sub_res.get("queued_task") else {}),
                }
            )
            sub_outputs.append(f"### Subtask {idx}: {sub}\n{sub_res['output']}")

        # Step 3: Aggregate outputs in an orchestrator step (delegated to Gemini when token-heavy)
        agg_context = "\n\n".join(sub_outputs)
        agg_res = _internal_step(
            task="Aggregate and synthesize the subtask outputs below into a single cohesive response.",
            context=f"Overall goal: {task}\n\n{agg_context}",
            role="orchestrator",
            now=ts,
            auto_skills=False,
        )
        trace.append(
            {
                "step": "aggregation",
                "role": "orchestrator",
                "provider": agg_res["provider"],
                "model": agg_res["model"],
                "reason_code": agg_res["reason_code"],
                "reason_summary": agg_res["reason_summary"],
                "tokens": agg_res["tokens"]["total"],
            }
        )
        if agg_res.get("queue_skipped") or not str(agg_res.get("output") or "").strip():
            # The orchestrator lane only queues; join the subtask outputs here instead of queueing a merge task.
            agg_res["output"] = agg_context
        queued = [t["queued_task"] for t in trace if t.get("queued_task")]
        if queued:
            agg_res["queued_tasks"] = queued
        agg_res["trace"] = trace
        return agg_res

