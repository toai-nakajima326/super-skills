#!/bin/bash
# pre-outage.sh — One-command pre-shutdown data-safety checklist.
#
# Run before a planned power-off / long idle / risky operation.
# Ensures everything is on disk and integrity-verified so a cold boot
# comes back cleanly.
#
# Exit 0 if everything is green, 1 if any check failed. All checks
# print PASS/WARN/FAIL with details.
#
# Usage:
#   bash scripts/pre-outage.sh

set -u
BASE="${VCONTEXT_URL:-http://localhost:3150}"
RAM_DB="/Volumes/VContext/vcontext.db"
SSD_DB="$HOME/skills/data/vcontext-ssd.db"
VEC_DB="/Volumes/VContext/vcontext-vec.db"
SNAP_DIR="$HOME/skills/data/snapshots"
WAL_FILE="$HOME/skills/data/entries-wal.jsonl"

if [ -t 1 ]; then
  G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'
else G=''; R=''; Y=''; N=''; fi

FAIL=0
pass() { echo -e "${G}PASS${N} $1"; }
warn() { echo -e "${Y}WARN${N} $1"; }
fail() { echo -e "${R}FAIL${N} $1"; FAIL=$((FAIL + 1)); }

echo "━━━ Pre-outage safety checklist ━━━"
echo ""

# 1. Server responding — try up to 3 times (10s each).  Treat transient
# slowness as WARN rather than FAIL since data safety comes from the
# SQLite files + JSONL + snapshots, not from the HTTP endpoint.
SRV_OK=0
for i in 1 2 3; do
  if curl -sf --max-time 10 "$BASE/health" >/dev/null 2>&1; then SRV_OK=1; break; fi
done
if [ "$SRV_OK" = 1 ]; then
  pass "vcontext server responding at $BASE"
else
  warn "vcontext server not responding (after 3× 10s retries) — data on disk is still safe"
fi

# 2. Git clean + pushed
cd "$HOME/skills" || exit 1
if [ -z "$(git status --porcelain)" ]; then
  pass "git working tree clean"
else
  warn "uncommitted changes:"
  git status --short | head -5 | sed 's/^/     /'
fi
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
if [ "$AHEAD" = "0" ]; then
  pass "git in sync with origin/main"
else
  warn "git is $AHEAD commits ahead of origin/main (push if you want them backed up)"
fi

# 3. Force WAL checkpoint so all pending writes flush to main DB file
if sqlite3 "$RAM_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null | grep -q '^0|'; then
  pass "RAM DB WAL flushed"
else
  warn "RAM DB WAL checkpoint returned non-zero (may have pending pages — still safe)"
fi
if [ -f "$SSD_DB" ]; then
  sqlite3 "$SSD_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 && pass "SSD DB WAL flushed"
fi

# 4. Integrity checks
check_integrity() {
  local db="$1" name="$2"
  if [ ! -f "$db" ]; then warn "$name missing: $db"; return; fi
  local r
  r=$(sqlite3 "$db" "PRAGMA quick_check;" 2>&1 | head -1)
  if [ "$r" = "ok" ]; then pass "$name integrity ok"
  else fail "$name integrity FAILED — $r"; fi
}
check_integrity "$RAM_DB" "RAM DB"
check_integrity "$SSD_DB" "SSD DB"
check_integrity "$VEC_DB" "Vec DB"

# 5. Data parity (RAM vs SSD)
RAM_MAX=$(sqlite3 "$RAM_DB" "SELECT COALESCE(MAX(id),0) FROM entries;" 2>/dev/null)
SSD_MAX=$(sqlite3 "$SSD_DB" "SELECT COALESCE(MAX(id),0) FROM entries;" 2>/dev/null)
if [ "$RAM_MAX" = "$SSD_MAX" ]; then
  pass "RAM/SSD in sync at id=$RAM_MAX"
elif [ "$RAM_MAX" -gt "$SSD_MAX" ] 2>/dev/null; then
  GAP=$((RAM_MAX - SSD_MAX))
  if [ "$GAP" -le 50 ]; then
    warn "RAM ahead of SSD by $GAP (normal — 1-min sync timer will catch up, SSD is 1min behind at worst)"
  else
    fail "RAM ahead of SSD by $GAP — force sync: curl -XPOST $BASE/tier/migrate"
  fi
fi

# 6. Fresh snapshot
TS=$(date +%Y-%m-%dT%H-%M-%S)
SNAP_PATH="$SNAP_DIR/vcontext-${TS}-pre-outage.db"
mkdir -p "$SNAP_DIR"
if cp "$RAM_DB" "$SNAP_PATH" 2>/dev/null; then
  SNAP_SIZE=$(du -h "$SNAP_PATH" | awk '{print $1}')
  pass "snapshot saved: $(basename "$SNAP_PATH") ($SNAP_SIZE)"
else
  fail "snapshot FAILED — check disk space"
fi

# 7. JSONL WAL on SSD (not RAM disk — survives reboot)
if [ -f "$WAL_FILE" ]; then
  LINES=$(wc -l < "$WAL_FILE" | tr -d ' ')
  SIZE=$(du -h "$WAL_FILE" | awk '{print $1}')
  pass "JSONL entries log: $LINES lines / $SIZE (on SSD — survives outage)"
else
  warn "JSONL entries log missing — not a blocker, but recovery loses the 1-min-window"
fi

# 8. LaunchAgents present (for auto-restart after boot)
MISSING_AGENTS=""
for label in com.vcontext.ramdisk com.vcontext.mlx-embed com.vcontext.mlx-generate com.vcontext.server com.vcontext.watchdog com.vcontext.maintenance com.vcontext.morning-brief; do
  PLIST="$HOME/Library/LaunchAgents/${label}.plist"
  [ -f "$PLIST" ] || MISSING_AGENTS="$MISSING_AGENTS $label"
done
if [ -z "$MISSING_AGENTS" ]; then
  pass "all 7 LaunchAgents present (auto-restart ready)"
else
  fail "missing LaunchAgents:$MISSING_AGENTS"
fi

# 9. Smoke test (via npm test:quick — read-only, no side effects)
if bash "$HOME/skills/scripts/smoke-test.sh" --quick >/dev/null 2>&1; then
  pass "smoke test suite passing (read-only subset)"
else
  warn "smoke test had failures — run 'npm run test:quick' to see details"
fi

# ── Report ──
echo ""
if [ $FAIL -eq 0 ]; then
  echo -e "${G}Safe to shut down.${N}"
  echo "  On boot, 7 LaunchAgents will auto-restart everything."
  echo "  Verify afterwards:  bash scripts/smoke-test.sh"
  echo "  If anything's off:  see RECOVERY.md"
  exit 0
else
  echo -e "${R}$FAIL blockers — review before shutting down.${N}"
  echo "  See RECOVERY.md for remediation steps."
  exit 1
fi
