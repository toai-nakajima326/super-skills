#!/bin/bash
# vcontext-deploy.sh — zero-downtime deploy from this worktree to the
# live scripts directory at $HOME/skills. Designed so Claude sessions
# currently running are never interrupted.
#
# Flow:
#   1. Validate: node --check on all .js, bash -n on all .sh
#   2. Snapshot live DB (rollback point)
#   3. Atomic swap: write to tmp-path + rename
#   4. Reload only what needs reloading:
#        - server: SIGHUP (graceful reload) OR kickstart -k
#        - watchdog/maintenance: no-op (they re-read script on each fire)
#        - hooks: no-op (spawned per-invocation)
#
# Usage:
#   ./scripts/vcontext-deploy.sh [--dry-run] [--component <name>]

set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_ROOT="$HOME/skills"
NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v24.15.0/bin/node"
DRY_RUN=0
COMPONENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --component) COMPONENT="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

[[ "$WORKTREE" == "$LIVE_ROOT" ]] && { err "Cannot deploy: you are in live dir"; exit 1; }

ok "Worktree: $WORKTREE"
ok "Live:     $LIVE_ROOT"
[[ $DRY_RUN -eq 1 ]] && warn "DRY RUN — no files written"

# ── 1. Validate ───────────────────────────────────────────────────
ok "Validating scripts..."
while IFS= read -r -d '' f; do
  "$NODE" --check "$f" || { err "node --check FAILED: $f"; exit 1; }
done < <(find "$WORKTREE/scripts" -maxdepth 2 -name '*.js' -print0 2>/dev/null)

while IFS= read -r -d '' f; do
  bash -n "$f" || { err "bash -n FAILED: $f"; exit 1; }
done < <(find "$WORKTREE/scripts" -maxdepth 2 -name '*.sh' -print0 2>/dev/null)

ok "All scripts passed syntax check"

# ── 2. Snapshot DB for rollback ───────────────────────────────────
if [[ $DRY_RUN -eq 0 ]]; then
  # Prune older pre-deploy snapshots first so frequent commits don't
  # blow past the retention budget. Keep 3 most recent.
  SNAP_DIR="$HOME/skills/data/snapshots"
  if [[ -d "$SNAP_DIR" ]]; then
    ls -1t "$SNAP_DIR"/vcontext-*-pre-deploy.db 2>/dev/null | tail -n +4 | while read f; do
      [[ -n "$f" ]] && rm -f "$f" && echo "[deploy] pruned $(basename "$f")"
    done
  fi
  ok "Creating pre-deploy snapshot..."
  "$NODE" "$WORKTREE/scripts/vcontext-hooks.js" snapshot "pre-deploy" || warn "Snapshot failed (non-fatal)"
fi

# ── 3. Diff changed files ────────────────────────────────────────
ok "Changed files:"
CHANGED=()
while IFS= read -r f; do
  rel="${f#$WORKTREE/}"
  live_f="$LIVE_ROOT/$rel"
  if [[ -f "$live_f" ]]; then
    if ! diff -q "$f" "$live_f" >/dev/null 2>&1; then
      CHANGED+=("$rel")
      echo "    M $rel"
    fi
  else
    CHANGED+=("$rel")
    echo "    + $rel"
  fi
done < <(find "$WORKTREE/scripts" -maxdepth 2 \( -name '*.js' -o -name '*.sh' -o -name '*.py' -o -name '*.html' \) -type f 2>/dev/null)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  ok "No changes — nothing to deploy"
  exit 0
fi

# ── 4. Atomic write ──────────────────────────────────────────────
if [[ $DRY_RUN -eq 0 ]]; then
  ok "Deploying ${#CHANGED[@]} file(s) atomically..."
  for rel in "${CHANGED[@]}"; do
    src="$WORKTREE/$rel"
    dst="$LIVE_ROOT/$rel"
    tmp="${dst}.deploy.$$"
    cp "$src" "$tmp"
    chmod --reference="$src" "$tmp" 2>/dev/null || chmod +x "$tmp"
    mv -f "$tmp" "$dst"   # atomic on same filesystem
    echo "    ✓ $rel"
  done
fi

# ── 5. Graceful reload ───────────────────────────────────────────
HOOKS_CHANGED=0
SERVER_CHANGED=0
SETUP_CHANGED=0
for rel in "${CHANGED[@]}"; do
  case "$rel" in
    scripts/vcontext-hooks.js|scripts/vcontext-hook-wrapper.sh) HOOKS_CHANGED=1;;
    scripts/vcontext-server.js) SERVER_CHANGED=1;;
    scripts/vcontext-setup.sh) SETUP_CHANGED=1;;
  esac
done

if [[ $HOOKS_CHANGED -eq 1 ]]; then
  ok "Hooks changed — no reload needed (spawned per-invocation)"
fi

if [[ $SERVER_CHANGED -eq 1 && $DRY_RUN -eq 0 ]]; then
  ok "Server changed — gracefully reloading..."
  # Health check live server before reload
  if curl -s --max-time 2 http://127.0.0.1:3150/health >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.vcontext.server" 2>&1 || warn "Kickstart failed"
    # Wait for health (up to 10s)
    for i in {1..10}; do
      if curl -s --max-time 1 http://127.0.0.1:3150/health >/dev/null 2>&1; then
        ok "Server healthy after reload (${i}s)"
        break
      fi
      sleep 1
    done
  else
    warn "Server not healthy pre-reload; skipping kickstart"
  fi
fi

if [[ $SETUP_CHANGED -eq 1 ]]; then
  ok "Setup script changed — takes effect on next ramdisk restart (not applied now)"
fi

ok "Deploy complete"
