#!/bin/bash
# launchagent-health-check.sh — Verify all AIOS LaunchAgents are running/scheduled correctly.
#
# Every morning: did keyword-expander fire at 05:00? Did article-scanner run
# at 06:00? Is watchdog alive? This script answers in one screen.
#
# Usage:
#   bash scripts/launchagent-health-check.sh         # human report
#   bash scripts/launchagent-health-check.sh --json  # machine-readable
#
# Portable: avoids `declare -A` (not in macOS default bash 3.2) and uses
# case-statement lookups instead. Works on any bash ≥ 3.

set -u

JSON_MODE=0
[[ "${1:-}" == "--json" ]] && JSON_MODE=1

# Keep in sync with docs/vision/aios-schedule.md (inventory table).
AGENTS="com.vcontext.server
com.vcontext.watchdog
com.vcontext.mlx-embed
com.vcontext.mlx-generate
com.vcontext.ramdisk
com.vcontext.maintenance
com.vcontext.hooks-setup
com.vcontext.morning-brief
com.vcontext.article-scanner
com.vcontext.article-scanner-evening
com.vcontext.self-evolve
com.vcontext.keyword-expander
com.vcontext.skill-discovery"

kind_for() {
  # ramdisk: one-shot at boot (exits after mounting), treat like boot-only
  # hooks-setup: same pattern
  case "$1" in
    com.vcontext.server|com.vcontext.watchdog|com.vcontext.mlx-embed|com.vcontext.mlx-generate) echo daemon ;;
    com.vcontext.ramdisk|com.vcontext.hooks-setup) echo boot-only ;;
    com.vcontext.maintenance|com.vcontext.morning-brief|com.vcontext.article-scanner|com.vcontext.article-scanner-evening|com.vcontext.self-evolve|com.vcontext.keyword-expander) echo cron-daily ;;
    com.vcontext.skill-discovery) echo cron-weekly ;;
    *) echo unknown ;;
  esac
}

logfile_for() {
  case "$1" in
    com.vcontext.server) echo /tmp/vcontext-server.log ;;
    com.vcontext.watchdog) echo /tmp/vcontext-watchdog.log ;;
    com.vcontext.mlx-embed) echo /tmp/mlx-embed-server.log ;;
    com.vcontext.mlx-generate) echo /tmp/vcontext-mlx-generate.log ;;
    com.vcontext.ramdisk) echo /tmp/vcontext-setup.log ;;
    com.vcontext.maintenance) echo /tmp/vcontext-maintenance.log ;;
    com.vcontext.morning-brief) echo /tmp/vcontext-morning-brief.log ;;
    com.vcontext.article-scanner) echo /tmp/vcontext-article-scanner.log ;;
    com.vcontext.article-scanner-evening) echo /tmp/vcontext-article-scanner-evening.log ;;
    com.vcontext.self-evolve) echo /tmp/vcontext-self-evolve.log ;;
    com.vcontext.keyword-expander) echo /tmp/vcontext-keyword-expander.log ;;
    com.vcontext.skill-discovery) echo /tmp/vcontext-skill-discovery.log ;;
    *) echo "" ;;
  esac
}

loaded_pid() {
  launchctl list | awk -v label="$1" '$3 == label { print $1 }' | head -1
}

log_age_mins() {
  local f="$1"
  [[ -z "$f" || ! -f "$f" ]] && { echo "-"; return; }
  local mtime=$(stat -f %m "$f" 2>/dev/null || echo 0)
  local now=$(date +%s)
  echo $(( (now - mtime) / 60 ))
}

threshold_ok() {
  local kind="$1" age="$2"
  [[ "$age" == "-" ]] && return 1
  case "$kind" in
    daemon) (( age <= 15 )) ;;
    cron-daily) (( age <= 1560 )) ;;
    cron-weekly) (( age <= 11520 )) ;;
    boot-only) return 0 ;;
    *) return 1 ;;
  esac
}

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
[[ ! -t 1 ]] && { GREEN=""; RED=""; YELLOW=""; RESET=""; }

total=0; ok=0; warn=0; fail=0
rows=""

while IFS= read -r agent; do
  [[ -z "$agent" ]] && continue
  total=$((total+1))
  kind=$(kind_for "$agent")
  logf=$(logfile_for "$agent")
  pid=$(loaded_pid "$agent")
  age=$(log_age_mins "$logf")

  if [[ -z "$pid" ]]; then
    status="NOT-LOADED"; color="$RED"; fail=$((fail+1))
  elif [[ "$kind" == "daemon" ]] && [[ "$pid" == "-" ]]; then
    status="DAEMON-DOWN"; color="$RED"; fail=$((fail+1))
  elif threshold_ok "$kind" "$age"; then
    status="OK"; color="$GREEN"; ok=$((ok+1))
  else
    status="STALE"; color="$YELLOW"; warn=$((warn+1))
  fi

  if [[ $JSON_MODE -eq 1 ]]; then
    row="{\"agent\":\"$agent\",\"kind\":\"$kind\",\"pid\":\"${pid:-}\",\"log_age_min\":\"$age\",\"status\":\"$status\"}"
    [[ -z "$rows" ]] && rows="$row" || rows="$rows,$row"
  else
    printf "  %b%-12s%b  %-40s  kind=%-12s  pid=%-8s  log_age=%s min\n" \
      "$color" "$status" "$RESET" "$agent" "$kind" "${pid:-}" "$age"
  fi
done <<< "$AGENTS"

if [[ $JSON_MODE -eq 1 ]]; then
  echo -n '{"generated_at":"'
  date -u +%Y-%m-%dT%H:%M:%SZ | tr -d '\n'
  echo -n '","total":'$total',"ok":'$ok',"warn":'$warn',"fail":'$fail',"agents":['
  echo -n "$rows"
  echo ']}'
else
  echo ""
  echo "━━━ Summary ━━━"
  echo "  Total: $total | ${GREEN}OK: $ok${RESET} | ${YELLOW}STALE: $warn${RESET} | ${RED}FAIL: $fail${RESET}"
  if (( fail > 0 )); then
    echo ""
    echo "${RED}Action needed:${RESET} $fail agent(s) not loaded or not running."
    echo "  Try: launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/<label>.plist"
    exit 2
  fi
  if (( warn > 0 )); then
    echo ""
    echo "${YELLOW}Watch:${RESET} $warn agent(s) have stale logs."
    exit 1
  fi
  exit 0
fi
