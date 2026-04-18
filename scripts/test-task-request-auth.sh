#!/bin/bash
# test-task-request-auth.sh — verify X-Vcontext-Admin header gate on
# POST /admin/task-request for task_type=shell-command.
#
# Acceptance criteria (from docs/spec/2026-04-18-task-request-admin-header.md):
#   AC1: no header + shell-command           → 403
#   AC2: no header + locomo-eval (non-shell) → 202/200 (no regression)
#   AC3: header + shell-command + approved_by_user=true → 200 (enqueued)
#   AC4: header + shell-command + approved_by_user=false → 403 (existing guard)
#
# Usage:  bash scripts/test-task-request-auth.sh
# Exit:   0 all PASS, 1 any FAIL

set -u

VCONTEXT="${VCONTEXT_URL:-http://127.0.0.1:3150}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# Sanity
if ! curl -sS --max-time 5 "$VCONTEXT/health" >/dev/null; then
  red "[FAIL] vcontext /health unreachable at $VCONTEXT"
  exit 2
fi

FAILS=0
TOTAL=0

# Helper: submit and capture HTTP status + body.
#   $1 = label
#   $2 = expected HTTP status (regex, e.g. '200|202' or '403')
#   $3 = body JSON
#   $4 = extra curl args (e.g. "-H 'X-Vcontext-Admin: yes'")
check() {
  local label="$1"
  local expect_re="$2"
  local body="$3"
  shift 3
  TOTAL=$((TOTAL+1))
  bold "[AC] $label"
  local http_code response
  # Write body to stdout, status to stderr via -w.
  response=$(curl -sS -o /tmp/task-req-body.$$ -w '%{http_code}' \
                 -X POST -H 'Content-Type: application/json' "$@" \
                 --max-time 10 -d "$body" "$VCONTEXT/admin/task-request" 2>&1)
  http_code="$response"
  local resp_body; resp_body=$(cat /tmp/task-req-body.$$ 2>/dev/null || echo '')
  rm -f /tmp/task-req-body.$$

  printf '  status=%s body=%s\n' "$http_code" "$resp_body"
  if [[ "$http_code" =~ ^($expect_re)$ ]]; then
    green "  PASS (got $http_code, expected match: $expect_re)"
  else
    red "  FAIL (got $http_code, expected match: $expect_re)"
    FAILS=$((FAILS+1))
  fi
  echo
}

# Unique marker so we can spot any accidentally enqueued items in vcontext.
MARKER="task-auth-test-$(date +%s)-$$"

# ── AC1: no header + shell-command → expect 403 ──
BODY_AC1=$(cat <<EOF
{
  "task_type": "shell-command",
  "requested_by": "test-auth-ac1-$MARKER",
  "payload": {
    "cmd": "echo should-not-run-ac1-$MARKER",
    "approved_by_user": true
  }
}
EOF
)
check "AC1 no-header + shell-command → 403" '403' "$BODY_AC1"

# ── AC2: no header + locomo-eval (non-shell) → expect 200/202 (no regression) ──
# locomo-eval requires payload.dataset; supply something structurally valid.
# The handler accepts any object-shaped payload, so we supply dry-run style args.
BODY_AC2=$(cat <<EOF
{
  "task_type": "locomo-eval",
  "requested_by": "test-auth-ac2-$MARKER",
  "payload": {
    "dataset": "data/locomo-mock.json",
    "max_samples": 1,
    "dry_run": true,
    "marker": "$MARKER"
  }
}
EOF
)
check "AC2 no-header + locomo-eval (non-shell) → 200" '200|202' "$BODY_AC2"

# ── AC3: header + shell-command + approved_by_user=true → expect 200 ──
BODY_AC3=$(cat <<EOF
{
  "task_type": "shell-command",
  "requested_by": "test-auth-ac3-$MARKER",
  "payload": {
    "cmd": "echo ac3-ok-$MARKER",
    "timeout_ms": 5000,
    "approved_by_user": true
  }
}
EOF
)
check "AC3 header + shell-command + approved=true → 200" '200|202' \
      "$BODY_AC3" -H 'X-Vcontext-Admin: yes'

# ── AC4: header + shell-command + approved_by_user=false → expect 403 ──
BODY_AC4=$(cat <<EOF
{
  "task_type": "shell-command",
  "requested_by": "test-auth-ac4-$MARKER",
  "payload": {
    "cmd": "echo should-not-run-ac4-$MARKER",
    "approved_by_user": false
  }
}
EOF
)
check "AC4 header + shell-command + approved=false → 403" '403' \
      "$BODY_AC4" -H 'X-Vcontext-Admin: yes'

bold "────────────────────────────────"
if (( FAILS == 0 )); then
  green "[test-task-request-auth] ALL PASS ($TOTAL/$TOTAL)"
  exit 0
else
  red   "[test-task-request-auth] FAILED ($FAILS/$TOTAL failures)"
  exit 1
fi
