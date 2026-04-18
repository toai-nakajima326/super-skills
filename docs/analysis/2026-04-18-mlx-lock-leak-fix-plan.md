# 2026-04-18 — MLX lock leak: fix plan (design only, do not code tonight)

See investigation doc: `docs/analysis/2026-04-18-mlx-lock-leak-investigation.md`.

## Two defects

D1. **Hard-kill orphan**: when a lock-holder is killed (SIGKILL,
    `execFile` timeout, OOM-killer), `finally`/`__exit__` doesn't run
    and the file survives until 25-min mtime stale threshold.
D2. **Broken parent-child re-entrancy for task-runner → locomo-eval**:
    `aios-task-runner.js` acquires via a non-atomic
    `fs.writeFileSync` path and does NOT export `AIOS_MLX_LOCK_HOLDER`,
    so the child `locomo-eval.py` is not recognized as re-entering and
    serially waits for the server's `_mlxDrain` to squeeze a release
    window.

## Fix for D1 — PID-liveness stale check

Change the lock file format from plain `<holder-id>\n` to
`<pid>\t<holder-id>\n`. The PID is the OS pid of the acquiring process.

Stale check becomes "EITHER mtime > 25 min OR `kill(pid, 0)` → ESRCH".
`kill(pid, 0)` is a permission-free liveness check on POSIX. If the
PID owning the lock is dead, reclaim immediately — no 25-min wait.

- **Breakage**: all three helpers (Node / Python / shell) must change
  their read and write paths together. Existing locks written by the
  old format are accepted but treated as "unknown PID, fall back to
  mtime only". That keeps the upgrade compatible across overlapping
  deployments.
- **Safety**: ESRCH check can false-positive if PID has been
  recycled by the OS. Use (pid, start_time_ns) tuple to guard against
  recycle: on Linux `/proc/<pid>/stat` field 22 (start_time); on macOS
  `sysctlbyname("kern.proc.pid.<pid>", ...)`. For stdlib-only Python
  this is annoying but not impossible. For the first iteration, accept
  the recycle risk — on a user laptop with millions of free PIDs, the
  probability of recycle within a 25-min window is extremely low.

## Fix for D2 — export `AIOS_MLX_LOCK_HOLDER` in task-runner, use the shared helper

Replace `aios-task-runner.js`'s inline `mlxLockAcquire`/`mlxLockStatus`/
`mlxLockRelease` (lines 422-457) with the shared
`import { tryMlxLock, releaseMlxLock }` from `aios-mlx-lock.js`. Then,
before `execFile` for `locomo-eval` / `self-evolve-dryrun` /
`article-scan-adhoc` / `skill-discovery-adhoc`, set
`env: { ...process.env, AIOS_MLX_LOCK_HOLDER: holderId }` so the child's
`_parent_holds()` returns true and the child's lock calls become
no-ops. This removes D2 entirely.

Side benefit: atomic (`O_CREAT|O_EXCL`) acquire removes the window where
both task-runner and `_mlxDrain` could both write (currently possible
because task-runner uses plain `writeFileSync`).

## Fix application order

1. D2 first (tiny diff — swap the 3 task-runner helpers for imports,
   add the env injection in `execFile`). Adversarial-review that the
   existing holder-id format — `task-runner:<request_id>` — still
   uniquely identifies the parent for release.
2. Then D1 (format change). Bumps a shared constant `LOCK_FORMAT = 2`
   in the header so all three helpers agree.
3. Re-run `scripts/test-mlx-lock-end-to-end.sh` which already covers
   Node/Python/shell serialization. Add two new scenarios:
   (7) PID-dead stale recovery, (8) task-runner→locomo env-var
   re-entrancy.

## Estimated effort

- D2: 30 min (small, single-file).
- D1: 90 min (three helpers + test harness + cross-format compat).
- Combined with adversarial review and
  `scripts/test-mlx-lock-end-to-end.sh` extension: ~3 hours.

## Do NOT ship tonight because

Investigation-only constraint stated. Also: this touches the
task-queue dispatch path for MLX-heavy jobs that run overnight — any
regression would cascade into the morning-brief and chunk-summary
loops. A quality-gate pass in fresh daylight is safer.
