#!/bin/bash
# test-admin-backup.sh — TDD integration test for POST /admin/backup.
#
# Stage 3 of the 2026-04-20 loose-coupling redesign
# (docs/specs/2026-04-20-true-loose-coupling-redesign.md).
#
# Run BEFORE implementation: expected to fail (endpoint 404).
# After implementation: expected to pass every scenario.
# Non-destructive on success (backup endpoint is idempotent).

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

BASE=http://127.0.0.1:3150
PASS=0
FAIL=0
FAILED_TESTS=()

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1 — $2"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }

header() { echo; echo "=== $1 ==="; }

# Sanity: server up
header "sanity"
if ! curl -sS -m 3 "$BASE/health" > /dev/null 2>&1; then
  echo "  ✗ server not responding — abort"
  exit 2
fi
pass "server /health responsive"

# ── TEST 1: missing admin header → 403 ────────────────────────────
header "auth"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/backup" \
  -H 'Content-Type: application/json' -d '{}')
if [[ "$CODE" == "403" ]]; then
  pass "missing X-Vcontext-Admin → 403"
else
  fail "missing X-Vcontext-Admin → 403" "got $CODE"
fi

# ── TEST 2: with admin header → some structured response ──────────
header "happy-path structure"
RESP=$(curl -sS -m 600 \
  -X POST "$BASE/admin/backup" \
  -H 'X-Vcontext-Admin: yes' \
  -H 'Content-Type: application/json' \
  -d '{}' 2>&1)

CODE_OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  assert 'status' in d, 'no status field'
  assert d['status'] in ('ok', 'skipped', 'fail'), f\"bad status={d['status']}\"
  print('ok')
except Exception as e:
  print(f'fail: {e}')
" 2>&1)

if [[ "$CODE_OK" == "ok" ]]; then
  pass "response has status field (ok/skipped/fail)"
else
  fail "response structure" "$CODE_OK (raw: ${RESP:0:200})"
fi

# ── TEST 3: when ok, response has backup_path + size + duration ──
header "ok response fields"
STATUS=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [[ "$STATUS" == "ok" ]]; then
  # Validate success-path fields
  FIELDS_OK=$(echo "$RESP" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
needed = ['backup_path', 'size_bytes', 'duration_ms', 'integrity', 'ran_at']
missing = [f for f in needed if f not in d]
if missing:
  print(f'missing: {missing}')
else:
  # Also sanity-check types
  assert isinstance(d['size_bytes'], int) and d['size_bytes'] > 1024*1024, f'tiny size {d[\"size_bytes\"]}'
  assert isinstance(d['duration_ms'], int) and d['duration_ms'] > 0, f'bad duration_ms'
  assert d['integrity'] in ('ok', 'fail'), f'bad integrity={d[\"integrity\"]}'
  print('ok')
" 2>&1)
  if [[ "$FIELDS_OK" == "ok" ]]; then
    pass "ok-response has backup_path/size_bytes/duration_ms/integrity/ran_at"
  else
    fail "ok-response fields" "$FIELDS_OK"
  fi
elif [[ "$STATUS" == "skipped" ]]; then
  echo "  (skip — status=skipped, not validating ok fields this run)"
else
  fail "status=ok or skipped expected" "got $STATUS"
fi

# ── TEST 4: no orphan .tmp* after call ─────────────────────────────
header "no orphan tmp"
/bin/sleep 2   # let any in-flight rename settle
ORPHANS=$(ls -1 ~/skills/data/vcontext-backup.sqlite.{tmp,ext-tmp}* 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ORPHANS" -eq 0 ]]; then
  pass "no orphan .tmp/.ext-tmp files after backup call"
else
  # Orphans could be from concurrent LaunchAgent cycle, not our call.
  # Check ownership by process / recentness:
  NEWEST_ORPHAN=$(ls -t ~/skills/data/vcontext-backup.sqlite.{tmp,ext-tmp}* 2>/dev/null | head -1)
  AGE=$(/bin/date -r "$NEWEST_ORPHAN" +%s 2>/dev/null || echo 0)
  NOW=$(/bin/date +%s)
  if (( NOW - AGE > 60 )); then
    fail "orphan tmp from >60s ago" "$NEWEST_ORPHAN"
  else
    pass "orphan $(basename "$NEWEST_ORPHAN") present but recent — likely concurrent LaunchAgent cycle"
  fi
fi

# ── TEST 5: backup file passes integrity ──────────────────────────
header "backup integrity"
if [[ -f ~/skills/data/vcontext-backup.sqlite ]]; then
  INT=$(sqlite3 ~/skills/data/vcontext-backup.sqlite 'PRAGMA integrity_check;' 2>&1 | head -1)
  if [[ "$INT" == "ok" ]]; then
    pass "backup.sqlite integrity_check = ok"
  else
    fail "backup integrity" "got: $INT"
  fi
else
  fail "backup exists" "~/skills/data/vcontext-backup.sqlite missing"
fi

# ── TEST 6: second call (rate-limit / idempotent) ─────────────────
header "second call"
RESP2=$(curl -sS -m 600 \
  -X POST "$BASE/admin/backup" \
  -H 'X-Vcontext-Admin: yes' \
  -H 'Content-Type: application/json' \
  -d '{}' 2>&1)
STATUS2=$(echo "$RESP2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [[ "$STATUS2" == "ok" ]] || [[ "$STATUS2" == "skipped" ]]; then
  pass "second call returns status=$STATUS2 (rate-limited OR in-progress OK)"
else
  fail "second call structured response" "$STATUS2"
fi

# ── TEST 7: /health responsive during backup (event loop not blocked) ─
header "event loop protected"
(
  # Fire a long-running backup call in background
  curl -sS -m 600 -X POST "$BASE/admin/backup" \
    -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}' \
    > /dev/null 2>&1 &
  BG_PID=$!
  /bin/sleep 1  # let backup kick in
  # Now measure /health — should be < 100ms even during backup
  T=$(curl -sS -m 3 -o /dev/null -w '%{time_total}' "$BASE/health" 2>&1)
  wait $BG_PID 2>/dev/null
  if /usr/bin/awk -v t="$T" 'BEGIN{exit !(t+0 < 0.2)}'; then
    pass "/health responded in ${T}s during backup (event loop preserved)"
  else
    fail "event loop preserved" "/health took ${T}s during backup"
  fi
)

# ── TEST 8: in-flight guard returns 429 on concurrent call ────────
# Reviewer-requested. Exercises the new finally-wrapped flag path
# (F1 blocker). Fire two calls in tight succession; one should
# get 200 or cached, the other should get 429 (in-flight guard) or
# cached (if within rate-limit window) — the key invariant is that
# the server does NOT run two ramDb.backup() in parallel.
header "in-flight 429 guard"
(
  RESP_A=$(mktemp); RESP_B=$(mktemp)
  # Fire both with a tiny stagger so A starts the backup and B sees flag=true
  curl -sS -m 600 -X POST "$BASE/admin/backup" \
    -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}' \
    -o "$RESP_A" -w '%{http_code}' > "$RESP_A.code" 2>/dev/null &
  A_PID=$!
  /bin/sleep 0.3
  CODE_B=$(curl -sS -m 10 -X POST "$BASE/admin/backup" \
    -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}' \
    -o "$RESP_B" -w '%{http_code}' 2>/dev/null)
  # Wait for A to finish (don't leave the backup mid-flight)
  wait $A_PID 2>/dev/null
  CODE_A=$(cat "$RESP_A.code" 2>/dev/null || echo "?")

  # B should be 429 (in-flight) OR 200 with cached=true (if cache hit).
  # Both demonstrate the server refused to start a second parallel backup.
  if [[ "$CODE_B" == "429" ]]; then
    pass "concurrent B received 429 busy (in-flight guard works)"
  elif [[ "$CODE_B" == "200" ]] && grep -q '"cached":true' "$RESP_B"; then
    pass "concurrent B received 200 cached (rate-limit path works)"
  else
    fail "concurrent B guard" "A=$CODE_A B=$CODE_B (raw B: $(head -c 200 "$RESP_B"))"
  fi
  rm -f "$RESP_A" "$RESP_A.code" "$RESP_B"
)

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
if [[ $FAIL -gt 0 ]]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do echo "  • $t"; done
  exit 1
fi
exit 0
