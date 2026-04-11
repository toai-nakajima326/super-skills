#!/bin/bash
# Wrapper for vcontext hooks — reads stdin from Claude Code and forwards to node
# Claude Code passes tool data as JSON on stdin for PostToolUse hooks

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v18.20.7/bin/node"
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
LOG="/tmp/vcontext-hook-debug.log"
CMD="${1:-tool-use}"

# Read all of stdin (non-blocking: if no stdin, skip)
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat 2>/dev/null)
fi

# Log every invocation for debugging
echo "[$(date '+%Y-%m-%d %H:%M:%S')] cmd=$CMD stdin_len=${#STDIN_DATA} pid=$$" >> "$LOG" 2>/dev/null

# Forward stdin to node script
if [ -n "$STDIN_DATA" ]; then
  echo "$STDIN_DATA" | "$NODE" "$HOOKS" "$CMD" 2>> "$LOG"
else
  "$NODE" "$HOOKS" "$CMD" 2>> "$LOG"
fi

EXIT_CODE=$?
[ $EXIT_CODE -ne 0 ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] EXIT=$EXIT_CODE" >> "$LOG" 2>/dev/null
exit 0
