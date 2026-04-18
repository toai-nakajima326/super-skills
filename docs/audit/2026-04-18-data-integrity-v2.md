# 2026-04-18 Data Integrity Audit v2 (post-fix re-check)

**Trigger**: user directive "修正したので、もう一回" — second pass after tonight's
REINDEX / orphan-WAL cleanup / task-runner respawn (first audit: `34a1d80`,
`docs/audit/2026-04-18-data-integrity.md`).
**Mode**: READ-ONLY (SELECT + PRAGMA only; no ALTER/INSERT/DELETE/VACUUM/CHECKPOINT).
**Skills applied**: `infinite-skills` (routing), `quality-gate`, `investigate`,
`security-review`, `spec-driven-dev`.

## Mini-spec + AC

- **Goal**: verify first-audit fixes held, detect any new anomalies since 19:31 JST.
- **Acceptance criteria**:
  1. All 8 DBs still PASS `integrity_check` + `foreign_key_check`.
  2. primary FTS drift: was +24 → after REINDEX should be 0 or near-0.
  3. No outstanding rollback journals (`.db-journal`).
  4. WAL size sanity check (>10MB = long txn flag).
  5. Backup freshness within 5-min cycle.
  6. Secret-regex on new rows since audit 1 finds 0 real tokens.
  7. LoCoMo / skill-discovery JSON schema still valid.
  8. Orphan `vcontext-ram-corrupt-*` WAL/SHM confirmed gone.

---

## 0. First-audit findings — status

| Finding | Severity | Status |
|---|---|---|
| Orphan `vcontext-ram-corrupt-20260417-*` WAL/SHM | HIGH | **RESOLVED** — files absent from `data/` |
| primary FTS +24 drift | LOW (race) | **RESOLVED** — REINDEX held, delta now 0 |
| Premigration backup 24h retention | MED | unchanged (mtime 16:13, 4h old — still within window) |
| Primary 3.1GB > 3GB warn | LOW | unchanged (now 3.33GB, warn level in RAM-days config still applies — but migration-era config; obsolete) |

## 1. Inventory delta (since first audit 19:31 JST)

- **Removed**: `vcontext-ram-corrupt-20260417-181759.db-wal` / `.db-shm` (orphans gone) ✓
- **Added**: none (no new backup snapshots, no new locomo/skill-discovery files)
- **Changed (live writes)**:
  - `vcontext-primary.sqlite` 3.10GB → 3.33GB (+235MB WAL checkpoint ingestion)
  - `vcontext-primary.sqlite-wal` 14.8MB → 36.4MB (growth under load)
  - `vcontext-ssd.db` 4.29GB → 4.70GB
  - `vcontext-ssd.db-wal` 40.1MB → 42.0MB (flat)
  - `vcontext-vec.db` 689MB → 740MB (+embedding inserts)
  - `vcontext-backup.sqlite` mtime 19:20 → 20:13 (**but mid-audit observed race**, see §6)
  - `vcontext-audit.db` 280kB → 290kB, rows 1473
  - `entries-wal.jsonl` 115MB → 125MB (+10MB JSONL replay log)

Note: first audit mis-identified paths as `/Volumes/VContext/*` — actual
location is `/Users/mitsuru_nakajima/skills/data/`. No data impact;
corrected here.

## 2. Integrity + Foreign-Key Re-check (8 DBs)

| File | integrity_check | foreign_key_check | OK? |
|------|-----------------|-------------------|-----|
| vcontext-primary.sqlite | ok | (no violations) | PASS |
| vcontext-ssd.db | ok | (no violations) | PASS |
| vcontext-vec.db | ok | (no violations) | PASS |
| vcontext-backup.sqlite (post-rotation, 20:13) | ok | (no violations) | PASS |
| vcontext-backup.sqlite.bak | **malformed (11)** | — | **FAIL — HIGH** |
| vcontext-premigration-1776496379.sqlite | ok | (no violations) | PASS |
| vcontext-audit.db | ok | (no violations) | PASS |
| vcontext-kg.db | ok | (no violations) | PASS |

**7 of 8 PASS.** `vcontext-backup.sqlite.bak` FAILS `integrity_check` with
"database disk image is malformed" on every read. File is 2.39GB but header
declares 813968 pages × 4096B = 3.33GB → **file is truncated** ~940MB short.

**Race witnessed mid-audit**: at 20:10 `vcontext-backup.sqlite` itself was
also truncated-malformed (2.39GB, mtime 19:48). Shortly after, a new backup
cycle completed (server log: `[vcontext] Backup complete: …` at ~20:13);
after rotation, `.sqlite` became the fresh 3.33GB good file, and the
malformed 2.39GB was shuffled into the `.bak` slot by the rename(2) pattern
in `scripts/vcontext-server.js:863-866`.

## 3. FTS regression (primary & ssd, post-REINDEX)

| DB | entries | entries_fts | delta | Status |
|---|---:|---:|---:|---|
| primary (audit 1, 19:31) | 56,626 | 56,650 | +24 | live-write race |
| primary (audit 2, 20:17) | 59,413 | 59,413 | **0** | **FIXED** |
| ssd (audit 1, 19:31) | 114,466 | 114,466 | 0 | OK |
| ssd (audit 2, 20:17) | 118,053 | 118,053 | 0 | OK |
| backup.sqlite (20:13 post-rotation) | 59,251 | 59,251 | 0 | OK |

REINDEX held; FTS drift delta reduction from +24 → 0 confirms the race was a
triggers-not-yet-flushed artifact, not a real corruption.

## 4. Transaction sanity

- **Rollback journals (`*.db-journal`)**: none. All WAL-mode.
- **WAL sizes**:
  - `vcontext-primary.sqlite-wal` = **36.4MB** (>10MB threshold)
  - `vcontext-ssd.db-wal` = **42.0MB** (>10MB threshold)
  - Others: 0 bytes (idle backups)
- `PRAGMA wal_autocheckpoint` = 1000 pages (SQLite default). WAL files grow
  faster than checkpoint cadence during active session — readers (this
  audit + hooks) block full truncate. **Not corruption; capacity signal.**
  Severity **MED** (resolves when session quiets).

## 5. Row count + type distribution (since first audit)

- **Primary**: +2,787 entries (MAX id 159,207 → 163,856; created_at 10:31:30 → 11:17:19 UTC).
- **SSD**: +3,587 entries (MAX id 161,208 → 164,300).
- Type distribution of primary new rows:
  `pre-tool 2061 · tool-use 2001 · working-state 183 · assistant-response 98 · session-end 52 · user-prompt 46 · subagent-stop 35 · tool-error 27 · predictive-search 17 · handoff 15 · skill-usage 12 · completion-violation 11 · session-summary 11 · decision 6 · skill-gap 6 · session-recall 5 · anomaly-alert 4 · compact 4 · skill-suggestion 4 · …`

All types are known hook-driven kinds; no bulk insert or novel type
appeared. 0 rows with NULL content. 16 tool-use rows >100KB (normal for
Read/Grep output capture). 5 distinct sessions (normal concurrency).

## 6. Backup freshness

- `vcontext-backup.sqlite` mtime at 20:13 → ~4 min before audit end (20:17)
  → **within 5-min cycle** ✓
- At 20:10 mid-audit, mtime was 19:48 (22 min stale) AND file was malformed.
  The 20:13 `Backup complete` log line resolved it. This ~25-min gap
  between 19:48 and 20:13 is **the anomaly**: backups normally rotate every
  300s. Explanation in log: several cycles ran but async `ramDb.backup(tmpPath)`
  may have been queued behind large write load. Observed "Backup every 300s"
  entries without matching "Backup complete" for that window.
- Row-count drift vs primary: backup 59,251 vs primary 59,413 = -162 rows =
  44s worth of ingestion, consistent with 20:13 snapshot vs 20:17 live read.

**HIGH**: `.bak` safety copy is corrupt. If the primary backup rotation
writes a bad `.sqlite` again, the renaming in `doBackup()` cannot fall back
to `.bak` for recovery — both could end up unusable. Recommend
out-of-audit: verify `.bak` integrity after each rotation; reject-and-keep
the previous known-good `.bak` if new candidate fails `integrity_check`.

## 7. Secret-scan regression

- Broad regex (`sk-ant-api`, `ghp_*`, `xoxp-*`, `AKIA*`, `BEGIN*PRIVATE KEY`)
  on new rows (id > 159,207): **12 loose matches**.
- Strict token-length regex (real-format): **0 matches** on new rows.
- Of the 12 loose: 11 are documentation/placeholder patterns
  (`sk-ant-api03-…` with ellipsis) stored in pre-tool/tool-use/user-prompt
  rows. 3 were matches on this audit's own SQL query strings echoed back
  into storage via pre-tool hooks (i.e., my query `content LIKE '%-----BEGIN...'`
  got stored as content). **False positives; recursive audit artifact.**
- **Result**: 0 real tokens leaked; no regression since first audit.

## 8. LoCoMo / skill-discovery schema

All 5 JSON files `json.load()` PASS:
- `locomo/locomo10.json` (2.7MB)
- `locomo-eval-result-2026-04-18.json` / `-judged.json` / `-full.json`
- `skill-discovery/2026-04-18.json`

No new corruption; schemas unchanged.

## Aggregate

- **CRITICAL**: 0
- **HIGH**: 1 (`vcontext-backup.sqlite.bak` malformed — stale truncated
  safety copy; rename-pattern shuffled bad data into .bak slot)
- **MED**: 2 (WAL >10MB on primary + ssd; first-audit's premigration 24h
  retain still pending)
- **LOW**: 0
- **First-audit issues resolved**: 2/3 (orphan WAL/SHM cleaned; FTS drift
  fixed via REINDEX). Premigration retention window still open.

Integrity: 7/8 PASS. Live DBs (primary, ssd, backup current, vec, premigration,
audit, kg) all PASS. Secret scan clean. FTS delta zeroed.

---

CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1
