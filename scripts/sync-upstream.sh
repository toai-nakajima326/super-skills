#!/bin/bash
set -euo pipefail

# Sync upstream (takurot/super-skills) changes, rebuild, and deploy to ~/.claude/skills/
#
# Usage:
#   ./scripts/sync-upstream.sh          # Fetch + merge + build + deploy
#   ./scripts/sync-upstream.sh --check  # Fetch only, show what's new
#   ./scripts/sync-upstream.sh --deploy # Build + deploy only (no upstream fetch)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GLOBAL_SKILLS="$HOME/.claude/skills"

cd "$ROOT"

# ─── Parse args ──────────────────────────────────────────────────────
MODE="full"
if [[ "${1:-}" == "--check" ]]; then MODE="check"; fi
if [[ "${1:-}" == "--deploy" ]]; then MODE="deploy"; fi

# ─── Colors ───────��──────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[sync]${NC} $*"; }
warn()  { echo -e "${YELLOW}[sync]${NC} $*"; }
error() { echo -e "${RED}[sync]${NC} $*"; }

# ─── Deploy only ─────────────────────────────────────────────────────
if [[ "$MODE" == "deploy" ]]; then
  info "Building Claude Code skills..."
  node scripts/build-claude-skills.js

  info "Deploying to $GLOBAL_SKILLS..."
  rm -rf "$GLOBAL_SKILLS"
  cp -r .claude/skills/ "$GLOBAL_SKILLS"

  SKILL_COUNT=$(ls "$GLOBAL_SKILLS" | wc -l | tr -d ' ')
  info "Deployed $SKILL_COUNT skills to $GLOBAL_SKILLS"
  exit 0
fi

# ─── Fetch upstream ────────���───────────────────────────────────���─────
info "Fetching upstream (takurot/super-skills)..."
if ! git remote get-url upstream &>/dev/null; then
  error "No upstream remote. Run: git remote add upstream https://github.com/takurot/super-skills.git"
  exit 1
fi

git fetch upstream

# ─── Check mode: show diff and exit ─────────────────────────────���───
if [[ "$MODE" == "check" ]]; then
  echo ""
  info "Changes available from upstream:"
  echo ""

  # Show new/changed files in upstream/main vs local
  DIFF=$(git diff --stat HEAD..upstream/main -- skills/ 2>/dev/null || echo "")
  if [[ -z "$DIFF" ]]; then
    info "No new changes from upstream."
  else
    echo "$DIFF"
    echo ""
    # Show new skill directories
    NEW_SKILLS=$(git diff --name-only HEAD..upstream/main -- skills/ 2>/dev/null | grep 'SKILL.md' | sed 's|skills/||;s|/SKILL.md||' | sort -u)
    if [[ -n "$NEW_SKILLS" ]]; then
      info "Skills with changes:"
      echo "$NEW_SKILLS" | while read -r s; do echo "  - $s"; done
    fi
  fi
  exit 0
fi

# ─── Full sync: merge + build + deploy ─────────────��─────────────────
info "Merging upstream/main..."

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  error "Uncommitted changes detected. Commit or stash first."
  exit 1
fi

# Merge upstream (only skills/ and scripts/ — skip their host-specific outputs)
git merge upstream/main --no-edit --allow-unrelated-histories 2>/dev/null || {
  warn "Merge conflict detected. Resolve manually, then run:"
  warn "  ./scripts/sync-upstream.sh --deploy"
  exit 1
}

info "Merge complete."

# Validate
info "Validating skills..."
node scripts/validate-skills.js

# Build
info "Building Claude Code skills..."
node scripts/build-claude-skills.js

# Deploy
info "Deploying to $GLOBAL_SKILLS..."
rm -rf "$GLOBAL_SKILLS"
cp -r .claude/skills/ "$GLOBAL_SKILLS"

SKILL_COUNT=$(ls "$GLOBAL_SKILLS" | wc -l | tr -d ' ')
info "Deployed $SKILL_COUNT skills to $GLOBAL_SKILLS"

echo ""
info "Done! Upstream changes merged and deployed."
