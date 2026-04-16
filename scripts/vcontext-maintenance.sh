#!/bin/bash
# vcontext-maintenance.sh — periodic housekeeping for the AI OS.
# Runs hourly via com.vcontext.maintenance launchagent.
#   - GC: prune expired entries by type-TTL
#   - integrity: sqlite PRAGMA integrity_check
#   - snapshot: .backup to SSD (once per day, keep last 7)
set -u

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v24.15.0/bin/node"
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

# 9. Auto-tuning — ensure indexes exist, ANALYZE for query planner, periodic VACUUM
DB_RAM="/Volumes/VContext/vcontext.db"
DB_SSD="$HOME/skills/data/vcontext-ssd.db"
for DB in "$DB_RAM" "$DB_SSD"; do
  [ -f "$DB" ] || continue
  # Ensure critical indexes (idempotent)
  sqlite3 "$DB" "
    CREATE INDEX IF NOT EXISTS idx_entries_embedding_null ON entries(id) WHERE embedding IS NULL;
    CREATE INDEX IF NOT EXISTS idx_entries_type_created ON entries(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session, id DESC);
  " 2>/dev/null
  # ANALYZE — update query planner statistics (fast, ~100ms)
  sqlite3 "$DB" "ANALYZE;" 2>/dev/null
  log "Auto-tune $(basename $DB): indexes ensured, ANALYZE done"
done
# Weekly VACUUM (Sunday only) — reclaim space, defragment
if [ "$(date +%u)" = "7" ] && [ ! -f "/tmp/vcontext-vacuum-$(date +%Y-%V).done" ]; then
  for DB in "$DB_RAM" "$DB_SSD"; do
    [ -f "$DB" ] || continue
    SIZE_BEFORE=$(stat -f%z "$DB" 2>/dev/null)
    sqlite3 "$DB" "VACUUM;" 2>/dev/null
    SIZE_AFTER=$(stat -f%z "$DB" 2>/dev/null)
    log "VACUUM $(basename $DB): ${SIZE_BEFORE}→${SIZE_AFTER} bytes"
  done
  touch "/tmp/vcontext-vacuum-$(date +%Y-%V).done"
fi

# 10. Upstream sync (was self-evolve) — check git remote for updates
SKILLS_DIR="$HOME/skills"
if [ -d "$SKILLS_DIR/.git" ]; then
  cd "$SKILLS_DIR"
  git fetch origin 2>/dev/null
  BEHIND=$(git rev-list HEAD..origin/main --count 2>/dev/null)
  if [ "${BEHIND:-0}" -gt 0 ]; then
    log "Upstream: $BEHIND commits behind origin/main"
  else
    log "Upstream: up to date"
  fi
fi

# 11. Evolution log — append daily summary to docs/evolution-log.md
EVOLUTION_LOG="$SKILLS_DIR/docs/evolution-log.md"
if [ -d "$SKILLS_DIR/docs" ]; then
  DISCOVERY_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-discovery' AND created_at >= datetime('now','-24 hours');" 2>/dev/null)
  SUGGESTION_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-suggestion' AND created_at >= datetime('now','-24 hours');" 2>/dev/null)
  CREATED_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-created' AND created_at >= datetime('now','-24 hours');" 2>/dev/null)
  EMBED_TOTAL=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries;" 2>/dev/null)
  EMBED_DONE=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE embedding IS NOT NULL;" 2>/dev/null)
  SESSIONS=$(sqlite3 "$DB_RAM" "SELECT COUNT(DISTINCT session) FROM entries WHERE created_at >= datetime('now','-24 hours');" 2>/dev/null)
  cat >> "$EVOLUTION_LOG" <<EOFLOG

## $(date +%Y-%m-%d) — auto (maintenance)
- Discovery: ${DISCOVERY_COUNT:-0} searches | Suggestions: ${SUGGESTION_COUNT:-0} | Skills created: ${CREATED_COUNT:-0}
- Embedding: ${EMBED_DONE:-?}/${EMBED_TOTAL:-?} | Sessions: ${SESSIONS:-0}
- Upstream: ${BEHIND:-0} commits behind
EOFLOG
  log "Evolution log updated"
fi

# 12. Daily AI news check — guaranteed once per day (discovery loop may miss due to restarts)
NEWS_MARKER="/tmp/vcontext-news-${TODAY}.done"
if [ ! -f "$NEWS_MARKER" ]; then
  NEWS_SOURCES=(
    "Anthropic+Claude+new+release"
    "OpenAI+GPT+new+model+release"
    "Apple+MLX+framework+update"
    "Qwen+Alibaba+new+model"
    "arxiv+AI+agent+paper+2026"
    "Google+Gemini+new+release"
    "Meta+Llama+new+model"
  )
  SEARXNG_PORT=$(docker port searxng 8080 2>/dev/null | head -1 | cut -d: -f2)
  SEARXNG_PORT="${SEARXNG_PORT:-8888}"
  NEWS_COUNT=0
  for QUERY in "${NEWS_SOURCES[@]}"; do
    RESULT=$(curl -s --max-time 10 "http://127.0.0.1:${SEARXNG_PORT}/search?q=${QUERY}+2026&format=json&language=auto" 2>/dev/null)
    if echo "$RESULT" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if len(d.get('results',[]))>0 else 1)" 2>/dev/null; then
      SNIPPETS=$(echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d.get('results',[])[:3]:
    print(f'[{r.get(\"engine\",\"?\")}] {r.get(\"title\",\"\")}')
" 2>/dev/null)
      curl -s -X POST http://127.0.0.1:3150/store -H 'Content-Type: application/json' \
        -d "{\"type\":\"skill-discovery\",\"content\":$(python3 -c "import json;print(json.dumps({'topic':'${QUERY//+/ }','results':'''${SNIPPETS}'''.split('\n')[:3],'source':'daily-news-check'}))" 2>/dev/null),\"tags\":[\"news-check\",\"daily\"],\"session\":\"system\"}" > /dev/null 2>&1
      NEWS_COUNT=$((NEWS_COUNT + 1))
    fi
    sleep 2  # rate limit
  done
  touch "$NEWS_MARKER"
  log "Daily news check: $NEWS_COUNT/${#NEWS_SOURCES[@]} sources checked"
fi

# 13. Hook auto-setup (was self-evolve) — ensure all AI tools have hooks
if [ -x "$SKILLS_DIR/scripts/setup-hooks.sh" ]; then
  bash "$SKILLS_DIR/scripts/setup-hooks.sh" >> "$LOG" 2>&1
  log "Hook setup: checked all AI tools"
fi

log "=== cycle done ==="
