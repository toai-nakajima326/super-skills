---
name: cache-auto-tune
description: "Use when system load metrics indicate the need to adjust cache sizes to optimize performance."
origin: auto-generated
---

## Rules

1. Use WebSearch to identify optimal cache configurations for different system load scenarios.
2. Generate and execute Bash scripts to dynamically adjust cache sizes based on real-time system load data.

## Workflow

1. Monitor system load metrics (CPU, memory, etc.) to determine cache adjustment needs.
2. Use WebSearch to find recommended cache configurations for similar system loads and workloads.
3. Generate Bash scripts to modify cache settings (e.g., adjusting 512MB/2GB thresholds).
4. Execute the scripts and validate the changes to ensure they meet performance goals.

## Gotchas

- Ensure WebSearch results are from reliable sources to avoid incorrect configurations.