#!/bin/bash
# vcontext-migrate.sh — Migrate Virtual Context + Super Skills to a new PC
#
# Usage:
#   On OLD PC: ./vcontext-migrate.sh export
#   Transfer the .tar.gz to new PC
#   On NEW PC: ./vcontext-migrate.sh import <file.tar.gz>

set -euo pipefail

SKILLS_DIR="$HOME/skills"
DATA_DIR="$SKILLS_DIR/data"
EXPORT_DIR="/tmp/vcontext-migration"
NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'
info() { echo -e "${GREEN}[migrate]${NC} $*"; }
warn() { echo -e "${YELLOW}[migrate]${NC} $*"; }

case "${1:-}" in
  export)
    info "Exporting Virtual Context + Super Skills..."
    rm -rf "$EXPORT_DIR"
    mkdir -p "$EXPORT_DIR"

    # 1. Skills repo
    info "  Copying skills repo..."
    git -C "$SKILLS_DIR" bundle create "$EXPORT_DIR/skills-repo.bundle" --all 2>/dev/null

    # 2. SSD database (encrypted)
    info "  Encrypting databases..."
    if [ -f "$DATA_DIR/vcontext-ssd.db" ]; then
      $NODE "$SKILLS_DIR/scripts/vcontext-encrypt.js" export
      cp "$DATA_DIR/vcontext-export.enc" "$EXPORT_DIR/"
    fi

    # 3. API keys and config
    info "  Copying configs..."
    [ -f "$DATA_DIR/vcontext-api-keys.json" ] && cp "$DATA_DIR/vcontext-api-keys.json" "$EXPORT_DIR/"
    [ -f "$DATA_DIR/vcontext-cloud.json" ] && cp "$DATA_DIR/vcontext-cloud.json" "$EXPORT_DIR/"
    [ -f "$DATA_DIR/.vcontext-key" ] && cp "$DATA_DIR/.vcontext-key" "$EXPORT_DIR/"

    # 4. Global configs
    info "  Copying global settings..."
    [ -f "$HOME/.claude/CLAUDE.md" ] && cp "$HOME/.claude/CLAUDE.md" "$EXPORT_DIR/claude-md.bak"
    [ -f "$HOME/.claude/settings.json" ] && cp "$HOME/.claude/settings.json" "$EXPORT_DIR/claude-settings.bak"
    [ -f "$HOME/.codex/AGENTS.md" ] && cp "$HOME/.codex/AGENTS.md" "$EXPORT_DIR/codex-agents.bak"
    [ -f "$HOME/.codex/hooks.json" ] && cp "$HOME/.codex/hooks.json" "$EXPORT_DIR/codex-hooks.bak"

    # 5. Evolution log
    [ -f "$SKILLS_DIR/docs/evolution-log.md" ] && cp "$SKILLS_DIR/docs/evolution-log.md" "$EXPORT_DIR/"

    # Package
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    ARCHIVE="$HOME/vcontext-migration-$TIMESTAMP.tar.gz"
    tar -czf "$ARCHIVE" -C /tmp vcontext-migration
    rm -rf "$EXPORT_DIR"

    info "Export complete: $ARCHIVE"
    info "Transfer this file to the new PC and run:"
    info "  ./vcontext-migrate.sh import $ARCHIVE"
    ;;

  import)
    ARCHIVE="${2:-}"
    if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
      echo "Usage: $0 import <vcontext-migration-*.tar.gz>"
      exit 1
    fi

    info "Importing Virtual Context + Super Skills..."

    # Extract
    tar -xzf "$ARCHIVE" -C /tmp
    IMPORT_DIR="/tmp/vcontext-migration"

    # 1. Skills repo
    if [ -f "$IMPORT_DIR/skills-repo.bundle" ]; then
      info "  Restoring skills repo..."
      if [ -d "$SKILLS_DIR" ]; then
        warn "  $SKILLS_DIR already exists, pulling from bundle..."
        git -C "$SKILLS_DIR" pull "$IMPORT_DIR/skills-repo.bundle" main 2>/dev/null || true
      else
        git clone "$IMPORT_DIR/skills-repo.bundle" "$SKILLS_DIR"
      fi
    fi

    # 2. Data directory
    mkdir -p "$DATA_DIR"

    # 3. Encryption key
    if [ -f "$IMPORT_DIR/.vcontext-key" ]; then
      info "  Restoring encryption key..."
      cp "$IMPORT_DIR/.vcontext-key" "$DATA_DIR/"
      chmod 600 "$DATA_DIR/.vcontext-key"
    fi

    # 4. Decrypt database
    if [ -f "$IMPORT_DIR/vcontext-export.enc" ]; then
      info "  Decrypting database..."
      $NODE "$SKILLS_DIR/scripts/vcontext-encrypt.js" import "$IMPORT_DIR/vcontext-export.enc"
      cp "$DATA_DIR/vcontext-import.db" "$DATA_DIR/vcontext-ssd.db"
      rm -f "$DATA_DIR/vcontext-import.db"
    fi

    # 5. Configs
    [ -f "$IMPORT_DIR/vcontext-api-keys.json" ] && cp "$IMPORT_DIR/vcontext-api-keys.json" "$DATA_DIR/"
    [ -f "$IMPORT_DIR/vcontext-cloud.json" ] && cp "$IMPORT_DIR/vcontext-cloud.json" "$DATA_DIR/"

    # 6. Build and deploy
    info "  Building and deploying skills..."
    cd "$SKILLS_DIR"
    npm run build 2>/dev/null || node scripts/build-all.js
    ./scripts/sync-upstream.sh --deploy 2>/dev/null || true

    # 7. Setup hooks
    info "  Setting up hooks..."
    bash "$SKILLS_DIR/scripts/setup-hooks.sh"

    # 8. Setup RAM disk and server
    info "  Starting vcontext server..."
    bash "$SKILLS_DIR/scripts/vcontext-setup.sh" start

    # 9. Install launchd
    bash "$SKILLS_DIR/scripts/vcontext-setup.sh" install 2>/dev/null || true

    rm -rf "$IMPORT_DIR"

    info "Import complete!"
    info "  Skills: $(ls $HOME/.claude/skills/ 2>/dev/null | wc -l | tr -d ' ') deployed"
    info "  Server: $(curl -s http://localhost:3150/health 2>/dev/null | grep -o '"status":"[^"]*"' || echo 'starting...')"
    info ""
    info "You may need to restart your AI tools for hooks to take effect."
    ;;

  *)
    echo "vcontext-migrate — Migrate Virtual Context to a new PC"
    echo ""
    echo "Usage:"
    echo "  $0 export              Export everything to a .tar.gz"
    echo "  $0 import <file.gz>    Import from a migration archive"
    echo ""
    echo "What's included:"
    echo "  - Skills repo (git bundle)"
    echo "  - Virtual context database (encrypted)"
    echo "  - API keys and cloud config"
    echo "  - Global settings (CLAUDE.md, settings.json, AGENTS.md)"
    echo "  - Evolution log"
    ;;
esac
