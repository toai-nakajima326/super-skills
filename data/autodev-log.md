# autodev-log

## 2026-04-15 -- AI OS Full System Audit

**Type**: Read-only audit
**Scope**: vcontext-server, MLX Embed, MLX Generate, SearXNG, hooks, watchdog, dashboard, data integrity
**Changes**: None (audit only)

### Findings Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 5 |
| MEDIUM   | 7 |
| LOW      | 2 |
| OK       | 17 |

### HIGH items requiring fixes

- H1: `promoteToRam()` SQL bug -- `supersedes` field not escaped (vcontext-server.js line 707)
- H2: FTS5 queries not sanitized for special chars (`<`, `/`, `,`) -- multiple callsites lack fallback
- H3: MLX Embed server intermittently unresponsive (avg 18.4s latency, GPU contention with Generate)
- H4: Watchdog does not monitor MLX Embed (port 3161) -- no auto-recovery
- H5: Discovery loop stuck repeating same topic on MLX Generate timeout

### Services status at audit time

- vcontext-server (3150): healthy, uptime 13 min
- MLX Embed (3161): healthy but intermittent timeouts, 4889 MB footprint
- MLX Generate (3162): healthy, 334 calls, 4686 MB
- SearXNG (8888): healthy, 34 results, Docker up 13 hours
- Data integrity: RAM=FTS=IDX=23263, SSD=23263, embedding coverage 99.9%
- Swap: 4748 MB / 5120 MB (93%)
