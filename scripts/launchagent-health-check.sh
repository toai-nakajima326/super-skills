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
com.vcontext.skill-discovery
com.vcontext.task-runner"

kind_for() {
  # ramdisk: one-shot at boot (exits after mounting), treat like boot-only
  # hooks-setup: same pattern
  case "$1" in
    com.vcontext.server|com.vcontext.watchdog|com.vcontext.mlx-embed|com.vcontext.mlx-generate|com.vcontext.task-runner) echo daemon ;;
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
    com.vcontext.mlx-generate) echo /tmp/mlx-generate-server.log ;;
    com.vcontext.ramdisk) echo /tmp/vcontext-setup.log ;;
    com.vcontext.hooks-setup) echo /tmp/vcontext-hooks-setup.log ;;
    com.vcontext.maintenance) echo /tmp/vcontext-maintenance.log ;;
    com.vcontext.morning-brief) echo /tmp/vcontext-morning-brief.log ;;
    com.vcontext.article-scanner) echo /tmp/vcontext-article-scanner.log ;;
    com.vcontext.article-scanner-evening) echo /tmp/vcontext-article-scanner-evening.log ;;
    com.vcontext.self-evolve) echo /tmp/vcontext-self-evolve.log ;;
    com.vcontext.keyword-expander) echo /tmp/vcontext-keyword-expander.log ;;
    com.vcontext.skill-discovery) echo /tmp/vcontext-skill-discovery.log ;;
    com.vcontext.task-runner) echo /tmp/vcontext-task-runner.log ;;
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
  # boot-only agents exit after running once; a missing/stale log is expected.
  # They are healthy as long as the plist is loaded (checked upstream).
  [[ "$kind" == "boot-only" ]] && return 0
  [[ "$age" == "-" ]] && return 1
  case "$kind" in
    daemon) (( age <= 15 )) ;;
    cron-daily) (( age <= 1560 )) ;;
    cron-weekly) (( age <= 11520 )) ;;
    *) return 1 ;;
  esac
}

# next_fire_for: for cron-{daily,weekly} agents, parse launchctl print's
# StartCalendarInterval descriptor (Hour/Minute/Weekday) and return the
# next scheduled fire time as "YYYY-MM-DD HH:MM" in local tz.
# Returns "-" for non-cron agents or if no schedule is found.
# Returns "MALFORMED" if the plist is loaded but has no parseable descriptor.
next_fire_for() {
  local agent="$1" kind="$2"
  case "$kind" in
    cron-daily|cron-weekly) ;;
    *) echo "-"; return ;;
  esac

  local print_out
  print_out=$(launchctl print "gui/$(id -u)/$agent" 2>/dev/null) || {
    echo "NOT-LOADED"
    return
  }

  # Interval-based agents (StartInterval) have "run interval = N seconds"
  # instead of a calendar descriptor. Report as interval=Ns, not malformed.
  local run_interval
  run_interval=$(printf '%s\n' "$print_out" | sed -n 's/^[[:space:]]*run interval = \([0-9]*\) seconds.*/\1/p' | head -1)
  if [[ -n "$run_interval" ]]; then
    echo "every ${run_interval}s"
    return
  fi

  # Extract the descriptor block (between the { after "descriptor =" and
  # the matching }). Then grep "Hour"/"Minute"/"Weekday" lines.
  local desc
  desc=$(printf '%s\n' "$print_out" | awk '/descriptor = \{/{flag=1;next} flag && /\}/{flag=0} flag')
  if [[ -z "$desc" ]]; then
    echo "MALFORMED"
    return
  fi

  local hour minute weekday
  hour=$(printf '%s\n' "$desc"    | sed -n 's/.*"Hour" => \([0-9]*\).*/\1/p'    | head -1)
  minute=$(printf '%s\n' "$desc"  | sed -n 's/.*"Minute" => \([0-9]*\).*/\1/p'  | head -1)
  weekday=$(printf '%s\n' "$desc" | sed -n 's/.*"Weekday" => \([0-9]*\).*/\1/p' | head -1)

  # Require at least a minute. Hour may be absent — that's an hourly schedule
  # firing every hour at :MM (e.g., com.vcontext.maintenance Minute=45).
  if [[ -z "$minute" ]]; then
    echo "MALFORMED"
    return
  fi

  # Compute next fire using python3 (portable date math). Falls back to
  # plain "HH:MM" or ":MM" if python3 unavailable.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "${hour:-}" "$minute" "${weekday:-}" <<'PY'
import sys, datetime
hour_raw = sys.argv[1]; minute = int(sys.argv[2])
weekday_raw = sys.argv[3]
now = datetime.datetime.now()
if hour_raw == "":
    # Hourly schedule pinned to :MM — next fire is this hour's :MM if
    # still in the future, else next hour's :MM.
    target = now.replace(minute=minute, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(hours=1)
else:
    hour = int(hour_raw)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if weekday_raw == "":
        # daily: next occurrence >= now
        if target <= now:
            target += datetime.timedelta(days=1)
    else:
        # weekly: launchd Weekday — 0=Sun, 1=Mon, ... 6=Sat. Python
        # weekday(): 0=Mon..6=Sun. Convert launchd→python: (w-1) % 7, except
        # launchd 7 also means Sunday.
        w = int(weekday_raw) % 7
        target_wd = (w - 1) % 7  # python weekday
        delta = (target_wd - now.weekday()) % 7
        target += datetime.timedelta(days=delta)
        if delta == 0 and target <= now:
            target += datetime.timedelta(days=7)
print(target.strftime("%Y-%m-%d %H:%M"))
PY
  elif [[ -n "$hour" ]]; then
    printf '%02d:%02d\n' "$hour" "$minute"
  else
    printf ':%02d\n' "$minute"
  fi
}

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
[[ ! -t 1 ]] && { GREEN=""; RED=""; YELLOW=""; RESET=""; }

total=0; ok=0; warn=0; fail=0
rows=""

malformed_cron=0

while IFS= read -r agent; do
  [[ -z "$agent" ]] && continue
  total=$((total+1))
  kind=$(kind_for "$agent")
  logf=$(logfile_for "$agent")
  pid=$(loaded_pid "$agent")
  age=$(log_age_mins "$logf")
  next_fire=$(next_fire_for "$agent" "$kind")

  if [[ "$next_fire" == "MALFORMED" ]]; then
    malformed_cron=$((malformed_cron+1))
  fi

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
    row="{\"agent\":\"$agent\",\"kind\":\"$kind\",\"pid\":\"${pid:-}\",\"log_age_min\":\"$age\",\"status\":\"$status\",\"next_fire\":\"$next_fire\"}"
    [[ -z "$rows" ]] && rows="$row" || rows="$rows,$row"
  else
    printf "  %b%-12s%b  %-40s  kind=%-12s  pid=%-8s  log_age=%-4s min  next_fire=%s\n" \
      "$color" "$status" "$RESET" "$agent" "$kind" "${pid:-}" "$age" "$next_fire"
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
  if (( malformed_cron > 0 )); then
    echo ""
    echo "${RED}Malformed schedule:${RESET} $malformed_cron cron agent(s) have no parseable StartCalendarInterval descriptor."
    echo "  Inspect with: launchctl print gui/\$(id -u)/<label>"
  fi
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
