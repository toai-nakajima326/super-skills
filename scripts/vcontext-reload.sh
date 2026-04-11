#!/bin/bash
# Trigger zero-downtime reload of vcontext server
PID_FILE="/tmp/vcontext-server.pid"
WRAPPER_PID=$(pgrep -f "vcontext-wrapper.sh")

if [[ -n "$WRAPPER_PID" ]]; then
  echo "Sending SIGHUP to wrapper (PID: $WRAPPER_PID)..."
  kill -HUP "$WRAPPER_PID"
  sleep 2
  # Verify
  if curl -s http://localhost:3150/health | grep -q healthy; then
    echo "Server reloaded successfully!"
  else
    echo "WARNING: Server may not be healthy after reload"
  fi
else
  echo "Wrapper not running. Start with: ./scripts/vcontext-wrapper.sh"
fi
