# vcontext-server instability — 2026-04-20 diagnosis

**Status**: diagnosed, most fixes shipped today (12 commits), residual
fundamental issue requires either user action or deeper refactor.

---

## Observed symptom

`vcontext-server.js` crashed with exit code 137 (`Killed: 9`, macOS
jetsam) **111 times** during today's active session. Each crash caused
~30-90 s of unreachability until the wrapper re-spawn finished its
SQLite cold boot on the 6 GB DB.

Client-visible effects:
- Dashboard reloads slow or blank
- Codex `/store` attempts refused (pre-3.5-GB-cap fix) or timed-out
  (post-fix)
- AIOS hook writes queued to `/tmp/vcontext-queue.jsonl` (140 items)
- Writes that exhausted retry → dead-letter
  `/tmp/vcontext-queue.deadletter.jsonl` (**1,574 items**, representing:
  531 pre-tool, 530 tool-use, 260 working-state, 105 assistant-response,
  24 session-end, 20 user-prompt, 20 handoff, 14 tool-error, 13
  skill-usage, 8 skill-suggestion, 6 subagent-stop, 4 session-recall,
  4 skill-suggestion, 2 compact, 2 pre-compact)

## Root cause (memory budget exceeded)

36 GB MacBook M3 Pro hosting concurrently:

| Process | RSS | Role |
|---|---|---|
| vcontext-server | 1,000-1,300 MB (grows with caches) | AIOS substrate |
| mlx-embed (python3.13) | 280-450 MB | Qwen3-Embedding-8B |
| mlx-generate-proxy (idle) | 60 MB | lazy-load shim |
| Chrome (multiple processes) | ~1,000 MB | browser + tabs |
| Codex.app | 500-600 MB | client |
| Virtualization (Docker) | 300-400 MB | SearXNG container |
| mds_stores | 500-650 MB | Spotlight indexing |
| System daemons | ~1,500 MB | macOS |

Total visible working set ≈ 5.5-6 GB. Add APFS page cache for the 6 GB
DB (normally several GB), Metal GPU reservation for MLX, and other
kernel buffers → peak well over the 10-12 GB comfortably available
after OS baseline.

Observable consequence: swap usage sits at 2.7-4.1 GB today (out of a
5 GB swap file). macOS jetsam triggers when compressor + swap can't
keep up; it kills the largest recently-grown managed-app process,
which is usually vcontext.

## Not-root-causes (ruled out today)

- **openclaw.gateway crash loop** — root cause of the weekend
  cascade; bootout'd this morning, plist renamed `.disabled.*`.
  NOT the source of today's recurrence.
- **28 GB runaway WAL** — caught + cleaned; in-process doBackup moved
  out to separate LaunchAgent. Backup disk IO no longer blocks event
  loop.
- **3.5 GB write-refusal cap** — fixed to 50 GB in SSD mode.
- **AIOS hook fail-open bug** — fixed via `_infra_error` sentinel and
  then properly encoded via TypeScript discriminated union in
  `hooks-gate.mts`.
- **FTS5 malformed inverted index** — diagnosed as a false positive
  from chained PRAGMAs in sqlite3 CLI. FTS5 data is clean.
- **MLX-generate memory hog** — moved to lazy-load proxy; 0 MB when
  idle. Not currently contributing.

## Mitigations shipped today (12 commits)

Each commit made the cascade shorter or rarer, but none fully prevent
it under current memory pressure:

```
1ddde65  fix(hooks): FTS5 false positive         — maint exit=1 streak broken
b8be398  perf(backup): PASSIVE checkpoint        — smaller WAL per cycle
1f95b0f  perf(server): yieldToEventLoop          — /health 5s→0.8-3.9s
f5bf9c1  feat(hooks): TS strict Phase 1          — bug class unrepresentable
4dac939  docs(schemas): OpenAPI 3.1              — contract-first substrate
7484527  feat(mlx): lazy-load proxy              — MLX 6GB→0 when idle
dc126b1  docs(analysis): research + morning 3-bugs
fe1c0c1  feat(backup): separate process + CONST  — backup decoupled from event loop
dfdee88  fix(watchdog): memory-aware MLX         — no spawn on low memory
cc697e4  fix(watchdog): cold-boot grace          — no kill during 79s boot
9dec2ab  fix(vcontext): 3 morning bugs           — write-cap, hook, L142
8afffbf  docs: OOM root-cause audit              — (yesterday) openclaw
```

## What works NOW

- `mlx-embed` (:3161) — stable, 2 ms /health response
- `mlx-generate-proxy` (:3163) — stable, lazy, 63 MB RSS
- `searxng` (:8888) — stable
- AIOS hard-gate — correctly fails open when server unreachable;
  correctly blocks when session hasn't routed
- Offline queue (140 retrying items) — survives crashes, will drain
  when server stable
- Dead-letter (1,574 items) — preserved, replayable via
  `scripts/vcontext-drain-deadletter.sh` when server stable

## What does NOT work NOW

- `vcontext-server` (:3150) — recurring jetsam kill (111× today)
- Roundtrip test in maintenance self-test → "roundtrip empty"
  (write timed out, or read happened before indexing caught up)
- Dashboard reloads during busy cycles
- Offline queue drain (server too unstable)

## Recommended actions (in order of user-cost)

### Low cost — user 1-minute action
1. **Close large Chrome tabs / Codex / Virtualization (Docker Desktop)**
   if not actively needed. Frees ~2 GB. Likely sufficient to stop the
   jetsam loop for the rest of the day.
2. **Reboot** — clears swap, resets memory compressor. Clean slate.

### Medium cost — 30-60 min engineering
3. **Reduce vcontext RSS footprint**:
   - Lower `cache_size` from 64 MB → 32 MB (trade: slightly slower
     hot-page queries; gain: jetsam less likely to pick us)
   - Lower `mmap_size` from 256 MB → 128 MB
   - Cap `embed-loop` batch size and retry frequency (currently retries
     fast on ECONNRESET, burning CPU)
4. **Increase macOS swap file size** (`sysctl vm.swapusage`): buy more
   headroom. Trade: SSD wear; gain: cushion.
5. **Split hot vs cold tier boundaries**: migrate older entries from
   primary (6 GB) to ssd (separate), reducing working-set for hot reads.

### High cost — day+ refactor
6. **Worker-thread pool for SQLite ops** — proper fix for event-loop
   blocking under memory pressure. better-sqlite3 isn't worker-thread-
   native; would need to shard the DB handle or switch to node-sqlite
   (async). Multi-day.
7. **Federated MLX** — move mlx-embed to a separate machine. Frees
   ~4 GB. Requires network stability between machines.
8. **Alternative vector store** — LanceDB (Rust, mmap-friendly) or
   Turso (libSQL) as a more memory-disciplined backend. Week-scale
   port.

## Artifacts for recovery (when server stabilizes)

- `scripts/vcontext-drain-deadletter.sh` — slow rate-limited replay
  of the 1,574 dead-lettered writes. content_hash dedupes. Safe to
  re-run and interrupt.
- `/tmp/vcontext-queue.jsonl` (140 live retry items) — drains
  automatically via hooks.js when server is reachable.
- `/tmp/vcontext-queue.deadletter.jsonl` (1,574 items) — preserved
  until manually drained.

## Open questions

1. Why did swap peak at 4+ GB today? Did something leak, or is this
   the normal working set? Would benefit from 24-hour RSS time-series.
2. Is the `[store] MLX embed failed: ECONNRESET` rate (dozens per
   minute) contributing? embed-loop reconnect attempts add CPU load.
3. Does the /store write path block on embed synchronously? If so,
   that's the path to make async first.

## Tomorrow's priorities (handoff)

1. User: close apps / reboot to establish baseline memory headroom
2. Engineering: profile what's in vcontext's 1.2 GB RSS (heap snapshot)
3. Engineering: investigate embed-loop retry storm
4. Maybe: implement low-cost RSS trim (#3 in recommendations)

---

*Today was a hard day for AIOS but a productive one. The substrate got
tougher (12 commits worth of structural improvements). The remaining
issue is out of the substrate's hands — it's about the host machine's
budget. AIOS is alive and learning; today it showed us its breaking
point, and we now have the diagnosis + tools to push that point back.*
