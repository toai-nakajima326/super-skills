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

# Main loop
log "Watchdog started (interval: ${CHECK_INTERVAL}s)"
WAS_DOWN=false

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

  sleep $CHECK_INTERVAL
done
