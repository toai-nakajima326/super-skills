# AIOS Stability — External References (2026-04-20 research sweep)

Context: AIOS on M3 Pro 36 GB, post-SSD migration. Targets: zero-downtime
vcontext-server, jetsam/swap resilience, launchd supervision, vector-store
scaling. Searches via local SearXNG; each bullet is a why-useful pointer.

## P0 — Zero-downtime Node + SQLite

- **[Node.js Graceful Shutdown: The Right Way](https://dev.to/axiom_agent/nodejs-graceful-shutdown-the-right-way-sigterm-connection-draining-and-kubernetes-fp8)** (dev.to, 2026) — stop-accepting + drain + close-DB-last checklist; mirrors what our watchdog should wait for (not just /health).
- **[better-sqlite3 performance.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)** (GitHub) — NORMAL synchronous default in WAL mode; confirms safe knobs for our 6 GB DB.
- **[DeepWiki: better-sqlite3 WAL Tuning](https://deepwiki.com/WiseLibs/better-sqlite3/3.4-wal-mode-and-performance-tuning)** — cache_size / mmap_size / wal_autocheckpoint knob reference.
- **[PM2 Graceful Start/Shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)** — SIGUSR2 fork-then-reload pattern to crib for a minimal vcontext reloader.
- **[Node Clusters in 2025: Still Worth It?](https://medium.com/@2nick2patel2/node-clusters-in-2025-still-worth-it-efc6dfd73010)** (2025-10) — confirms cluster is overkill for our single-SQLite-writer server.
- **[Node.js Clustering & Load Balancing](https://medium.com/@hadiyolworld007/node-js-clustering-load-balancing-explained-6b54926366f5)** (2025-09) — minimal SIGUSR2 rolling-restart recipe adaptable to our one-worker model.
- **[Scaling SQLite with Node worker threads](https://dev.to/lovestaco/scaling-sqlite-with-node-worker-threads-and-better-sqlite3)** — one connection per worker, read-only concurrency; useful when moving summary jobs off main thread.
- **[Static Web Server — FD socket passing](https://static-web-server.net/features/file-descriptor-socket-passing/)** — launchd Sockets-key exemplar; cleanest zero-downtime path on macOS.
- **[canopy#4354: SQLite connection never closed on shutdown](https://github.com/canopyide/canopy/issues/4354)** (2026-03) — real-world WAL-orphan bug identical to risks in our path.

## P1 — macOS jetsam / Node+Python co-tenancy

- **[Apple: jetsam event reports](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports)** — official report schema; tells us what `log show --predicate 'eventMessage CONTAINS "jetsam"'` will surface.
- **[What does RunningBoard do?](https://eclecticlight.co/2025/07/15/what-does-runningboard-do-2-managed-apps/)** (eclecticlight, 2025-07) — user-space memory-priority arbiter; explains why our Node/Python may be deprioritized first.
- **[XNU kern_memorystatus.c](https://fergofrog.com/code/codebrowser/xnu/bsd/kern/kern_memorystatus.c.html)** (2024) — authoritative source on jetsam priority bands + assertion conflicts.
- **[jetsam_utils](https://github.com/Torrekie/jetsam_utils)** — iOS-oriented but shows memorystatus_control(4) in practice; macOS surface is similar.
- **[Apple Silicon limitations for local LLM](https://stencel.io/posts/apple-silicon-limitations-with-usage-on-local-llm%20.html)** (stencel.io) — ~75% of RAM is practical GPU ceiling; aligns with our ~27 GB usable before thrash.
- **[Local LLMs Apple Silicon Mac 2026](https://www.sitepoint.com/local-llms-apple-silicon-mac-2026/)** (2026-03) — RAM headroom per tier; validates one 8B-4bit gen proc as upper bound for 36 GB.
- **[Apple ML: LLMs with MLX on M5](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)** (2025-11) — first-party Qwen3-8B-MLX-4bit numbers; comparable for our mlx-generate budget.

## P2 — LaunchAgent self-healing without cascade

- **[launchd.info — plist key reference](https://www.launchd.info/)** — clearest prose reference for KeepAlive / ThrottleInterval / RunAtLoad; primary doc when editing our plists.
- **[dabrahams: Notes on launchd](https://gist.github.com/dabrahams/4092951)** — captures the "ThrottleInterval set to zero ... Ignoring" guardrail; explains why our 20 s watchdog loop can pile up.
- **[Hosting a Swift Server on macOS](https://www.swifttoolkit.dev/posts/hosting-on-macos)** (2024-12) — rare 2024+ production-service example with ThrottleInterval guidance.
- **[Apple Dev Forums — LimitLoadToSessionType](https://developer.apple.com/forums/thread/759833)** — Quinn on agent vs daemon across pre-login/Aqua; relevant if we ever promote to a daemon.
- **[Homebrew Services (canonical code)](https://github.com/Homebrew/homebrew-services)** (2025) — real-world launchd templating at scale; reference for sane defaults.
- **[Homebrew brew Services System design](https://deepwiki.com/Homebrew/brew/11.2-services-system)** — abstraction over launchd/systemd worth borrowing for mass management.

## P3 — SQLite / sqlite-vec at multi-GB scale

- **[SQLite WAL (official)](https://www.sqlite.org/wal.html)** — why checkpoints don't shrink WAL without journal_size_limit; explains WAL bloat before nightly truncate.
- **[Litestream WAL Truncate Threshold](https://litestream.io/guides/wal-truncate-threshold/)** — 3-tier checkpoint strategy (PASSIVE / FULL / TRUNCATE); best concrete guide for a 6 GB DB with backups.
- **[phiresky SQLite tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)** — `wal_checkpoint(truncate)` cadence + mmap_size; older but still applicable.
- **[PhotoStructure: VACUUM in WAL mode](https://photostructure.com/coding/how-to-vacuum-sqlite/)** — VACUUM without checkpoint writes into the WAL, not the DB; pre-empts a bug in our maintenance.
- **[PowerSync SQLite High-Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)** — production pragma set + sizing checklist.
- **[SQLite Pragmas (official)](https://sqlite.org/pragma.html)** (2025-11) — quick_check O(N) vs integrity_check multi-pass; use quick_check per-boot, integrity_check weekly.
- **[asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)** — ANN still roadmap-only, so our brute-force assumption is correct.
- **[Firecrawl: Best Vector Databases 2026](https://www.firecrawl.dev/blog/best-vector-databases)** (2026) — 4096-dim support matrix across pgvector / LanceDB / Turso / sqlite-vec.
- **[sqlite-vec local vector search](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb)** (2025-10) — end-to-end 768-dim example; confirms brute-force hurts at 4096-dim past ~1 M rows.
- **[Turso Local-First Embedded Replicas](https://turso.tech/blog/local-first-cloud-connected-sqlite-with-turso-embedded-replicas)** (2025-03) — candidate for our future cloud-stub tier 3.
- **[SQLite Is Eating the Cloud in 2025](https://debugg.ai/resources/sqlite-eating-the-cloud-2025-edge-databases-replication-patterns-ditch-server)** (2025-08) — comparative framing of Turso / D1 / LiteFS / Litestream.

## P4 — MLX memory behavior on Apple Silicon

- **[Apple ML: LLMs with MLX on M5](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)** (2025-11) — first-party Qwen3-8B-MLX-4bit memory/perf numbers.
- **[mlx-lm#854: server OOM on KV-cache growth](https://github.com/ml-explore/mlx-lm/issues/854)** (2026-02) — exactly our failure mode; track upstream fix and wrap with context bound.
- **[mlx-lm#1015: generate() crash on Metal OOM](https://github.com/ml-explore/mlx-lm/issues/1015)** (2026-03) — same bug in library path; relevant if we move to in-process generate.
- **[mlx-lm SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)** — canonical startup/env knobs.
- **[jakedahn/qwen3-embeddings-mlx](https://github.com/jakedahn/qwen3-embeddings-mlx)** — production-ish embedding server with hot-swap + batch patterns worth borrowing.
- **[Reddit: keep multiple MLX models loaded](https://www.reddit.com/r/LocalLLaMA/comments/1md7lfi/how_can_i_keep_more_than_one_model_loaded_into/)** (2025-07) — HF_HOME-based warmth trick, avoids second process.

## P5 — Self-healing AI-OS / agentic memory prior art

- **[Mem0 / Zep / Letta / LangMem + LOCOMO comparison](https://renue.co.jp/posts/ai-agent-memory-mem0-zep-letta-langmem-locomo-benchmark-2026)** (2026-04) — decision matrix with LOCOMO numbers; direct fit for our eval harness.
- **[Top 10 AI Memory Products 2026](https://medium.com/@bumurzaqov2/top-10-ai-memory-products-2026-09d7900b5ab1)** (2026-02) — landscape map (Mem0, Zep, Letta, Supermemory, Cognee, Memori).
- **[Your LLM Has Amnesia: Production Memory](https://genmind.ch/posts/Your-LLM-Has-Amnesia-A-Production-Guide-to-Memory-That-Actually-Works/)** (2026-02) — hybrid vector + KG; validates our chunk-summary direction.
- **[ZenBrain: 7-Layer Memory](https://www.tdcommons.org/cgi/viewcontent.cgi?article=10975&context=dpubs_series)** (2026-04) — argues 2-3 tiers insufficient; useful ideas for extending ours.
- **[arXiv 2604.14228: Dive into Claude Code](https://arxiv.org/html/2604.14228v1)** (2026-04) — design-space analysis; skim for supervisor-pattern comparisons.
- **[arXiv 2603.04428: Persistent Q4 KV Cache on Edge](https://arxiv.org/pdf/2603.04428)** (2026-02) — warm-vs-restart cost breakdown; informs mlx keep-warm policy.
- **[Claude Code Auto-Memory guide](https://www.claudedirectory.org/blog/claude-code-auto-memory-guide)** — file-based memory pattern; close parallel to our CLAUDE.md + vcontext.

## Gaps / no-hits

- **Node.js + launchd socket-activation PoC**: no recent reliable Node example beyond static-web-server docs. Rec: prototype ourselves.
- **memorystatus_control for user-space macOS (not iOS)**: nothing beyond XNU source + iOS-focused tools. Rec: read XNU source; consult Apple Dev Forums before using.
- **sqlite-vec at 4096-dim, >1 M rows**: no concrete benchmarks; only roadmap. Rec: benchmark with our own corpus before any migration.
- **macOS watchdog cold-boot tolerance patterns**: no targeted article. Rec: phased health — `starting / warming / ready` — watchdog gates on `ready`.
- **Coordinated 10+-agent AIOS-style launchd sets**: closest is Homebrew Services. Rec: document ours once stable.

## Top-3 action items

1. **Adopt 3-phase graceful-shutdown (dev.to) + close DB last** — SIGTERM → stop-accept → drain 10 s → `wal_checkpoint(TRUNCATE)` → `db.close()` → exit. Pair with launchd `ExitTimeOut=30`. Closes the WAL-orphan class seen in canopyide/canopy#4354.
2. **Phase-aware watchdog using `quick_check` + a new /ready endpoint** — watchdog polls /ready (200 only after `PRAGMA quick_check` + first embedding ping), not /health. Eliminates the 79 s cold-boot race. Reserve integrity_check for weekly cron.
3. **Pre-empt MLX Metal-OOM: bounded-context proxy (mlx-lm#854) + warm Q4 KV (arXiv 2603.04428)** — cap generate context at 4096 tok behind a Node proxy, 503+enqueue on overflow. Then evaluate Q4 KV persistence for warm restart without RAM shock. Start with proxy (1 day); gate KV work on measured gain.
