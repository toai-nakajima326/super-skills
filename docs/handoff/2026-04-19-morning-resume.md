# Morning Resume — 2026-04-19

Handoff from 2026-04-18 (infra-heavy day: RAMdisk -> SSD migration, MLX
embed fixes, task-queue hardening, pillar 3/4/5 dashboards).

**First thing to check tomorrow morning**: embed backlog. At session end
it was **14588** per `curl /ai/status` (not 4669 — that figure is stale).
MLX watchdog + batching fixes are live, so it should be draining
overnight. If it has grown instead of shrunk, triage that before
anything else.

---

## 1. Quick status (30-sec read)

Run before anything:

```bash
curl -sf --max-time 3 http://127.0.0.1:3150/health | jq .
curl -sf --max-time 3 http://127.0.0.1:3150/ai/status \
  | jq '{backlog: .embedding_backlog, eligible: .embedding_eligible_total, embedded: .embedding_count}'
curl -sf --max-time 3 http://127.0.0.1:3150/pipeline/health | jq '.summary, .loops'
launchctl list | grep vcontext | awk '{print $3, $2}'
```

State captured at handoff (2026-04-18 17:26 JST, verify next session):

- **vcontext /health**: `healthy`, `ram_disk:false`, `ssd_database:true`,
  `mlx_available:true`, `mlx_generate_available:true`, uptime ~62min.
  SSD mode is now the default (commits `d621456`, `2e93b9f`).

- **embed backlog**: **14588** (embedded 34108 / eligible 48696).
  Growing was the concern today; post-`ae1ce3f` + `01ba5dd` + `fa05a9b`
  the MLX side should now drain faster than new writes. Watch the
  delta tomorrow morning — if `embedding_backlog` is lower than 14588,
  the fixes are working end-to-end.

- **pipeline /pipeline/health**: `{green:6, yellow:1, red:0, idle:3}`.
  The `yellow` is `predictive-search` (last fired 336 min ago, which is
  normal for its condition-gated cadence; confirm it's not structural).

- **loops**: `embed` green (12s ago); `chunk_summary` L2/L3 green;
  `discovery` RED (62min, weekly cadence per `99e8820`/`5e03f79` — age
  likely expected) and `chunk_summary` L1 RED (52min — investigate).

- **Q1 LoCoMo full `a03fa6dd`**: **FAILED** at duration 1200055ms (20min).
  Matches `wait_s=1200` MLX lock timeout set in `90e65e8`. Needs re-run.

- **Orphans**: 3 locomo + 1 article-scan already in `failed` with
  `error:"orphaned_on_restart"` from today's server bounces. No cleanup
  needed. `pending:[], running:[]` — clean.

---

## 2. In-flight when session ended

- **Active agents / tasks**: none. Queue empty.
- **Meta-loops**: daily cadence (`11049f7`) fires via LaunchAgent cron.
- **MLX lock**: `/tmp/aios-mlx-lock` exists. If new MLX work stalls,
  `cat /tmp/aios-mlx-lock` → `kill -0 <pid>`; if dead, `rm` it.
- **Uncommitted** (`git status` at handoff):
  - `modified: scripts/launchagent-health-check.sh`
  - `modified: scripts/test-task-dispatch-paths.sh`
  - `untracked: docs/analysis/2026-04-18-maintenance-pinned-45.md`

(Note: handoff prompt listed `data/locomo/`, `scripts/locomo-eval.py`,
`docs/analysis/2026-04-18-locomo-eval-harness.md` as untracked — they
are already committed via `4f88280` / `7c4197f`. Stale in prompt.)

---

## 3. Deferred items (ready to execute tomorrow)

1. **2-DB merge** — spec `docs/analysis/2026-04-18-db-merge-spec.md`
   (commit `08406cf`). Preconditions: backlog decreasing, no RED loops,
   empty task queue. Currently backlog 14588 — probably wait (§7).

2. **Re-run Q1 LoCoMo full** (replaces failed `a03fa6dd`). Raise lock
   timeout above 1200s, or run mid-subset first.

3. **Commit uncommitted files** (§2).

4. **Pillar cards polish** — TODOs in `docs/design/2026-04-18-dashboard-pillar-cards.md`
   not yet in `a5955b6`/`b4a914b`/`d8618b1`/`ef94138`.

5. **RED loops** — if `chunk_summary` L1 still RED > 2h tomorrow,
   investigate for stuck lock holder.

---

## 4. Followup queue (top 5, nice-to-have)

1. **LLM judge for LoCoMo** — MLX generate now stable; re-evaluate.
2. **Dashboard WS throttle** (`5390ebe` 1/10s) — check for staleness.
3. **Confirm ramdisk plist `Disabled`** key present (§5 fallback).
4. **Cadence audit followups** — open questions in `3fde318`.
5. **`test-mlx-lock-end-to-end.sh`** — confirm wired into CI/self-evolve.

---

## 5. Known-breakable surfaces

- **Env flags on server restart.** vcontext reads `VCONTEXT_DB_PATH` /
  `VCONTEXT_VEC_DB_PATH` / `VCONTEXT_USE_RAMDISK` at boot. Verify with
  `launchctl print gui/$UID/com.vcontext.server | grep -A3 Environment`.

- **RAMdisk must stay unloaded.** `com.vcontext.ramdisk.plist` still on
  disk but not in `launchctl list`; `/Volumes/VContext` confirmed absent.
  If reboot happens, vcontext still works (SSD default) but memory
  pressure returns. Tomorrow: `launchctl list | grep ramdisk` = empty.

- **Orphan recovery is automatic** (`2f2e54f`+`e0bafb5`). Confirmed
  working — 4 orphans cleaned on today's bounces. No manual trigger.

- **MLX lock stale risk.** If holder died without releasing, new MLX
  work queues up to `wait_s` (1200s locomo). See section 2 recovery.

- **MLX embed /health 200 in <3s at handoff** (post-`fa05a9b`). If it
  regresses, watchdog requires 2 consecutive >30s fails before restart
  (`ae1ce3f`). Watch `/tmp/vcontext-watchdog.log`.

- **`chunk_summary` L1 RED (52min) at handoff.** If > 2h tomorrow,
  could indicate stuck queue item holding MLX lock.

- **SearXNG:8888** returned HTML landing page — up. Confirm JSON API:
  `curl 'http://127.0.0.1:8888/search?q=X&format=json'`.

---

## 6. Morning smoke-test checklist

All must return `0` exit + non-empty. If any fail, fix before new work.

```bash
# 1. vcontext up + SSD mode
curl -sf --max-time 3 http://127.0.0.1:3150/health \
  | jq -e '.status=="healthy" and .ssd_database==true'

# 2. Backlog lower than 14588 (handoff value)
curl -sf --max-time 3 http://127.0.0.1:3150/ai/status \
  | jq -e '.embedding_backlog < 14588'

# 3. Pipeline no RED
curl -sf --max-time 3 http://127.0.0.1:3150/pipeline/health \
  | jq -e '.summary.red == 0'

# 4. Task queue empty (pending + running)
curl -sf --max-time 3 http://127.0.0.1:3150/admin/task-queue \
  | jq -e '(.pending|length==0) and (.running|length==0)'

# 5. Recent entries flowing (writes working)
curl -sf --max-time 3 'http://127.0.0.1:3150/recent?limit=1' \
  | jq -e '.count > 0'

# 6. MLX embed server healthy + fast
curl -sf --max-time 3 http://127.0.0.1:3161/health \
  | jq -e '.status=="healthy" and .model_status=="ready"'

# 7. MLX generate server up
curl -sf --max-time 3 http://127.0.0.1:3162/health \
  | jq -e '.status=="ok"'

# 8. SearXNG responsive for verify-before-assert
curl -sf --max-time 5 'http://127.0.0.1:8888/search?q=ping&format=json' \
  | jq -e '.results | length > 0'

# 9. No RAMdisk remount
test ! -e /Volumes/VContext

# 10. All 16 vcontext LaunchAgents listed
[ "$(launchctl list | grep -c vcontext)" -ge 15 ]
```

Pass 1–5: AIOS core healthy.
Pass 6–7: MLX stable, LoCoMo + self-evolve safe to run.
Pass 8–10: environment fully restored.

---

## 7. Decisions pending

1. **Re-run Q1 LoCoMo: full or mid-subset first?** 20-min timeout
   suspected. Recommend mid-subset to bound runtime.
2. **Enable LLM judge in re-run?** Today's small-subset had `llm=0` —
   judge was off. MLX-generate is stable now. Recommend enable at
   mid-subset, measure, decide on full.
3. **2-DB merge now or wait for backlog < 1000?** Current 14588. Wait.
4. **Commit cadence policy (`5e4a41b` Option C): switch on or docs-only?**
5. **`discovery` / `chunk_summary` L1 RED: genuine stall or cadence?**

---

## Verification index

Every claim maps to one of: live probe at handoff (curl, launchctl,
`ls`, `git status`), commit hash (inline), or doc path (inline). If
tomorrow a claim can't be verified via these, treat as stale.

---

## Monday (2026-04-20) North Star — 2 themes

Per user (2026-04-18 midnight): 「安定稼働と、安定したLLM生成ですね」

### Theme A — 安定稼働 (zero-downtime architecture)

**Priority: HIGHEST**. "Search failure stops everything" — from user
insight, the reliability of the CRITICAL path (/recall, /recent,
/health) gates everything else. Work items:

- **M1** — MLX lock D1+D2 (SIGKILL orphan fix) — 3h
- **M9** — zero-downtime architecture audit + search path isolation — 3-4h
- **M8** — RAM-disk-era dead code Phase 2 (remove USE_RAMDISK flag) — 1h
- **M3** — 2-DB merge (spec prepared) — 30min

AC: `/health` returns within 2s under any load (even MLX wedge /
backfill / tier migration).

### Theme B — 安定したLLM生成 (reliable LLM output)

**Priority: HIGH** (auto-recovers once Theme A is solid).

- **M2** — LoCoMo full 1986Q re-run (after M1 lands) — 30-60min
- **LLM judge re-enable** (fix `llm_j=0.0`)
- **MLX generate queue/retry/timeout policy** review
- **multi-prompt batch (P7)** — defer unless bottleneck shows

AC: MLX generate failures self-heal via task-queue; autonomous loops
retry and eventually succeed without user intervention.

### Why Theme A beats Theme B

User quote 2026-04-18 evening:

> ローカルLLMは生成が落ちても溜めておけるから、後で再生成すればいいけど
> 検索系が落ちると全てが動かなくなる

Search must be bulletproof first; generation is non-critical and
queues safely.

### Monday's first 30 min

1. Run smoke-test (§6 of this doc).
2. Read Phase 3 review `docs/analysis/2026-04-18-phase-3-integrated-review.md`.
3. `git stash list` — review the M1 partial work still parked.
4. Start M1 agent (Theme A foundation).
