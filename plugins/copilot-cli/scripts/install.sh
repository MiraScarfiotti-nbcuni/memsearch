#!/usr/bin/env bash
# Install the memsearch GitHub Copilot CLI extension.
#
# This script:
# 1. Checks memsearch availability (installs via uvx if needed)
# 2. Symlinks the extension to ~/.copilot/extensions/memsearch/
# 3. Copies the memory-recall skill (with path substitution) to ~/.agents/skills/
# 4. Prints setup instructions

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== memsearch GitHub Copilot CLI Extension Installer ==="
echo "Install directory: $INSTALL_DIR"
echo ""

# ── 1. Check memsearch ──────────────────────────────────────────────────────
echo "[1/4] Checking memsearch..."
if command -v memsearch &>/dev/null; then
  MS_VERSION=$(memsearch --version 2>/dev/null || echo "unknown")
  echo "  ✓ memsearch found: $(command -v memsearch) ($MS_VERSION)"
elif command -v uvx &>/dev/null; then
  echo "  ✓ uvx found — will use: uvx --from 'memsearch[onnx]' memsearch"
  echo "  Warming up cache (first run may take ~30s)..."
  uvx --from 'memsearch[onnx]' memsearch --version 2>/dev/null || true
else
  echo "  ✗ memsearch not found. Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  echo "  Warming up uvx cache (first run may take ~30s)..."
  uvx --from 'memsearch[onnx]' memsearch --version 2>/dev/null || true
fi
echo ""

# ── 2. Install extension to ~/.copilot/extensions/memsearch/ ────────────────
echo "[2/4] Installing Copilot CLI extension..."
COPILOT_EXT_DIR="${HOME}/.copilot/extensions/memsearch"
mkdir -p "${COPILOT_EXT_DIR}"

EXT_LINK="${COPILOT_EXT_DIR}/extension.mjs"
if [ -L "${EXT_LINK}" ] || [ -f "${EXT_LINK}" ]; then
  echo "  ⚠ Existing extension found at ${EXT_LINK} — replacing"
  rm -f "${EXT_LINK}"
fi

ln -sf "${INSTALL_DIR}/extension.mjs" "${EXT_LINK}"
echo "  ✓ Extension symlinked: ${EXT_LINK}"
echo "     → ${INSTALL_DIR}/extension.mjs"
echo ""

# ── 3. Install memory-recall skill ──────────────────────────────────────────
echo "[3/4] Installing memory-recall skill..."
SKILL_SRC="${INSTALL_DIR}/skills/memory-recall"
AGENTS_SKILL_DST="${HOME}/.agents/skills/memory-recall"
mkdir -p "${HOME}/.agents/skills"

if [ -d "${AGENTS_SKILL_DST}" ] || [ -L "${AGENTS_SKILL_DST}" ]; then
  echo "  ⚠ Existing memory-recall skill found — replacing"
  rm -rf "${AGENTS_SKILL_DST}"
fi

# Copy (not symlink) so __INSTALL_DIR__ placeholder can be substituted
cp -r "${SKILL_SRC}" "${AGENTS_SKILL_DST}"

# Substitute __INSTALL_DIR__ placeholder in SKILL.md
if [ -f "${AGENTS_SKILL_DST}/SKILL.md" ]; then
  python3 - "${AGENTS_SKILL_DST}/SKILL.md" "__INSTALL_DIR__" "${INSTALL_DIR}" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace(sys.argv[2], sys.argv[3]))
PY
  echo "  ✓ Skill installed: ${AGENTS_SKILL_DST}"
  echo "     (INSTALL_DIR set to ${INSTALL_DIR})"
fi
echo ""

# ── 4. Make scripts executable ──────────────────────────────────────────────
echo "[4/4] Setting permissions..."
chmod +x "${INSTALL_DIR}/scripts/"*.sh
echo "  ✓ Scripts marked executable"
echo ""

echo "=== Installation Complete ==="
echo ""
echo "What happens automatically in every Copilot CLI session:"
echo "  • onSessionStart: indexes project memory, injects recent context"
echo "  • onSessionEnd:   saves the session transcript to .memsearch/memory/"
echo "  • memsearch_search / memsearch_expand tools available to the agent"
echo ""
echo "Pull-based recall skill (requires \$memory-recall support):"
echo "  \$memory-recall what did we discuss about Redis?"
echo ""
echo "Memory files:      <project>/.memsearch/memory/*.md"
echo "Extension link:    ${EXT_LINK}"
echo "Skill location:    ${AGENTS_SKILL_DST}"
echo ""
echo "To verify: start a new copilot session — look for [memsearch] Memory active."
