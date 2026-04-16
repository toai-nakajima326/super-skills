#!/bin/bash
# Zero-downtime wrapper for vcontext-server
# Watches for SIGHUP to gracefully restart the server
# Usage: ./scripts/vcontext-wrapper.sh

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v24.15.0/bin/node"
SERVER="/Users/mitsuru_nakajima/skills/scripts/vcontext-server.js"
PID_FILE="/tmp/vcontext-server.pid"

# Load runtime env overrides (VCONTEXT_BIND=0.0.0.0 for LAN, etc.)
ENV_FILE="$HOME/skills/data/vcontext.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

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

wait_port_free() {
  # Wait up to 10s for port 3150 to be released by any prior process
  # before launching a new server. Without this, a watchdog-triggered
  # restart races against the dying server's TIME_WAIT and dies with
  # EADDRINUSE (66 such errors observed in the wild).
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -iTCP:3150 -sTCP:LISTEN -P -t >/dev/null 2>&1 || return 0
    # If something IS holding it, kill any stray non-wrapper process
    STRAY=$(lsof -iTCP:3150 -sTCP:LISTEN -P -t 2>/dev/null | head -1)
    if [[ -n "$STRAY" ]] && [[ "$STRAY" != "$SERVER_PID" ]]; then
      kill -9 "$STRAY" 2>/dev/null
    fi
    sleep 1
  done
}

start_server() {
  wait_port_free
  $NODE "$SERVER" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
}

trap cleanup SIGTERM SIGINT EXIT
trap reload SIGHUP

echo "[wrapper] Starting vcontext server..."
start_server
echo "[wrapper] Server running (PID: $SERVER_PID)"

# After startup: wait for health, then drain any queued writes that
# accumulated while the server was down. Runs in background so startup
# is not blocked.
(
  HOOK_JS="$HOME/skills/scripts/vcontext-hooks.js"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s --max-time 1 http://127.0.0.1:3150/health >/dev/null 2>&1 && break
    sleep 1
  done
  if [ -f /tmp/vcontext-queue.jsonl ] && [ -f "$HOOK_JS" ]; then
    "$NODE" "$HOOK_JS" drain-queue >> /tmp/vcontext-startup-drain.log 2>&1
  fi
) &

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
