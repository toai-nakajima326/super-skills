#!/bin/bash
# setup-hooks.sh — Detect installed AI tools and set up Virtual Context hooks for each.
# Run once after installing the skills repo, or re-run to update hooks.

set -euo pipefail

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v24.15.0/bin/node"
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
PLUGINS="/Users/mitsuru_nakajima/skills/plugins"

echo "Setting up Virtual Context hooks for all AI tools..."
echo ""

# ── Claude Code ──────────────────────────────────────────────
if [ -d "$HOME/.claude" ]; then
  echo "  Claude Code — hooks in settings.json (already configured)"
fi

# ── Codex ────────────────────────────────────────────────────
if [ -d "$HOME/.codex" ]; then
  echo "  Setting up Codex hooks..."
  CODEX_HOOKS="$HOME/.codex/hooks.json"
  if [ -f "$CODEX_HOOKS" ]; then
    # Merge: back up existing, then write new (manual merge if needed)
    cp "$CODEX_HOOKS" "$CODEX_HOOKS.bak"
    echo "    Backed up existing hooks.json to hooks.json.bak"
  fi
  cp "$PLUGINS/codex/hooks.json" "$CODEX_HOOKS"
  echo "  Codex — hooks.json installed at $CODEX_HOOKS"
fi

# ── Cursor ───────────────────────────────────────────────────
if [ -d "$HOME/.cursor" ]; then
  echo "  Setting up Cursor hooks..."
  CURSOR_HOOKS_DIR="$HOME/.cursor/hooks"
  mkdir -p "$CURSOR_HOOKS_DIR"
  cp "$PLUGINS/cursor/hooks.json" "$CURSOR_HOOKS_DIR/vcontext.json"
  echo "  Cursor — hooks installed at $CURSOR_HOOKS_DIR/vcontext.json"
fi

# ── Kiro ─────────────────────────────────────────────────────
if [ -d "$HOME/.kiro" ]; then
  echo "  Setting up Kiro hooks..."
  KIRO_HOOKS_DIR="$HOME/.kiro/hooks"
  mkdir -p "$KIRO_HOOKS_DIR"
  cp "$PLUGINS/kiro/hooks/vcontext-recall.md" "$KIRO_HOOKS_DIR/"
  cp "$PLUGINS/kiro/hooks/vcontext-store.md"  "$KIRO_HOOKS_DIR/"
  cp "$PLUGINS/kiro/hooks/vcontext-end.md"    "$KIRO_HOOKS_DIR/"
  echo "  Kiro — hooks installed at $KIRO_HOOKS_DIR/"
fi

echo ""
echo "Done! Virtual Context hooks are active for all detected tools."
