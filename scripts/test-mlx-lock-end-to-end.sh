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

# ───────── Summary ─────────
echo
echo "════════════════════════════════════════════"
echo "  passed=$pass  failed=$fail"
echo "════════════════════════════════════════════"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
