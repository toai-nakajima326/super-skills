#!/bin/bash
# skill-discovery.sh — Weekly AI/dev trend scanning and skill gap registration
# Schedule: Monday 09:30 via com.vcontext.skill-discovery LaunchAgent
#
# Phases: GitHub trending → Exa search (optional) → skill-registry diff →
#         MLX gap analysis → save YYYY-MM-DD.json → register skill-gap entries
#
# Safety: never creates SKILL.md files — all candidates require human review.

set -u

SERVER="http://127.0.0.1:3150"
MLX_GEN="${MLX_GENERATE_URL:-http://127.0.0.1:3162}"
OUT_DIR="$HOME/skills/data/skill-discovery"
LOG="/tmp/vcontext-skill-discovery.log"
mkdir -p "$OUT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

DATE=$(date +%Y-%m-%d)
log "=== skill-discovery ($DATE) ==="

# Guard: vcontext must be up
if ! curl -sf "$SERVER/health" > /dev/null 2>&1; then
  log "vcontext not healthy — skipping"
  osascript -e "display notification \"vcontext not up — skill-discovery skipped\" with title \"⚠️ skill-discovery\"" 2>/dev/null
  exit 1
fi

# ── Phase 1: GitHub Trending ──────────────────────────────────────────────────
log "Fetching GitHub trending..."
TRENDING=$(curl -s --max-time 20 "https://github.com/trending?since=weekly" 2>/dev/null | \
  python3 -c "
import sys, re
html = sys.stdin.read()
repos = re.findall(r'href=\"/([a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+)\"[^>]*>', html)
descs = re.findall(r'<p\s+class=\"[^\"]*col-9[^\"]*\"[^>]*>\s*(.*?)\s*</p>', html, re.DOTALL)
seen, results, desc_idx = set(), [], 0
for repo in repos:
    if repo in seen: continue
    seen.add(repo)
    desc = re.sub(r'\s+', ' ', descs[desc_idx]).strip()[:120] if desc_idx < len(descs) else ''
    results.append(f'{repo}: {desc}')
    desc_idx += 1
    if len(results) >= 20: break
print('\n'.join(results))
" 2>/dev/null)

[[ -z "$TRENDING" ]] && TRENDING="(GitHub trending unavailable)"
log "GitHub trending: $(echo "$TRENDING" | grep -c '/' 2>/dev/null || echo 0) repos"

# ── Phase 2: Exa Search (optional) ───────────────────────────────────────────
EXA_RESULTS=""
if [[ -n "${EXA_API_KEY:-}" ]]; then
  log "EXA_API_KEY found — fetching trends..."
  LAST_RUN_FILE="$HOME/.skills-discovery-last-run"
  if [[ -f "$LAST_RUN_FILE" ]]; then
    AFTER_DATE="$(cat "$LAST_RUN_FILE" | tr -d '[:space:]')T00:00:00.000Z"
  else
    AFTER_DATE="2026-01-01T00:00:00.000Z"
  fi

  while IFS= read -r TOPIC; do
    [[ -z "$TOPIC" ]] && continue
    BODY=$(python3 -c "
import json, sys
topic, after = sys.argv[1], sys.argv[2]
print(json.dumps({
  'query': topic,
  'numResults': 3,
  'startPublishedDate': after,
  'useAutoprompt': True,
  'type': 'neural',
  'contents': {'highlights': {'numSentences': 2}}
}))" "$TOPIC" "$AFTER_DATE" 2>/dev/null)
    RESULT=$(curl -s --max-time 20 "https://api.exa.ai/search" \
      -H "x-api-key: $EXA_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$BODY" 2>/dev/null | \
      python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for r in d.get('results', []):
        hl = ' '.join(r.get('highlights', ['']))[:200]
        print(f\"- {r.get('title', '')}: {hl}\")
except: pass" 2>/dev/null)
    [[ -n "$RESULT" ]] && EXA_RESULTS="${EXA_RESULTS}[${TOPIC}]"$'\n'"${RESULT}"$'\n'
  done << 'TOPICS'
AI agent patterns 2026
LLM orchestration framework 2026
MCP model context protocol
Claude agent SDK patterns
local LLM Apple Silicon MLX 2026
agentic workflow automation tools
TOPICS
  log "Exa: $(echo "$EXA_RESULTS" | wc -l | tr -d ' ') lines collected"
else
  log "EXA_API_KEY not set — GitHub trending only"
fi

# ── Phase 3: Fetch skill-registry from vcontext ───────────────────────────────
log "Fetching skill-registry..."
EXISTING_SKILLS=$(curl -s --max-time 15 \
  "$SERVER/recall?q=skill-registry&limit=200&type=skill-registry" 2>/dev/null | \
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    names = []
    for e in d.get('results', []):
        try:
            c = json.loads(e.get('content', '{}'))
            n = c.get('name') or c.get('skill_name') or ''
            if n: names.append(n)
        except: pass
    print(', '.join(sorted(set(names))))
except: pass" 2>/dev/null)

SKILL_COUNT=$(echo "${EXISTING_SKILLS:-}" | tr ',' '\n' | grep -c '\S' 2>/dev/null || echo 0)
log "Existing skills: $SKILL_COUNT"

# ── Phase 4: MLX gap analysis ─────────────────────────────────────────────────
log "Running MLX gap analysis..."

# Export to env vars for safe multi-line handling in Python
export _SD_TRENDING="${TRENDING:0:2000}"
export _SD_EXA="${EXA_RESULTS:0:2000}"
export _SD_SKILLS="${EXISTING_SKILLS:0:1000}"

GAP_PAYLOAD=$(python3 - << 'PYEOF'
import json, os

prompt = f"""あなたはAIスキルライブラリのギャップ分析エキスパートです。

## 既存スキル（カンマ区切り）
{os.environ.get('_SD_SKILLS', '(none)')}

## 今週のGitHub Trending
{os.environ.get('_SD_TRENDING', '(none)')}

## 最新AI動向（Exa）
{os.environ.get('_SD_EXA', '(not available)')}

## タスク
既存スキル一覧と最新動向を比較し、まだスキル化されていない重要なパターンを3〜5個特定してください。

各候補を以下の形式で出力してください（この形式を厳守）:
CANDIDATE: <skill-name-kebab-case>
DESCRIPTION: <Use when で始まる1文の英語説明>
SOURCE: <ソース名またはURL>
PRIORITY: <P0/P1/P2/P3/P4>
---
"""

print(json.dumps({
    "model": "mlx-community/Qwen3-8B-4bit",
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": 1500,
    "temperature": 0.3
}))
PYEOF
)

ANALYSIS=$(curl -s --max-time 120 "$MLX_GEN/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$GAP_PAYLOAD" 2>/dev/null | \
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'])
except: pass" 2>/dev/null)

if [[ -z "$ANALYSIS" ]]; then
  log "MLX unavailable — saving raw data without analysis"
  ANALYSIS="(MLX gap analysis unavailable)"
fi
log "Gap analysis: $(echo "$ANALYSIS" | wc -c | tr -d ' ') bytes"

# ── Phase 5: Save JSON output ─────────────────────────────────────────────────
OUT_FILE="$OUT_DIR/$DATE.json"
export _SD_ANALYSIS="$ANALYSIS"
export _SD_DATE="$DATE"
export _SD_SKILL_COUNT="$SKILL_COUNT"

python3 - << 'PYEOF' > "$OUT_FILE"
import json, datetime, os
print(json.dumps({
    "date": os.environ.get("_SD_DATE"),
    "run_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "github_trending": os.environ.get("_SD_TRENDING", ""),
    "exa_results": os.environ.get("_SD_EXA") or None,
    "existing_skill_count": int(os.environ.get("_SD_SKILL_COUNT", 0)),
    "existing_skills": os.environ.get("_SD_SKILLS", ""),
    "gap_analysis": os.environ.get("_SD_ANALYSIS", ""),
}, ensure_ascii=False, indent=2))
PYEOF
log "Saved: $OUT_FILE"

# ── Phase 6: Parse candidates and register to vcontext ───────────────────────
REGISTERED=0
CAND_NAME="" CAND_DESC="" CAND_SOURCE="" CAND_PRIO=""

while IFS= read -r LINE; do
  case "$LINE" in
    CANDIDATE:*)   CAND_NAME=$(echo "${LINE#CANDIDATE:}" | xargs | tr ' ' '-' | tr '[:upper:]' '[:lower:]') ;;
    DESCRIPTION:*) CAND_DESC=$(echo "${LINE#DESCRIPTION:}" | xargs) ;;
    SOURCE:*)      CAND_SOURCE=$(echo "${LINE#SOURCE:}" | xargs) ;;
    PRIORITY:*)    CAND_PRIO=$(echo "${LINE#PRIORITY:}" | xargs) ;;
    ---)
      if [[ -n "${CAND_NAME:-}" ]]; then
        export _SD_CNAME="$CAND_NAME"
        export _SD_CDESC="${CAND_DESC:-}"
        export _SD_CSRC="${CAND_SOURCE:-}"
        export _SD_CPRIO="${CAND_PRIO:-P4}"
        export _SD_CDATE="$DATE"

        PAYLOAD=$(python3 - << 'PYEOF'
import json, os
print(json.dumps({
    "type": "skill-gap",
    "content": json.dumps({
        "name": os.environ["_SD_CNAME"],
        "description": os.environ.get("_SD_CDESC", ""),
        "source": os.environ.get("_SD_CSRC", ""),
        "priority": os.environ.get("_SD_CPRIO", "P4"),
        "discovered_date": os.environ["_SD_CDATE"],
        "status": "candidate",
        "note": "Auto-discovered by skill-discovery. Human review required before SKILL.md creation."
    }),
    "tags": ["skill-gap", "skill-discovery", os.environ["_SD_CDATE"]],
    "session": "system"
}))
PYEOF
)
        curl -s -X POST "$SERVER/store" \
          -H 'Content-Type: application/json' \
          -d "$PAYLOAD" > /dev/null 2>&1
        log "Registered skill-gap: $CAND_NAME (${CAND_PRIO:-P4})"
        REGISTERED=$((REGISTERED + 1))
        CAND_NAME="" CAND_DESC="" CAND_SOURCE="" CAND_PRIO=""
      fi
      ;;
  esac
done <<< "$ANALYSIS"

# ── Done ──────────────────────────────────────────────────────────────────────
echo "$DATE" > "$HOME/.skills-discovery-last-run"

NOTIF="${REGISTERED} skill-gap candidates registered | ${SKILL_COUNT} existing skills | $DATE"
osascript -e "display notification \"$NOTIF\" with title \"🔍 skill-discovery\" sound name \"Glass\"" 2>/dev/null

log "Done: $REGISTERED candidates registered"
log "=== skill-discovery complete ==="
exit 0
