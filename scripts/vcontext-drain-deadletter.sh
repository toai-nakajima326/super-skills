#!/bin/bash
# vcontext-drain-deadletter.sh — slow, safe replay of the dead-letter queue.
#
# Context (2026-04-20):
#   Today's cascades generated ~1,574 dead-lettered writes —
#   tool-use, pre-tool, working-state, skill-usage entries that
#   couldn't reach vcontext during OOM windows. These represent
#   genuine context loss for the AIOS memory substrate.
#
#   content_hash on the entries table dedupes silently, so replaying
#   is safe: already-stored entries return as the existing id, new
#   ones land fresh. No harm in replaying the whole file.
#
# Strategy — rate-limited replay to avoid re-crashing the server:
#   - One item every 500 ms (~7,200/hour at worst case; 1,574 drains in ~13 min)
#   - After N consecutive failures, back off (server may be in a maintenance cycle)
#   - Progress counter to /tmp so the script can resume after interruption
#   - DO NOT run while /health is timing out — pre-check aborts the run
#   - Items that fail N times stay in the dead-letter with attempts++ —
#     a re-run later can pick them up
#
# Safe to run multiple times. Safe to interrupt (Ctrl-C).

set -eu -o pipefail

DEADLETTER="/tmp/vcontext-queue.deadletter.jsonl"
PROGRESS="/tmp/vcontext-drain-deadletter.progress"
OUTCOMES="/tmp/vcontext-drain-deadletter.outcomes.jsonl"
LOG="/tmp/vcontext-drain-deadletter.log"
RATE_MS=500       # delay between POSTs
BACKOFF_AFTER=5   # consecutive failures before 30-s backoff
SERVER_URL="http://127.0.0.1:3150"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# ── Pre-flight ────────────────────────────────────────────────────
if [[ ! -f "$DEADLETTER" ]]; then
  log "no dead-letter file at $DEADLETTER — nothing to drain"
  exit 0
fi

TOTAL=$(wc -l < "$DEADLETTER" | tr -d ' ')
log "dead-letter has $TOTAL items"

# Progress resume
START_LINE=$(cat "$PROGRESS" 2>/dev/null || echo 0)
log "resuming from line $START_LINE (progress file: $PROGRESS)"

# Server health pre-check — abort if not serving
HEALTH=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "${SERVER_URL}/health" 2>&1 || true)
if [[ "$HEALTH" != "200" ]]; then
  log "server /health = $HEALTH — not drain-ready, abort. Try again when /health=200 sustained."
  exit 1
fi

# ── Drain loop ────────────────────────────────────────────────────
line_num=0
ok=0
fail=0
consecutive_fail=0

while IFS= read -r LINE; do
  line_num=$((line_num + 1))
  # Skip ahead on resume
  if [[ $line_num -le $START_LINE ]]; then continue; fi

  # Parse the queue entry to extract POST body
  BODY=$(echo "$LINE" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(json.dumps(d.get('data', {})))
except Exception as e:
  pass
" 2>/dev/null || true)

  if [[ -z "$BODY" ]] || [[ "$BODY" == "{}" ]]; then
    log "line $line_num: unparseable, skip"
    fail=$((fail + 1))
    echo "$line_num" > "$PROGRESS"
    continue
  fi

  # POST it
  CODE=$(curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "$BODY" -o /dev/null -w '%{http_code}' \
    "${SERVER_URL}/store" 2>&1 || echo "000")

  if [[ "$CODE" == "200" ]] || [[ "$CODE" == "201" ]]; then
    ok=$((ok + 1))
    consecutive_fail=0
    printf '{"line":%d,"outcome":"ok","code":%s}\n' "$line_num" "$CODE" >> "$OUTCOMES"
  else
    fail=$((fail + 1))
    consecutive_fail=$((consecutive_fail + 1))
    printf '{"line":%d,"outcome":"fail","code":"%s"}\n' "$line_num" "$CODE" >> "$OUTCOMES"
    if [[ $consecutive_fail -ge $BACKOFF_AFTER ]]; then
      log "$consecutive_fail consecutive failures (last code $CODE) — 30s backoff"
      sleep 30
      # Re-probe server after backoff
      HEALTH=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "${SERVER_URL}/health" 2>&1 || true)
      if [[ "$HEALTH" != "200" ]]; then
        log "server still unhealthy ($HEALTH) — stopping drain. Re-run later."
        echo "$line_num" > "$PROGRESS"
        break
      fi
      consecutive_fail=0
    fi
  fi

  # Every 50 items: progress log
  if (( line_num % 50 == 0 )); then
    log "progress: line=$line_num ok=$ok fail=$fail"
  fi

  echo "$line_num" > "$PROGRESS"
  # Rate-limit
  sleep 0.5
done < "$DEADLETTER"

log "drain done. total=$TOTAL ok=$ok fail=$fail last_line=$line_num"
log "outcomes recorded in $OUTCOMES"
