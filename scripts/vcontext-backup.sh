#!/bin/bash
# vcontext-backup.sh — thin HTTP client that triggers a server-side backup.
#
# Stage 3b of the 2026-04-20 loose-coupling redesign
# (docs/specs/2026-04-20-true-loose-coupling-redesign.md).
#
# Before 3b: this script shelled out to `sqlite3 "$PRIMARY" ".backup"`,
# which held a read-snapshot on primary.sqlite for 60-120s and blocked
# the server's WAL from TRUNCATE-checkpointing. When the sqlite3 hung
# (observed 2026-04-20 for 1h 59m), the live WAL grew to 3 GB.
#
# After 3b: we POST to /admin/backup. The server owns primary.sqlite
# exclusively; no external process opens the file. P1 (loose coupling)
# fully applied for the backup surface.
#
# Scheduled by com.vcontext.backup LaunchAgent every 15 min.
#
# Contract (via docs/schemas/vcontext-api-v1.yaml):
#   POST /admin/backup
#   headers: X-Vcontext-Admin: yes
#   returns: { status, backup_path, size_bytes, integrity, duration_ms,
#              ran_at, cached?, next_in_seconds? }

set -eu -o pipefail

LOG="/tmp/vcontext-backup-external.log"
VCTX_URL="${VCONTEXT_URL:-http://127.0.0.1:3150}"
# Max wait for the server to complete the backup. On a 6 GB DB, the
# backup is ~60-90 s. 5 min cap lets us tolerate slow disks without
# hanging forever — and a slow server likely means bigger problems.
BACKUP_TIMEOUT_S="${VCTX_BACKUP_TIMEOUT_S:-300}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

exec >> "$LOG" 2>&1
log "=== external backup cycle (thin-client) ==="

# Pre-flight: server reachable?
if ! curl -sS -m 3 "${VCTX_URL}/health" > /dev/null 2>&1; then
  log "server unreachable at ${VCTX_URL} — skipping cycle (queue retry next tick)"
  exit 0
fi

# Fire the backup.
RESP=$(curl -sS -m "$BACKUP_TIMEOUT_S" \
  -X POST "${VCTX_URL}/admin/backup" \
  -H "X-Vcontext-Admin: yes" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1)
RC=$?

if [[ $RC -ne 0 ]]; then
  log "curl failed (rc=$RC) — likely server timeout or network"
  log "response snippet: ${RESP:0:200}"
  exit 1
fi

# Parse response for status.
STATUS=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "parse_fail")
case "$STATUS" in
  ok)
    SIZE=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('size_bytes',0))" 2>/dev/null)
    DUR=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('duration_ms',0))" 2>/dev/null)
    INT=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('integrity','?'))" 2>/dev/null)
    CACHED=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if d.get('cached') else 'no')" 2>/dev/null)
    log "backup OK: size=${SIZE} bytes duration=${DUR}ms integrity=${INT} cached=${CACHED}"
    ;;
  busy)
    log "backup busy (in-flight guard) — another backup already running, will retry next tick"
    ;;
  skipped)
    REASON=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reason','?'))" 2>/dev/null)
    log "backup skipped: ${REASON}"
    ;;
  fail)
    log "backup FAILED: ${RESP:0:300}"
    exit 1
    ;;
  *)
    log "unexpected status=${STATUS} response=${RESP:0:300}"
    exit 1
    ;;
esac

# Log rotation (>10 MB → keep last 500 lines)
if [[ -f "$LOG" ]] && [[ $(stat -f%z "$LOG" 2>/dev/null || echo 0) -gt 10485760 ]]; then
  tail -500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  log "(log truncated to last 500 lines)"
fi

exit 0
