# Spec — RAM-disk era dead-code cleanup

**Level**: Spec-Anchored (doc lives alongside code, evolves with it)
**Status**: Phase 1 in-progress — agent `a997cf961a6fddaac` executing
**Phase 2 planned**: 2026-04-19 morning after architectural review
**Author**: main orchestrator, 2026-04-18 evening

---

## Architectural premise (2026-04-18 evening user insight)

> "仮想コンテキストと、RAM-diskは同じ仕組みだった気がします"
> "だから、複雑化して、不安定になった"

Historical truth: **"virtual context" as a concept WAS the RAM disk** — they
were the same thing, just named from different angles (concept-facing vs
implementation-facing). The "RAM tier / SSD tier" split was a later
premature generalization, never load-tested at the levels that would
justify it, and the source of today's infinite-loop bug.

### Causal chain of today's instability (user's thesis)

```
vcontext original design (1 concept, 1 implementation: RAM disk)
  ↓  (someone added 2-tier "hot RAM / cold SSD" split + migration)
same data now has 2 seats + migration logic + 18GB heuristics
  + mount-point dependencies
  ↓  (complexity accumulation over months)
today: RAM→SSD migration removes one tier
  ↓
stale half-tier logic fires as bogus heuristics (anomaly loop)
  ↓
OOM cascade + 90s HTTP hang + observed user pain
```

**= direct 1:1 correspondence between premature-generalization
and instability**. The cure is not adding more abstraction (e.g.,
③ RAM-buffer over SSD), but collapsing the unnecessary tier split
back to the original 1-concept design.

**Implication for this spec**:
- Phase 1 (tonight): conservative cleanup via `USE_RAMDISK` gate —
  preserves revert path, minimum risk to the fragile server.
- Phase 2 (tomorrow): aggressive simplification — remove `USE_RAMDISK`
  flag entirely, collapse tier concept, single "vcontext" store.

Phase 1 must NOT preclude Phase 2. No new baroque abstractions.

---

## Requirements

### Goal

Remove dead or heuristically-wrong code paths that assumed the 18 GB RAM
disk architecture, so they cannot re-surface as runtime bugs (as one did
today at `anomaly-detect` L3487 — "RAM disk >3GB" alarm looping every
5 min and starving the HTTP handler).

### Acceptance Criteria

- **AC1** — As a running vcontext server, there are **ZERO** new
  `[anomaly-response] RAM disk full` log lines emitted in a 10-min
  observation window post-fix.
- **AC2** — As a running vcontext server, there are **ZERO** new
  `[auto-consult] Failed to create: consultations is not defined` lines
  (this was fixed in 0252bcc; cleanup must not regress it).
- **AC3** — As a developer running `grep -rn "MOUNT_POINT|/Volumes/VContext" scripts/`,
  every remaining hit MUST be either:
    - Inside an `if (USE_RAMDISK)` guard, OR
    - The `MOUNT_POINT` const itself (kept for legacy gate), OR
    - The `/admin/ramdisk-stats` endpoint reading live df (legitimate), OR
    - A comment referencing the original design.
- **AC4** — `migrateRamToSsd()` (or the equivalent tier-migration function)
  MUST return 0 immediately (no-op) when `DB_PATH === SSD_DB_PATH`, with
  no SQL executed.
- **AC5** — `curl /tier/stats` MUST return a response shape that signals
  unified mode (new field `unified: true` OR `ram.entries === ssd.entries`
  — document which was chosen).
- **AC6** — Dashboard still renders 16 cards; the "RAM / SSD / Cloud" tier
  bar either (a) stays 3-bar with ram+ssd showing same value, OR
  (b) collapses to 2-bar "Primary / Cloud". Either is acceptable; must
  not be broken.
- **AC7** — Server restart completes in ≤ 60s from bootstrap to `/health`
  returning healthy.
- **AC8** — `bash scripts/launchagent-health-check.sh` reports 14 agents
  with OK count ≥ 8 (matches tonight's baseline of 9).
- **AC9** — Revert path preserved: setting `VCONTEXT_USE_RAMDISK=1` env
  still makes the server attempt the RAM-disk code path (not a hard
  deletion). Documented in the audit doc.
- **AC10** — No 2-DB merge touches (data files untouched); no MLX-lock
  touches (that's M1). This cleanup is STRICTLY code-path.

### Out of Scope

- 2-DB merge (separate spec `docs/analysis/2026-04-18-db-merge-spec.md`)
- MLX lock D1+D2 (the M1 task, deferred to tomorrow)
- Cloud tier implementation
- Dashboard visual overhaul beyond the tier-bar shape change
- Any MLX-server-side code
- Any `skills/` directory content

## Design

### Data Model

No schema changes. The unified state is characterized by:
- `DB_PATH === SSD_DB_PATH` (same file)
- `USE_RAMDISK === false` (env not set)
- `MOUNT_POINT` existence is irrelevant to correctness

### API / Interface

`GET /tier/stats` response shape evolution (backward-compatible):
```
Pre-cleanup:  { ram: {entries, size}, ssd: {entries, size}, cloud: {...} }
Post-cleanup: { ram: {entries, size}, ssd: {entries, size}, cloud: {...},
                unified: true }  // ← NEW field
```
Dashboard reads the new field and can collapse tiers if `unified === true`.

All other endpoints (`/store`, `/recall`, `/recent`, `/health`,
`/admin/*`, dashboard) MUST keep their existing response shapes.

### Sequence

1. Audit: grep all RAM-disk references, classify A/B/C
2. Remove category B (dead, no USE_RAMDISK gate) with simple diffs
3. Add `unified: true` to `/tier/stats`
4. Optional: dashboard 2-bar collapse (if <30 min work)
5. Restart server, run smoke tests
6. Split commits per logical concern

### Constraints

- `USE_RAMDISK=1` env must still work (preserve RAM-disk-era code, just
  gate it properly — don't delete the logic).
- Server restart: at MOST ONCE during the audit, at the END.
- No file deletions (only code removals inside files).
- Commit split: audit doc separate; server code changes in 1-3 commits;
  dashboard in 1 commit.

## Tasks (traceability)

- [ ] **T1** — Audit doc `docs/analysis/2026-04-18-ram-disk-audit.md`
      with full grep hit table (satisfies AC3 traceability)
- [ ] **T2** — Verify anomaly-detect cleanup from `0252bcc` covers
      all similar heuristics in the file (satisfies AC1)
- [ ] **T3** — `migrateRamToSsd()` early-return when paths equal
      (satisfies AC4)
- [ ] **T4** — `/tier/stats` add `unified` field (satisfies AC5)
- [ ] **T5** — Dashboard handle `unified` field (satisfies AC6)
- [ ] **T6** — Server restart + 60s healthy (satisfies AC7)
- [ ] **T7** — Health check 14 agents / OK≥8 (satisfies AC8)
- [ ] **T8** — 10-min log observation: 0 anomaly-response, 0 consultations
      errors (satisfies AC1, AC2)
- [ ] **T9** — Verify `VCONTEXT_USE_RAMDISK=1` code path still compiles
      (satisfies AC9)

## Verification Use (post-execution)

After agent `a997cf961a6fddaac` reports completion, the main orchestrator
MUST check each AC and each T against the agent's reported work:
- AC1 via `tail -100 /tmp/vcontext-server.log | grep -c "anomaly-response"`
- AC3 via `grep -rn "MOUNT_POINT\|/Volumes/VContext" scripts/ | wc -l`
  (should be low; each remaining must be audited)
- AC4 via read the updated code
- AC5 via `curl /tier/stats | python3 -c "..."`
- AC7, AC8 via live run

Flag any failed AC for agent retry.

## Notes

- This spec was written DURING execution (Spec-Anchored level) rather
  than pre-execution (Spec-First). The agent prompt already embedded
  an informal spec, so risk is moderate not high. But proper skill
  discipline (`spec-driven-dev`) would have produced this doc FIRST.
- Added to docs/spec/ as a new directory pattern for future
  architecture-adjacent work.
