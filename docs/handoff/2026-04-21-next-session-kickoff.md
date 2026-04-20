# Next-Session Kickoff — 2026-04-21

*User-approved plan from 2026-04-20 end of session. Start here.*

---

## Session-start ritual (5 min)

1. `infinite-skills` consult is automatic via UserPromptSubmit hook. Verify `skill-usage` entry exists this session.
2. Probe live services:
   ```
   curl -sS http://127.0.0.1:3150/health
   curl -sS http://127.0.0.1:3161/health
   curl -sS http://127.0.0.1:3163/proxy/health
   ```
   Expected: all 200, vcontext <10ms, mlx-embed <10ms, proxy <10ms.
3. Check overnight stability:
   ```
   grep "exited with code 137" /tmp/vcontext-server.log | tail -5
   pgrep -lf 'sqlite3.*primary'    # should be empty
   ls -la ~/skills/data/vcontext-primary.sqlite-wal
   ```
   WAL should be < 500 MB. Zero long-running sqlite3.
4. If anything above is off, pause and investigate BEFORE starting new work.

---

## Priority 1 — Stage 2: `POST /admin/integrity-check` (1-2h)

**Spec**: `docs/specs/2026-04-20-true-loose-coupling-redesign.md` §Stage 2.

**Why first**: Yesterday's bandaid (`cmdIntegrity` → backup copy) has a race
when backup file is mid-write. Server-internal endpoint eliminates this +
gives us rate-limiting + observability via stored events.

**Steps**:
1. Read `vcontext-server.js` routing block — find where `/admin/*` endpoints
   land. Note auth pattern (`X-Vcontext-Admin` header + bearer).
2. Add handler `handleAdminIntegrityCheck(req, res)`:
   - Accepts body `{ target?: "primary" | "backup" }` (default "backup")
   - For target=backup: spawns `sqlite3 BACKUP_PATH 'PRAGMA integrity_check;'` with timeout
   - For target=primary: uses `ramDb.pragma('integrity_check')` — SAME connection, no external lock
   - Returns `{ status, target, result, duration_ms, ran_at }`
   - Rate-limit: 1/hour per target (in-memory last-run Map)
   - Stores result as entry `type=admin-op detail="integrity"` for dashboard visibility
3. Update `scripts/vcontext-maintenance.sh`:
   - Replace `if ! "$NODE" "$HOOK" integrity >> "$LOG" 2>&1; then` block
     with `curl -sS -X POST ... /admin/integrity-check`
   - Parse JSON response; log + continue even on "fail" status
4. Update `docs/schemas/vcontext-api-v1.yaml` — add the endpoint schema
5. Commit + push
6. Wait 1 maintenance cycle, verify `grep /admin/integrity /tmp/vcontext-maintenance.log` shows the call

**Accept criteria**:
- ✅ No sqlite3 process spawned by maintenance cycle for integrity check
- ✅ Endpoint returns in < 30s for "backup" target on current DB
- ✅ Result visible in dashboard / `/recent?type=admin-op`

---

## Priority 2 — Review-agent LOW cleanup (20-30 min, light work)

Single commit. No urgency. Good for tired-brain moments.

- `scripts/vcontext-server.js:3607` — `syncEmbeddingsToSsd(100)` drops the arg. Either remove `100` or add `batchSize` param to the function signature.
- `scripts/vcontext-server.js:3480-3534` — embed-loop: if `_mlxEmbedBatchRaw` returns mismatched array length, neither success nor `batchFailed=true` fires. Add `else if (!embeddings || embeddings.length !== rows.length) { batchFailed = true; }` before the final `await yieldToEventLoop()`.
- `scripts/vcontext-watchdog.sh:266,286,331` — `$((SEARXNG_CHECK_COUNTER % 1))` is always 0. Replace with `true` or remove the guard entirely.
- `scripts/vcontext-watchdog.sh:252` — `PRAGMA wal_checkpoint` still targets `/Volumes/VContext/vcontext.db` (retired RAM-disk path). Gate on `USE_RAMDISK` env or remove.
- `scripts/vcontext-maintenance.sh:38-41` — integrity exit-1 branch is dead after 2138ef6. Remove or make cmdIntegrity exit non-zero on genuine failure (design choice — match to the Stage 2 redesign's intent).
- `scripts/test-aios-gate.sh` — tests (b/e/f) expect BLOCK even when server is down, but hooks-gate.mts correctly fail-opens. Add `/health=200` precondition at test start or seed the cache.

---

## Priority 3 — Stage 3: `POST /admin/backup` (half day)

**Trigger**: Stage 2 lands and bakes for a few hours without surprise.

**Spec**: `docs/specs/2026-04-20-true-loose-coupling-redesign.md` §Stage 3.

**Deliverables**:
- `POST /admin/backup` endpoint in server.js (uses `ramDb.backup(tmpPath)` — already exists in doBackup)
- `scripts/vcontext-backup.sh` → 15 lines of curl. No more sqlite3 CLI.
- `cleanupBackupTmp` + `BACKUP_TIMEOUT_S` + `wait $SQLITE_PID || true` all become obsolete — can't-zombie-a-request-over-HTTP.

---

## Priority 4 — Stage 4: WAL checkpoint endpoint + scripts sweep (1-2h)

**Deliverables**:
- `POST /admin/wal-checkpoint` endpoint
- Repo-wide `grep -r 'sqlite3.*primary\.sqlite' scripts/` → must return empty
- `pgrep -lf 'sqlite3.*primary'` check passes 24h uptime

---

## Deferred (don't start unless explicit user go)

- **TS Phase 2** — `hooks-util.mts` extraction per `docs/specs/2026-04-20-ts-strict-migration-plan.md`. H3 decision. Only if Phase 1 has been stable ≥ 1 day.
- **Port 3162 → proxy alias flip** (proxy Phase B). Only after proxy has 24h uptime with no restarts.
- **Bun drop-in smoke test** — after TS Phase 2 lands.
- **Worker-thread SQLite refactor** — multi-day. Triggered only when Stage 1-4 all land and /stats /recall latency still exceeds 2s during maintenance.
- **M21 roundtrip investigation** — when server stable, take time to trace why write-then-recall returns empty.
- **Dead-letter drain** (`scripts/vcontext-drain-deadletter.sh`) — 4,069 lost writes. Run ONLY after `curl /health` has been green for > 10 min consecutively.

---

## What NOT to do

- Don't commit without `INFINITE_SKILLS_OK=1 CHECKER_VERIFIED=1` prefix (autonomous-commit-gate)
- Don't touch Qwen3.6-35B — registered in `docs/roadmap/model-candidates.md` as deferred, memory budget doesn't fit today
- Don't run `PRAGMA integrity_check` against live primary.sqlite from an external process — that's the bug we're eliminating
- Don't re-attempt APFS `cp -c` for backup without a helper that holds `BEGIN IMMEDIATE` during clone — see `scripts/vcontext-backup.sh` header comment
- Don't tighten watchdog restart policy — cold-boot-grace 180s + no-force-restart by default is the safe shape after today's cascade

---

## Artifacts from 2026-04-20 (session context)

- `docs/principles/AIOS-CONSTITUTION.md` — 4 axioms + 6 principles + HITL tiers
- `docs/specs/2026-04-20-true-loose-coupling-redesign.md` — Stage 1-4 spec
- `docs/specs/2026-04-20-ts-strict-migration-plan.md` — 7-phase TS plan
- `docs/specs/2026-04-20-mlx-lazy-load-proxy.md` — proxy spec
- `docs/schemas/vcontext-api-v1.yaml` — OpenAPI 3.1, 75 endpoints
- `docs/analysis/2026-04-20-server-instability-diagnosis.md` — root-cause doc (corrected mid-session)
- `docs/analysis/2026-04-20-stability-research-refs.md` — external reading list
- `docs/analysis/2026-04-20-aios-morning-3-bugs.md` — morning fixes
- `docs/runbooks/hooks-phase1-rollback.md` — < 30 s rollback
- `docs/roadmap/model-candidates.md` — Qwen3.6 deferred

---

## 2026-04-20 lessons (for whoever picks this up)

1. **"Dramatic narrative" warning**: I wrote a "36 GB memory ceiling" diagnosis that sounded crisp and was WRONG. User's "36 GB もあるし…" correction saved the session. Check whether each "root cause" is actually evidenced, not just plausible.
2. **Process separation ≠ loose coupling**: today's backup extraction moved doBackup out of the event loop (real win) but kept sqlite3-CLI-on-primary (hidden shared-resource coupling that caused the 3 GB WAL). Contract-first = HTTP + JSON, not file locks.
3. **investigate-first is not a solo discipline**: AI alone can pattern-match onto wrong hypotheses. User push-back was the feedback loop that kept us honest. Constitution §P6 only works when there's someone to say "違う".
4. **Today ended responsive**: after clean restart, /health 0.8-1.3 ms, WAL 2 MB stable, all four endpoints 200. The bandaid works for now — Stage 2 is the real fix.

---

*Wrote 2026-04-20 end-of-session. When you read this, the plan is approved; just execute top-to-bottom. If stability is off from the session-start ritual, pause and investigate first.*
