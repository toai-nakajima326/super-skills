---
name: mlx-embed-health-check
description: "Use when automating health checks for MLX embed servers, including SQLite queries, curl-based status checks, and process footprint analysis with progress reporting."
origin: auto-generated
---
## Rules
1. Only execute on authorized MLX embed server endpoints.
2. Prioritize non-intrusive checks to avoid disrupting embeddings.

## Workflow
1. Run SQLite queries to track embedding job status and resource allocation.
2. Execute curl commands to validate server API endpoints and response times.
3. Analyze process footprints using system monitoring tools.
4. Generate a consolidated report with progress metrics and server health status.

## Gotchas
- SQLite queries may require elevated privileges on certain servers.
- Network latency can falsely indicate server instability.
- Avoid overlapping with existing `mlx-embed-server-monitoring-maintenance` workflows.

SKILL_NAME: system-health
---
name: system-health
---
description: "Use when monitoring overall system health, including resource utilization, error tracking, and adaptive alerting for MLX embed environments."
origin: auto-generated
---
## Rules
1. Monitor CPU, memory, disk, and network metrics at 1-minute intervals.
2. Correlate system health data with error logs from `error-tracking-and-notification`.

## Workflow
1