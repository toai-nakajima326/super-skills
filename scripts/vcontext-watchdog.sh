#!/bin/bash
# vcontext-watchdog.sh — Monitor vcontext server health
# Sends macOS notification if server is down. Optionally calls a webhook.

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

  # Check SearXNG every 5 minutes (every 5th iteration)
  SEARXNG_CHECK_COUNTER=$((SEARXNG_CHECK_COUNTER + 1))
  if [[ $((SEARXNG_CHECK_COUNTER % 5)) -eq 0 ]]; then
    check_searxng
  fi

  # MLX Embed health check every 5 minutes (every 5th iteration)
  # Restart if: unresponsive or memory > 6GB (MLX leaks ~200 calls before hang)
  if [[ $((SEARXNG_CHECK_COUNTER % 5)) -eq 0 ]]; then
    EMBED_PID=$(pgrep -f "mlx-embed-server" | head -1)
    if [[ -n "$EMBED_PID" ]]; then
      EMBED_HEALTH=$(curl -s --max-time 5 http://127.0.0.1:3161/health 2>/dev/null)
      EMBED_MB=$(footprint -p "$EMBED_PID" 2>/dev/null | grep Footprint | grep -o '[0-9]* MB' | grep -o '[0-9]*')
      if [[ -z "$EMBED_HEALTH" ]] || { [[ -n "$EMBED_MB" ]] && [[ "$EMBED_MB" -gt 6000 ]]; }; then
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
  if [[ $((SEARXNG_CHECK_COUNTER % 5)) -eq 0 ]]; then
    GEN_PID=$(pgrep -f "mlx-generate-server" | head -1)
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

  sleep $CHECK_INTERVAL
done
