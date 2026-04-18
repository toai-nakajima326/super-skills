# self-evolve Redesign — Pillar 2 Core Loop

**Date**: 2026-04-18
**Scope**: Extend `skills/self-evolve/SKILL.md` from a manual-trigger upstream-sync
workflow into the fitness-scored evolutionary loop at the heart of AIOS Pillar 2
("Continuous Evolution"). The existing upstream-sync and web-discovery sub-
workflows remain as sub-routines; this redesign adds the missing input sources,
scoring, cycle, and schedule that turn them into a feedback-driven engine.

Non-goals: auto-applying patches without human approval; rewriting dashboard
approval flow; creating a new audit surface. All applied changes still route
through the existing `pending-patch` approve/reject path.

---

## 1. Context and evidence

**Confirmed via filesystem inspection (断定)**:
- `skills/self-evolve/SKILL.md` exists — 176 lines, last touched 2026-04-17.
  Defines 3 sub-workflows: Upstream Sync, Web Discovery, Self-Improvement.
  No fitness function, no scheduler, no input from article-scanner / self-
  improve pipeline / discovery loop.
- `docs/evolution-log.md` exists — 680 lines, active since well before today.
  The freshness anchor referenced by step 0 of Web Discovery.
- `scripts/article-scanner.js` — 454 lines. Writes `external-article`,
  `article-evaluation`, `pending-idea`, `article-digest` to vcontext.
  LaunchAgent `com.vcontext.article-scanner` runs daily 06:00 JST.
- `~/Library/LaunchAgents/` contains 9 `com.vcontext.*` plists. **No
  `com.vcontext.self-evolve.plist` today.**
- `skills/self-evolve/` subdirs `data/` and `scripts/` created during this
  redesign session (were absent before).
- `infinite-skills/SKILL.md` line 14 routes `self-evolve` under P0 `update`.

**Confirmed via docs (断定, citations inline)**:
- `docs/vision/aios-5-pillars.md` L46-55 describes Pillar 2 as "AlphaEvolve-
  style evolutionary loop for skills: weekly variant generation, shadow A/B,
  fitness = success-rate x adoption-rate x tokium pain->structure". The gap
  is named explicitly: "no selection pressure, no variant pool, no fitness
  function wired to outcomes."
- `docs/analysis/2026-04-18-ideas-research-phase-review.md` L26-40 lists
  research inputs applicable to self-evolve: AlphaEvolve (arXiv:2506.13131,
  DeepMind), tokium pain->structure (Zenn), Letta LoCoMo eval, evolver
  (Qiita#1), Claude Code Agent Teams.

**Assumption (推測, flagged)**:
- vcontext server was not reachable during this design session
  (`curl -s -m 5 http://127.0.0.1:3150/...` returned empty; `launchctl list`
  shows the server process listed but port 3150 was not responsive). The
  design below assumes the endpoints `POST /store`, `GET /recall`,
  `GET /admin/pending-patches`, `POST /admin/approve-patch`,
  `POST /admin/reject-patch` behave per the stated contract in the mission
  brief. If the contract diverges, the Phase 3 script will need adjustment.

---

## 2. Boundary with neighboring skills

| Skill | Role | Overlap with self-evolve | Redesigned boundary |
|---|---|---|---|
| `skill-discovery` | Web-trend -> new-skill generator | Both touch "new skills from outside" | Discovery is the **generator of candidates**. self-evolve is the **selector** that scores candidates from all sources (discovery + article + patch + suggestion) and promotes winners. |
| `skill-creator` | SKILL.md authoring helper (format, frontmatter, validation) | Both produce SKILL.md files | Creator is a **tool** invoked by self-evolve when it decides to mutate a skill. No independent scheduling. |
| `infinite-skills` | P0 routing table | Routes "update" queries to self-evolve | Unchanged. self-evolve remains the single update entry point. |
| `article-scanner` | Daily external-article sweep | Writes `pending-idea` | Upstream feed. self-evolve reads `pending-idea` as one of four input streams. |
| `self-improve` pipeline | Internal refactor proposals -> `pending-patch` | Writes `pending-patch` | Upstream feed. self-evolve reads `pending-patch` as input stream #2. |
| `discovery-loop` (background) | Gap detection -> `skill-suggestion` | Writes `skill-suggestion` | Upstream feed. self-evolve reads `skill-suggestion` as input stream #3. |
| Dashboard approve/reject | Human-in-the-loop gate | Operates on `pending-patch` | **Unchanged**. self-evolve emits new `pending-patch` entries; it does **not** bypass this gate. |

In one sentence: **self-evolve becomes the periodic scorer and merger of four
candidate streams, emitting ranked `pending-patch` entries into the existing
approval surface.**

---

## 3. Extended input sources

Current (2026-04-17): `npm run sync:check` (upstream git) + WebSearch
(discovery) + conversation-context skim (self-improvement).

After redesign:

| # | Source | vcontext type | Freshness filter | Mapped signal |
|---|---|---|---|---|
| 1 | Upstream repo diff | (none, git) | `git log --since=last_run` | Maintainer-curated improvement |
| 2 | Web discovery | (none, search) | `after:last_run` | Novel external pattern |
| 3 | **NEW** article-scanner | `pending-idea` | `created_at > last_run` | Daily external research insight |
| 4 | **NEW** self-improve pipeline | `pending-patch` (unapproved) | `status = pending` | Runtime-proposed fix |
| 5 | **NEW** discovery-loop | `skill-suggestion` | `created_at > last_run` | Gap-based synthesis |

Sources 3-5 are additive — existing sources 1-2 stay. All five are gathered in
Phase (a) of each cycle (see section 5), then scored in Phase (b).

---

## 4. Fitness function

### 4.1 Formula (AlphaEvolve + tokium "pain->structure")

```
fitness(candidate) = w1 * adoption_rate
                   + w2 * triggered_change_rate   # tokium pain->structure
                   + w3 * reduced_error_rate
                   + w4 * user_approval_rate
                   + w5 * freshness               # time-decay
                   + bias_source(candidate.source)
```

All components normalized to `[0, 1]`. Weights `w1..w5` default to `0.25, 0.25,
0.20, 0.20, 0.10`; stored in `skills/self-evolve/data/evolution-config.json`
so they are tunable without editing the skill.

### 4.2 Per-component measurement (concrete vcontext queries)

| Component | Definition | vcontext query |
|---|---|---|
| **adoption_rate** | Fraction of eligible sessions in last 30d that actually invoked the skill | `count(type=skill-usage AND skill=X AND created_at>=now-30d) / count(type=session AND skill_eligible=X AND created_at>=now-30d)`. Zero eligibility => 0. |
| **triggered_change_rate** | "pain->structure": how often a skill invocation was followed within 24h by a `skill-diff` / `pending-patch` / doc edit on the same target | For skill X in last 30d, for each usage event, look forward 24h for `type in (skill-diff, pending-patch, chunk-summary)` whose `target_path` overlaps. Returns [0,1]. |
| **reduced_error_rate** | Drop in `error`/`anomaly-response` entries referencing skill X, period-over-period | `(errors(X, 30d..60d) - errors(X, 0..30d)) / max(1, errors(X, 30d..60d))`, clamped to [0,1]. |
| **user_approval_rate** | For candidates that passed through `pending-patch`: approved / (approved + rejected) | `count(approve-patch, target=X) / (count(approve-patch, target=X) + count(reject-patch, target=X))`. No decisions => 0.5 prior. |
| **freshness** | `exp(-age_days / 90)` where age = days since candidate source-doc publish or last meaningful skill edit | Read `created_at` on candidate; read `evolution-log.md` last entry for the target skill. |
| **bias_source** | Small additive for provenance trust: upstream=+0.05, article-scanner high-confidence=+0.03, discovery=+0.02, self-improve=+0.02, web=0 | Read the `source` field stamped at gather time. |

A candidate with no usage history (brand new skill) defaults `adoption_rate =
triggered_change_rate = reduced_error_rate = 0`, uses `user_approval_rate`
prior, and scores primarily on `freshness + bias_source`. This ensures new
skills can compete while biased toward demonstrated wins.

### 4.3 Why these five components

- `w1` + `w2` + `w3` map directly onto the mission brief's formula.
- `w4` adds a human-in-the-loop term so approval feedback accumulates in the
  metric (mission brief #2).
- `w5` fights stagnation: old content decays even if historically adopted. This
  mirrors AlphaEvolve's preference for novel variants (cited in brief item 0).
- `bias_source` encodes the observation from 2026-04-18-ideas-research-phase-
  review section 3 that upstream and article-scanner sources were more
  consistently actionable than raw web-search hits.

---

## 5. Evolution cycle

**Period**: Weekly, Sundays 07:00 JST (chosen to avoid article-scanner's 06:00
overlap). Mission-brief spec matched.

### Phases

| # | Phase | Inputs | Outputs | Success criteria | Rollback trigger |
|---|---|---|---|---|---|
| a | **Gather** | Last-run timestamp from `evolution-log.md`; 5 source streams (section 3) | In-memory candidate list `C[]` | `len(C) > 0` OR log "no new candidates" and exit cleanly | None (read-only) |
| b | **Score** | `C[]` + `evolution-config.json` | `C[]` sorted by fitness, with component breakdown | Every candidate has non-null fitness; weights sum to ~1.0 | Fitness sum of any component outside [0,1] => abort, log |
| c | **Mutate** | Top-K (default K=3) candidates; current SKILL.md for each target | Proposed new SKILL.md text per candidate | SKILL.md passes `npm run validate` (frontmatter + structure) | Validation fail => drop that candidate, continue |
| d | **Validate** | Proposed SKILL.md files | Boolean pass/fail per candidate | `npm run build` succeeds; LoCoMo eval delta >= -2% (no regression); no removal of safety-skill rules | Any fail => mark candidate `rejected-validation`, do not emit `pending-patch` |
| e | **Apply** | Validated candidates | `pending-patch` entries in vcontext | `POST /store type=pending-patch` returns 200 with entry id | Store failure => retry 3x then log and abort cycle |
| f | **Log** | Cycle summary | Append block to `docs/evolution-log.md`; `article-digest`-style summary entry to vcontext (type `evolution-digest`) | Both writes succeed | Log write failure is non-fatal; warn and continue |

**Cycle-level rollback**: Phase (e) is the only mutating step. Because it only
*creates* `pending-patch` rows (which require dashboard approval to actually
modify any file), there is no file-system rollback needed. If Phase (e) errors
mid-way, the partially-created pending-patches remain in the approval queue
where the user can reject them.

**Idempotency**: Each cycle writes one `evolution-digest` keyed on
`cycle_id = YYYY-WW`. Re-running the same week dedupes via the `cycle_id` tag
(alreadyScanned-style check, modeled on `article-scanner.js:295`).

---

## 6. LaunchAgent spec

Filename: `~/Library/LaunchAgents/com.vcontext.self-evolve.plist`
Model: `com.vcontext.article-scanner.plist` (confirmed via `plutil -p`).

Key differences from article-scanner:
- Schedule: weekly Sunday 07:00 (not daily 06:00) — uses `Weekday=0, Hour=7, Minute=0`.
- Log path: `/tmp/vcontext-self-evolve.log`
- Program: `node scripts/self-evolve.js` in working dir `/Users/mitsuru_nakajima/skills`
- Label: `com.vcontext.self-evolve`
- `RunAtLoad = false`, `KeepAlive = false` (matches article-scanner)
- Env: `VCONTEXT_URL=http://127.0.0.1:3150` (matches article-scanner)

Phase 3 creates this file if the Write tool is permitted; otherwise it is
deferred to the commit agent.

---

## 7. Pillar 2 connection points

| Connection | How self-evolve uses it |
|---|---|
| **chunk-summary L2 (daily)** — `docs/vision/aios-5-pillars.md` L28 | self-evolve's Phase (a) reads the latest daily L2 summary and mines `pain_signals` (error spike / repeated-failed tool pattern) as additional candidates. Tokium-style: pain in L2 becomes structural change proposal. |
| **article-scanner** `pending-idea` — confirmed 2026-04-18 (scripts/article-scanner.js L377) | Direct input stream #3 (section 3, row 3). |
| **LoCoMo eval** (research, Letta) — `docs/analysis/2026-04-18-ideas-research-phase-review.md` row K | Gate at Phase (d): candidate must not regress LoCoMo score by more than 2%. Initial release: wire only the interface; score source is placeholder until the eval harness lands. |
| **self-improve pipeline** — existing, emits `pending-patch` | Input stream #4. |
| **skill-discovery** — existing | Input stream #5 (via `skill-suggestion`). |

The LoCoMo gate is the one forward-looking hook that is not fully wired today
(the eval harness is listed as deferred in the 2026-04-18 research review,
item K). The config ships with `locomo_gate_enabled: false` so the cycle
functions without it; flip to `true` once the eval pipeline exists.

---

## 8. What ships in Phase 3

1. `skills/self-evolve/data/evolution-config.json` — default weights + toggles.
2. `docs/evolution-log.md` — **already exists** (680 lines). No re-init needed.
   **Document the header assumption**: the existing file *is* the anchor.
3. `skills/self-evolve/SKILL.md` — Workflow section extended with:
   - New Evolution-Cycle sub-workflow (the weekly scheduler path)
   - Rules update referencing the fitness function
   - Input-sources list extended to 5
4. `skills/self-evolve/scripts/self-evolve.js` *(optional, skeleton only)* —
   follows article-scanner skeleton; implements Phase (a) Gather and (f) Log
   end-to-end and stubs Phases (b)-(e). Full scoring is explicitly out of
   scope for this redesign per mission constraint #2.
5. `~/Library/LaunchAgents/com.vcontext.self-evolve.plist` — weekly Sun 07:00.

Out of scope for this change (per mission constraints):
- Actually auto-editing SKILL.md files from a scheduler (Rules #1-#3
  enshrine the approve/reject gate).
- A new dashboard approval route (reuse existing `pending-patch` surface).
- LoCoMo harness (deferred gate).

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| False-positive mutation proposals flood the approval queue | Phase (b) default `top_K=3`. Dashboard inherits existing reject flow. Config allows `top_K=0` to run in observation mode. |
| vcontext schema drift (new types unrecognized) | Script probes `/recall` once at startup, logs counts per type, warns on zero. Non-fatal. |
| Weight tuning wars (user changes w1..w5, loses reason) | `evolution-config.json` is committed; each cycle logs the weight vector it used in `evolution-log.md`. Reversible. |
| Schedule overlap with article-scanner (06:00) | Self-evolve at 07:00 on Sunday only, giving a 1-hour gap even on scan day. |
| Server unreachable (observed during this design session) | Script short-circuits with clear error and exits non-zero, consistent with `article-scanner.js` MLX-probe pattern (L409-416). LaunchAgent does not retry on failure. |

---

## 10. Next-step proposal (post Phase 3/4)

1. **Wire Phase (b) real scoring** — replace stub with five `/recall` aggregations; probably a ~300-line commit with before/after numbers on the dashboard.
2. **LoCoMo harness** — the gate is referenced but not implemented. That's its own skill-sized chunk.
3. **Archive dead skills** — once fitness < threshold for 4 consecutive cycles, propose retirement (new `pending-patch` type `skill-archive`). Needs dashboard UI change, so defer.
4. **Cross-reference article-scanner keyword rotation with fitness** — low-performing topics get fewer weekly keyword slots.

---

*Design authored 2026-04-18. Implementation landing in the same session,
phased, with commit handled by the supervising agent.*
