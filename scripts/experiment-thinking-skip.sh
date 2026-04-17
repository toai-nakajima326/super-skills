#!/bin/bash
# experiment-thinking-skip.sh — A/B test Qwen3 thinking vs /no_think for
# summarization task. Reads real entries from vcontext, generates 10
# summaries each way, measures latency + output length, reports results.
# Non-destructive — writes nothing back to the DB.

set -u
N="${1:-10}"
MODEL="mlx-community/Qwen3-8B-4bit"
OUT_DIR="$HOME/skills/data/experiments"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/thinking-skip-$TS.json"

echo "[experiment] thinking-skip A/B × $N samples"
echo "[experiment] output: $OUT"

# Sample N diverse entries (between 500-2000 chars) from RAM DB
SAMPLES=$(sqlite3 /Volumes/VContext/vcontext.db \
  "SELECT id, substr(content, 1, 1500) FROM entries WHERE length(content) BETWEEN 500 AND 2000 AND type IN ('tool-use','assistant-response','user-prompt') ORDER BY RANDOM() LIMIT $N;" 2>/dev/null)

if [[ -z "$SAMPLES" ]]; then
  echo "[experiment] No samples available — exiting"
  exit 1
fi

echo "[" > "$OUT"
FIRST=1

run_probe() {
  local id="$1"
  local content="$2"
  local no_think="$3"  # "true" or "false"
  local prefix=""
  [[ "$no_think" == "true" ]] && prefix="/no_think\n"

  local prompt
  prompt=$(python3 -c "
import json
p = '''${prefix}Summarize this in one sentence (max 50 words). Output ONLY the summary, nothing else:\n\n${content//\'/\\\'}'''
print(json.dumps({
  'model': '$MODEL',
  'messages': [{'role':'user','content': p}],
  'max_tokens': 400,
  'temperature': 0.3,
}))
" 2>/dev/null)

  local t0=$(python3 -c "import time;print(time.time())")
  local resp
  resp=$(curl -s --max-time 60 -X POST http://127.0.0.1:3162/v1/chat/completions \
    -H 'Content-Type: application/json' -d "$prompt" 2>/dev/null)
  local t1=$(python3 -c "import time;print(time.time())")
  local latency_ms=$(python3 -c "print(int((${t1}-${t0})*1000))")

  local summary
  summary=$(echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['choices'][0]['message'].get('content','')[:300])" 2>/dev/null)
  local prompt_tok completion_tok
  prompt_tok=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('usage',{}).get('prompt_tokens',0))" 2>/dev/null)
  completion_tok=$(echo "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('usage',{}).get('completion_tokens',0))" 2>/dev/null)

  # Detect <think> block (anti-check: should NOT be present when no_think=true)
  local has_think
  has_think=$(echo "$summary" | grep -c '<think>' || echo 0)

  if [[ $FIRST -eq 0 ]]; then echo "," >> "$OUT"; fi
  FIRST=0
  python3 -c "
import json
print(json.dumps({
  'entry_id': $id,
  'no_think': $no_think == 'true' if False else ('$no_think' == 'true'),
  'latency_ms': $latency_ms,
  'prompt_tokens': $prompt_tok,
  'completion_tokens': $completion_tok,
  'has_think_block': $has_think > 0,
  'summary_preview': '''$summary'''[:200].replace(chr(10),' ').strip(),
}, ensure_ascii=False))
" 2>/dev/null >> "$OUT"
}

i=0
echo "$SAMPLES" | while IFS='|' read -r id content; do
  i=$((i+1))
  [[ -z "$id" ]] && continue
  echo "  [$i/$N] entry $id — thinking..."
  run_probe "$id" "$content" "false"
  sleep 1
  echo "  [$i/$N] entry $id — no_think..."
  run_probe "$id" "$content" "true"
  sleep 1
done

echo "]" >> "$OUT"

echo ""
echo "[experiment] done. Analyzing..."
python3 <<EOF
import json
with open("$OUT") as f:
    raw = f.read()
# Fix ", " at end then reparse
data = json.loads(raw)
think = [r for r in data if not r['no_think']]
noth  = [r for r in data if r['no_think']]
def stats(rows):
    if not rows: return {'n':0}
    lats = [r['latency_ms'] for r in rows]
    comps = [r['completion_tokens'] for r in rows]
    return {
      'n': len(rows),
      'latency_avg_ms': round(sum(lats)/len(lats)),
      'latency_p50_ms': sorted(lats)[len(lats)//2],
      'latency_max_ms': max(lats),
      'completion_tok_avg': round(sum(comps)/len(comps)),
      'completion_tok_max': max(comps),
    }
t = stats(think)
n = stats(noth)
print(f"\n=== RESULTS ({len(think)} thinking / {len(noth)} no_think) ===")
print(f"{'metric':<24} {'thinking':>12} {'no_think':>12} {'delta':>10}")
for k in ['latency_avg_ms','latency_p50_ms','latency_max_ms','completion_tok_avg','completion_tok_max']:
    tv, nv = t.get(k,0), n.get(k,0)
    delta = f"-{round((tv-nv)/max(tv,1)*100)}%" if tv > nv else f"+{round((nv-tv)/max(tv,1)*100)}%"
    print(f"{k:<24} {tv:>12} {nv:>12} {delta:>10}")
print(f"\n<think> blocks leaked: thinking={sum(1 for r in think if r['has_think_block'])}, no_think={sum(1 for r in noth if r['has_think_block'])}")
EOF
echo ""
echo "[experiment] raw data: $OUT"
