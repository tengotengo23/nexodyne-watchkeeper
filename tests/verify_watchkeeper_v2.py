#!/usr/bin/env python3
"""Deep Verification, Chaos & Parity Suite for Watchkeeper Unified Runtime v2.0 (Gates 1-6)."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.clipboard_io import extract_fenced_rewrite, format_standalone_fence  # noqa: E402
from core.fast_path import evaluate_fast_path  # noqa: E402
from core.forensic_audit import generate_ledger  # noqa: E402
from core.gemini_engine import (  # noqa: E402
    MAX_OUTPUT_TOKENS,
    MODEL_CARBON,
    MODEL_HYDROGEN,
    Gemini4Engine,
    build_deterministic_payload,
    select_brain_tier,
    validate_gemini4_request,
)
from core.graph_bridge import check_blast_radius, query_ego_subgraph, sync_and_load_graph  # noqa: E402
from core.hook_bus import handle_event  # noqa: E402
from core.prompt_compiler import COMPILER_RESPONSE_SCHEMA, STATIC_COMPILER_SYSTEM_PROMPT, compile_prompt_v2  # noqa: E402
from core.skill_router import (  # noqa: E402
    build_skills_manifest,
    load_composed_skill_bundle,
    select_all_matching_skills,
)
from core.state_store import StateStore  # noqa: E402
from core.wk_cli import run_wk_cli  # noqa: E402


class Gate1CapabilityParityTests(unittest.TestCase):
    """Gate 1: CAPABILITY_LEDGER.json 100% parity & Hook Bus wiring."""

    def test_capability_ledger_parity_and_sanitization(self) -> None:
        ledger_path = ROOT / "core" / "CAPABILITY_LEDGER.json"
        self.assertTrue(ledger_path.is_file(), "core/CAPABILITY_LEDGER.json must exist")
        raw_text = ledger_path.read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"/Users/[A-Za-z0-9._-]+", raw_text), "Ledger must not contain personal /Users paths")

        ledger = json.loads(raw_text)
        self.assertEqual(ledger.get("schema_version"), "2.0.0")
        self.assertGreaterEqual(int(ledger.get("summary", {}).get("total_capabilities", 0)), 140)
        self.assertIn("external_skills_catalog", ledger)
        self.assertIn("capabilities", ledger)
        origins = {str(e.get("origin_component") or "") for e in ledger["capabilities"]}
        self.assertTrue({"watchkeeper", "graphify", "re-prompt-v1.3.0"}.issubset(origins))

        # Verify every core Watchkeeper + v2 artifact registered in the ledger exists on disk
        required_files = [
            "hooks/hooks.json",
            "bin/wk.mjs",
            "bin/wk-guard.mjs",
            "bin/wk-evidence.mjs",
            "bin/wk-handoff.mjs",
            "bin/wk-steward.mjs",
            "bin/wk-skill-sync.mjs",
            "bin/wk-carbon-fallback.mjs",
            "bin/wk-graphify.mjs",
            "bin/wk-status.mjs",
            "commands/wk.md",
            "commands/re-prompt.md",
            "commands/status.md",
            "skills/wk/SKILL.md",
            "antigravity/plugins/watchkeeper/skills/wk/SKILL.md",
            "core/hook_bus.py",
            "core/gemini_engine.py",
            "core/prompt_compiler.py",
            "core/skill_router.py",
            "core/graph_bridge.py",
            "core/fast_path.py",
            "core/state_store.py",
            "core/clipboard_io.py",
            "core/wk_cli.py",
            "reprompt/server/reprompt_mcp_server.py",
            "reprompt/server/reprompt_engine.py",
            "reprompt/server/orchestrator.py",
            "panel/extension.js",
            "panel/src/render.js",
        ]
        for rel in required_files:
            self.assertTrue((ROOT / rel).exists(), f"Missing unified capability file: {rel}")

        # Verify dynamic ledger generation succeeds inside temp staging without touching tracked file
        with tempfile.TemporaryDirectory() as td:
            gen = generate_ledger(root=ROOT, home=Path(td), write_outputs=False)
            self.assertGreaterEqual(gen["summary"]["watchkeeper_counts"]["hooks"], 7)

    def test_hooks_json_routes_through_hook_bus_with_wildcard_pretool(self) -> None:
        hooks_cfg = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
        hooks = hooks_cfg.get("hooks", {})
        expected_events = [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PostToolBatch",
            "SubagentStart",
            "SubagentStop",
            "Stop",
        ]
        for ev in expected_events:
            self.assertIn(ev, hooks, f"hooks.json missing event {ev}")
            entries = hooks[ev]
            self.assertTrue(len(entries) >= 1)
            cmds = [h.get("command", "") for entry in entries for h in entry.get("hooks", [])]
            self.assertTrue(any(("core/hook_bus.py" in c and ev in c) for c in cmds), f"{ev} must invoke core/hook_bus.py {ev}")
        self.assertEqual(hooks["PreToolUse"][0].get("matcher"), "*")


class Gate2Gemini4AndPrefixCacheTests(unittest.TestCase):
    """Gate 2: Gemini 4 API laws, google-genai SDK/Interactions/fallback, prefix cache & legacy sweep."""

    def test_gemini4_request_validator_and_routing(self) -> None:
        validate_gemini4_request(MODEL_CARBON, {"max_output_tokens": 65536, "thinking_level": "high"})
        validate_gemini4_request(MODEL_HYDROGEN, {"max_output_tokens": 65536, "thinking_level": "xhigh"})

        for bad_model, bad_cfg in [
            ("gemini-2." + "5-pro", {"max_output_tokens": 65536, "thinking_level": "high"}),
            ("gemini-2." + "5-flash", {"max_output_tokens": 65536, "thinking_level": "high"}),
            (MODEL_HYDROGEN, {"max_output_tokens": 65536, "thinking_level": "minimal"}),
            (MODEL_CARBON, {"max_output_tokens": 4096, "thinking_level": "high"}),
            (MODEL_CARBON, {"max_output_tokens": 65536, "thinking_level": "high", "temperature": 0.2}),
            (MODEL_CARBON, {"max_output_tokens": 65536, "thinking_level": "high", "top_p": 0.9}),
            (MODEL_CARBON, {"max_output_tokens": 65536, "thinking_level": "high", "top_k": 40}),
            (MODEL_CARBON, {"max_output_tokens": 65536, "thinking_level": "high", "cachedContents": "c/1"}),
        ]:
            with self.assertRaises(ValueError):
                validate_gemini4_request(bad_model, bad_cfg)

        self.assertEqual(select_brain_tier("Architect distributed SQL consensus engine"), (MODEL_CARBON, "high"))
        self.assertEqual(select_brain_tier("rename helper variable", complexity="low", latency_sensitive=True), (MODEL_HYDROGEN, "high"))
        self.assertEqual(select_brain_tier("format docs", complexity="low", latency_sensitive=False), (MODEL_HYDROGEN, "xhigh"))

    def test_sdk_interactions_continuation_and_deterministic_prefix_cache(self) -> None:
        captured_calls: list[dict[str, Any]] = []

        class FakeModels:
            def __init__(self) -> None:
                self.turn = 0

            def generate_content(self, *, model: str, contents: str, config: Any) -> Any:
                self.turn += 1
                captured_calls.append({"kind": "generate_content", "model": model, "contents": contents, "config": config})
                spec = {
                    "selected_skills": ["api-spec", "sql-migrator"],
                    "objective": f"Normalized objective turn {self.turn}",
                    "structural_grounding": ["app.py (in:0 out:1)"],
                    "composed_playbook": ["Step 1: design API", "Step 2: migrate SQL"],
                    "guardrails_and_dod": ["Run unit tests after edits"],
                }
                return types.SimpleNamespace(
                    text=json.dumps(spec),
                    candidates=[types.SimpleNamespace(finish_reason="MAX_TOKENS" if self.turn == 1 else "STOP")],
                )

        class FakeInteractions:
            def create(self, **kwargs: Any) -> Any:
                captured_calls.append({"kind": "interactions", **kwargs})
                return types.SimpleNamespace(id="inter_002", output_text='{"ok": true}')

        class FakeClient:
            def __init__(self) -> None:
                self.models = FakeModels()
                self.interactions = FakeInteractions()

        # Also test fake `google.genai` module import path cleanly
        fake_google = types.ModuleType("google")
        fake_genai = types.ModuleType("google.genai")
        fake_types = types.ModuleType("google.genai.types")
        fake_types.ThinkingConfig = lambda **kw: dict(kw)  # type: ignore[attr-defined]
        fake_types.GenerateContentConfig = lambda **kw: dict(kw)  # type: ignore[attr-defined]
        fake_genai.types = fake_types  # type: ignore[attr-defined]
        fake_genai.Client = lambda **_kw: FakeClient()  # type: ignore[attr-defined]
        fake_google.genai = fake_genai  # type: ignore[attr-defined]

        prev_g = sys.modules.get("google")
        prev_gg = sys.modules.get("google.genai")
        prev_ggt = sys.modules.get("google.genai.types")
        sys.modules["google"] = fake_google
        sys.modules["google.genai"] = fake_genai
        sys.modules["google.genai.types"] = fake_types
        try:
            engine = Gemini4Engine(env={}, client_factory=lambda **_kw: FakeClient())
            res_models = engine.generate(
                prompt_payload="test architectural refactor",
                model=MODEL_CARBON,
                thinking_level="high",
                response_schema=COMPILER_RESPONSE_SCHEMA,
            )
            self.assertTrue(res_models["ok"])
            self.assertEqual(res_models["backend"], "google-genai:models")
            self.assertEqual(len([c for c in captured_calls if c["kind"] == "generate_content"]), 2)
            cfg0 = captured_calls[0]["config"]
            self.assertEqual(cfg0.get("max_output_tokens"), 65536)
            self.assertNotIn("temperature", cfg0)
            self.assertNotIn("top_p", cfg0)
            self.assertNotIn("top_k", cfg0)

            res_inter = engine.generate(
                prompt_payload="follow up",
                model=MODEL_CARBON,
                thinking_level="high",
                use_interactions=True,
                previous_interaction_id="inter_001",
            )
            self.assertTrue(res_inter["ok"])
            self.assertEqual(res_inter["interaction_id"], "inter_002")
            inter_call = [c for c in captured_calls if c["kind"] == "interactions"][0]
            self.assertEqual(inter_call["previous_interaction_id"], "inter_001")
        finally:
            for k, v in (("google", prev_g), ("google.genai", prev_gg), ("google.genai.types", prev_ggt)):
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v

        # Deterministic [STATIC BLOCK A] + [STATIC BLOCK B] >= 4096 tokens and byte-identical hash + HIT tracking
        manifest = [{"name": "api-spec", "scope": "project_local", "description": "REST API guide", "tags": ["api"], "has_scripts": True}]
        p1 = build_deterministic_payload(
            static_instructions=STATIC_COMPILER_SYSTEM_PROMPT,
            compact_manifest=manifest,
            graph_report_summary="Summary A",
            dynamic_subgraph={"nodes": ["n1"]},
            wk_state={"mode": "auto"},
            raw_prompt="build endpoint 1",
            pad_prefix_to_4096_tokens=True,
        )
        p2 = build_deterministic_payload(
            static_instructions=STATIC_COMPILER_SYSTEM_PROMPT,
            compact_manifest=manifest,
            graph_report_summary="Summary A",
            dynamic_subgraph={"nodes": ["n2", "n3"]},
            wk_state={"mode": "confirm"},
            raw_prompt="build endpoint 2",
            pad_prefix_to_4096_tokens=True,
        )
        self.assertGreaterEqual(p1["static_prefix_est_tokens"], 4096)
        self.assertEqual(p1["static_prefix_sha256"], p2["static_prefix_sha256"])
        self.assertEqual(p1["static_prefix"], p2["static_prefix"])
        self.assertNotEqual(p1["dynamic_block_c"], p2["dynamic_block_c"])

        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            ws.mkdir()
            store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
            eng_hit = Gemini4Engine(env={}, client_factory=lambda **_kw: FakeClient())
            dec = evaluate_fast_path("Design secure REST API with SQL migration", env={})
            c1 = compile_prompt_v2(dec, workspace_dir=ws, session_id="s1", store=store, engine=eng_hit)
            c2 = compile_prompt_v2(dec, workspace_dir=ws, session_id="s1", store=store, engine=eng_hit)
            self.assertEqual(c1["cache_status"], "WARM")
            self.assertEqual(c2["cache_status"], "HIT")
            self.assertGreaterEqual(store.get_cache_stats()["hits"], 1)

    def test_retry_failover_and_zero_legacy_gemini_refs(self) -> None:
        calls: list[str] = []

        class FlakyClient:
            class models:
                @staticmethod
                def generate_content(*, model: str, contents: str, config: Any) -> Any:
                    calls.append(model)
                    if model == MODEL_CARBON:
                        raise RuntimeError("429 Too Many Requests overloaded")
                    return types.SimpleNamespace(text='{"selected_skills": [], "objective": "ok", "structural_grounding": [], "composed_playbook": [], "guardrails_and_dod": []}', candidates=[])

        eng = Gemini4Engine(env={}, client_factory=lambda **_kw: FlakyClient())
        out = eng.generate(prompt_payload="refactor engine", model=MODEL_CARBON, thinking_level="high")
        self.assertTrue(out["ok"])
        self.assertEqual(out["model"], MODEL_HYDROGEN)
        self.assertEqual(out["thinking_level"], "xhigh")
        self.assertGreaterEqual(len(calls), 3)

        # Static repo sweep: ZERO gemini-2.5 or google-generativeai anywhere in source
        legacy_pat = re.compile(r"gemini-2\.5|google-generativeai")
        scan_dirs = ("core", "bin", "panel/src", "panel/media", "reprompt/server", "reprompt/scripts", "reprompt/ide-extension", "antigravity")
        hits: list[str] = []
        for d in scan_dirs:
            p = ROOT / d
            if not p.exists():
                continue
            for f in p.rglob("*"):
                if not f.is_file() or f.suffix not in (".py", ".js", ".mjs", ".html", ".json", ".md"):
                    continue
                txt = f.read_text(encoding="utf-8", errors="replace")
                if legacy_pat.search(txt):
                    hits.append(str(f.relative_to(ROOT)))
        self.assertEqual(hits, [], f"Legacy Gemini 2.5 / old SDK strings found in: {hits}")


class Gate3FastPathAndLoopImmunityTests(unittest.TestCase):
    """Gate 3: <5ms triage and zero-recursion loop immunity."""

    def test_fast_path_under_5ms_and_bypass_triggers(self) -> None:
        samples = [
            "[WK-SPEC-V2:abcdef123456]\n## 1. Core Objective",
            "raw: check quick bug",
            "rp-raw: explain error",
            "yes",
            "ok",
            "1",
            "/wk status",
            "git status",
        ]
        # Warmup once then measure strict elapsed per call
        evaluate_fast_path("warmup", env={})
        t0 = time.perf_counter()
        for _ in range(40):
            for s in samples:
                dec = evaluate_fast_path(s, env={})
                self.assertTrue(dec.bypass, f"Expected fast-path bypass for: {s!r}")
        avg_ms = ((time.perf_counter() - t0) * 1000.0) / (40 * len(samples))
        self.assertLess(avg_ms, 5.0, f"Fast-path exceeded 5ms budget: {avg_ms:.3f}ms")

        # Subagent env guard
        env_dec = evaluate_fast_path("Architect big backend change", env={"WK_SUBAGENT_ACTIVE": "1"})
        self.assertTrue(env_dec.bypass)
        self.assertEqual(env_dec.reason, "subagent_loop_guard")

        # Passthrough runtime config
        rt_dec = evaluate_fast_path("Add SQL table", env={}, runtime_config={"mode": "passthrough"})
        self.assertTrue(rt_dec.bypass)
        self.assertEqual(rt_dec.reason, "mode_passthrough")

    def test_hook_bus_subagent_depth_prevents_recursive_reprompt(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            ws.mkdir()
            store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
            sid = "subagent_sess_1"

            handle_event("SubagentStart", json.dumps({"session_id": sid, "cwd": str(ws)}), store=store, bypass_subprocesses=True)
            self.assertEqual(store.get_session(sid).get("subagent_depth"), 1)

            rc, out, _ = handle_event(
                "UserPromptSubmit",
                json.dumps({"session_id": sid, "cwd": str(ws), "prompt": "Implement complex auth service"}),
                store=store,
                bypass_subprocesses=True,
            )
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(out), {})  # Loop immunity: zero re-prompting inside subagent!

            handle_event("SubagentStop", json.dumps({"session_id": sid, "cwd": str(ws)}), store=store, bypass_subprocesses=True)
            self.assertEqual(store.get_session(sid).get("subagent_depth"), 0)


class Gate4MultiSkillAndGraphifyTests(unittest.TestCase):
    """Gate 4: Unrestricted 3+ multi-skill composition, precedence, resources, quarantine & Graphify AST."""

    def test_multi_skill_composition_precedence_aux_and_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            home = Path(td) / "home"
            store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)

            local_specs = {
                "api-designer": ("API endpoint design REST OpenAPI schema validation", ["api"], "Project-local API skill"),
                "sql-migrator": ("SQL postgres migration table schema index rollback", ["sql"], "SQL skill"),
                "sec-hardener": ("Security OAuth JWT CSRF hardening OWASP audit", ["security"], "Security skill"),
                "ui-test-suite": ("UI React frontend layout component unit test vitest coverage", ["ui", "test"], "UI & tests skill"),
            }
            for sname, (desc, tags, tag_line) in local_specs.items():
                sdir = ws / ".claude" / "skills" / sname
                (sdir / "references").mkdir(parents=True, exist_ok=True)
                (sdir / "scripts").mkdir(parents=True, exist_ok=True)
                (sdir / "SKILL.md").write_text(
                    f"---\nname: {sname}\ndescription: {desc}\ntags: {json.dumps(tags)}\n---\n"
                    f"# {sname}\n{tag_line}. See `references/guide.md` and `scripts/check.sh`.\n",
                    encoding="utf-8",
                )
                (sdir / "references" / "guide.md").write_text(f"{sname} authoritative checklist\n", encoding="utf-8")
                (sdir / "scripts" / "check.sh").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")

            # Add colliding lower-priority user_global skill to verify project_local wins
            glob_dir = home / ".claude" / "skills" / "api-designer"
            glob_dir.mkdir(parents=True, exist_ok=True)
            (glob_dir / "SKILL.md").write_text(
                "---\nname: api-designer\ndescription: Global overridden API skill\ntags: [api]\n---\nShould lose to project_local.\n",
                encoding="utf-8",
            )

            manifest = build_skills_manifest(workspace_dir=ws, home=home, store=store, force_reload=True)
            api_entries = [s for s in manifest["skills"] if s["name"] == "api-designer"]
            self.assertEqual(len(api_entries), 1)
            self.assertEqual(api_entries[0]["scope"], "project_local")

            # Complex 4-domain prompt must load ALL 4 skills (no artificial cap!)
            prompt = (
                "Build a new REST OpenAPI endpoint with PostgreSQL SQL migration table schema, "
                "OAuth JWT security hardening, React UI component and unit tests +skill:ui-test-suite"
            )
            matched = select_all_matching_skills(prompt, manifest, agent_role="main")
            matched_names = {s["name"] for s in matched}
            self.assertTrue({"api-designer", "sql-migrator", "sec-hardener", "ui-test-suite"}.issubset(matched_names))

            bundle = load_composed_skill_bundle(matched)
            api_b = next(b for b in bundle if b["name"] == "api-designer")
            self.assertTrue(len(api_b["references"]) >= 1)
            self.assertTrue(any(p.endswith("scripts/check.sh") for p in api_b["scripts"]))

            # Quarantine mode must never load skills
            self.assertEqual(select_all_matching_skills(prompt, manifest, agent_role="quarantine"), [])

    def test_graphify_ast_fallback_ego_subgraph_and_blast_radius(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            src = ws / "src"
            src.mkdir(parents=True)
            (src / "auth_core.py").write_text("def verify_token(tok: str) -> bool:\n    return bool(tok)\n", encoding="utf-8")
            for i in range(6):
                (src / f"caller_{i}.py").write_text(
                    "from src.auth_core import verify_token\n\n"
                    f"def handle_{i}(x):\n    return verify_token(x)\n",
                    encoding="utf-8",
                )

            store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
            info = sync_and_load_graph(ws, store=store, bootstrap=True, force=True, prefer_cli=False)
            self.assertTrue(info["exists"])
            self.assertGreaterEqual(info["total_nodes"], 7)
            self.assertGreaterEqual(info["total_edges"], 6)

            sub = query_ego_subgraph(ws, "update auth_core verify_token validation")
            self.assertTrue(sub["available"])
            self.assertLess(sub["query_ms"], 50.0)
            self.assertGreaterEqual(sub["node_count"], 5)

            br = check_blast_radius(ws, "src/auth_core.py", min_callers=5)
            self.assertTrue(br["high_impact"])
            self.assertGreaterEqual(br["callers"], 6)

            # Hook Bus PreToolUse emits blast-radius alert cleanly
            rc, out, _ = handle_event(
                "PreToolUse",
                json.dumps({"cwd": str(ws), "tool_name": "Edit", "tool_input": {"file_path": str(src / "auth_core.py")}}),
                store=store,
                bypass_subprocesses=True,
            )
            self.assertEqual(rc, 0)
            self.assertIn("Graphify Blast-Radius Alert", json.loads(out)["systemMessage"])

        # Verify Graphify acts as default token-saving layer even before manual graph sync
        with tempfile.TemporaryDirectory() as td2:
            ws2 = Path(td2) / "ws2"
            ws2.mkdir()
            (ws2 / "core_mod.py").write_text("def compute():\n    return 7\n", encoding="utf-8")
            (ws2 / "unrelated.py").write_text("x = 1\n" * 600, encoding="utf-8")
            store2 = StateStore(runtime_dir=Path(td2) / "rt2", workspace_dir=ws2)
            dec2 = evaluate_fast_path("Update compute in core_mod", env={})
            res2 = compile_prompt_v2(dec2, workspace_dir=ws2, store=store2, engine=Gemini4Engine(env={"HOME": td2}))
            self.assertTrue(res2["subgraph"]["available"])
            self.assertGreater(res2["token_savings"]["saved_tokens"], 0)
            self.assertGreater(res2["token_savings"]["saved_pct"], 0)


class Gate5ClipboardIsolationTests(unittest.TestCase):
    """Gate 5: Inline turns never overwrite clipboard; standalone /reprompt nested fences copy cleanly."""

    def test_inline_never_touches_clipboard_vs_standalone_nested_fence(self) -> None:
        inner = "### Task Spec\n```python\ndef ping():\n    return 'ok'\n```\nVerify exit 0."
        fenced = format_standalone_fence(inner)
        self.assertTrue(fenced.startswith("````markdown"))
        extracted = extract_fenced_rewrite(f"Intro line\n\n{fenced}\n\nSummary bullet.")
        self.assertEqual(extracted, inner)

        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            ws.mkdir()
            clip_file = Path(td) / "clipboard.txt"
            store = StateStore(runtime_dir=Path(td) / "rt", workspace_dir=ws)
            old_clip = os.environ.get("WK_CLIPBOARD_FILE")
            os.environ["WK_CLIPBOARD_FILE"] = str(clip_file)
            try:
                # 1. Inline prompt must NEVER touch clipboard
                rc1, _, _ = handle_event(
                    "UserPromptSubmit",
                    json.dumps({"session_id": "s_inline", "cwd": str(ws), "prompt": "Fix spacing bug in button"}),
                    store=store,
                    bypass_subprocesses=True,
                )
                self.assertEqual(rc1, 0)
                handle_event(
                    "Stop",
                    json.dumps({"session_id": "s_inline", "cwd": str(ws), "last_assistant_message": "Done.\n````markdown\nignored\n````"}),
                    store=store,
                    bypass_subprocesses=True,
                )
                self.assertFalse(clip_file.exists(), "Inline turns must NEVER overwrite clipboard")

                # 2. Standalone /reprompt MUST copy clean nested fence on Stop
                rc2, out2, _ = handle_event(
                    "UserPromptSubmit",
                    json.dumps({"session_id": "s_solo", "cwd": str(ws), "prompt": "/reprompt Build OAuth PKCE proxy"}),
                    store=store,
                    bypass_subprocesses=True,
                )
                self.assertEqual(rc2, 0)
                self.assertIn("STANDALONE `/reprompt` MODE ACTIVE", out2)
                self.assertTrue((store.get_session("s_solo").get("standalone_reprompt") or {}).get("active"))

                rc_s, out_s, _ = handle_event(
                    "Stop",
                    json.dumps({"session_id": "s_solo", "cwd": str(ws), "last_assistant_message": f"Here is the prompt:\n\n{fenced}"}),
                    store=store,
                    bypass_subprocesses=True,
                )
                self.assertEqual(rc_s, 0)
                self.assertIn("copied rewritten prompt", out_s)
                self.assertTrue(clip_file.is_file())
                self.assertEqual(clip_file.read_text(encoding="utf-8"), inner)
                self.assertIsNone(store.get_session("s_solo").get("standalone_reprompt"))
            finally:
                if old_clip is None:
                    os.environ.pop("WK_CLIPBOARD_FILE", None)
                else:
                    os.environ["WK_CLIPBOARD_FILE"] = old_clip


class Gate6ChaosConcurrencyOfflineAndCliTests(unittest.TestCase):
    """Gate 6: 5-process flock concurrency, Stop incremental Graphify drain, offline fallback & /wk CLI/MCP."""

    def test_five_process_flock_concurrency_and_stop_drain(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            rt_dir = Path(td) / "rt"
            ws.mkdir()
            (ws / "mod.py").write_text("x = 1\n", encoding="utf-8")

            worker_code = (
                "import sys; sys.path.insert(0, sys.argv[1]); "
                "from core.state_store import StateStore; "
                "s = StateStore(runtime_dir=sys.argv[2], workspace_dir=sys.argv[3]); "
                "wid = int(sys.argv[4]); "
                "[s.record_prefix_cache('sha_' + str(wid % 2), hit=(i > 0)) for i in range(6)]; "
                "s.push_dirty_files([f'file_{wid}_{i}.py' for i in range(4)]); "
                "s.update_session('shared', lambda st: ("
                "st.__setitem__('subagent_depth', int(st.get('subagent_depth') or 0) + 1), "
                "st.__setitem__('last_compiled_criteria', list(st.get('last_compiled_criteria') or []) + [f'w_{wid}'])"
                "))"
            )
            procs = [
                subprocess.Popen([sys.executable, "-c", worker_code, str(ROOT), str(rt_dir), str(ws), str(wid)])
                for wid in range(5)
            ]
            for p in procs:
                self.assertEqual(p.wait(timeout=20), 0)

            store = StateStore(runtime_dir=rt_dir, workspace_dir=ws)
            stats = store.get_cache_stats()
            self.assertEqual(stats["hits"] + stats["misses"], 30)
            shared = store.get_session("shared")
            self.assertEqual(shared["subagent_depth"], 5)
            self.assertEqual(len(shared["last_compiled_criteria"]), 5)

            # Initialize baseline AST graph, then create a new file + enqueue PostToolUse -> Stop incremental drain
            sync_and_load_graph(ws, store=store, bootstrap=True, force=True, prefer_cli=False)
            (ws / "extra_mod.py").write_text("def extra():\n    return 99\n", encoding="utf-8")
            handle_event(
                "PostToolUse",
                json.dumps({"cwd": str(ws), "tool_name": "Write", "tool_input": {"file_path": str(ws / "extra_mod.py")}}),
                store=store,
                bypass_subprocesses=True,
            )
            rc_stop, _, _ = handle_event("Stop", json.dumps({"cwd": str(ws)}), store=store, bypass_subprocesses=True)
            self.assertEqual(rc_stop, 0)
            self.assertEqual(store.drain_dirty_files(), [])
            gdata = json.loads((ws / "graphify-out" / "graph.json").read_text(encoding="utf-8"))
            self.assertTrue(any("extra_mod.py" in str(n.get("source_file") or n.get("file") or "") for n in gdata.get("nodes", [])))

    def test_offline_degradation_and_wk_cli_plus_mcp_tools(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "ws"
            rt_dir = Path(td) / "rt"
            ws.mkdir()
            (ws / "app.py").write_text("def main():\n    return 42\n", encoding="utf-8")

            env_bak = {k: os.environ.get(k) for k in ("WATCHKEEPER_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "WK_RUNTIME_DIR")}
            for k in ("WATCHKEEPER_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
                os.environ.pop(k, None)
            os.environ["WK_RUNTIME_DIR"] = str(rt_dir)
            try:
                eng = Gemini4Engine(env={"HOME": td})
                dec = evaluate_fast_path("Refactor app entrypoint with tests", env={})
                res = compile_prompt_v2(dec, workspace_dir=ws, engine=eng, home=Path(td))
                self.assertTrue(res["ok"])
                self.assertEqual(res["backend"], "offline-local")
                self.assertIn("[WK-SPEC-V2:", res["compiled_text"])

                for argv, key in [
                    (["doctor"], "checks"),
                    (["status"], "version"),
                    (["mode", "confirm"], "mode"),
                    (["mode", "auto"], "mode"),
                    (["brain", "carbon-high"], "brain"),
                    (["brain", "adaptive-max"], "brain"),
                    (["skills", "reload"], "skill_count"),
                    (["skills", "match", "graph", "security"], "matched"),
                    (["graph", "sync"], "nodes"),
                    (["graph", "inspect", "main"], "subgraph"),
                ]:
                    code, payload = run_wk_cli(argv, workspace=str(ws))
                    self.assertEqual(code, 0, f"/wk {' '.join(argv)} failed: {payload}")
                    self.assertIn(key, payload)

                # MCP server wiring check for wk_doctor + wk_command
                sys.path.insert(0, str(ROOT / "reprompt"))
                from server.reprompt_engine import RePromptStore  # type: ignore  # noqa: E402
                from server.reprompt_mcp_server import TOOLS, execute_tool  # type: ignore  # noqa: E402

                tool_names = {t["name"] for t in TOOLS}
                self.assertIn("wk_doctor", tool_names)
                self.assertIn("wk_command", tool_names)
                rp_store = RePromptStore(data_dir=Path(td) / "rp_data")
                doc_out = execute_tool(rp_store, "wk_doctor", {"workspace": str(ws)})
                self.assertFalse(doc_out["isError"])
                self.assertTrue(doc_out["structuredContent"]["ok"])
                cmd_out = execute_tool(rp_store, "wk_command", {"command": "status", "workspace": str(ws)})
                self.assertFalse(cmd_out["isError"])
                self.assertEqual(cmd_out["structuredContent"]["version"], "2.0.0")
            finally:
                for k, v in env_bak.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v


if __name__ == "__main__":
    unittest.main(verbosity=2)
