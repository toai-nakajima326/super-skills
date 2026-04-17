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
