# True Loose-Coupling Redesign (option A) — spec

**Status**: PROPOSAL, not yet implemented.
**Decision tier**: HITL **H3** (architectural direction). User has
indicated preference for this path; today committed a localized
bandaid (cmdIntegrity → backup copy) while this spec is drafted.

---

## The insight that drove this

User, 2026-04-20 late afternoon, after I proposed a 24-hour throttle
on integrity_check as a fix:

> 疎結合になってないですね  (it's not loosely coupled, is it?)

And shortly after:

> checkが走るのは普通のことですが、ロックするのはおかしい  
> (checks running is normal — LOCKING is what's wrong)

Both correct.

Today's "backup is a separate process" refactor (commit `fe1c0c1`) moved
the doBackup() call OUT of the Node event loop — a genuine win for
server responsiveness — but it kept the **shared-resource coupling**:
backup.sh, maintenance.sh, and watchdog.sh all open `primary.sqlite`
directly via `sqlite3` CLI. The coupling is via SQLite file locks, not
via the process boundary. A stuck CLI reader = frozen WAL = server
slowness. Observed today: `sqlite3 ... PRAGMA integrity_check` ran for
1h 59m holding a snapshot; live WAL grew to 3.07 GB.

**Process-separated but resource-shared is not loose coupling. It's the
same monolith with extra processes.**

---

## What true loose coupling looks like

```
                    ┌────────────────────────────────────┐
                    │  vcontext-server (SOLE owner of    │
                    │  primary.sqlite)                   │
                    │                                    │
                    │  HTTP admin endpoints:             │
                    │   • POST /admin/backup             │
                    │   • POST /admin/integrity-check    │
                    │   • POST /admin/wal-checkpoint     │
                    │   • POST /admin/verify-backup      │
                    │                                    │
                    │  Internal scheduler:               │
                    │   • WAL truncate per maintenance   │
                    │   • Self rate-limits heavy ops     │
                    └────────────────────────────────────┘
                               ▲
                               │ HTTP contract only
                               │ (no SQLite file access)
         ┌─────────────────────┼──────────────────────┐
         │                     │                      │
  ┌─────────────┐      ┌──────────────┐       ┌──────────────┐
  │ backup.sh   │      │maintenance.sh│       │ watchdog.sh  │
  │ (thin)      │      │ (thin)       │       │ (thin)       │
  │             │      │              │       │              │
  │ curl POST   │      │ curl POST    │       │ curl GET     │
  │ /admin/bkup │      │ /integrity   │       │ /health      │
  └─────────────┘      └──────────────┘       └──────────────┘
```

Key invariants:

1. **The server owns `primary.sqlite` exclusively.** No other process
   opens the file. Period. This is enforced by code review, not by a
   runtime lock — any new script that does `sqlite3 primary.sqlite …`
   is a bug that must be redirected through the server.

2. **Contract = HTTP + JSON** (per AIOS Constitution §P2). External
   processes know the API shape from `docs/schemas/vcontext-api-v1.yaml`
   (already extracted today, commit `4dac939`), not from the storage
   layout.

3. **The server can refuse**: a heavy op (integrity_check, backup) runs
   at the server's own discretion. Rate-limiting, coalescing, and
   scheduling happen internally. If a caller requests too fast, server
   returns `429 Too Many Requests` with a `retry-after` — no zombie
   processes possible.

4. **Failure isolation**: a misbehaving thin client (hang, memory
   blow-up, killed mid-request) affects only its own HTTP connection.
   No file-level blast radius.

---

## Concrete changes

### Server-side (`scripts/vcontext-server.js`)

Three new admin endpoints:

```
POST /admin/integrity-check       (was: external sqlite3 via cmdIntegrity)
  request  : { target?: "primary" | "backup", ram_ok?: bool }
  response : { status: "ok"|"fail"|"skipped", target, message,
               ran_at, duration_ms }
  auth     : admin role
  internal :
    - reuses the server's existing ramDb / ssdDb handle
    - uses read-only snapshot via `BEGIN CONCURRENT` or a dedicated
      read connection, so the main writer is not blocked
    - rate-limited to 1/hour per target (in-memory last-run stamp)
    - async: returns immediately with a job id; GET /admin/job/:id
      to poll if the integrity takes >5 s

POST /admin/backup
  request  : { target_label?: string, include_wal?: bool }
  response : { status, path, size_bytes, integrity, elapsed_ms }
  auth     : admin role
  internal :
    - calls ramDb.backup(tmpPath) (better-sqlite3 API — already used
      in the current doBackup())
    - manages atomic rename + .bak rotation (same safety gates as
      current doBackup)
    - never leaves .tmp-wal orphans (cleanupBackupTmp helper)
    - rate-limited to 1/5min (backup.sh calls every 15 min anyway)

POST /admin/wal-checkpoint
  request  : { mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" }
  response : { status, busy, log, checkpointed }
  auth     : admin role
  internal :
    - calls ramDb.pragma('wal_checkpoint(${mode})')
    - no rate-limit (cheap call; repeated calls are idempotent)
```

### Thin-client refactor

`scripts/backup.sh` becomes a ~15-line HTTP caller:

```bash
set -eu -o pipefail
LABEL="$(date '+%Y%m%d-%H%M')"
RESP=$(curl -sS -m 600 -X POST \
  -H "X-Vcontext-Admin: yes" \
  -H "Authorization: Bearer $(cat ~/skills/data/.vcontext-admin-token)" \
  -H "Content-Type: application/json" \
  -d "{\"target_label\":\"$LABEL\"}" \
  http://127.0.0.1:3150/admin/backup)
echo "$RESP" | tee -a /tmp/vcontext-backup-external.log
```

No `sqlite3` CLI. No file-lock worries. No zombies possible.

`scripts/vcontext-maintenance.sh` similarly: swap `$NODE $HOOK integrity`
for `curl POST /admin/integrity-check`. The hook's `cmdIntegrity` stays
only as a fallback / emergency tool.

`scripts/vcontext-hooks.js cmdIntegrity` deprecated in favor of the
server endpoint; kept for manual use (`node vcontext-hooks.js integrity`).

### Security

All three endpoints require existing admin role (see OpenAPI spec).
`X-Vcontext-Admin: yes` header already gates `/admin/*`. Admin bearer
token is file-stored at `~/skills/data/.vcontext-admin-token` (same
pattern as existing admin operations). Read-only for the thin clients.

---

## Migration plan

Ship in 3 reversible stages so no single commit lands a monolithic
rewrite.

### Stage 1 (today bandaid, already shipped in this commit)
- `cmdIntegrity` now targets `vcontext-backup.sqlite`, not primary.
- `cmdIntegrity` no longer `process.exit(1)` on failure — maintenance
  continues with other tasks.

Lock risk remains (backup-vs-maintenance interleaving) but is
bounded: if the backup file is being overwritten by `backup.sh`, the
integrity check will see a transient malformed state, log failure
softly, and move on. Server is untouched.

### Stage 2 (half day, next session)
- Add `POST /admin/integrity-check` to server.js. Initially it runs
  via `spawnSync('sqlite3', …)` against the backup file just like
  cmdIntegrity does now — equivalent semantics, different caller
  identity. This lets us switch maintenance.sh over without changing
  code logic.
- `maintenance.sh` calls the HTTP endpoint. `hooks.js cmdIntegrity`
  stays for `node vcontext-hooks.js integrity` manual use.

### Stage 3 (half day, following session)
- Add `POST /admin/backup` that calls `ramDb.backup()` directly.
- `backup.sh` reduces to the 15-line HTTP caller above.
- Remove `sqlite3 .backup` from the script entirely.
- `cleanupBackupTmp` + `BACKUP_TIMEOUT_S` become obsolete —
  can't-zombie-a-request-over-HTTP.

### Stage 4 (quarter day, final polish)
- Add `POST /admin/wal-checkpoint` for parity.
- Delete any remaining sqlite3-CLI-against-primary patterns in
  scripts/.

---

## Acceptance criteria

- [ ] External `sqlite3 primary.sqlite …` pattern has **zero matches**
      in `scripts/`, `~/Library/LaunchAgents/*.plist`, and crontab.
- [ ] After 24h of operation, no orphan `sqlite3` process has
      accumulated anywhere (verified via `pgrep -lf sqlite3`).
- [ ] Primary WAL file mtime + size stays bounded: size never exceeds
      500 MB between maintenance cycles; mtime flips at least every
      15 min (indicating auto-checkpoint is working).
- [ ] Every admin endpoint emits a structured event to `entries` with
      type `admin-op` so the dashboard / metrics card shows call rates.
- [ ] `docs/schemas/vcontext-api-v1.yaml` updated to describe the
      three new endpoints.

---

## Open questions (for HITL H3)

1. **Auth propagation**: does the admin token handoff to background
   LaunchAgents (backup.sh, maintenance.sh) via an env var acceptable
   to the user? Or should we introduce a distinct "local-only" role
   that trusts loopback connections without a bearer?
2. **Asynchronous response shape**: if the server does a 10-min
   integrity on a large future DB, does the HTTP caller block or
   poll? Proposal: `202 Accepted` + job id for ops > 5 s. User
   preference?
3. **Rate-limit visibility**: where does the "next allowed at" info
   get surfaced? Dashboard card, `/admin/status`, or just header on
   429?

---

## Why this wasn't done today

Time-box. Today was already 17 commits long. A monolithic
"everything-through-server" refactor in the middle of an already-
volatile session risked introducing more bugs than it fixed. Staging
it over 4 small commits over the next few sessions is safer and
keeps each change auditable.

The bandaid (cmdIntegrity → backup) lets us sleep tonight without the
morning's 3 GB WAL recurrence, while this spec preserves the
architectural intent for when we resume.

*— co-drafted with user 2026-04-20 after the "it's not loosely coupled"
pushback.*
