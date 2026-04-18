#!/usr/bin/env bash
# test-aios-gate.sh — tests the PreToolUse AIOS hard-gate in vcontext-hooks.js
#
# Scenarios:
#   (a) Edit to a non-AIOS file → passes
#   (b) Edit to an AIOS file without prior skill-usage → BLOCKS
#   (c) Edit to an AIOS file with INFINITE_SKILLS_OK=1 → passes
#   (d) Edit to an AIOS file with prior skill-usage cached → passes
#
# The gate runs a hard block via {"continue":false,"stopReason":"..."} JSON
# emission. We grep stdout for that pattern to assert BLOCK vs PASS.
#
# Works whether or not vcontext server is reachable — the gate fails
# open on infra errors, so we use a unique session per test and a file
# cache flag to simulate prior skill-usage for case (d).

set -u
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node"
PASS=0
FAIL=0

# Shared suffix for unique session ids (epoch-ns)
SESSION_PREFIX="aios-gate-test-$(date +%s)-$$"

run_hook() {
  # $1 = session_id, $2 = tool_name, $3 = file_path or command, $4 = extra env (may be empty)
  local sid="$1" tool="$2" target="$3" extra="${4:-}"
  local input_field="file_path"
  if [ "$tool" = "Bash" ]; then input_field="command"; fi
  local payload
  payload=$(cat <<JSON
{"session_id":"$sid","tool_name":"$tool","tool_input":{"$input_field":"$target"}}
JSON
)
  # Age the session-start sentinel past the 30s cold-start grace window
  # so the gate evaluates path matching + skill-usage check.
  local safe_sid
  safe_sid=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9-')
  local start_flag="/tmp/vcontext-session-start-$safe_sid.flag"
  printf '%s' "$(( $(date +%s) * 1000 - 60000 ))" > "$start_flag"
  if [ -n "$extra" ]; then
    printf '%s' "$payload" | env $extra "$NODE" "$HOOKS" pre-tool 2>/dev/null
  else
    printf '%s' "$payload" | "$NODE" "$HOOKS" pre-tool 2>/dev/null
  fi
}

assert() {
  # $1 = label, $2 = expected (PASS|BLOCK), $3 = actual output
  local label="$1" expected="$2" actual="$3"
  local got="PASS"
  if printf '%s' "$actual" | grep -q '"continue":false'; then got="BLOCK"; fi
  if [ "$got" = "$expected" ]; then
    echo "  PASS: $label (expected=$expected got=$got)"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $label (expected=$expected got=$got)"
    echo "    output: $(printf '%s' "$actual" | head -c 300)"
    FAIL=$((FAIL+1))
  fi
}

cleanup_caches() {
  local sid="$1"
  local safe
  safe=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9-')
  rm -f "/tmp/vcontext-skill-usage-$safe.flag" "/tmp/vcontext-session-start-$safe.flag"
}

echo "== AIOS hard-gate tests =="

# (a) non-AIOS file → PASS
SID_A="${SESSION_PREFIX}-a"
cleanup_caches "$SID_A"
OUT=$(run_hook "$SID_A" "Edit" "/tmp/not-aios-test-file.txt")
assert "(a) Edit to /tmp/not-aios-test-file.txt" "PASS" "$OUT"
cleanup_caches "$SID_A"

# (b) AIOS file without prior skill-usage → BLOCK
SID_B="${SESSION_PREFIX}-b"
cleanup_caches "$SID_B"
OUT=$(run_hook "$SID_B" "Edit" "/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js")
assert "(b) Edit to ~/skills/ without routing" "BLOCK" "$OUT"
cleanup_caches "$SID_B"

# (c) AIOS file with INFINITE_SKILLS_OK=1 → PASS
SID_C="${SESSION_PREFIX}-c"
cleanup_caches "$SID_C"
OUT=$(run_hook "$SID_C" "Edit" "/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js" "INFINITE_SKILLS_OK=1")
assert "(c) Edit to ~/skills/ with INFINITE_SKILLS_OK=1" "PASS" "$OUT"
cleanup_caches "$SID_C"

# (d) AIOS file with prior skill-usage cached → PASS
SID_D="${SESSION_PREFIX}-d"
cleanup_caches "$SID_D"
SAFE_D=$(printf '%s' "$SID_D" | tr -cd 'A-Za-z0-9-')
# Seed the per-session cache flag the gate consults (within 6h TTL).
printf '1' > "/tmp/vcontext-skill-usage-$SAFE_D.flag"
OUT=$(run_hook "$SID_D" "Edit" "/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js")
assert "(d) Edit to ~/skills/ with prior skill-usage" "PASS" "$OUT"
cleanup_caches "$SID_D"

# Extras: LaunchAgent and Bash (rm) path
SID_E="${SESSION_PREFIX}-e"
cleanup_caches "$SID_E"
OUT=$(run_hook "$SID_E" "Write" "/Users/mitsuru_nakajima/Library/LaunchAgents/com.vcontext.newagent.plist")
assert "(e) Write to com.vcontext.* LaunchAgent without routing" "BLOCK" "$OUT"
cleanup_caches "$SID_E"

SID_F="${SESSION_PREFIX}-f"
cleanup_caches "$SID_F"
OUT=$(run_hook "$SID_F" "Bash" "rm /Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js")
assert "(f) Bash rm inside ~/skills/ without routing" "BLOCK" "$OUT"
cleanup_caches "$SID_F"

SID_G="${SESSION_PREFIX}-g"
cleanup_caches "$SID_G"
OUT=$(run_hook "$SID_G" "Read" "/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js")
assert "(g) Read on ~/skills/ — read-only tool, never gated" "PASS" "$OUT"
cleanup_caches "$SID_G"

echo "== Done: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
