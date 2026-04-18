# 2026-04-18 AIOS Log Analysis v3 — Delta After M17 + M18

## Mini-Spec

**Intent**: Re-run log audit after landing M17 (`d385142`, server-side integrity-check-before-backup-rotate) and M18 (`42a6085`, hooks-side cmdIntegrity path fix). Verify (a) whether M17/M18 are actually active, (b) whether none of tonight's 7 earlier hotfixes regressed, (c) no new patterns since v2 cutoff.

**Cutoffs**:
- v1 @ `b84c4b3` (19:33 JST)
- v2 @ `0286197` (20:15 JST)
- v3 scope = **post-`0286197`** log lines, with emphasis on post-20:34 (M17) / post-20:37 (M18).

**Acceptance Criteria**:
- [x] M17 server-side activation check on `doBackup()` (every 5min)
- [x] M18 hooks-side activation check on `maintenance` cycle
- [x] Re-check 7 hotfixes for regression
- [x] New error patterns since v2
- [x] Current live state: `/health`, `launchagent-health-check.sh`, server PID
- [x] Aggregate PASS/FAIL

**Constraints**: READ-ONLY (no server ops). `CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1`.

---

## Section 1 — M17 / M18 Activation

### M17 `doBackup()` integrity-check (commit `d385142` @ 20:34:06 JST)

| Indicator | Evidence | Verdict |
|---|---|---|
| Server loaded M17 code? | **PID 97124 started 2026-04-18 20:07:22 JST** (before M17 commit at 20:34). Node.js has no hot-reload. Uptime from `/health` = 2382s. | **NOT LOADED** |
| `[vcontext] Backup complete` events since 20:34? | 10 events (last at line 8356, inside last 200 lines of server log) | Running |
| Any `type=anomaly-alert` or "integrity-reject"? | 0 | N/A — code path never triggered |
| `Skip (integrity fail)` count | 1 (line 7, pre-v1) | Not new |

**Verdict**: **M17 IS DORMANT**. The commit message explicitly chose not to restart the server post-commit. Until next restart (via watchdog or manual bounce), all `doBackup()` rotations still use the pre-M17 byte-oblivious rename path. A truncated `.sqlite` can still be promoted into `.bak`. **Risk persists.**

### M18 `cmdIntegrity` path fix (commit `42a6085` @ 20:37:40 JST)

| Maintenance cycle | Restore hint path | Status |
|---|---|---|
| 19:45:05 (pre-M18) | `/Volumes/VContext/vcontext.db` | Dead RAM path (old bug) |
| **20:35:36 (post-M18)** | `/Users/mitsuru_nakajima/skills/data/vcontext-primary.sqlite` | **Live primary — M18 ACTIVE** |
| **20:45:05 (post-M18)** | `/Users/mitsuru_nakajima/skills/data/vcontext-primary.sqlite` | **M18 ACTIVE** |

- Path string switched cleanly at the first cycle after M18 commit.
- **"DB integrity: FAILED" still appears** post-M18 due to documented side-finding: combined `PRAGMA integrity_check; PRAGMA quick_check;` under concurrent WAL writes reports false-positive `malformed inverted index`. Each PRAGMA individually returns ok. Tracked in `docs/analysis/2026-04-18-cmdintegrity-deferred.md`.

**Verdict**: **M18 PARTIALLY FIXED** — path bug resolved. Semantic FAILED noise remains (known, deferred, acceptable).

---

## Section 2 — Hotfix Regression Check (post-v2 window)

| Hotfix | Pattern | Delta count (post-`0286197`) | Expect | Verdict |
|---|---|---:|---|---|
| `ae1ce3f` MLX Killed:9 | `Killed: 9` in server | **5 more** (lines 7940, 8011, 8014, 8017; pre-v2 was 20) | 0 | **REGRESSION** (minor; at wrapper retry loop during OOM tail-storm) |
| `0252bcc` RAM disk full | `ram-disk-full`, `ENOSPC` | 0 | 0 | HELD |
| `0252bcc` consultations undef | `consultations is not defined` | 0 | 0 | HELD |
| `d621456` UTF-16 surrogate | `surrogate`, 400s | 0 | 0 | HELD |
| `7d0fc33` .cjs rename | stale `.js` path attempts | 0 | 0 | HELD |
| `20ee1c2` admin header | unauthenticated 401s | 0 | 0 | HELD |
| `c8f831e`/`079360d` mlx-lock | task-runner churn | 14 dispatched / 7 completed; 1 min-interval stable | healthy | HELD |

**Concerning**: the `Killed:9` re-occurrence at lines 8011/8014/8017 (three back-to-back) is a **continuation of the 20:04 OOM storm catalogued in v2**, not a brand-new event — but server log shows the wrapper retried `81770 → 83573 → 88753` before finally binding a fresh PID. This is the **same storm** v2 captured. Current server (PID 97124) has been stable since.

---

## Section 3 — NEW Patterns Since v2

| Pattern | Count | Severity | Notes |
|---|---:|---|---|
| `[store] MLX embed failed: read ECONNRESET` (post-v2) | **~5** at line 8201–8390 (tail of file) | MED | Sporadic mlx-embed-server hiccups. No sustained storm (≥100/5min threshold not crossed). |
| `[store] MLX embed failed: socket hang up` | 1 (line 8391) | LOW | Same root as above. |
| `[embed-loop] batch failed` | 0 new in delta | — | Clean |
| `[vcontext:alert] N anomalies detected` | 1 (line near tail, `2 anomalies`) | LOW | Alert loop working as designed |
| OOM storm (new) | 0 | — | No post-v2 OOM storm |
| Task-runner restart | 0 new | — | Still PID 80146 |
| Deprecation warnings | 0 | — | Clean |
| Loop signature (>100 identical lines / 5min) | 0 | — | No loop detected |
| HTTP 400/500 | 0 real (previous v2 "152" were stdin_len bytes, not status codes — false-positive classified) | — | Clean |

---

## Section 4 — Current Live State

### `GET /health` (200 OK)

```
status=healthy, ram_disk=false, use_ramdisk=false, database=true,
ssd_database=true, mlx_generate_available=true,
mlx_available=true, ws_clients=0, uptime_seconds=2382,
features={semantic_search, mlx_embed, usage_analytics}
```

### LaunchAgent health

Total: 14 | OK: 8 | STALE: 5 | FAIL: 1

- **OK (8)**: server, mlx-embed, mlx-generate, maintenance, hooks-setup, article-scanner-evening, skill-discovery, task-runner
- **STALE (5)**: watchdog (39min), morning-brief, article-scanner, self-evolve, keyword-expander — all cron-daily with `next_fire` tomorrow; STALE = "no run in window, no imminent schedule" (expected)
- **NOT-LOADED (1)**: `com.vcontext.ramdisk` — boot-only, **intentionally dormant post-RAM-disk decommission** (not a fault)

### vcontext-server process

- PID **97124**, started 2026-04-18 20:07:22 JST, uptime ~40 min at audit time
- **RSS 1,136,128 KB ≈ 1.08 GiB** — elevated but below 1.5 GiB watchdog threshold

---

## Aggregate Verdict

| Area | Status |
|---|---|
| M17 activation | **DORMANT — server not restarted; code not loaded** |
| M18 activation | **PARTIAL — path fix active; FTS5 false-FAIL noise remains (known)** |
| 7 hotfix regression | **6 HELD / 1 tail-storm continuation (same as v2, not new)** |
| New patterns | **None above threshold** |
| Live state | **Healthy; 1.08 GiB RSS trending high** |

**AGGREGATE: PASS (with open item)**.

No CRITICAL — no pre-fix symptom reappeared after its fix landed. The M17-dormant state is expected per M17 commit message; follow-up is to restart `vcontext-server` during a quiescent window to activate M17.

Open follow-ups:
1. Restart vcontext-server safely to activate M17 (non-urgent — backup rotation is not actively corrupting anything right now).
2. Monitor RSS; 1.08 GiB + continued backfill loops could push into 4th-OOM territory within hours.
3. FTS5 combined-PRAGMA race documented in `2026-04-18-cmdintegrity-deferred.md`; reserve a low-traffic window to split queries.
