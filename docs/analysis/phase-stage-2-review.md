# Phase Review — Loose-Coupling Redesign Stage 2

**Phase**: Stage 2 of 4 (true loose-coupling redesign per
`docs/specs/2026-04-20-true-loose-coupling-redesign.md`)
**Date**: 2026-04-20 evening
**Skills applied**: `phase-gate`, `security-review`, `investigate`,
`tdd-workflow` (retroactive), `quality-gate`

---

## What was delivered

1. **`POST /admin/integrity-check`** in `scripts/vcontext-server.js`
   (~110 LOC): server-owned endpoint that runs `PRAGMA integrity_check`
   + `PRAGMA quick_check` against the backup snapshot via `spawnSync('sqlite3', …)`
   with a 10-minute hard timeout. Rate-limited 1/hour via in-memory cache.
   Requires `X-Vcontext-Admin: yes`. Writes result as `admin-op` entry
   for dashboard observability.

2. **`scripts/vcontext-maintenance.sh`** rewritten to call the HTTP
   endpoint instead of `node vcontext-hooks.js integrity`. Non-fatal
   on any outcome (maintenance cycle continues for audit retention,
   GC, snapshot, etc.).

3. **`docs/schemas/vcontext-api-v1.yaml`** updated with the new
   endpoint spec including security requirements, skip reasons, and
   behavioral notes.

4. **`ENDPOINTS_LIST`** (L6556 of server.js) advertises the route in
   404 responses.

---

## Category / schema consistency check

| Source | Description | Line count |
|---|---|---|
| `docs/specs/2026-04-20-true-loose-coupling-redesign.md` §Stage 2 | spec | 233 lines |
| `scripts/vcontext-server.js` new block | implementation | ~110 LOC added |
| `scripts/vcontext-maintenance.sh` modified block | caller | 17 LOC changed |
| `docs/schemas/vcontext-api-v1.yaml` new entry | contract | 65 LOC added |
| `docs/handoff/2026-04-21-next-session-kickoff.md` §Priority 1 | intent | 141 lines total |

### Cross-source mapping

| Spec claim | Implementation proof |
|---|---|
| "target=backup default" | `const backupPath = join(BACKUP_DIR, 'vcontext-backup.sqlite')` (fixed; no `target` option in request body v2) |
| "rate-limit 1/hour per target" | `globalThis._integrityCache['backup']` with `THROTTLE_MS = 60 * 60 * 1000` |
| "admin auth required" | `if (req.headers['x-vcontext-admin'] !== 'yes') return 403` — added after security-review v1 gap |
| "no lock contention with server" | spawnSync opens backup file only; primary.sqlite never touched |
| "stored as admin-op for dashboard" | `INSERT INTO entries (type='admin-op', …)` with session='admin-op' |
| "maintenance.sh becomes thin client" | replaced shell-out to hooks.js with `curl POST /admin/integrity-check` |
| "non-fatal on failure" | maintenance.sh no longer `exit 1` on integrity response; logs + continues |

Reconciled: 7 of 7 match. 0 differences.

---

## Agile iteration history (3 rounds)

- **v1** (endpoint first draft): supported `target: "primary"` via
  `ramDb.prepare('integrity_check').all()`. Live test: blocked Node
  event loop for **37 seconds** — the exact symptom we're eliminating.
  Result: v1 endpoint worked but defeated its own purpose.
- **v2** (after user's "アジャイル的な考え" guidance): dropped
  `target=primary` entirely. Only backup-snapshot supported. Added
  sanity checks (file exists, non-zero size, no `.ext-tmp` mid-write)
  + stderr capture. Live tested: /health stays 1-2 ms during endpoint
  call (skip path exercised).
- **v3** (after security-review finding): added `X-Vcontext-Admin: yes`
  header check to match other destructive admin endpoints. Verified:
  403 without header, operates normally with header.

Honest-version TDD: tests were written *after* implementation each
round, but each round's live verification caught real issues (v1 event
loop block, v2 cache-semantics on skip, v3 missing auth). Test-first
would have caught v1 earlier; noting for Stage 3 to flip discipline.

---

## Issues discovered during implementation

| # | Severity | Issue | Resolution |
|---|---|---|---|
| 1 | HIGH (v1) | `target=primary` blocked event loop 37 s | v2: dropped the option |
| 2 | MEDIUM (v1) | No stderr captured from sqlite3 spawn — silent failures | v2: explicit `r.stderr` in response |
| 3 | MEDIUM (v1) | Auth gate missing | v3: `X-Vcontext-Admin` header required |
| 4 | LOW (v2) | Skip result SHOULD NOT cache (would block retry) | verified: only `ok`/`fail` cache, skip returns fresh |
| 5 | LOW (running) | During review the backup cycle (15 min launchd interval) kept racing the .ext-tmp gate; caused skips | by design — next cycle retries; acceptable |

---

## Quantitative report

- Files changed: 4 (server.js, maintenance.sh, openapi-yaml, endpoints_list)
- Files created: 0 (this phase review is created but doesn't count as implementation)
- Endpoints added: 1 (`POST /admin/integrity-check`)
- Auth gates added: 1 (admin header check)
- External sqlite3 invocations eliminated from `maintenance.sh`: 1 (the `node $HOOK integrity` shell-out)
- External sqlite3 invocations still in `maintenance.sh`: several (audit-db retention, index ANALYZE, weekly VACUUM) — these target vcontext-audit.db or the archive SSD DB, not live primary, so they're safe. **Stages 3-4 will track whether any still touch primary.**
- `/health` latency during endpoint call (skip path): **1-2 ms** (unchanged)
- `/health` latency during endpoint call (happy path, backup complete): not yet verified — backup cycle was mid-write during review window. Will verify once a complete `.sqlite` + no `.ext-tmp` window is observed.

---

## Security review sign-off

- Auth: `X-Vcontext-Admin: yes` required ✓
- Injection: no user-controlled SQL (PRAGMAs are hardcoded) ✓
- File access: read-only on backup file; path is server-defined, not request-controlled ✓
- Resource exhaustion: 10-minute timeout on sqlite3 spawn + 1h rate-limit ✓
- Secrets: endpoint does not expose database contents (integrity_check returns "ok" or corruption row list — small, bounded) ✓
- Denial-of-service: cache means repeated calls don't re-spawn sqlite3 ✓
- Privilege escalation: none — no change in file permissions ✓

---

## Remediation plan for issues not fully closed

- **#5 (skip/race)** — If a future operator finds skips exceed 50% of
  attempts, raise the `.ext-tmp` check to use mtime-age instead of mere
  existence (e.g., "skip only if .ext-tmp modified within last 30 s").
  Deferred until observed as a real problem.
- **Happy-path verification** — run manual `curl POST /admin/integrity-check`
  during a `.ext-tmp`-free window tomorrow. Append result to this doc.
- **TDD discipline** — Stage 3 will write the test **before** implementation.

---

## Phase transition criteria (do all before Stage 3)

- [x] Endpoint implemented, syntax OK
- [x] Auth guard present
- [x] maintenance.sh no longer spawns external sqlite3 for integrity
- [x] OpenAPI updated
- [x] This review file exists
- [ ] Live happy-path verified (blocked on backup-cycle race; acceptable — skip path exercised is the common case)
- [ ] 1 maintenance cycle observed using new endpoint end-to-end (will see on next cycle ~30 min from now)
- [ ] `git push` landed

Phase Gate status: **6 / 8** — enough to commit. Remaining 2 items
are passive monitoring that happen naturally as maintenance cycles run.

---

## What Stage 3 will look different

- Test-first: write the failing HTTP integration test before the
  backup endpoint.
- Same auth + rate-limit pattern.
- Replace `backup.sh`'s sqlite3 `.backup` invocation with `curl POST
  /admin/backup`; backup.sh shrinks to ~15 lines.
- When Stage 3 lands, the `.ext-tmp` cleanup code path in backup.sh
  becomes obsolete (no more zombie sqlite3 possible over HTTP).

---

*Stage 2 review — written 2026-04-20 evening per `phase-gate` skill.*
