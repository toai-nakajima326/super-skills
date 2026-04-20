#!/bin/bash
# test-admin-wal-checkpoint.sh — TDD integration test for POST /admin/wal-checkpoint.
#
# Stage 4 of the 2026-04-20 loose-coupling redesign
# (docs/specs/2026-04-20-true-loose-coupling-redesign.md).
#
# Write BEFORE implementation (RED). Implementation is expected to pass
# every scenario (GREEN).
#
# Endpoint contract (target):
#   POST /admin/wal-checkpoint
#   Auth: X-Vcontext-Admin: yes
#   Body: { mode?: "PASSIVE"|"FULL"|"RESTART"|"TRUNCATE" }  default TRUNCATE
#   Returns: { status, mode, busy, log, checkpointed, duration_ms, ran_at }
#
# Why this exists: external `sqlite3 PRAGMA wal_checkpoint(TRUNCATE)` held
# a lock on primary.sqlite, causing the 3 GB WAL incident. Server-internal
# endpoint uses ramDb's own connection — no file-lock contention with the
# server's writers.

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

BASE=http://127.0.0.1:3150
PASS=0
FAIL=0
FAILED_TESTS=()

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1 — $2"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }
header() { echo; echo "=== $1 ==="; }

header "sanity"
if ! curl -sS -m 3 "$BASE/health" > /dev/null 2>&1; then
  echo "  ✗ server not responding — abort"
  exit 2
fi
pass "server /health responsive"

# ── T1: missing admin header → 403 ────────────────────────────────
header "auth"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/wal-checkpoint" \
  -H 'Content-Type: application/json' -d '{}')
if [[ "$CODE" == "403" ]]; then
  pass "missing X-Vcontext-Admin → 403"
else
  fail "auth" "got $CODE (endpoint not implemented yet? acceptable during RED)"
fi

# ── T2: default mode → structured response ────────────────────────
header "default mode"
RESP=$(curl -sS -m 30 \
  -X POST "$BASE/admin/wal-checkpoint" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')

STATUS=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [[ "$STATUS" == "ok" ]]; then
  pass "default mode returns status=ok"
else
  fail "default mode" "got status=$STATUS (raw: ${RESP:0:150})"
fi

# ── T3: response has busy/log/checkpointed integers ───────────────
header "response fields"
FIELDS=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  for f in ['busy', 'log', 'checkpointed', 'mode', 'duration_ms']:
    if f not in d: print(f'missing: {f}'); sys.exit(0)
    if f in ['busy','log','checkpointed','duration_ms'] and not isinstance(d[f], int):
      print(f'not-int: {f}={d[f]}'); sys.exit(0)
  print('ok')
except Exception as e: print(f'parse: {e}')
" 2>/dev/null)
if [[ "$FIELDS" == "ok" ]]; then
  pass "response has busy/log/checkpointed/mode/duration_ms fields with proper types"
else
  fail "response fields" "$FIELDS"
fi

# ── T4: explicit mode=PASSIVE ─────────────────────────────────────
header "explicit PASSIVE mode"
RESP_P=$(curl -sS -m 10 \
  -X POST "$BASE/admin/wal-checkpoint" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d '{"mode":"PASSIVE"}')
MODE_P=$(echo "$RESP_P" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null)
if [[ "$MODE_P" == "PASSIVE" ]]; then
  pass "mode=PASSIVE echoed back"
else
  fail "PASSIVE echo" "got mode=$MODE_P"
fi

# ── T5: invalid mode → 400 ────────────────────────────────────────
header "invalid mode rejection"
CODE_BAD=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/wal-checkpoint" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d '{"mode":"EVIL_MODE"}')
if [[ "$CODE_BAD" == "400" ]]; then
  pass "invalid mode → 400"
else
  fail "invalid mode" "got $CODE_BAD (expected 400)"
fi

# ── T6: /health during checkpoint (event loop preserved) ──────────
header "event loop"
(
  curl -sS -m 30 -X POST "$BASE/admin/wal-checkpoint" \
    -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
    -d '{"mode":"TRUNCATE"}' > /dev/null 2>&1 &
  BG=$!
  /bin/sleep 0.1
  T=$(curl -sS -m 3 -o /dev/null -w '%{time_total}' "$BASE/health" 2>&1)
  wait $BG 2>/dev/null
  if /usr/bin/awk -v t="$T" 'BEGIN{exit !(t+0 < 0.2)}'; then
    pass "/health during checkpoint responded in ${T}s (<200ms)"
  else
    fail "event loop" "/health took ${T}s during checkpoint"
  fi
)

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && { echo "Failed:"; for t in "${FAILED_TESTS[@]}"; do echo "  • $t"; done; exit 1; }
exit 0
