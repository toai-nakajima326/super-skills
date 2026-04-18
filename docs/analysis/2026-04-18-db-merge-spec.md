# DB Merge Spec — consolidate `vcontext-primary.sqlite` + `vcontext-ssd.db`

**Date**: 2026-04-18
**Author**: claude (careful + guard + phase-gate stack)
**Status**: Phase 2 — SPEC ready, Phase 3 (execute) **DEFERRED** (LoCoMo full run in flight)

## Context

Today (commit `d621456`) the RAM-disk tier was migrated to SSD. After the
migration, two SSD-resident SQLite databases exist side-by-side:

| file                              | size   | rows   | role            |
|-----------------------------------|--------|--------|-----------------|
| `data/vcontext-primary.sqlite`    | 3.3 GB | 52,531 | hot/primary     |
| `data/vcontext-ssd.db`            | 4.1 GB | 96,330 | tier-2 archive  |

Both live on the same internal NVMe. The two-tier split was introduced to
separate RAM (`ramDb`) from SSD (`ssdDb`). After the RAM→SSD migration
the split is vestigial: both tiers are on the same block device, both go
through the same FS cache, both are backed up identically. The code
carries duplicate schema bootstrap, duplicate FTS triggers, and cascading
reads/writes across tiers that add complexity without measurable benefit.

User decision (approved 2026-04-18): consolidate into one
`data/vcontext.sqlite`, keep tier-migration code as a no-op, preserve all
endpoints and UI.

## Row counts (pre-merge)

```text
primary:   52,531 rows    (IDs 7..138,112)     — 35,900 with embedding
ssd:       96,330 rows    (IDs 1..142,567)     — 48,556 with embedding
ID overlap:         49,303 rows                 — SSD supersets primary IDs
unique primary:      3,228 rows (52,531 − 49,303)
unique ssd:         47,027 rows (96,330 − 49,303)
expected merged:    99,558 rows (ssd + unique-primary)
                    (before UNIQUE-hash dedup; see below)
```

Observation: primary (hot) is mostly a **subset** of SSD (archive). This
matches the design — after the RAM→SSD migration, the "hot" DB is a
rolling working set while SSD accumulates everything.

## Schema compatibility

`entries` table — **identical columns**:
```
id, type, content, tags, session, created_at, token_estimate,
last_accessed, access_count, tier, reasoning, conditions, supersedes,
confidence, status, embedding, content_hash, parent_id
```

**Difference — indexes**:
- primary has `UNIQUE uniq_entry_hash ON entries(session, type, content_hash)` (partial index excluding ephemeral types)
- ssd has non-unique `idx_ssd_dedup ON entries(type, content_hash)`

**Difference — auxiliary tables**:
- primary has `analytics`, `consultations` (hot-only)
- ssd lacks both

**Difference — whitespace-only**: `api_metrics`, `entry_index`, and FTS
triggers differ in formatting but are semantically identical.

**FTS5 & sqlite-vec**:
- `entries_fts*` tables live inside each DB and must be **rebuilt** after
  merge (`INSERT INTO entries_fts(entries_fts) VALUES('rebuild');`).
- `vec_entries*` lives in a separate file (`vcontext-vec.db`) — **untouched
  by merge**. IDs are preserved (via explicit INSERT with id), so the
  rowid→embedding mapping in vec DB stays valid.

## Merge strategy

1. Start from **primary's schema** (the newer, authoritative one,
   including `UNIQUE uniq_entry_hash`).
2. Copy all rows from primary first (they win on both ID collision and
   content-hash collision — primary is newer).
3. Copy rows from SSD using `INSERT OR IGNORE` with explicit `id` — this
   handles both ID collisions (skipped because primary already has them)
   and content-hash collisions (skipped because the UNIQUE partial index
   catches them — intended dedup behavior).
4. Dedup warning: SSD has 24,606 rows with duplicate (session, type,
   content_hash) tuples that primary's UNIQUE index would reject. These
   are older archived dups from before the dedup index existed. Skipping
   them via `INSERT OR IGNORE` is the intended outcome.
5. Rebuild FTS5 after load: `INSERT INTO entries_fts(entries_fts)
   VALUES('rebuild');`
6. `VACUUM` the merged DB once.
7. Verify before swap.

Predicted merged row count: **~75,000** (99,558 minus ~24,606 dedup
rejections minus collision overlap). We will report the actual count.

## Which DB wins on collision?

**Primary wins** for any id collision. Rationale:
- Primary is the live hot DB; its rows carry the most recent
  `last_accessed` / `access_count` / `status` fields.
- SSD rows for the same id are by definition older (they were promoted
  back up to RAM, so the SSD copy is stale).
- For rows that only exist in SSD (the 47k unique), we take SSD's row
  verbatim.

Content-hash collisions (same hash, different IDs) across primary/SSD:
resolved by `INSERT OR IGNORE` + UNIQUE partial index. First-inserted
wins → primary wins again.

## Acceptance criteria

| # | Check | Pass condition |
|---|-------|----------------|
| 1 | `sqlite3 data/vcontext.sqlite "SELECT COUNT(*) FROM entries"` | ≥ primary count (52,531), ≤ ssd+unique-primary (99,558) |
| 2 | `SELECT COUNT(*) FROM entries WHERE embedding IS NOT NULL` | ≥ primary's 35,900 |
| 3 | `/health` | `{"status":"healthy","database":true}` |
| 4 | `/stats` | total matches sqlite COUNT |
| 5 | `/recall?q=<known-archived-phrase>` | finds SSD-only entries |
| 6 | `/recall?q=<recent-phrase>` | finds hot entries |
| 7 | `/search/semantic?q=hello` | returns results |
| 8 | `/tier/stats` | no error; ram and ssd point at same unified DB |
| 9 | Dashboard loads without tier fields going red | visual check |
| 10 | `SELECT ... FROM entries_fts WHERE entries_fts MATCH ?` | FTS works |

## Rollback plan

If any verification fails:

1. Stop the server (`launchctl bootout`).
2. Restore `data/vcontext-primary.sqlite` from
   `data/vcontext-primary-premerge-<ts>.sqlite`.
3. Restore `data/vcontext-ssd.db` from
   `data/vcontext-ssd-premerge-<ts>.db`.
4. Revert `scripts/vcontext-server.js` edits (`git checkout HEAD -- scripts/vcontext-server.js`).
5. Start server; verify `/health`.
6. Delete `data/vcontext.sqlite` (the merge output).

Pre-merge backups (`*-premerge-*`) are **retained indefinitely** as a
safety net — do not delete even after successful verification.

## Code changes planned (Phase 3)

| change                                       | file                         | lines |
|---------------------------------------------|------------------------------|-------|
| `DEFAULT_DB_PATH` → `vcontext.sqlite`       | `scripts/vcontext-server.js` | 70    |
| `SSD_DB_PATH` → same as `DB_PATH` (no-op)   | `scripts/vcontext-server.js` | 77    |
| Keep `migrateRamToSsd()` — becomes no-op    | (idempotent by path equality) | —     |
| `/tier/stats` — report ssd.entries=0 when same path | `scripts/vcontext-server.js` | 2278 |

**Do NOT modify schema**. **Do NOT rip tier code out** — simplest is to
let `DB_PATH === SSD_DB_PATH` make every migration a self-insert that
gets IGNOREd by the UNIQUE index.

## Execution blocker — deferred to tomorrow

At the time of spec write (07:55 UTC), a **LoCoMo full-subset eval**
(request `a03fa6dd`) was 5 minutes into a run expected to last 40-60
minutes. Per user directive, executing the merge during LoCoMo would
either crash the eval (server stop) or starve it (read contention).
Phase 3 is deferred; merge script will be written on next attempt.

All analysis, counts, and strategy above are pre-computed and still
valid at retry time — only new data since spec write needs to be
re-accounted (a handful of rows — insignificant).

## Merge script outline (for retry)

```js
// scripts/merge-dbs.js — one-shot, idempotent, stop-on-error.
import Database from 'better-sqlite3';
const target = new Database('data/vcontext.sqlite');
const p = new Database('data/vcontext-primary.sqlite', { readonly: true });
const s = new Database('data/vcontext-ssd.db', { readonly: true });

// 1. Copy primary's schema via .dump-like approach
//    (use sqlite3 shell: VACUUM INTO 'data/vcontext.sqlite' from primary).
// 2. ATTACH 'data/vcontext-ssd.db' AS ssd;
//    INSERT OR IGNORE INTO main.entries (id, type, ...) SELECT ... FROM ssd.entries;
// 3. Rebuild FTS.
// 4. VACUUM.
// 5. COUNT + embeddings COUNT — print both.
```

Preferred approach: use `sqlite3` CLI with `VACUUM INTO` to clone primary
into `vcontext.sqlite` (which preserves all schema, indexes, triggers,
FTS tables), then ATTACH ssd and INSERT OR IGNORE. This avoids handcoding
the schema.
