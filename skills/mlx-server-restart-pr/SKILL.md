---
name: mlx-server-restart-pr
description: "Use when automatic server restarts are required based on health check failures or resource thresholds"
origin: auto-generated
---
## Rules
1. Only initiate restarts after confirming server health checks have failed twice consecutively
2. Prioritize restarts during maintenance windows to minimize service disruption

## Workflow
1. Execute mlx-embed-health-check to verify server status and resource metrics
2. If critical thresholds (CPU >90%, memory >85%, disk >95%) are exceeded, trigger restart sequence
3. Log restart initiation with timestamp and reason in system event logs
4. Verify server status post-restart using health check protocols

## Gotchas
- Avoid restarting during active user sessions or critical operations
- Ensure backup processes are paused before restart to prevent data loss