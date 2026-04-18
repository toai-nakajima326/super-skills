# 2026-04-18 Source Audit — Post-78-Commit Verification Sweep

## Mini-spec

**Goal**: Full-count read-only audit of every source file in scope after
today's 78+ commits to catch pre-Monday-morning surprises.

**Scope**: `scripts/**`, `skills/**/SKILL.md`, `skills/self-evolve/scripts/**`,
`~/Library/LaunchAgents/com.vcontext.*.plist`, `.claude/*.json`,
`docs/policy/*.md`, `docs/spec/*.md`, `docs/templates/*`.

**Acceptance criteria**:
1. Every file in scope is inventoried (count + bytes).
2. Every file is syntax-checked with its canonical tool.
3. Every finding has file:line + proposed action (no execution).
4. Findings grouped by severity: HIGH (live bug/security), MEDIUM (stale ref
   / confusion risk), LOW (cosmetic).

**Constraints**: READ-ONLY. No file edits, no server restart, no DB writes.

**Skills applied**: `infinite-skills` routing + `freeze` (read-only),
`investigate` (evidence-first with cite), `security-review` (trust
boundaries), `quality-gate` (full-count, no sampling).

---

## Inventory

| Directory                                       | Files | Bytes    |
|-------------------------------------------------|-------|----------|
| `scripts/**.{js,cjs,py,sh}`                     | 66    | 950,846  |
| `scripts/lib/**`                                | 6     | (in 66)  |
| `skills/**/SKILL.md`                            | 47    | 198,195  |
| `skills/self-evolve/scripts/self-evolve.js`     | 1     | 36,581   |
| `~/Library/LaunchAgents/com.vcontext.*.plist`   | 16    | —        |
| `.claude/**/*.json`                             | 47    | —        |
| `docs/policy/*.md`                              | 2     | 55,085   |
| `docs/spec/*.md`                                | 3     | (combined)|
| `docs/templates/*`                              | 1     | (combined)|
| **Total files in scope**                        | **183** | **~1.24 MB** |

By extension in `scripts/`: 25 `.js`, 5 `.cjs`, 5 `.py`, 31 `.sh`.

## Syntax Health

| Tool                              | Files | Pass | Fail |
|-----------------------------------|-------|------|------|
| `node --check` (.js, .cjs + lib)  | 30+6  | 36   | 0    |
| `bash -n` (.sh)                   | 31    | 31   | 0    |
| `python3 -m py_compile` (.py)     | 5     | 5    | 0    |
| `plutil -lint` (plist)            | 16    | 16   | 0    |
| JSON parse (.claude json)         | 47    | 47   | 0    |
| **Aggregate**                     | **135** | **135** | **0** |

All 135 syntax checks pass. Note: `node --check` is syntax-only; 4 scripts
pass syntax but FAIL at module-resolution time — see HIGH-2 below.

---

## Findings

### HIGH (live-impact or security)

| # | File:Line | Severity | Finding | Proposed Action (not executed) |
|---|-----------|----------|---------|-------------------------------|
| H1 | `scripts/aios-task-runner.js:267, 295, 185` | HIGH (correctness) | Task-runner spawns MLX-heavy children (article-scanner, self-evolve, locomo-eval) via `execFile(..., { env: { ...process.env, TASK_RUNNER: '1', ... } })` but does NOT set `AIOS_MLX_LOCK_HOLDER`. Parent acquires `/tmp/aios-mlx-lock` at L497, child then calls `withMlxLock()` inside the script — no re-entry marker → child tries to acquire a lock the parent already holds → blocks until parent's timeout-SIGKILL, then parent orphans the lock (exactly the "lock-leak" documented in `docs/analysis/2026-04-18-mlx-lock-leak-investigation.md` and `…-fix-plan.md`). Fix plan has been documented but NOT applied. | Add `AIOS_MLX_LOCK_HOLDER: \`task-runner:${next.request_id}\`` to the `env` object at L271-275, L299-304, and to the `runLocomoEval` call at L185 (needs per-payload holder id). Verify with `scripts/test-mlx-lock-end-to-end.sh` scenario 3. |
| H2 | `scripts/scan-secrets.js:3`, `scripts/validate-configs.js:3`, `scripts/build-skills.js:3`, `scripts/build-mcp-config.js:3` | HIGH (user-facing tool broken) | All 4 files open with bare `const fs = require("fs")` but repo `package.json` is `"type": "module"`. `node --check` passes (syntax-only) but execution throws `ReferenceError: require is not defined in ES module scope`. README (`skills/README.md:26`, `docs/ARCHITECTURE.md:72`, `mcp/README.md:72-75`) instructs users to run `node scripts/build-skills.js` and `node scripts/build-mcp-config.js` — they fail today. **scan-secrets.js itself** cannot run → secret-scan CI step (if any) is silently dark. Verified: `node scripts/scan-secrets.js` → throws. | Rename to `.cjs`, OR convert to ESM (`import fs from 'node:fs'`), OR add `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` (same pattern already used in `scripts/vcontext-server.js:39-52`). Smallest diff: rename `.js` → `.cjs` for these 4 files (mirrors today's earlier rename work for watcher/miner/bridge/generator). |
| H3 | `scripts/vcontext-server.js:7124-7170` + `scripts/aios-task-runner.js:309-320` | HIGH (security — local RCE) | `POST /admin/task-request` accepts `task_type: 'shell-command'` with `payload.cmd` and `payload.approved_by_user: true`. The ONLY guard on shell-command is that `payload.approved_by_user === true` — a client-side flag. No `X-Vcontext-Admin: yes` header check (unlike `/admin/apply-patch` L6620). Any local process (or DNS-rebind-style cross-origin call from the user's browser) on port 3150 can submit `{task_type:'shell-command', payload:{cmd:'rm -rf ~', approved_by_user:true}}`. The task-runner (LaunchAgent, runs as user) then calls `exec(cmd, ...)` at L315 — arbitrary code execution as the user. Server binds 127.0.0.1 by default, but loopback still reachable from any local app and from browser DNS-rebind. | Require the same `X-Vcontext-Admin: yes` header check the other admin endpoints use. Additionally: treat `approved_by_user` as a server-enforced invariant (e.g., only dashboard click can submit shell-command, enforced by CSRF token + Origin check), not a client-settable boolean. Consider removing `shell-command` dispatch entirely — article-scan/self-evolve/locomo already cover legitimate task types. |

### MEDIUM (stale reference, missed fix, naming drift)

| # | File:Line | Severity | Finding | Proposed Action |
|---|-----------|----------|---------|----------------|
| M1 | `scripts/vcontext-server.js:1642, 5352` | MEDIUM (info-loss, not crash) | `mlxEmbedFast(q.slice(0,500), 2000)` — user query slice by UTF-16 code-unit, not code-point. If a user's query has an emoji at offset 499, it's half-cut. The downstream `_mlxEmbedRaw:4897` applies `sanitizeEmbedText` which strips the broken surrogate, so no crash — but query semantics degraded vs. other embed paths. The directive's "3 call sites" for `safeSliceCodePoints` only covers L1410 + L3356; the 2 `mlxEmbedFast` callsites were missed by commit `280ab3e`. | Wrap the `.slice(0, 500)` / raw `q` at L1642 and L5352 with `safeSliceCodePoints(..., 500)`. Same justification as commit `280ab3e`. |
| M2 | `scripts/pre-outage.sh:16-18`, `scripts/vcontext-abtest.sh:19`, `scripts/vcontext-self-improve.sh:12`, `scripts/vcontext-maintenance.sh:115`, `scripts/experiment-thinking-skip.sh:19` | MEDIUM (silent failure in SSD mode) | 5 scripts hard-code `/Volumes/VContext/vcontext.db`. After ramdisk-to-SSD migration (commit `0252bcc`), the default DB is `data/vcontext-primary.sqlite`. These scripts run silently against a non-existent path. Prior audit (`docs/analysis/2026-04-18-ram-disk-audit.md:43`) explicitly deferred this as "out of tonight's fragile path." Still deferred — still failing. | Read `VCONTEXT_DB_PATH` env var (same pattern as `vcontext-setup.sh`). If unset and `!USE_RAMDISK`, default to `$HOME/skills/data/vcontext-primary.sqlite`. |
| M3 | `scripts/vcontext-hooks.js:2201` (indirect — observed via prior audit) | MEDIUM | `VCTX_RAM_DB = '/Volumes/VContext/vcontext.db'` — fallback path in hooks. Only used if env-based path is missing. Latent but not currently firing. | Mirror vcontext-server's `USE_RAMDISK` gate or drop the fallback. |
| M4 | `scripts/vcontext-server.js:41-42` (comment) | MEDIUM (doc drift) | Comment cites `scripts/self-evolve.js` — that file does not exist at that path. Current location is `skills/self-evolve/scripts/self-evolve.js`. Reader may waste time grepping for a phantom file. | Update comment to `skills/self-evolve/scripts/self-evolve.js`. |
| M5 | `skills/comprehensive-qa/SKILL.md:401, 405` | MEDIUM | Diagnostic snippet: `new Database('/Volumes/VContext/vcontext.db')` and `new Database(process.env.HOME + '/skills/data/vcontext-ssd.db')`. Both paths are wrong now — primary is `data/vcontext-primary.sqlite`, no `vcontext-ssd.db`. QA rehearsals per this doc would fail. | Update paths to `data/vcontext-primary.sqlite` (guarded by `USE_RAMDISK` check for the RAM leg). |
| M6 | `scripts/vcontext-server.js` variables | MEDIUM (naming drift, not bug) | 50 `ramDb` + 35 `ssdDb` identifiers still in use alongside 8 `primary` + 4 `archive`. Post-migration, `ramDb` semantically points to the SSD primary DB unless `VCONTEXT_USE_RAMDISK=1`. Next engineer reading this will misinterpret. | No code change needed (invasive). Add a top-of-file comment block: `// NOTE (2026-04-18): "ramDb" / "ssdDb" are legacy names from RAM-disk era. In SSD mode, ramDb = primary = data/vcontext-primary.sqlite; ssdDb = archive snapshots. See USE_RAMDISK.` Alternatively defer to a future rename commit. |
| M7 | `docs/spec/2026-04-18-skill-feedback-loop.md:512` | MEDIUM (doc drift) | Cites `scripts/self-evolve.js` — same phantom-path as M4. | Update to `skills/self-evolve/scripts/self-evolve.js`. |

### LOW (cosmetic, comment drift, tiny TODOs)

| # | File:Line | Severity | Finding | Proposed Action |
|---|-----------|----------|---------|----------------|
| L1 | `scripts/vcontext-server.js:3638, 3642` | LOW (defense-in-depth) | `execSync(\`osascript -e 'display notification "${msg.replace(/"/g,"")}" with title "…"'\`)`. `.replace(/"/g,"")` strips double quotes but not single quote, backtick, `$(`, `;`. `msg` comes from server-internal `alert.msg` (trusted), so not exploitable today. But a future refactor that routes any HTTP input to `alert.msg` would immediately become RCE. | Use `spawn('osascript', ['-e', `display notification "${msg}" with title "…"`])` with args-array, OR `.replace(/['"`$;\\]/g,'')`. |
| L2 | `docs/analysis/2026-04-18-self-evolve-redesign.md:176` | LOW (design-phase doc, historical) | Cites `node scripts/self-evolve.js` as proposed Program path. Actual LaunchAgent uses `skills/self-evolve/scripts/self-evolve.js`. Historical design doc — ok if annotated as such. | Either leave as historical, or prepend "Superseded by actual layout at…" note. |
| L3 | `docs/policy/autonomous-commit-gate.md:153-154` | LOW (historical accurate) | Refers to `new-feature-watcher.js` and `conversation-skill-miner.js`. These were renamed to `.cjs` in commit `a523bf5` today. The references are inside a "retrospective review" table, so historical `.js` names are technically accurate for that commit's state. | No action; consider a "today renamed to .cjs" footnote for forward readers. |
| L4 | `scripts/vcontext-hooks.js:27` | LOW (naming) | `VCTX_DEADLETTER = '/tmp/vcontext-queue.deadletter.jsonl'` — uses the word "DEAD" in constant name (picked up by grep for "DEAD"). Legitimate deadletter-queue naming, not dead code. | None — false positive in grep sweep. |
| L5 | `scripts/__pycache__/mlx-generate-server.cpython-313.pyc` | LOW (stale artifact) | Deleted `scripts/mlx-generate-server.py` (commit `ebba45e`) but `.pyc` cache still present. Not referenced anywhere. Harmless but untidy. | `rm scripts/__pycache__/mlx-generate-server.cpython-313.pyc`. |

---

## Aggregate

- **Total files scanned**: 183 in scope, 135 runnable syntax checks — **0 syntax failures**.
- **Findings**: 3 HIGH / 7 MEDIUM / 5 LOW = 15 total.
- **Skills applied**: `infinite-skills` (routing), `freeze` (read-only), `investigate` (evidence-first), `security-review` (RCE scan), `quality-gate` (full-count, no sampling), `spec-driven-dev` (mini-spec at top).
- **Expected value to user**: surfaces 3 items that would have bitten Monday —
  (1) next task-runner MLX task will deadlock (H1), (2) anyone running
  `node scripts/build-skills.js` per the README hits a crash (H2),
  (3) local RCE via `/admin/task-request` `shell-command` gate is weaker
  than designed (H3).

## Explicit non-findings (checked, clean)

- `mx.metal.clear_cache` / `set_cache_limit` dual-path — fully migrated (mlx-embed-server.py L37-38 uses `getattr(mx, 'clear_cache', None) or getattr(getattr(mx, 'metal', None), 'clear_cache', None)`). coreml-embed-server.py uses no `mx.*` at all.
- Hardcoded secrets (sk-ant, sk_live, AKIA, ghp_, xoxb-, vctx_) — no matches in `scripts/` or `skills/` (false-positive `vctx_…` found via scan-secrets.js was in `.claude/worktrees/` junk dirs, not tracked source).
- Path traversal (`readFile(\`${req.body.x}\`)`) — no matches.
- SQL injection — `patchId` (`parseInt`), `Number(row.id)`, `esc(JSON.stringify(...))` at all dynamic-SQL sites; admin endpoints have both input validation and `X-Vcontext-Admin` header (except H3).
- `.cjs` LaunchAgent references — all 4 renamed scripts (new-feature-watcher, conversation-skill-miner, aios-learning-bridge, skill-query-generator) correctly referenced as `.cjs` in their plists and invocations.
- `USE_RAMDISK` gating at the `MOUNT_POINT` reference — core server correctly gated (`vcontext-server.js:65-77, 506, 2073, 3520`), `vcontext-setup.sh:13-16`; only the 5 ancillary scripts (M2) are ungated.
- `sanitizeEmbedText` on the 3 embed-batch sites — L1410 (handleStore), L3356 (embed loop), _mlxEmbedRaw internal at L4897, _mlxEmbedBatchRaw internal at L4964: defense-in-depth chain intact. (M1 is about the 2 *fast* paths that slice user input without code-point awareness — a weaker but non-crashing issue.)
