#!/bin/bash
# attack-test.sh — Adversarial / chaos probes against running vcontext.
#
# Probes are idempotent, but CUMULATIVE LOAD (28 probes + 10 concurrent
# writes + giant bodies) has OOM'd the server in the past. Two safeguards:
#   1. ATTACK_SLEEP_MS (default 300) paces every probe. Bump to 1000 for
#      a stressed server, or to 100 if you're trying to reproduce burst
#      crashes on purpose.
#   2. ATTACK_CONCURRENCY (default 10) caps the JSONL-race burst so the
#      test doesn't itself become the DoS it's meant to detect.

set -u
BASE="${VCONTEXT_URL:-http://localhost:3150}"
ATTACK_SLEEP_MS="${ATTACK_SLEEP_MS:-300}"
ATTACK_CONCURRENCY="${ATTACK_CONCURRENCY:-10}"
if [ -t 1 ]; then G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; N='\033[0m'
else G=''; R=''; Y=''; N=''; fi

PASS=0; FAIL=0; WEAK=()
_sleep() { python3 -c "import time;time.sleep($ATTACK_SLEEP_MS/1000)" 2>/dev/null || sleep 0.3; }

probe() {
  local name="$1" url="$2" expected_codes="$3"
  _sleep
  local code=$(curl -s --max-time 15 "$BASE$url" -o /dev/null -w '%{http_code}' 2>/dev/null)
  if [[ "$expected_codes" == *"$code"* ]]; then
    echo -e "${G}OK${N}   $name ($code)"; PASS=$((PASS+1))
  else
    echo -e "${R}WEAK${N} $name → $code (expected: $expected_codes)"; FAIL=$((FAIL+1)); WEAK+=("$name")
  fi
}

probe_post() {
  local name="$1" url="$2" body="$3" expected_codes="$4"
  _sleep
  local code=$(curl -s --max-time 15 -X POST "$BASE$url" \
    -H 'Content-Type: application/json' -d "$body" \
    -o /dev/null -w '%{http_code}' 2>/dev/null)
  if [[ "$expected_codes" == *"$code"* ]]; then
    echo -e "${G}OK${N}   $name ($code)"; PASS=$((PASS+1))
  else
    echo -e "${R}WEAK${N} $name → $code (expected: $expected_codes)"; FAIL=$((FAIL+1)); WEAK+=("$name")
  fi
}

probe_timing() {
  local name="$1" url="$2" max_sec="$3"
  local t0=$(python3 -c "import time;print(time.time())")
  curl -s --max-time "$((max_sec * 2))" "$BASE$url" -o /dev/null
  local t1=$(python3 -c "import time;print(time.time())")
  local ok=$(python3 -c "print(1 if $t1-$t0 <= $max_sec else 0)")
  local dur=$(python3 -c "print(f'{$t1-$t0:.1f}')")
  if [ "$ok" = "1" ]; then
    echo -e "${G}OK${N}   $name (${dur}s ≤ ${max_sec}s)"; PASS=$((PASS+1))
  else
    echo -e "${R}WEAK${N} $name (${dur}s > ${max_sec}s — DoS risk)"; FAIL=$((FAIL+1)); WEAK+=("$name")
  fi
}

echo "━━━ adversarial probes against $BASE ━━━"

echo ""
echo "--- SQL injection probes (should sanitize, not 500) ---"
for payload in "' OR 1=1 --" "'; DROP TABLE entries; --" "' UNION SELECT * --"; do
  enc=$(python3 -c "import urllib.parse;print(urllib.parse.quote('''$payload'''))")
  probe "SQLi: ${payload:0:20}" "/recall?q=$enc&limit=1" "200 400"
done

echo ""
echo "--- Path traversal ---"
for p in "../../../etc/passwd" "..%2F..%2Fetc%2Fpasswd" "/etc/passwd"; do
  probe "session/ path: $p" "/session/$p?limit=1" "200 400 404"
done

echo ""
echo "--- Unicode / control chars ---"
probe "4-byte emoji" "/recall?q=%F0%9F%8E%89&limit=1" "200"
probe "NUL byte" "/recall?q=hi%00evil&limit=1" "200 400"
probe "CRLF" "/recall?q=%0D%0Ainjected&limit=1" "200"

echo ""
echo "--- DoS / boundary values ---"
probe_timing "5KB q completes ≤5s" "/recall?q=$(python3 -c 'print("a"*5000)')&limit=1" "5"
probe "limit=0" "/recall?q=test&limit=0" "200 400"
probe "limit=-5" "/recall?q=test&limit=-5" "200 400"
probe "limit=9e9" "/recall?q=test&limit=9999999999" "200 400"
probe "recent n=-1" "/recent?n=-1" "200"
probe "metrics hours=-10" "/metrics/report?hours=-10" "200"
probe "metrics hours=999999" "/metrics/report?hours=999999" "200"

echo ""
echo "--- Auth / admin spoofing ---"
probe_post "admin/approve-patch no-header" "/admin/approve-patch" '{"id":1}' "403"
probe_post "admin/rollback-last no-header" "/admin/rollback-last" '{}' "403"
probe_post "admin/replay-wal no-header" "/admin/replay-wal" '{}' "403"

hdr_probe() {
  local name="$1" hdr="$2"
  local code=$(curl -s -X POST --max-time 5 "$BASE/admin/rollback-last" \
    -H "X-Vcontext-Admin: $hdr" -o /dev/null -w '%{http_code}')
  if [ "$code" = "403" ]; then
    echo -e "${G}OK${N}   admin rejects X-Vcontext-Admin='$hdr'"; PASS=$((PASS+1))
  else
    echo -e "${R}WEAK${N} admin accepts '$hdr' → $code"; FAIL=$((FAIL+1)); WEAK+=("hdr:$hdr")
  fi
}
hdr_probe "empty-string" ""
hdr_probe "truthy" "true"
hdr_probe "uppercase" "YES"
hdr_probe "spaced" " yes"

echo ""
echo "--- Type confusion ---"
probe_post "store type=null" "/store" '{"type":null,"content":"x"}' "400"
probe_post "store type=number" "/store" '{"type":123,"content":"x"}' "400"
probe_post "store type=empty" "/store" '{"type":"","content":"x"}' "400"
probe_post "store content=null" "/store" '{"type":"test","content":null}' "400"

echo ""
echo "--- Pending-patch RCE regression ---"
rce='{"type":"pending-patch","content":"{\"proposal\":\"FILE: foo.js; rm -rf /tmp/x\\nBEFORE: a\\nAFTER: b\",\"status\":\"pending-review\"}","tags":["pending-patch"]}'
store_resp=$(curl -s -X POST "$BASE/store" -H 'Content-Type: application/json' -d "$rce")
patch_id=$(echo "$store_resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('stored',{}).get('id',''))" 2>/dev/null)
if [ -n "$patch_id" ]; then
  code=$(curl -s -X POST --max-time 5 "$BASE/admin/approve-patch" \
    -H 'Content-Type: application/json' -H 'X-Vcontext-Admin: yes' \
    -d "{\"id\":$patch_id}" -o /tmp/rce.json -w '%{http_code}')
  if [ "$code" = "400" ] && grep -q "invalid characters" /tmp/rce.json; then
    echo -e "${G}OK${N}   RCE: malicious FILE rejected ($code)"; PASS=$((PASS+1))
  else
    echo -e "${R}WEAK${N} RCE: approve returned $code — $(head -c 100 /tmp/rce.json)"
    FAIL=$((FAIL+1)); WEAK+=("rce-regression")
  fi
  # Cleanup — without this every run leaves a scary-looking
  # pending-patch (`FILE: foo.js; rm -rf …`) on the dashboard. The
  # approve flow correctly rejects it, but the entry itself persists.
  # /admin/reject-patch flips status→rejected so the dashboard hides it.
  curl -s -X POST --max-time 5 "$BASE/admin/reject-patch" \
    -H 'Content-Type: application/json' -H 'X-Vcontext-Admin: yes' \
    -d "{\"id\":$patch_id}" -o /dev/null
fi

echo ""
echo "--- JSONL concurrent write race (concurrency=$ATTACK_CONCURRENCY) ---"
B=$(wc -l < "$HOME/skills/data/entries-wal.jsonl")
for i in $(seq 1 "$ATTACK_CONCURRENCY"); do
  (curl -s -X POST "$BASE/store" -H 'Content-Type: application/json' \
     -d "{\"type\":\"test\",\"content\":\"chaos-$i-$(date +%N)\"}" > /dev/null) &
done
wait
sleep 1
corrupt=$(tail -15 "$HOME/skills/data/entries-wal.jsonl" | python3 -c "
import sys, json
bad = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: json.loads(line)
    except: bad += 1
print(bad)
")
if [ "$corrupt" = "0" ]; then
  A=$(wc -l < "$HOME/skills/data/entries-wal.jsonl")
  echo -e "${G}OK${N}   10 concurrent stores → JSONL clean (B=$B A=$A)"; PASS=$((PASS+1))
else
  echo -e "${R}WEAK${N} JSONL has $corrupt bad lines after concurrent writes"
  FAIL=$((FAIL+1)); WEAK+=("jsonl-corrupted")
fi

echo ""
echo "━━━ Results ━━━"
if [ "$FAIL" = "0" ]; then
  echo -e "${G}All $PASS probes handled correctly.${N}"
  exit 0
else
  echo -e "${R}$FAIL/$((PASS+FAIL)) weaknesses:${N}"
  for w in "${WEAK[@]}"; do echo "  - $w"; done
  exit 1
fi
