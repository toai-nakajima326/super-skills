---
name: system-status-monitor
description: "Use when monitoring MLX dashboard metrics, cache usage, and session states for system anomalies"
origin: auto-generated
---
Rules
1. Only check metrics from authenticated MLX dashboards
2. Prioritize alerts for "MLX off" states and cache overflow thresholds
Workflow
1. Use WebFetch to access MLX dashboard endpoints
2. Parse JSON metrics for cache usage percentages
3. Cross-reference session states with system alerts
4. Generate priority alerts for critical thresholds
Gotchas
- MLX API rate limits may require token rotation
- Cache units (GB/MB) must match system documentation

SKILL_NAME: cache-configuration-checker
---
name: cache-configuration-checker
description: "Use when validating cache size settings against system specifications"
origin: auto-generated
---
Rules
1. Compare cache size values (e.g., "1GB") with system RAM capacity
2. Verify units match (GB vs TB) across configuration files
Workflow
1. Fetch system specs via WebSearch for cache limits
2. Parse cache configuration files for size parameters
3. Calculate cache percentage of total system memory
4. Flag discrepancies exceeding 80% utilization
Gotchas
- Some systems use "cache" as both RAM and storage
- Legacy systems may have undocumented limits