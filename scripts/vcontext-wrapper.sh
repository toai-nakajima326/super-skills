#!/bin/bash
# Zero-downtime wrapper for vcontext-server
# Watches for SIGHUP to gracefully restart the server
# Usage: ./scripts/vcontext-wrapper.sh

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v18.20.7/bin/node"
SERVER="/Users/mitsuru_nakajima/skills/scripts/vcontext-server.js"
PID_FILE="/tmp/vcontext-server.pid"

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  exit 0
}

reload() {
  echo "[wrapper] Reloading server..."
  # Start new server first (it will fail to bind if old is still up, so we kill old first)
  # But we use SO_REUSEPORT concept: kill old, immediately start new
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    # Wait briefly for port to free
    sleep 1
  fi
  start_server
  echo "[wrapper] Server reloaded (PID: $SERVER_PID)"
}

start_server() {
  $NODE "$SERVER" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
}

trap cleanup SIGTERM SIGINT EXIT
trap reload SIGHUP

echo "[wrapper] Starting vcontext server..."
start_server
echo "[wrapper] Server running (PID: $SERVER_PID)"

# Wait forever, restarting if server dies
while true; do
  wait "$SERVER_PID" 2>/dev/null
  EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "[wrapper] Server exited with code $EXIT_CODE, restarting in 2s..."
    sleep 2
    start_server
    echo "[wrapper] Server restarted (PID: $SERVER_PID)"
  else
    echo "[wrapper] Server exited cleanly"
    break
  fi
done
