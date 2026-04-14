#!/bin/bash
# Trigger reload of vcontext server via launchd (clean restart, no port conflicts)
PLIST="com.vcontext.server"

echo "Reloading vcontext server via launchd..."
launchctl kickstart -k "gui/$(id -u)/$PLIST" 2>/dev/null

if [ $? -ne 0 ]; then
  # Fallback: unload/load cycle
  echo "kickstart unavailable, using unload/load..."
  launchctl unload ~/Library/LaunchAgents/${PLIST}.plist 2>/dev/null
  sleep 1
  # Kill any orphaned processes
  lsof -ti :3150 | xargs kill -9 2>/dev/null
  sleep 1
  launchctl load ~/Library/LaunchAgents/${PLIST}.plist 2>/dev/null
fi

sleep 3
if curl -s http://localhost:3150/health | grep -q healthy; then
  echo "Server reloaded successfully!"
else
  echo "WARNING: Server may not be healthy after reload"
fi
