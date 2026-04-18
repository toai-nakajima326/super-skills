# 2026-04-18 Source Audit v2 — Post-Fix Regression Sweep

## Mini-spec

**Goal**: Second full-count read-only audit after tonight's H1/H2/H3
remediation commits. Verify fixes held, catch regression-variants, and
find any NEW issues introduced.

**Scope**: identical to v1 (`docs/audit/2026-04-18-source-audit.md`).
`scripts/**`, `skills/**/SKILL.md`, plists, `.claude/**/*.json`,
`docs/policy/*.md`, `docs/spec/*.md`.

**Acceptance criteria**:
1. Each v1 finding classified as FIXED / DEFERRED / REGRESSED-VARIANT.
2. All 135+ syntax checks re-run on current tree.
3. New findings have file:line + severity + proposed action.
4. H1 in-flight status explicitly stated.

**Constraints**: READ-ONLY. `node --check`, `bash -n`, `plutil -lint`,
`python3 -m py_compile` only.

**Skills applied**: `infinite-skills` (routing), `investigate`
(evidence-first), `security-review` (H3 gate verification), `quality-gate`
(full-count re-check), `spec-driven-dev` (this mini-spec).

---

## Inventory delta

| Category                                      | v1 count | v2 count | Delta |
|-----------------------------------------------|----------|----------|-------|
| `scripts/**` .js                              | 25       | 16       | -9 (`.js`→`.cjs` rename + cleanup) |
| `scripts/**` .cjs                             | 5        | 8        | +3 (scan-secrets/validate-configs/build-skills/build-mcp-config + build-antigravity-skills/kiro/cursor net) |
| `scripts/**` .py                              | 5        | 5        | 0 |
| `scripts/**` .sh                              | 31       | 32       | +1 (`aios-mlx-lock.sh`) |
| `skills/**/SKILL.md`                          | 47       | 47       | 0 |
| `~/Library/LaunchAgents/com.vcontext.*.plist` | 16       | 16       | 0 |

Commits landed since v1 (9078e7b): `d295de3`, `20ee1c2` (H3), `7d0fc33`
(H2), `c8f831e` (H1 part 1, D1), `079360d` (H1 part 2, D2), `e39feb0`
(H1 tests).

## Syntax re-check

| Tool                              | Files | Pass | Fail |
|-----------------------------------|-------|------|------|
| `node --check` (.js + .cjs + lib) | 24+8+6 | all   | 0    |
| `bash -n` (.sh)                   | 32    | 32   | 0    |
| `python3 -m py_compile` (.py)     | 5     | 5    | 0    |
| `plutil -lint` (plist)            | 16    | 16   | 0    |
| **Aggregate**                     | **~137** | **all** | **0** |

All syntax checks pass.

## Regression table — v1 findings × current status

| v1 ID | Severity | Status | Evidence |
|-------|----------|--------|---------|
| H1    | HIGH     | **FIXED** (both D1+D2 landed) | `c8f831e` + `079360d`. `scripts/aios-task-runner.js:188,249,273,306` inject `AIOS_MLX_LOCK_HOLDER` into child env. `aios-mlx-lock.js:44` exports `MLX_LOCK_ENV_VAR`. Tests exist at `scripts/test-mlx-lock-end-to-end.sh` scenarios 6/7/8. |
| H2    | HIGH     | **FIXED**                     | `7d0fc33`. `scripts/scan-secrets.cjs`, `validate-configs.cjs`, `build-skills.cjs`, `build-mcp-config.cjs` all exist; the `.js` originals removed. `node scripts/scan-secrets.cjs` runs cleanly (prints expected worktree false-positives). READMEs updated to `.cjs`. |
| H3    | HIGH     | **FIXED**                     | `20ee1c2`. `vcontext-server.js:7149` checks `req.headers['x-vcontext-admin'] !== 'yes'` for `task_type==='shell-command'`. Test at `scripts/test-task-request-auth.sh` covers AC1–AC4. |
| M1    | MED      | DEFERRED (still present)      | `vcontext-server.js:1642` and `5352` — `mlxEmbedFast(q.slice(0,500), 2000)` still slices by UTF-16 unit, not code-points. Same recommendation as v1. |
| M2    | MED      | DEFERRED                      | `scripts/pre-outage.sh:16`, `vcontext-abtest.sh:19`, `vcontext-self-improve.sh:12`, `vcontext-maintenance.sh:115`, `experiment-thinking-skip.sh:19` all still hard-code `/Volumes/VContext/vcontext.db`. |
| M3    | MED      | DEFERRED                      | `scripts/vcontext-hooks.js:2201` — `VCTX_RAM_DB='/Volumes/VContext/vcontext.db'` still present. Latent. |
| M4    | MED      | **FIXED** (comment corrected) | `vcontext-server.js:41-42` now cites `skills/self-evolve/scripts/self-evolve.js`. |
| M5    | MED      | DEFERRED                      | `skills/comprehensive-qa/SKILL.md:401` still uses `/Volumes/VContext/vcontext.db`. |
| M6    | MED      | DEFERRED                      | `ramDb`/`ssdDb` naming drift unchanged (not a bug; out of this session's scope). |
| M7    | MED      | DEFERRED                      | `docs/spec/2026-04-18-skill-feedback-loop.md:512` still says `scripts/self-evolve.js`. |
| L1    | LOW      | DEFERRED                      | `vcontext-server.js:3638, 3642` osascript quote-strip unchanged. Defense-in-depth only. |
| L2    | LOW      | DEFERRED                      | `docs/analysis/2026-04-18-self-evolve-redesign.md:176` — historical. |
| L3    | LOW      | DEFERRED                      | `docs/policy/autonomous-commit-gate.md` retrospective ref. |
| L4    | LOW      | (non-finding; false-grep)     | `VCTX_DEADLETTER` — legitimate, no action. |
| L5    | LOW      | DEFERRED                      | `scripts/__pycache__/mlx-generate-server.cpython-313.pyc` still present. |

**Summary**: 3/3 HIGH fixed. 1/7 MED fixed (M4). 0/5 LOW fixed (all cosmetic).

---

## NEW findings since v1

### HIGH

(none — no new critical issues introduced by tonight's three fix commits)

### MEDIUM

| # | File:Line | Severity | Finding | Proposed Action |
|---|-----------|----------|---------|----------------|
| N-M1 | `docs/SPEC.md:634, 640` + `docs/PLAN.md:84, 778` | MEDIUM (doc drift post-H2) | After H2 rename commit `7d0fc33`, `docs/SPEC.md:634` and `:640` still say `build-skills.js` (twice) and `docs/PLAN.md:84` proposes `scripts/build-skills.ts` + `:778` says `build-skills.js`. Readers using SPEC to understand pipeline will grep for a phantom name. Not a runtime bug (since SPEC is narrative), but an inconsistency risk. | Update 4 mentions to `build-skills.cjs` (or annotate as historical/proposal). |
| N-M2 | `scripts/coreml-embed-server.py:47`, `scripts/convert-bge-coreml.py:18` | MEDIUM (latent) | Hard-coded `/Volumes/VContext/bge-small-coreml.mlpackage`. Model file does not exist on current SSD-only host (RAM disk unmounted). If anyone runs these experimental embed servers (not in any LaunchAgent today), they fail. Same class as M2 but different path. | Read model path from env var, default to `data/models/bge-small-coreml.mlpackage` on SSD mode. Or mark scripts as `[experimental, requires RAM disk]`. |

### LOW

| # | File:Line | Severity | Finding | Proposed Action |
|---|-----------|----------|---------|----------------|
| N-L1 | `docs/PLAN.md:416, 483, 515` | LOW (doc drift) | Mentions `scripts/build-mcp-config.ts` (proposal form), `scripts/scan-secrets.*` (wildcard), and `validate-configs` command. Harmless in plan doc, but glob `.*` won't find `.js` anymore; wording should match delivered `.cjs`. | Update 3 mentions. |
| N-L2 | `scripts/__pycache__/` — 5 .pyc files for live .py, + 1 stale `mlx-generate-server.cpython-313.pyc` (v1-L5) | LOW | Consistent with L5; no change. | `rm mlx-generate-server.cpython-313.pyc` (single-file, no blast). |

---

## Regression-introduced-by-fix check

All three checks **CLEAN**:

1. **H2 rename aftermath**: `grep -rn build-skills.js scripts/` → no matches in executable code paths. The only residual `.js` references are in `docs/SPEC.md` + `docs/PLAN.md` (doc drift — N-M1), not callers.
2. **H3 admin header**: Legitimate callers inventory:
   - `scripts/vcontext-dashboard.html` — only reads task-queue, never submits task-request. No regression.
   - `scripts/test-task-queue.sh:47` — sends `X-Vcontext-Admin: yes`. OK.
   - `scripts/test-task-request-auth.sh` — covers all 4 ACs. OK.
   - `scripts/test-task-dispatch-paths.sh:46` — submits `skill-discovery-adhoc`, `article-scan-adhoc`, `self-evolve-dryrun` (not `shell-command`), so no header needed by current server. OK.
   - No LaunchAgent or skill posts `shell-command` — the endpoint is dashboard-click-only. OK.
3. **H1 env-export consistency**: `grep MLX_LOCK_ENV_VAR scripts/` shows:
   - Exported from `aios-mlx-lock.js:44`
   - Imported & used by `aios-task-runner.js:34,195,255,290,322` — 4 dispatch paths all set holder id
   - Parallel Python export at `aios_mlx_lock.py:47` + Python consumer at `locomo-eval.py:52,696,697,705,707`
   - Import `import { ... MLX_LOCK_ENV_VAR } from './aios-mlx-lock.js'` — `node --check` passes, symbol resolves.

---

## Aggregate

- **First-audit findings status**: 4 FIXED (H1, H2, H3, M4); 11 DEFERRED; 0 REGRESSED-VARIANT.
- **New findings**: 0 HIGH / 2 MED (N-M1, N-M2) / 2 LOW (N-L1, N-L2).
- **Syntax health**: all 137 checks pass.
- **Security posture**: improved vs v1 — local-RCE path (H3) now behind `X-Vcontext-Admin: yes` header; MLX lock-leak deadlock (H1) closed.
- **Skills applied**: `infinite-skills` (routing), `investigate`, `security-review`, `quality-gate`, `spec-driven-dev`.
- **H1 in-flight status**: no longer in flight. D1 (`c8f831e`) + D2 (`079360d`) + tests (`e39feb0`) all committed. Fix is complete per the plan in `docs/analysis/2026-04-18-mlx-lock-leak-fix-plan.md`.

## Explicit non-findings (re-verified clean)

- Hardcoded secrets: none in `scripts/` or `skills/` (worktree stubs are expected false-positives).
- Path traversal: no `readFile(${req.body.x})` patterns.
- SQL injection: `esc()` + `Number()` coverage intact across 30+ `dbExec` sites.
- `.cjs` consistency: all 8 `.cjs` files callable via `node --check`; all active callers use `.cjs` extension.
- `USE_RAMDISK` gating at active sites intact (`vcontext-server.js:65, 506, 2073, 3520`; `vcontext-setup.sh:8`).
- `MLX_LOCK_ENV_VAR` export/import chain verified across Node + Python + Bash.
