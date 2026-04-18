# Spec — doBackup() integrity-check before rotation

**Date**: 2026-04-18
**Owner**: vcontext-server
**Trigger**: data re-audit v2 (`b54d9b2`) — malformed `.bak` (2.39 GB file, 3.33 GB header = ~940 MB truncated). Root cause: `rename(2)` pattern in `scripts/vcontext-server.js:863-866` promotes whatever `.sqlite` currently exists (even a corrupt one) into the `.bak` slot on the next cycle.

## Current rename chain (buggy)

```
ramDb.backup(tmp)  → tmp
if exists(.sqlite): rename(.sqlite → .bak)   ← promotes corrupt .sqlite too
rename(tmp → .sqlite)
```

`rename(2)` is POSIX-atomic but byte-oblivious: it renames inodes regardless of file content, so a truncated `.sqlite` silently becomes a truncated `.bak`, destroying the last good safety copy.

## Fixed rename chain

```
ramDb.backup(tmp)           → tmp
verify integrity_check(tmp)       ← NEW: reject if not "ok"
if exists(.sqlite):
    verify integrity_check(.sqlite)  ← NEW: skip .bak promotion if corrupt
    rename(.sqlite → .bak)
rename(tmp → .sqlite)
```

## Acceptance Criteria

- **AC1**: Before promoting the freshly-written tmp to `.sqlite`, run `PRAGMA integrity_check` on `tmp`. If result is not `"ok"`, unlink `tmp`, log a warning, emit anomaly-alert, and abort this cycle (leave `.sqlite` and `.bak` untouched).
- **AC2**: Before rotating old `.sqlite` to `.bak`, run `integrity_check` on current `.sqlite`. If not `"ok"`, keep old `.bak` intact and skip that rename — but still promote the (verified-good) tmp to `.sqlite` so the next cycle has a healthy source to rotate.
- **AC3**: Function signature of `doBackup()` unchanged. No new npm dependencies. Use existing `dbQuery(sql, path)` helper which already supports readonly open on arbitrary file paths.
- **AC4**: On any reject, insert a row: `type='anomaly-alert'`, content `{ alerts: [{ kind:'backup-integrity-fail', file, reason, detected_at }] }`. Pattern mirrors line 3591.
- **AC5**: Integrity-check performance: on a ~3 GB SQLite file the check is typically 1–5s. Backup cycle is 5-min, so the cost is acceptable. If we observe >10s wall-time in practice, we will add a fast-path (skip check every N cycles) — not implemented in v1.

## Non-goals

- Do NOT restart vcontext-server. Change lands on next natural 5-min `doBackup()` or Monday's first natural restart.
- Do NOT change the SSD-tier or WAL replay paths. This is only the RAM→disk backup rotation.
- Do NOT modify `setup.sh` restore_backup logic (separate concern).

## Risk

- Low. Adds reject-paths only; does not alter the successful-case rename chain.
- `dbQuery(sql, arbitrary-path)` already opens readonly, so the checks cannot corrupt files.
- Worst case if `integrity_check` itself throws: `verifyBackup()` catches and returns false → we skip rotation this cycle, which is the safe default.
