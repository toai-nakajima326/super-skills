#!/bin/bash
# vcontext-watchdog.sh — Monitor vcontext server health
# Sends macOS notification if server is down. Optionally calls a webhook.
# Hardened: trap all signals, catch all errors, never crash

set -o pipefail
trap 'log "Caught signal, continuing..."; sleep 5' HUP INT TERM
trap 'log "Unexpected error on line $LINENO, continuing..."; sleep 5' ERR

# Self-singleton — prevent multiple watchdogs racing to restart the same
# services (seen 2026-04-17: 3 watchdogs spawned across reloads, each
# independently killing+restarting mlx-generate every minute).
PIDFILE="/tmp/vcontext-watchdog.pid"
if [[ -f "$PIDFILE" ]]; then
  OTHER_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [[ -n "$OTHER_PID" ]] && kill -0 "$OTHER_PID" 2>/dev/null && [[ "$OTHER_PID" != "$$" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another watchdog (PID $OTHER_PID) is running — exiting"
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

HEALTH_URL="http://localhost:3150/health"
CHECK_INTERVAL=60
WEBHOOK_URL="${VCONTEXT_ALERT_WEBHOOK:-}"  # Set env var for Slack/Discord/LINE
NOTIFY_COOLDOWN=300  # Don't spam: 5 min between notifications
LAST_NOTIFY_FILE="/tmp/vcontext-watchdog-last-notify.txt"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

check_health() {
  local response
  response=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 "$HEALTH_URL" 2>/dev/null)
  [[ "$response" == "200" ]]
}

should_notify() {
  if [[ ! -f "$LAST_NOTIFY_FILE" ]]; then return 0; fi
  local last=$(cat "$LAST_NOTIFY_FILE" 2>/dev/null)
  local now=$(date +%s)
  local diff=$((now - last))
  [[ $diff -ge $NOTIFY_COOLDOWN ]]
}

send_alert() {
  local message="$1"

  # macOS notification
  osascript -e "display notification \"$message\" with title \"⚠️ Virtual Context Alert\"" 2>/dev/null

  # Webhook (Slack/Discord/LINE)
  if [[ -n "$WEBHOOK_URL" ]]; then
    curl -s -X POST "$WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"⚠️ Virtual Context: $message\"}" 2>/dev/null
  fi

  date +%s > "$LAST_NOTIFY_FILE"
  log "ALERT: $message"
}

send_recovery() {
  local message="$1"
  osascript -e "display notification \"$message\" with title \"✅ Virtual Context Recovery\"" 2>/dev/null
  if [[ -n "$WEBHOOK_URL" ]]; then
    curl -s -X POST "$WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"✅ Virtual Context: $message\"}" 2>/dev/null
  fi
  log "RECOVERY: $message"
}

# Ensure SearXNG container is running (docker compose up -d is idempotent)
SEARXNG_COMPOSE="$HOME/skills/config/searxng/docker-compose.yml"
check_searxng() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^searxng$'; then
      log "SearXNG container not running, starting via compose..."
      docker compose -f "$SEARXNG_COMPOSE" up -d 2>/dev/null
      if [[ $? -eq 0 ]]; then
        log "SearXNG started via docker compose"
      else
        log "SearXNG docker compose failed"
      fi
    fi
  fi
}

# Main loop
log "Watchdog started (interval: ${CHECK_INTERVAL}s)"
WAS_DOWN=false
SEARXNG_CHECK_COUNTER=0

while true; do
  (  # Subshell — any error inside won't kill the loop
  if check_health; then
    if $WAS_DOWN; then
      send_recovery "Server recovered and is healthy again"
      WAS_DOWN=false
    fi
  else
    WAS_DOWN=true
    if should_notify; then
      send_alert "Server is not responding at $HEALTH_URL"
    fi

    # Try to restart via wrapper
    if ! pgrep -f vcontext-wrapper > /dev/null; then
      log "Wrapper not running, attempting restart..."
      bash /Users/mitsuru_nakajima/skills/scripts/vcontext-wrapper.sh &
      sleep 5
      if check_health; then
        send_recovery "Server auto-restarted successfully"
        WAS_DOWN=false
      fi
    fi
  fi

  # RAM disk capacity check — every cycle (critical: DB corruption risk if full)
  RAM_USED_PCT=$(df /Volumes/VContext 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  if [[ -n "$RAM_USED_PCT" ]]; then
    if [[ "$RAM_USED_PCT" -ge 95 ]]; then
      log "RAM DISK CRITICAL: ${RAM_USED_PCT}% used — emergency cleanup"
      # Remove any corrupt DB backups
      rm -f /Volumes/VContext/vcontext-corrupt-*.db 2>/dev/null
      # Force WAL checkpoint to flush and shrink
      sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null
      osascript -e "display notification \"RAM disk ${RAM_USED_PCT}% — emergency cleanup\" with title \"🚨 vcontext CRITICAL\"" 2>/dev/null
    elif [[ "$RAM_USED_PCT" -ge 85 ]]; then
      log "RAM DISK WARN: ${RAM_USED_PCT}% used"
      sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(PASSIVE);" 2>/dev/null
      osascript -e "display notification \"RAM disk ${RAM_USED_PCT}% — watch closely\" with title \"⚠️ vcontext\"" 2>/dev/null
    fi
  fi

  # Check SearXNG every 5 minutes (every 5th iteration)
  SEARXNG_CHECK_COUNTER=$((SEARXNG_CHECK_COUNTER + 1))
  if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]; then
    check_searxng
  fi

  # MLX Embed health check every 5 minutes (every 5th iteration)
  # Restart if: unresponsive or memory > 10GB (cache 5GB + model 4.5GB = 9.5GB normal)
  if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]; then
    EMBED_PID=$(pgrep -f "mlx-embed-server" | head -1)
    if [[ -n "$EMBED_PID" ]]; then
      EMBED_HEALTH=$(curl -s --max-time 5 http://127.0.0.1:3161/health 2>/dev/null)
      EMBED_MB=$(footprint -p "$EMBED_PID" 2>/dev/null | grep Footprint | grep -o '[0-9]* MB' | grep -o '[0-9]*')
      if [[ -z "$EMBED_HEALTH" ]] || { [[ -n "$EMBED_MB" ]] && [[ "$EMBED_MB" -gt 10000 ]]; }; then
        log "MLX Embed restart: health=${EMBED_HEALTH:+ok}${EMBED_HEALTH:-timeout} mem=${EMBED_MB:-?}MB"
        launchctl unload ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
        sleep 1; kill -9 "$EMBED_PID" 2>/dev/null; lsof -ti :3161 | xargs kill -9 2>/dev/null
        sleep 1; launchctl load ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
        log "MLX Embed restarted"
      fi
    else
      log "MLX Embed not running, starting..."
      launchctl load ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
    fi
  fi

  # MLX Generate health check every 5 minutes (every 5th iteration).
  # /health responds even when generation hangs — so we probe an ACTUAL
  # completion with 15s timeout. This is how the 2026-04-14 halt went
  # undetected for a day: /health was up but generation was dead.
  if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]; then
    # Process identity: mlx-generate-wrapper.sh execs `python3 -m mlx_lm.server`,
    # so the running command line contains mlx_lm.server (NOT mlx-generate-server).
    # Using the wrong pattern caused a perpetual restart loop — watchdog killed
    # the process every minute thinking it was down.  Match on the actual binary.
    GEN_PID=$(pgrep -f "mlx_lm.server --model" | head -1)
    NEED_RESTART=false
    REASON=""

    if [[ -n "$GEN_PID" ]]; then
      # Memory check
      GEN_MB=$(footprint -p "$GEN_PID" 2>/dev/null | grep Footprint | grep -o '[0-9]* MB' | grep -o '[0-9]*')
      if [[ -n "$GEN_MB" ]] && [[ "$GEN_MB" -gt 8000 ]]; then
        NEED_RESTART=true; REASON="memory ${GEN_MB}MB > 8GB"
      fi

      # Actual-generation probe. Qwen3 thinks before answering — a
      # 3-token cap with 15s timeout was killing MLX mid-thought during
      # legitimate long generations.  Use /v1/models (liveness only) +
      # /health. A genuine hang shows as both failing.
      # 503 "busy" on /v1/chat/completions counts as ALIVE.
      MODELS_CODE=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3162/v1/models 2>/dev/null)
      if [[ "$MODELS_CODE" != "200" ]]; then
        # Fallback: try a tiny generation with larger budget.
        GEN_CODE=$(curl -s --max-time 90 -o /tmp/vcontext-mlx-probe.out -w '%{http_code}' \
          -X POST http://127.0.0.1:3162/v1/chat/completions \
          -H 'Content-Type: application/json' \
          -d '{"model":"mlx-community/Qwen3-8B-4bit","messages":[{"role":"user","content":"hi"}],"max_tokens":4000}' 2>/dev/null)
        if [[ "$GEN_CODE" != "200" && "$GEN_CODE" != "503" ]]; then
          NEED_RESTART=true; REASON="both /v1/models and generation probe failed (models=${MODELS_CODE:-timeout} gen=${GEN_CODE:-timeout})"
        fi
      fi

      # Call count check (prevents gradual hang)
      GEN_HEALTH=$(curl -s --max-time 3 http://127.0.0.1:3162/health 2>/dev/null)
      GEN_CALLS=$(echo "$GEN_HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin).get('calls',0))" 2>/dev/null)
      if [[ -n "$GEN_CALLS" ]] && [[ "$GEN_CALLS" -gt 200 ]]; then
        NEED_RESTART=true; REASON="calls=${GEN_CALLS} > 200"
      fi
    else
      NEED_RESTART=true; REASON="process not found"
    fi

    if $NEED_RESTART; then
      log "MLX Generate restart: $REASON"
      launchctl unload ~/Library/LaunchAgents/com.vcontext.mlx-generate.plist 2>/dev/null
      sleep 1
      [[ -n "$GEN_PID" ]] && kill -9 "$GEN_PID" 2>/dev/null
      lsof -ti :3162 | xargs kill -9 2>/dev/null
      sleep 1
      launchctl load ~/Library/LaunchAgents/com.vcontext.mlx-generate.plist 2>/dev/null
      log "MLX Generate restarted"
    fi
  fi

  ) 2>/dev/null || log "Cycle error caught, continuing"
  sleep $CHECK_INTERVAL
done
