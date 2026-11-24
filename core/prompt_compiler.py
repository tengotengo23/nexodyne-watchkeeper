#!/usr/bin/env python3
"""Prompt Compiler v2.0: merges Re-Prompt v1.3.0, Graphify 2-hop truth, and Composed Skills."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from core.clipboard_io import format_standalone_fence
from core.fast_path import FastPathDecision
from core.gemini_engine import (
    MODEL_CARBON,
    Gemini4Engine,
    build_deterministic_payload,
    select_brain_tier,
)
from core.graph_bridge import query_ego_subgraph, sync_and_load_graph
from core.learning_engine import build_learning_context
from core.skill_router import (
    build_skills_manifest,
    load_composed_skill_bundle,
    select_all_matching_skills,
)
from core.state_store import StateStore

ROOT = Path(__file__).resolve().parent.parent

STATIC_COMPILER_SYSTEM_PROMPT = """
You are the Watchkeeper Unified Prompt Compiler v2.0.
Your task is to normalize the user's raw engineering prompt into a deterministic, unambiguous, executable specification while selecting ALL matching skills from the SkillsManifestJSON.

Strict output JSON schema:
{
  "selected_skills": ["skill-name-1", "..."],
  "objective": "Clear, concrete engineering goal preserving 100% of user intent and constraints.",
  "structural_grounding": ["File/symbol and upstream callers from EgoSubgraph to inspect or keep intact."],
  "composed_playbook": ["Harmonized concrete steps derived from all selected skills and helpers."],
  "guardrails_and_dod": ["Concrete verification command(s), test criteria, and security invariants."]
}
""".strip()

COMPILER_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "selected_skills": {"type": "array", "items": {"type": "string"}},
        "objective": {"type": "string"},
        "structural_grounding": {"type": "array", "items": {"type": "string"}},
        "composed_playbook": {"type": "array", "items": {"type": "string"}},
        "guardrails_and_dod": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["selected_skills", "objective", "structural_grounding", "composed_playbook", "guardrails_and_dod"],
}


def _strip_skill_directives(text: str) -> str:
    cleaned = re.sub(r"(?:^|\s)[+-@]skill:[A-Za-z0-9_.:-]+", "", text or "")
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _format_graph_lines(subgraph: dict[str, Any]) -> list[str]:
    if not subgraph.get("available"):
        return ["No existing graphify-out/graph.json in workspace (run `/wk graph sync` to generate AST graph)."]
    lines: list[str] = []
    nodes = subgraph.get("nodes") or []
    edges = subgraph.get("edges") or []
    for n in nodes[:10]:
        f = f" ({n['file']})" if n.get("file") else ""
        lines.append(f"`{n.get('label', n['id'])}`{f} — in:{n.get('in_degree', 0)} out:{n.get('out_degree', 0)}")
    if edges:
        sample = ", ".join(f"{e['source']}->{e['target']}" for e in edges[:5])
        lines.append(f"Key 2-hop edges: {sample}")
    return lines or ["Graph loaded; no direct symbol overlap — scan entrypoints before editing."]


def _format_skill_playbook(bundle: list[dict[str, Any]]) -> list[str]:
    if not bundle:
        return ["No domain specialist skills matched; follow Watchkeeper core engineering & test-evidence discipline."]
    out: list[str] = []
    for sk in bundle:
        summary = sk.get("description") or ((sk.get("instructions") or "").splitlines()[0] if sk.get("instructions") else "")
        out.append(f"**[{sk['name']}]** ({sk['scope']}): {summary[:220]}")
        for sc in sk.get("scripts") or []:
            out.append(f"  - Helper script: `{sc}`")
        for ref in sk.get("references") or []:
            first_line = next((ln.strip() for ln in ref["excerpt"].splitlines() if ln.strip()), "")
            out.append(f"  - Reference `{ref['file']}` (`{ref['path']}`): {first_line[:160]}")
    return out


def _offline_synthesize(
    *,
    prompt_body: str,
    style_override: str | None,
    subgraph: dict[str, Any],
    bundle: list[dict[str, Any]],
) -> dict[str, Any]:
    style_note = f" [{style_override} focus]" if style_override else ""
    return {
        "objective": f"{_strip_skill_directives(prompt_body)}{style_note}",
        "structural_grounding": _format_graph_lines(subgraph),
        "composed_playbook": _format_skill_playbook(bundle),
        "guardrails_and_dod": [
            "Respect ~/.wk/KILL, fail-closed policy pins (config/gates.json), and worktree boundaries.",
            "Run targeted verification tests after final edits and report only directly observed results.",
        ],
    }


# P2-272 hook budget: compile_prompt_v2 runs inside a hook (the plugin's UserPromptSubmit timeout and Antigravity's
# hook budget are both 45 s). One call to one model, at most 25 s, and at least 10 s left for the local template.
HOOK_BUDGET_S = 45.0
HOOK_HEADROOM_S = 10.0
HOOK_MODEL_TIMEOUT_MAX_S = 25.0
HOOK_MODEL_TIMEOUT_MIN_S = 3.0


def compile_prompt_v2(
    decision: FastPathDecision,
    *,
    workspace_dir: str | Path,
    session_id: str = "default",
    agent_role: str = "main",
    store: StateStore | None = None,
    engine: Gemini4Engine | None = None,
    home: str | Path | None = None,
    pad_prefix_to_4096_tokens: bool = True,
    hook_budget_s: float = HOOK_BUDGET_S,
) -> dict[str, Any]:
    """Execute Stages 2-4: Graphify 2-hop extraction -> Multi-skill composition -> Gemini 4 Spec."""
    t0 = time.monotonic()
    ws = Path(workspace_dir).expanduser().resolve()
    rt = store or StateStore(workspace_dir=ws)
    cfg = rt.load_config()
    sess = rt.get_session(session_id)

    auto_boot = bool(cfg.get("graphify_default", True)) and os.environ.get("WK_GRAPHIFY_DEFAULT") != "0"
    graph_info = sync_and_load_graph(ws, store=rt, bootstrap=auto_boot)
    subgraph = query_ego_subgraph(ws, decision.prompt_body, graph_info=graph_info)
    manifest = build_skills_manifest(workspace_dir=ws, home=home, store=rt)

    complexity = "high" if (len(decision.prompt_body) > 160 or subgraph.get("node_count", 0) >= 4) else "medium"
    model, thinking_level = select_brain_tier(
        decision.prompt_body,
        complexity=complexity,
        latency_sensitive=False,
        brain_policy=str(cfg.get("brain") or "adaptive-max"),
    )

    compact_manifest = [
        {"name": s["name"], "scope": s["scope"], "desc": s["description"][:140], "tags": s.get("tags", [])[:5]}
        for s in manifest.get("skills") or []
    ]
    payload = build_deterministic_payload(
        static_instructions=STATIC_COMPILER_SYSTEM_PROMPT,
        compact_manifest=compact_manifest,
        graph_report_summary=graph_info.get("report_summary") or "",
        dynamic_subgraph={"nodes": subgraph.get("nodes", []), "edges": subgraph.get("edges", [])},
        wk_state={"mode": cfg["mode"], "brain": cfg["brain"], "style": decision.style_override},
        raw_prompt=decision.prompt_body,
        pad_prefix_to_4096_tokens=pad_prefix_to_4096_tokens,
    )

    prev_stats = rt.get_cache_stats()
    prefix_hit = bool(prev_stats.get("last_prefix_sha") == payload["static_prefix_sha256"])

    eng = engine or Gemini4Engine()
    use_interactions = bool(model == MODEL_CARBON and sess.get("last_interaction_id"))
    # P2-272: the model gets what is left of the hook budget after the graph work, minus the headroom, capped at 25 s.
    model_timeout_s = min(HOOK_MODEL_TIMEOUT_MAX_S, float(hook_budget_s) - HOOK_HEADROOM_S - (time.monotonic() - t0))
    if model_timeout_s >= HOOK_MODEL_TIMEOUT_MIN_S:
        g_res = eng.generate(
            prompt_payload=payload,
            model=model,
            thinking_level=thinking_level,
            response_schema=COMPILER_RESPONSE_SCHEMA,
            previous_interaction_id=sess.get("last_interaction_id"),
            use_interactions=use_interactions,
            timeout_s=model_timeout_s,
            max_attempts=1,
        )
    else:
        g_res = {
            "ok": False,
            "fallback": "offline-local",
            "backend": "offline-local",
            "model": model,
            "thinking_level": thinking_level,
            "text": "",
            "error": "Hook time budget used up before the model call; the local template is used",
        }

    parsed: dict[str, Any] | None = None
    gemini_skills: list[str] = []
    if g_res.get("ok") and g_res.get("text"):
        rt.record_prefix_cache(payload["static_prefix_sha256"], prefix_hit)
        cache_badge = "HIT" if prefix_hit else "WARM"
        try:
            cand = json.loads(g_res["text"])
            if isinstance(cand, dict):
                parsed = cand
                gemini_skills = [str(s) for s in (cand.get("selected_skills") or []) if isinstance(s, str)]
        except (ValueError, TypeError):
            parsed = None
    else:
        cache_badge = "LOCAL"

    try:
        learn_ctx = build_learning_context(decision.prompt_body, workspace_dir=ws)
    except Exception:
        learn_ctx = {"has_context": False, "snippets": [], "heuristics": [], "ranking_boosts": {}, "markdown": "", "latency_ms": 0.0}

    selected_skills = select_all_matching_skills(
        decision.prompt_body,
        manifest,
        agent_role=agent_role,
        gemini_selected=gemini_skills,
        ranking_boosts=learn_ctx.get("ranking_boosts") or None,
    )
    skill_bundle = load_composed_skill_bundle(selected_skills)

    if parsed is None:
        parsed = _offline_synthesize(
            prompt_body=decision.prompt_body,
            style_override=decision.style_override,
            subgraph=subgraph,
            bundle=skill_bundle,
        )
    else:
        # Ensure selected skills & helper scripts from Tier-2 are never omitted from playbook
        playbook = [str(x) for x in (parsed.get("composed_playbook") or []) if str(x).strip()]
        existing_low = "\n".join(playbook).lower()
        for sk in skill_bundle:
            if sk["name"].lower() not in existing_low:
                playbook.extend(_format_skill_playbook([sk]))
            else:
                for sc in sk.get("scripts") or []:
                    if sc not in existing_low:
                        playbook.append(f"- Skill `{sk['name']}` helper script: `{sc}`")
        parsed["composed_playbook"] = playbook

    elapsed_s = round(time.monotonic() - t0, 2)
    spec_hash = hashlib.sha256(f"{decision.prompt_body}:{payload['static_prefix_sha256']}".encode("utf-8")).hexdigest()[:12]
    skill_names = [s["name"] for s in skill_bundle]
    skills_disp = ", ".join(skill_names) if skill_names else "none"
    sav = subgraph.get("token_savings") or {}
    saved_note = f", ~{sav['saved_pct']:.0f}% tok saved" if sav.get("saved_pct") else ""
    hud = (
        f"⚡ Watchkeeper │ Brain: {g_res.get('model', model)} ({g_res.get('thinking_level', thinking_level)}) │ "
        f"Graph: {subgraph.get('total_nodes', 0)} nodes, {subgraph.get('total_edges', 0)} edges ({subgraph.get('freshness', 'none')}{saved_note}) │ "
        f"Skills: [{skills_disp}] │ Guardrails: ON │ Cache: {cache_badge} ({elapsed_s}s)"
    )

    sec_ground = "\n".join(f"- {ln}" for ln in (parsed.get("structural_grounding") or _format_graph_lines(subgraph)))
    sec_play = "\n".join(f"- {ln}" if not str(ln).startswith(("  -", "-", "*")) else str(ln) for ln in (parsed.get("composed_playbook") or []))
    dod_list = [str(ln) for ln in (parsed.get("guardrails_and_dod") or []) if str(ln).strip()]
    sec_dod = "\n".join(f"- {ln}" for ln in dod_list)

    compiled_body = (
        f"[WK-SPEC-V2:{spec_hash}]\n"
        f"{hud}\n\n"
        f"## 1. Core Objective & Exact Scope\n{str(parsed.get('objective') or _strip_skill_directives(decision.prompt_body)).strip()}\n\n"
        f"## 2. Graphify Structural Grounding\n{sec_ground}\n\n"
        f"## 3. Active Composed Skill Playbook\n{sec_play}\n\n"
        f"## 4. Watchkeeper Guardrails & Definition of Done\n{sec_dod}"
    ).strip()

    if learn_ctx.get("has_context") and learn_ctx.get("markdown"):
        learn_lines = [ln for ln in str(learn_ctx["markdown"]).splitlines()[1:]]
        learn_inner = "\n".join(learn_lines).strip()
        if learn_inner:
            compiled_body = f"{compiled_body}\n\n## 5. Learned Guardrails & Verified Snippets\n{learn_inner}"

    if decision.confirm_required and decision.mode != "standalone_reprompt":
        compiled_body = (
            f"{compiled_body}\n\n"
            "> **Watchkeeper Confirm Mode:** Present this `[WK-SPEC-V2]` plan to the user for quick approval before modifying files."
        )

    fenced_rewrite = format_standalone_fence(compiled_body) if decision.mode == "standalone_reprompt" else ""

    def _save_sess(st: dict[str, Any]) -> None:
        st["last_spec_hash"] = spec_hash
        st["last_compiled_criteria"] = dod_list[:8]
        if g_res.get("interaction_id"):
            st["last_interaction_id"] = g_res["interaction_id"]
        elif g_res.get("cleared_interaction_id"):
            st["last_interaction_id"] = None
        if decision.mode == "standalone_reprompt":
            st["standalone_reprompt"] = {
                "active": True,
                "spec_hash": spec_hash,
                "clean_text": compiled_body,
                "fenced_markdown": fenced_rewrite,
            }
        else:
            st["standalone_reprompt"] = None

    rt.update_session(session_id, _save_sess)

    return {
        "ok": True,
        "spec_hash": spec_hash,
        "mode": decision.mode,
        "hud": hud,
        "compiled_text": compiled_body,
        "fenced_markdown": fenced_rewrite,
        "model": g_res.get("model", model),
        "thinking_level": g_res.get("thinking_level", thinking_level),
        "backend": g_res.get("backend", "offline-local"),
        "cache_status": cache_badge,
        "static_prefix_sha256": payload["static_prefix_sha256"],
        "static_prefix_est_tokens": payload["static_prefix_est_tokens"],
        "skills": skill_names,
        "skill_bundle": skill_bundle,
        "subgraph": subgraph,
        "token_savings": sav,
        "learning": {
            "has_context": bool(learn_ctx.get("has_context")),
            "snippet_count": len(learn_ctx.get("snippets") or []),
            "heuristic_count": len(learn_ctx.get("heuristics") or []),
            "latency_ms": learn_ctx.get("latency_ms", 0.0),
        },
        "elapsed_s": elapsed_s,
    }
