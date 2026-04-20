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
WEBHOOK_URL="${VCONTEXT_ALERT_WEBHOOK:-}"  # Set env var for Slack/Discord/LINE
LAST_NOTIFY_FILE="/tmp/vcontext-watchdog-last-notify.txt"

# Log-path note (2026-04-18 audit M6): watchdog stdout/stderr goes to
# /tmp/vcontext-watchdog.log via com.vcontext.watchdog.plist, distinct
# from the server's /tmp/vcontext-server.log (com.vcontext.server.plist).
# No collision — both plists write to their own file.

# ── Tunables (override via env) ───────────────────────────────
# All thresholds here so ops can tune without editing code.
# Memory thresholds reflect steady-state + buffer, not leak detection:
#   Qwen3-8B-4bit ~6GB + draft 0.5GB + prompt cache 1GB + runtime 2GB = ~10GB
#   Embed 8B-DWQ  ~5GB + cache                                       = ~5-6GB
# Defaults relaxed 2026-04-20 after 08:16 force-restart loop incident:
# 20s interval + VCONTEXT_RESTART_ON_HEALTH_FAIL=1 killed the server
# repeatedly during its 79s SQLite cold-boot. User-vacation (36h) window
# is over — back to calmer defaults + new cold-boot grace below.
CHECK_INTERVAL="${VCONTEXT_WATCHDOG_INTERVAL:-60}"           # seconds between checks (was 20; 60 allows SQLite cold boot to finish)
NOTIFY_COOLDOWN="${VCONTEXT_WATCHDOG_COOLDOWN:-300}"          # min gap between user notifications
VCONTEXT_RESTART_ON_HEALTH_FAIL="${VCONTEXT_RESTART_ON_HEALTH_FAIL:-0}"  # 1=force launchctl bootout+bootstrap on /health fail; 0=legacy wrapper-only (default: legacy, set =1 only during vacation / unattended windows)
# Cold-boot grace: SQLite migration + backfill index on startup take
# up to 79s on a 6 GB primary DB (observed 2026-04-20 morning). Force-
# restart during that window kills the server mid-backfill → infinite
# cascade. Never force-restart a server younger than this threshold.
VCONTEXT_COLD_BOOT_GRACE_S="${VCONTEXT_COLD_BOOT_GRACE_S:-180}"  # seconds; 3× worst-observed cold boot
RAM_WARN_PCT="${VCONTEXT_RAM_WARN_PCT:-85}"                  # warn at this RAM disk fill %
RAM_CRIT_PCT="${VCONTEXT_RAM_CRIT_PCT:-95}"                  # emergency cleanup at this %
MLX_GEN_MAX_MB="${VCONTEXT_MLX_GEN_MAX_MB:-14000}"           # MLX Generate memory kill threshold (14 GB)
MLX_EMBED_MAX_MB="${VCONTEXT_MLX_EMBED_MAX_MB:-10000}"       # MLX Embed memory kill threshold (10 GB)
MLX_GEN_CALL_LIMIT="${VCONTEXT_MLX_GEN_CALL_LIMIT:-200}"     # restart MLX Generate after N calls (prevents gradual hang)

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
    # Reset fail counter on success (2026-04-18 aggressive recovery mode)
    rm -f /tmp/vcontext-watchdog-server-fails 2>/dev/null
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
    elif [[ "$VCONTEXT_RESTART_ON_HEALTH_FAIL" == "1" ]]; then
      # 2026-04-18: wrapper alive but /health not responding → process likely
      # hung (main-thread starvation or mid-OOM). Force bootout + bootstrap
      # for a clean cycle. 2-strike guard to avoid flapping on transient.
      #
      # 2026-04-20 fix — cold-boot grace: if the server process was started
      # within VCONTEXT_COLD_BOOT_GRACE_S (default 180s), skip force-restart.
      # Our SQLite cold boot takes up to 79s (schema migration + backfill
      # index + WAL replay on a 6GB primary DB). Force-killing during that
      # window creates an infinite loop that never lets the server finish.
      # Root cause of this morning's 07:42→08:16 cascade.
      # Per dabrahams launchd research: launchd's own ThrottleInterval
      # will start ignoring our re-bootstrap calls ("You're not that
      # important. Ignoring.") if we cycle too fast — another reason to
      # wait patiently for cold boot instead of re-hammering.
      SERVER_PID=$(pgrep -f vcontext-server.js 2>/dev/null | head -1)
      SERVER_AGE_S=0
      if [[ -n "$SERVER_PID" ]]; then
        SERVER_AGE_S=$(ps -o etimes= -p "$SERVER_PID" 2>/dev/null | tr -d ' ' || echo 0)
      fi
      if [[ "$SERVER_AGE_S" -gt 0 ]] && [[ "$SERVER_AGE_S" -lt "$VCONTEXT_COLD_BOOT_GRACE_S" ]]; then
        log "Server too young (${SERVER_AGE_S}s < ${VCONTEXT_COLD_BOOT_GRACE_S}s cold-boot grace) — skip force-restart, let cold boot finish"
        # Don't increment fail counter during grace window — the server
        # just isn't ready yet, not hung.
      else
        FAIL_FILE="/tmp/vcontext-watchdog-server-fails"
        FAILS=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
        FAILS=$((FAILS + 1))
        echo "$FAILS" > "$FAIL_FILE"
        if [[ "$FAILS" -ge 2 ]]; then
          log "Server /health fail x${FAILS} (age=${SERVER_AGE_S}s) — force bootout + bootstrap"
          launchctl bootout "gui/$(id -u)/com.vcontext.server" 2>/dev/null
          sleep 2
          pkill -9 -f vcontext-wrapper 2>/dev/null
          pkill -9 -f vcontext-server.js 2>/dev/null
          sleep 3
          rm -f /tmp/aios-mlx-lock
          launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.vcontext.server.plist" 2>/dev/null
          rm -f "$FAIL_FILE"
          sleep 15
          if check_health; then
            send_recovery "Server force-restarted successfully"
            WAS_DOWN=false
          fi
        fi
      fi
    fi
  fi

  # Self-heal: ensure launchd is managing com.vcontext.server.
  # Seen 2026-04-18: after a previous session's /admin/stop-aios call
  # (which used `launchctl bootout`), the service was missing from the
  # launchctl service graph after reboot despite the plist being valid.
  # Without this block, the server stayed down until the user manually
  # ran `launchctl bootstrap`.
  # Honors `launchctl disable` state — if the user explicitly disabled
  # via the new stop-aios flow, we do NOT re-enable (respecting intent).
  UID_NUM=$(id -u)
  SVC="gui/${UID_NUM}/com.vcontext.server"
  PLIST="$HOME/Library/LaunchAgents/com.vcontext.server.plist"
  if [[ -f "$PLIST" ]]; then
    if ! launchctl print "$SVC" >/dev/null 2>&1; then
      if launchctl print-disabled "gui/${UID_NUM}" 2>/dev/null | grep -q '"com.vcontext.server" => \(true\|disabled\)'; then
        log "com.vcontext.server is disabled by user — not auto-bootstrapping"
      else
        log "com.vcontext.server missing from launchd graph — bootstrapping from $PLIST"
        if launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null; then
          log "bootstrap OK"
        else
          log "bootstrap failed (retry next cycle)"
        fi
      fi
    fi
  fi

  # RAM disk capacity check — every cycle (critical: DB corruption risk if full)
  RAM_USED_PCT=$(df /Volumes/VContext 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  if [[ -n "$RAM_USED_PCT" ]]; then
    if [[ "$RAM_USED_PCT" -ge $RAM_CRIT_PCT ]]; then
      log "RAM DISK CRITICAL: ${RAM_USED_PCT}% used — emergency cleanup"
      # Remove any corrupt DB backups. Two patterns are possible:
      #   * vcontext-corrupt-*.db             (original checkAndRecoverDb format)
      #   * vcontext.db.corrupted-YYYYMMDD-HHMM (format observed 2026-04-18 —
      #     a 2.6GB leftover filled 98% of the 6GB RAM disk, cascading into
      #     WAL-write failures → DB corruption → new corrupted copy → loop)
      rm -f /Volumes/VContext/vcontext-corrupt-*.db 2>/dev/null
      rm -f /Volumes/VContext/vcontext.db.corrupted-* 2>/dev/null
      rm -f /Volumes/VContext/vcontext*corrupt*.db 2>/dev/null
      # Force WAL checkpoint to flush and shrink
      sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null
      osascript -e "display notification \"RAM disk ${RAM_USED_PCT}% — emergency cleanup\" with title \"🚨 vcontext CRITICAL\"" 2>/dev/null
    elif [[ "$RAM_USED_PCT" -ge $RAM_WARN_PCT ]]; then
      log "RAM DISK WARN: ${RAM_USED_PCT}% used"
      sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(PASSIVE);" 2>/dev/null
      osascript -e "display notification \"RAM disk ${RAM_USED_PCT}% — watch closely\" with title \"⚠️ vcontext\"" 2>/dev/null
    fi
  fi

  # Check SearXNG every cycle (commit 3698c3b, 2026-04-16: simplified
  # from a 5-iteration sub-sample to every iteration so recovery time
  # tracks CHECK_INTERVAL, not 5*CHECK_INTERVAL). Counter is retained
  # for any future sub-sampling without renaming.
  SEARXNG_CHECK_COUNTER=$((SEARXNG_CHECK_COUNTER + 1))
  if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]; then
    check_searxng
  fi

  # MLX Embed health check every cycle (was a 5-iter sub-sample pre-3698c3b).
  # 2026-04-18 INCIDENT (44 restarts in 2h): the previous check used
  #   curl --max-time 5  on /health  AND  restart on first failure.
  # But the server's /health handler shares Python's asyncio event loop
  # with /embed_batch; an 8B batch can block the loop for 5-45s, so
  # /health times out legitimately. The watchdog was killing the server
  # mid-batch, causing the vcontext embed backlog to grow instead of shrink.
  # Fix:
  #   (a) extend curl timeout 5s -> 30s  (longer than typical embed batch)
  #   (b) require TWO consecutive failures before kill (one transient
  #       block during a batch is not a hang)
  #   (c) cap memory-based restart at MLX_EMBED_MAX_MB only AFTER the
  #       health probe passes — a 9-10GB spike during a batch is normal,
  #       not a leak.
  # State file tracks consecutive failures across watchdog iterations.
  EMBED_FAIL_FILE="/tmp/vcontext-watchdog-mlx-embed-fails"
  if [[ $((SEARXNG_CHECK_COUNTER % 1)) -eq 0 ]]; then
    EMBED_PID=$(pgrep -f "mlx-embed-server" | head -1)
    if [[ -n "$EMBED_PID" ]]; then
      EMBED_HEALTH=$(curl -s --max-time 30 http://127.0.0.1:3161/health 2>/dev/null)
      EMBED_MB=$(footprint -p "$EMBED_PID" 2>/dev/null | grep Footprint | grep -o '[0-9]* MB' | grep -o '[0-9]*')
      if [[ -z "$EMBED_HEALTH" ]]; then
        EMBED_FAILS=$(cat "$EMBED_FAIL_FILE" 2>/dev/null || echo 0)
        EMBED_FAILS=$((EMBED_FAILS + 1))
        echo "$EMBED_FAILS" > "$EMBED_FAIL_FILE"
      else
        EMBED_FAILS=0
        echo 0 > "$EMBED_FAIL_FILE"
      fi
      # Only restart when: (probe failed twice in a row) OR (probe OK but memory over cap)
      if [[ "$EMBED_FAILS" -ge 2 ]] || { [[ -n "$EMBED_HEALTH" ]] && [[ -n "$EMBED_MB" ]] && [[ "$EMBED_MB" -gt $MLX_EMBED_MAX_MB ]]; }; then
        log "MLX Embed restart: fails=${EMBED_FAILS} health=${EMBED_HEALTH:+ok}${EMBED_HEALTH:-timeout} mem=${EMBED_MB:-?}MB"
        launchctl unload ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
        sleep 1; kill -9 "$EMBED_PID" 2>/dev/null; lsof -ti :3161 | xargs kill -9 2>/dev/null
        sleep 1; launchctl load ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
        echo 0 > "$EMBED_FAIL_FILE"
        log "MLX Embed restarted"
      fi
    else
      log "MLX Embed not running, starting..."
      launchctl load ~/Library/LaunchAgents/com.vcontext.mlx-embed.plist 2>/dev/null
    fi
  fi

  # MLX Generate health check every cycle (was a 5-iter sub-sample pre-3698c3b).
  # /health responds even when generation hangs — so we probe an ACTUAL
  # completion with 15s timeout. This is how the 2026-04-14 halt went
  # undetected for a day: /health was up but generation was dead.
  # Note: on the fallback /v1/chat/completions probe this block can take up
  # to ~90s (> CHECK_INTERVAL=60s). The outer `sleep CHECK_INTERVAL` still
  # runs after, so worst-case cycle is ~90+60=150s — still far below the
  # 5*CHECK_INTERVAL=300s the old sub-sampled design took, so every-iter
  # sampling strictly improves detection latency.
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
      # Threshold 14GB (was 8GB).  Qwen3-8B-4bit ≈6GB, Qwen3-0.6B-MLX-4bit
      # draft ≈0.5GB, prompt cache 1GB, runtime buffers ≈2GB → normal
      # resident ~10GB. 8GB kept flapping the server every 4 min today
      # (watchdog log 12:03, 12:07, 12:13) which in turn OOM'd node via
      # GPU contention + cache thrash. 14GB leaves headroom while still
      # catching a genuine leak.
      if [[ -n "$GEN_MB" ]] && [[ "$GEN_MB" -gt $MLX_GEN_MAX_MB ]]; then
        NEED_RESTART=true; REASON="memory ${GEN_MB}MB > 14GB"
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
      if [[ -n "$GEN_CALLS" ]] && [[ "$GEN_CALLS" -gt $MLX_GEN_CALL_LIMIT ]]; then
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
