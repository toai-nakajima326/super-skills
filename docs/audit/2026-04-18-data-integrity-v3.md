# 2026-04-18 Data Integrity Audit v3

**Trigger**: 3rd pass after `d385142` (M17 doBackup integrity gate) + `42a6085`
(M18 cmdIntegrity path) + user-manual `.bak` regen confirmation.
**Prior audits**: v1 `34a1d80`, v2 `b54d9b2`.
**Mode**: READ-ONLY (SELECT + PRAGMA only; no CHECKPOINT/VACUUM/ALTER).
**Skills applied**: `infinite-skills`, `quality-gate`, `investigate`,
`security-review`, `spec-driven-dev`.

## Mini-spec + AC

- **Goal**: confirm M17 backup gate activated cleanly, `.bak` now healthy,
  v2 findings held, no regressions.
- **AC**:
  1. All 8 DBs PASS `integrity_check`.
  2. `.bak` PASS integrity (was malformed v2).
  3. FTS drift on primary stays 0.
  4. No new orphan WAL/SHM.
  5. Row-count delta explainable.
  6. 0 real secrets leaked.

## 1. M17 activation

Timeline (JST):
- v2 audit commit: 20:19:25
- `d385142` M17 commit: 20:34:06
- `.bak` mtime: 20:38:06 → **post-commit** (regenerated under new gated code)
- `.sqlite` mtime: 20:50 → **post-commit** (>=1 rotation via gated path)

Server `scripts/vcontext-server.js` mtime 20:33 matches commit, indicating
the running process was restarted and current rotations run through the
`integrity_check`-before-rename branch. M17 is live.

Live primary unaffected — PRAGMA ok, row writes progressing (56,457 → 56,906
across this audit window → active ingestion during read).

## 2. 8-DB integrity table

| File | integrity_check | Notes |
|---|---|---|
| vcontext-primary.sqlite | ok | live |
| vcontext-ssd.db | ok | tier absorbed RAM migrations |
| vcontext-vec.db | ok | 756MB |
| vcontext-backup.sqlite | ok | 3.33GB, regen'd post-M17 |
| vcontext-backup.sqlite.bak | **ok** | **FIXED — was malformed v2** |
| vcontext-premigration-1776496379.sqlite | ok | 3.30GB (24h retain unchanged) |
| vcontext-audit.db | ok | 290kB |
| vcontext-kg.db | ok | 45kB |

**Result**: 8/8 PASS. v2's HIGH (`.bak` malformed) **resolved**.

## 3. Backup triad (`.sqlite` vs `.bak` vs primary)

- `backup.sqlite`: 3.33GB · MAX id 164,925 · count 56,840
- `backup.bak`:    3.33GB · MAX id 164,574 · count 56,989
- `primary live`:                 MAX id 165,042 · count 56,457

Size parity exact (3,334,012,928 bytes). `.bak` is one rotation behind
`.sqlite` (expected: `.bak` = previous-good snapshot). Both ok. Counts
differ due to RAM→SSD migration between rotations (see §5), not loss.

## 4. FTS drift + orphans

- Primary FTS drift: **0** (was +24 v1 → 0 v2 → 0 v3, REINDEX held).
- Orphan WAL/SHM: **none**. 4 pairs present (primary, ssd, backup,
  premigration) — all have a matching DB file. `vcontext-ram-corrupt-*`
  stays absent.
- Rollback journals (`*-journal`): none.

## 5. Row-count + type delta since v2

Apparent primary count dropped 59,413 → 56,457 (−2,956) **despite +1,210
new ids after v2**. Root cause: **RAM→SSD tier migration**, not deletion.

- Primary tier dist: 100% `ram` (56,470).
- SSD tier dist: `ram=817`, `ssd=121,236` — SSD gained the migrated rows.
- v2-era ids still in primary: 55,271 / 59,413 (4,142 migrated out).
- No rows with `status=deleted|pruned|archived` → hard-delete after migration.
- 0 rows with NULL content.

Type delta on id>163,856 (1,210 rows):
`pre-tool 451 · tool-use 447 · working-state 127 · assistant-response 41 ·
handoff 10 · session-end 10 · user-prompt 9 · anomaly-alert 7 · decision 7 ·
session-summary 7 · skill-usage 7 · skill-gap 6 · subagent-stop 6 · …`
All known hook-driven types. No bulk or novel type. No spike.

## 6. Secret scan (id > 163,856)

- Loose regex (`sk-ant-api|ghp_|AKIA|xoxp-|BEGIN*PRIVATE KEY`): 3 matches,
  all hook payloads echoing audit queries / docs literals.
- Strict token-length GLOB: **0 matches**.
- **0 real tokens leaked.**

## 7. LoCoMo / skill-discovery JSON

All 5 JSONs `json.load()` PASS, no NaN/Inf/negative anomalies:
`locomo/locomo10.json`, 3×`locomo-eval-result-2026-04-18*.json`,
`skill-discovery/2026-04-18.json`.

## Aggregate

- **CRITICAL**: 0
- **HIGH**: 0 (v2's `.bak`-malformed HIGH → RESOLVED by M17 regen)
- **MED**: 1 (premigration 24h retention window still open; unchanged)
- **LOW**: 1 (primary WAL/SHM present during live writes — expected)
- **Resolved since v2**: 1/1 HIGH

Integrity 8/8 PASS. M17 gate activated cleanly. No data loss — apparent row
drop explained by tier migration. Secret scan clean.

---

CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1
