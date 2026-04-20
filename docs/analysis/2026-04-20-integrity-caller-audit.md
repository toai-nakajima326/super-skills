# Integrity / lock-holding caller audit — 2026-04-20

**Scope**: every process that opens `vcontext-primary.sqlite` (or its historical
RAM-era path `/Volumes/VContext/vcontext.db`), holds a read-snapshot, runs
`PRAGMA integrity_check`, or does `VACUUM/ANALYZE/.backup/.recover` against it
from outside the server's singleton `ramDb` connection.

**Hard-gate invariant (per spec 2026-04-20-true-loose-coupling-redesign.md §1)**:
the server owns primary exclusively. Any script or Node function that opens
primary with a fresh connection — even readonly — holds a WAL snapshot that
prevents `wal_autocheckpoint(TRUNCATE)`, the exact mechanism behind today's
3 GB WAL bloat.

**Headline finding**: main session flagged 3 callers. Audit found **20 distinct
call sites** across 9 files, plus 4 unexpected classes of coupling (VACUUM
from external shell, RAM-disk-path zombies, FTS diagnostics in QA skill,
`.recover` spawning two CLI processes back-to-back).

**Runtime note**: `/Volumes/VContext` is NOT mounted (verified 2026-04-20
15:03 JST — no `/Volumes/VContext` directory exists). Every script targeting
`/Volumes/VContext/vcontext.db` therefore fails silently (suppressed by
`2>/dev/null`). They are latent bugs that will re-animate the instant
anyone remounts the RAM disk or sets `VCONTEXT_USE_RAMDISK=1`.

---

## Inventory (20 callers found across 9 files)

| # | file:line | function / call context | class | fires on |
|---|-----------|-------------------------|-------|----------|
| 1 | vcontext-server.js:882 | `verifyBackupFile()` → `dbQuery('PRAGMA integrity_check;', path)` | A | backup cycle (every 15 min) — but path is BACKUP file, not primary |
| 2 | vcontext-server.js:319 | `checkAndRecoverDb()` → `new Database(dbPath, readonly)` + `quick_check` | C | startup only |
| 3 | vcontext-server.js:346 | `checkAndRecoverDb()` → `execSync('sqlite3 "$dbPath" ".recover" | sqlite3 …')` | **B** | startup, ONLY when quick_check failed |
| 4 | vcontext-server.js:395 | `checkAndRecoverDb()` → `new Database(dbPath)` (write-mode merge) | C | startup, corruption recovery only |
| 5 | vcontext-server.js:461/492 | `dbExec`/`dbQuery` fallback → `new Database(dbPath)` for unknown paths | C | any runtime call with path ≠ DB_PATH/SSD_DB_PATH |
| 6 | vcontext-server.js:956 / 7663 | backup/admin-backup → `new Database(tmpPath)` post-`ramDb.backup()` to truncate WAL on tmp | C | backup cycle + `/admin/backup` |
| 7 | vcontext-server.js:6806–6815 | `/admin/verify-snapshot` → `new Database(fullPath, readonly)` + `integrity_check` | C | admin verify-snapshot endpoint (on-demand + maintenance.sh:66) — **against snapshots, not primary** |
| 8 | vcontext-server.js:6748 | `/admin/auto-audit` meta-checker → `spawnSync('sqlite3', [vcontext-audit.db, …])` | B | admin auto-audit endpoint — **audit DB, not primary** |
| 9 | vcontext-server.js:7805–7818 | `/admin/integrity-check` → `spawnSync('sqlite3', [backupPath, integrity_check/quick_check])` | B | maintenance.sh POSTs hourly — **backup path, not primary** |
| 10 | vcontext-hooks.js:156/183/240/267/281/299/461/485/726/823/1056/2288 | 12 separate `spawnSync('sqlite3', [VCTX_RAM_DB, …])` sites: metrics / policy-check / secret-scan / tier-balance / route-table / skill-deps / synthesis / self-test integrity / gc dry-run | **B** | cmdMetrics (maintenance); self-test (maintenance); policy-check (maintenance); buildRouteTable (every hook entry!); cmdGc (maintenance) |
| 11 | vcontext-hooks.js:2316 | `cmdGc` → `sqliteExec(VCTX_RAM_DB, 'VACUUM;')` | **B** | every maintenance GC cycle |
| 12 | vcontext-hooks.js:2366/2369–2370 | `cmdIntegrity` → `spawnSync('sqlite3', [target, 'integrity_check/quick_check'])` where `target = backupPath ?: VCTX_RAM_DB` (fallback) | B | `node vcontext-hooks.js integrity` manual; fallback to primary if backup missing |
| 13 | vcontext-hooks.js:2408 | `cmdSnapshot` → `spawnSync('sqlite3', [VCTX_RAM_DB, '.backup'])` | **B** | daily snapshot via maintenance.sh `$NODE $HOOK snapshot daily` |
| 14 | vcontext-maintenance.sh:137–149 | `for DB in $DB_RAM $DB_SSD` → `sqlite3 "$DB" "CREATE INDEX …; ANALYZE;"` | **D** | every maintenance cycle (hourly at :45) — DB_RAM targets dead `/Volumes/VContext/vcontext.db` |
| 15 | vcontext-maintenance.sh:156 | weekly `sqlite3 "$DB" "VACUUM;"` on DB_RAM + DB_SSD | **D** | Sundays, same dead-path problem |
| 16 | vcontext-maintenance.sh:167–168, 201–206 | 6 × `sqlite3 "$DB_RAM" "SELECT …"` for perf regression + evolution-log stats | **D** | every maintenance cycle — dead path returns empty, perf regression noise |
| 17 | vcontext-watchdog.sh:252 / 256 | `sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(…)"` (TRUNCATE at ≥95%, PASSIVE at ≥85%) | **D** | watchdog every cycle when RAM used pct triggers — dead path, no-op |
| 18 | pre-outage.sh:63/69/77/86–87 | `sqlite3 "$RAM_DB" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA quick_check; SELECT MAX(id) …"` | **D** | manual pre-outage run only |
| 19 | vcontext-self-improve.sh:19/26/35 | `sqlite3 "$RAM_DB" "SELECT … FROM entries / api_metrics"` | **D** | self-improve loop (called from maintenance.sh:260) |
| 20 | vcontext-abtest.sh:24–27 | `sqlite3 "$RAM_DB" "SELECT AVG(latency_ms) FROM api_metrics …"` | **D** | manual A/B runs + scripts/experiment-thinking-skip.sh:19 |

**Plus**: `vcontext-setup.sh` (lines 41, 118, 124, 221, 260–272) — sqlite3 init/restore/backup/stats against `${DB_PATH}` (resolves to primary in SSD mode). Class **D**, fires only on `vcontext-setup.sh start/stop/status` manual invocation. Lowest risk — no background caller.

---

## Detail + fix proposal per caller

### 1. vcontext-server.js:882  `verifyBackupFile() → dbQuery('PRAGMA integrity_check;', path)`
```js
function verifyBackupFile(path) {
  try {
    if (!existsSync(path)) return false;
    const rows = dbQuery('PRAGMA integrity_check;', path);
    return !!(rows && rows[0] && rows[0].integrity_check === 'ok');
  } catch { return false; }
}
```
**Class**: C (when `path === DB_PATH`) / A (when `path !== DB_PATH`, falls through to server's dbQuery fallback which opens a temp connection).
**Fires**: doBackup() (every 15 min from backup LaunchAgent-triggered /admin/backup), verifies tmp + .bak paths — NOT primary. The path parameter in practice is always `BACKUP_PATH` or `BACKUP_PATH + '.tmp'`.
**Risk**: LOW. dbQuery at L487–497 opens a transient `new Database(path, readonly)` that closes immediately. The snapshot window is <10 ms for the backup file (6 GB but read-only open is O(1)). Does NOT touch primary.
**Fix**: none required. Doc-comment that `path` MUST never be DB_PATH — add an `assert(path !== DB_PATH)` defensive check.

### 2. vcontext-server.js:319  `checkAndRecoverDb() → new Database(dbPath, readonly)`
```js
const db = new Database(dbPath, { readonly: true });
try {
  const r = db.prepare('PRAGMA quick_check').get();
  const result = r.quick_check || r.integrity_check;
  if (result !== 'ok') throw new Error(`integrity: ${result}`);
  return true;
} finally { db.close(); }
```
**Class**: C (same process as ramDb will be, but `ramDb` doesn't exist yet — it's called from `openDatabases()` L430 before `ramDb = new Database(DB_PATH)`).
**Fires**: startup only, once per process.
**Risk**: LOW (singleton, ephemeral) but still a second connection during server boot. On a healthy DB quick_check completes in <1s. The read-snapshot is released on `db.close()` at L329.
**Fix**: keep. This is pre-ramDb so there's no alternative. Document that it must close before `ramDb` opens.

### 3. vcontext-server.js:346  `execSync('sqlite3 … .recover | sqlite3 …')`
```js
execSync(`sqlite3 "${dbPath}" ".recover" | sqlite3 "${salvageFile}"`, {
  timeout: 120000,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: '/bin/bash'
});
```
**Class**: **B** — spawns TWO `sqlite3` CLI processes, the first holds a read-snapshot on corrupt `dbPath` (= `DB_PATH` = primary).
**Fires**: startup, ONLY when quick_check at L325 failed. Never in normal ops.
**Risk**: ZERO during normal ops, MEDIUM during recovery (timeout 120 s — one-off, not recurring). Primary is being restored from snapshot, not actively written.
**Fix**: keep — this is emergency recovery and primary is by definition already corrupt. Server hasn't bound yet so there's no WAL-bloat race.

### 4. vcontext-server.js:395  `new Database(dbPath)` (recovery merge)
**Class**: C, same recovery path as #3.
**Fires**: startup corruption path only.
**Risk**: ZERO — recovery write path, server not yet online.
**Fix**: keep.

### 5. vcontext-server.js:461 / 492  `dbExec/dbQuery` fallback `new Database(dbPath)`
```js
if (!db) {
  const tmpDb = new Database(dbPath, { readonly: true });  // L492
  try { return tmpDb.prepare(sql).all(); } finally { tmpDb.close(); }
}
```
**Class**: C (ephemeral).
**Fires**: any dbQuery/dbExec with `path !== DB_PATH && path !== SSD_DB_PATH`. Only #1 uses this path; all other callers pass DB_PATH → resolve to ramDb singleton.
**Risk**: LOW (only hit by backup-path queries; <10 ms window).
**Fix**: add `if (dbPath === DB_PATH) { /* bug */ throw }` guard. Protects against future mistakes.

### 6. vcontext-server.js:956 / 7663  `new Database(tmpPath)` WAL truncate
```js
try {
  const tmpDb = new Database(tmpPath);
  tmpDb.pragma('wal_checkpoint(TRUNCATE)');
  tmpDb.close();
} catch {}
```
**Class**: C — but `tmpPath === BACKUP_PATH + '.tmp'`, NEVER primary.
**Fires**: backup cycle post-`ramDb.backup()` + admin-backup endpoint.
**Risk**: ZERO for primary; fixes the orphan-WAL-28GB bug documented at L908–915.
**Fix**: keep.

### 7. vcontext-server.js:6806  `/admin/verify-snapshot`
```js
const probe = new Database(fullPath, { readonly: true });
try {
  const ok = probe.prepare('PRAGMA integrity_check').get();
  integrity = ok.integrity_check === 'ok' ? 'ok' : ok.integrity_check;
  const cnt = probe.prepare('SELECT COUNT(*) as c FROM entries').get();
```
**Class**: C. `fullPath` iterates `BACKUP_DIR/snapshots/*.db` — never primary.
**Fires**: maintenance.sh:66 (hourly) + manual.
**Risk**: LOW. Snapshots are static files; `new Database(..., readonly)` scopes a snapshot to this request. 10 snapshots × ~2s integrity_check each on a 6 GB snapshot = ~20s total. These all run sequentially INSIDE the server's Node process → same event loop → BLOCKS the server. THIS is the event-loop stall the spec mentions at §1 "observed 1h 59m" (plausibly verify-snapshot on a bad day).
**Fix**: **HIGH PRIORITY**. Move this loop to a worker thread or break into async chunks. Snapshots being readonly doesn't matter — integrity_check is CPU-bound.

### 8. vcontext-server.js:6748  `spawnSync('sqlite3', [vcontext-audit.db, …])`
**Class**: B. Targets `BACKUP_DIR/vcontext-audit.db` (a SEPARATE DB), not primary.
**Fires**: /admin/auto-audit endpoint (on-demand).
**Risk**: ZERO for primary. Audit DB is tiny and lockless.
**Fix**: could inline via a dedicated better-sqlite3 handle for audit.db. Cosmetic, not urgent.

### 9. vcontext-server.js:7805  Stage-2 `/admin/integrity-check`
```js
const r = spawnSync('sqlite3', [backupPath, pragma], {
  encoding: 'utf-8',
  timeout: 10 * 60 * 1000,
  killSignal: 'SIGKILL',
});
```
**Class**: B. `backupPath` = `vcontext-backup.sqlite` — NOT primary.
**Fires**: maintenance.sh POSTs hourly at :45 via HTTP.
**Risk**: LOW for primary (backup file is a separate file, no lock on primary). BUT: the Stage-2 endpoint has a subtle issue — the spawned `sqlite3` holds a 10-min snapshot on the BACKUP file while the next backup cycle may try to overwrite it. Existing guard at L7795 (`ext-tmp` check) addresses this — good.
**Fix**: none urgent. Long-term: replace with an in-process connection (`new Database(backupPath, {readonly: true})`) to avoid the CLI spawn cost entirely. ~15-line change.

### 10. vcontext-hooks.js — twelve `spawnSync('sqlite3', [VCTX_RAM_DB, …])` sites
Representative: L2288 (cmdGc expiry scan):
```js
const q = `SELECT COUNT(*), COALESCE(SUM(LENGTH(embedding)),0) FROM entries WHERE type='${type}' AND embedding IS NOT NULL AND created_at < datetime('now','-${EMBEDDING_PRUNE_DAYS} days');`;
const r = spawnSync('sqlite3', ['-separator', '│', VCTX_RAM_DB, q], { encoding: 'utf-8' });
```
All 12 share the pattern. `VCTX_RAM_DB` resolves via L2176: `process.env.VCONTEXT_DB_PATH || (USE_RAMDISK ? '/Volumes/…' : primary.sqlite)` → **primary.sqlite**.
**Class**: **B** — external CLI process, holds read-snapshot on primary for the query duration (typically 10–200 ms, but on large scans could be seconds).
**Fires (sorted by risk)**:
  - L1056 `cmdSelfTest` integrity — maintenance.sh (hourly) + 10-min `integrity_check` read cursor. **HIGH**
  - L461 `buildRouteTable` — EVERY hook entry point that calls `routeSkills()` (user prompt submit, tool use hook). Runs dozens of times per active session. **HIGH**
  - L485 second buildRouteTable block — same as above
  - L1063 self-test audit-log probe — maintenance.sh hourly (audit DB, not primary — LOWER risk)
  - L156/183/240/267/281/299 `cmdMetrics` + `cmdPolicyCheck` — maintenance.sh hourly, multiple scans. **MED** (short queries, but 6 sequential spawns per cycle)
  - L726 `cmdSynthesize` — weekly, low freq
  - L823 `cmdSkillDeps` — on-demand
  - L2288 `cmdGc` — maintenance.sh hourly. **MED**
**Risk**: **HIGHEST** in the audit. `buildRouteTable` fires on every hook — if a session sends 100 tool uses in a minute, that's 200 sqlite3 CLI spawns × read-snapshot holds on primary. Even if each is fast, they cumulatively starve wal_checkpoint.
**Fix**: **HIGH PRIORITY**. Option A — the hook process opens its own `better-sqlite3` singleton on primary (readonly) once at module-load and reuses it. Still a second connection but no per-call fork/exec. Option B (preferred, Stage 4.5) — add new server endpoints:
  - `GET /admin/route-table` → returns cached skill-registry rows
  - `GET /admin/metrics?window=1h` → returns counts
  - `POST /admin/gc/dry-run` → returns prune candidates
  Then hooks become pure HTTP clients. ~200 lines change, distributes across 6-8 endpoints. This is the CLASS B → Stage-4-style conversion the spec anticipates at §"Stage 4 polish".

### 11. vcontext-hooks.js:2316  `sqliteExec(VCTX_RAM_DB, 'VACUUM;')`
```js
if (!dryRun && (migrated > 0 || totalEmbedFreed > 0)) {
  sqliteExec(VCTX_RAM_DB, `VACUUM;`);
```
**Class**: **B**. sqliteExec helper at L2187 is `spawnSync('sqlite3', [db, sql])`. VACUUM on primary holds an EXCLUSIVE lock and rewrites the entire file (6.5 GB). Has been running HOURLY from maintenance.sh → cmdGc.
**Fires**: every maintenance GC cycle where migrated>0 or embed_freed>0 — so effectively hourly.
**Risk**: **CRITICAL**. VACUUM is strictly worse than integrity_check — it takes an EXCLUSIVE lock, not just a snapshot. Server writes block entirely for the duration. On a 6.5 GB DB a VACUUM is 30-120 seconds of server freeze. Unclear why this hasn't surfaced as a "server hung" incident — possibly the `migrated>0` gate rarely triggers. **Verify via grep of /tmp/vcontext-maintenance.log for "VACUUM" timestamps.**
**Fix**: **URGENT**. Remove the VACUUM entirely (server's internal auto-vacuum + periodic FTS rebuild at server.js:7985/8030 handles reclamation), OR redirect to new endpoint `POST /admin/vacuum` that uses `ramDb.exec('VACUUM;')` on the server's own connection. Cannot happen hourly regardless — VACUUM is a weekly-at-most operation.

### 12. vcontext-hooks.js:2366  `cmdIntegrity` fallback to primary
Already documented in the script (L2354 `target = backupPath ?: VCTX_RAM_DB`). Primary fallback only when backup missing (first boot).
**Class**: B.
**Fires**: manual `node vcontext-hooks.js integrity` only after Stage 2 removed it from maintenance.sh.
**Risk**: LOW in practice.
**Fix**: kept for emergency debug. Add a comment "DO NOT use in production loops".

### 13. vcontext-hooks.js:2408  `cmdSnapshot` → `.backup`
```js
const r = spawnSync('sqlite3', [VCTX_RAM_DB, `.backup '${dst}'`], { encoding: 'utf-8' });
```
**Class**: **B**. `.backup` holds a read-snapshot on primary for the entire copy duration (60-120 s on a 6.5 GB DB).
**Fires**: `$NODE $HOOK snapshot daily` from maintenance.sh:111, once per day when SNAP_MARKER absent.
**Risk**: **HIGH**. Same failure mode as the integrity_check — 60-120 s of snapshot = 60-120 s of WAL-bloat window. This is the SECOND path still shelling out `.backup` on primary (first was backup.sh, replaced in Stage 3b). **Missed by main session.**
**Fix**: replace with `POST /admin/snapshot` or reuse `POST /admin/backup` with a `snapshot_label` param. The server's `ramDb.backup()` is page-incremental and cooperates with WAL. Stage 4-adjacent work; independent of 3b.

### 14. vcontext-maintenance.sh:137–149  auto-tune
```bash
DB_RAM="/Volumes/VContext/vcontext.db"
DB_SSD="$HOME/skills/data/vcontext-ssd.db"
for DB in "$DB_RAM" "$DB_SSD"; do
  [ -f "$DB" ] || continue    # DB_RAM fails this because /Volumes/VContext doesn't exist
  sqlite3 "$DB" "CREATE INDEX IF NOT EXISTS …; … ANALYZE;"
done
```
**Class**: **D** — external sqlite3 CLI from shell, separate process from server.
**Fires**: every maintenance cycle (hourly at :45).
**Risk**: HIGH-if-path-resolved-correctly, **ZERO today because `/Volumes/VContext/vcontext.db` doesn't exist** — the `[ -f "$DB" ] || continue` gate skips it. **But**: this is a booby trap. The moment the RAM disk is remounted (or `VCONTEXT_USE_RAMDISK=1` is set and setup.sh runs), this script will hit primary with CREATE INDEX + ANALYZE every hour. ANALYZE takes an exclusive write lock briefly; running CREATE INDEX IF NOT EXISTS is idempotent but still writes a transaction.
**Fix**: replace DB_RAM with `"$HOME/skills/data/vcontext-primary.sqlite"` — BUT even with the right path, this script MUST stop hitting primary. Options:
  - Replace with `POST /admin/auto-tune` that runs the same SQL via ramDb.
  - Or drop entirely: server's migrate functions already ensure these indexes on every startup.

### 15. vcontext-maintenance.sh:156  weekly VACUUM
```bash
sqlite3 "$DB" "VACUUM;" 2>/dev/null
```
**Class**: **D**.
**Fires**: Sundays weekly, NEXT Sunday is 2026-04-26.
**Risk**: **CRITICAL** if it runs against primary — VACUUM-EXCLUSIVE-lock for minutes. Dead path today (same /Volumes/VContext check), will activate when path is fixed.
**Fix**: drop entirely from the shell script. VACUUM must only be initiated by the server (via new `/admin/vacuum` or the existing server-side VACUUM at vcontext-server.js:7985/8030 for admin-dedup-migration which itself should be reviewed — those are within an admin endpoint, rate-limit enforced).

### 16. vcontext-maintenance.sh:167–168, 201–206  perf-regression + evolution-log stats
```bash
CURRENT_PERF=$(sqlite3 "$DB_RAM" "SELECT operation, ROUND(AVG(latency_ms),0) FROM api_metrics …")
BASELINE_PERF=$(sqlite3 "$DB_RAM" "SELECT … FROM api_metrics …")
…
DISCOVERY_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-discovery' …")
SUGGESTION_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-suggestion' …")
CREATED_COUNT=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE type='skill-created' …")
EMBED_TOTAL=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries;")
EMBED_DONE=$(sqlite3 "$DB_RAM" "SELECT COUNT(*) FROM entries WHERE embedding IS NOT NULL;")
SESSIONS=$(sqlite3 "$DB_RAM" "SELECT COUNT(DISTINCT session) FROM entries WHERE created_at >= datetime('now','-24 hours');")
```
**Class**: **D**. 8 sqlite3 spawns per maintenance cycle, each holding a short snapshot.
**Fires**: hourly.
**Risk**: dead path today (returns empty → perf-regression loop emits no alerts, evolution-log shows "?"). ACTIVE if path gets corrected. 8 sequential snapshots × ~100 ms each = seconds of snapshot overlap.
**Fix**: replace with `GET /stats?window=1h` + `GET /stats?window=24h` — existing server endpoints already have these numbers. One HTTP call replaces 8 sqlite3 spawns.

### 17. vcontext-watchdog.sh:252 / 256  WAL checkpoint
```bash
sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null
…
sqlite3 /Volumes/VContext/vcontext.db "PRAGMA wal_checkpoint(PASSIVE);" 2>/dev/null
```
**Class**: **D**.
**Fires**: every watchdog cycle when `RAM_USED_PCT ≥ 85` / `≥ 95`. Dead path today — never actually runs.
**Risk**: would be **HIGH** if path resolved — external wal_checkpoint races with the server's own `wal_autocheckpoint(500)`. Could starve server's writer or return `-1 | -1 | -1` sentinel and log-spam.
**Fix**: replace with `curl -sS -X POST http://127.0.0.1:3150/admin/wal-checkpoint -d '{"mode":"TRUNCATE"}'` — the Stage-4 endpoint (already test-scaffolded at scripts/test-admin-wal-checkpoint.sh). **This is the watchdog caller spec §4 explicitly anticipates.**

### 18. pre-outage.sh:63/69/77/86–87
```bash
RAM_DB="/Volumes/VContext/vcontext.db"
…
if sqlite3 "$RAM_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null | grep -q '^0|'; then
…
r=$(sqlite3 "$db" "PRAGMA quick_check;" 2>&1 | head -1)
RAM_MAX=$(sqlite3 "$RAM_DB" "SELECT COALESCE(MAX(id),0) FROM entries;")
…
if cp "$RAM_DB" "$SNAP_PATH" 2>/dev/null; then
```
**Class**: **D**. 5 sqlite3 CLI calls + a `cp` on a potentially-WAL'd file (unsafe snapshot!).
**Fires**: manual `bash scripts/pre-outage.sh`. Dead path today.
**Risk**: LOW in practice (manual). If path is corrected: the `cp "$RAM_DB" "$SNAP_PATH"` at L103 is UNSAFE for a WAL-mode DB with pending pages — the copy could be inconsistent.
**Fix**: rewrite entirely as HTTP calls. `curl POST /admin/wal-checkpoint` + `curl POST /admin/integrity-check` + `curl POST /admin/backup` with label "pre-outage".

### 19. vcontext-self-improve.sh:19/26/35  regression analytics
3 sqlite3 SELECTs against `RAM_DB="/Volumes/VContext/vcontext.db"` for api_metrics analysis.
**Class**: **D**.
**Fires**: maintenance.sh:260 calls this hourly (non-fatal if errored). Dead path today → self-improve sees empty regression/slowest, exits quietly.
**Risk**: LOW in practice (exits at L20 when PENDING=0 which it always is with empty DB read). Will WAKE UP silently when path fixes.
**Fix**: replace with `GET /stats?window=1h`. Self-improve becomes HTTP-only.

### 20. vcontext-abtest.sh:24–27 + experiment-thinking-skip.sh:19
Manual A/B scripts reading api_metrics via `RAM_DB="/Volumes/VContext/vcontext.db"`.
**Class**: **D**.
**Fires**: manual only.
**Risk**: LOW (manual, dead path).
**Fix**: same as #19 — redirect to `/stats` endpoint.

---

## Unexpected classes of coupling (flagged)

**UC1. External VACUUM on primary (vcontext-hooks.js:2316)** — `sqliteExec(VCTX_RAM_DB, 'VACUUM;')` fires hourly from maintenance → cmdGc. VACUUM takes an EXCLUSIVE lock, not a snapshot. This is strictly worse than integrity_check and was NOT in the main session's 3-caller grep. **→ Fix before Stage 3b lands** — takes exactly one patch to comment out (VACUUM is not actually needed; server-side sqlite auto-vacuum handles it).

**UC2. External daily `.backup` on primary (vcontext-hooks.js:2408)** — `sqlite3 primary.sqlite '.backup dst'` holds a read-snapshot for ~90s every day. Runs from `$NODE $HOOK snapshot daily`. Main session believed backup path was closed by Stage 3b; `.backup` from hooks.js is a second, overlooked path.

**UC3. /admin/verify-snapshot event-loop stall (vcontext-server.js:6806)** — integrity_check loop over 10 snapshot files runs INLINE in the Node event loop. On a bad day this alone can freeze the server for 10-20 s. Not a primary-file coupling bug but a blocking-I/O bug in the server itself. **Flag for a separate spec — this is not the integrity audit's scope but is close-adjacent.**

**UC4. Dead-path booby traps** — 7 callers target `/Volumes/VContext/vcontext.db`, which doesn't exist post-SSD-migration. They silently return empty strings, suppressing via `2>/dev/null`. Right now they're no-ops. The moment `VCONTEXT_USE_RAMDISK=1` is flipped (or the RAM disk is remounted for testing), they ALL re-activate and start holding snapshots on primary. **These are not Stage-3b blockers but they're the highest-priority Stage 4 / 4.5 cleanup.**

**UC5. skills/comprehensive-qa/SKILL.md:401–406** — a QA rehearsal snippet instructs the reader to `new Database('/Volumes/VContext/vcontext.db', { readonly: true })` + `PRAGMA integrity_check` from an ad-hoc `node -e` one-liner. This is documentation, not running code, but if anyone follows it they open a second connection on primary. Doc-update only; trivial.

---

## Stage 4.5 impact assessment

| # | Independent of Stage 3b? | Est. LOC change | Risk if deferred |
|---|--------------------------|-----------------|------------------|
| 10 (hooks × 12) | YES (hooks.js is independent surface) | ~200 | HIGHEST — `buildRouteTable` fires per-hook |
| 11 (hooks VACUUM) | YES | ~3 (delete) | CRITICAL — hourly EXCLUSIVE lock |
| 13 (hooks .backup) | YES | ~10 | HIGH — daily 90-s snapshot |
| 14–16 (maintenance.sh) | YES | ~50 (shell→curl) | MED (booby trap; dead path today) |
| 17 (watchdog.sh) | NO — requires /admin/wal-checkpoint (Stage 4) | ~5 | MED (dead path today, wakes on RAM remount) |
| 18–20 (manual/self-improve/abtest) | YES | ~30 | LOW (manual or dead path) |
| 7 (verify-snapshot) | YES, SEPARATE bug | ~30 (worker thread or chunking) | MED — event loop stall |
| 9 (Stage-2 endpoint CLI→in-process) | YES | ~15 | LOW (cosmetic perf) |

**Total estimated diff**: ~350 lines across 6 files (vcontext-hooks.js dominates with 200 LOC; maintenance.sh 50; other 100). Could be landed in 3-4 commits of ~100 LOC each.

**Risk**: contained — each caller conversion is idempotent, testable against current server endpoints, and reverts as a single file.

---

## Recommendations (prioritized)

1. **UC1 / #11 — kill `sqliteExec(VCTX_RAM_DB, 'VACUUM;')` at vcontext-hooks.js:2316 IMMEDIATELY**. Single-line fix, blocks a hourly EXCLUSIVE lock that shouldn't exist. Independent of Stage 3b. **Do today.**

2. **#13 — replace `cmdSnapshot` `.backup` with `POST /admin/backup` w/ label**. Daily 90-s snapshot on primary is close to the 1h 59m stall root cause. **Do this week.**

3. **#10 — the 12 hooks.js CLI sites**. `buildRouteTable` alone is the highest-frequency caller in the entire audit (every hook entry). Two options:
   - Quick fix: singleton `new Database(VCTX_RAM_DB, { readonly: true })` at hooks module init, reused for all reads. Still CLASS C, but eliminates fork/exec overhead and shares the connection's WAL view. Zero new endpoints needed.
   - Proper fix: new server endpoints (route-table, metrics, gc-candidates, skill-deps). Bigger patch, better architecture per P1.
   Recommend quick fix first (this week), proper fix over 2 weeks.

4. **#14–16 maintenance.sh** — replace with `curl` calls to /stats and new /admin/auto-tune. Clean-up pass, not urgent (dead path today).

5. **#17 watchdog.sh** — redirect to `/admin/wal-checkpoint` once Stage 4 endpoint lands. Test scaffolding already exists at `scripts/test-admin-wal-checkpoint.sh`.

6. **UC3 / #7 verify-snapshot event-loop stall** — not part of this audit's primary scope but flag for a separate spec. Likely contributed to "server stalled" perceptions.

7. **Defensive hardening**: add `assert(path !== DB_PATH)` in `verifyBackupFile()` (#1) and in `dbQuery/dbExec` tmpDb fallback (#5) — prevents future primary-path regressions.

8. **Doc update**: comprehensive-qa SKILL.md (UC5) — point paths at `data/vcontext-primary.sqlite` and warn against opening primary directly.

---

*Audit performed 2026-04-20 16:00 JST. Evidence basis: grep across `scripts/`, `~/Library/LaunchAgents/*.plist`, `~/skills/skills/*`, and verified via `ls /Volumes/VContext` (absent) + `ls data/*.sqlite` (primary 6.5 GB, backup 6.5 GB, ssd 7.5 GB present). Not-modified-any-code invariant upheld.*
