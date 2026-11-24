#!/usr/bin/env python3
"""Cross-platform installer for Re-Prompt (Antigravity Plugin, IDE .vsix, Claude Code Plugin)."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def install_antigravity_plugin() -> None:
    target = Path.home() / ".gemini" / "config" / "plugins" / "re-prompt"
    zips = sorted(DIST.glob("re-prompt-antigravity-plugin-*.zip"))
    if not zips:
        raise FileNotFoundError("Missing Antigravity plugin zip in dist/. Run scripts/build_dist.py first.")
    pkg_zip = zips[-1]

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(pkg_zip, "r") as zf:
        zf.extractall(target)

    mcp_script = target / "server" / "reprompt_mcp_server.py"
    if os.name == "posix" and mcp_script.is_file():
        mcp_script.chmod(0o755)
    print(f"[OK] Installed Antigravity Plugin to: {target}")


def _find_ide_cli() -> str | None:
    candidates = [
        "antigravity-ide",
        "antigravity",
        "code",
        "cursor",
    ]
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found

    home = Path.home()
    extra = [
        home / "Antigravity IDE" / "bin" / "antigravity-ide",
        Path("/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"),
        Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
    ]
    if os.name == "nt":
        local_app = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        extra.extend([
            local_app / "Programs" / "Antigravity IDE" / "bin" / "antigravity-ide.cmd",
            local_app / "Programs" / "Microsoft VS Code" / "bin" / "code.cmd",
        ])
    for p in extra:
        if p.is_file():
            return str(p)
    return None


def install_ide_vsix() -> None:
    vsixs = sorted(DIST.glob("re-prompt-*.vsix"))
    if not vsixs:
        raise FileNotFoundError("Missing .vsix in dist/. Run scripts/build_dist.py first.")
    vsix = vsixs[-1]

    cli = _find_ide_cli()
    if not cli:
        print(f"[SKIP] IDE CLI not auto-detected. Manually install VSIX via Extensions -> Install from VSIX: {vsix}")
        return
    proc = subprocess.run([cli, "--install-extension", str(vsix)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"IDE extension install failed ({cli}): {proc.stderr or proc.stdout}")
    print(f"[OK] Installed IDE Extension via {cli}: {vsix.name}")


def install_claude_plugin() -> None:
    target = Path.home() / ".claude" / "plugins" / "re-prompt"
    zips = sorted(DIST.glob("re-prompt-claude-plugin-*.zip"))
    if not zips:
        raise FileNotFoundError("Missing Claude Code plugin zip in dist/. Run scripts/build_dist.py first.")
    pkg_zip = zips[-1]

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(pkg_zip, "r") as zf:
        zf.extractall(target)
    print(f"[OK] Installed Claude Code Plugin to: {target}")
    print(f"     Run Claude Code with: claude --plugin-dir \"{target}\"")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install Re-Prompt across Antigravity, Antigravity IDE/VS Code, and Claude Code")
    parser.add_argument("--antigravity", action="store_true", help="Install Antigravity Plugin")
    parser.add_argument("--ide", action="store_true", help="Install Antigravity IDE / VS Code .vsix extension")
    parser.add_argument("--claude", action="store_true", help="Install Claude Code plugin")
    parser.add_argument("--all", action="store_true", help="Install all components (default if no flag given)")
    args = parser.parse_args()

    run_all = args.all or not (args.antigravity or args.ide or args.claude)
    if run_all or args.antigravity:
        install_antigravity_plugin()
    if run_all or args.ide:
        install_ide_vsix()
    if run_all or args.claude:
        install_claude_plugin()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
