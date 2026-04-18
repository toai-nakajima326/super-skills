#!/bin/bash
# test-task-queue.sh — AIOS Task Queue end-to-end smoke test.
#
# Submits a trivial shell-command task, polls until it completes,
# verifies the result contains expected stdout. Exit 0 on pass.
#
# Usage:  bash scripts/test-task-queue.sh

set -u

VCONTEXT="${VCONTEXT_URL:-http://127.0.0.1:3150}"
MARKER="aios-task-queue-smoke-$(date +%s)-$$"
MAX_WAIT_SECS=60
SLEEP_SECS=2

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }

echo "[test-task-queue] marker=$MARKER"

# Sanity: vcontext + endpoint reachable.
if ! curl -sS --max-time 5 "$VCONTEXT/health" >/dev/null; then
  red "[FAIL] vcontext /health unreachable at $VCONTEXT"
  exit 2
fi
if ! curl -sS --max-time 5 "$VCONTEXT/admin/task-queue" >/dev/null; then
  red "[FAIL] /admin/task-queue unreachable — endpoint not deployed?"
  exit 2
fi

# Submit a trivial shell-command task that echoes a unique marker.
REQUEST_BODY=$(cat <<EOF
{
  "task_type": "shell-command",
  "priority": 1,
  "requested_by": "test-task-queue.sh",
  "payload": {
    "cmd": "echo $MARKER && date +%s",
    "timeout_ms": 10000,
    "approved_by_user": true
  }
}
EOF
)

SUBMIT_RESP=$(curl -sS -X POST -H 'Content-Type: application/json' --max-time 10 -d "$REQUEST_BODY" "$VCONTEXT/admin/task-request")
if [[ -z "$SUBMIT_RESP" ]]; then
  red "[FAIL] submit returned empty response"
  exit 3
fi
REQUEST_ID=$(echo "$SUBMIT_RESP" | node -e 'let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).request_id||"")}catch{console.log("")}})')
if [[ -z "$REQUEST_ID" ]]; then
  red "[FAIL] could not parse request_id from submit response:"
  echo "$SUBMIT_RESP"
  exit 3
fi
echo "[test-task-queue] submitted request_id=$REQUEST_ID"

# Poll until we see a task-result for this request_id.
waited=0
while (( waited < MAX_WAIT_SECS )); do
  QUEUE=$(curl -sS --max-time 5 "$VCONTEXT/admin/task-queue" 2>/dev/null || echo '{}')
  FOUND=$(echo "$QUEUE" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      try {
        const d = JSON.parse(s);
        const want = process.argv[1];
        const r = (d.recent_results || []).find(x => x.request_id === want);
        if (r) console.log(JSON.stringify(r));
      } catch {}
    });
  ' "$REQUEST_ID")
  if [[ -n "$FOUND" ]]; then
    echo "[test-task-queue] result: $FOUND"
    STATUS=$(echo "$FOUND" | node -e 'let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).status||"")}catch{}})')
    if [[ "$STATUS" != "completed" ]]; then
      red "[FAIL] task did not complete (status=$STATUS)"
      exit 4
    fi
    # Double-check the stdout contains our marker via /recall.
    RECALL=$(curl -sS --max-time 5 "$VCONTEXT/recall?q=$MARKER&type=task-result&limit=5" 2>/dev/null || echo '{}')
    MATCH=$(echo "$RECALL" | node -e '
      let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
        try {
          const d = JSON.parse(s);
          const want = process.argv[1];
          const hit = (d.results || []).find(e => String(e.content || "").includes(want));
          console.log(hit ? "yes" : "no");
        } catch { console.log("err"); }
      });
    ' "$MARKER")
    if [[ "$MATCH" != "yes" ]]; then
      red "[FAIL] /recall did not return an entry containing marker $MARKER"
      echo "$RECALL" | head -c 400
      exit 5
    fi
    green "[PASS] task completed, stdout contains marker, /recall finds it"
    exit 0
  fi
  sleep "$SLEEP_SECS"
  waited=$((waited + SLEEP_SECS))
  yellow "[test-task-queue] waiting for result… (${waited}s / ${MAX_WAIT_SECS}s)"
done

red "[FAIL] timed out after ${MAX_WAIT_SECS}s waiting for task-result for $REQUEST_ID"
exit 6
