#!/usr/bin/env python3
"""Build Re-Prompt distributables: PNG icon, Antigravity Plugin ZIP, IDE .vsix, Claude Code ZIP."""

from __future__ import annotations

import json
import math
import shutil
import struct
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ASSETS = ROOT / "assets"
IDE_DIR = ROOT / "ide-extension"
IDE_MEDIA = IDE_DIR / "media"
CLAUDE_DIR = ROOT / "claude-code-plugin"


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else (hi if v > hi else v)


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = _clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def _dist_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0.0:
        return math.hypot(px - ax, py - ay)
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return math.hypot(px - bx, py - by)
    t = c1 / c2
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _dist_round_rect(px: float, py: float, cx: float, cy: float, half_w: float, half_h: float, r: float) -> float:
    qx = abs(px - cx) - (half_w - r)
    qy = abs(py - cy) - (half_h - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def _blend(dst: list[float], r: float, g: float, b: float, a: float) -> None:
    a = _clamp(a)
    if a <= 0.0:
        return
    inv = 1.0 - a
    dst[0] = dst[0] * inv + r * a
    dst[1] = dst[1] * inv + g * a
    dst[2] = dst[2] * inv + b * a
    dst[3] = 1.0 - (1.0 - dst[3]) * inv


def generate_icon_png(out_path: Path, size: int = 128) -> None:
    """Render an anti-aliased 128x128 RGBA PNG icon using pure Python stdlib."""
    raw_rows = bytearray()
    for y in range(size):
        raw_rows.append(0)  # PNG filter type 0
        for x in range(size):
            px = x + 0.5
            py = y + 0.5
            rgba = [0.0, 0.0, 0.0, 0.0]

            # Rounded badge (13..115)
            d_bg = _dist_round_rect(px, py, 64.0, 64.0, 51.0, 51.0, 24.0)
            a_bg = 1.0 - _smoothstep(-1.0, 1.0, d_bg)
            if a_bg > 0.0:
                t = _clamp(((px - 14.0) + (py - 14.0)) / 200.0)
                r = (49 * (1 - t) + 14 * t) / 255.0
                g = (46 * (1 - t) + 165 * t) / 255.0
                b = (129 * (1 - t) + 233 * t) / 255.0
                _blend(rgba, r, g, b, a_bg)

                # Subtle inner border
                if abs(d_bg + 1.2) < 2.2:
                    a_ring = (1.0 - _smoothstep(0.0, 2.0, abs(d_bg + 1.2))) * 0.32 * a_bg
                    _blend(rgba, 0.88, 0.91, 1.0, a_ring)

            # Left bracket '<'
            d_left = min(
                _dist_segment(px, py, 40.0, 46.0, 27.0, 64.0),
                _dist_segment(px, py, 27.0, 64.0, 40.0, 82.0),
            ) - 3.6
            _blend(rgba, 1.0, 1.0, 1.0, 1.0 - _smoothstep(-0.9, 0.9, d_left))

            # Right bracket '>'
            d_right = min(
                _dist_segment(px, py, 62.0, 46.0, 75.0, 64.0),
                _dist_segment(px, py, 75.0, 64.0, 62.0, 82.0),
            ) - 3.6
            _blend(rgba, 0.65, 0.95, 0.99, 1.0 - _smoothstep(-0.9, 0.9, d_right))

            # Center slash '/'
            d_slash = _dist_segment(px, py, 46.0, 78.0, 56.0, 50.0) - 3.0
            _blend(rgba, 0.88, 0.95, 1.0, 1.0 - _smoothstep(-0.9, 0.9, d_slash))

            # 4-point sparkle at (90, 40)
            dx = abs(px - 90.0) / 12.0
            dy = abs(py - 40.0) / 12.0
            d_spark = (dx ** 0.55 + dy ** 0.55 - 1.0) * 10.0
            a_spark = 1.0 - _smoothstep(-1.0, 1.0, d_spark)
            if a_spark > 0.0:
                _blend(rgba, 0.99, 0.94, 0.54, a_spark)

            # Refinement curve + arrowhead
            arc_r = math.hypot(px - 79.0, py - 68.0)
            in_quadrant = px >= 78.0 and py >= 67.0
            d_arc = abs(arc_r - 16.0) - 2.8 if in_quadrant else 10.0
            d_arrow = min(
                d_arc,
                _dist_segment(px, py, 89.0, 69.0, 95.0, 63.0) - 2.8,
                _dist_segment(px, py, 95.0, 63.0, 101.0, 69.0) - 2.8,
            )
            _blend(rgba, 1.0, 1.0, 1.0, 1.0 - _smoothstep(-0.9, 0.9, d_arrow))

            # Un-premultiply? rgba already accumulated over transparent; clamp 0..255
            raw_rows.extend(
                [
                    int(_clamp(rgba[0]) * 255 + 0.5),
                    int(_clamp(rgba[1]) * 255 + 0.5),
                    int(_clamp(rgba[2]) * 255 + 0.5),
                    int(_clamp(rgba[3]) * 255 + 0.5),
                ]
            )

    def _chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=9)
    png_bytes = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes)


def sync_shared_assets() -> None:
    IDE_MEDIA.mkdir(parents=True, exist_ok=True)
    generate_icon_png(ASSETS / "icon.png", 128)
    shutil.copy2(ASSETS / "icon.png", IDE_MEDIA / "icon.png")
    shutil.copy2(ASSETS / "logo.svg", IDE_MEDIA / "icon.svg")
    shutil.copy2(ROOT / "ui" / "reprompt_app.html", IDE_MEDIA / "reprompt_app.html")
    shutil.copy2(ROOT / "LICENSE", IDE_DIR / "LICENSE")


def _add_file_to_zip(zf: zipfile.ZipFile, src: Path, arcname: str) -> None:
    info = zipfile.ZipInfo(arcname)
    info.date_time = (2026, 11, 21, 12, 0, 0)
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = src.stat().st_mode & 0o777
    info.external_attr = (mode << 16)
    zf.writestr(info, src.read_bytes())


def _add_bytes_to_zip(zf: zipfile.ZipFile, data: bytes, arcname: str) -> None:
    info = zipfile.ZipInfo(arcname)
    info.date_time = (2026, 11, 21, 12, 0, 0)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o644 << 16)
    zf.writestr(info, data)


def build_antigravity_plugin_zip(version: str) -> Path:
    out_zip = DIST / f"re-prompt-antigravity-plugin-{version}.zip"
    include_files = [
        "plugin.json",
        "mcp_config.json",
        "hooks.json",
        "README.md",
        "LICENSE",
        "assets/logo.svg",
        "assets/icon.png",
        "rules/AGENTS.md",
        "skills/re-prompt/SKILL.md",
        "skills/duo-orchestrator/SKILL.md",
        "skills/profession-skill-vault/SKILL.md",
        "scripts/reprompt_skill_hook.py",
        "scripts/reprompt_inline_hook.py",
        "scripts/prompt_prefix.py",
        "scripts/orchestrate.py",
        "scripts/skill_router.py",
        "scripts/skill_vault.py",
        "scripts/proc_group.py",
        "scripts/sources.json",
        "scripts/install_bundle.sh",
        "server/__init__.py",
        "server/orchestrator.py",
        "server/reprompt_engine.py",
        "server/reprompt_mcp_server.py",
        "ui/reprompt_app.html",
    ]
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in include_files:
            src = ROOT / rel
            if not src.is_file():
                raise FileNotFoundError(f"Missing plugin file: {src}")
            _add_file_to_zip(zf, src, rel)
    return out_zip


def build_claude_plugin_zip(version: str) -> Path:
    out_zip = DIST / f"re-prompt-claude-plugin-{version}.zip"
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(CLAUDE_DIR.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                rel = path.relative_to(CLAUDE_DIR).as_posix()
                _add_file_to_zip(zf, path, rel)
        for rel in (
            "README.md",
            "LICENSE",
            "scripts/orchestrate.py",
            "scripts/reprompt_inline_hook.py",
            "scripts/reprompt_skill_hook.py",
            "scripts/prompt_prefix.py",
            "scripts/skill_router.py",
            "scripts/skill_vault.py",
            "scripts/proc_group.py",
            "scripts/sources.json",
            "server/__init__.py",
            "server/orchestrator.py",
            "server/reprompt_engine.py",
            "server/reprompt_mcp_server.py",
            "ui/reprompt_app.html",
        ):
            _add_file_to_zip(zf, ROOT / rel, rel)
    return out_zip


def build_vsix(version: str) -> Path:
    pkg = json.loads((IDE_DIR / "package.json").read_text(encoding="utf-8"))
    publisher = pkg["publisher"]
    name = pkg["name"]
    display_name = pkg["displayName"]
    desc = pkg["description"]
    out_vsix = DIST / f"{name}-{version}.vsix"

    content_types_xml = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
""".encode("utf-8")

    manifest_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{desc}</Description>
    <Tags>re-prompt,prompt,antigravity,claude-code,ai</Tags>
    <Categories>AI,Other,Programming Languages</Categories>
    <Icon>extension/media/icon.png</Icon>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
""".encode("utf-8")

    ext_files = [
        "package.json",
        "extension.js",
        "repromptEngine.js",
        "orchestrator.js",
        "README.md",
        "LICENSE",
        "media/icon.png",
        "media/icon.svg",
        "media/reprompt_app.html",
    ]
    with zipfile.ZipFile(out_vsix, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        _add_bytes_to_zip(zf, content_types_xml, "[Content_Types].xml")
        _add_bytes_to_zip(zf, manifest_xml, "extension.vsixmanifest")
        for rel in ext_files:
            src = IDE_DIR / rel
            if not src.is_file():
                raise FileNotFoundError(f"Missing extension file: {src}")
            _add_file_to_zip(zf, src, f"extension/{rel}")
    return out_vsix


def main() -> int:
    DIST.mkdir(parents=True, exist_ok=True)
    plugin_meta = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    version = plugin_meta.get("version", "1.0.0")

    sync_shared_assets()
    agy_zip = build_antigravity_plugin_zip(version)
    claude_zip = build_claude_plugin_zip(version)
    vsix_path = build_vsix(version)

    print(f"Built: {agy_zip}")
    print(f"Built: {claude_zip}")
    print(f"Built: {vsix_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
