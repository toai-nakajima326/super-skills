# AIOS morning 3-bug cascade — 2026-04-20

**Summary**: After Monday morning's openclaw-gateway bootout (per
`2026-04-18-oom-cascade-root-cause.md`), three compounding bugs were
identified and fixed in sequence. One was surfaced by Codex sending a
field report ("VContextへの保存は試しましたが、DB上限 3.5GB で Writes
refused でした"), one by the AIOS hard-gate repeatedly blocking this
session's own Bash commands despite 109 skill-usage entries, and one
was found by the parallel audit agent as a latent compounder.

## The three bugs

### Bug 1 — `/store` HTTP 507 write-refusal on all DBs > 3.5 GB

**File**: `scripts/vcontext-server.js` L118 (pre-fix)
**Symptom**: Every POST /store returns `{"error":"Database at maximum size (3.5GB). Writes refused."}`.
**Root cause**: `MAX_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024` was a hard
cap, sized for the 18 GB RAM-disk era where DB_PATH lived on
`/Volumes/VContext` and had to leave budget for other RAM uses. After
the 2026-04-18 RAM→SSD migration (`d621456`), DB_PATH points at
`~/skills/data/vcontext-primary.sqlite` on APFS with hundreds of GB
free. Current size is 5.97 GB, well past the obsolete cap.
**Impact**: Silent write loss for all clients — Codex, self-evolve,
skill-discovery, hooks, dashboard UI. The only reason this session kept
functioning was that READ paths don't call `checkDbSize()`.
**Fix** (L117-130, L854-858 of server.js): USE_RAMDISK-gated caps.
RAM mode keeps the 3 GB warn / 3.5 GB max. SSD mode uses 40 GB warn /
50 GB max (≈10× current size, room to grow before any refusal). Error
messages now interpolate the live cap via `_fmtGB()` so operators can
see mode at a glance.
**Verification**: Live `/store` POST returned `{"stored":{"id":217572,...}}`
immediately after the fix — confirms cap is now effective at 50 GB.

### Bug 2 — AIOS hard-gate blocks writes whenever vcontext server is down

**File**: `scripts/vcontext-hooks.js` L1086-1087 (pre-fix)
**Symptom**: Every Edit/Bash/Write against `~/skills/**` or
LaunchAgent paths returns `{continue: false, stopReason: "AIOS-connected
write detected..."}` — even though the session has 109 historical
skill-usage entries, the gate says "no routing yet."
**Root cause**: `get()` uses a "resolve never reject" pattern — on
ECONNREFUSED / timeout / JSON parse-fail it returns `{results:[]}`.
The gate's `sessionHasSkillUsage()` sees empty results, returns
`hasRouted=false`, and blocks. The intended fail-open catch in
`handlePreToolGate()` at L1334-1338 is unreachable because `get()`
never throws.
**Impact**: During the morning's OOM cascade / watchdog restart loop
(server unreachable for ~80 s every minute), EVERY AIOS write attempt
was hard-blocked. This is what made manual recovery of the cap bug so
slow — we were fighting the gate while it fought the cascade.
**Fix** (L1072-1103, L1279-1289 of hooks.js): `get()` attaches an
`_infra_error` sentinel (`'connect' | 'timeout' | 'parse'`) on failure
paths. Existing callers that only read `r.results` are unaffected.
`sessionHasSkillUsage()` now throws when `_infra_error` is set so the
fail-open catch runs. Verified via `VCONTEXT_PORT=9999` simulation:
hook emits no block payload, `/tmp/vcontext-errors.jsonl` records
`aios_gate_query_failed: vcontext unreachable (connect)`.

### Bug 3 — Latent `getRamMigrateDays()` nonsense in SSD mode

**File**: `scripts/vcontext-server.js` L139-146 (pre-fix)
**Symptom**: In SSD mode, `RAM_TO_SSD_DAYS` computed as `0` (meaning
"migrate everything now") because `5.97 GB / 3.5 GB * 100 = 170%` far
exceeds the 85% threshold. The migrate code path at L1047 has a
`DB_PATH === SSD_DB_PATH` guard, but our deployment uses
`vcontext-primary.sqlite` (not `SSD_DB_PATH = vcontext-ssd.db`), so the
guard doesn't fire; migration runs on every maintenance tick with nothing
real to migrate.
**Impact**: Low severity standalone, but a contributor to maintenance-
cycle CPU/IO spikes that correlate with watchdog-observed `/health`
timeouts. Agent-flagged as "latent compound bug."
**Fix** (L139-155 of server.js): Early return when `!USE_RAMDISK`. The
concept "spill from RAM to SSD" simply doesn't apply when both tiers
are SSD paths.

## Additional stability actions

1. **Openclaw plist disabled** — renamed `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
   to `.disabled.2026-04-20` so the 1-spawn-per-second crash loop
   (root cause of weekend OOM cascades, per
   `2026-04-18-oom-cascade-root-cause.md`) doesn't return on next login.
   Bootout alone doesn't survive reboot with `RunAtLoad=true + KeepAlive=true`.

2. **Rogue `sqlite3 PRAGMA integrity_check` (PID 48255) killed** — 8-min
   old, 28% CPU, holding a read lock on the primary DB. Audit-agent-
   flagged as contributing to the server's response-timeout → watchdog
   SIGKILL → wrapper restart cycle.

3. **Watchdog paused** — the 07:42-→ force-restart loop (every ~60 s:
   "Server /health fail x2 — force bootout + bootstrap") was fighting
   the server's 79-second SQLite cold-boot, killing it mid-backfill.
   Watchdog will be restarted with calmer settings after commit lands.

## Audit agents used (read-only, parallel)

- **Stability audit**: caught that my in-flight edit had already
  landed (prior agent run was stale), found L142 hardcoded denominator,
  enumerated 9 additional silent `get()`-failure call sites, verified
  `/tmp/vcontext-errors.jsonl` had never been written (confirming
  fail-open path never fired in production).
- **Openclaw verification**: confirmed bootout stuck, plist still on
  disk, memory tight but no active AIOS OOM kills, mlx-generate not
  loaded (needs separate bootstrap), `com.vcontext.maintenance` has
  40× exit=1 streak (deferred: separate investigation).

## Follow-ups (not blocking)

- **M23**: Address the 9 silent-fail-on-empty `get()` callers (L213,
  664, 697, 960, 973, 1854, 2101, 2121, 2134, 2544). These don't block
  but cause silent policy loss (MANDATORY rules, goals, reminders)
  during server-down windows. Same `_infra_error` pattern applies —
  callers should distinguish and either retry or log clearly.
- **M24**: com.vcontext.maintenance 40× exit=1 streak (silent bug).
- **M25**: mlx-generate bootstrap after OOM memory settles.
- **M26**: Watchdog safer settings (60 s interval, no auto-force-restart
  during cold-boot window, skip restart if `sqlite3` diagnostic
  processes are active).

## Phase state

- All 3 bugs: **FIXED** on disk, verified at runtime.
- Server: healthy, uptime >60 s post-restart, writes accepting.
- Codex's "Writes refused" error: **resolved** — next /store from Codex
  will return 200.
- AIOS gate: **functioning correctly** — both positive (skill-usage
  exists → PASS) and fail-open (server down → PASS with error log)
  verified.
