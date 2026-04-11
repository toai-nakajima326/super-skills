#!/bin/bash
# Wrapper for vcontext hooks that logs everything for debugging
# and ensures proper execution regardless of environment

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v18.20.7/bin/node"
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
LOG="/tmp/vcontext-hook-debug.log"
CMD="${1:-tool-use}"

# Read stdin into variable (with timeout to avoid hanging)
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(timeout 2 cat 2>/dev/null || true)
fi

# Log
echo "[$(date '+%H:%M:%S')] cmd=$CMD stdin_len=${#STDIN_DATA}" >> "$LOG"

# Execute
if [ -n "$STDIN_DATA" ]; then
  echo "$STDIN_DATA" | "$NODE" "$HOOKS" "$CMD" 2>> "$LOG"
else
  "$NODE" "$HOOKS" "$CMD" 2>> "$LOG"
fi
