---
name: mlx-embed-server-automated-monitor
description: "Use when automating MLX embed server monitoring tasks including SQLite queries, health checks, and server restarts."
origin: auto-generated
---

## Rules

1. Only execute when MLX server metrics or logs trigger predefined thresholds
2. Prioritize non-intrusive monitoring to avoid impacting server performance

## Workflow

1. Parse task notifications to extract SQLite query parameters and health check commands
2. Execute monitored SQLite queries against the MLX embed server database
3. Perform automated health checks on server resources and connection pools
4. If critical failures detected, initiate server restart sequence with 30-second delay
5. Log all operations to centralized monitoring dashboard

## Gotchas

- Avoid conflicting with active MLX model inference processes during restarts
- Ensure SQLite queries are idempotent to prevent data corruption
- Verify server restarts don't trigger infinite restart loops