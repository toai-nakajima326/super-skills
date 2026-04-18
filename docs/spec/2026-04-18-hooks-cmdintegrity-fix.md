# Fix: hooks.js cmdIntegrity targets decommissioned RAM path

## Problem

After the RAM→SSD migration (commit `d621456`), `/Volumes/VContext/vcontext.db`
no longer exists. But `scripts/vcontext-hooks.js:2201` still hardcodes
`VCTX_RAM_DB = '/Volumes/VContext/vcontext.db'`, and every usage
(including `cmdIntegrity` at L2346 and `cmdSelfTest`'s integrity probe at
L1056) targets that dead path.

Result: `/tmp/vcontext-maintenance.log` logs `DB integrity: FAILED` every
hour with message "malformed inverted index" (sqlite3 on a nonexistent
file). This aborts the maintenance cycle (`exit 1` at L2364 and
`maintenance.sh:40`), so GC, metrics, snapshots all silently skip.

Example log excerpt:
```
[2026-04-18 19:45:05] === maintenance cycle ===
DB integrity: FAILED
Restore candidate: /Users/mitsuru_nakajima/skills/data/vcontext-backup.sqlite
Run: cp "/Users/mitsuru_nakajima/skills/data/vcontext-backup.sqlite" "/Volumes/VContext/vcontext.db"
[2026-04-18 19:45:05] Integrity FAILED — aborting this cycle
```

## Acceptance Criteria

- **AC1**: `VCTX_RAM_DB` no longer unconditionally points at the RAM path.
  RAM path only active when `VCONTEXT_USE_RAMDISK=1`.
- **AC2**: Default path becomes `~/skills/data/vcontext-primary.sqlite`,
  overridable via `VCONTEXT_DB_PATH` env var — same pattern as
  `vcontext-server.js:65-71`.
- **AC3**: `node ./scripts/vcontext-hooks.js integrity` returns "DB integrity: OK"
  against the real primary DB. Next maintenance cycle's log shows no "FAILED".
- **AC4**: No function signatures change. All 17 call sites at
  L156/183/240/267/281/299/461/485/726/823/1056/2310/2318/2338/2346/2362/2375
  keep using `VCTX_RAM_DB` as an identifier and resolve to the correct
  active DB at runtime.

## Implementation

Change `const VCTX_RAM_DB = '/Volumes/VContext/vcontext.db'` at L2201 to:

```js
const VCTX_RAM_DB = process.env.VCONTEXT_DB_PATH ||
  (process.env.VCONTEXT_USE_RAMDISK === '1'
    ? '/Volumes/VContext/vcontext.db'
    : join(homedir(), 'skills', 'data', 'vcontext-primary.sqlite'));
```

Also update `cmdIntegrity` restore-path hint (L2362) — currently suggests
restoring onto the RAM path regardless of actual DB. Change to print the
DB_PATH currently in use.

## Out of scope

- Renaming `VCTX_RAM_DB` constant to `VCTX_DB_PATH` — 17 call sites,
  cosmetic. Keep name for minimal diff.
- Fixing `maintenance.sh:115` (`DB_RAM="/Volumes/VContext/vcontext.db"`) —
  that is guarded by `[ -f "$DB" ] || continue` so it silently skips
  (not the source of FAILED log noise). Separate cleanup.

## Verify

1. `node --check scripts/vcontext-hooks.js`
2. `node scripts/vcontext-hooks.js integrity` → expect "DB integrity: OK"
3. (Optional) `launchctl kickstart -k gui/$(id -u)/com.vcontext.maintenance`,
   then tail `/tmp/vcontext-maintenance.log` — no "FAILED" in the next cycle.
