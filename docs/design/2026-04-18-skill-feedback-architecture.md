# Architecture — Skill Feedback Loop

**Status**: Design — implementation in a later session
**Author**: main orchestrator, 2026-04-18 evening
**Companion spec**: `docs/spec/2026-04-18-skill-feedback-loop.md`
**Related**: `docs/policy/aios-infinite-skills-mandate.md`,
`skills/self-evolve/SKILL.md`, `scripts/vcontext-server.js`,
`scripts/lib/llm-parse.cjs`.

---

## 1. Data-flow diagram

```
                                                   ┌────────────────────────┐
                                                   │  AIOS Clients          │
                                                   │                        │
                                                   │  • User (CLI/UI)       │
                                                   │  • Claude Code session │
                                                   │  • Sub-agents          │
                                                   │  • Codex / Atlas       │
                                                   │  • Dashboard reviewer  │
                                                   └─────────┬──────────────┘
                                                             │
                                                             │  HTTPS  /  Bearer API key
                                                             │  JSON body (§5 spec)
                                                             ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │              vcontext-server.js  (localhost:3150)                │
       │                                                                   │
       │   POST /skills/feedback           ─── validates, sanitizes,       │
       │      │                                 rate-limits, moderates    │
       │      ▼                                                            │
       │   ┌──────────────────────┐                                        │
       │   │  validateApiKey()    │   401 on fail                          │
       │   │  hasRole('member')   │   403 on viewer                        │
       │   └──────────┬───────────┘                                        │
       │              │                                                    │
       │   ┌──────────▼──────────┐                                         │
       │   │ sanitizeSkillName() │   400 on unsafe name                    │
       │   │ (shared lib)        │                                         │
       │   └──────────┬──────────┘                                         │
       │              │                                                    │
       │   ┌──────────▼──────────┐                                         │
       │   │ rate-limit check    │   429 on exceed                         │
       │   │ (in-mem Map)        │                                         │
       │   └──────────┬──────────┘                                         │
       │              │                                                    │
       │   ┌──────────▼──────────┐                                         │
       │   │ moderation auto-flag│   status=pending-review or active       │
       │   └──────────┬──────────┘                                         │
       │              │                                                    │
       │   ┌──────────▼──────────┐                                         │
       │   │ content-hash dedup  │   return existing_id if match           │
       │   └──────────┬──────────┘                                         │
       │              │                                                    │
       │              ▼                                                    │
       │    INSERT INTO entries (type, content, tags, session,             │
       │      content_hash, status, parent_id)                             │
       │    tags += [target:<name>, sentiment:<s>, skill-feedback]         │
       │                                                                   │
       │                       ┌────────────────────┐                      │
       │                       │  RAM SQLite        │                      │
       │                       │  /Volumes/VContext │                      │
       │                       │                    │                      │
       │                       │ async write-through│                      │
       │                       │         ▼          │                      │
       │                       │  SSD SQLite (mirror)                      │
       │                       └────────────────────┘                      │
       │                                                                   │
       │   GET /skills/:name/feedback    ──── list by tag                  │
       │   GET /skills/:name/health      ──── aggregate + cache            │
       │   POST /admin/approve-feedback  ──── owner moderation flip        │
       └──────────────────────────────────┬────────────────────────────────┘
                                          │
                       ┌──────────────────┼──────────────────┐
                       │                  │                  │
                       ▼                  ▼                  ▼
             ┌──────────────────┐ ┌──────────────┐ ┌────────────────────┐
             │  self-evolve     │ │  Dashboard   │ │  skill-discovery   │
             │  weekly cycle    │ │  card: Skill │ │  loop seeds from   │
             │                  │ │  Feedback    │ │  skill-request rows│
             │  Stream 7:       │ │  (30d view)  │ │                    │
             │    skill-request │ │              │ │  Input stream in   │
             │    → candidates  │ │  GET /skills/│ │  Phase (a) Gather  │
             │                  │ │    effective │ │                    │
             │  Fitness:        │ │    ness (ext)│ │                    │
             │   + w6 *         │ │              │ │                    │
             │     feedback_    │ │  + lazy GET  │ │                    │
             │     score        │ │    :name/    │ │                    │
             │                  │ │    health    │ │                    │
             └──────────────────┘ └──────────────┘ └────────────────────┘
```

Legend:
- Solid arrows = synchronous request/response.
- All persistence flows through `handleStore()` shape — no new DB path.
- Consumers read via `GET /recall?type=<t>` or their new direct
  endpoints.

---

## 2. Entries table — no new schema

The existing `entries` table already supports all three new types. No
migration required.

Relevant existing columns (from `scripts/vcontext-server.js`):

| Column | Used by feedback loop |
|---|---|
| `id` | PK; returned in response |
| `type` | `skill-feedback` \| `skill-request` \| `skill-success` |
| `content` | JSON per §5 of spec |
| `tags` | `["skill-feedback","target:<name>","sentiment:<s>"]` |
| `session` | submitter session (for rate-limit + low_signal check) |
| `token_estimate` | auto-computed by handleStore |
| `content_hash` | auto-computed, enables dedup |
| `tier` | `ram` on insert (migrates per existing overflow rule) |
| `status` | `active` \| `pending-review` \| `rejected` |
| `reasoning` | optional auto-summary from MLX |
| `parent_id` | optional link to `skill-usage` or `tool-use` ancestor |
| `created_at` | auto |

**No ALTER TABLE is needed.** The existing `status` column (used today
for `migrated`/`active`) already supports `pending-review`.

### 2.1 Indexes

Existing indexes sufficient:
- `idx_entries_type` — covers `WHERE type='skill-feedback'` scans.
- `idx_entries_session_id` — covers rate-limit window queries.
- `idx_entries_content_hash` — covers dedup.

One **potential** new index (defer until hit rate justifies it):
- `idx_entries_tags_target` — GIN-like on tag substring. NOT needed
  at v1 — `tags LIKE '%target:<name>%'` is fine for < 10k feedback
  rows (SQLite's FTS handles this well via `entries_fts` already).

---

## 3. SQL queries (aggregation)

### 3.1 Per-skill list (backs `GET /skills/:name/feedback`)

```sql
SELECT id, type, content, created_at, status
  FROM entries
 WHERE type IN ('skill-feedback','skill-request','skill-success')
   AND tags LIKE '%"target:' || :name || '"%'
   AND (status IS NULL OR status = 'active')
   AND (:since_id IS NULL OR id > :since_id)
   AND (:type_filter IS NULL OR type = :type_filter)
 ORDER BY id DESC
 LIMIT :limit;
```

Note: `tags` is stored as JSON string `["skill-feedback","target:X","sentiment:negative"]`.
The `"target:` prefix pattern (with leading `"`) exactly matches the
JSON boundary, avoiding false positives on skill-name prefixes.

### 3.2 Counts for `/health`

```sql
-- positive / neutral / negative feedback counts
SELECT
  SUM(CASE WHEN type='skill-feedback'
           AND json_extract(content,'$.sentiment')='positive' THEN 1 ELSE 0 END) AS pos_fb,
  SUM(CASE WHEN type='skill-feedback'
           AND json_extract(content,'$.sentiment')='neutral'  THEN 1 ELSE 0 END) AS neu_fb,
  SUM(CASE WHEN type='skill-feedback'
           AND json_extract(content,'$.sentiment')='negative' THEN 1 ELSE 0 END) AS neg_fb,
  SUM(CASE WHEN type='skill-success' THEN 1 ELSE 0 END) AS success_cnt,
  SUM(CASE WHEN type='skill-request' THEN 1 ELSE 0 END) AS request_cnt,
  MIN(created_at) AS first_at,
  MAX(created_at) AS last_at
  FROM entries
 WHERE type IN ('skill-feedback','skill-request','skill-success')
   AND tags LIKE '%"target:' || :name || '"%'
   AND (status IS NULL OR status = 'active')
   AND created_at >= datetime('now', '-' || :window_days || ' days');
```

### 3.3 `skill-usage` count (existing skill, 30d)

```sql
SELECT COUNT(*) AS usage_cnt
  FROM entries
 WHERE type = 'skill-usage'
   AND content LIKE '%"' || :name || '"%'
   AND created_at >= datetime('now', '-' || :window_days || ' days');
```

### 3.4 Top categories

```sql
SELECT json_extract(content,'$.category') AS cat, COUNT(*) AS cnt
  FROM entries
 WHERE type = 'skill-feedback'
   AND tags LIKE '%"target:' || :name || '"%'
   AND json_extract(content,'$.category') IS NOT NULL
   AND (status IS NULL OR status = 'active')
   AND created_at >= datetime('now', '-' || :window_days || ' days')
 GROUP BY cat
 ORDER BY cnt DESC
 LIMIT 5;
```

### 3.5 low_signal determination (per-entry lookup)

```sql
-- Did this submitter use this skill in the 7 days BEFORE their feedback?
SELECT COUNT(*) AS usage_cnt
  FROM entries
 WHERE type = 'skill-usage'
   AND session = :submitter_session
   AND content LIKE '%"' || :target_skill || '"%'
   AND created_at BETWEEN datetime(:feedback_created_at, '-7 days')
                      AND :feedback_created_at;
```
If `usage_cnt = 0` → `low_signal = true`, discount weight 0.3x.

### 3.6 Rate-limit check (in-memory preferred)

Primary path: in-process `Map<session_id, { total: int, per_skill: Map<name, int>, window_start: ts }>`.

SQL fallback (if server restarted mid-window):
```sql
SELECT COUNT(*) AS cnt
  FROM entries
 WHERE type IN ('skill-feedback','skill-request','skill-success')
   AND session = :session_id
   AND created_at >= datetime('now', '-1 day');
```

---

## 4. Caching strategy

### 4.1 Writes: no cache
Writes go straight through `handleStore()` path. No buffering — matches
existing `POST /store` behavior.

### 4.2 Reads: two-tier

**Tier 1 — `/skills/:name/feedback` list endpoint**: no cache. SQLite
FTS on `entries` is fast enough (<5ms for ≤10k rows per skill). Adds
no complexity.

**Tier 2 — `/skills/:name/health` aggregate**: in-process LRU cache,
5-minute TTL, keyed on `(name, window_days)`.

```
cacheKey = `${name}:${window_days}`
cache.get(cacheKey) → hit return
else → run 4 queries (§3.2, §3.3, §3.4, low_signal pass), compute
     feedback_score, set cache, return
cache size cap = 256 entries (most-used skills); evict LRU
```

Invalidation: **passive**. TTL handles staleness. A 5-min delay between
a new feedback row and its effect on the dashboard score is acceptable;
trading freshness for read-throughput at the dashboard.

Active invalidation (optional, v2): on `POST /skills/feedback`, invalidate
cache for the target skill. Simple one-line change if needed later.

### 4.3 self-evolve: no cache needed
Runs once a week. Recomputes from scratch every cycle. The 5-min
health cache is irrelevant at this cadence.

---

## 5. Interaction with existing subsystems

### 5.1 `skill-registry`
- `skill-registry` is the **source of truth** for skill names.
- `POST /skills/feedback` validates `target_skill` against registry via
  a single `SELECT 1 FROM entries WHERE type='skill-registry' AND content LIKE '%"name":"<X>"%' LIMIT 1;`.
- Mismatch → 200 with `warn: "skill not in registry"` (accept anyway —
  registry may lag). This is the spec §AC3 "warning only" behavior.
- **No mutation** of `skill-registry` from this loop. Registry remains
  single-writer (skill creator / upstream sync).

### 5.2 `skill-usage`
- Unchanged. Emitted by the PreToolUse hook as today.
- The feedback loop **reads** `skill-usage` for:
  1. `/health` endpoint `counts.usage` field.
  2. `low_signal` determination (§3.5).
  3. `self-evolve` `adoption_rate` component (unchanged).

### 5.3 `skill-suggestion`
- Unchanged. MLX-generated suggestions still flow into `self-evolve`
  Phase (a) Stream 2 (existing).
- `skill-request` (the human-facing analog) is a **separate stream**
  (Stream 7). They never conflict — different sources, different
  confidence priors.

### 5.4 `pending-patch`
- Unchanged. Remains the single approval surface.
- New indirect consumer: dashboard "Generate improvement patch"
  button (spec §9 step 6) creates a `skill-request` which becomes a
  Stream 7 input, which — if it wins top-K — lands as a new
  `pending-patch`. Human approval gate remains intact.

### 5.5 `chunk-summary`
- Unchanged. May opt-in to summarize feedback bodies > 1000 chars
  (spec §8 table).

### 5.6 `self-evolve`
- New Stream 7 in Phase (a) Gather:
  `GET /recall?type=skill-request&after=<last_run>`.
- New fitness weight `w6`. Config loader must handle missing key
  (default 0, renormalize — backward-compatible with existing
  `data/evolution-config.json` files).
- Per-skill `feedback_score` fetched via direct DB query in the
  score phase (no HTTP round-trip — same process).
- Log lines: evolution-log.md gains a new section per candidate:
  `feedback_score: 0.37 (pos:5, neg:8, neu:2, low_signal:3)`.

---

## 6. Security review (Phase 3 of task)

Apply the `security-review` skill across every input path.

### 6.1 Input validation

| Input | Validation | Reference |
|---|---|---|
| `target_skill` | `sanitizeSkillName()` from `scripts/lib/llm-parse.cjs` (commit `cfcacd9`). Allowlist: `[a-z0-9][a-z0-9-]{1,63}`. Rejects path traversal, shell metachars, `..`. | spec §AC3 |
| `type` | Strict whitelist of 3 values. | spec §AC1 |
| `sentiment` | Enum check. | spec §5.1 |
| `content.body` | Length cap 4000. UTF-8 normalization before hash. | spec §AC3 |
| `context.session_id` | Non-empty string; existing `esc()` quoting in SQL. | handleStore |
| `context.ai_identity` | Non-empty string; ≤ 120 chars. | new |
| `tags` | Array of strings; server prepends trusted defaults. Client-provided tags sanitized for JSON-injection (JSON.stringify). | handleStore pattern |

### 6.2 Rate limits

- **Per session per skill per 24h**: 20. Prevents a single
  compromised session from drowning the signal for one skill.
- **Per session total per 24h**: 100. Prevents a single session
  from drowning the signal across all skills.
- **Global per 24h**: not enforced at v1. If AIOS gains external
  clients, add global cap (default 10k/day). Track via counter
  reset on `window_start < now - 24h`.
- **Response on exceed**: HTTP 429 with `Retry-After: <secs>`.
- **Implementation**: in-process `Map` + hourly persistence to SSD
  in case of restart. Same pattern as existing MLX throttle.

### 6.3 Attribution

- `session_id` **required** in content AND mapped to DB `session`
  column. Double-write so a content-only spoof still diverges from
  the DB-level session and can be audited.
- `ai_identity` **required**. Signed-in user vs `claude-opus-4-7[1m]`
  vs `codex-gpt-5` — all first-class. Stored in content only (no
  DB column). Dashboard surfaces counts by identity.
- Mandate: `docs/policy/aios-infinite-skills-mandate.md` already
  requires sub-agent prompts to carry session context. Feedback
  loop reuses the same envelope.

### 6.4 Spam mitigation

Layered defense (weakest-first):

1. **Content-hash dedup** (handleStore existing path): identical
   bodies from same session → collapsed to existing row. Near-zero
   overhead.
2. **Rate limits** (§6.2): caps adversarial volume.
3. **Moderation auto-flag** (spec §7.1): URL/shell/shouting detector
   sets `status=pending-review`. Not visible in dashboard or
   `feedback_score` until owner approves.
4. **low_signal discount** (spec §AC8): submissions without prior
   usage weighted at 0.3x. Reduces value of drive-by spam without
   blocking legitimate first-time users.
5. **Owner moderation endpoints**: `/admin/approve-feedback/:id` +
   `/admin/reject-feedback/:id`. Both owner-only, both logged.

### 6.5 Moderation gate — how bad-faith content is blocked from dashboard

1. On POST, regex scan per §7.1 of spec.
2. Match → `status='pending-review'`.
3. `GET /skills/:name/feedback` SQL includes `AND (status IS NULL OR status = 'active')` — pending-review rows invisible.
4. `GET /skills/:name/health` aggregation identical filter — zero
   fitness impact.
5. Owner dashboard gets a separate card "Pending review" (out of
   scope tonight but planned in spec §11 Phase 4).
6. Owner POSTs `/admin/approve-feedback/:id` → status → `active`,
   row visible. Cache invalidated.
7. Rejected rows retained for audit (`status='rejected'`), never
   surfaced.

### 6.6 Path traversal / SQL injection

- `sanitizeSkillName()` + `assertSkillPathSafe()` cover file-path
  risks (no file writes from this loop, but defense in depth).
- All SQL composed via existing `esc()` helper in
  `scripts/vcontext-server.js`. No string concat of user input into
  SQL. New `:name` queries (§3.1-§3.4) MUST use the same esc'd
  params; NO template interpolation of untrusted `name`.
- `json_extract()` on content fields is safe — SQLite parses.

### 6.7 Observability

- Every `POST /skills/feedback` logs:
  `[skill-feedback] session=<s> identity=<i> target=<n> sentiment=<s> status=<s> id=<id>`
- Every moderation flag logs:
  `[moderation] auto-flagged id=<id> reason=<rule>`
- Every rate-limit rejection logs:
  `[rate-limit] 429 session=<s> target=<n> count=<c>/<cap>`
- Metrics exposed via existing `/metrics/report` under new operation
  key `skill-feedback.submit`.

### 6.8 Known residual risks (accepted)

- **Content poisoning**: a nuanced negative feedback that does NOT
  match spam patterns still penalizes fitness. Mitigation: owner
  dashboard review on low feedback_score drops; manual
  `/admin/reject-feedback/:id`.
- **Collusion**: N sessions from same user could stack feedback.
  Mitigation: session count per unique `user:` tag surfaced in
  health response; dashboard warning if fewer unique users than
  expected (heuristic).
- **Registry lag**: feedback on a just-added skill may fail existence
  check. Mitigation: accept with `warn`, don't 400.

---

## 7. Failure modes and fallback

| Failure | Detected by | Fallback |
|---|---|---|
| vcontext write path broken | `handleStore` throws | return 503, client retries (existing behavior) |
| RAM SQLite full | existing `checkDbSize()` | 507, tier migration handles |
| Moderation regex misfire | owner review | `/admin/approve-feedback/:id` |
| `self-evolve` gets empty stream | zero-row Phase (a) | `feedback_score` prior = 0.5, fitness unchanged |
| Cache poisoning | 5-min TTL | self-heals within 5 min |
| Rate-limit map lost on restart | SQL fallback (§3.6) | first few submits bypass the in-mem counter but DB query catches |

---

## 8. Phased rollout (mirrors spec §11)

See spec §11 for the full phase table. Architecture note:

- **Phase 1-4** are vcontext-server-local changes. Can ship without
  any dashboard or self-evolve work.
- **Phase 5** (self-evolve) can ship independently after Phase 1-4
  — data already flowing by then.
- **Phase 6** (dashboard card) is purely client-side HTML + fetch.
- **Phase 7** (rate limit) can actually ship before Phase 2 if we
  want belt-and-suspenders (generic per-session limit is independent
  of endpoint shape).

---

## 9. Verification mapping (spec → architecture)

| Spec AC | Architecture support |
|---|---|
| AC1 (3 types) | §2 schema — no table change; §3.1 query by type filter |
| AC2 (JSON bodies) | §3.1 SQL confirms round-trip shape |
| AC3 (POST endpoint) | §1 diagram pipeline; §6.1 validation table |
| AC4 (GET feedback) | §3.1 query; §4.2 no cache |
| AC5 (GET health) | §3.2-§3.4 queries; §4.2 cache |
| AC6 (self-evolve integration) | §5.6 Stream 7 + w6 |
| AC7 (dashboard card) | §1 bottom-right consumer; existing handler extension |
| AC8 (moderation/rate-limit/spam) | §6.2-§6.5 layered defense |

---

## 10. Size

- Spec doc: ~430 lines (companion file).
- This architecture doc: ~370 lines (this file).
- Total design budget < 800 lines. All code-free. No binary.

---

## 11. What this doc does NOT cover

- Server code. No diff to `scripts/vcontext-server.js` tonight.
- Dashboard HTML. The card is sketched in the spec; actual markup
  ships in Phase 6.
- Client SDK. Any AIOS client can use `curl` or `fetch` against the
  documented endpoints; no SDK needed at v1.
- Test harness. Implementation session will add unit tests against
  the three types + mock rate-limit window.
