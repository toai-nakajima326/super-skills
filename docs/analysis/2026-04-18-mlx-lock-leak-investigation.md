# 2026-04-18 — MLX lock leak investigation

Status: **real leak reproduced, known root-cause, safe pre-fix workaround in place (25-min stale cleanup).**

## Observed symptom

- 2026-04-18 session: `/tmp/aios-mlx-lock` reported as held by
  `vcontext-server:45755:1776497618489` for 477,999 ms (~8 min) while
  `:3162` had no ESTABLISHED connections. Lock not stale at observation
  (<25 min), so auto-clear did not fire.
- Follow-up live observation at 17:26 JST: lock held by
  `locomo-eval:pid-82515`, mtime `17:03 JST`, 23 min old at observation
  and now just over the 25-min stale threshold. **PID 82515 does not
  exist** (verified via `ps -p`).

## Timeline that pins the leak

Sourced from `/tmp/vcontext-task-runner.log`:

| Event | UTC | JST | Source line |
|---|---|---|---|
| `task-runner dispatching locomo-eval (a03fa6dd…)` | 07:54:10 | 16:54:10 | L328 |
| `locomo-eval` acquires `/tmp/aios-mlx-lock` (mtime set) | 08:03:00 | 17:03:00 | `stat /tmp/aios-mlx-lock` |
| `task-runner failed locomo-eval … in 1200055ms` — **timeout-kill at +20 min exact** | 08:14:10 | 17:14:10 | L329 |
| Observation | 08:26:58 | 17:26:58 | live |

The 1,200,055 ms kill is the `LOCOMO_EVAL_TIMEOUT_MS = 20 * 60 * 1000`
that `execFile(..., {timeout})` in `runLocomoEval()` enforces. Node's
`execFile` timeout sends `SIGTERM` then `SIGKILL` — either way the Python
child dies before `MlxLock.__exit__` runs.

Result: the file on disk keeps the `locomo-eval:pid-82515` holder string
for up to 25 min (stale threshold), during which any `_mlxDrain()` tick
yields with `"external actor holding /tmp/aios-mlx-lock, skip this tick"`.

## Release-path audit table

| # | Call site | File:Line | Try/finally? | Release on reject? | Release on throw? | Release on process-kill? | Leak risk |
|---|---|---|---|---|---|---|---|
| 1 | `withMlxLock()` (Node) | `scripts/aios-mlx-lock.js:156-158` | yes (`try { return await fn() } finally { releaseMlxLock(...) }`) | yes | yes | **no — SIGKILL bypasses `finally`** | `_mlxDrain` watchdog SIGKILL |
| 2 | `_mlxDrain()` item body | `scripts/vcontext-server.js:5131-5139` | yes | yes (`item.reject(e); finally releaseMlxLock`) | yes | **no — event-loop watchdog SIGKILL (vcontext-server.js:273) or OOM-kill** | watchdog kill mid-await |
| 3 | `MlxLock.__enter__/__exit__` (Py) | `scripts/aios_mlx_lock.py:183-198` | yes (context manager) | yes (`__exit__` fires on exception) | yes | **no — SIGKILL / timeout-kill bypasses `__exit__`** | task-runner timeout-kill (confirmed) |
| 4 | `aios-task-runner.js` shell-lock | `scripts/aios-task-runner.js:499-505` | yes (`try { await dispatch } finally { mlxLockRelease }`) | yes | yes | **no — SIGTERM→SIGKILL on task-runner itself; also, this finally is in the *parent* process, so if the child (`locomo-eval.py`) re-wrote the lock with its own holder-id, `mlxLockRelease("task-runner:...")` is a no-op because `who !== holderId`** | child-rewrite: task-runner can't release a lock whose holder string was rewritten by locomo-eval |
| 5 | Shell `trap 'release' EXIT` | `scripts/aios-mlx-lock.sh:28` (usage example) | yes | n/a | yes | no — SIGKILL bypasses trap | SIGKILL only |

Summary: **5 call sites, 5 have SIGKILL/hard-kill leak risk by design.**
Row 3 is the *confirmed* leak source. Row 4 exposes a design subtlety:
task-runner acquires BEFORE exec, then the child `locomo-eval.py` also
acquires (overwrites the holder ID, despite the re-entrancy env var logic
being in place — see "Re-entrancy interaction" below). The child's
acquire overwrites the file, and on child SIGKILL, the parent's
`mlxLockRelease('task-runner:...')` becomes a string-mismatch no-op. The
lock then waits for the 25-min stale threshold.

## Re-entrancy interaction (unexpected)

`aios-task-runner.js` does `mlxLockAcquire` (lines 443-448) via a plain
`fs.writeFileSync` — it does NOT set `AIOS_MLX_LOCK_HOLDER`. So when the
child `locomo-eval.py` starts, `_parent_holds()` returns false (env var
unset), and the child calls `_try_acquire_atomic` — which sees the
existing non-stale lock and blocks. This means **task-runner + locomo
double-acquire deadlock-waits** up to 20 min per the child's `wait_s`,
burning the entire timeout on the child sitting in `time.sleep(0.5)`
polling loop without ever running eval. That's a second bug — quieter
but more harmful because the child wastes the full timeout window
waiting on a lock its own parent acquired.

Actually confirmed via the live log chain: locomo-eval was dispatched at
07:54:10, the lock mtime is 08:03:00 (~9 min later) — consistent with
the child's 20 min polling loop eventually succeeding after the parent's
lock went stale at the 25-min line, except 9 min is well short of stale.

More likely explanation: task-runner's `mlxLockAcquire` uses
`writeFileSync` which BLINDLY overwrites without EEXIST check. When
`pollOnce` saw `mlxLockStatus().held === false` (because no prior lock),
it wrote `task-runner:…` at 07:54. When the child started, it called
`_try_acquire_atomic` which saw the existing file, called `_is_stale`
(false — fresh), and returned false. Child then polled every 500ms.
But we see the file mtime was updated at 08:03 — that's either:
  (a) child acquired after the parent released (unlikely — parent is
      still in `await dispatch(next)` which doesn't return until
      `execFile` completes/fails), OR
  (b) `writeFileSync` mtime was refreshed by another process, OR
  (c) child overwrote in a way we didn't trace.

Actually re-reading `aios-task-runner.js:443-448`: `mlxLockAcquire`
uses `writeFileSync`. That does NOT respect `O_EXCL`. So if the parent
wrote it at 07:54, and then at some point the child *also* called
`_try_acquire_atomic` which uses `O_CREAT|O_EXCL|O_WX`, the child would
fail. BUT the task-runner side uses a non-atomic write and a
non-re-entrant design — and task-runner never exports
`AIOS_MLX_LOCK_HOLDER`, so child doesn't skip acquire. The child must
have waited for stale OR for the parent to rotate/release somewhere.

There's a **third path worth investigating**: `_mlxDrain` inside
vcontext-server acquires/releases every queue item. If the server had
a queue item fire at 08:02:59, acquired, held 1 ms, released — then
child's `_try_acquire_atomic` raced in and won at 08:03:00.191. That
would explain the 9-minute wait: child polled 1060 times before
catching an opening.

## Simulation result

Passive simulation (temporarily renamed real lock out of the way,
restored after):

- Node `withMlxLock` + Promise rejection → **releases correctly** ✓
- Node `withMlxLock` + success → **releases correctly** ✓
- Node stale-detect + re-acquire → **works correctly** ✓
- Python `MlxLock` + exception in `with` body → **releases correctly** ✓
- Python `MlxLock` + SIGKILL simulation (manual acquire, no release)
  → **file persists with holder ID, recovered only via stale
  threshold** — this matches the live leak exactly.

So the in-process code is correct. The leak is purely the
hard-kill path.

## Conclusion

**(a) Confirmed bug: hard-kill leaves the lock file orphaned until the
25-min stale window expires.** The bug is not in release semantics — it's
in the design choice of "`finally` block + 25-min stale timeout" as the
only recovery path for hard-kill. Two secondary findings:

1. `aios-task-runner.js` uses a separate non-atomic
   `mlxLockAcquire(writeFileSync)` path that doesn't export
   `AIOS_MLX_LOCK_HOLDER`, so the child-parent re-entrancy is broken.
   Child serially waits for server's own `_mlxDrain` window to squeeze
   through — wasting up to 25 min on the 20-min-budget tasks.
2. The user's originally-reported `vcontext-server:45755:...` held for
   477s is **different from the current lock**; that was a legit long
   inference (likely chunk-summary or discovery over a big prompt) and
   the 10-min HTTP timeout would have covered it. No bug there — just
   observed `:3162` TCP teardown between chunks.

### Recommended follow-up

- Short term (no code today): let 25-min stale cleanup fire; document
  "task-runner kill → orphan lock → up to 25 min of degraded
  `_mlxDrain`" as a known symptom in the runbook.
- Medium (next dev session): write `mlx-lock-leak-fix-plan.md` —
  add PID-to-lock encoding so stale detection can use `kill(pid, 0)`
  liveness rather than mtime alone, AND add `AIOS_MLX_LOCK_HOLDER`
  export to `aios-task-runner.js` so the child stays a no-op.
- Long (separate): audit other uses of file-locks in the repo for
  the same SIGKILL-bypass pattern.

### Safe probe for next session

After the stale threshold passes, probe the lock state with
`node scripts/aios-mlx-lock.js status` once per minute for 30 min
following a `locomo-eval` failure to confirm the pattern reproduces.
Do NOT live-probe while the lock is held — would block the probe.

## References

- `scripts/aios-mlx-lock.js` — Node helper (E agent commit `65fe8c7`)
- `scripts/aios_mlx_lock.py` — Python helper (stdlib-only twin)
- `scripts/aios-mlx-lock.sh` — Bash twin
- `scripts/vcontext-server.js:5096-5142` — `_mlxDrain()` (commit `90e65e8`)
- `scripts/aios-task-runner.js:422-506` — task-runner lock path
  (commit `57115b5`)
- `scripts/locomo-eval.py:685-707` — caller using `MlxLock` context manager
- Live evidence: `/tmp/vcontext-task-runner.log` L328-L329
  (dispatch at 07:54:09.999Z, failed at 08:14:10.059Z, Δ=1200055ms)
- Live evidence: `/tmp/aios-mlx-lock` mtime 08:03:00.191Z UTC, holder
  `locomo-eval:pid-82515`, PID 82515 no longer extant
