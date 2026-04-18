# cmdIntegrity — path fix applied, FTS5 corruption remains

**Date**: 2026-04-18
**Status**: PATH FIX APPLIED. Underlying FTS5 issue deferred.

## What the original task targeted

Fix `cmdIntegrity` at `scripts/vcontext-hooks.js:2346` so it no longer hits
the decommissioned RAM path `/Volumes/VContext/vcontext.db`.

## What was fixed (AC1-AC4 met for path)

`scripts/vcontext-hooks.js:2201-2209` — changed hardcoded constant:

```js
// Before:
const VCTX_RAM_DB = '/Volumes/VContext/vcontext.db';

// After:
const VCTX_RAM_DB = process.env.VCONTEXT_DB_PATH ||
  (process.env.VCONTEXT_USE_RAMDISK === '1'
    ? '/Volumes/VContext/vcontext.db'
    : join(homedir(), 'skills', 'data', 'vcontext-primary.sqlite'));
```

Also updated restore-hint comment near L2361.

Confirmation (after kickstart):
```
[2026-04-18 20:35:36] === maintenance cycle ===
Run: cp ".../vcontext-backup.sqlite" ".../vcontext-primary.sqlite"
                                       ^^ Correct target — was /Volumes/VContext before
```

## What the fix revealed

The maintenance log now shows that `PRAGMA integrity_check; PRAGMA quick_check;`
run together against the **live primary DB while server is writing** produces:

```
ok
malformed inverted index for FTS5 table main.entries_fts
```

But each PRAGMA run **individually** on the same DB returns `ok`. This
implies the FTS5 shadow table sees a transient inconsistency only when
both checks traverse together under concurrent WAL writes. This is
**different from** the SSD.db corruption the v2 audit said was fixed by
REINDEX — that was on `vcontext-ssd.db`, not `vcontext-primary.sqlite`.

## Why deferred

- User said "DO NOT restart vcontext-server (MLX + server fragile tonight)"
- A proper fix likely requires `INSERT INTO entries_fts(entries_fts)
  VALUES('rebuild');` on `vcontext-primary.sqlite`, which needs either:
  - Server down during rebuild (conflicts with tonight's constraint)
  - A safe online rebuild via the server admin endpoint
- The FTS5 issue is orthogonal to the cmdIntegrity path bug — the log
  will now at least name the correct DB if the maintenance cycle detects
  a real problem.

## Follow-up (separate task)

1. Investigate whether `vcontext-primary.sqlite` FTS5 needs REINDEX.
   Run offline: `sqlite3 <db> "INSERT INTO entries_fts(entries_fts)
   VALUES('integrity-check');"` — should silently succeed. If it errors,
   rebuild is needed.
2. Consider splitting cmdIntegrity's two PRAGMAs into separate invocations
   so a transient FTS5 concurrency miss doesn't flag the whole DB.
3. `maintenance.sh:115` (`DB_RAM="/Volumes/VContext/vcontext.db"`) — still
   stale but silently skips via `[ -f "$DB" ] || continue`. Cosmetic.

## Files changed

- `scripts/vcontext-hooks.js:2201-2209` — path resolution.
- `scripts/vcontext-hooks.js:2361` — restore-hint comment clarified.
- `docs/spec/2026-04-18-hooks-cmdintegrity-fix.md` — mini-spec.
