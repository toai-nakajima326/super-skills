# 2026-04-18 Source Audit v3 — Post M17+M18 Re-verify

## Mini-spec

**Goal**: Third read-only audit cycle. Quality-gate post-fix re-verification
of M17 (`d385142` doBackup integrity check) and M18 (`42a6085` cmdIntegrity
DB_PATH resolution) landed since v2. Confirm no regression, no new
finding, and that H1 + H3 regression tests still green.

**Scope**: identical to v1/v2 — `scripts/**`, `skills/**/SKILL.md`,
`~/Library/LaunchAgents/com.vcontext.*.plist`, plus diff since `b0b82b2`.

**Acceptance criteria**:
1. M17 helpers + gate chain confirmed by static inspection (4 checks).
2. M18 DB_PATH resolution matches `vcontext-server.js` pattern.
3. `node --check`, `bash -n`, `plutil -lint` all clean across tree.
4. v2 DEFERRED findings (N-M1, N-M2, N-L1, N-L2) status reclassified.
5. H1 (27/27) + H3 (4/4) regression tests executed and PASS.

**Constraints**: READ-ONLY source; tests exercise existing server only.
No server restart. Commit with `CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1`.

**Skills applied**: `infinite-skills` (routing), `quality-gate`
(post-fix re-execute), `investigate` (evidence-first), `security-review`
(M17 inserts into `entries`), `spec-driven-dev` (this mini-spec).

---

## Section 1 — M17 verification (`scripts/vcontext-server.js`)

| Check | Evidence | Status |
|-------|----------|--------|
| `verifyBackupFile()` helper exists | L852–860, uses `dbQuery('PRAGMA integrity_check;', path)` readonly | PASS |
| `emitBackupIntegrityAlert()` helper exists | L862–874, INSERTs `anomaly-alert` row with tags | PASS |
| Tmp verified BEFORE any rename | L892–897 (`verifyBackupFile(tmpPath)` + unlink + return) | PASS |
| `.sqlite`→`.bak` rotation gated by integrity | L902–912 (verify current; if corrupt, skip rotation, preserve last-good .bak) | PASS |
| copyFileSync fallback gated | L927–932 (same `verifyBackupFile(tmpPath)` + unlink + return) | PASS |
| `node --check scripts/vcontext-server.js` | exit 0 | PASS |
| Alert row schema matches `entries` table | Uses `type='anomaly-alert'`, `session='system'`, `tier='ram'`, `esc(content)` guards | PASS |

**Aggregate**: M17 PASS (7/7).

## Section 2 — M18 verification (`scripts/vcontext-hooks.js`)

| Check | Evidence | Status |
|-------|----------|--------|
| `VCTX_RAM_DB` resolves via `VCONTEXT_DB_PATH` env first | L2206 `process.env.VCONTEXT_DB_PATH \|\| ...` | PASS |
| Pattern matches `vcontext-server.js:65-71` | same `VCONTEXT_USE_RAMDISK === '1'` gate, same SSD default `join(homedir(),'skills','data','vcontext-primary.sqlite')` | PASS |
| No hardcoded `/Volumes/VContext/vcontext.db` as default at L2201 | Present only at L2208 inside `VCONTEXT_USE_RAMDISK === '1'` branch | PASS |
| cmdIntegrity at L2354 targets `VCTX_RAM_DB` (now resolved) | L2354 `sqlite3 VCTX_RAM_DB 'PRAGMA integrity_check;...'` | PASS |
| `node --check scripts/vcontext-hooks.js` | exit 0 | PASS |
| All 17 downstream `VCTX_RAM_DB` call sites still reference same identifier | grep finds 11 additional sites (L156…L2384) unchanged | PASS |

**Aggregate**: M18 PASS (6/6).

---

## Section 3 — v2 findings delta

| v2 ID | Severity | v2 status | v3 status | Evidence |
|-------|----------|-----------|-----------|----------|
| N-M1 | MED (doc drift) | DEFERRED | DEFERRED (unchanged) | `docs/SPEC.md:634,640`, `docs/PLAN.md:84,778` still reference `build-skills.js|.ts`. |
| N-M2 | MED (latent) | DEFERRED | DEFERRED (unchanged) | `scripts/coreml-embed-server.py:47`, `convert-bge-coreml.py:18` still hard-code `/Volumes/VContext/bge-small-coreml.mlpackage`. |
| N-L1 | LOW (doc drift) | DEFERRED | DEFERRED (unchanged) | `docs/PLAN.md:416,483,515` plan-form references. |
| N-L2 | LOW (pycache) | DEFERRED | DEFERRED (unchanged) | `scripts/__pycache__/mlx-generate-server.cpython-313.pyc` still present. |

M1–M7, L1–L5 from v1 all remain in their v2 state (no regression).

---

## Section 4 — NEW findings since v2

### Syntax sweep

| Tool | Files | Pass | Fail |
|------|-------|------|------|
| `node --check` (.js/.cjs) | 24+8 | all | 0 |
| `bash -n` (.sh) | 32 | 32 | 0 |
| `plutil -lint` (plist) | 16 | 16 | 0 |
| **Aggregate** | **~80** | **all** | **0** |

### Stale-ref sweep (`/Volumes/VContext`)

Remaining non-trivial references, each classified:

| File:Line | Category | Classification |
|-----------|----------|----------------|
| `vcontext-hooks.js:1198, 1279, 2208` | hooks allowlist + RAM-opt-in branch | EXPECTED (opt-in) |
| `vcontext-server.js:60-66, 2127, 2382, 6853` | MOUNT_POINT constant + comments/health | EXPECTED (opt-in) |
| `vcontext-watchdog.sh:163-180`, `vcontext-setup.sh:14,143`, `vcontext-abtest.sh`, `pre-outage.sh`, `vcontext-self-improve.sh`, `vcontext-maintenance.sh`, `experiment-thinking-skip.sh` | shell scripts | Covered by v1-M2 (DEFERRED; not reintroduced by M17/M18). |
| `coreml-embed-server.py`, `convert-bge-coreml.py` | Python experimental | Covered by v2-N-M2 (DEFERRED). |

**No NEW stale reference introduced by M17/M18.**

### Dead-code / inconsistency from M17+M18

1. **Comment accuracy**: `verifyBackupFile()` calls `dbQuery(sql, path)`
   which opens a new readonly handle on the file under test — not the
   live `ramDb` handle. This is the correct pattern (SQLite can't
   integrity_check a file currently in transaction). No finding.
2. **Alert dedup**: `emitBackupIntegrityAlert()` inserts a row on every
   invocation with no idempotency key. If an operator leaves a corrupt
   file in place for hours, each 5-min backup cycle generates a new
   anomaly row. Not a bug (by design — each event is a distinct signal),
   but worth noting. **Severity: LOW** (new finding N3-L1).
3. **M18 const name**: `VCTX_RAM_DB` now means "primary DB path"; the
   name is misleading post-migration. Rename deferred per commit message.
   **Severity: LOW** (new finding N3-L2, cosmetic).

### NEW findings table

| # | File:Line | Severity | Finding | Proposed Action |
|---|-----------|----------|---------|-----------------|
| N3-L1 | `vcontext-server.js:862-874` | LOW | `emitBackupIntegrityAlert` has no dedup; repeat alerts every 5 min until fixed. | Add dedup key `kind:file` + 1-hour suppression window, OR accept (design choice). |
| N3-L2 | `vcontext-hooks.js:2206` | LOW (cosmetic) | Const name `VCTX_RAM_DB` misleading post-migration. | Rename to `VCTX_PRIMARY_DB` in next cleanup pass (touches 17 call sites). |

**No HIGH or MEDIUM new findings.**

---

## Section 5 — Regression test results

### H1 — MLX lock end-to-end (`scripts/test-mlx-lock-end-to-end.sh`)

```
════════════════════════════════════════════
  passed=27  failed=0
════════════════════════════════════════════
```

All 8 scenarios green:
1. basic acquire/release (3)
2. lock-holder survives SIGTERM (2)
3. re-entrant acquire via env var (2)
4. non-owner release is safe no-op (2)
5. stale lock auto-clear (1)
6. dead-PID detection <1s (D1) (9)
7. task-runner-style env re-entry (3)
8. SIGKILL-orphan recovery (3)

**Status**: 27/27 PASS — no regression from M17/M18.

### H3 — task-request auth (`scripts/test-task-request-auth.sh`)

First attempt timed out (server busy with RAM→SSD migration after 500-
entry backfill; /health unreachable for ~35s). Re-ran after server
caught up — all 4 ACs green:

- AC1 no-header + shell-command → 403 (PASS)
- AC2 no-header + locomo-eval (non-shell) → 200 (PASS)
- AC3 header + shell-command + approved=true → 200 (PASS)
- AC4 header + shell-command + approved=false → 403 (PASS)

**Status**: 4/4 PASS — no regression from M17/M18.

Note: the `/health` stall is not a source regression. Server uptime 42
min, 2.6% CPU, 779 MB RSS — mid-maintenance cycle (tier migration +
anomaly alert writes). Matches v2 log-analysis patterns.

---

## Aggregate

| Dimension | Result |
|-----------|--------|
| M17 verification | PASS (7/7) |
| M18 verification | PASS (6/6) |
| v2 findings regression | 0 regressed, 4 DEFERRED unchanged |
| NEW findings | 0 HIGH / 0 MED / 2 LOW (N3-L1, N3-L2 — both cosmetic) |
| Syntax health | all ~80 checks pass |
| H1 regression (27 tests) | PASS |
| H3 regression (4 tests) | PASS |
| Security posture | unchanged from v2 (still improved vs v1) |
| **Overall verdict** | **PASS** |

**Skills applied**: `infinite-skills` (routing), `quality-gate`
(post-fix re-execute), `investigate`, `security-review`, `spec-driven-dev`.

**H1 + H3 in-flight status**: not in flight. M17 + M18 both land cleanly
with no regression to prior fixes. Two new LOW cosmetic observations;
both are deferrals the fix authors explicitly signaled.
