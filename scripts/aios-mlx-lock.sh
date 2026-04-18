#!/usr/bin/env bash
# aios-mlx-lock.sh — Cross-process file lock for MLX concurrency coordination.
#
# Contract (compatible with aios-task-runner.js, aios-mlx-lock.js, aios_mlx_lock.py):
#   Lock file: /tmp/aios-mlx-lock
#   Format:    "<holder-id>\n"   (trailing newline)
#   Stale:     >25min mtime → auto-cleared
#   Re-entry: env AIOS_MLX_LOCK_HOLDER=<id> makes acquire/release a no-op so
#              parent-held locks survive child invocations.
#
# Usage:
#   scripts/aios-mlx-lock.sh acquire <holder-id> [wait-seconds]
#   scripts/aios-mlx-lock.sh release <holder-id>
#   scripts/aios-mlx-lock.sh status
#
# Exit codes:
#   0 = success (acquired/released/status printed)
#   1 = timeout waiting for lock
#   2 = bad argv
#
# Intended use in a bash script:
#
#     HOLDER="skill-discovery:$$"
#     if ! scripts/aios-mlx-lock.sh acquire "$HOLDER" 1200; then
#       echo "MLX busy, bailing" >&2
#       exit 1
#     fi
#     trap 'scripts/aios-mlx-lock.sh release "$HOLDER"' EXIT
#     # ... do MLX work ...

set -euo pipefail

LOCK_FILE=/tmp/aios-mlx-lock
STALE_S=$((25 * 60))
DEFAULT_WAIT_S=$((20 * 60))
ENV_VAR=AIOS_MLX_LOCK_HOLDER
POLL_INTERVAL=0.5

usage() {
  cat <<EOF >&2
Usage: $0 acquire <holder-id> [wait-seconds]
       $0 release <holder-id>
       $0 status
EOF
  exit 2
}

_read_holder() {
  [ -f "$LOCK_FILE" ] || { echo ""; return; }
  # Strip trailing newline for comparison.
  tr -d '\n' < "$LOCK_FILE" 2>/dev/null || echo ""
}

_is_stale() {
  [ -f "$LOCK_FILE" ] || return 1
  # macOS/BSD stat(1) uses different flags than GNU. Fall back to Python.
  if stat -f %m "$LOCK_FILE" >/dev/null 2>&1; then
    mtime=$(stat -f %m "$LOCK_FILE")
  elif stat -c %Y "$LOCK_FILE" >/dev/null 2>&1; then
    mtime=$(stat -c %Y "$LOCK_FILE")
  else
    mtime=$(python3 -c "import os; print(int(os.stat('$LOCK_FILE').st_mtime))")
  fi
  now=$(date +%s)
  age=$(( now - mtime ))
  [ "$age" -gt "$STALE_S" ]
}

# Extract PID from a holder-id string for D1 (2026-04-18).
# Known formats: `self-evolve:pid-12345:cycle-abc`,
#                `locomo-eval:pid-82515`,
#                `vcontext-server:45755:1776497618489`.
# Prints the PID to stdout, or nothing if no PID can be parsed.
_parse_holder_pid() {
  local holder="$1"
  [ -n "$holder" ] || return 0
  # Prefer explicit `:pid-<digits>` marker.
  if [[ "$holder" =~ :pid-([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  # Fallback: second colon-token is all-digits (vcontext-server pattern).
  # `a:123:b` → IFS split gives ['a', '123', 'b']; take index 1.
  IFS=':' read -r -a parts <<< "$holder"
  if [ "${#parts[@]}" -ge 3 ] && [[ "${parts[1]}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${parts[1]}"
  fi
}

# D1 PID-liveness stale check: `kill -0 <pid>` is a permission-free
# liveness probe on POSIX. Returns 0 (true) iff the holder's PID is
# provably dead (ESRCH). False if PID is alive, unparseable, or we
# lack permission to signal (EPERM — process exists under other uid).
_is_pid_dead() {
  local holder="$1"
  local pid
  pid=$(_parse_holder_pid "$holder")
  [ -n "$pid" ] || return 1          # no PID parseable → not dead
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  if kill -0 "$pid" 2>/dev/null; then
    return 1                         # alive
  fi
  # kill -0 failed. Distinguish ESRCH (dead) from EPERM (alive, other uid).
  # Bash doesn't expose errno, but we can re-probe via /proc on linux OR
  # `ps -p` cross-platform: if `ps -p <pid>` returns a row, process exists.
  if ps -p "$pid" >/dev/null 2>&1; then
    return 1                         # exists (was EPERM) → alive
  fi
  return 0                           # genuinely dead
}

_parent_holds() {
  # True iff env var set AND file content matches it.
  [ -n "${!ENV_VAR:-}" ] || return 1
  on_disk=$(_read_holder)
  [ "$on_disk" = "${!ENV_VAR}" ]
}

_try_acquire_atomic() {
  local holder="$1"
  if [ -f "$LOCK_FILE" ]; then
    local on_disk
    on_disk=$(_read_holder)
    # D1 2026-04-18: stale = mtime >25min OR holder PID dead.
    if _is_stale || _is_pid_dead "$on_disk"; then
      rm -f "$LOCK_FILE" 2>/dev/null || true
    else
      return 1
    fi
  fi
  # set -o noclobber + > redirect is the POSIX-correct O_CREAT|O_EXCL idiom.
  # `( set -C; > "$LOCK_FILE") 2>/dev/null` returns non-zero if the file
  # already exists (race-safe with other acquirers on the same host).
  if ( set -o noclobber; printf '%s\n' "$holder" > "$LOCK_FILE" ) 2>/dev/null; then
    return 0
  fi
  return 1
}

cmd_acquire() {
  local holder="${1:-}"
  local wait_s="${2:-$DEFAULT_WAIT_S}"
  if [ -z "$holder" ]; then usage; fi
  if [[ "$holder" == *$'\n'* ]]; then
    echo "holder-id must not contain newlines" >&2
    exit 2
  fi

  if _parent_holds; then
    # Re-entrant no-op — parent script already holds the lock.
    return 0
  fi

  local deadline=$(( $(date +%s) + wait_s ))
  while :; do
    if _try_acquire_atomic "$holder"; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "aios-mlx-lock: timeout waiting ${wait_s}s (holder=$(_read_holder))" >&2
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

cmd_release() {
  local holder="${1:-}"
  if [ -z "$holder" ]; then usage; fi
  if _parent_holds; then
    return 0  # parent still holds; they'll release
  fi
  [ -f "$LOCK_FILE" ] || return 0
  local on_disk
  on_disk=$(_read_holder)
  if [ "$on_disk" = "$holder" ]; then
    rm -f "$LOCK_FILE" 2>/dev/null || true
  fi
  return 0
}

cmd_status() {
  if [ ! -f "$LOCK_FILE" ]; then
    echo '{"held":false,"holder":null,"stale":false,"pid_dead":false}'
    return 0
  fi
  local holder mtime_stale pid_dead stale held
  holder=$(_read_holder)
  if _is_stale;       then mtime_stale=true; else mtime_stale=false; fi
  if _is_pid_dead "$holder"; then pid_dead=true; else pid_dead=false; fi
  # D1 2026-04-18: stale iff either condition true.
  if [ "$mtime_stale" = true ] || [ "$pid_dead" = true ]; then
    stale=true; held=false
    # Reclaim the file when the holder is provably dead so the next
    # acquirer doesn't have to wait for the mtime timer.
    if [ "$pid_dead" = true ] && [ "$mtime_stale" = false ]; then
      rm -f "$LOCK_FILE" 2>/dev/null || true
    fi
  else
    stale=false; held=true
  fi
  printf '{"held":%s,"holder":"%s","stale":%s,"pid_dead":%s}\n' \
    "$held" "$holder" "$stale" "$pid_dead"
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    acquire) cmd_acquire "$@" ;;
    release) cmd_release "$@" ;;
    status)  cmd_status "$@" ;;
    *)       usage ;;
  esac
}

main "$@"
