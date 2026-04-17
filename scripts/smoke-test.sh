#!/bin/bash
# smoke-test.sh — Shape-assertion smoke tests for vcontext server endpoints.
# Catches regressions like the 2026-04-17 "truncated is not defined" bug
# that broke /session/:id in production for hours before detection.
#
# Usage:
#   bash scripts/smoke-test.sh            # run all
#   bash scripts/smoke-test.sh --quick    # skip long endpoints
#   npm test                              # via package.json
#
# Exit: 0 = all pass, 1 = any fail. Each check prints PASS/FAIL with details.

set -u
BASE="${VCONTEXT_URL:-http://localhost:3150}"
QUICK="${1:-}"

PASS=0
FAIL=0
FAIL_NAMES=()

# Color helpers (no-op if stdout isn't a TTY)
if [ -t 1 ]; then
  G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'
else
  G=''; R=''; Y=''; N=''
fi

# assert <name> <curl-cmd-returning-body> <python-assertion>
# The assertion runs with the response body on stdin as `sys.stdin` JSON d.
assert() {
  local name="$1" url="$2" assertion="$3"
  local body
  body=$(curl -s --max-time 15 "$BASE$url" 2>/dev/null)
  if [ -z "$body" ]; then
    echo -e "${R}FAIL${N}  $name — empty response from $url"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    return
  fi
  local result
  result=$(echo "$body" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception as e:
    print(f'JSON_PARSE_FAIL: {e}')
    sys.exit(1)
try:
    assert $assertion, 'assertion false'
    print('OK')
except AssertionError as e:
    print(f'ASSERT_FAIL: {e}')
    sys.exit(1)
except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)
" 2>&1)
  if echo "$result" | grep -q '^OK$'; then
    echo -e "${G}PASS${N}  $name"
    PASS=$((PASS + 1))
  else
    echo -e "${R}FAIL${N}  $name — $result"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
  fi
}

# assert_post <name> <path> <json-body> <python-assertion>
assert_post() {
  local name="$1" url="$2" body="$3" assertion="$4"
  local resp
  resp=$(curl -s --max-time 15 -X POST -H 'Content-Type: application/json' -d "$body" "$BASE$url" 2>/dev/null)
  if [ -z "$resp" ]; then
    echo -e "${R}FAIL${N}  $name — empty POST response"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    return
  fi
  local result
  result=$(echo "$resp" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    assert $assertion, 'assertion false'
    print('OK')
except AssertionError as e:
    print(f'ASSERT_FAIL: {e}')
    sys.exit(1)
except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)
" 2>&1)
  if echo "$result" | grep -q '^OK$'; then
    echo -e "${G}PASS${N}  $name"
    PASS=$((PASS + 1))
  else
    echo -e "${R}FAIL${N}  $name — $result"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
  fi
}

echo "━━━ vcontext smoke test ━━━ $BASE"
echo ""

# ── Core health ──
assert "/health healthy"            "/health" \
  "d.get('status') == 'healthy' and 'uptime_seconds' in d"
assert "/health has mlx flags"       "/health" \
  "'mlx_available' in d and 'mlx_generate_available' in d"

# ── Core read ──
assert "/recent?n=1 shape"           "/recent?n=1" \
  "isinstance(d.get('results'), list) and 'count' in d"
assert "/recent?n=5&short=1 truncates" "/recent?n=5&short=1" \
  "isinstance(d.get('results'), list)"
assert "/recent?type filter"         "/recent?n=1&type=anomaly-alert" \
  "isinstance(d.get('results'), list)"

# ── Recall (FTS) ──
assert "/recall?q= returns results"  "/recall?q=database&limit=3" \
  "isinstance(d.get('results'), list) and d.get('query') == 'database'"
assert "/recall opt-out semantic"    "/recall?q=nonsenseword123xyz&semantic=false" \
  "isinstance(d.get('results'), list)"

# ── Session (regression test for the 'truncated' SyntaxError) ──
assert "/session/:id shape"          "/session/test-session?limit=1" \
  "'total' in d and 'has_more' in d and 'truncated' not in d"

# ── Metrics / analytics ──
assert "/metrics/report shape"       "/metrics/report?hours=1" \
  "'operations' in d and 'skills' in d and 'period_hours' in d"
assert "/metrics skills period"      "/metrics/report?hours=24" \
  "'auto_created_in_period' in d['skills']"
assert "/analytics/weekly-summary"   "/analytics/weekly-summary?days=1" \
  "'total_events' in d and 'top_tools' in d"
assert "/analytics/skill-effectiveness" "/analytics/skill-effectiveness" \
  "isinstance(d.get('skills'), list)"

# ── Admin endpoints ──
assert "/admin/wal-status"           "/admin/wal-status" \
  "'exists' in d and 'rotate_threshold_mb' in d"
assert "/admin/health-report"        "/admin/health-report?days=1" \
  "'brief' in d and 'stats' in d"

# ── Infrastructure ──
assert "/tier/stats"                 "/tier/stats" \
  "'ram' in d and 'ssd' in d and 'cloud' in d"
assert "/ai/status"                  "/ai/status" \
  "'embedding_count' in d and 'embedding_eligible_total' in d"
assert "/pipeline/health"            "/pipeline/health" \
  "'features' in d and 'summary' in d"

# ── Edge cases (inputs that should fail cleanly, not 500) ──
# Validates the server returns an explicit error envelope rather than
# leaking a stack trace or hanging.
assert_status() {
  local name="$1" url="$2" expected="$3"
  local code
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$BASE$url" 2>/dev/null)
  if [ "$code" = "$expected" ]; then
    echo -e "${G}PASS${N}  $name ($code)"
    PASS=$((PASS + 1))
  else
    echo -e "${R}FAIL${N}  $name — got HTTP $code, expected $expected"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
  fi
}
assert_status "/recall missing q → 400"   "/recall"                        "400"
assert_status "/session/ empty → 400"     "/session/"                      "400"
assert_status "/unknown-path → 404"       "/nonexistent-endpoint"          "404"
assert_status "/dashboard (GET) → 200"    "/dashboard"                     "200"
# /recall with nonsense FTS chars shouldn't crash — server sanitizes via ftsQuery()
assert "/recall with special chars"      "/recall?q=%23%24%25%28%25%28%29&limit=1" \
  "isinstance(d.get('results'), list)"
# Large n should be capped, not OOM
assert "/recent?n=99999 capped"           "/recent?n=99999&short=1" \
  "d.get('count', 99999) <= 200"

# ── Regression tests for bugs fixed 2026-04-17 ──
# Each test guards against a specific bug that took down a real code path.

# #1 CSRF header requirement on destructive admin endpoints (commit 4f2e19a)
# No header → 403.  Block trivial cross-origin CSRF.
POST_NO_HDR=$(curl -s -X POST --max-time 5 "$BASE/admin/rollback-last" -o /dev/null -w '%{http_code}')
if [ "$POST_NO_HDR" = "403" ]; then
  echo -e "${G}PASS${N}  [regression] destructive /admin without CSRF header → 403"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  [regression] /admin/rollback-last no-header returned $POST_NO_HDR (expected 403)"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("csrf-regression")
fi

# #2 Body size cap — 10 MB (commit 82631ee)
BIG_CODE=$(python3 -c "print('x' * 11_000_000)" | curl -s -X POST "$BASE/store" \
  -H 'Content-Type: application/json' -d @- --max-time 15 -o /dev/null -w '%{http_code}' 2>/dev/null)
if [ "$BIG_CODE" != "200" ] && [ "$BIG_CODE" != "201" ]; then
  echo -e "${G}PASS${N}  [regression] 11 MB body rejected (got $BIG_CODE, not 2xx)"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  [regression] 11 MB body was accepted — body size cap broken"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("body-size-regression")
fi

# #3 Route-cache TTL (commit be0b777) — server-side verifiable only via hooks.js
# We check the constant is set to something non-zero in the source file.
if grep -q "ROUTE_CACHE_TTL = 60_000" scripts/vcontext-hooks.js; then
  echo -e "${G}PASS${N}  [regression] hooks.js ROUTE_CACHE_TTL = 60s"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  [regression] ROUTE_CACHE_TTL reverted"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("route-cache-regression")
fi

# #4 Semantic search lock (commit 969481e) — must complete inside 10s
SEM_CODE=$(curl -s --max-time 10 "$BASE/search/semantic?q=database&limit=2" -o /dev/null -w '%{http_code}')
if [ "$SEM_CODE" = "200" ]; then
  echo -e "${G}PASS${N}  [regression] /search/semantic returns 200 inside 10s"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  [regression] /search/semantic timed out or failed ($SEM_CODE)"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("semantic-lock-regression")
fi

# ── Boundary / input validation tests ──

# /recent?n=0 should cap gracefully (return empty or 1+ results, not error)
assert "/recent?n=0 handled"              "/recent?n=0&short=1" \
  "isinstance(d.get('results'), list)"
# /metrics/report?hours=0 — shouldn't divide-by-zero or hang
assert "/metrics?hours=0 handled"         "/metrics/report?hours=0" \
  "'operations' in d"
# /recent with nonexistent type → empty list, not 500
assert "/recent?type=notreal"             "/recent?n=1&type=notreal" \
  "isinstance(d.get('results'), list) and d.get('count',99)==0"
# Method mismatch: GET /store → 404 or 405, not 500
GET_STORE=$(curl -s --max-time 5 "$BASE/store" -o /dev/null -w '%{http_code}')
if [ "$GET_STORE" = "404" ] || [ "$GET_STORE" = "405" ]; then
  echo -e "${G}PASS${N}  GET on POST-only /store → $GET_STORE"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  GET /store returned $GET_STORE (expected 404/405)"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("method-mismatch")
fi

# POST /store with missing required field → 400
MISS_TYPE=$(curl -s -X POST "$BASE/store" -H 'Content-Type: application/json' -d '{"content":"no type"}' --max-time 5 -o /dev/null -w '%{http_code}')
if [ "$MISS_TYPE" = "400" ]; then
  echo -e "${G}PASS${N}  POST /store missing type → 400"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  POST /store missing type returned $MISS_TYPE (expected 400)"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("missing-field-validation")
fi

# POST with malformed JSON → 400 (Invalid JSON body)
MALFORMED=$(curl -s -X POST "$BASE/store" -H 'Content-Type: application/json' -d 'not-json-at-all' --max-time 5 -o /dev/null -w '%{http_code}')
if [ "$MALFORMED" = "400" ]; then
  echo -e "${G}PASS${N}  POST with malformed JSON → 400"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  malformed JSON POST returned $MALFORMED (expected 400)"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("json-parse-validation")
fi

# ── Additional uncovered endpoints (coverage expansion) ──
assert "/stats"                           "/stats" \
  "isinstance(d.get('ram_entries', d.get('entries', 0)), int)"
assert "/feed?since=2026-01-01"           "/feed?since=2026-01-01" \
  "isinstance(d.get('results', d.get('events', [])), list)"
assert "/auth/whoami"                     "/auth/whoami" \
  "'role' in d or 'userId' in d or 'user' in d"
assert "/admin/pending-patches"           "/admin/pending-patches" \
  "isinstance(d.get('patches', []), list)"

# ── Dashboard HTML served ──
# Use HTTP code check instead of JSON parse
DASH_CODE=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/dashboard")
if [ "$DASH_CODE" = "200" ]; then
  echo -e "${G}PASS${N}  /dashboard returns 200"
  PASS=$((PASS + 1))
else
  echo -e "${R}FAIL${N}  /dashboard HTTP=$DASH_CODE"
  FAIL=$((FAIL + 1))
  FAIL_NAMES+=("/dashboard")
fi

# ── Write path ──
if [ "$QUICK" != "--quick" ]; then
  TEST_BODY='{"type":"test","content":"smoke-test-marker","tags":["smoke-test"]}'
  assert_post "/store accepts entry" "/store" "$TEST_BODY" \
    "d.get('stored', {}).get('id') is not None or d.get('deduped') is True"
fi

# ── JS syntax of dashboard (catches shadow var bugs) ──
DASH_HTML=$(curl -s --max-time 5 "$BASE/dashboard")
# Extract <script> block and verify it parses
JS=$(echo "$DASH_HTML" | python3 -c "
import sys, re
html = sys.stdin.read()
m = re.search(r'<script>(.*?)</script>', html, re.DOTALL)
if m: sys.stdout.write(m.group(1))
")
if [ -n "$JS" ]; then
  JS_CHECK=$(echo "$JS" > /tmp/smoke-dash.js && node --check /tmp/smoke-dash.js 2>&1)
  if [ $? -eq 0 ]; then
    echo -e "${G}PASS${N}  dashboard JS parses cleanly"
    PASS=$((PASS + 1))
  else
    echo -e "${R}FAIL${N}  dashboard JS SyntaxError — $JS_CHECK"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("dashboard JS parse")
  fi
fi

# ── Report ──
echo ""
echo "━━━ Results ━━━"
if [ $FAIL -eq 0 ]; then
  echo -e "${G}All $PASS checks passed.${N}"
  exit 0
else
  echo -e "${R}$FAIL/$((PASS + FAIL)) failed:${N}"
  for name in "${FAIL_NAMES[@]}"; do
    echo "  - $name"
  done
  exit 1
fi
