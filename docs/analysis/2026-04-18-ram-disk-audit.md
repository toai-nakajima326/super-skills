# RAM-Disk-Era Dead Code Audit — 2026-04-18

**Context**: Primary DB migrated from 18 GB RAM disk `/Volumes/VContext/`
to SSD `data/vcontext-primary.sqlite` this morning. `USE_RAMDISK` env
flag (default false) gates the old path. Tonight one RAM-disk-era
heuristic (`anomaly-detect` L3487: "RAM disk >3GB" alarm → `migrateRamToSsd()`
loop every 5 min) starved the main thread for 90s+. Root-cause fix
landed in `0252bcc`. This audit classifies every remaining hit so the
class of bug cannot resurface.

**Scope**: `scripts/` + `skills/` only. DB files untouched. Merge
(`ssd.db` + primary) deferred to tomorrow per
`docs/analysis/2026-04-18-db-merge-spec.md`.

## Classifications

- **A** = gated by `USE_RAMDISK` (or only runs when mount exists) → keep
- **B** = dead or heuristically wrong without gate → remove / fix
- **C** = mixed / uncertain → defer + TODO comment

## Survey table

| File:Line | Code | Classification | Action |
|-----------|------|---------------:|--------|
| `scripts/vcontext-server.js:65-77` | `USE_RAMDISK / MOUNT_POINT / DB_PATH / SSD_DB_PATH` constants | A | keep — gates exist downstream |
| `scripts/vcontext-server.js:117-118` | `WARN_SIZE_BYTES = 3 GB`, `MAX_SIZE_BYTES = 3.5 GB` | C | used as a reference budget; tied to 18GB mount. Keep w/ TODO — not the proximate cause of tonight's incident |
| `scripts/vcontext-server.js:123-135` | `getRamMigrateDays()` — checks `DB_PATH.size / 3.5GB` and returns migrate days | C | still runs in SSD mode; it computes but migration only does work when stale rows exist. Leave, add TODO |
| `scripts/vcontext-server.js:224` | `let ramDb, ssdDb` | A | handle name is legacy but semantics are "primary"/"archive". No behaviour issue. |
| `scripts/vcontext-server.js:415` | `ramDb.pragma('mmap_size = 268435456')` — comment "RAM disk so basically free" | C | still correct on SSD; comment is misleading. Leave mmap, refresh comment optionally. |
| `scripts/vcontext-server.js:505-521` | `ensureRamDisk()` — gated by `USE_RAMDISK` | A | keep (correctly gated) |
| `scripts/vcontext-server.js:980-1047` | `migrateRamToSsd()` | A/B mixed | still active between primary and ssd.db (different files), so NOT a true no-op pre-merge. Add `DB_PATH === SSD_DB_PATH` early-return for AC4 forward-compat. |
| `scripts/vcontext-server.js:2052` | `handleHealth` uses `existsSync(MOUNT_POINT)` | A | already gated — only required for healthy when `USE_RAMDISK` |
| `scripts/vcontext-server.js:2284-2328` | `handleTierStats` | B | no `unified` flag; add `unified: (DB_PATH === SSD_DB_PATH) \|\| !USE_RAMDISK` for AC5 |
| `scripts/vcontext-server.js:3476-3487` | `"RAM ahead of SSD" anomaly` | A | semantic comment is accurate; doesn't misfire post-migration |
| `scripts/vcontext-server.js:3489-3500` | `"RAM disk >3GB"` | A | already gated by `USE_RAMDISK` in commit `0252bcc` — verified |
| `scripts/vcontext-server.js:3577-3613` | `respondToAnomalies()` — `ram-disk-full` branch | A | reachable only if alert produced; alert is now USE_RAMDISK-gated so the branch is dead in SSD mode. Keep for revert path. |
| `scripts/vcontext-server.js:6762-6804` | `/admin/ramdisk-stats` | A | gracefully returns `status: 'disabled'` when mount absent |
| `scripts/vcontext-dashboard.html:699, 796-817` | dashboard RAM disk card | A | already renders only when `ramdiskStats.used_pct != null`; returns `null` in SSD mode because status='disabled' has no `used_pct`. Card hidden correctly. |
| `scripts/vcontext-dashboard.html:735` | dashboard "RAM Disk" health dot | B (cosmetic) | always red when unmounted, even in intentional SSD mode. Relabel / adjust |
| `scripts/vcontext-dashboard.html:744-750` | 3-tier bar RAM/SSD/Cloud | B | when unified, ram.entries and ssd.entries map to different DBs; labels are stale. Collapse to Primary/Archive/Cloud and read `tiers.unified`. |
| `scripts/vcontext-setup.sh` many | RAM-disk setup script | A | entire script is the RAM-disk setup; used ONLY by `VCONTEXT_USE_RAMDISK=1` flow |
| `scripts/vcontext-watchdog.sh:40, 162-182` | RAM disk % watchdog | A | runs unconditionally but `df /Volumes/VContext` fails silently → no action when unmounted. Acceptable; TODO to make it explicit. |
| `scripts/pre-outage.sh`, `scripts/vcontext-abtest.sh`, `scripts/vcontext-self-improve.sh`, `scripts/vcontext-maintenance.sh`, `scripts/experiment-thinking-skip.sh` | hard-coded `/Volumes/VContext/vcontext.db` | B (latent) | these scripts break silently in SSD-only mode; out of tonight's scope (not user-facing, not in fragile-path). Document; defer. |
| `scripts/convert-bge-coreml.py`, `scripts/coreml-embed-server.py` | `/Volumes/VContext/bge-small-coreml.mlpackage` | B (out of tonight) | MLX path; M1 territory (deferred) |
| `scripts/vcontext-hooks.js:265` | comment "RAM disk DB size — 4GB cap, alert at 75%" | C | outdated comment; actual code uses `VCONTEXT_DB_PATH`. Leave, add TODO. |
| `scripts/vcontext-hooks.js:2201` | `const VCTX_RAM_DB = '/Volumes/VContext/vcontext.db'` | B (latent) | only used if fallback kicks in; in SSD mode the env-based path is used first. Defer — out of tonight's fragile path. |
| `skills/comprehensive-qa/SKILL.md:387, 401` | documentation examples | C | docs describe RAM-disk setup; accurate when `USE_RAMDISK=1`. Leave with forward note later. |

## Totals

| Class | Count |
|-------|-------|
| A (gated) | 13 |
| B (must fix tonight — core path) | 3 (tier-stats unified flag, migrateRamToSsd early-return, dashboard 3-tier bar) |
| B (latent, out-of-tonight — scripts not in live serving path) | 6 |
| C (defer + TODO) | 6 |

Total B items in tonight's fragile path = **3**. Well under the 15-item cap.
Latent B items in non-live-serving scripts (pre-outage, abtest, self-improve,
maintenance, experiment, hooks legacy fallback) are documented and deferred
to a follow-up task — touching them mid-fragile-night risks more than it
saves.

## Tonight's actions

1. **T3 / AC4** — add `DB_PATH === SSD_DB_PATH` early-return to `migrateRamToSsd()`
2. **T4 / AC5** — add `unified: boolean` + `ram_disk_mounted: boolean` to `/tier/stats`
3. **T5 / AC6** — dashboard reads `tiers.unified`, relabels 3-tier bar "Primary / Archive / Cloud" + hides the "RAM Disk" red health dot when `!ram_disk_mounted && !USE_RAMDISK`
4. Confirm `0252bcc` already gates the `"RAM disk >3GB"` anomaly (T2 / AC1) — **verified at L3493**

## Revert path (AC9)

Setting `VCONTEXT_USE_RAMDISK=1` + `VCONTEXT_DB_PATH=/Volumes/VContext/vcontext.db`
still:
- Mounts RAM disk via `vcontext-setup.sh start`
- Enables the anomaly heuristic
- Keeps `migrateRamToSsd()` active (not no-op)

All RAM-disk code paths are preserved; only incorrect-in-SSD-mode heuristics
are gated off.

## Follow-ups (deferred)

1. `scripts/pre-outage.sh` + 4 siblings: update to honor `VCONTEXT_DB_PATH`
2. `scripts/vcontext-hooks.js` `VCTX_RAM_DB` fallback path modernization
3. `skills/comprehensive-qa/SKILL.md`: add SSD-mode equivalents
4. MLX/CoreML `/Volumes/VContext/bge-small-coreml.mlpackage` path → M1 task
5. 2-DB merge → tomorrow per `docs/analysis/2026-04-18-db-merge-spec.md`

After the 2-DB merge lands, `migrateRamToSsd()` early-return triggers
automatically and the whole tier-migration module becomes a true no-op.

---

*Audit produced by agent `a997cf961a6fddaac` per spec
`docs/spec/2026-04-18-ramdisk-dead-code-cleanup.md`.*
