# Autonomous Cadence Audit — 2026-04-18

**Scope**: All `com.vcontext.*` LaunchAgents (daemons + cron loops). Read-only
inventory, 24h timeline, collision report, proposed adjustments.
**Method**: `plutil -p` on each plist + `launchctl print` load verification +
source read of invoked scripts (MLX/DB profiling only — no behavior change).
**Constraint**: Zero plist edits, zero disable, zero commit outside this doc.

---

## Section 1 — Inventory table

16 plists found under `~/Library/LaunchAgents/com.vcontext.*.plist`. 15 are
loaded (verified via `launchctl print gui/501/<label>`); 1 is unloaded
(ramdisk — ran-once, completed at boot).

| # | label | type | schedule (JST) | invokes | MLX use per run | est duration |
|---|-------|------|----------------|---------|-----------------|--------------|
| 1 | com.vcontext.server | daemon | KeepAlive=true, RunAtLoad | `scripts/vcontext-wrapper.sh` → `vcontext-server.js` | internal bg generate loop (separate concern) | always on |
| 2 | com.vcontext.mlx-generate | daemon | KeepAlive (SuccessfulExit=false), RunAtLoad, Nice=-20 | `mlx-generate-wrapper.sh` → port 3162 | N/A (it IS the MLX generate server) | always on |
| 3 | com.vcontext.mlx-embed | daemon | KeepAlive (SuccessfulExit=false), RunAtLoad, Nice=-20 | `mlx-embed-server.py --port 3161` (Qwen3-Embedding-8B) | N/A (it IS the MLX embed server) | always on |
| 4 | com.vcontext.watchdog | daemon | KeepAlive=true, RunAtLoad | `vcontext-watchdog.sh` | probe-only (3 tok `/v1/chat/completions` liveness ping, at its own cadence inside the script) | continuous |
| 5 | com.vcontext.task-runner | daemon | KeepAlive=true, RunAtLoad, ThrottleInterval=10 | `aios-task-runner.js` | on-demand (when a task is queued) | continuous |
| 6 | com.vcontext.hooks-setup | boot-once | RunAtLoad=true (no interval) | `setup-hooks.sh` | none | ~1s at boot |
| 7 | com.vcontext.ramdisk | boot-once | RunAtLoad=true (no interval); **not currently loaded** | `vcontext-setup.sh start` | none | ~3s at boot |
| 8 | com.vcontext.maintenance | hourly | `StartInterval=3600` + `RunAtLoad=true` | `vcontext-maintenance.sh` | 1× `/v1/chat/completions` probe (`max_tokens:3`) per run | 5-30s |
| 9 | com.vcontext.keyword-expander | daily 05:00 | `StartCalendarInterval{Hour:5,Minute:0}` | `keyword-expander.js --verbose` | 1× MLX generate (large prompt, `max_tokens` default — suggest NEW keywords from 30-day activity) | 20-120s |
| 10 | com.vcontext.article-scanner (morning) | daily 06:00 | `StartCalendarInterval{Hour:6,Minute:0}` | `article-scanner.js` | 1× MLX generate per scraped article (max 800 tok, 120s timeout). Cap: `SOURCES × KEYWORDS × 2 articles/src`; default ≤ ~20 articles/run | 3-15 min |
| 11 | com.vcontext.self-evolve | daily 07:00 | `StartCalendarInterval{Hour:7,Minute:0}` | `self-evolve/scripts/self-evolve.js --observation --verbose` | multi-call: 1 MLX generate per candidate, all behind `aios-mlx-lock`. MLX-heavy | 5-30 min |
| 12 | com.vcontext.morning-brief | daily 09:00 | `StartCalendarInterval{Hour:9,Minute:0}` | `vcontext-morning-brief.sh 1` | **zero** (pulls `/admin/health-report` JSON + osascript notification) | <5s |
| 13 | com.vcontext.skill-discovery | weekly Mon 09:30 | `StartCalendarInterval{Hour:9,Minute:30,Weekday:1}` | `skill-discovery.sh` | 1× MLX generate per discovered tool (Qwen3-8B-4bit prompt) | 2-10 min |
| 14 | com.vcontext.new-feature-watcher | daily 10:00 | `StartCalendarInterval{Hour:10,Minute:0}` | `new-feature-watcher.cjs` | 1× MLX generate per new tool discovered (`generateSkillMd` loop) | 2-8 min |
| 15 | com.vcontext.conversation-skill-miner | daily 11:00 | `StartCalendarInterval{Hour:11,Minute:0}` | `conversation-skill-miner.cjs` | 1× MLX generate per candidate (`generateSkillMd` loop over candidates) | 3-10 min |
| 16 | com.vcontext.article-scanner-evening | daily 18:00 | `StartCalendarInterval{Hour:18,Minute:0}` | `article-scanner.js` (same script as #10) | same profile as morning run | 3-15 min |

**Background ticks** (not a LaunchAgent but runs inside `com.vcontext.server`):

| loop | cadence | phase | duration | resource |
|------|---------|-------|----------|----------|
| backup + vecSync + migration | `setInterval(doBackupAndMigrate, 5*60*1000)` | **server-boot-phase**, not wall-clock aligned. Current server booted 16:23:27 → backup ticks at ~:03, :08, :13, :18, :23, :28, :33, :38, :43, :48, :53, :58 (±10s) | 2-10s normal, up to 30s if DB grew | DB write (RAM→SSD backup), SSD DB checkpoint |

**Nothing found with both `StartInterval` and `StartCalendarInterval`** — no
misconfigured plists.

---

## Section 2 — 24h timeline (JST)

Notation: `▮` per ~5 min expected duration. `[BK]` = possible backup-tick window.

```
Hour  | Loops firing                                        | Backup ticks (approx, ±30s window)
──────┼─────────────────────────────────────────────────────┼───────────────────────────────────
00:00 | —                                                   | [BK] 00:03 00:08 00:13 00:18 00:23 00:28 00:33 00:38 00:43 00:48 00:53 00:58
00:?? | maintenance (hourly, phase depends on boot)         |
01:00 | —                                                   | every 5 min
01:?? | maintenance                                         |
02:00 | —                                                   |
02:?? | maintenance                                         |
03:00 | —                                                   |
03:?? | maintenance                                         |
04:00 | —                                                   |
04:?? | maintenance                                         |
05:00 | keyword-expander ▮▮▮▮ (MLX-G, 20-120s)              | [BK] 05:03 overlaps keyword-expander tail
05:?? | maintenance                                         |
06:00 | article-scanner morning ▮▮▮▮▮▮▮▮▮ (MLX-G, 3-15min)  | [BK] 06:03, 06:08, 06:13 — overlap the whole run
06:?? | maintenance                                         |
07:00 | self-evolve ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ (MLX-G, 5-30min)      | [BK] 07:03, 07:08, 07:13, 07:18, 07:23, 07:28
07:?? | maintenance                                         |
08:00 | —                                                   | backup only
08:?? | maintenance                                         |
09:00 | morning-brief ▮ (<5s, no MLX)                       | [BK] 09:03
09:30 | skill-discovery ▮▮▮▮ (Mon only, MLX-G, 2-10min)     | [BK] 09:33, 09:38, 09:43
09:?? | maintenance                                         |
10:00 | new-feature-watcher ▮▮▮ (MLX-G, 2-8min)             | [BK] 10:03, 10:08
10:?? | maintenance                                         |
11:00 | conversation-skill-miner ▮▮▮ (MLX-G, 3-10min)       | [BK] 11:03, 11:08
11:?? | maintenance                                         |
12:00 | —                                                   | backup only
12:?? | maintenance                                         |
…     | (quiet afternoon)                                   |
17:00 | —                                                   | backup only
17:?? | maintenance                                         |
18:00 | article-scanner evening ▮▮▮▮▮▮▮▮▮ (MLX-G, 3-15min)  | [BK] 18:03, 18:08, 18:13
18:?? | maintenance                                         |
19:00 | —                                                   | backup only
…     |                                                     |
23:00 | —                                                   | backup only
```

---

## Section 3 — Collision report

Severity: **LOW** = minor tail overlap, likely fine. **MEDIUM** = concurrent
MLX-generate within 30-min window, contention via `aios-mlx-lock` but possible
queueing. **HIGH** = two or more long-running MLX-G jobs stacking, or
lock-contention risk with backup tick.

| # | severity | when | loops | description |
|---|----------|------|-------|-------------|
| C1 | LOW | :00 of any daily-firing hour | any daily loop + backup | LaunchAgent fires at :00; backup runs at ~:03/:08 (server-phase dependent). Current server phase puts backup at :03 wall-clock → **3 min after each daily loop starts** = harmless if loop > 3 min (lock is on DB write, not blocking loop reads), but if server restarts the phase shifts. |
| C2 | LOW | 06:00 + 07:00 stacking | article-scanner morning (up to 15 min) → self-evolve (up to 30 min) | Back-to-back MLX-G at 60-min gap. Article-scanner tail (06:15) precedes self-evolve head (07:00) by 45 min → no direct overlap, but both contest the same day's MLX thermals. |
| C3 | MEDIUM | 09:00-09:45 Mondays | morning-brief (09:00, no MLX) + skill-discovery (09:30, MLX-G, up to 10 min) | No MLX overlap (morning-brief has zero MLX). Low-severity only because clustered in a 45-min window, but skill-discovery may still be running at 09:40 while backup ticks at 09:38/09:43. Backup tick × DB-write inside skill-discovery `/store` at same moment → possible SQLite busy_timeout hit (5s timeout configured; unlikely to fail but worth watching). |
| C4 | MEDIUM | 10:00 → 11:00 | new-feature-watcher (up to 8 min) → conversation-skill-miner (up to 10 min) | Separated by 52+ min in worst case. No direct MLX overlap under `aios-mlx-lock`. But both are "generate skill-md per candidate" loops of identical structure — if one hangs past 1 hour, the second starts while the first still holds the MLX lock → lock queueing (task-runner also competes). |
| C5 | MEDIUM | daily 05:00-08:00 | keyword-expander (05:00) → article-scanner morning (06:00) → self-evolve (07:00) | Three MLX-generate loops in a 3-hour dawn block. Under `aios-mlx-lock` each run sequentializes, but if 05:00 overruns past 06:00 (120s LLM timeout × multiple retries possible), article-scanner waits for lock → cascading delay. Worst-case self-evolve doesn't start until 07:30+. |
| C6 | LOW | any hour ~:00 | maintenance (hourly, phase=boot-time) + daily loop at :00 | Maintenance fires on its own hourly cadence (since boot). Current phase unknown without log inspection; likely lands somewhere in the hour unrelated to :00. Low unless it coincidentally aligns with :00 + server ~:03 backup. |
| C7 | HIGH | **18:00** vs morning block | article-scanner-evening (18:00, 3-15 min) | Standalone — no other loop at 18:00, only backup ticks. **Low risk.** *Downgrade to LOW after review* — the timeline shows evening is isolated. |

Rolling 1-hour windows with >3 loops firing:

- **09:00-10:00** (Mondays): morning-brief + skill-discovery + new-feature-watcher (10:00 start). = 3 loops, boundary case.
- No window currently has strictly >3 overlapping loops.

---

## Section 4 — Proposed adjustments

All proposals are **deferred** — audit is read-only. Apply only after separate
approval.

| # | target loop | current | proposed | rationale | rollback |
|---|-------------|---------|----------|-----------|----------|
| P1 | conversation-skill-miner | daily 11:00 | daily **11:15** | Distance new-feature-watcher (10:00) tail (up to 10:08 run + backup at 10:08/10:13). A 15-min shift keeps the daily slot but reduces lock-queue risk when both overrun. | `plutil -replace StartCalendarInterval.Minute -integer 0 <plist>` + reload |
| P2 | new-feature-watcher | daily 10:00 | daily **10:20** | Offset from the :00 wall-clock mark so backup tick (server phase-dependent) doesn't cluster at the loop start. :20 minute is well clear of :18/:23 backup ticks under the current server phase. | same pattern |
| P3 | keyword-expander | daily 05:00 | daily **04:30** | Widen the gap to article-scanner (06:00) from 60 min to 90 min. Reduces lock cascade risk in C5. Also moves off the :00 mark. | same pattern |
| P4 | self-evolve | daily 07:00 | daily **07:30** | Same :00 mark concern. Also self-evolve is longest (up to 30 min); a :30 start lands its tail at :00 of next hour, cleanly before morning-brief at 09:00. | same pattern |
| P5 | morning-brief | daily 09:00 | daily **08:55** | Frees 09:00-09:30 band to be empty so Mondays' skill-discovery (09:30) has a clean start. Morning-brief is <5s and zero-MLX → can move without interaction impact. | same pattern |
| P6 | maintenance | hourly (boot-phase) | **hourly at :45** (`StartCalendarInterval{Minute:45}`) | Pinning maintenance to :45 removes the phase-drift concern — you can predict exactly when the MLX probe fires, and :45 is the quietest slot on the timeline. Keep `StartInterval=3600` removed to avoid double-schedule bug. | requires replacing `StartInterval` with `StartCalendarInterval` in plist; rollback by restoring original plist from git history |

**If only ONE proposal is accepted**, P6 (maintenance to fixed :45) has the
highest value: it eliminates a whole class of "phase unknown" ambiguity in
future audits.

**Net effect of all 6**:

```
04:30 keyword-expander
06:00 article-scanner morning
07:30 self-evolve
08:55 morning-brief
09:30 skill-discovery (Mon)
10:20 new-feature-watcher
11:15 conversation-skill-miner
18:00 article-scanner evening
[every hour]:45 maintenance
```

Daily loops now all end at least 10 minutes before the next begins (in typical
durations), and none coincide with :00 wall-clock backup ticks.

---

## Section 5 — Followup items

1. **ramdisk plist not loaded** — `launchctl print` returned "Bad request"
   (confirmed via `Could not find service`). Either intentionally unloaded
   (RAM disk already mounted via prior boot) or silently broken. Needs
   manual inspection: `launchctl load ~/Library/LaunchAgents/com.vcontext.ramdisk.plist`
   dry-run — does it succeed, and if so, was it simply never re-loaded after
   an unload?
2. **Backup phase drift** — backup interval is relative to server boot, not
   wall-clock. Any server restart shifts the phase. Followup: consider
   replacing `setInterval(doBackupAndMigrate, 5*60*1000)` with a wall-clock
   aligned schedule (e.g., next tick at ceil(now / 5min)). Would make audits
   deterministic and remove C1 ambiguity.
3. **maintenance hourly phase** — the exact hourly tick time was not read
   from the live process. Needs `launchctl list | grep maintenance` →
   observe `LastExitStatus` timestamps in log to derive actual phase. P6
   would make this moot.
4. **task-runner on-demand MLX load** — this daemon can call MLX generate
   whenever a queued task arrives. Not cron-scheduled, so not on the
   timeline, but could still collide with scheduled loops. Out of scope for
   a cadence audit; flag for future "MLX lock utilization" audit.
5. **self-evolve duration variance** — estimated 5-30 min based on
   "candidates × 1 MLX-G each" but no measured p95 in logs. Followup:
   parse `/tmp/vcontext-self-evolve.log` across past 7 days for actual
   durations.
6. **watchdog internal cadence** — watchdog.sh runs continuously; its MLX
   probe frequency is inside the shell script (not in plist). If it probes
   every minute, that's 60 probes/hour × 3 tokens each = negligible but
   worth confirming before adding any more hourly loops.

---

## Audit summary (for report)

- Total loops audited: **16** (15 loaded, 1 ramdisk ran-once).
- Cron-scheduled distinct loops: **8 daily + 1 weekly + 1 hourly = 10**.
- Daemons / boot-once (no cadence concern): **6**.
- Collisions detected: **7** (HIGH: 0 after C7 downgrade, MEDIUM: 3, LOW: 4).
- Proposed adjustments: **6** (all deferred, read-only audit).
- Misconfigured plists (StartInterval + StartCalendarInterval both set): **0**.
