#!/usr/bin/env python3
"""Gemini 4 Frontier Reasoning Engine (gemini-4-carbon:high & gemini-4-hydrogen:xhigh/high)."""

from __future__ import annotations

import hashlib
import json
import os
import random
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MODEL_CARBON = "gemini-4-carbon"
MODEL_HYDROGEN = "gemini-4-hydrogen"
MAX_OUTPUT_TOKENS = 65536

VALID_THINKING_LEVELS: dict[str, tuple[str, ...]] = {
    MODEL_CARBON: ("low", "medium", "high"),
    MODEL_HYDROGEN: ("low", "medium", "high", "xhigh"),
}

BANNED_PARAM_KEYS = frozenset({
    "temperature",
    "top_p",
    "top_k",
    "topP",
    "topK",
    "cachedContents",
    "cached_content",
    "cachedContent",
})

ARCH_KEYWORDS = (
    "architect",
    "design",
    "refactor",
    "security",
    "audit",
    "migration",
    "schema",
    "consensus",
    "concurrency",
    "multi-module",
    "spec",
    "hardening",
    "threat",
    "policy",
)

STATIC_CONTRACT_REFERENCE = (
    "Watchkeeper v2.0 Static Invariants: Enforce fail-closed path & policy checks; verify every claim with fresh tests; "
    "never drop existing Watchkeeper, Graphify, Full-IDE workspace, daily GitHub skill sync, or Carbon High failover "
    "capabilities; use Graphify 2-hop structural call/callee edges before broad raw greps; compose all domain-relevant "
    "skills and their supplementary scripts/references cleanly without leaking credentials or secrets."
)


def est_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text.encode("utf-8", errors="replace")) / 3.2))


def validate_gemini4_request(model: str, config: dict[str, Any]) -> None:
    """Enforce Gemini 4 API laws (forbids 2.5, minimal thinking, cachedContents, and sampling knobs)."""
    low_m = str(model or "").strip().lower()
    if low_m.startswith("gemini-2.") or low_m.startswith("gemini-1."):
        raise ValueError(f"Banned legacy model: {model}")
    if model not in VALID_THINKING_LEVELS:
        raise ValueError(f"Unsupported Gemini 4 core model: {model}")

    for k in config:
        if k in BANNED_PARAM_KEYS:
            raise ValueError(f"Banned Gemini 4 parameter: {k}")

    thinking = str(config.get("thinking_level") or "")
    if thinking == "minimal" or thinking not in VALID_THINKING_LEVELS[model]:
        raise ValueError(f"Invalid thinking_level '{thinking}' for {model}")

    max_tok = config.get("max_output_tokens")
    if max_tok != MAX_OUTPUT_TOKENS:
        raise ValueError(f"Gemini 4 calls require max_output_tokens={MAX_OUTPUT_TOKENS}, got {max_tok}")


def select_brain_tier(
    task: str,
    *,
    complexity: str = "high",
    latency_sensitive: bool = False,
    brain_policy: str = "adaptive-max",
) -> tuple[str, str]:
    """Choose top Gemini 4 model + highest appropriate reasoning tier."""
    pol = (brain_policy or "adaptive-max").strip().lower()
    if pol == "carbon-high":
        return MODEL_CARBON, "high"
    if pol == "hydrogen-xhigh":
        return MODEL_HYDROGEN, "high" if latency_sensitive else "xhigh"

    low = (task or "").lower()
    is_arch = complexity == "high" or any(kw in low for kw in ARCH_KEYWORDS)
    if is_arch:
        return MODEL_CARBON, "high"
    return MODEL_HYDROGEN, ("high" if latency_sensitive else "xhigh")


def resolve_gemini_credentials(env: dict[str, str] | None = None) -> tuple[str | None, str]:
    """Resolve Gemini key cleanly: WATCHKEEPER_GEMINI_API_KEY -> GEMINI_API_KEY -> GOOGLE_API_KEY -> config file."""
    env_map = env if env is not None else os.environ
    for key_name in ("WATCHKEEPER_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        val = (env_map.get(key_name) or "").strip()
        if val:
            return val, f"env:{key_name}"

    cred_path = Path(env_map.get("HOME") or Path.home()) / ".config" / "watchkeeper" / "credentials.json"
    if cred_path.is_file():
        try:
            data = json.loads(cred_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                val = str(data.get("gemini_api_key") or data.get("api_key") or "").strip()
                if val:
                    return val, "config:credentials.json"
        except (OSError, ValueError):
            pass

    rp_dir = env_map.get("REPROMPT_DATA_DIR")
    if rp_dir:
        sec_path = Path(rp_dir).expanduser() / "secrets.json"
        if sec_path.is_file():
            try:
                sec = json.loads(sec_path.read_text(encoding="utf-8"))
                if isinstance(sec, dict) and str(sec.get("geminiApiKey") or "").strip():
                    return str(sec["geminiApiKey"]).strip(), "reprompt:secrets.json"
            except (OSError, ValueError):
                pass
    return None, "missing"


def save_credentials_secure(gemini_api_key: str, home: Path | None = None) -> Path:
    """Persist API credentials cleanly with 0600 permissions."""
    cred_path = (home or Path.home()) / ".config" / "watchkeeper" / "credentials.json"
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(cred_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (json.dumps({"gemini_api_key": gemini_api_key.strip()}, indent=2) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return cred_path


def build_deterministic_payload(
    *,
    static_instructions: str,
    compact_manifest: list[dict[str, Any]],
    graph_report_summary: str,
    dynamic_subgraph: dict[str, Any],
    wk_state: dict[str, Any],
    raw_prompt: str,
    pad_prefix_to_4096_tokens: bool = True,
) -> dict[str, Any]:
    """Order payload deterministically: [STATIC BLOCK A] + [STATIC BLOCK B] + [DYNAMIC BLOCK C]."""
    sorted_manifest = sorted(compact_manifest, key=lambda x: (str(x.get("name") or ""), str(x.get("scope") or "")))
    manifest_json = json.dumps(sorted_manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    block_a = f"[STATIC BLOCK A: WATCHKEEPER COMPILER SYSTEM]\n{static_instructions.strip()}"
    block_b_parts = [
        "[STATIC BLOCK B: SKILLS LIBRARY MANIFEST & GRAPH ARCHITECTURE SUMMARY]",
        f"SkillsManifestJSON={manifest_json}",
        f"GraphArchitectureSummary={(graph_report_summary or 'No static graph report yet.').strip()}",
    ]
    static_prefix = f"{block_a}\n\n" + "\n\n".join(block_b_parts)

    if pad_prefix_to_4096_tokens and est_tokens(static_prefix) < 4200:
        # Canonical deterministic invariant lines keep Blocks A+B above the 4,096-token implicit cache floor when needed
        need_chars = max(0, int(4250 * 3.3) - len(static_prefix))
        rep = max(1, (need_chars // len(STATIC_CONTRACT_REFERENCE)) + 1)
        pad_block = "\n".join(f"[{idx:03d}] {STATIC_CONTRACT_REFERENCE}" for idx in range(rep))
        static_prefix = f"{static_prefix}\n\n[STATIC REFERENCE INVARIANTS]\n{pad_block}"

    prefix_sha = hashlib.sha256(static_prefix.encode("utf-8")).hexdigest()
    block_c = (
        "[DYNAMIC BLOCK C: FRESH GRAPH SUBGRAPH, STATE & USER PROMPT]\n"
        f"EgoSubgraph={json.dumps(dynamic_subgraph, sort_keys=True, ensure_ascii=False)}\n"
        f"WatchkeeperState={json.dumps(wk_state, sort_keys=True, ensure_ascii=False)}\n"
        f"RawUserPrompt:\n{(raw_prompt or '').strip()}"
    )

    return {
        "static_block_a": block_a,
        "static_block_b": "\n\n".join(block_b_parts),
        "static_prefix": static_prefix,
        "dynamic_block_c": block_c,
        "full_prompt": f"{static_prefix}\n\n{block_c}",
        "static_prefix_sha256": prefix_sha,
        "static_prefix_est_tokens": est_tokens(static_prefix),
    }


def _try_import_genai() -> Any:
    try:
        from google import genai  # type: ignore

        return genai
    except Exception:
        return None


def sdk_status() -> dict[str, Any]:
    mod = _try_import_genai()
    return {
        "sdk": "google-genai" if mod is not None else "stdlib-rest-fallback",
        "google_genai_installed": mod is not None,
        "version": getattr(mod, "__version__", None) if mod is not None else None,
        "legacy_sdk_present": False,
    }


# P2-272 canon: Watchkeeper never calls Google's Gemini service from Claude: not from the Claude Code hook
# (WK_CALLER=claude_code) and not from any process Claude started (CLAUDECODE=1: its shells, tests, scripts).
# The same rule as reprompt_engine.called_from_claude_code and bin/lib.mjs agyBlockedForClaude. An injected
# client (tests) makes no network call and stays allowed; callers fall back to the local template.
GEMINI_CANON_MESSAGE = "Watchkeeper canon: Gemini is never called from Claude (the local template is used)"


def gemini_blocked_for_claude(env: Any = None) -> bool:
    """True when the engine runs under Claude: the given env or this process's own environment says so."""
    for src in (env, os.environ):
        if not hasattr(src, "get"):
            continue
        if str(src.get("WK_CALLER") or "").strip().lower() == "claude_code":
            return True
        if str(src.get("CLAUDECODE") or "").strip() == "1":
            return True
    return False


class Gemini4Engine:
    """Fault-tolerant Gemini 4 client supporting google-genai SDK, Interactions API & REST fallback."""

    def __init__(self, env: dict[str, str] | None = None, client_factory: Any = None) -> None:
        self.env = env if env is not None else os.environ
        self.client_factory = client_factory

    def _call_sdk(
        self,
        *,
        api_key: str,
        model: str,
        thinking_level: str,
        contents: str,
        response_schema: dict[str, Any] | None,
        previous_interaction_id: str | None,
        use_interactions: bool,
        timeout_s: float = 25.0,
        max_hops: int = 2,
    ) -> dict[str, Any]:
        genai_mod = _try_import_genai()
        if self.client_factory is not None:
            client = self.client_factory(api_key=api_key)
        elif genai_mod is not None:
            # P2-272: bound the request like the REST path (the SDK's http_options timeout is in milliseconds).
            try:
                client = genai_mod.Client(api_key=api_key, http_options={"timeout": int(max(1.0, float(timeout_s)) * 1000)})
            except TypeError:
                client = genai_mod.Client(api_key=api_key)
        else:
            raise ImportError("google-genai not installed")

        cfg_kwargs: dict[str, Any] = {
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "thinking_level": thinking_level,
        }
        validate_gemini4_request(model, cfg_kwargs)

        if use_interactions and hasattr(client, "interactions"):
            inter_kwargs: dict[str, Any] = {
                "model": model,
                "input": contents,
                "generation_config": {
                    "max_output_tokens": MAX_OUTPUT_TOKENS,
                    "thinking_level": thinking_level,
                },
            }
            if previous_interaction_id:
                inter_kwargs["previous_interaction_id"] = previous_interaction_id
            resp = client.interactions.create(**inter_kwargs)
            text = str(getattr(resp, "output_text", None) or getattr(resp, "text", "") or "").strip()
            iid = getattr(resp, "id", None)
            return {"ok": bool(text), "text": text, "interaction_id": iid, "backend": "google-genai:interactions"}

        gen_cfg: Any
        try:
            from google.genai import types  # type: ignore

            t_kwargs: dict[str, Any] = {
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "thinking_config": types.ThinkingConfig(thinking_level=thinking_level),
            }
            if response_schema is not None:
                t_kwargs["response_mime_type"] = "application/json"
                t_kwargs["response_schema"] = response_schema
            gen_cfg = types.GenerateContentConfig(**t_kwargs)
        except Exception:
            gen_cfg = {
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "thinking_config": {"thinking_level": thinking_level},
                **({"response_mime_type": "application/json", "response_schema": response_schema} if response_schema else {}),
            }

        chunks: list[str] = []
        prompt_cur = contents
        for _hop in range(max(1, int(max_hops))):
            resp = client.models.generate_content(model=model, contents=prompt_cur, config=gen_cfg)
            part = str(getattr(resp, "text", "") or "").strip()
            if part:
                chunks.append(part)
            finish_reason = ""
            cands = getattr(resp, "candidates", None) or []
            if cands:
                finish_reason = str(getattr(cands[0], "finish_reason", "") or "").upper()
            if "MAX_TOKENS" not in finish_reason:
                break
            prompt_cur = f"{contents}\n\n[Continue seamlessly from:]\n{part[-600:]}"

        full_text = "\n".join(chunks).strip()
        return {"ok": bool(full_text), "text": full_text, "interaction_id": None, "backend": "google-genai:models"}

    def _call_rest(
        self,
        *,
        api_key: str,
        model: str,
        thinking_level: str,
        contents: str,
        response_schema: dict[str, Any] | None,
        timeout_s: float = 25.0,
    ) -> dict[str, Any]:
        validate_gemini4_request(model, {"max_output_tokens": MAX_OUTPUT_TOKENS, "thinking_level": thinking_level})
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        gen_cfg: dict[str, Any] = {
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "thinkingConfig": {"thinkingLevel": thinking_level},
        }
        if response_schema is not None:
            gen_cfg["responseMimeType"] = "application/json"
            gen_cfg["responseSchema"] = response_schema

        payload = json.dumps(
            {
                "contents": [{"role": "user", "parts": [{"text": contents}]}],
                "generationConfig": gen_cfg,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        cands = data.get("candidates") or []
        parts = (((cands[0].get("content") or {}).get("parts")) or []) if cands else []
        text = "\n".join(str(p.get("text") or "") for p in parts if isinstance(p, dict)).strip()
        return {"ok": bool(text), "text": text, "interaction_id": None, "backend": "gemini-4-rest"}

    def generate(
        self,
        *,
        prompt_payload: str | dict[str, Any],
        model: str = MODEL_CARBON,
        thinking_level: str = "high",
        response_schema: dict[str, Any] | None = None,
        previous_interaction_id: str | None = None,
        use_interactions: bool = False,
        timeout_s: float = 25.0,
        max_attempts: int = 3,
    ) -> dict[str, Any]:
        validate_gemini4_request(model, {"max_output_tokens": MAX_OUTPUT_TOKENS, "thinking_level": thinking_level})
        contents = prompt_payload["full_prompt"] if isinstance(prompt_payload, dict) else str(prompt_payload)

        if self.client_factory is None and gemini_blocked_for_claude(self.env):
            # P2-272 canon, checked before any key is read: under Claude no key file is opened and nothing is sent.
            return {
                "ok": False,
                "fallback": "offline-local",
                "model": model,
                "thinking_level": thinking_level,
                "backend": "offline-local",
                "key_source": "not-read",
                "text": "",
                "error": GEMINI_CANON_MESSAGE,
                "canon_blocked": True,
            }

        api_key, key_source = resolve_gemini_credentials(self.env)
        if not api_key and self.client_factory is None:
            return {
                "ok": False,
                "fallback": "offline-local",
                "model": model,
                "thinking_level": thinking_level,
                "backend": "offline-local",
                "key_source": key_source,
                "text": "",
                "error": "No Gemini API key configured",
            }

        alt_tier = (MODEL_HYDROGEN, "xhigh") if model == MODEL_CARBON else (MODEL_CARBON, "high")
        attempts = [(model, thinking_level), (model, thinking_level), alt_tier]
        # P2-272: hooks ask for one call to one model (no retry chain inside a hook's time budget).
        attempts = attempts[: max(1, min(len(attempts), int(max_attempts or 1)))]
        # A single-attempt call makes one request, so its timeout is the whole model budget.
        sdk_hops = 1 if len(attempts) == 1 else 2
        last_err = ""
        cur_use_inter = use_interactions
        cur_prev_id = previous_interaction_id
        cleared_interaction_id = False

        for idx, (m_cur, t_cur) in enumerate(attempts):
            try:
                if self.client_factory is not None or _try_import_genai() is not None:
                    res = self._call_sdk(
                        api_key=api_key or "injected-client",
                        model=m_cur,
                        thinking_level=t_cur,
                        contents=contents,
                        response_schema=response_schema,
                        previous_interaction_id=cur_prev_id,
                        use_interactions=cur_use_inter,
                        timeout_s=timeout_s,
                        max_hops=sdk_hops,
                    )
                else:
                    res = self._call_rest(
                        api_key=api_key or "",
                        model=m_cur,
                        thinking_level=t_cur,
                        contents=contents,
                        response_schema=response_schema,
                        timeout_s=timeout_s,
                    )
                if res.get("ok"):
                    return {
                        **res,
                        "model": m_cur,
                        "thinking_level": t_cur,
                        "key_source": key_source,
                        **({"cleared_interaction_id": True} if cleared_interaction_id else {}),
                    }
                last_err = "empty response from Gemini 4"
                if cur_use_inter and cur_prev_id:
                    cur_prev_id = None
                    cur_use_inter = False
                    cleared_interaction_id = True
            except urllib.error.HTTPError as exc:
                last_err = f"HTTP {exc.code}: {exc.reason}"
                if cur_use_inter and cur_prev_id:
                    cur_prev_id = None
                    cur_use_inter = False
                    cleared_interaction_id = True
                    if idx + 1 < len(attempts):
                        continue
                if exc.code in (429, 503) and idx + 1 < len(attempts):
                    time.sleep(min(1.5, (0.25 * (2**idx)) + random.uniform(0.05, 0.2)))
                    continue
            except Exception as exc:
                last_err = str(exc)[:240]
                if cur_use_inter and cur_prev_id:
                    cur_prev_id = None
                    cur_use_inter = False
                    cleared_interaction_id = True
                    if idx + 1 < len(attempts):
                        continue
                if idx + 1 < len(attempts) and any(tok in last_err.lower() for tok in ("429", "503", "rate", "overloaded", "unavailable")):
                    time.sleep(min(1.5, 0.2 * (idx + 1)))
                    continue

        return {
            "ok": False,
            "fallback": "offline-local",
            "model": model,
            "thinking_level": thinking_level,
            "backend": "offline-local",
            "key_source": key_source,
            "text": "",
            "error": last_err or "Gemini 4 request failed",
            **({"cleared_interaction_id": True} if cleared_interaction_id else {}),
        }
