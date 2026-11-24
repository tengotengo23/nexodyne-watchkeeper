#!/usr/bin/env python3
"""Unified CLI entrypoint for the Gemini + Claude Quota & Spend-Aware Orchestrator."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.orchestrator import Orchestrator  # noqa: E402
from server.reprompt_engine import RePromptStore, default_data_dir  # noqa: E402


def _build_orchestrator(data_dir: str = "") -> Orchestrator:
    dd = Path(data_dir) if data_dir else default_data_dir()
    store = RePromptStore(dd)
    return Orchestrator(data_dir=dd, settings=store.load_settings())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gemini + Claude Quota & Spend-Aware Orchestrator CLI")
    parser.add_argument("--data-dir", default="", help="Override persistent data directory")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")

    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Show Gemini & Claude plugin status, quotas, and spend pacing")

    p_plan = sub.add_parser("plan", help="Preview routing decision without executing")
    p_plan.add_argument("task", help="Task description")
    p_plan.add_argument("--role", default="auto", choices=["auto", "execution", "orchestrator", "planning"])
    p_plan.add_argument("--context", default="", help="Inline context string")
    p_plan.add_argument("--context-file", default="", help="Path to context file")
    p_plan.add_argument("--override", default="", choices=["", "gemini", "claude"])
    p_plan.add_argument("--cap", action="append", default=[], help="Required capability (repeatable)")
    p_plan.add_argument("--session-id", default="default", help="Session id for auto skill Load/Unload tracking")
    p_plan.add_argument("--no-auto-skills", action="store_true", help="Disable automatic skill judging")

    p_run = sub.add_parser("run", help="Route and execute a task or multi-step workflow")
    p_run.add_argument("task", help="Task description")
    p_run.add_argument("--role", default="auto", choices=["auto", "execution", "orchestrator", "planning"])
    p_run.add_argument("--context", default="", help="Inline context string")
    p_run.add_argument("--context-file", default="", help="Path to context file")
    p_run.add_argument("--override", default="", choices=["", "gemini", "claude"])
    p_run.add_argument("--strict-override", action="store_true")
    p_run.add_argument("--subtask", action="append", default=[], help="Subtask to fan out (repeatable)")
    p_run.add_argument("--cap", action="append", default=[], help="Required capability (repeatable)")
    p_run.add_argument("--session-id", default="default", help="Session id for auto skill Load/Unload tracking")
    p_run.add_argument("--no-auto-skills", action="store_true", help="Disable automatic skill judging")
    p_run.add_argument("--dry-run", action="store_true", help="Only compute route decision")

    p_cfg = sub.add_parser("config", help="Update budget/pacing configuration")
    p_cfg.add_argument("--gemini-budget", type=float)
    p_cfg.add_argument("--claude-budget", type=float)
    p_cfg.add_argument("--gemini-tokens", type=int)
    p_cfg.add_argument("--claude-tokens", type=int)
    p_cfg.add_argument("--preserve-threshold", type=float)

    sub.add_parser("reset", help="Reset daily usage and cooldown counters")

    args = parser.parse_args(argv)
    orch = _build_orchestrator(args.data_dir)

    if args.cmd == "status":
        st = orch.status()
        if args.json:
            print(json.dumps(st, indent=2))
        else:
            print(f"Overall Status: {st['overall_status']} (Date: {st['date']})")
            for p in ("gemini", "claude"):
                info = st["integrations"][p]
                u = st["usage"][p]
                print(
                    f"  {p.upper():6s}: ready={info['available']} via={info['primary_channel']} | "
                    f"spend=${u['spend_usd']:.4f}/${u['daily_budget_usd']:.2f} | "
                    f"tokens={u['tokens_used']:,}/{u['daily_token_limit']:,} | "
                    f"cooldown={'YES' if u['in_cooldown'] else 'no'}"
                )
            print(f"  Estimated Claude Spend Saved: ${st['claude_savings_usd']:.4f}")
        return 0

    if args.cmd in ("plan", "run"):
        ctx = args.context or ""
        if args.context_file:
            ctx = (ctx + "\n" + Path(args.context_file).read_text(encoding="utf-8", errors="replace")).strip()
        override = args.override or None

        if args.cmd == "plan" or getattr(args, "dry_run", False):
            dec = orch.preview_route(
                task=args.task,
                context=ctx,
                role=args.role,
                required_capabilities=args.cap,
                override_provider=override,
                auto_skills=not getattr(args, "no_auto_skills", False),
                session_id=getattr(args, "session_id", "default"),
            )
            if args.json:
                print(json.dumps(dec, indent=2))
            else:
                sj = dec.get("skill_judgment") or {}
                sk_str = ""
                if sj.get("load_skills") or sj.get("unload_skills"):
                    l_names = ", ".join(s["name"] for s in (sj.get("load_skills") or [])) or "none"
                    u_names = ", ".join(u["name"] for u in (sj.get("unload_skills") or [])) or "none"
                    sk_str = f"\nSkills: Load=[{l_names}] | Unload=[{u_names}]"
                print(
                    f"[Route Preview] provider={dec['provider']} channel={dec['channel']} "
                    f"model={dec['model']} reason={dec['reason_code']}\n"
                    f"Summary: {dec['reason_summary']}\n"
                    f"Tokens~: {dec['estimated_tokens']:,} | Claude Savings~: ${dec['claude_savings_usd']:.4f}{sk_str}"
                )
            return 0 if dec.get("provider") else 1

        res = orch.orchestrate_workflow(
            task=args.task,
            context=ctx,
            subtasks=args.subtask,
            role=args.role,
            required_capabilities=args.cap,
            override_provider=override,
            strict_override=args.strict_override,
            auto_skills=not getattr(args, "no_auto_skills", False),
            session_id=getattr(args, "session_id", "default"),
        )
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            sj = res.get("skill_judgment") or {}
            sk_str = ""
            if sj.get("load_skills") or sj.get("unload_skills"):
                l_names = ", ".join(s["name"] for s in (sj.get("load_skills") or [])) or "none"
                u_names = ", ".join(u["name"] for u in (sj.get("unload_skills") or [])) or "none"
                sk_str = f"\n[Skills: Load={l_names} | Unload={u_names}]"
            print(
                f"[Executed via {res['provider']} · {res['model']} ({res['channel']}) | {res['reason_summary']}]{sk_str}\n\n"
                f"{res['output']}"
            )
        return 0

    if args.cmd == "config":
        updates: dict = {}
        if args.gemini_budget is not None:
            updates.setdefault("gemini", {})["dailyBudgetUsd"] = args.gemini_budget
        if args.claude_budget is not None:
            updates.setdefault("claude", {})["dailyBudgetUsd"] = args.claude_budget
        if args.gemini_tokens is not None:
            updates.setdefault("gemini", {})["dailyTokenLimit"] = args.gemini_tokens
        if args.claude_tokens is not None:
            updates.setdefault("claude", {})["dailyTokenLimit"] = args.claude_tokens
        if args.preserve_threshold is not None:
            updates["claudePreserveThreshold"] = args.preserve_threshold
        cfg = orch.ledger.update_config(updates)
        print(json.dumps(cfg, indent=2))
        return 0

    if args.cmd == "reset":
        fresh = orch.ledger.reset_usage()
        print(json.dumps(fresh, indent=2))
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

