// aios-mlx-lock.js — Cross-process file lock for MLX concurrency coordination.
//
// Mission: prevent the 2026-04-18 OOM cascade pattern where Claude-launched
// agents, Task-Queue runners, adhoc scripts, and the vcontext server's own
// background loops all hit MLX generate simultaneously. 5x 8GB unified
// memory per Qwen3-8B-4bit caller pushes a 36GB box past its swap ceiling
// and wedges MLX into uninterruptible sleep.
//
// Contract (compatible with scripts/aios-task-runner.js commit 57115b5):
//   Lock file: /tmp/aios-mlx-lock
//   Format:    "<holder-id>\n"  (holder-id is ASCII text; trailing newline)
//   Stale:     >25min mtime → auto-cleared (matches task-runner)
//   Re-entry: env var AIOS_MLX_LOCK_HOLDER makes nested calls a no-op so
//              parent-acquired locks survive child-process acquire attempts.
//
// Usage:
//   import { withMlxLock, tryMlxLock, releaseMlxLock } from './aios-mlx-lock.js';
//
//   // Fire-and-forget — wraps an async fn, acquires/releases automatically:
//   const result = await withMlxLock('my-script:42', async () => {
//     return await doMlxWork();
//   }, { waitMs: 20 * 60 * 1000 });  // default 20min
//
//   // Manual control (for background loops that need granular release):
//   const ok = await tryMlxLock('my-script:42', { waitMs: 5000 });
//   if (ok) {
//     try { await doMlxWork(); }
//     finally { releaseMlxLock('my-script:42'); }
//   } else {
//     // Another holder timed us out — skip this tick, try again later.
//   }
//
// Safety:
//   - releaseMlxLock only unlinks if the on-disk holder-id matches ours
//     (prevents clobbering someone else's acquired lock on crash-recovery).
//   - AIOS_MLX_LOCK_HOLDER re-entry check is string-exact — nested children
//     inherit the env var and become no-ops; unrelated processes don't.

import { existsSync, statSync, readFileSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';

export const MLX_LOCK_FILE = '/tmp/aios-mlx-lock';
export const MLX_LOCK_STALE_MS = 25 * 60 * 1000;
export const MLX_LOCK_DEFAULT_WAIT_MS = 20 * 60 * 1000;
export const MLX_LOCK_ENV_VAR = 'AIOS_MLX_LOCK_HOLDER';

const POLL_INTERVAL_MS = 500;

function _readHolder() {
  try { return readFileSync(MLX_LOCK_FILE, 'utf-8').trim(); }
  catch { return null; }
}

function _isStale() {
  try {
    const st = statSync(MLX_LOCK_FILE);
    return (Date.now() - st.mtimeMs) > MLX_LOCK_STALE_MS;
  } catch { return false; }
}

// Parent already holds the lock? (e.g. task-runner launched this script)
// Check env var AND that the file actually contains that holder (not stale).
function _parentHolds(myHolderId) {
  const envHolder = process.env[MLX_LOCK_ENV_VAR];
  if (!envHolder) return false;
  const onDisk = _readHolder();
  if (!onDisk) return false;
  // Parent held if env matches disk content — our own acquire would recurse.
  // myHolderId is ignored here; even if it differs, re-entry is semantically
  // "this process tree already holds the lock".
  return envHolder === onDisk;
}

// Atomic create — returns true if we successfully acquired, false if EEXIST
// and the existing lock is NOT stale. Clears stale locks on the way.
function _tryAcquireAtomic(holderId) {
  if (existsSync(MLX_LOCK_FILE)) {
    if (_isStale()) {
      try { unlinkSync(MLX_LOCK_FILE); } catch {}
    } else {
      return false;
    }
  }
  // O_CREAT | O_EXCL | O_WRONLY → fails with EEXIST if another caller
  // raced us between the existsSync above and this open. That's fine —
  // the caller's retry loop handles it.
  try {
    const fd = openSync(MLX_LOCK_FILE, 'wx');
    try { writeSync(fd, holderId + '\n'); }
    finally { closeSync(fd); }
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    // Any other error (permission, disk full) — rethrow so the caller sees it.
    throw e;
  }
}

/**
 * Try to acquire the lock, waiting up to opts.waitMs (default 20min) for it.
 * Returns true on success, false on timeout. Re-entrant: if AIOS_MLX_LOCK_HOLDER
 * matches the on-disk holder, returns true immediately without touching the
 * lock file (release is similarly a no-op in that case).
 *
 * @param {string} holderId  Identifying string ("self-evolve:pid-1234" etc).
 *                           Kept under 120 chars; no newlines.
 * @param {object} opts
 * @param {number} opts.waitMs   Max total wait in ms (default 1,200,000).
 * @param {function} opts.onWait Optional callback(ageMs, holderOnDisk) fired
 *                               once every 60s while waiting, for logging.
 */
export async function tryMlxLock(holderId, opts = {}) {
  if (typeof holderId !== 'string' || !holderId || /\n/.test(holderId)) {
    throw new Error('tryMlxLock: holderId must be a non-empty single-line string');
  }
  if (_parentHolds(holderId)) return true;  // re-entrant no-op
  const waitMs = Math.max(0, opts.waitMs ?? MLX_LOCK_DEFAULT_WAIT_MS);
  const deadline = Date.now() + waitMs;
  let lastLogAt = 0;
  while (true) {
    if (_tryAcquireAtomic(holderId)) return true;
    if (Date.now() >= deadline) return false;
    if (opts.onWait && Date.now() - lastLogAt > 60_000) {
      try { opts.onWait(Date.now() - (Date.now() - 60_000), _readHolder()); } catch {}
      lastLogAt = Date.now();
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Release the lock iff we're the holder on disk. No-op if:
 *   - the lock is held by someone else (shouldn't happen in normal flow;
 *     safe behavior if we somehow try to release a lock we don't own)
 *   - AIOS_MLX_LOCK_HOLDER is set (parent holds it; parent will release)
 */
export function releaseMlxLock(holderId) {
  if (_parentHolds(holderId)) return;  // parent still holds — leave alone
  try {
    if (!existsSync(MLX_LOCK_FILE)) return;
    const who = _readHolder();
    if (who === holderId) {
      try { unlinkSync(MLX_LOCK_FILE); } catch {}
    }
  } catch {}
}

/**
 * High-level wrapper: acquire → run fn → release, even on exception.
 * Throws if the lock can't be acquired within opts.waitMs.
 */
export async function withMlxLock(holderId, fn, opts = {}) {
  const acquired = await tryMlxLock(holderId, opts);
  if (!acquired) {
    throw new Error(`aios-mlx-lock: timeout waiting ${opts.waitMs ?? MLX_LOCK_DEFAULT_WAIT_MS}ms for MLX lock (current holder: ${_readHolder() || 'none'})`);
  }
  try { return await fn(); }
  finally { releaseMlxLock(holderId); }
}

/**
 * Lightweight status reader (used by the server's _mlxDrain to decide
 * whether to yield to an external holder). Does NOT acquire.
 * Returns { held: bool, holder: string|null, ageMs: number, stale: bool }.
 */
export function mlxLockStatus() {
  try {
    if (!existsSync(MLX_LOCK_FILE)) return { held: false, holder: null, ageMs: 0, stale: false };
    const st = statSync(MLX_LOCK_FILE);
    const ageMs = Date.now() - st.mtimeMs;
    const stale = ageMs > MLX_LOCK_STALE_MS;
    const holder = _readHolder();
    return { held: !stale, holder, ageMs, stale };
  } catch { return { held: false, holder: null, ageMs: 0, stale: false }; }
}

// CLI mode: `node aios-mlx-lock.js status` — prints JSON status. Useful for
// scripts/tests to check the lock without importing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg === 'status') {
    process.stdout.write(JSON.stringify(mlxLockStatus()) + '\n');
    process.exit(0);
  }
  process.stderr.write('Usage: node aios-mlx-lock.js status\n');
  process.exit(2);
}
