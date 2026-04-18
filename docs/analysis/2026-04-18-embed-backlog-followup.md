# Embed Backlog — Server-Side Bottleneck (2026-04-18 follow-up)

**Status**: Client loop already tuned earlier today; new run confirms the
bottleneck is now on the server side, not in the client loop. STOP per
task instructions.
**Related**: `scripts/vcontext-server.js:3200-3296` (embed loop),
`scripts/mlx-embed-server.py`, `/tmp/vcontext-server.log`,
`/tmp/mlx-embed-server.log`, prior OOM discussion in
`docs/analysis/2026-04-18-locomo-eval-blockers.md`.

## TL;DR

The embed-loop client was already re-tuned today: `BATCH=16`, 100 ms gap,
5 s retry, heartbeat exposed via `/pipeline/health`. In isolation this
gives ~8 emb/s. In reality it gives **~0.26 emb/s** (measured 14:59:21 →
15:06:08, +98 embeddings over 6 min 47 s while the backlog sat at ~16.8 k).

The delta is not a loop-tuning issue. Two server-side failures are chewing
throughput:

1. **vcontext-server Node process keeps OOM-ing** (`Server exited with
   code 137`, 6 observed in `/tmp/vcontext-server.log`, two in the last
   ~5 minutes). Latest crash (PID 30445) was `Killed: 9` before it even
   finished booting. RSS was climbing past 1.3 GB within 5 s of startup.
2. **MLX embed (:3161) shuts itself down during batch traffic**.
   Uvicorn logs `INFO: Shutting down` after every few batches, losing
   inflight connections (vcontext log shows `ECONNRESET` / `socket hang
   up` / `ECONNREFUSED` bursts). Each cold restart reloads the 8B model
   (~6–8 s) and a single `/embed_batch` of 16 rows takes **28–44 s**
   end-to-end (normal 8B embedding is ~1-2 s). That is 20–30× the
   latency the loop’s throughput budget assumes.

With vcontext crashing every few minutes and MLX embed recycling mid-batch,
the loop spends most of its time either dead or retrying. Changing
`BATCH` or the sleep will not fix either failure mode.

## Evidence

Process snapshot (15:04–15:06 window):
- vcontext PIDs observed and lost: `18995 → 27743 → 30445 → <restarting>`.
- MLX embed PIDs: `8726 → 21253 → 24661 → 27705 → 30398`. Each one loads
  the model afresh (logged as `Model ... loaded successfully in 6–8 s`).
- Latest batch latency on :3161 (from `/tmp/mlx-embed-server.log`):
  `POST /embed_batch - Status: 200 - Time: 44219.93 ms`, then
  `Time: 39638.09 ms`, then `Shutting down`.

Client loop (from `scripts/vcontext-server.js:3253-3292`) is already:
- `BATCH=16` (knee of the throughput curve per today's tuning comment).
- 100 ms inter-batch sleep, 30 s when queue empty.
- 5 s backoff on failure (not 60 s).
- Bypasses `withMlxLock` to avoid store-path 60 s timeouts stacking.
- Uses `_mlxEmbedBatchRaw`, skips low-value types.

Throughput:
- T0 14:59:21 — embeddings=37 065, total=53 901, backlog=16 836.
- T1 15:06:08 — embeddings=37 163, total=54 019, backlog=16 856.
- Delta: +98 embedded, +118 created, backlog grew by 20. Net rate
  ~0.26 emb/s vs target ~8 emb/s. At this rate draining the backlog
  takes ~18 h, assuming no further crashes.

MLX lock `/tmp/aios-mlx-lock`: not held during investigation. No active
LoCoMo probe interfered — the crashes are unrelated.

## Why client tuning won't help

- Reducing `BATCH` below 16 cuts MLX embed utilisation (already measured
  8.07 emb/s @ 16 vs 0.73 @ 3, per in-code tuning note).
- Raising `BATCH` risks pushing MLX embed OOM (it already crashes; task
  caps us at 32 and cautions against it).
- Shortening the sleep would only increase the connection-refused storms
  during MLX embed restarts.
- A catch-up mode helps when the downstream is healthy — ours is not.

## Real bottlenecks to fix elsewhere (not this task)

Captured here so a follow-up can pick them up without re-investigating:

1. **vcontext-server memory bloat / OOM loop.**
   RSS climbs from 800 MB to >1.3 GB in ~2 min of normal load and gets
   SIGKILL'd. The OOM is not specific to embed — backup timers, vec sync,
   entry restore all fire at startup. This likely interacts with:
   - `vcontext:restore` trying to reconcile 34 376 SSD entries back into
     RAM on every boot (`RAM has 54019, SSD has 88395 (34376 missing)`).
   - `sqlite-vec` loading the 3 GB RAM-disk DB + vector index in-process.
   - Concurrent loops (discovery, chunk-summary L1/L2/L3) all kicking
     within the first few seconds. The `--max-old-space-size` flag in
     `vcontext-wrapper.sh` should be audited.
2. **MLX embed server lifecycle.**
   Something is sending SIGTERM / exit to the :3161 server after
   a handful of batches. Suspects: an external supervisor (LaunchAgent
   plist or `mlx-embed-healthcheck` cron), `clear_cache` OOM, or a
   deprecation warning path that aborts. `/tmp/mlx-embed-server.log`
   shows `Shutting down` as the explicit uvicorn signal, not a crash,
   which points to supervisor-driven termination.
3. **Batch latency when MLX embed *is* up.**
   44 s for 16 rows of ≤1 000 chars is 20–30× the expected Qwen3-8B-4bit
   rate. Likely causes: cold compile on each startup, M-series memory
   fragmentation after prior MLX generate runs, or the server being
   starved by the concurrent Qwen3-8B-4bit generate model on :3162.
   Investigate by running `/embed_batch` standalone (no vcontext traffic)
   once the system is idle.

Any of (1), (2), or (3) has to be resolved before an embed-loop tuning
pass will move the backlog. All three are out of scope for this task
per the "STOP and document" instruction.

## Constraints respected

- No MLX restart issued; no changes to `scripts/mlx-embed-server.py`.
- No memory-heavy probes launched (no batch embed, no vector search).
- `/tmp/aios-mlx-lock` checked (not held).
- All measurements taken via passive SQLite reads or health-ping curls.
