# Spec — Skill Feedback Loop

**Level**: Spec-First (design precedes implementation)
**Status**: Design only — no server code tonight
**Author**: main orchestrator, 2026-04-18 evening
**Related policy**: `docs/policy/aios-infinite-skills-mandate.md`
**Related skills**: `skills/self-evolve/SKILL.md`, `skills/infinite-skills/SKILL.md`, `skills/skill-discovery/SKILL.md`
**Architecture doc**: `docs/design/2026-04-18-skill-feedback-architecture.md`

---

## 1. Premise (user directive 2026-04-18)

> スキルのフィードバックや要望をもらって、みんなで賢くなっていきましょう。

In English: collect feedback and requests about skills, let every
AIOS-connected client contribute, and route the signal back into the
self-evolve fitness function so the skill graph improves over time.

Today (pre-spec), AIOS already records:

| Signal | Type in vcontext | Producer | Consumer |
|---|---|---|---|
| Skill routing decision | `skill-usage` | `infinite-skills` PreToolUse hook | `self-evolve` adoption_rate |
| Skill gap (MLX-proposed) | `skill-suggestion` | `runOnePrediction()` | `self-evolve` candidates |
| Candidate skills (web) | `skill-discovery` | `skill-discovery` loop | `self-evolve` candidates |
| Pending mutation | `pending-patch` | `self-evolve`, self-improve | dashboard approve/reject |

Missing: a **direct, writable** feedback channel for humans and
sub-agents to critique or praise a skill **after** using it, separate
from the implicit `skill-usage` ping. The loop is one-way today
(usage → fitness). The user wants a **two-way** loop.

## 2. Goal

Define three new entry types + two read endpoints + one write endpoint
that let any AIOS client submit observations, wishlist items, and
positive signals about skills, and let `self-evolve` and the dashboard
consume the resulting signal.

Phase 4 of this spec lists the implementation steps. **This spec
produces the contract only.** Server code lands in a later session.

## 3. Scope

### 3.1 In scope
- Three new vcontext entry types and their JSON schemas.
- One new POST endpoint (`/skills/feedback`) + two new GET endpoints
  (`/skills/:name/feedback`, `/skills/:name/health`).
- `self-evolve` integration plan — new fitness component `w6 * feedback_score`.
- Dashboard card shape (read-only tonight; wired up later).
- Moderation / rate-limit / spam contract.

### 3.2 Out of scope
- Server code (any diff to `scripts/vcontext-server.js`).
- New DB table (all three types reuse `entries`).
- Cross-client auth beyond what `validateApiKey()` already provides.
- Dashboard implementation (design only; wiring in a later phase).
- ML-based spam detection. Start with content-hash dedup + rate limits.
- Sentiment analysis. v1 carries explicit `sentiment` field from client.

## 4. Acceptance Criteria

### AC1 — Three entry types, names fixed, schemas stable
The following entry types MUST be accepted by `POST /skills/feedback`
and MUST round-trip through `POST /store` unchanged:

- `skill-feedback` — observation or critique about an existing skill.
- `skill-request` — wishlist / gap report for a skill that may or may
  not exist yet (may or may not resolve to `target_skill`).
- `skill-success` — positive signal after a successful skill application.

Each schema is frozen in §5. Changes require a spec revision.

### AC2 — Example JSON bodies (copy-paste reference)

`skill-feedback`:

```json
{
  "type": "skill-feedback",
  "content": {
    "target_skill": "self-evolve",
    "sentiment": "negative",
    "category": "false-positive",
    "body": "Triggered on read-only doc edits; expected no-op.",
    "context": {
      "session_id": "abc123",
      "ai_identity": "claude-opus-4-7[1m]",
      "occurred_at": "2026-04-18T08:32:10Z",
      "parent_entry_id": 138442
    },
    "severity": "medium"
  },
  "tags": ["skill-feedback", "target:self-evolve", "sentiment:negative"]
}
```

`skill-request`:

```json
{
  "type": "skill-request",
  "content": {
    "target_skill": null,
    "request_kind": "new-skill",
    "title": "Rust cargo build troubleshooting",
    "body": "No skill exists for cargo build errors; would help with ...",
    "rationale": "Saw 3 cargo errors in past week, no skill fired.",
    "context": {
      "session_id": "abc123",
      "ai_identity": "user",
      "occurred_at": "2026-04-18T08:32:10Z"
    },
    "priority": "low"
  },
  "tags": ["skill-request", "kind:new-skill"]
}
```

`skill-success`:

```json
{
  "type": "skill-success",
  "content": {
    "target_skill": "investigate",
    "body": "Found root cause in 2 steps using the evidence-before-edit rule.",
    "context": {
      "session_id": "abc123",
      "ai_identity": "claude-opus-4-7[1m]",
      "occurred_at": "2026-04-18T08:32:10Z",
      "parent_entry_id": 138442
    }
  },
  "tags": ["skill-success", "target:investigate"]
}
```

### AC3 — POST /skills/feedback endpoint

- **Auth**: `validateApiKey()` → member role or above (same as `POST /store`).
- **Request body**:
  ```json
  {
    "type": "skill-feedback" | "skill-request" | "skill-success",
    "target_skill": "<sanitized name or null for skill-request>",
    "content": { ... },          // per §5 schema
    "tags": [ ... ]               // optional, server injects defaults
  }
  ```
- **Validation**:
  - `type` MUST be one of the three whitelisted values; 400 otherwise.
  - `target_skill` (when present) MUST pass `sanitizeSkillName()` from
    `scripts/lib/llm-parse.cjs`. 400 on fail.
  - Body size cap: `content.body` ≤ 4000 chars; 400 otherwise.
  - Existence check: for `skill-feedback` and `skill-success`, verify
    `target_skill` appears in `skill-registry`. Warning only (still
    accept — registry may be stale or partial), with `warn` field in
    response.
- **Response** (201 on success):
  ```json
  {
    "ok": true,
    "id": <entry_id>,
    "deduped": false,
    "warn": null
  }
  ```
- **Dedup**: reuse existing content-hash dedup. Identical body from
  same session → 200 with `deduped: true` (matches `POST /store`).

### AC4 — GET /skills/:name/feedback

- **Auth**: `validateApiKey()` → any authenticated role can read.
- **Query params**: `limit` (default 50, max 200), `type` (optional
  filter: `skill-feedback | skill-request | skill-success`),
  `sentiment` (optional filter), `since_id` (optional).
- **Response** (200):
  ```json
  {
    "skill": "<name>",
    "count": N,
    "entries": [
      {"id": ..., "type": "...", "content": {...}, "created_at": "..."}
    ],
    "next_cursor": <last_id_or_null>
  }
  ```
- **Ordering**: `ORDER BY id DESC` (newest first).
- **Scope**: matches `tags LIKE '%target:<name>%'` AND `type IN (3 types)`.

### AC5 — GET /skills/:name/health

Aggregate view for dashboards and `self-evolve`.

- **Auth**: `validateApiKey()` → any authenticated role.
- **Query params**: `window_days` (default 30, max 90).
- **Response** (200):
  ```json
  {
    "skill": "<name>",
    "window_days": 30,
    "counts": {
      "feedback": { "positive": N, "neutral": N, "negative": N },
      "requests": N,
      "success": N,
      "usage": N                  // from existing skill-usage
    },
    "feedback_score": 0.73,       // see §6 for formula
    "top_categories": [
      {"category": "false-positive", "count": 4},
      {"category": "unclear-trigger", "count": 2}
    ],
    "first_feedback_at": "...",
    "last_feedback_at": "..."
  }
  ```
- **Caching**: `feedback_score` is computed on-read, cached in-process
  for 5 min per skill name. See architecture §4.

### AC6 — self-evolve integration

`self-evolve` fitness function gains a new component **`feedback_score`**:

```
fitness = w1 * adoption_rate
        + w2 * triggered_change_rate
        + w3 * reduced_error_rate
        + w4 * user_approval_rate
        + w5 * freshness
        + w6 * feedback_score        ← NEW
        + bias_source(candidate.source)
```

- `w6` default: **OPEN: needs user decision.** Recommended start: `0.15`
  (steal equal parts from `w1` and `w4`, yielding
  `w1=0.20, w2=0.25, w3=0.20, w4=0.15, w5=0.10, w6=0.10`). Keep sum=1.0.
- `feedback_score` ∈ [0,1] per §6 formula (positive - negative,
  normalized, with volume damping).
- `skill-request` rows also feed `self-evolve` as a new Stream 7:
  `GET /recall?type=skill-request&after=<last_run>` → candidates for
  novel skills (source = `human_skill_request`, bias_source boost +0.05).
- Weights live in `data/evolution-config.json`. When the file is
  missing the new `w6` key, `self-evolve` MUST default `w6=0` and the
  other weights are renormalized (additive-backward-compatibility —
  existing cycles continue unchanged).

### AC7 — Dashboard card (design only)

New card "Skill Feedback" in the dashboard grid, added after
`skill-suggestion` card and before `Recent Entries`. Layout:

```
┌─ Skill Feedback (30d) ────────────────────────────┐
│ Top skills by feedback_score:                     │
│  1. investigate       +0.82  (18 pos, 2 neg)      │
│  2. quality-gate      +0.71  (12 pos, 3 neg)      │
│  3. supervisor-worker +0.55  (8  pos, 4 neg)      │
│                                                   │
│ Lowest feedback_score (needs review):             │
│  1. self-evolve       -0.31  (2  pos, 7 neg)      │
│                                                   │
│ Open requests: 5   (1 pending-patch generated)    │
└───────────────────────────────────────────────────┘
```

Powered by `GET /skills/effectiveness` (extended) + per-skill
`GET /skills/:name/health` (lazy on hover). No new dashboard endpoint
needed — aggregation happens server-side in the existing handler.

### AC8 — Moderation, rate-limit, spam

- **Rate limit**: max **20 feedback entries per session per skill per
  24h**, max **100 total per session per 24h**. Exceeded → HTTP 429.
- **Content-hash dedup**: reuses existing dedup path (handleStore
  behavior). Identical bodies collapse to one row.
- **Moderation gate**: new `status='pending-review'` when
  `content.body` contains flagged patterns (list in §7). These rows
  are stored but excluded from dashboard and `feedback_score` until
  an owner explicitly calls `POST /admin/approve-feedback/:id`.
- **Attribution required**: `session_id` + `ai_identity` both
  mandatory. Missing → 400. This creates traceable audit trail and
  discourages drive-by spam.
- **Bad-faith protection**: feedback entries where the **submitting
  session has no prior `skill-usage` for that skill in the last 7d**
  are flagged `context.low_signal=true`. Dashboard de-emphasizes
  (greys out); `feedback_score` weights them at 0.3x. Rationale:
  a session that never used the skill is less authoritative.

---

## 5. Content schemas (frozen)

### 5.1 `skill-feedback.content`

| Field | Type | Req? | Notes |
|---|---|---|---|
| `target_skill` | string | yes | Sanitized per `sanitizeSkillName()` |
| `sentiment` | `"positive"\|"neutral"\|"negative"` | yes | Explicit, no NLP |
| `category` | string | no | Free-form short tag (e.g., `false-positive`, `unclear-trigger`, `missing-case`, `too-verbose`, `outdated`) |
| `body` | string | yes | ≤ 4000 chars |
| `context.session_id` | string | yes | — |
| `context.ai_identity` | string | yes | `claude-opus-4-7[1m]`, `user`, etc. |
| `context.occurred_at` | ISO-8601 | yes | When the skill ran |
| `context.parent_entry_id` | int | no | Link to the `skill-usage` or `tool-use` entry that triggered this feedback |
| `severity` | `"low"\|"medium"\|"high"` | no | Defaults `low` |

### 5.2 `skill-request.content`

| Field | Type | Req? | Notes |
|---|---|---|---|
| `target_skill` | string\|null | no | Null for new-skill request |
| `request_kind` | `"new-skill"\|"improve-skill"\|"deprecate-skill"` | yes | — |
| `title` | string | yes | ≤ 120 chars |
| `body` | string | yes | ≤ 4000 chars |
| `rationale` | string | no | Why this request matters |
| `context.session_id` | string | yes | — |
| `context.ai_identity` | string | yes | — |
| `context.occurred_at` | ISO-8601 | yes | — |
| `priority` | `"low"\|"medium"\|"high"` | no | Defaults `low` |

### 5.3 `skill-success.content`

| Field | Type | Req? | Notes |
|---|---|---|---|
| `target_skill` | string | yes | Sanitized |
| `body` | string | yes | ≤ 4000 chars — what worked, why |
| `context.session_id` | string | yes | — |
| `context.ai_identity` | string | yes | — |
| `context.occurred_at` | ISO-8601 | yes | — |
| `context.parent_entry_id` | int | no | — |

---

## 6. `feedback_score` formula

```
  pos := count(skill-success, target=X, 30d)
       + count(skill-feedback, target=X, sentiment=positive, 30d)
  neg := count(skill-feedback, target=X, sentiment=negative, 30d)
  neu := count(skill-feedback, target=X, sentiment=neutral, 30d)
  vol := pos + neg + neu
  low_signal_discount := 0.3    # applied per-entry to low_signal rows

  raw := (pos_weighted - neg_weighted) / max(1, vol_weighted)
  # raw ∈ [-1, +1]

  # Volume damping via Laplace-style smoothing so tiny samples don't dominate
  damped := raw * vol / (vol + 5)

  # Map to [0, 1] for fitness compatibility
  feedback_score := (damped + 1) / 2
```

- `low_signal` entries (submitter had no prior usage in 7d) count at
  0.3x of a regular entry.
- Prior: 0.5 when `vol == 0` (neutral).
- Stored as `float` in health response, NOT persisted on the entry.

---

## 7. Moderation details

### 7.1 Auto-flagged patterns (→ `status=pending-review`)
- URLs that are not GitHub / docs (regex: `https?://[^ ]+` AND
  NOT `github.com|readthedocs|docs\.anthropic\.com|anthropic\.com|`
  AIOS-internal domains). Prevents phishing links in dashboard.
- Shell-command-like strings: `rm -rf`, `curl | sh`, `eval(`,
  `<script>`. Prevents prompt-injection of downstream processors.
- All-caps > 200 chars (shouting spam).
- Repeated character runs ≥ 30 (`aaaa...` junk).
- Body exactly matches a known-bad regex list (seeded empty; admins
  append via `POST /admin/moderation-rules`).

### 7.2 Owner approval
- `POST /admin/approve-feedback/:id` — owner-only, flips status from
  `pending-review` to `active`.
- `POST /admin/reject-feedback/:id` — owner-only, flips status to
  `rejected`. Row kept for audit.

---

## 8. Interaction with existing loops

| Loop | Today | Change under this spec |
|---|---|---|
| `infinite-skills` (PreToolUse hook) | emits `skill-usage` | **no change** — feedback is a separate downstream entry |
| `self-evolve` weekly | reads 6 input streams | adds Stream 7 (`skill-request`) + `w6 * feedback_score` |
| `skill-discovery` loop | web-searches for gaps | reads `skill-request` as a **seed list** for targeted searches |
| Dashboard reviewer | approves/rejects `pending-patch`, `pending-idea` | adds "Skill Feedback" card + `/admin/approve-feedback` workflow |
| `chunk-summary` | summarizes conversations | opt-in: summarizes feedback bodies > 1000 chars for dashboard |

---

## 9. Worked example (end-to-end scenario)

**Scenario**: `self-evolve` loop proposes a new skill `async-rust-patterns`.
Dashboard approves it → SKILL.md is written → `skill-registry` gains
the entry → routing table lights it up in sessions.

1. **T+0** — Next session, user asks an async Rust question.
   `infinite-skills` routing hits `async-rust-patterns`. Skill fires.
   Emits `skill-usage` with `{skills:["async-rust-patterns"], session:"s1"}`.

2. **T+5min** — Skill recommends `tokio::spawn` in a context where
   `std::thread::spawn` is correct. User notices, submits feedback:

   ```json
   POST /skills/feedback
   {
     "type": "skill-feedback",
     "target_skill": "async-rust-patterns",
     "content": {
       "target_skill": "async-rust-patterns",
       "sentiment": "negative",
       "category": "wrong-recommendation",
       "body": "Suggested tokio::spawn but request was for CPU-bound work. Should recommend rayon or std::thread here.",
       "context": {
         "session_id": "s1",
         "ai_identity": "user",
         "occurred_at": "2026-04-18T08:32:10Z",
         "parent_entry_id": 138442
       },
       "severity": "medium"
     }
   }
   ```

   Server stores with `tags=["skill-feedback","target:async-rust-patterns","sentiment:negative"]`.
   Response: `{"ok":true,"id":139010,"deduped":false}`.

3. **T+1h** — Second user hits same case, submits same-spirit negative
   feedback. Content differs enough (no dedup). `feedback_score` for
   `async-rust-patterns` now: 0 pos, 2 neg, 0 neu, vol=2, raw=-1.0,
   damped = -1.0 * 2/(2+5) = -0.286, → `feedback_score = 0.357`.

4. **T+next Sunday 07:00 JST** — `self-evolve` weekly cycle runs.
   Phase (b) Score re-computes fitness for `async-rust-patterns`:

   ```
   w1 * adoption_rate         = 0.20 * 0.40 = 0.080
   w2 * triggered_change_rate = 0.25 * 0.50 = 0.125
   w3 * reduced_error_rate    = 0.20 * 0.30 = 0.060
   w4 * user_approval_rate    = 0.15 * 0.50 = 0.075
   w5 * freshness             = 0.10 * 0.95 = 0.095
   w6 * feedback_score        = 0.10 * 0.36 = 0.036
   bias_source(upstream)      = 0.05
   fitness                    = 0.521
   ```
   Previously (pre-feedback): fitness ≈ 0.59. Drop of **-0.07** from
   feedback signal.

5. **Phase (c)** — Top-K selection. `async-rust-patterns` scored
   0.521, below top-K cutoff (0.55). NOT mutated. But still sits on
   the dashboard for owner review.

6. **T+next dashboard open** — Owner sees the "Skill Feedback" card
   with `async-rust-patterns` in red (lowest score). Drills in via
   `GET /skills/async-rust-patterns/health` → sees "2 negative:
   wrong-recommendation". Clicks "Generate improvement patch" →
   dashboard calls `/admin/request-patch?skill=async-rust-patterns&based_on=feedback`
   which creates a `skill-request` with `request_kind=improve-skill`.

7. **T+next Sunday** — Stream 7 picks up the `skill-request`.
   `skill-creator` + `skill-discovery` produce a new proposed
   SKILL.md that distinguishes I/O-bound vs CPU-bound patterns. Lands
   as `pending-patch` in the approval queue. Owner reviews diff,
   approves. File updates. Routing keywords refined.

8. **T+2 weeks** — Repeat sessions, feedback now shows
   `sentiment:positive` mostly. `feedback_score` climbs to 0.78,
   fitness back above 0.60, self-reinforcing loop closes.

**Outcome**: a single-user criticism drove a 2-week self-improvement
cycle without any human reading a log file. The skill got smarter
because humans **and** sub-agents could speak to it, and
`self-evolve` heard them.

---

## 10. Open questions

- **OPEN: needs user decision** — Should `w6` default to 0.10 (safe,
  additive) or 0.15 (stronger signal, reduces `w1`/`w4`)? Recommend
  0.10 for first 2 cycles, revisit after observing real feedback
  volume.
- **OPEN: needs user decision** — Should a single `sentiment=negative`
  with `severity=high` block auto-adoption entirely (hard gate), or
  just heavily penalize fitness (soft gate)? Recommend soft gate;
  safety-review should catch the truly unsafe cases.
- **OPEN: needs user decision** — Who bears ownership of
  `POST /admin/approve-feedback`? Recommend: same role as existing
  `/admin/approve-patch` (owner only).
- **OPEN: needs user decision** — Should `skill-request` from
  sub-agents carry different weight than from the human user? User
  directive was "みんなで" (everyone), suggesting equal weight. But
  the `low_signal` discount already gives humans a soft boost when
  they've actually used the skill. Recommend: no explicit weighting,
  rely on usage-based discount.

---

## 11. Phased implementation plan (code-free)

| Phase | Scope | Files touched | Risk | Duration | Owner |
|---|---|---|---|---|---|
| 1 | Whitelist 3 new types in `isValidType` comment + DEDUP_SKIP review (no-op — they dedup by content-hash) | `scripts/vcontext-server.js` (comment-only) | Low | 10min | later |
| 2 | POST `/skills/feedback` handler + validation + sanitizeSkillName hookup | `scripts/vcontext-server.js`, reuse `scripts/lib/llm-parse.cjs` | Low | 30min | later |
| 3 | GET `/skills/:name/feedback` + `/skills/:name/health` handlers + in-process 5min cache | `scripts/vcontext-server.js` | Medium | 45min | later |
| 4 | Moderation auto-flag + `/admin/approve-feedback/:id` + `/admin/reject-feedback/:id` | `scripts/vcontext-server.js` | Medium | 30min | later |
| 5 | `self-evolve` Stream 7 (skill-request gather) + `w6` in fitness function | `skills/self-evolve/SKILL.md`, `scripts/self-evolve.js`, `data/evolution-config.json` | Medium | 30min | later |
| 6 | Dashboard "Skill Feedback" card + data wiring | `scripts/vcontext-server.js` (HTML section) | Low | 45min | later |
| 7 | Rate-limit table + session-scoped counter (in-memory `Map`) | `scripts/vcontext-server.js` | Low | 20min | later |
| 8 | Docs: update `skills/self-evolve/SKILL.md` + `skills/infinite-skills/SKILL.md` + evolution-log entry | `skills/**/SKILL.md`, `docs/evolution-log.md` | Low | 20min | later |

**Total**: ≈ 4h10m across 8 phases. Each phase independently
deployable + revertible.

---

## 12. Verification (for the future implementation session)

- Round-trip test: `POST /skills/feedback` → `GET /skills/:name/feedback`
  returns the same row with correct `target:<name>` tag.
- Dedup test: same body twice from same session → second call returns
  `deduped:true`.
- Rate-limit test: 21 requests in < 24h from same session → 21st returns
  429.
- Moderation test: body containing `rm -rf /` → status=pending-review,
  excluded from health response; approve flips to active.
- self-evolve test: mock feedback with 5 neg / 0 pos for skill X →
  confirm fitness drops by at least `w6 * 0.25` vs baseline.
- Dashboard test: card renders without JS errors when 0 feedback rows
  exist (empty state).

---

## 13. Notes

- No new DB tables. All three types are `entries` rows distinguished
  by `type` + `tags`. This matches the existing pattern
  (`skill-suggestion`, `skill-registry`, `pending-patch` all share the
  same table).
- Content-hash dedup covers most accidental double-submits; rate limits
  cover malicious ones; moderation gates cover hostile content.
- The `low_signal` discount is a heuristic, not a hard filter. It
  preserves the directive "みんなで" — everyone can speak, but the
  system weights by demonstrated context.
- This spec does NOT prescribe client UI. `POST /skills/feedback` is
  the contract; whether it is called by a CLI, a hook, or a UI button
  is out of scope and can vary per AI client.
