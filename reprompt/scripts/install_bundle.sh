#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
ZIP_PATH="${DIST_DIR}/re-prompt-skill-suite.zip"
INSTALL_DIR="${HOME}/.gemini/config/plugins/re-prompt"
VAULT_INDEX="${HOME}/.gemini/skill-vault/index.json"

package_zip() {
  mkdir -p "${DIST_DIR}"
  python3 - "${ROOT_DIR}" "${ZIP_PATH}" <<'PY'
import os
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
out_zip = Path(sys.argv[2]).resolve()
exclude_dirs = {"dist", "__pycache__", ".git", ".pytest_cache", ".mypy_cache"}

if out_zip.exists():
    out_zip.unlink()

with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in exclude_dirs)
        for fname in sorted(filenames):
            if fname.endswith((".pyc", ".pyo")):
                continue
            fpath = Path(dirpath) / fname
            if fpath.resolve() == out_zip:
                continue
            rel = fpath.relative_to(root).as_posix()
            zf.write(fpath, rel)
print(f"Created package: {out_zip} ({out_zip.stat().st_size} bytes)")
PY
}

install_plugin() {
  if command -v agy >/dev/null 2>&1; then
    agy plugin validate "${ROOT_DIR}" --strict >/dev/null
  fi

  mkdir -p "$(dirname "${INSTALL_DIR}")"
  local tmp_dir="${INSTALL_DIR}.tmp.$$"
  rm -rf "${tmp_dir}"
  mkdir -p "${tmp_dir}"

  python3 - "${ROOT_DIR}" "${tmp_dir}" <<'PY'
import os
import shutil
import sys
from pathlib import Path

src = Path(sys.argv[1]).resolve()
dst = Path(sys.argv[2]).resolve()
exclude_dirs = {"dist", "__pycache__", ".git", ".pytest_cache", ".mypy_cache"}

for dirpath, dirnames, filenames in os.walk(src):
    dirnames[:] = sorted(d for d in dirnames if d not in exclude_dirs)
    rel_dir = Path(dirpath).relative_to(src)
    (dst / rel_dir).mkdir(parents=True, exist_ok=True)
    for fname in filenames:
        if fname.endswith((".pyc", ".pyo")):
            continue
        shutil.copy2(Path(dirpath) / fname, dst / rel_dir / fname)
PY

  chmod +x "${tmp_dir}/scripts/"*.py "${tmp_dir}/scripts/"*.sh 2>/dev/null || true
  rm -rf "${INSTALL_DIR}"
  mv "${tmp_dir}" "${INSTALL_DIR}"
  echo "Installed plugin to: ${INSTALL_DIR}"

  if [[ ! -f "${VAULT_INDEX}" ]]; then
    echo "Vault index missing; syncing repositories into ~/.gemini/skill-vault ..."
    python3 "${INSTALL_DIR}/scripts/skill_vault.py" sync
  else
    echo "Existing skill vault detected at ${VAULT_INDEX}."
  fi

  if command -v agy >/dev/null 2>&1; then
    agy plugin validate "${INSTALL_DIR}" --strict
  fi
}

case "${1:-}" in
  --package)
    package_zip
    ;;
  --all)
    package_zip
    install_plugin
    ;;
  "")
    install_plugin
    ;;
  *)
    echo "Usage: $0 [--package | --all]" >&2
    exit 1
    ;;
esac

