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

_parent_holds() {
  # True iff env var set AND file content matches it.
  [ -n "${!ENV_VAR:-}" ] || return 1
  on_disk=$(_read_holder)
  [ "$on_disk" = "${!ENV_VAR}" ]
}

_try_acquire_atomic() {
  local holder="$1"
  if [ -f "$LOCK_FILE" ]; then
    if _is_stale; then
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
    echo '{"held":false,"holder":null,"stale":false}'
    return 0
  fi
  local holder stale
  holder=$(_read_holder)
  if _is_stale; then stale=true; else stale=false; fi
  # Held = file exists AND not stale.
  local held
  if [ "$stale" = true ]; then held=false; else held=true; fi
  printf '{"held":%s,"holder":"%s","stale":%s}\n' "$held" "$holder" "$stale"
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
