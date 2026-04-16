#!/bin/bash
# vcontext-abtest.sh — A/B test runner for vcontext parameters
# Usage: abtest.sh <param> <value_a> <value_b> <metric> <duration_hours>
#   param: e.g. EMBED_BATCH, EMBED_WAIT_MS, CLEAR_CACHE_INTERVAL
#   metric: recall_ms, store_ms, embed_rate, hit_rate
set -u

LOG="$HOME/skills/data/abtest-log.jsonl"
mkdir -p "$(dirname "$LOG")"

PARAM="${1:-}"
VALUE_A="${2:-}"
VALUE_B="${3:-}"
METRIC="${4:-recall_ms}"
DURATION_H="${5:-2}"

[ -z "$PARAM" ] && echo "Usage: $0 <param> <value_a> <value_b> <metric> <duration_h>" && exit 1

RAM_DB="/Volumes/VContext/vcontext.db"

get_metric() {
  local since_min=$1
  case "$METRIC" in
    recall_ms) sqlite3 "$RAM_DB" "SELECT ROUND(AVG(latency_ms),1) FROM api_metrics WHERE operation='recall' AND created_at > datetime('now','-${since_min} minutes');" ;;
    store_ms) sqlite3 "$RAM_DB" "SELECT ROUND(AVG(latency_ms),1) FROM api_metrics WHERE operation='store' AND created_at > datetime('now','-${since_min} minutes');" ;;
    hit_rate) sqlite3 "$RAM_DB" "SELECT ROUND(SUM(CASE WHEN result_count>0 THEN 1 ELSE 0 END)*100.0/COUNT(*),2) FROM api_metrics WHERE operation='recall' AND created_at > datetime('now','-${since_min} minutes');" ;;
    embed_rate) sqlite3 "$RAM_DB" "SELECT COUNT(*) FROM entries WHERE embedding IS NOT NULL AND created_at > datetime('now','-${since_min} minutes');" ;;
  esac
}

apply_param() {
  local val=$1
  case "$PARAM" in
    EMBED_BATCH)
      sed -i '' "s/const BATCH = [0-9]*;/const BATCH = ${val};/" ~/skills/scripts/vcontext-server.js
      bash ~/skills/scripts/vcontext-reload.sh >/dev/null 2>&1 ;;
    EMBED_WAIT_MS)
      sed -i '' "s/setTimeout(r, [0-9]*)); \/\/ 100ms gap/setTimeout(r, ${val})); \/\/ ${val}ms gap/" ~/skills/scripts/vcontext-server.js
      bash ~/skills/scripts/vcontext-reload.sh >/dev/null 2>&1 ;;
    *) echo "Unknown param: $PARAM"; exit 1 ;;
  esac
}

DURATION_MIN=$((DURATION_H * 60))

echo "=== A/B Test: $PARAM ==="
echo "A=$VALUE_A, B=$VALUE_B, metric=$METRIC, duration=${DURATION_H}h each"

# Variant A
echo "[$(date +%H:%M)] Applying A=$VALUE_A"
apply_param "$VALUE_A"
sleep 300  # warmup 5min
START_A=$(date +%s)
sleep $((DURATION_MIN * 60))
METRIC_A=$(get_metric $DURATION_MIN)
echo "[$(date +%H:%M)] A result: ${METRIC}=${METRIC_A}"

# Variant B
echo "[$(date +%H:%M)] Applying B=$VALUE_B"
apply_param "$VALUE_B"
sleep 300
START_B=$(date +%s)
sleep $((DURATION_MIN * 60))
METRIC_B=$(get_metric $DURATION_MIN)
echo "[$(date +%H:%M)] B result: ${METRIC}=${METRIC_B}"

# Result
WINNER="A"
if [[ -n "$METRIC_B" ]] && [[ -n "$METRIC_A" ]]; then
  # For latency metrics, lower is better; for rate metrics, higher
  case "$METRIC" in
    *_ms) [[ $(echo "$METRIC_B < $METRIC_A" | bc -l 2>/dev/null) == "1" ]] && WINNER="B" ;;
    *rate|embed_rate) [[ $(echo "$METRIC_B > $METRIC_A" | bc -l 2>/dev/null) == "1" ]] && WINNER="B" ;;
  esac
fi

RESULT=$(cat <<EOF
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","param":"$PARAM","value_a":"$VALUE_A","value_b":"$VALUE_B","metric":"$METRIC","metric_a":"$METRIC_A","metric_b":"$METRIC_B","winner":"$WINNER","duration_h":$DURATION_H}
EOF
)
echo "$RESULT" >> "$LOG"
echo "=== Winner: $WINNER (${METRIC}: A=${METRIC_A} vs B=${METRIC_B}) ==="
osascript -e "display notification \"A/B test done: $PARAM winner=$WINNER\" with title \"🧪 vcontext A/B\"" 2>/dev/null
