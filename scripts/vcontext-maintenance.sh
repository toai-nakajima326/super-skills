#!/bin/bash
# vcontext-maintenance.sh — periodic housekeeping for the AI OS.
# Runs hourly via com.vcontext.maintenance launchagent.
#   - GC: prune expired entries by type-TTL
#   - integrity: sqlite PRAGMA integrity_check
#   - snapshot: .backup to SSD (once per day, keep last 7)
set -u

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v18.20.7/bin/node"
HOOK="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
SNAP_DIR="/Users/mitsuru_nakajima/skills/data/snapshots"
LOG="/tmp/vcontext-maintenance.log"
TODAY=$(date +%Y-%m-%d)
SNAP_MARKER="/tmp/vcontext-snap-${TODAY}.done"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Rotate log if > 5MB
[ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ] && mv "$LOG" "${LOG}.old"

# 1. Integrity check — required before destructive GC
log "=== maintenance cycle ==="

# 0a. Meta-monitor: who watches the watchman? Verify watchdog itself is alive.
# If watchdog died, no MLX hang detection. Restart via launchctl.
if ! pgrep -f vcontext-watchdog >/dev/null; then
  log "Watchdog DEAD — restarting via launchctl"
  launchctl kickstart -k "gui/$(id -u)/com.vcontext.watchdog" 2>>"$LOG"
  osascript -e 'display notification "vcontext watchdog had died and was restarted" with title "⚠️ AI OS: Meta-monitor"' 2>/dev/null
fi

# 0b. Audit log retention — keep 90 days, drop older. Audit DB lives on
# SSD and grows linearly; uncapped it eventually fills the disk.
sqlite3 "$HOME/skills/data/vcontext-audit.db" \
  "DELETE FROM audit WHERE at < datetime('now','-90 days');" 2>/dev/null && \
  log "Audit retention applied (>90d pruned)"

if ! "$NODE" "$HOOK" integrity >> "$LOG" 2>&1; then
  log "Integrity FAILED — aborting this cycle, letting watchdog handle recovery"
  exit 1
fi

# Backup verification — once per cycle, confirm latest snapshot is restorable.
BACKUP_VERIFY=$(curl -s -X POST http://127.0.0.1:3150/admin/verify-backup 2>/dev/null)
if echo "$BACKUP_VERIFY" | grep -q '"integrity":"ok"'; then
  log "Backup verify: OK"
else
  log "Backup verify FAILED: $BACKUP_VERIFY"
  osascript -e 'display notification "Latest snapshot failed verification" with title "⚠️ AI OS: Backup"' 2>/dev/null
fi

# 2. Drain fallback queue — zero-downtime deploys write here when the
# server is briefly unavailable; replay as soon as it's reachable.
"$NODE" "$HOOK" drain-queue >> "$LOG" 2>&1 || log "Drain errored (non-fatal)"

# 2b. Fire any due reminders (time-aware notifications)
"$NODE" "$HOOK" remind-fire >> "$LOG" 2>&1 || true

# 3. Self-test — smoke test the critical paths; alert on failure
if ! "$NODE" "$HOOK" self-test >> "$LOG" 2>&1; then
  osascript -e 'display notification "vcontext self-test failed — check /tmp/vcontext-maintenance.log" with title "⚠️ AI OS"' 2>/dev/null
  log "Self-test FAILED — skipping GC this cycle"
  exit 1
fi

# 4. MLX generate liveness — /v1/models responds even when generation hangs,
# so probe a real completion with tight timeout. If it hangs, kill the
# process so launchctl (KeepAlive) auto-restarts it.
MLX_PROBE=$(curl -s --max-time 15 -X POST http://127.0.0.1:3162/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Qwen3-8B-4bit","messages":[{"role":"user","content":"hi"}],"max_tokens":3}' 2>&1)
if ! echo "$MLX_PROBE" | grep -q '"choices"'; then
  log "MLX generate liveness FAILED — killing process so launchctl respawns"
  MLX_PID=$(ps -ef | grep mlx-generate-server | grep -v grep | awk '{print $2}' | head -1)
  [ -n "$MLX_PID" ] && kill -9 "$MLX_PID" 2>/dev/null && log "Killed MLX pid=$MLX_PID"
fi

# 5. Policy check — detect backlogs, dead-letters, error spikes
"$NODE" "$HOOK" policy-check >> "$LOG" 2>&1 || log "Policy check errored (non-fatal)"

# 5. Metrics snapshot — append to log for trend analysis
"$NODE" "$HOOK" metrics >> "$LOG" 2>&1 || log "Metrics errored (non-fatal)"

# 6. GC — prune by TTL
"$NODE" "$HOOK" gc >> "$LOG" 2>&1 || log "GC errored (non-fatal)"

# 7. Daily snapshot (marker file prevents more than once per day)
if [ ! -f "$SNAP_MARKER" ]; then
  "$NODE" "$HOOK" snapshot "daily" >> "$LOG" 2>&1 && touch "$SNAP_MARKER"
fi

# 8. Snapshot retention (per-class + total size cap 20 GB).
#    Classes: daily (keep 7), pre-deploy (keep 3), others (keep 2 each).
snap_prune() {
  local glob="$1"; local keep="$2"
  ls -1t "$SNAP_DIR"/vcontext-*-${glob}.db 2>/dev/null | tail -n +$((keep + 1)) | while read f; do
    [ -n "$f" ] && rm -f "$f" && log "Pruned snapshot (class=$glob): $(basename "$f")"
  done
}
snap_prune daily 7
snap_prune pre-deploy 3
snap_prune initial-os 2
snap_prune adhoc 2
# Hard size cap: 20 GB total. Remove oldest until under cap.
TOTAL_BYTES=$(du -sk "$SNAP_DIR" 2>/dev/null | awk '{print $1 * 1024}')
CAP_BYTES=$((20 * 1024 * 1024 * 1024))
while [ "${TOTAL_BYTES:-0}" -gt "$CAP_BYTES" ]; do
  OLDEST=$(ls -1t "$SNAP_DIR"/vcontext-*.db 2>/dev/null | tail -1)
  [ -z "$OLDEST" ] && break
  rm -f "$OLDEST" && log "Size-cap prune: $(basename "$OLDEST")"
  TOTAL_BYTES=$(du -sk "$SNAP_DIR" 2>/dev/null | awk '{print $1 * 1024}')
done

log "=== cycle done ==="
# hook verification Wed Apr 15 13:21:13 JST 2026
