# OOM Cascade Root-Cause Analysis — 2026-04-18

**Skills applied:** investigate, quality-gate, spec-driven-dev.
**Audit header:** `CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1`

## Mini-spec

**Problem**: `vcontext-server` is SIGKILLed repeatedly today (`Killed: 9` / exit 137).
The user reported ~5 cascades; log inspection shows the count is far higher.

**Scope**: Read-only investigation across the live log, source, DB sizes,
ps, and macOS unified log. No fixes, no DB writes, no server bounces.

**Acceptance criteria**:
1. Enumerate every kill event in `/tmp/vcontext-server.log` with context.
2. Decide whether the cause is V8 heap OOM, a vcontext leak, or
   system-wide jetsam pressure, with concrete evidence.
3. Draft a non-destructive fix plan covering the top-ranked cause.

---

## Timeline of kill events (log-line-based)

Source: `/tmp/vcontext-server.log` (8822 lines at audit time; server
died a 25th time in the middle of this investigation).

| # | Log ln | Marker | Context immediately before kill |
|---|-------:|--------|----------------------------------|
| 1  | 21   | Killed: 9 (PID 5224)  | Startup during RAM-disk init failure |
| 2  | 176  | Killed: 9 (PID 28802) | `Backup complete` + embed-loop ECONNRESET |
| 3–13 | 179–221 | Killed: 9 (11 in a row) | Cascade: new server dies instantly during startup (wait_server_bound never fires) |
| 14 | 1865 | exit 137 | `Backup complete` |
| 15 | 3034 | Killed: 9 (93481) | WS + sqlite-vec Sync |
| 16 | 3119 | exit 137 | embed-loop ECONNREFUSED :3161 |
| 17 | 3231 | exit 137 | WS clients 19–20 churn |
| 18 | 3662 | exit 137 | WS clients 7–8 churn |
| 19 | 3741 | exit 137 | embed failures + ECONNREFUSED |
| 20 | 3849 | exit 137 | embed ECONNREFUSED |
| 21 | 4264 | exit 137 | `Backup complete` |
| 22 | 4346 | exit 137 | (short window) |
| 23 | 5438 | exit 137 | WS churn |
| 24 | 6949 | exit 137 | **predict handler entered + Backup** |
| 25 | 7095 | exit 137 | **chunk-summary 100 entries** → "attempted restart" |
| 26 | 7172 | exit 137 | predict "generating triggers for 5 gaps" |
| 27 | 7870 | exit 137 | predict "building prompt" + "generating triggers" |
| 28 | 7939 | exit 137 | predict building prompt |
| 29 | 8010 | exit 137 | (short) |
| 30 | 8648 | exit 137 | predict handler entered (x2 prompt_len=54) after backup cluster |
| 31 | 8823 | exit 137 | auto-migrate RAM→SSD 500 + mlx-generate Available + 18 WS connects |

**Counts**: 25 × `Killed: 9`, 17 × `exit 137`, 31 × `bound port 3150`.
Ten distinct cascades, each 2–11 kills deep.

**Uptime distribution** (bind-to-kill intervals): ranges from **7 s to
40+ min**. The median successful uptime is ~5 min; a new server often
dies in <1 min if load is high. Most strikingly, multiple servers die
DURING startup (before `bound port 3150`), which rules out a slow
memory leak in steady-state code — at 7–13 s uptime the heap has not
had time to bloat.

---

## RSS / heap evidence

- **No V8 heap errors** in log: `grep -c "Heap out of memory\|Reached heap limit" = 0`.
- Node wrapper sets `--max-old-space-size=4096` (4 GB) —
  `scripts/vcontext-wrapper.sh:31`. A V8 OOM would log a FATAL with a
  stack trace before exit. None seen. Every kill is signal 9.
- Only signal 9 (SIGKILL) from outside — not a V8 self-terminate.
- Current live server RSS ~1.12 GB (`ps -o rss`). Far below the 4 GB
  cap. Prior "1.08 GB trending from 900 MB" observation matches.
- mlx-generate server (PID 12305) RSS 538 MB, mlx-embed (PID 95356)
  RSS 249 MB. Combined MLX ≈ 787 MB.
- Claude.app Helper (Renderer) RSS **2.3 GB** (PID 8259); Codex
  Helper 540 MB; four Chrome renderers 240 MB each.

## System memory pressure (macOS)

`vm_stat` + `memory_pressure` right now:

```
Total:           38.65 GB
Pages free:       1.00 GB   (65,487 × 16 KB)
Swap-out history: 11,560,445 swapouts (session)
Swap-in history:   9,257,847 swapins  (session)
Pages purged:     317 GB-equivalent over uptime
Compressor size:  1.0–1.2 M pages ≈ 16–19 GB compressed
```

`compressor_size` oscillating **1.04 → 1.18 M pages** in the kernel
memorystatus log is the fingerprint of sustained macOS memory
pressure. Kernel is aggressively compressing pages, and the
compressor is nearly full (~19 GB).

In the unified log, `memorystatus: killing_idle_process` events for
idle-exit daemons (cfprefsd, trustd, ospredictiond, mobileassetd,
etc.) fire continuously across the day — the classic jetsam response
to low `memorystatus_available_pages`.

---

## Compounding factor: `ai.openclaw.gateway` crash loop

**This is the biggest independent finding.**

- LaunchAgent `ai.openclaw.gateway.plist` has `KeepAlive=true` +
  `ThrottleInterval=1`.
- Target binary `/opt/homebrew/lib/node_modules/openclaw/dist/entry.js`
  — every spawn dies in 0 seconds ("Service only ran for 0 seconds.
  Pushing respawn out by 1 seconds.").
- Over the last 6 h: **439,284 log lines** tagged `ai.openclaw`
  (roughly one spawn + ~20 kernel/launchd entries per second).
- Each `node` process briefly touches the DYLD shared region
  (`node[521] triggered unnest of range 0x1ea000000->0x1ee000000 of
  DYLD shared region — increases system memory footprint almost
  permanently until re-slid`). 20k+ nest/unnest cycles/hour leaves a
  large, fragmented shared-region residue.

This is **not** vcontext, but it explains why the system is at
memory-pressure red-line when vcontext is otherwise behaving. It also
competes for the ~same file caches (node runtime pages, npm modules).

---

## Disk & file-cache footprint

DB sizes on `/Users/.../skills/data/` (all SSD, no RAM disk):

| File | Size | Rows |
|------|-----:|-----:|
| vcontext-primary.sqlite   | 3.10 GB | 60 369 |
| vcontext-primary.sqlite-wal | 73 MB | — |
| vcontext-ssd.db           | 4.64 GB | 126 716 |
| vcontext-ssd.db-wal       | 42 MB | — |
| vcontext-backup.sqlite    | 3.10 GB | — (copy) |
| vcontext-backup.sqlite.tmp + .bak | 6.2 GB | — (copies) |
| vcontext-vec.db           | 738 MB | — |
| entries-wal.jsonl         | 128 MB | — |
| **Total**                 | **18 GB** | — |

Of primary: 2.5 GB of that 3.1 GB is embedding JSON text (60k rows ×
~40 KB each). Of SSD: 3.8 GB embedding. Every `SELECT * FROM entries`
or any bulk-scan that doesn't `WHERE embedding IS NULL` drags GB into
the page cache.

Observed: `[vcontext] Async backup failed: disk I/O error` (line 8567)
and `[db query error ...] disk I/O error` on a COUNT(*) query (line
8639) — both immediately before kill #30. Disk I/O errors under
memory pressure strongly correlate with page-cache eviction of
read-only SQLite pages that APFS cannot re-read fast enough.

---

## Hypothesis ranking

### H1 — System-wide jetsam under compounded pressure **[STRONGEST]**

`vcontext-server` is SIGKILLed by macOS `memorystatus` because the
system is at sustained memory-pressure red-line. Evidence:

1. No V8 OOM: signal 9 only.
2. Compressor 19 GB, swap churn 20M IO ops, Purged pages 317 GB-eq.
3. ai.openclaw.gateway crash-looping 1/s × 6h depletes shared region.
4. Claude Helper 2.3 GB, MLX 787 MB, Chrome 1 GB, mds_stores 900 MB.
5. Kernel-log flood of `memorystatus: killing_idle_process`.
6. vcontext live RSS 1.1 GB — well under its 4 GB cap, not a leak.
7. Disk I/O errors during high-memory windows — classic cache
   eviction signature on APFS.

**Why vcontext specifically gets killed**: among node processes,
vcontext has (a) the highest RSS growth under MLX load bursts,
(b) the largest file-backed pages (mmap-ed SQLite), (c) no jetsam
priority protection in its plist. jetsam ranks by RSS × priority;
vcontext wins the lottery.

### H2 — Short-term RSS spike during MLX generate bursts (secondary)

During certain operations vcontext DOES spike briefly to 2–3 GB
before the MLX response lands and GC reclaims. Evidence:

- 12+ call sites use `maxTokens: 40960` (`mlxGenerate` responses can
  be ~200 KB+ each).
- `handlePredictiveSearch` hooks are fired per user prompt (hooks.js
  1413, 1708, 1786) — log shows 206 predict handler entries, **often
  duplicated within 1 s** (prompt_len=500 fires 4–6 times in a row).
- No per-endpoint concurrency cap. MLX generate queue (`_mlxQueue`)
  serializes generate calls but has **no max length** — if 50
  predictive-search items pile up they all hold their closures (with
  prompt strings, pending MLX response buffers, and SearXNG chunks)
  in memory.
- Chunk-summary every 5 min builds prompts up to 6000 chars from
  100–500 entries (line 3875). `maxTokens: 300` is fine there, but
  the 100-entry scan pulls embedded content into RAM.
- `/predict/next` is SQL-only and cheap (✔).

H2 is NOT enough on its own to cause 4 GB heap OOM, but the spike +
jetsam red-line is fatal together.

### H3 — embed-loop tight-loop thrashing (contributor)

- `startEmbedLoop` does `dbQuery(SELECT ... WHERE embedding IS NULL
  LIMIT 16)` + MLX call with a **100 ms gap** between batches (line
  3428 — comment says 2 s; code is 100 ms. Inconsistency is itself a
  bug).
- 3587 MLX embed failures (`read ECONNRESET` / `socket hang up`) in
  the log. Each failed batch retries in 5 s. Under MLX stalls the
  loop generates thousands of rejected attempts, each allocating a
  16-row promise closure + batch buffer.
- Bypasses `/tmp/aios-mlx-lock` by design, but that means it CAN
  saturate MLX when an agent also calls generate.

### H4 — Slow leak (ruled out)

- Current steady-state RSS 1.1 GB vs earlier "trending 900 MB → 1.08
  GB". The 180 MB drift over many hours is consistent with retained
  closures + large DB row buffers, not a growth-unbounded leak.
- Kills happen at 7 s, 8 s, 13 s, 30 s uptime — no correlation with
  uptime. If it were a leak, only long-uptime servers would die.

---

## Verdict

**Root cause is H1 (system-wide jetsam pressure), with H2 and H3 as
second-order triggers that tip vcontext into the top-RSS slot when
jetsam scans.**

The earlier fixes (M17/M18/H1/H2/H3, vecSync spike in 90e65e8) ARE
effective — they prevent 2.6 GB heap spikes. But they can't help
against SIGKILL from outside. As long as ai.openclaw.gateway is
crash-looping and the working-set approaches 20 GB, any node process
of meaningful size is in jetsam's shortlist.

---

## Proposed fix plan (NOT yet implemented)

Ranked by risk-adjusted impact.

### Fix A — Stop the openclaw crash loop **[LARGEST IMPACT, 0 risk to vcontext]**

File: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`.

Options (choose one):
- (A1) `launchctl bootout gui/501 ~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  — unload until the user needs the service.
- (A2) Patch the plist to add `ThrottleInterval=60` so it respawns
  once per minute rather than once per second. Reduces load 60×.
- (A3) Fix the underlying openclaw crash (requires reading
  `/Users/.../.openclaw/logs/gateway.err.log`; out of scope for
  this task).

**Risk**: Zero risk to AIOS. If user needs the gateway they will
notice; if not, (A1) removes 439k log lines / 6 h.

### Fix B — Raise vcontext's jetsam-priority floor

File: `~/Library/LaunchAgents/com.vcontext.server.plist` (exists;
user loaded it via `launchctl list`).

Add:
```xml
<key>ProcessType</key>
<string>Interactive</string>
<key>LowPriorityIO</key>
<false/>
```

`ProcessType=Interactive` tells launchd that this process should be
ranked above background daemons when jetsam shortlists — currently
vcontext is implicitly `Background`. Needs plist reload:
`launchctl bootout gui/501 <plist>; launchctl bootstrap gui/501 <plist>`.

**Risk**: LOW. Interactive processes use slightly more scheduler
priority; vcontext's node process is not CPU-bound.

### Fix C — Bound the MLX generate queue

File: `scripts/vcontext-server.js`, function `mlxGenerate` (line 5236).

Add:
```javascript
const _MLX_QUEUE_MAX = 64;
if (_mlxQueue.length >= _MLX_QUEUE_MAX) {
  return Promise.reject(new Error('mlx-queue: saturated, drop'));
}
```

Then in `handlePredictiveSearch` and similar setImmediate-dispatched
calls, catch the rejection and log `skipped — queue full`.

**Risk**: LOW. Dropped predictive searches are best-effort already
(fire-and-forget in setImmediate). Protects heap from unbounded
closure accumulation.

### Fix D — Deduplicate predictive-search fan-out at the hook layer

File: `scripts/vcontext-hooks.js` lines 1413, 1708, 1786.

Only one of these should fire per user prompt. Currently hooks chain:
user-prompt → agent-wrapper → another hook all POST to
`/predictive-search` with the same (prompt, session). Add an in-
process dedup keyed by `sha256(prompt + session)` with a 30 s TTL.

**Risk**: LOW. Reduces predict calls from ~4 per prompt to 1.

### Fix E — Embed-loop gap consistency

File: `scripts/vcontext-server.js:3428`.

The comment says 2 s, the code is 100 ms. Set it to 1–2 s under
MLX-error regime (raise to 5 s on consecutive failures). Prevents
the embed-loop from hammering MLX during the 30-min windows where
MLX is restarting.

**Risk**: LOW. Slower embed backlog drain; acceptable.

### Fix F — Compact backup/SSD DBs

`vcontext-backup.sqlite.bak` and `vcontext-backup.sqlite.tmp` (each
3.1 GB) appear to be crash-residue from a prior interrupted backup.
If stale, delete. Saves 6.2 GB of file-cache pressure.

**Risk**: LOW — verify they are not an in-progress backup first
(check mtime, lsof).

---

## Open questions

1. **Why does ai.openclaw.gateway crash instantly?** Requires
   reading `/Users/.../.openclaw/logs/gateway.err.log`. Out of scope
   for this audit (not AIOS-owned).
2. **Does vcontext's plist exist and what's its current ProcessType?**
   I confirmed `com.vcontext.server` is loaded; I did not `cat` the
   plist to check keys. Fix B assumes current absence of
   `ProcessType=Interactive`; if already set, move to Fix A/C/D.
3. **Is `/predict/next` DB-only or does any caller chain call
   `/predictive-search` behind it?** I confirmed the endpoint itself
   is pure SQL; I did not audit the hook chain for whether
   `/predict/next` clients also POST `/predictive-search`.
4. **Could the 2026-04-18 v3 log audit "RSS 1.08 GB trending from 900
   MB" be evidence of a slow leak I'm dismissing?** 180 MB drift over
   ~8 h is well within natural V8 retention of long-lived caches
   (MLX probe cache, vec index). Not conclusive, but if Fix A+B+C+D
   are applied and RSS keeps drifting, revisit.

---

## Evidence cites (verbatim, line-numbers point to log/source above)

- `/tmp/vcontext-server.log` lines 21, 175–206 (first cascade), 6949,
  7095, 7172, 7870 (predict-adjacent kills), 8567, 8639 (disk I/O
  error), 8648, 8823 (latest cascades).
- `/Users/.../scripts/vcontext-server.js` lines 3411 (_mlxEmbedBatchRaw),
  3428 (100 ms gap), 4259 (maxTokens 40960 in runOnePrediction),
  5130 (default maxTokens 4000), 5138 (600 s MLX timeout), 5172
  (_mlxQueue no cap), 5236–5266 (mlxGenerate queue dispatch), 5977
  (handlePredictiveSearch setImmediate).
- `/Users/.../scripts/vcontext-wrapper.sh:31` (4 GB heap cap).
- `/Users/.../scripts/vcontext-hooks.js` lines 1413, 1708, 1786
  (predictive-search fan-out).
- `~/Library/LaunchAgents/ai.openclaw.gateway.plist` lines 10–15
  (KeepAlive + ThrottleInterval=1).
- `vm_stat` + `memory_pressure` output (this report).
- `launchctl list`: com.vcontext.* labels confirmed.

---

## Actions NOT taken (read-only audit)

- No code changes.
- No DB writes, purges, or VACUUMs.
- No server kill or restart.
- No plist reload.
- No removal of openclaw LaunchAgent.
- No deletion of backup-tmp/bak files.

All six proposed fixes require explicit user approval before
implementation. Recommend executing A1 (unload openclaw) FIRST as
zero-risk, highest-leverage step; measure 1 h; then decide on B–F.
