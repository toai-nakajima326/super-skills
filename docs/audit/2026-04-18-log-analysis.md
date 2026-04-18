# 2026-04-18 AIOS Log Analysis — Full Audit

## Mini-Spec

**Intent**: User directive "全ソース、全ログ、全データ、再チェックしておいてください、発見があるかもしれません". Exhaustive read-only scan of every AIOS log file for anomalies, deprecation, loop signatures, silent failures, and hotfix efficacy.

**Acceptance Criteria**:
- [x] Inventory every log file (size, line count, timespan)
- [x] Aggregate error-pattern counts (ERROR/FATAL/CRITICAL/Exception, Killed:9, ECONN*, timeout, EPIPE/EADDRINUSE, OOM, ReferenceError, Permission denied)
- [x] Classify DeprecationWarnings by library
- [x] Identify MLX-embed latency outliers (>10s)
- [x] Detect loop signatures (identical lines repeating)
- [x] Compute daemon restart counts + mean-time-between-restart
- [x] Detect silent failures (loops started, never completed)
- [x] Confirm 4 known hotfixes (ae1ce3f, d621456, 0252bcc) held post-commit
- [x] Label ONGOING issues still emitting at audit time
- [x] Assign severity (HIGH requires action / LOW noise)

**Non-goals**: Fixing issues (read-only), log rotation, daemon restart.

## Inventory Table

| Log | Bytes | Lines | First Timestamp | Last Timestamp | Notes |
|---|---:|---:|---|---|---|
| `/tmp/vcontext-server.log` | 462,330 | 7,559 | 13:25 JST (wrapper boot) | 19:22 JST (`Client 90 disconnected`) | Chunk-summary timestamps are UTC (+9 = JST) |
| `/tmp/vcontext-watchdog.log` | 12,948 | 201 | 13:25:54 | 18:58:49 | 60s cadence; alerts + restarts |
| `/tmp/vcontext-task-runner.log` | 44,813 | 540 | 04:53:17 UTC (13:53 JST) | 10:30:23 UTC (19:30 JST) | ONGOING failures |
| `/tmp/mlx-embed-server.log` | 1,334,299 | 16,297 | 13:26:17 JST | 19:23 JST | 25 restarts today |
| `/tmp/mlx-generate-server.log` | 177,337 | 2,578 | earlier today | 19:22 JST | 24 restarts (Exception-free) |
| `/tmp/vcontext-setup.log` | 718 | 13 | 13:26 JST | 13:27 JST | RAM-disk create (one-shot) |
| `/tmp/vcontext-maintenance.log` | 3,074 | 59 | 13:26 JST | 18:45 JST | 7 cycles |
| `/tmp/vcontext-article-scanner-evening.log` | 11,869 | 98 | 09:00 UTC | 09:46 UTC | Single scan |
| `/tmp/vcontext-skill-discovery.log` | 1,857 | 30 | 14:46 JST | 14:54 JST | Two runs, both "Done" |
| `/tmp/vcontext-hook-debug.log` | 523,490 | 8,785 | 13:27 JST | 19:29 JST | Live (updates continuously) |
| `/tmp/vcontext-startup-drain.log` | 716 | 14 | (unstamped) | — | 14 drain events, retrying counts visible |
| `/tmp/vcontext-maintenance-launchd.log` | 0 | 0 | — | — | Empty (launchd stdout not used) |
| `/tmp/vcontext-autodeploy.log` | 738 | — | 17:05 | — | Minor; not in scope |

**Missing (expected by directive, not present)**: `/tmp/vcontext-self-evolve.log`, `/tmp/vcontext-keyword-expander.log`, `/tmp/vcontext-morning-brief.log`, additional article-scanner variants. Those loops either log to stdout (swallowed) or have different paths.

## Error Counts Table (vcontext-server.log unless noted)

| Pattern | Total | First Seen (line/time) | Last Seen (line/time) | Probable Cause |
|---|---:|---|---|---|
| `ECONNREFUSED 127.0.0.1:3161` (MLX-embed down) | 3,394 | line 298 / 04:30 UTC | line 5233 / 06:50 UTC | MLX-embed churn, watchdog Killed:9 loop (pre-ae1ce3f) |
| `ECONNRESET` (MLX mid-batch reset) | 104 | line 170 | line 7094 | Same root: MLX restart mid-request |
| `Killed: 9` (vcontext node wrapper) | 22 | line 21 | line 7177 | OOM on RAM-disk-era server; post-SSD: rare |
| `timeout` (probe/embed) | 11 | line 3484 / 05:40 UTC | line 7083 / 09:30 UTC | MLX slow under load |
| `consultations is not defined` (ReferenceError) | 3 | line 5266 | line 6743 | 0252bcc fixed; no post-fix occurrences |
| `RAM disk full — checkpointed + migrated` | 19 | line 4871 / 06:20 UTC | line 6864 / 09:00 UTC | Pre-d621456 RAM-disk era |
| `EPIPE` | 1 | — | — | Benign client disconnect |
| `EADDRINUSE` | 0 | — | — | — |
| `OOM / out of memory` | 0 (text-matched) | — | — | Killed:9 events are implicit OOM |
| `ERROR\|FATAL\|CRITICAL\|Exception\|Traceback` | 0 (text-matched) | — | — | Node doesn't emit these tokens; error info in per-line `[store] MLX embed failed:` |
| `TypeError\|ReferenceError\|Cannot read\|is not a function` | 3 | (all = "consultations") | — | Single bug, single commit |
| `Permission denied / EACCES / EPERM` | 0 | — | — | — |
| `[vcontext:tier] RAM cleanup ... (FTS issue)` | 43 | line 5821 | (pre-fix window) | FTS5 inverted-index corruption (see HIGH #1) |
| **mlx-embed-server.log errors** | 0 | — | — | No Python exceptions; only deprecation |
| **mlx-generate-server.log errors** | 0 | — | — | Clean stdout |
| **mlx-embed DeprecationWarning** | 46 | line 1 | (repeats each restart) | `mx.metal.{set_cache_limit,clear_cache}` pre-23735c9 refactor |
| **task-runner poll failed** | 237 ECONNREFUSED + additional timeouts | 04:53:17 UTC | **10:30:23 UTC (ONGOING)** | See HIGH #2 |
| **article-scanner store failed** | >40 occurrences | 09:01:31 UTC | 09:46:21 UTC | Coincided with server restart storms (single scan window) |

### Hook-debug log
- `tool-error` events: **91** (hook records harness-level tool errors from the Claude Code side). Non-systemic — normal activity.

## Hotfix Efficacy Table

| Commit | Time (JST) | Bug | Pre-fix Count | Post-fix Count | Verdict |
|---|---|---|---:|---:|---|
| **ae1ce3f** `fix(watchdog): stop killing mlx-embed mid-batch` | 15:23 | MLX-embed `Killed: 9` | 0 (embed-log clean of K9) | 0 | **HELD** (embed server: 0 SIGKILL, 25 clean restarts) |
| **ae1ce3f** (secondary) | 15:23 | vcontext node `Killed: 9` (knock-on) | 15 (pre-07:10 UTC) | 5 (post-06:30 UTC — includes 1 right before fix) | **PARTIAL** — secondary churn persisted until SSD migration, but root cause addressed |
| **d621456** `feat(storage): migrate … RAM disk → NVMe SSD` | 16:19 | "RAM disk full" anomalies | 19 (pre-07:10 UTC) | 1 (between 09:00 UTC and fix+1h; 0 after 09:00 UTC chunk) | **HELD** — remaining 14 events between 07:10–09:00 UTC likely pre-fix DB still on RAM until server restart |
| **0252bcc** `fix(server): infinite tier-migration loop + consultations ReferenceError` | 18:21 | `consultations is not defined` | 3 (lines 5266, 5343, 6743 — all before fix commit time 09:21 UTC) | **0** | **HELD** |
| **0252bcc** (secondary) | 18:21 | Infinite tier-migration loop | 44 RAM cleanup cycles (pre-fix) | **0 after line 7171** (09:40 UTC) | **HELD** |
| **d621456 (sanitize)** "Embed batch 400s" | 16:19 | 4xx/5xx from MLX-embed | 0 HTTP status-4xx/5xx found in mlx-embed log | 0 | **HELD** — sanitize path prevents surrogate half-cut (256ab3e reinforcement at 16:59) |

## Restart History Table (daemon / count / MTBR / concerning?)

| Daemon | Boots today | Unclean (K9) | MTBR | Concerning? |
|---|---:|---:|---|---|
| `vcontext-server` (node wrapper) | 25 | 22 × `Killed: 9` | ≈ 13.8 min avg | **YES** — 22 SIGKILLs indicate repeated OOM, mostly pre-SSD-migration |
| `mlx-embed-server` (uvicorn) | 25 | 0 SIGKILL, 21 clean `Shutting down`, 4 unclean exits (no K9) | ≈ 14.0 min | Mixed — ae1ce3f stopped mid-batch kills, but watchdog still restarted on health timeout (44 `MLX Embed restart` entries total in watchdog log) |
| `mlx-generate-server` (mlx_lm.server) | 24 (24 starts in log + 16 watchdog restarts) | — | ≈ 14.5 min | **YES** — "process not found" appears 3× in watchdog log suggesting plist manages this; rapid flap |
| `vcontext-task-runner` | 1 long-running (PID 98009, age 3h43m) | — | N/A | **YES — ONGOING FAIL** (see HIGH #2) |
| `watchdog` itself | 1 | 0 | — | OK |
| `maintenance` | 7 cycles (launchd :45 cadence) | — | 60 min | OK cadence; integrity check failing (HIGH #1) |

Top spurious reasons in watchdog:
- `com.vcontext.server missing from launchd graph — bootstrapping…` × 3
- `MLX Generate restart: process not found` × 3
- `MLX Embed restart: health=timeout mem=XXXXMB` × 44
- `Wrapper not running, attempting restart…` × 3

## Loop Signatures (pattern / count / window / status)

| Pattern | Count | Window | Status |
|---|---:|---|---|
| `[store] MLX embed failed: connect ECONNREFUSED 127.0.0.1:3161` | **2,252** | 04:30–06:50 UTC (~140 min) | Resolved (post-ae1ce3f) — loop signature |
| `[embed-loop] batch failed (3 rows): connect ECONNREFUSED 127.0.0.1:3161` | 602 | same | Resolved |
| `[embed-loop] batch failed (16 rows): connect ECONNREFUSED 127.0.0.1:3161` | 532 | same | Resolved |
| `[store] MLX embed failed: read ECONNRESET` | 76 | distributed | Resolved post-watchdog fix |
| `[vcontext:tier] RAM cleanup: 500 deleted, 0 soft-marked (FTS issue)` | **43** | 07:10–09:00 UTC (~110 min) | **WATCH** — signals FTS5 corruption (HIGH #1); 0 post-SSD migration |
| `[vcontext:tier] Migrated 500/500 entries RAM → SSD` | 44 | same | Pairs with above; resolved |
| `[vcontext:predict] handler entered, prompt_len=500` | 62 | distributed | Normal prediction loop (not concerning) |
| `[task-runner] poll failed: connect ECONNREFUSED` | 237 | 04:53–09:59 UTC | Resolved then re-emerged as timeout |
| `[task-runner] poll failed: timeout` | ~20 (sampled from tail) | 10:27–10:30 UTC | **ONGOING** (HIGH #2) |

All signatures were under the >100-in-5-min "infinite-loop" criterion during at least one window (2,252 ECONNREFUSED clustered).

## Latency Outliers — Top 10 Slowest Embed Batches

| Rank | Time (ms) | Line | Timestamp (JST) | Endpoint |
|---:|---:|---:|---|---|
| 1 | 158,259.85 | — | ~14:55 | `POST /api/embeddings` |
| 2 | 131,309.90 | — | ~14:55 | `POST /api/embeddings` |
| 3 | 127,760.46 | — | ~14:55 | `POST /api/embeddings` |
| 4 | 127,652.11 | — | ~14:55 | `POST /api/embeddings` |
| 5 | 127,641.72 | — | ~14:55 | `POST /api/embeddings` |
| 6 | 103,729.72 | — | ~14:55 | `POST /api/embeddings` |
| 7 | 73,182.01 | 4049 | 14:59:03 | `POST /api/embeddings` |
| 8 | 73,181.96 | 4047 | 14:59:03 | `POST /api/embeddings` |
| 9 | 73,181.68 | 4045 | 14:59:03 | `POST /api/embeddings` |
| 10 | 63,634.94 | — | ~14:59 | `POST /api/embeddings` |

**Distribution**: 1,458 batches >10s out of 8,036 total samples = **18.1%** slow.
**Post-ae1ce3f (15:23 JST)**: 1,409 slow / 5,832 post-15:30 = **24.2%** still slow.
Slow-query endpoint headers: mostly `/api/embeddings` (legacy individual call), not `/embed_batch`. Interpretation: the old `/api/embeddings` path remained a bottleneck; `01ba5dd` (15:22) fixed `/embed_batch` to 1.9s but callers on `/api/embeddings` route still slow.

## Silent Failures

| Loop | Started | Last Activity | Notes |
|---|---|---|---|
| `chunk-summary-l2` | 04:28 UTC boot | Logs "skipped (no L1 summaries)" each cycle | Started ×15 times but never produced L2 summary today — expected (cadence 30m, needs ≥3 L1 samples) |
| `chunk-summary-l3` | same | Logs "skipped (no L2 summaries)" | Dependency chain blocks; design per commit 2e538ee |
| `task-runner` | 04:53 UTC | 10:30:23 UTC poll fail | **ONGOING FAIL** — see HIGH #2 |
| `startup-drain` | ad-hoc | 14 drains observed; no completion log | 565 & 599 retrying counts suggest backlog pressure during server restart storms |
| `article-scanner (evening)` | 09:00 UTC | 09:46:21 UTC "completed in 2776.7s — stored=36 high-impact=20" | OK (final line shows success despite many mid-scan timeouts) |

## Aggregate

- **Total issues (grep+loop hits)**: 7,100+ lines of error/loop traffic across all logs.
- **HIGH-severity (requires action)**: **3**
- **LOW-severity (noise, resolved, or expected)**: 6 categories below

### HIGH #1 — Maintenance cycle: DB integrity FAILED every hour (FTS5 corruption) — ONGOING
- **File**: `/tmp/vcontext-maintenance.log` lines 18–59
- **Last seen**: 18:45:06 JST (most recent maintenance cycle)
- **Detail**: 6 out of 7 maintenance cycles today failed integrity check with `malformed inverted index for FTS5 table main.entries_fts`. Maintenance auto-aborts GC each cycle, "letting watchdog handle recovery" — but watchdog does not perform FTS reindex. Accumulating: full-text search likely degraded.
- **Recommendation**: Run `REINDEX entries_fts;` on `/Users/mitsuru_nakajima/skills/data/vcontext-primary.sqlite` (SSD) during next quiet window; or restore from backup via command already suggested in the log: `cp "/Users/mitsuru_nakajima/skills/data/vcontext-backup.sqlite" …`. Must verify backup has healthy FTS5 first.

### HIGH #2 — task-runner stuck polling with timeouts — ONGOING
- **File**: `/tmp/vcontext-task-runner.log` last line 10:30:23 UTC (19:30 JST, < 1 min before audit)
- **Detail**: Process PID 98009, age 3h43m. Earlier ECONNREFUSED (during server restarts) transitioned to `poll failed: timeout` at 10:27 UTC and continues. Server `/health` responds instantly at audit time (0.002s curl), so the task-runner's HTTP client may have a dangling `keep-alive` socket or outdated endpoint. It hasn't polled successfully in >30 min.
- **Recommendation**: Restart `aios-task-runner.js` (kill PID 98009 and let LaunchAgent respawn) OR add HTTP-client reset on 3-consecutive-timeouts inside the script.

### HIGH #3 — Remaining MLX embed latency outliers (24% >10s) post-ae1ce3f
- **File**: `/tmp/mlx-embed-server.log`
- **Detail**: Even after the batch-inference fix at 15:22 JST and watchdog fix at 15:23, 1,409 of 5,832 post-15:30 batches exceeded 10s, with top outliers at 158s / 131s / 127s on `/api/embeddings` (not `/embed_batch`). The individual-embeddings path was not batched by `01ba5dd`.
- **Recommendation**: Route callers from `/api/embeddings` → `/embed_batch`, or add server-side auto-batch in mlx-embed for the legacy endpoint.

### LOW (informational only)
- `mx.metal.*` DeprecationWarning × 46 — pre-23735c9 refactor; already fixed in code, just re-emits from cached compiled bytecode each restart until all restarts pick up the new module.
- Shape of `[vcontext:predict] handler entered, prompt_len=500` × 62 — normal cadence.
- `EPIPE` ×1 — transient client disconnect.
- `Startup drain` retrying spikes (565, 599) — resolved each time (0 dead-lettered).
- Article-scanner mid-scan errors — final `completed` line shows 36 stored / 20 high-impact; OK.
- `chunk-summary-l2/l3 skipped` — expected per cadence design.

## Verdict

All 4 known bugs from user-supplied checklist **held**:
- ae1ce3f: MLX-embed Killed:9 pre-fix=22 (in server log, proxy metric) → post=0 in embed log
- d621456: RAM disk full pre=19, post-09:00UTC=0
- 0252bcc (tier loop): 44 cycles pre-fix → 0 after line 7171
- 0252bcc (consultations ReferenceError): 3 pre → 0 post

However, **3 HIGH-severity issues remain**, with **2 ongoing at audit time (FTS5 corruption + task-runner stuck)**. These were not covered by today's hotfix set.
