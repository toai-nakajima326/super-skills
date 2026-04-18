# Observation — Zero-downtime architecture not working as designed (2026-04-18)

**Observer**: user
**Quote**: "ゼロダウンタイムのアーキテクチャーが機能してない気がします"
**Severity**: HIGH — invariant not met
**Status**: Documented for 2026-04-19 morning investigation

---

## Evidence from today (why the user said this)

Tonight's visible downtime events in this session alone:

| Time (JST) | Event | Duration | Root cause |
|------------|-------|----------|------------|
| ~13:00 | RAM→SSD migration | ~30s intentional | planned |
| ~15:00 | OOM cascade #1 | ~60s | MLX unified memory + 18GB RAM disk pressure |
| ~15:20 | OOM cascade #2 | ~60s | same |
| ~17:00 | LoCoMo full FAILED | 20min lock timeout | MLX lock leak after SIGKILL |
| ~18:00 | Server hang #1 | 90s+ HTTP timeout | tier-migration infinite loop |
| ~18:10 | Server OOM (code 137) | ~40s | main-thread starvation + Jest on another project |
| ~18:24 | Server hang #2 | ~90s | same tier-migration loop until hotfix 0252bcc landed |
| ~18:30 | Server restart post-hotfix | 35s cold-start | normal restart |

**Total downtime today**: roughly 5-10 minutes of observable unavailability,
plus ~20 min of "functionally hung" time (alive but unresponsive).

Original invariants believed to provide zero-downtime:
1. `LaunchAgent KeepAlive` = auto-respawn on crash
2. `vcontext-wrapper.sh` = event-loop watchdog inside wrapper
3. `com.vcontext.watchdog` = external probe + restart
4. AIOS Task Queue = Claude-independent work pipeline
5. Hot-tier RAM disk → SSD migration = rolling tier management

## Why each failed (summary)

| Invariant | Why it failed tonight |
|-----------|----------------------|
| KeepAlive | Respawn happens AFTER crash; if startup takes 35s (vec index load + backfill), there's 35s of down |
| wrapper watchdog | Watchdog kills on hang → restart cycle; between kill and new-process-listen there's 30-60s |
| external watchdog | 60s probe interval + 2-strike = up to 2min detection latency |
| Task Queue | Works for task-queue submitters, but `/health` + dashboard still hang if server main thread blocked |
| Tier migration | The "rolling" part: tier-migration itself caused the hang (infinite loop). Ironic. |

## Categories of failure this exposes

### (A) Fail-hard instead of fail-soft
When one subsystem (tier migration) goes bad, the WHOLE HTTP handler
dies. Better design: isolate loops into their own process/thread so
`/health` stays responsive even under tier-migration pressure.

### (B) No read-path fallback during writes
When main thread is busy with tier migration + MLX embed retries,
simple reads (`/health`, `/recall?q=...`) queue behind them. Could be
served from a read replica or a dedicated read thread.

### (C) Cold-start is slow
35s to bind port + load sqlite-vec + run backfill. During this window
every client gets ECONNREFUSED. Options:
- Pre-compile on first boot, cache
- Lazy-load sqlite-vec (serve /health immediately, load vec on first vec query)
- Graceful handoff: old instance keeps serving while new one warms up

### (D) KeepAlive races with wrapper
LaunchAgent can race with wrapper — observed today as "Bootstrap failed:
5: I/O error" when bootout didn't complete before bootstrap.

### (E) MLX wedge cascades into server wedge
MLX generate U-state blocks vcontext embed loop → loop starvation →
anomaly loop → main thread starvation. Cascading.

## Proposed investigation areas (tomorrow)

1. **Single-process → multi-process**: split `/health` + `/recall` +
   `/recent` into a separate worker so long-running writes cannot block
   reads (Node `cluster` module or unix-socket forwarding).
2. **Graceful handoff on restart**: old instance keeps accepting while
   new one binds a different port, then reverse-proxy swaps. Requires
   LaunchAgent to spawn N+1 instances briefly.
3. **Pre-load caching**: precomputed sqlite-vec shard so cold-start is
   <2s not 35s.
4. **Tier-migration off main thread**: Worker thread or periodic
   subprocess. Main process only handles HTTP.
5. **Health endpoint priority**: dedicated promise chain that races
   past normal handler queue.
6. **Unified memory budget**: hard cap MLX to some fraction of unified
   memory (via Metal API?) so it can't starve node.

## Criticality tiering (user insight 2026-04-18 evening)

> ローカルLLMは生成が落ちても溜めておけるから、後で再生成すればいいけど
> 検索系が落ちると全てが動かなくなる

| Subsystem | Criticality | Why | Downtime tolerance |
|-----------|-------------|-----|--------------------|
| **vcontext search** (`/recall`, `/recent`, `/session`) | 🔴 **CRITICAL** | If down, every AI loses context access → total system halt | ≤ 2s p99 |
| **vcontext health** (`/health`, `/stats`, `/pipeline/health`) | 🔴 **CRITICAL** | Observability foundation; hook system depends on it | ≤ 2s p99 |
| **vcontext write** (`POST /store`) | 🟡 **IMPORTANT** | Writes queue in JSONL WAL, replay via `/admin/replay-wal` | ≤ 30s p99 |
| **MLX generate** (:3162) | 🟢 **NON-CRITICAL** | Tasks queue in Task Queue, regenerate later | Minutes OK |
| **MLX embed** (:3161) | 🟡 **IMPORTANT** | Backlog accumulates, catches up (observed 14k today) | Minutes OK |
| **Background loops** (self-evolve, article-scan, etc) | 🟢 **NON-CRITICAL** | Cron-driven, safe to skip a cycle | Hours OK |

**Implication for architecture**: SEARCH path must be the MOST isolated
from other subsystems' failures. Reads must not queue behind writes.
Reads must not queue behind MLX calls. Reads must not queue behind
tier migrations.

## Acceptance criteria for "zero-downtime works"

Split into 3 tiers matching criticality:

### CRITICAL (search + health)
- AC1: `/health` returns within 2s, **99%** of the time, even during
  tier migration / MLX wedge / backfill / OOM recovery.
- AC2: `/recall?q=X` returns within 3s, **99%** of the time, even when
  writes are stuck.
- AC3: After a crash, CRITICAL endpoints serve new requests within 5s
  via failover or pre-warmed standby.
- AC4: CRITICAL endpoints NEVER return 503 due to main-thread starvation.

### IMPORTANT (writes)
- AC5: `POST /store` returns within 30s, **95%** of the time.
- AC6: If POST /store fails, JSONL WAL receives the entry (no data loss
  as long as the write reached the wrapper process).
- AC7: After crash, no stored entry is permanently lost (replay-WAL
  recovers them).

### NON-CRITICAL (LLM + loops)
- AC8: MLX queue accepts new tasks within 10s even during MLX wedge
  (task-queue path separate from MLX dispatch).
- AC9: A failed MLX call is automatically re-queued with backoff.
- AC10: Loops that miss a cycle resume the next scheduled slot.

## Design priority order for remediation

Given the criticality tiers:
1. **P1 (highest)** — separate read path from write path (read worker
   or async serve pattern). Reads must not block on writes.
2. **P2** — make MLX wedges non-blocking for search:
   replace blocking calls with async + timeout + retry-later semantics.
3. **P3** — graceful handoff on restart so cold-start doesn't drop reads.
4. **P4** — tier-migration → worker thread (so main thread stays free).
5. **P5** — MLX memory hard cap so unified-memory can't starve node.

Writes (P2-P5 affect) can be tuned after search is bulletproof.

## Next steps

- Add to tomorrow morning M-series queue as **M9 — Zero-downtime audit
  & remediation** (2-4h agent work)
- Precondition: M1 (MLX lock fix) done, since lock leak contributes
- Likely will produce an architecture spec before any code

## Related

- docs/handoff/2026-04-19-morning-resume.md — add this observation
- docs/analysis/2026-04-18-phase-2-integrated-review.md §R2 already
  mentions "MLX embed /health blocks during batch" — this is the same
  class of problem at a different subsystem
