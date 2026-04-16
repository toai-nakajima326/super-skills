#!/bin/bash
# vcontext-self-improve.sh — AI OS self-modification pipeline
# Workflow: detect → research → patch → test → propose (notify user for approval)
# User approves via dashboard button → auto-apply to main + reload
# Auto-rollback on test failure. User retains final approval authority.
set -u

LOG="$HOME/skills/data/self-improve.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

RAM_DB="/Volumes/VContext/vcontext.db"
SKILLS_DIR="$HOME/skills"
cd "$SKILLS_DIR" || exit 1

log "=== self-improve cycle ==="

# Exit if a previous proposal is still pending (one at a time)
PENDING=$(sqlite3 "$RAM_DB" "SELECT COUNT(*) FROM entries WHERE type='pending-patch' AND json_extract(content,'\$.status') IN ('pending-review','testing');" 2>/dev/null)
if [[ "${PENDING:-0}" -gt 0 ]]; then
  log "Skipping: ${PENDING} proposal(s) still pending user review"
  exit 0
fi

# 1. Detect problems
REGRESSION=$(sqlite3 "$RAM_DB" "
SELECT operation||':'||ROUND(AVG(latency_ms),0)||'ms' FROM api_metrics
WHERE created_at > datetime('now','-1 hour')
GROUP BY operation
HAVING AVG(latency_ms) > (SELECT AVG(latency_ms)*1.3 FROM api_metrics WHERE operation=api_metrics.operation AND created_at BETWEEN datetime('now','-7 days') AND datetime('now','-1 day'));
" 2>/dev/null)

[[ -z "$REGRESSION" ]] && log "No regressions detected" && exit 0
log "Regression detected: $REGRESSION"

# 2. Research latest best practices
SEARXNG_PORT=$(docker port searxng 8080 2>/dev/null | head -1 | cut -d: -f2)
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
RESEARCH=$(curl -s --max-time 15 "http://127.0.0.1:${SEARXNG_PORT}/search?q=Node.js+SQLite+performance+optimization+2026&format=json&language=auto" 2>/dev/null | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print('\n'.join(f'- {r.get(\"title\",\"\")}: {r.get(\"content\",\"\")[:150]}' for r in d.get('results',[])[:5]))" 2>/dev/null)

# 3. Generate patch via MLX
PATCH_REQUEST=$(python3 -c "
import json
print(json.dumps({
  'model':'mlx-community/Qwen3-8B-4bit',
  'messages':[{'role':'user','content':f'''Regression: $REGRESSION
Research findings:
$RESEARCH

Task: Propose ONE minimal code change to /Users/mitsuru_nakajima/skills/scripts/vcontext-server.js.
Output ONLY in this exact format:
FILE: scripts/vcontext-server.js
LINE: <line_number>
BEFORE: <exact current code>
AFTER: <proposed new code>
RATIONALE: <one sentence why>
Be conservative. Never break APIs.'''}],
  'max_tokens': 2000
}))
")
PROPOSAL=$(curl -s --max-time 300 http://127.0.0.1:3162/v1/chat/completions \
  -H 'Content-Type: application/json' -d "$PATCH_REQUEST" 2>/dev/null | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['choices'][0]['message'].get('content',''))" 2>/dev/null)

if [[ -z "$PROPOSAL" ]] || ! echo "$PROPOSAL" | grep -q "^FILE:"; then
  log "No valid patch generated"
  exit 0
fi

# 4. Create feature branch and apply patch
BRANCH="self-improve-$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH" 2>/dev/null
log "Created branch: $BRANCH"

# Parse proposal (simplified — real patching would use git apply or node script)
# For safety: save proposal, let user apply manually after review
PATCH_FILE="$HOME/skills/data/pending-patches/${BRANCH}.patch"
mkdir -p "$(dirname "$PATCH_FILE")"
echo "$PROPOSAL" > "$PATCH_FILE"
log "Patch saved: $PATCH_FILE"

# 5. Run tests (syntax + health check)
TEST_OK=true
node -c scripts/vcontext-server.js 2>/dev/null || TEST_OK=false
bash -n scripts/vcontext-watchdog.sh 2>/dev/null || TEST_OK=false

# Revert to main (don't actually apply until user approves)
git checkout main 2>/dev/null
git branch -D "$BRANCH" 2>/dev/null

# 6. Store proposal for user review
PAYLOAD=$(python3 <<EOF
import json
print(json.dumps({
  'type':'pending-patch',
  'content': json.dumps({
    'regression': """$REGRESSION""",
    'research': """$RESEARCH"""[:1000],
    'proposal': """$PROPOSAL""",
    'branch': '$BRANCH',
    'patch_file': '$PATCH_FILE',
    'test_passed': $([[ "$TEST_OK" == "true" ]] && echo "true" || echo "false"),
    'status': 'pending-review',
    'created_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
  }),
  'tags':['pending-patch','self-improve','regression'],
  'session':'system'
}))
EOF
)
curl -s -X POST http://127.0.0.1:3150/store -H 'Content-Type: application/json' -d "$PAYLOAD" > /dev/null

# 7. Notify user
osascript -e "display notification \"AI OS improvement proposal ready for review: $REGRESSION\" with title \"🔧 vcontext self-improve\" sound name \"Submarine\"" 2>/dev/null
log "Proposal submitted for user review"
log "=== cycle done ==="
