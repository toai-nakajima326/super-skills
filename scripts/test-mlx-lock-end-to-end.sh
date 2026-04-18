#!/usr/bin/env bash
# test-mlx-lock-end-to-end.sh — Verify cross-language MLX lock coordination.
#
# Spawns concurrent "users" of /tmp/aios-mlx-lock (Node + Python + shell)
# and verifies they serialize correctly:
#   1. First acquirer holds the lock.
#   2. Second acquirer blocks until first releases.
#   3. Third acquirer (via the shell helper) also blocks.
#   4. Re-entrancy: with AIOS_MLX_LOCK_HOLDER set, acquire is a no-op.
#   5. Release-by-non-owner is a safe no-op.
#   6. Stale-lock recovery: an old lock file gets auto-cleared.
#
# Exit 0 on success. Prints a readable pass/fail trace to stdout.
#
# Prereqs: node, python3, bash, jq (optional for JSON pretty-print).

set -euo pipefail

REPO=${REPO:-/Users/mitsuru_nakajima/skills}
LOCK=/tmp/aios-mlx-lock
SCRATCH=/tmp/aios-mlx-lock-test.$$
mkdir -p "$SCRATCH"
trap 'rm -f "$LOCK" 2>/dev/null; rm -rf "$SCRATCH"' EXIT

pass=0
fail=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS  $label"
    pass=$((pass+1))
  else
    echo "  FAIL  $label  (expected=$expected actual=$actual)"
    fail=$((fail+1))
  fi
}

# ───────── Scenario 1: Node holds, Python waits, then acquires ─────────
echo
echo "Scenario 1: Node acquires + holds 3s, Python waits up to 10s, acquires after."

rm -f "$LOCK"

# Node: acquire, sleep 3s, release. Write timestamps so we can verify order.
node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  const ok = await m.tryMlxLock("node-holder", { waitMs: 1000 });
  if (!ok) { console.error("node failed to acquire"); process.exit(2); }
  console.log(JSON.stringify({ who: "node", event: "acquired", at: Date.now() }));
  await new Promise(r => setTimeout(r, 3000));
  console.log(JSON.stringify({ who: "node", event: "releasing", at: Date.now() }));
  m.releaseMlxLock("node-holder");
  process.exit(0);
});
' > "$SCRATCH/node.log" 2>&1 &
NODE_PID=$!

# Give Node a beat to acquire.
sleep 0.5

# Python: try to acquire, waiting up to 10s.
python3 -c '
import sys, time, json
sys.path.insert(0, "'"$REPO"'/scripts")
from aios_mlx_lock import try_mlx_lock, release_mlx_lock
t0 = time.time() * 1000
got = try_mlx_lock("python-waiter", wait_s=10.0)
t1 = time.time() * 1000
print(json.dumps({"who":"python", "acquired": got, "waited_ms": int(t1-t0)}))
if got:
    release_mlx_lock("python-waiter")
' > "$SCRATCH/python.log" 2>&1 &
PY_PID=$!

wait $NODE_PID
NODE_RC=$?
wait $PY_PID
PY_RC=$?

echo "  node exit=$NODE_RC  python exit=$PY_RC"
echo "  node log:" ; sed 's/^/    /' "$SCRATCH/node.log"
echo "  py log:"   ; sed 's/^/    /' "$SCRATCH/python.log"

check "node exit 0" 0 "$NODE_RC"
check "python exit 0" 0 "$PY_RC"

py_got=$(python3 -c 'import json,sys; print(json.load(open("'"$SCRATCH"'/python.log")).get("acquired"))')
py_wait=$(python3 -c 'import json,sys; print(json.load(open("'"$SCRATCH"'/python.log")).get("waited_ms"))')
check "python did acquire" True "$py_got"
# Python should have waited ~2.5s (3s - 0.5s head-start). Allow 1500-5000ms band.
if [ "$py_wait" -ge 1500 ] && [ "$py_wait" -le 5000 ]; then
  echo "  PASS  python wait=${py_wait}ms is in expected 1500-5000ms band"
  pass=$((pass+1))
else
  echo "  FAIL  python wait=${py_wait}ms outside 1500-5000ms band"
  fail=$((fail+1))
fi

# ───────── Scenario 2: Shell holds, Node tries with short timeout → fails ─────────
echo
echo "Scenario 2: Shell acquires + holds 2s, Node waits 500ms → timeout."

rm -f "$LOCK"

(
  "$REPO/scripts/aios-mlx-lock.sh" acquire "sh-holder" 2
  sleep 2
  "$REPO/scripts/aios-mlx-lock.sh" release "sh-holder"
) > "$SCRATCH/sh.log" 2>&1 &
SH_PID=$!

sleep 0.2

node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  const ok = await m.tryMlxLock("node-impatient", { waitMs: 500 });
  console.log(JSON.stringify({ acquired: ok }));
  process.exit(0);
});
' > "$SCRATCH/node-impatient.log" 2>&1 &
NI_PID=$!

wait $NI_PID
NI_RC=$?
ni_got=$(python3 -c 'import json,sys; print(json.load(open("'"$SCRATCH"'/node-impatient.log")).get("acquired"))')
check "node impatient exit 0" 0 "$NI_RC"
check "node impatient did NOT acquire" False "$ni_got"

wait $SH_PID || true

# ───────── Scenario 3: Re-entrancy via AIOS_MLX_LOCK_HOLDER ─────────
echo
echo "Scenario 3: parent holds, child with matching env acquires as no-op."

rm -f "$LOCK"

# Parent acquires
"$REPO/scripts/aios-mlx-lock.sh" acquire "parent-holder" 5
# Child with env var should return acquired=true instantly (no-op).
export AIOS_MLX_LOCK_HOLDER="parent-holder"
child_result=$(node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  const t0 = Date.now();
  const ok = await m.tryMlxLock("child-caller", { waitMs: 100 });
  console.log(JSON.stringify({ acquired: ok, wait_ms: Date.now() - t0 }));
  m.releaseMlxLock("child-caller"); // should NOT unlink the file
  process.exit(0);
});
')
echo "  child result: $child_result"
child_acq=$(python3 -c "import json; print(json.loads('''$child_result''').get('acquired'))")
check "child (env-match) acquired instantly" True "$child_acq"

# Parent's lock should STILL be on disk (child release was a no-op)
if [ -f "$LOCK" ]; then
  echo "  PASS  parent lock survived child's release"
  pass=$((pass+1))
else
  echo "  FAIL  child release clobbered parent lock"
  fail=$((fail+1))
fi

# Same test via Python child
py_result=$(python3 -c '
import json, sys, time
sys.path.insert(0, "'"$REPO"'/scripts")
from aios_mlx_lock import try_mlx_lock, release_mlx_lock
t0 = time.time() * 1000
ok = try_mlx_lock("py-child", wait_s=0.1)
t1 = time.time() * 1000
release_mlx_lock("py-child")
print(json.dumps({"acquired": ok, "wait_ms": int(t1-t0)}))
')
echo "  py child: $py_result"
py_acq=$(python3 -c "import json; print(json.loads('''$py_result''').get('acquired'))")
check "python child (env-match) acquired instantly" True "$py_acq"
if [ -f "$LOCK" ]; then
  echo "  PASS  parent lock survived python child's release"
  pass=$((pass+1))
else
  echo "  FAIL  python child release clobbered parent lock"
  fail=$((fail+1))
fi

unset AIOS_MLX_LOCK_HOLDER
"$REPO/scripts/aios-mlx-lock.sh" release "parent-holder"

# ───────── Scenario 4: Release-by-non-owner is safe ─────────
echo
echo "Scenario 4: non-owner release leaves lock alone."

rm -f "$LOCK"
"$REPO/scripts/aios-mlx-lock.sh" acquire "original-owner" 5
# Someone else tries to release with wrong id — should be a no-op.
"$REPO/scripts/aios-mlx-lock.sh" release "not-the-owner"

if [ -f "$LOCK" ]; then
  echo "  PASS  non-owner release was a safe no-op"
  pass=$((pass+1))
else
  echo "  FAIL  non-owner release clobbered the lock"
  fail=$((fail+1))
fi

# Real owner releases.
"$REPO/scripts/aios-mlx-lock.sh" release "original-owner"
if [ ! -f "$LOCK" ]; then
  echo "  PASS  real-owner release unlinked the lock"
  pass=$((pass+1))
else
  echo "  FAIL  real-owner release failed"
  fail=$((fail+1))
fi

# ───────── Scenario 5: Stale-lock auto-clear ─────────
echo
echo "Scenario 5: stale lock (>25 min mtime) auto-cleared on acquire."

rm -f "$LOCK"
printf 'ancient-holder\n' > "$LOCK"
# Age the mtime 30 min into the past.
touch -t "$(date -v-30M +%Y%m%d%H%M.%S 2>/dev/null || date -d '30 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK"

# New acquire should succeed (stale cleared).
node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  const ok = await m.tryMlxLock("fresh-holder", { waitMs: 1000 });
  console.log(JSON.stringify({ acquired: ok }));
  m.releaseMlxLock("fresh-holder");
  process.exit(0);
});
' > "$SCRATCH/stale.log" 2>&1
stale_acq=$(python3 -c 'import json; print(json.load(open("'"$SCRATCH"'/stale.log")).get("acquired"))')
check "stale lock auto-cleared on acquire" True "$stale_acq"

# ───────── Scenario 6: Dead-PID stale detection (D1 2026-04-18) ─────────
echo
echo "Scenario 6: mlxLockStatus detects dead-PID holder <1s (D1)."

rm -f "$LOCK"
# Fork a Python child, capture its PID, kill it, then write a lock file
# containing that now-dead PID. mlxLockStatus should flag stale=true with
# pidDead=true and immediately reclaim the file.
DEAD_PID=$(python3 -c 'import os,sys,time
pid = os.fork()
if pid == 0:
    time.sleep(0.05); os._exit(0)
else:
    os.waitpid(pid, 0)
    print(pid)')
echo "  dead pid (child, waited): $DEAD_PID"
# Double-check — the PID should be truly gone.
if kill -0 "$DEAD_PID" 2>/dev/null; then
  echo "  FAIL  PID $DEAD_PID is still alive, skipping scenario 6"
  fail=$((fail+1))
else
  printf 'fake-holder:pid-%s\n' "$DEAD_PID" > "$LOCK"
  # Give it a fresh mtime (now) so mtime-stale is false — only PID-dead
  # should trigger reclaim.
  touch "$LOCK"

  # Check timing: status should return stale=true AND reclaim the file.
  status_json=$(node -e '
  import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
    const t0 = Date.now();
    const s = m.mlxLockStatus();
    const took = Date.now() - t0;
    console.log(JSON.stringify({ ...s, took_ms: took }));
    process.exit(0);
  });
  ')
  echo "  status: $status_json"
  s_stale=$(python3 -c "import json; print(json.loads('''$status_json''').get('stale'))")
  s_piddead=$(python3 -c "import json; print(json.loads('''$status_json''').get('pidDead'))")
  s_took=$(python3 -c "import json; print(json.loads('''$status_json''').get('took_ms'))")
  check "stale flagged true on dead PID" True "$s_stale"
  check "pidDead flagged true on dead PID" True "$s_piddead"
  if [ "$s_took" -lt 1000 ]; then
    echo "  PASS  dead-PID detection took ${s_took}ms (< 1000ms budget)"
    pass=$((pass+1))
  else
    echo "  FAIL  dead-PID detection took ${s_took}ms (>= 1000ms)"
    fail=$((fail+1))
  fi
  # Status is supposed to RECLAIM the lock file when pidDead==true.
  if [ ! -f "$LOCK" ]; then
    echo "  PASS  dead-PID lock was reclaimed by status call"
    pass=$((pass+1))
  else
    echo "  FAIL  dead-PID lock survived status call — expected reclaim"
    fail=$((fail+1))
  fi

  # Python side should see the same: dead PID → reclaim.
  printf 'fake-holder:pid-%s\n' "$DEAD_PID" > "$LOCK"
  touch "$LOCK"
  py_status_json=$(python3 -c '
import json, sys
sys.path.insert(0, "'"$REPO"'/scripts")
from aios_mlx_lock import mlx_lock_status
print(json.dumps(mlx_lock_status()))
')
  echo "  py status: $py_status_json"
  py_stale=$(python3 -c "import json; print(json.loads('''$py_status_json''').get('stale'))")
  py_piddead=$(python3 -c "import json; print(json.loads('''$py_status_json''').get('pid_dead'))")
  check "python stale flagged on dead PID" True "$py_stale"
  check "python pid_dead flagged on dead PID" True "$py_piddead"

  # Shell side: parse of pid and kill -0 behaviour.
  printf 'fake-holder:pid-%s\n' "$DEAD_PID" > "$LOCK"
  touch "$LOCK"
  sh_status=$("$REPO/scripts/aios-mlx-lock.sh" status)
  echo "  sh status: $sh_status"
  sh_stale=$(python3 -c "import json; print(json.loads('''$sh_status''').get('stale'))")
  sh_piddead=$(python3 -c "import json; print(json.loads('''$sh_status''').get('pid_dead'))")
  check "shell stale flagged on dead PID" True "$sh_stale"
  check "shell pid_dead flagged on dead PID" True "$sh_piddead"
fi

# ───────── Scenario 7: task-runner re-entrancy via exported env ─────────
echo
echo "Scenario 7: parent holds, child spawned with AIOS_MLX_LOCK_HOLDER env."
echo "            child's acquire is an instant no-op (re-entrant)."

rm -f "$LOCK"
# Parent acquires via Node helper.
node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  const ok = await m.tryMlxLock("task-runner:scn7-parent", { waitMs: 1000 });
  if (!ok) { console.error("parent failed to acquire"); process.exit(2); }
  console.log("parent acquired");
  process.exit(0);
});
' > "$SCRATCH/scn7-parent.log" 2>&1
# Now spawn a child with the env var set, mimicking what task-runner's
# execFile with { env: { ..., AIOS_MLX_LOCK_HOLDER: "task-runner:scn7-parent" } } does.
export AIOS_MLX_LOCK_HOLDER="task-runner:scn7-parent"
child_py=$(python3 -c '
import json, sys, time
sys.path.insert(0, "'"$REPO"'/scripts")
from aios_mlx_lock import try_mlx_lock, release_mlx_lock
t0 = time.time() * 1000
ok = try_mlx_lock("locomo-eval:pid-1234", wait_s=0.1)
t1 = time.time() * 1000
release_mlx_lock("locomo-eval:pid-1234")
print(json.dumps({"acquired": ok, "wait_ms": int(t1-t0)}))
')
echo "  python child: $child_py"
cpy_acq=$(python3 -c "import json; print(json.loads('''$child_py''').get('acquired'))")
cpy_wait=$(python3 -c "import json; print(json.loads('''$child_py''').get('wait_ms'))")
check "python child (task-runner env) acquired instantly" True "$cpy_acq"
if [ "$cpy_wait" -lt 100 ]; then
  echo "  PASS  python child wait=${cpy_wait}ms < 100ms (no-op)"
  pass=$((pass+1))
else
  echo "  FAIL  python child wait=${cpy_wait}ms >= 100ms (not a no-op)"
  fail=$((fail+1))
fi
# Parent lock must survive.
if [ -f "$LOCK" ]; then
  echo "  PASS  parent lock survived task-runner-style child"
  pass=$((pass+1))
else
  echo "  FAIL  child release clobbered parent lock"
  fail=$((fail+1))
fi
unset AIOS_MLX_LOCK_HOLDER

# Parent releases.
node -e '
import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
  m.releaseMlxLock("task-runner:scn7-parent");
  process.exit(0);
});
' > /dev/null 2>&1

# ───────── Scenario 8: SIGKILL orphan recovery (D1) ─────────
echo
echo "Scenario 8: SIGKILL-orphan lock is recovered in <1s via PID-liveness."

rm -f "$LOCK"
# Spawn a Python child that acquires and then exec-replaces itself with
# `sleep infinity` so we have a known-PID holder we can SIGKILL. We write
# its PID into the lock (using a format the helper recognises).
python3 -c '
import os, sys
sys.path.insert(0, "'"$REPO"'/scripts")
from aios_mlx_lock import _try_acquire_atomic
hid = f"orphan-test:pid-{os.getpid()}"
assert _try_acquire_atomic(hid), "child acquire failed"
# exec replaces process with `sleep infinity` — PID stays the same.
os.execvp("sleep", ["sleep", "60"])
' &
ORPHAN_PID=$!
# Wait briefly for the child to acquire and exec.
sleep 0.5
# Confirm the lock is held by the child's PID.
on_disk=$(cat "$LOCK" 2>/dev/null || echo "")
echo "  lock held by: $on_disk (orphan pid=$ORPHAN_PID)"
if ! echo "$on_disk" | grep -q "pid-$ORPHAN_PID"; then
  echo "  FAIL  orphan didn't acquire; skipping scenario 8"
  kill -9 "$ORPHAN_PID" 2>/dev/null || true
  fail=$((fail+1))
else
  # Now SIGKILL the orphan without giving it a chance to clean up.
  kill -9 "$ORPHAN_PID" 2>/dev/null || true
  wait "$ORPHAN_PID" 2>/dev/null || true
  # The lock file still exists (finally/__exit__ didn't fire).
  if [ ! -f "$LOCK" ]; then
    echo "  FAIL  lock file vanished before PID-liveness check (unexpected)"
    fail=$((fail+1))
  else
    # mlxLockStatus should detect dead-PID and reclaim < 1s.
    t0=$(python3 -c 'import time; print(int(time.time()*1000))')
    node -e '
    import("'"$REPO"'/scripts/aios-mlx-lock.js").then(async m => {
      const s = m.mlxLockStatus();
      console.log(JSON.stringify(s));
      process.exit(0);
    });
    ' > "$SCRATCH/scn8.log" 2>&1
    t1=$(python3 -c 'import time; print(int(time.time()*1000))')
    took=$(( t1 - t0 ))
    s_json=$(cat "$SCRATCH/scn8.log")
    echo "  status after SIGKILL: $s_json (took=${took}ms)"
    s_piddead=$(python3 -c "import json; print(json.loads('''$s_json''').get('pidDead'))")
    check "SIGKILL orphan flagged pidDead=true" True "$s_piddead"
    if [ "$took" -lt 1000 ]; then
      echo "  PASS  orphan-lock reclaimed in ${took}ms (< 1000ms)"
      pass=$((pass+1))
    else
      echo "  FAIL  orphan-lock reclaim took ${took}ms (>= 1000ms)"
      fail=$((fail+1))
    fi
    if [ ! -f "$LOCK" ]; then
      echo "  PASS  orphan-lock file was unlinked"
      pass=$((pass+1))
    else
      echo "  FAIL  orphan-lock file still present"
      fail=$((fail+1))
    fi
  fi
fi

# ───────── Summary ─────────
echo
echo "════════════════════════════════════════════"
echo "  passed=$pass  failed=$fail"
echo "════════════════════════════════════════════"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
