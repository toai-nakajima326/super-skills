# RAM-disk → SSD migration spec

**Date:** 2026-04-18
**Owner decision:** "RAM diskは、SSDにしましょう、ただしSSD用のバッファーでとして1GBならOKですよ、必要ならの話です"
**Translation:** move primary DB to SSD; optional 1 GB RAM-disk write buffer ONLY if measurably needed. Ship SSD-only first.

## Current state

- Primary DB on 18 GB APFS RAM disk at `/Volumes/VContext/vcontext.db` (~3.1 GB, 56,600 entries)
- Vector index at `/Volumes/VContext/vcontext-vec.db` (~386 MB)
- SSD backup (5-min cadence) at `data/vcontext-backup.sqlite` (~3.1 GB, 56,460 entries — slight lag)
- SSD tier (cold storage) at `data/vcontext-ssd.db` (~3.9 GB, 90,945 entries — cumulative)
- LaunchAgent `com.vcontext.ramdisk` creates RAM disk at boot via `scripts/vcontext-setup.sh start`
- Server (`scripts/vcontext-server.js`) hard-codes `MOUNT_POINT='/Volumes/VContext'`, `DB_PATH=join(MOUNT_POINT,'vcontext.db')`
- RAM→SSD migration runs every 5 min in `doBackupAndMigrate()`; size-based overflow only (85% threshold, currently 999 days effectively off)

## Target state

- Primary DB on internal NVMe at `data/vcontext-primary.sqlite`
- Vector index on internal NVMe at `data/vcontext-vec.db` (moved alongside primary)
- No RAM disk (not even 1 GB) — will add buffer later if p95 write latency regresses
- Tier structure unchanged in concept: **primary (SSD) → tier (vcontext-ssd.db) → cloud**.
  The "RAM tier" naming remains in code for minimal diff — just the physical storage flips.
- LaunchAgent `com.vcontext.ramdisk` bootout'd (file preserved for revert)
- Env flag `VCONTEXT_DB_PATH` allows override; `VCONTEXT_USE_RAMDISK=1` re-enables old behaviour

## Files that change

| File | Change | ~LOC delta |
|---|---|---|
| `scripts/vcontext-server.js` | `DB_PATH` → env-driven, new default; `vecDb` path; `ensureRamDisk()` tolerates absent mount | ~25 |
| `scripts/vcontext-setup.sh` | `hdiutil attach` behind `VCONTEXT_USE_RAMDISK=1` flag, default off; `MOUNT_POINT` unused when flag off; `DB_PATH` honors env | ~20 |
| `scripts/vcontext-watchdog.sh` | `df /Volumes/VContext` guards with `[ -d ]` | ~5 |
| `docs/analysis/2026-04-18-ramdisk-to-ssd-migration-spec.md` | this doc | N/A |

**Not changed (dashboard accepts missing ram_disk):**
- `scripts/vcontext-dashboard.html` — renders `health.ram_disk` as red dot; displays correctly when false
- `scripts/vcontext-hooks.js` — `/Volumes/VContext` is still a valid AIOS-path matcher (defensive whitelist)
- `scripts/vcontext-server.js` `/admin/ramdisk-stats` endpoint — returns 500 when mount absent; acceptable (dashboard has no hard dependency)

## Execution order

1. **Baseline capture** (vm_stat wired, /stats counts, pre-migration DB copy)
2. **Graceful stop**: `launchctl bootout gui/$UID/com.vcontext.server` + pkill stragglers + wait for port 3150 free
3. **Copy DB** RAM → SSD: `cp /Volumes/VContext/vcontext.db data/vcontext-primary.sqlite` (and vec.db)
4. **Edit `vcontext-server.js`**: introduce `VCONTEXT_DB_PATH` env + new default; guard `ensureRamDisk` on flag
5. **Edit `vcontext-setup.sh`**: wrap `hdiutil attach` in `VCONTEXT_USE_RAMDISK=1` check; `DB_PATH` defaults to `data/vcontext-primary.sqlite`
6. **Edit `vcontext-watchdog.sh`**: guard `/Volumes/VContext` df read
7. **Bootout ramdisk LaunchAgent**: `launchctl bootout gui/$UID/com.vcontext.ramdisk`
8. **Restart server**: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.vcontext.server.plist`
9. **Wait /health = 200**; verify `ram_disk=false`, `database=true`
10. **Unmount RAM disk**: `hdiutil detach /Volumes/VContext -force`
11. **Verify**: stats, recall, semantic search, pipeline/health, sqlite count, vm_stat wired (~-3 GB wired, ~-18 GB total allocation)

## Rollback plan

If any verification fails or port 3150 fails to bind cleanly:

1. `launchctl bootout gui/$UID/com.vcontext.server`
2. `export VCONTEXT_USE_RAMDISK=1` (or unset `VCONTEXT_DB_PATH`) and revert server.js/setup.sh via `git checkout scripts/vcontext-server.js scripts/vcontext-setup.sh`
3. If RAM disk still mounted: server resumes using `/Volumes/VContext/vcontext.db`
4. If unmounted: `bash scripts/vcontext-setup.sh start` recreates + restores from `data/vcontext-backup.sqlite` (5-min backup)
5. `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.vcontext.ramdisk.plist`
6. `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.vcontext.server.plist`
7. **Last-resort safety net:** `data/vcontext-premigration-<ts>.sqlite` is a byte-for-byte copy of the RAM DB at migration start. Restore with `cp data/vcontext-premigration-<ts>.sqlite /Volumes/VContext/vcontext.db`.

## Acceptance criteria

- `GET /health` → 200; `database: true`, `ssd_database: true`, `ram_disk: false`
- `GET /stats` entry count within ±50 of pre-migration 56,600 (few may land during window)
- `GET /recall?q=task-runner` → ≥1 result (FTS works)
- `GET /search/semantic?q=hello` → ≥1 result (sqlite-vec works on new vec.db path)
- `GET /pipeline/health` → no NEW red signals beyond pre-migration baseline
- `sqlite3 data/vcontext-primary.sqlite 'SELECT COUNT(*) FROM entries'` matches /stats
- `vm_stat` wired pages drop relative to baseline (exact drop depends on other processes; RAM disk pages freed eventually by unmount)
- Port 3150 owned by a SINGLE process (wrapper single-instance guard honored)
- Pre-existing in-flight work: Q1 LoCoMo full + embed-pace agent will be interrupted by restart — **accepted** per task brief. task-runner's orphan-recovery marks them failed within 30 min.

## Follow-ups (NOT in scope for today)

- 1 GB write-buffer RAM disk: add only if p95 write latency > 400 ms sustained over 30-min window. Implementation sketch: mount at `/Volumes/VContextBuf`, point `entries-wal.jsonl` there, periodic fsync to SSD. Gated by `VCONTEXT_WRITE_BUFFER=1`.
- After 24h of clean SSD-only run: drop `ramdisk.plist` entirely and purge `MOUNT_POINT` dead code.
- Consider consolidating `vcontext-ssd.db` (tier) and `vcontext-primary.sqlite` (primary) — currently we have two SQLite files on SSD for different tiers; may simplify to a single DB with tier column.
