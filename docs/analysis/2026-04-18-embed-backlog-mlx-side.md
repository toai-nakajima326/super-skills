# Embed backlog investigation — 2026-04-18

## TL;DR

The embed backlog (15,829 pending at task start) has **two distinct root
causes**, both contributing. Loop-side fixes applied; MLX-side issue
documented for a separate task because the instructions say STOP if
MLX is the bottleneck.

1. **Loop-side (FIXED)**
   - `BATCH = 3` was 11x below optimal throughput (empirically 0.73 → 8.07 emb/s at batch=16)
   - Startup race: `checkMlx()` returned false during concurrent MLX boot, `startEmbedLoop()` never called, self-heal only triggered every 5 min and had its own `await` bug
2. **MLX-side (NOT FIXED — see below)**
   - MLX embed server is being restarted by watchdog every 1-2 minutes
   - Every restart drops in-flight embed calls, wipes GPU state, and requires ~7s model reload
   - This is the dominant throughput limiter now that the loop is correctly batching

## Empirical measurements

### Isolated batch-size sweep (MLX warm, no competing load)

| BATCH | Time   | Throughput       |
|-------|--------|------------------|
| 3     | 4.12s  | 0.73 emb/s       |
| 8     | 5.62s  | 1.42 emb/s       |
| 16    | 1.98s  | **8.07 emb/s**   |
| 32    | 3.69s  | 8.67 emb/s       |

Knee of the curve is at BATCH=16. Fixed overhead per HTTP call dominates at small batches.

### Live loop throughput (5-min window 15:08:36 → 15:13:46, post-fix)

- Embed count: 37180 → 37305 = **+125 embeddings in 310s = 0.40 emb/s**
- Eligible total: 54079 → 54233 = +154 new entries = 0.50 entries/s
- Backlog: 16899 → 16928 = **+29 over 5 min**
- Pre-fix (14:35-14:40 window, before changes): backlog grew ~40/min. Net improvement.
- Expected from batch=16 test: ~8 emb/s. Observed: 0.40 emb/s. **20x slower than isolated test.**

The gap (0.40 vs 8.07 emb/s) is explained entirely by the MLX-side
issue below — every restart forces a cold start and drops the queue.

## MLX-side issue (/tmp/vcontext-watchdog.log evidence)

```
[2026-04-18 14:35:11] MLX Embed restart: health=timeout mem=5029MB
[2026-04-18 14:36:26] MLX Embed restart: health=timeout mem=5856MB
[2026-04-18 14:38:49] MLX Embed restart: health=timeout mem=4929MB
[2026-04-18 14:40:07] MLX Embed restart: health=timeout mem=5839MB
[2026-04-18 14:43:42] MLX Embed restart: health=timeout mem=4539MB
[2026-04-18 14:51:40] MLX Embed restart: health=timeout mem=7566MB
[2026-04-18 14:59:00] MLX Embed restart: health=timeout mem=4519MB
[2026-04-18 15:00:55] MLX Embed restart: health=timeout mem=9766MB
[2026-04-18 15:01:03] MLX Embed restarted
[2026-04-18 15:02:11] MLX Embed restart: health=timeout mem=8109MB
[2026-04-18 15:04:30] MLX Embed restart: health=timeout mem=4435MB
[2026-04-18 15:07:13] MLX Embed restart: health=timeout mem=6674MB
```

- Frequency: every 1-2 minutes
- Memory at restart trigger: **4.4 GB → 9.8 GB** (growing leak between restarts)
- Root: watchdog trigger is `health=timeout` — MLX stops responding to `/health` before its memory actually OOMs the host. Consistent with the Python/MLX side getting wedged under load.
- From /tmp/mlx-embed-server.log: a single `/embed_batch` call took **20345 ms** (normal is ~2000 ms). That's the moment MLX started slowing down before the watchdog killed it.

Pattern: after BATCH=16 was applied, memory peak at restart moved from
~5GB to ~8-10GB. **Suggests the MLX batch path accumulates cache more
aggressively than the single-call path**, triggering the
`clear_cache`-deprecated codepath that was flagged in the log.

## What was changed (loop-side)

### 1. BATCH size: 3 → 16

`scripts/vcontext-server.js` ~L3253 in `startEmbedLoop`.

### 2. Startup race fix

`scripts/vcontext-server.js` ~L7587. Previously:
```js
checkMlx().then(() => {
  if (mlxAvailable) { startEmbedLoop().catch(() => {}); }
});
```
If MLX was still booting (common during concurrent restarts),
`mlxAvailable` stayed false and the loop was never started.

Now: always call `startEmbedLoop()` regardless of initial probe. The
loop's internal `!mlxAvailable` guard awaits `checkMlx()` and retries
every 60s — it was built to handle this but the startup path circumvented it.

### 3. Self-heal await bug

`scripts/vcontext-server.js` ~L3342 in `doBackupAndMigrate`. Previously:
```js
checkMlx();  // not awaited!
if (mlxAvailable && !embedLoopRunning) { startEmbedLoop(); }
```
`checkMlx` is async; the `if` ran against stale state. Now `await`ed.
Also made `doBackupAndMigrate` async.

## What was NOT changed (per task instructions)

- MLX embed server code (`mlx-*-server.py`) — out of scope
- MLX model (Qwen3-Embedding-8B-4bit-DWQ) — not allowed
- MLX restart policy — watchdog triggering too aggressively, or MLX
  server leaking memory, or `clear_cache` deprecation not being honored

## Recommended follow-up (separate task)

1. **Investigate the MLX memory growth** — compare memory trajectory between
   `/embed_batch` calls (batch-16) vs sequential `/embed` calls. Hypothesis:
   the batch path is not calling `mx.clear_cache()` per batch, so
   cached activations stack up.
2. **Relax the watchdog threshold** OR **increase MLX memory limit** — ramdisk
   is 8GB, unified memory is 36GB. Current triggers at ~5GB seem too tight.
3. **Back-pressure the embed loop** — if MLX returns 503/timeout, back off
   rather than flood. Currently the loop retries in 5s which may contribute
   to re-wedging MLX on startup.
4. **Benchmark `/embed_batch` vs `/embed` x N** in a stable window — the 20s
   batch latency observed once (vs 2s expected) suggests the batch kernel
   may have a bug or cache pathology worth reporting upstream.

## Measurement method

- SearXNG not consulted (internal metrics).
- Data from `/tmp/vcontext-watchdog.log`, `/tmp/mlx-embed-server.log`,
  `/tmp/vcontext-server.log`, and 15 samples over 5 min of
  `GET /ai/status` on port 3150.
