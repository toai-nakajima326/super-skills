#!/bin/bash
# vcontext-backup.sh — out-of-process backup of the primary DB.
#
# Why this exists (2026-04-20):
#   The in-server setInterval(doBackupAndMigrate, 5min) did file-level
#   backup on the Node event loop. A SIGKILL mid-backup left orphan
#   .tmp/.tmp-wal files; the next cycle's ramDb.backup() reused them,
#   appending unchecked — one morning of cascade cycles grew the
#   .tmp-wal to 28.77 GB. That size saturated APFS I/O, which blocked
#   the event loop, which made /health/stats/recent time out for
#   clients (dashboard, Codex, hooks). The in-process coupling was
#   itself the bug.
#
#   User's architectural call: run backup as a separate process. This
#   script is that separate process. No Node, no event loop. SQLite's
#   online backup is designed for concurrent access to a live WAL DB,
#   so the server keeps serving reads/writes while we snapshot.
#
# Contract:
#   Input:  $HOME/skills/data/vcontext-primary.sqlite  (live, owned by server)
#   Output: $HOME/skills/data/vcontext-backup.sqlite   (atomic rename target)
#           $HOME/skills/data/vcontext-backup.sqlite.bak  (last-good safety)
#
# Scheduled by: ~/Library/LaunchAgents/com.vcontext.backup.plist (300s interval,
# LowPriorityIO=true, Nice=10 — yields to the server process).

set -eu -o pipefail

PRIMARY="$HOME/skills/data/vcontext-primary.sqlite"
BACKUP="$HOME/skills/data/vcontext-backup.sqlite"
# .ext-tmp distinguishes from the in-server .tmp that used to live here
# (never reuse the old name — keeps forensic logs readable and avoids
# any chance of collision with a stale file from the pre-2026-04-20 era).
TMP="${BACKUP}.ext-tmp"
LOG="/tmp/vcontext-backup-external.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

exec >> "$LOG" 2>&1
log "=== external backup cycle ==="

# ── Pre-flight: clean any orphan fileset from prior interrupted run ──
# This is the CRITICAL defense. A bare `rm` before each cycle guarantees
# we never inherit a runaway -wal. 4 suffixes cover every SQLite sidecar
# kind (main, WAL mode, shared-memory, legacy rollback journal).
for suffix in '' '-wal' '-shm' '-journal'; do
  rm -f "${TMP}${suffix}"
done

if [[ ! -f "$PRIMARY" ]]; then
  log "primary DB not found at $PRIMARY — aborting (server may be mid-boot)"
  exit 0
fi

# ── Online backup via sqlite3 CLI ──
# .backup uses SQLite's pager-level online backup API. The live server
# can continue reading/writing; we get a consistent snapshot of pages
# as of the start of the backup. Completes in ~3-8 s for a 6 GB DB on
# APFS; LowPriorityIO + Nice=10 keeps our IO under the server's.
if ! sqlite3 "$PRIMARY" ".backup '$TMP'" 2>&1; then
  log ".backup command failed — cleaning tmp, aborting cycle"
  for suffix in '' '-wal' '-shm' '-journal'; do rm -f "${TMP}${suffix}"; done
  exit 1
fi

# ── Integrity gate on the fresh tmp ──
INTEGRITY=$(sqlite3 "$TMP" 'PRAGMA integrity_check;' 2>&1 | head -1)
if [[ "$INTEGRITY" != "ok" ]]; then
  log "integrity_check FAILED on fresh tmp: '$INTEGRITY' — dropping, keeping existing .sqlite untouched"
  for suffix in '' '-wal' '-shm' '-journal'; do rm -f "${TMP}${suffix}"; done
  exit 1
fi

# ── Rotate: current .sqlite → .bak (only if currently-valid) ──
# Never overwrite .bak with a corrupt .sqlite — .bak is the last-good
# safety copy that recovered us yesterday. Same invariant as the in-
# server doBackup's AC2.
if [[ -f "$BACKUP" ]]; then
  BACKUP_INTEGRITY=$(sqlite3 "$BACKUP" 'PRAGMA integrity_check;' 2>&1 | head -1)
  if [[ "$BACKUP_INTEGRITY" == "ok" ]]; then
    mv -f "$BACKUP" "${BACKUP}.bak"
    for s in '-wal' '-shm'; do
      [[ -f "${BACKUP}${s}" ]] && mv -f "${BACKUP}${s}" "${BACKUP}.bak${s}" || true
    done
  else
    log "existing .sqlite corrupt ('$BACKUP_INTEGRITY') — dropping it but keeping .bak intact"
    rm -f "$BACKUP" "${BACKUP}-wal" "${BACKUP}-shm"
  fi
fi

# ── Promote tmp to primary backup ──
mv -f "$TMP" "$BACKUP"
# rename(2) only moves the named file. Purge any tmp sidecars that
# sqlite3 may have created during the .backup or integrity_check calls.
for suffix in '-wal' '-shm' '-journal'; do
  rm -f "${TMP}${suffix}"
done

SIZE=$(du -h "$BACKUP" | awk '{print $1}')
log "backup complete: $BACKUP ($SIZE)"

# ── Housekeeping: log rotation ──
# Prevent this script's own log from growing unboundedly.
if [[ -f "$LOG" ]] && [[ $(stat -f%z "$LOG" 2>/dev/null || echo 0) -gt 10485760 ]]; then  # >10 MB
  tail -500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  log "(log truncated to last 500 lines)"
fi
