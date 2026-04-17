# Changelog

## 2026-04-17

A single-day stabilization & performance sweep (80+ commits).
Highlights, grouped by theme.

### 🛡️ Data protection (defence in depth)

- Async SSD write-through with id alignment (`handleStore` wrapped in
  `setImmediate`) — no longer blocks HTTP response on SSD I/O.
- Append-only JSONL log at `data/entries-wal.jsonl` — SQLite-independent
  durable write log. Survives any DB-level corruption.
- `checkAndRecoverDb` — on startup, `sqlite3 .recover` salvages raw
  entries from a corrupt RAM DB, then restores from snapshot, then
  `INSERT OR IGNORE`s salvaged rows back. Verified E2E on a 1.8 GB DB
  (`docs/analysis/2026-04-17-recovery-e2e-verification.md`).
- 1-min `rawSyncTimer` — RAM→SSD entries catch-up timer separate from the
  heavier 5-min backup/migration tick. Loss window: 5 min → 1 min.
- `POST /admin/replay-wal` / `GET /admin/wal-status` endpoints —
  catastrophic-recovery tooling.
- RAM disk 4 GB → **6 GB** (`vcontext-setup.sh`); `wal_autocheckpoint`
  500 pages on both RAM and SSD DBs.

### ⚡ Performance

| Metric (24 h → current) | Before | After | Ratio |
|---|---|---|---|
| recall avg | 3184 ms | 642 ms | 5× |
| recall max | 25 040 ms | 2 787 ms | 9× |
| store max | 38 145 ms | 3 337 ms | 11× |
| recent max | 16 226 ms | 286 ms | **56×** |
| embed throughput | 0/min (stalled) | 45/min | — |
| dashboard bandwidth | 3.5 MB / refresh | 225 KB | 94% cut |
| `/ai/status` | 1199 ms | 682 ms | 1.8× |
| summarize latency | 15 765 ms | 1 472 ms | **91% faster** (Qwen3 `/no_think`) |

Root causes that turned out to share a shape (fixed in both places):

- `withMlxLock` serialized background batches behind user-facing queries
  — fixed in recall (`mlxEmbedFast`) and embed-loop (`_mlxEmbedBatchRaw`).
- Silent `catch{}` on MLX availability probes flipped flags to false
  permanently — fixed with hysteresis + logging in both `checkMlx` and
  `checkMlxGenerate`.
- Watchdog `pgrep -f "mlx-generate-server"` never matched the real
  `python3 -m mlx_lm.server` cmdline → perpetual restart loop every 60 s.

### 🐛 Bug fixes

- `truncated is not defined` in `/session/:id` — orphan var after pagination refactor
- `malformed JSON` flood on `/analytics/skill-effectiveness` — SQLite optimizer
  pushed `json_each` above the type filter; switched to pure-JS aggregation
- dashboard frozen at "Loading..." — `var recent` shadowed `const recent`
  from outer scope → parse-time SyntaxError; renamed + added `Cache-Control: no-cache`
- watchdog ran 3+ duplicate instances after reloads → added pidfile singleton
- MLX Generate memory threshold 8 GB was catching steady-state, flapping
  the server every 4 min → raised to 14 GB
- `entry_index` had 28 538 orphan rows (deleted-entries residue) — purged
  + added incremental sweep to the 5-min tick
- `/ai/status` was 6 full-table `COUNT(*)` scans → one `SUM(CASE)` aggregate

### 🧩 Features

- **Morning brief** at 09:00: `com.vcontext.morning-brief` LaunchAgent +
  `GET /admin/health-report?days=N` endpoint + macOS notification +
  optional Slack/Discord webhook
- **Anomaly auto-response** (`respondToAnomalies`): per-kind handlers for
  embed-stall / ram-ahead / ram-disk-full / error-spike with 5-min cooldown
  and `type='anomaly-response'` audit trail
- **Dashboard Data Protection card** — JSONL WAL size, fill %, and the
  defence-in-depth chain explainer
- **Dashboard labels** — metric values now distinguish lifetime vs
  period (`N entries total (Xms/write · 24h)`, `Y queries/24h`, skills
  `registered (N lifetime, M in 24h) K matches/24h`)
- **`npm test` smoke suite** — 25 shape-asserting checks catch regressions
  like the truncated bug in < 5 s
- **`scripts/pre-outage.sh`** — one-command pre-shutdown data-safety checklist
- **Anomaly detection +3**: latency regression vs 7d baseline / DB write
  error count in recent log / embed backlog growth

### 🏷️ Rename: super-skills → infinite-skills

Internal auto-routing skill renamed across all 5 deploy targets
(claude / codex / cursor / kiro / antigravity). Earlier `auto-router`
residue (skill-registry DB row, manifest entries, server fallbacks)
also cleaned up.

*Preserved:* `scripts/sync-upstream.sh` still references `takurot/super-skills`
(external GitHub repo — not a skill name).

### 🔧 Operational

- **Watchdog tunables via env vars** — `VCONTEXT_MLX_GEN_MAX_MB`,
  `VCONTEXT_RAM_WARN_PCT`, etc. Ops can tune thresholds without code edits.
- **Module-split pattern established** — `scripts/lib/vcontext-utils.js`
  with pure helpers (esc, ftsQuery, estimateTokens, parseTags) as a
  proof-of-concept for future extraction (MLX client, DB layer, route
  handlers).
- **Snapshot pruning** — `data/snapshots/` 12 GB → 5.6 GB (kept
  initial-os + daily + pre-reboot).
- **RECOVERY.md** — runbook for cold-start, corrupt-RAM recovery,
  catastrophic-DB-loss, crash-loop, watchdog-flap, MLX-deadlock,
  RAM-disk-full scenarios.

### 📊 Tooling

- `experiment-thinking-skip.sh` — A/B harness measuring Qwen3 `<think>` cost
- `smoke-test.sh` — 25 endpoint shape checks + JS parse validation
- `pre-outage.sh` — 9-step data-safety checklist
- `vcontext-morning-brief.sh` — daily health digest generator
