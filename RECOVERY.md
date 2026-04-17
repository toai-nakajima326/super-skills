# vcontext Recovery Runbook

Cold-start and failure recovery procedures.  Every step is idempotent —
running twice is safe.

---

## Normal cold start (after power off / reboot)

Nothing to do by hand. LaunchAgents bring everything back automatically in
this order (all under `~/Library/LaunchAgents/com.vcontext.*.plist`):

1. `com.vcontext.ramdisk`    — creates 6 GB RAM disk at `/Volumes/VContext`
2. `com.vcontext.mlx-embed`  — Python server on `127.0.0.1:3161`
3. `com.vcontext.mlx-generate` — Python server on `127.0.0.1:3162`
4. `com.vcontext.server`     — Node server on `127.0.0.1:3150`
5. `com.vcontext.watchdog`   — health monitor
6. `com.vcontext.maintenance` — cron-style tasks
7. `com.vcontext.morning-brief` — daily 09:00 notification

First request may take 10–60 s while MLX loads the models.  Verify with
`bash scripts/smoke-test.sh` (expect 20/20 pass).

---

## If RAM DB is corrupt on boot (`database disk image is malformed`)

Auto-handled by `checkAndRecoverDb()` on server startup:

1. `PRAGMA quick_check` fails → skip to recovery.
2. `sqlite3 .recover` salvages every raw entry it can read from the
   corrupt file to `/tmp/vcontext-salvage-<ts>.db`.
3. Move the corrupt DB aside as `vcontext.db.corrupt.<ts>`.
4. Copy the latest file from `data/snapshots/*.db` into place.
5. Attach the salvage file and `INSERT OR IGNORE` unique rows back.

Log tag: `[db-recovery]`.  Verified on 1.8 GB DB in 32 s with zero data
loss (see `docs/analysis/2026-04-17-recovery-e2e-verification.md`).

---

## If both SQLite DBs are gone (catastrophic)

Rebuild from the append-only JSONL log:

```
# Start a fresh RAM disk + empty DB
bash scripts/vcontext-setup.sh stop
bash scripts/vcontext-setup.sh start

# (Server will boot with an empty DB)
bash scripts/vcontext-reload.sh

# Replay raw entries from data/entries-wal.jsonl
curl -X POST http://localhost:3150/admin/replay-wal
```

The WAL file lives on SSD (not RAM disk) — survives the RAM disk being
recreated.  Replay is INSERT-OR-IGNORE by id, so repeat runs are safe.

---

## If server won't start — SyntaxError or crash loop

Symptom: `/tmp/vcontext-server.log` shows `SyntaxError` or repeated
`[wrapper] Server exited with code 1, restarting in 2s...`

```
cd ~/skills

# 1. Find the broken file
node -c scripts/vcontext-server.js

# 2. If dashboard only, check JS parse separately
node --check scripts/vcontext-dashboard.html  # wrapper won't parse .html,
                                               # but the smoke test does it
npm test

# 3. Revert last commit if unsure
git log --oneline -5
git revert HEAD
bash scripts/vcontext-reload.sh
```

---

## If watchdog is restarting a service in a loop

Common cause: memory threshold too tight for the MLX model's working set.

```
# Check watchdog log
tail -50 /tmp/vcontext-watchdog.log | grep restart

# If MLX Generate keeps getting killed: raise the threshold via env
#  (edit ~/Library/LaunchAgents/com.vcontext.watchdog.plist,
#   add <key>EnvironmentVariables</key> dict with VCONTEXT_MLX_GEN_MAX_MB)
launchctl unload ~/Library/LaunchAgents/com.vcontext.watchdog.plist
launchctl load  ~/Library/LaunchAgents/com.vcontext.watchdog.plist
```

---

## If MLX Embed is returning 200 on /health but embeddings time out

This is the 2026-04-17 deadlock pattern.  Kill + launchd will restart:

```
kill -9 $(pgrep -f mlx-embed-server)
# wait ~50s for model to reload
until curl -sf -X POST http://127.0.0.1:3161/api/embeddings \
        -H 'Content-Type: application/json' \
        -d '{"prompt":"ping","model":"mlx-community/Qwen3-Embedding-8B-4bit-DWQ"}' >/dev/null; do sleep 5; done
```

---

## If RAM disk fills up (>95%)

Watchdog does emergency cleanup automatically (wal_checkpoint TRUNCATE +
corrupt-DB removal).  If that's not enough:

```
# Force migrate old entries RAM → SSD
curl -X POST http://localhost:3150/tier/migrate

# Nuclear option: rebuild the RAM disk at current 6 GB size
bash scripts/vcontext-setup.sh stop    # creates a fresh backup first
bash scripts/vcontext-setup.sh start
bash scripts/vcontext-reload.sh
```

---

## Sanity checks (run anytime)

```
bash scripts/smoke-test.sh                   # 20 endpoint checks
curl localhost:3150/admin/wal-status         # JSONL log size + line count
curl localhost:3150/admin/verify-backup -X POST  # last-10-snapshots integrity
curl 'localhost:3150/admin/health-report?days=1' | python3 -m json.tool
sqlite3 /Volumes/VContext/vcontext.db 'PRAGMA quick_check;'
sqlite3 ~/skills/data/vcontext-ssd.db 'PRAGMA quick_check;'
```

All should print `ok` or structured JSON with no errors.
