#!/bin/bash
# test-task-dispatch-paths.sh — AIOS Task Queue: verify three adhoc dispatch paths.
#
# Submits one task for each of:
#   - skill-discovery-adhoc   (invokes scripts/skill-discovery.sh)
#   - article-scan-adhoc      (invokes scripts/article-scanner.js --dry-run --max 1)
#   - self-evolve-dryrun      (invokes skills/self-evolve/scripts/self-evolve.js --observation)
#
# For each task, polls until a task-result appears, verifies the status is one of
#   { completed, failed-with-expected-error, skipped_already_running }, and prints
# a short summary. Exits 0 only when all three complete successfully (or with an
# acceptable "skipped_already_running" marker which is the idempotence signal).
#
# Usage:  bash scripts/test-task-dispatch-paths.sh
#
# Safety: article-scan is invoked with --dry-run so no writes to vcontext occur.
# self-evolve is invoked with --observation so Phase c-e (mutations) are skipped.
# skill-discovery.sh does POST to vcontext but is idempotent by design (upserts
# by skill-name + date).

set -u

VCONTEXT="${VCONTEXT_URL:-http://127.0.0.1:3150}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-1500}"   # 25 min — accommodates back-to-back runs
SLEEP_SECS=3

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

fail() { red "[FAIL] $*"; exit 1; }

# ── sanity ──
if ! curl -sS --max-time 5 "$VCONTEXT/health" >/dev/null; then
  fail "vcontext /health unreachable at $VCONTEXT"
fi
if ! curl -sS --max-time 5 "$VCONTEXT/admin/task-queue" >/dev/null; then
  fail "/admin/task-queue unreachable — server not patched?"
fi

# Submit a task and echo the request_id.
submit_task() {
  local body="$1"
  local resp
  resp=$(curl -sS -X POST -H 'Content-Type: application/json' --max-time 10 -d "$body" "$VCONTEXT/admin/task-request")
  if [[ -z "$resp" ]]; then
    red "[submit] empty response"
    return 1
  fi
  echo "$resp" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
      try { console.log(JSON.parse(s).request_id||""); } catch { console.log(""); }
    });
  '
}

# Wait for a task-result matching request_id, print status + tail of stdout/stderr.
# Exit 0 on acceptable result, 1 otherwise.
wait_for_result() {
  local request_id="$1"
  local label="$2"
  local waited=0
  while (( waited < MAX_WAIT_SECS )); do
    local queue found
    queue=$(curl -sS --max-time 5 "$VCONTEXT/admin/task-queue" 2>/dev/null || echo '{}')
    found=$(echo "$queue" | node -e '
      let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
        try {
          const d = JSON.parse(s);
          const want = process.argv[1];
          const r = (d.recent_results || []).find(x => x.request_id === want);
          if (r) console.log(JSON.stringify(r));
        } catch {}
      });
    ' "$request_id")
    if [[ -n "$found" ]]; then
      # Fetch the full task-result entry via /recall to see result.stdout / result.stderr.
      local recall detail
      recall=$(curl -sS --max-time 5 "$VCONTEXT/recall?q=$request_id&type=task-result&limit=5" 2>/dev/null || echo '{}')
      detail=$(echo "$recall" | node -e '
        let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
          try {
            const d = JSON.parse(s);
            const want = process.argv[1];
            const e = (d.results || []).find(x => String(x.content||"").includes(want));
            if (e) {
              const c = JSON.parse(e.content);
              const r = c.result || {};
              const skipped = r.skipped || null;
              const out = {
                status: c.status, error: c.error, duration_ms: c.duration_ms,
                skipped,
                stdout_tail: String(r.stdout||"").split("\n").slice(-8).join("\n"),
                stderr_tail: String(r.stderr||"").split("\n").slice(-5).join("\n"),
              };
              console.log(JSON.stringify(out));
            }
          } catch (e) { console.error(e.message); }
        });
      ' "$request_id")
      if [[ -z "$detail" ]]; then
        red "[$label] could not fetch task-result detail for $request_id"
        return 1
      fi
      echo "---- [$label] result ----"
      echo "$detail" | node -e '
        let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
          try {
            const d = JSON.parse(s);
            console.log("status       :", d.status);
            console.log("duration_ms  :", d.duration_ms);
            if (d.skipped) console.log("skipped      :", d.skipped);
            if (d.error) console.log("error        :", d.error);
            console.log("stdout_tail  :", "\n" + (d.stdout_tail||"").replace(/^/gm,"  | "));
            if (d.stderr_tail) console.log("stderr_tail  :", "\n" + d.stderr_tail.replace(/^/gm,"  | "));
          } catch (e) { console.log("raw:", s); }
        });
      '
      local status skipped
      status=$(echo "$detail" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).status||"")}catch{}})')
      skipped=$(echo "$detail" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).skipped||"")}catch{}})')
      if [[ "$status" == "completed" ]]; then
        if [[ -n "$skipped" ]]; then
          yellow "[$label] completed with skipped=$skipped (idempotence guard fired — acceptable)"
        else
          green "[$label] completed ok"
        fi
        return 0
      fi
      red "[$label] status=$status (expected completed)"
      return 1
    fi
    sleep "$SLEEP_SECS"
    waited=$((waited + SLEEP_SECS))
    if (( waited % 15 == 0 )); then
      yellow "[$label] waiting… ${waited}s / ${MAX_WAIT_SECS}s"
    fi
  done
  red "[$label] timed out after ${MAX_WAIT_SECS}s"
  return 1
}

run_one() {
  local label="$1" body="$2"
  bold ">>> $label"
  local rid
  rid=$(submit_task "$body") || fail "submit failed for $label"
  if [[ -z "$rid" ]]; then
    fail "no request_id returned for $label"
  fi
  echo "[$label] request_id=$rid"
  wait_for_result "$rid" "$label" || fail "$label did not complete"
}

# ── Tests ──
# skill-discovery-adhoc: empty payload. LaunchAgent is disabled outside Mon 09:30,
# so there should be no concurrent invocation.
run_one "skill-discovery-adhoc" '{
  "task_type": "skill-discovery-adhoc",
  "priority": 1,
  "requested_by": "test-task-dispatch-paths.sh",
  "payload": {}
}'

# article-scan-adhoc: use --dry-run + --max 1 to keep the run fast and side-effect-free.
run_one "article-scan-adhoc" '{
  "task_type": "article-scan-adhoc",
  "priority": 1,
  "requested_by": "test-task-dispatch-paths.sh",
  "payload": { "dry_run": true, "max": 1, "verbose": false }
}'

# self-evolve-dryrun: observation mode only (Phase c-e skipped by the script).
# Also pass dry_run_only=true so Phase a-b writes are suppressed.
run_one "self-evolve-dryrun" '{
  "task_type": "self-evolve-dryrun",
  "priority": 1,
  "requested_by": "test-task-dispatch-paths.sh",
  "payload": { "dry_run_only": true }
}'

green "[PASS] all three dispatch paths completed"
exit 0
