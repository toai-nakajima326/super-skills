"""aios_mlx_lock.py — Cross-process file lock for MLX concurrency coordination.

Mission: prevent the 2026-04-18 OOM cascade pattern where Claude-launched
agents, Task-Queue runners, adhoc scripts, and the vcontext server's own
background loops all hit MLX generate simultaneously. 5x 8GB unified memory
per Qwen3-8B-4bit caller pushes a 36GB box past its swap ceiling and wedges
MLX into uninterruptible sleep.

Contract (compatible with scripts/aios-task-runner.js commit 57115b5
and scripts/aios-mlx-lock.js):

    Lock file: /tmp/aios-mlx-lock
    Format:    "<holder-id>\\n"  (holder-id is ASCII text; trailing newline)
    Stale:     >25min mtime --> auto-cleared (matches task-runner)
    Re-entry: env var AIOS_MLX_LOCK_HOLDER makes nested calls a no-op so
               parent-acquired locks survive child-process acquire attempts.

Usage::

    from aios_mlx_lock import MlxLock, try_mlx_lock, release_mlx_lock

    # Context manager (recommended):
    with MlxLock("locomo-eval:pid-1234", wait_s=1200):
        do_mlx_work()

    # Manual control:
    if try_mlx_lock("locomo-eval:pid-1234", wait_s=5):
        try:
            do_mlx_work()
        finally:
            release_mlx_lock("locomo-eval:pid-1234")

The module is deliberately stdlib-only (no pip install).
"""

from __future__ import annotations

import errno
import os
import time
from pathlib import Path

MLX_LOCK_FILE = "/tmp/aios-mlx-lock"
MLX_LOCK_STALE_S = 25 * 60
MLX_LOCK_DEFAULT_WAIT_S = 20 * 60
MLX_LOCK_ENV_VAR = "AIOS_MLX_LOCK_HOLDER"

_POLL_INTERVAL_S = 0.5


# ── Internal helpers ────────────────────────────────────────────

def _read_holder() -> str | None:
    try:
        return Path(MLX_LOCK_FILE).read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return None


def _is_stale() -> bool:
    try:
        return (time.time() - os.stat(MLX_LOCK_FILE).st_mtime) > MLX_LOCK_STALE_S
    except (FileNotFoundError, OSError):
        return False


def _parent_holds() -> bool:
    """Is the lock held by an ancestor process (via env var)?

    Returns True iff AIOS_MLX_LOCK_HOLDER is set AND the file on disk
    currently contains that exact holder. Subprocess callers then become
    no-ops: they inherit the env var, see the parent still holds it, and
    skip both acquire and release.
    """
    env_holder = os.environ.get(MLX_LOCK_ENV_VAR)
    if not env_holder:
        return False
    return _read_holder() == env_holder


def _try_acquire_atomic(holder_id: str) -> bool:
    """Atomic O_CREAT|O_EXCL|O_WRONLY acquire. True on success."""
    if os.path.exists(MLX_LOCK_FILE):
        if _is_stale():
            try:
                os.unlink(MLX_LOCK_FILE)
            except OSError:
                pass
        else:
            return False
    try:
        fd = os.open(MLX_LOCK_FILE,
                     os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except OSError as e:
        if e.errno == errno.EEXIST:
            return False
        raise
    try:
        os.write(fd, (holder_id + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return True


# ── Public API ──────────────────────────────────────────────────

def try_mlx_lock(holder_id: str, wait_s: float | None = None) -> bool:
    """Try to acquire the MLX lock, waiting up to wait_s seconds.

    Returns True on success, False on timeout. Re-entrant via
    AIOS_MLX_LOCK_HOLDER env var: if the parent already holds the lock,
    returns True immediately without touching the file.

    Args:
        holder_id: identifying string ("script-name:pid-1234", etc).
                   No newlines; kept under 120 chars.
        wait_s:    max total wait in seconds (default 1200 = 20 min).
    """
    if not isinstance(holder_id, str) or not holder_id or "\n" in holder_id:
        raise ValueError("holder_id must be a non-empty single-line string")
    if _parent_holds():
        return True
    if wait_s is None:
        wait_s = MLX_LOCK_DEFAULT_WAIT_S
    deadline = time.time() + max(0.0, wait_s)
    while True:
        if _try_acquire_atomic(holder_id):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(_POLL_INTERVAL_S)


def release_mlx_lock(holder_id: str) -> None:
    """Release the lock iff we're the holder on disk. Safe no-op otherwise."""
    if _parent_holds():
        return  # parent still holds — parent will release
    try:
        if not os.path.exists(MLX_LOCK_FILE):
            return
        if _read_holder() == holder_id:
            try:
                os.unlink(MLX_LOCK_FILE)
            except OSError:
                pass
    except OSError:
        pass


def mlx_lock_status() -> dict:
    """Read-only peek. Does NOT acquire."""
    try:
        st = os.stat(MLX_LOCK_FILE)
    except FileNotFoundError:
        return {"held": False, "holder": None, "age_s": 0.0, "stale": False}
    age_s = time.time() - st.st_mtime
    stale = age_s > MLX_LOCK_STALE_S
    return {
        "held": not stale,
        "holder": _read_holder(),
        "age_s": age_s,
        "stale": stale,
    }


class MlxLock:
    """Context manager for the MLX file lock.

    Raises TimeoutError if the lock can't be acquired within wait_s.
    No-op if AIOS_MLX_LOCK_HOLDER env marks parent-held.

    Example::

        with MlxLock("locomo-eval:pid-1234", wait_s=1200):
            run_locomo_eval()
    """

    def __init__(self, holder_id: str, wait_s: float | None = None):
        self.holder_id = holder_id
        self.wait_s = wait_s if wait_s is not None else MLX_LOCK_DEFAULT_WAIT_S
        self._acquired = False

    def __enter__(self) -> "MlxLock":
        ok = try_mlx_lock(self.holder_id, wait_s=self.wait_s)
        if not ok:
            holder = _read_holder() or "none"
            raise TimeoutError(
                f"aios-mlx-lock: timeout waiting {self.wait_s}s for MLX "
                f"lock (current holder: {holder})"
            )
        self._acquired = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._acquired:
            release_mlx_lock(self.holder_id)
            self._acquired = False
        # don't suppress exceptions
        return None


# CLI mode: `python3 aios_mlx_lock.py status` — prints JSON status.
if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) == 2 and sys.argv[1] == "status":
        print(json.dumps(mlx_lock_status()))
        raise SystemExit(0)
    print("Usage: python3 aios_mlx_lock.py status", file=sys.stderr)
    raise SystemExit(2)
