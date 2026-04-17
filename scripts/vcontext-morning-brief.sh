#!/bin/bash
# vcontext-morning-brief.sh — Daily AIOS health brief via macOS notification
# Runs every morning via LaunchAgent. Pulls /admin/health-report and surfaces:
#   • key counters (events/sessions/errors/skills)
#   • anomalies from the period
#   • top tools used
# Full brief saved to $HOME/skills/data/morning-briefs/YYYY-MM-DD.txt

set -u

DAYS="${1:-1}"   # default: yesterday's brief
SERVER="http://localhost:3150"
OUT_DIR="$HOME/skills/data/morning-briefs"
LOG="$HOME/skills/data/morning-brief.log"
mkdir -p "$OUT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "=== morning brief (days=$DAYS) ==="

# Ensure server is up
if ! curl -sf "$SERVER/health" > /dev/null 2>&1; then
  log "Server not healthy, skipping"
  osascript -e "display notification \"vcontext server not healthy — skipping brief\" with title \"⚠️ vcontext brief\"" 2>/dev/null
  exit 1
fi

# Fetch brief
RESPONSE=$(curl -s --max-time 10 "$SERVER/admin/health-report?days=$DAYS")
if [[ -z "$RESPONSE" ]] || ! echo "$RESPONSE" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null; then
  log "Invalid response from /admin/health-report"
  exit 1
fi

BRIEF=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('brief',''))")
EVENTS=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['stats'].get('events',0))")
ERRORS=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['stats'].get('errors',0))")
SESSIONS=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['stats'].get('sessions',0))")
SKILLS=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['stats'].get('skills',0))")
PATCHES=$(echo "$RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['stats'].get('patches',0))")

# Save full brief to file
DATE=$(date +%Y-%m-%d)
OUT_FILE="$OUT_DIR/$DATE.txt"
echo "$BRIEF" > "$OUT_FILE"
log "Saved brief: $OUT_FILE"

# macOS notification — short line, clickable
NOTIF_BODY="Events:$EVENTS Sessions:$SESSIONS Skills:$SKILLS Errors:$ERRORS"
[[ "$PATCHES" -gt 0 ]] && NOTIF_BODY="$NOTIF_BODY Patches:$PATCHES"
ALERT_LEVEL="☀️"
[[ "$ERRORS" -gt 100 ]] && ALERT_LEVEL="⚠️"
[[ "$PATCHES" -gt 0 ]] && ALERT_LEVEL="🔧"

osascript -e "display notification \"$NOTIF_BODY\" with title \"$ALERT_LEVEL vcontext morning brief\" sound name \"Glass\"" 2>/dev/null

# Optional: Slack/Discord webhook
if [[ -n "${VCONTEXT_BRIEF_WEBHOOK:-}" ]]; then
  curl -s -X POST "$VCONTEXT_BRIEF_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json;print(json.dumps({'text': '\`\`\`\n$BRIEF\n\`\`\`'}))")" > /dev/null 2>&1
fi

log "Brief sent: $NOTIF_BODY"
exit 0
