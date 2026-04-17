---
name: aios-llm-router
description: |
  タスク種別・複雑度・コストに応じてMLX(ローカル)とAPI LLMを動的に
  ルーティングするワークフロー。モデル選択ヒューリスティック・フォールバック・
  コスト最適化を標準化する。
  Use when selecting which LLM to use for a task or adding new model backends.
origin: unified
---

# AIOS LLM Router

## モデルティア定義

```
Tier 1 (ローカル高速)  : MLX Qwen3-0.6B   — 要約・分類・キーワード抽出
Tier 2 (ローカル中速)  : MLX Qwen3-8B     — スキル生成・コード・推論
Tier 3 (API高品質)    : claude-opus-4.x  — 複雑な設計・判断・マルチステップ
Tier 4 (API高速)      : claude-haiku-4.x — 高頻度・低コスト・単純タスク
```

## ルーティングロジック

```javascript
// scripts/llm-router.js
const ROUTING_RULES = [
  // [条件関数, モデル, エンドポイント]
  [t => t.tokens < 500 && t.task === 'summarize',   'qwen3-0.6b', 'mlx-draft'],
  [t => t.tokens < 4000 && t.task === 'generate',   'qwen3-8b',   'mlx-main'],
  [t => t.task === 'skill-create',                  'qwen3-8b',   'mlx-main'],
  [t => t.complexity === 'high' || t.multi_step,     'claude-opus', 'api'],
  [t => t.task === 'embed',                          'qwen3-embed', 'mlx-embed'],
  [() => true,                                       'qwen3-8b',   'mlx-main'], // default
];

function routeLLM(taskSpec) {
  const rule = ROUTING_RULES.find(([cond]) => cond(taskSpec));
  const [, model, endpoint] = rule;
  console.log(`[llm-router] ${taskSpec.task} → ${model} (${endpoint})`);
  return { model, endpoint };
}

// タスク仕様の作り方
const taskSpec = {
  task: 'summarize',          // summarize | generate | embed | skill-create | reason
  tokens: estimateTokens(input),
  complexity: 'low',          // low | medium | high
  multi_step: false,
  budget_usd: 0.001,          // コスト上限（API使用時）
};
```

## MLXバックエンド設定

```yaml
# aios/config/config.yaml 相当
llms:
  # Tier 1: ドラフトモデル（投機的デコード用）
  - name: "Qwen/Qwen3-0.6B-MLX-4bit"
    backend: "mlx-draft"
    hostname: "http://127.0.0.1:3162"
    max_tokens: 2048
    temperature: 0.3

  # Tier 2: メインローカルモデル
  - name: "mlx-community/Qwen3-8B-4bit"
    backend: "mlx-main"
    hostname: "http://127.0.0.1:3162"
    max_tokens: 32768
    temperature: 0.7

  # Tier 3: 埋め込み専用
  - name: "mlx-community/Qwen3-Embedding-8B-4bit-DWQ"
    backend: "mlx-embed"
    hostname: "http://127.0.0.1:3161"
    dim: 4096
```

## フォールバックチェーン

```javascript
async function callWithFallback(taskSpec, prompt) {
  const endpoints = [
    { model: 'qwen3-8b',   url: 'http://127.0.0.1:3162/v1/chat/completions' },
    { model: 'claude-haiku', url: null },  // API fallback
  ];

  for (const ep of endpoints) {
    try {
      const result = await callLLM(ep, prompt, taskSpec);
      // 成功 → ルーティング実績をvcontextに記録
      await recordRouting(taskSpec.task, ep.model, 'success');
      return result;
    } catch (err) {
      console.warn(`[llm-router] ${ep.model} failed: ${err.message}, trying next`);
      await recordRouting(taskSpec.task, ep.model, 'fallback');
    }
  }
  throw new Error('[llm-router] All backends failed');
}
```

## ルーティング実績の監視

```bash
# どのモデルが何回使われたか
curl -s 'http://127.0.0.1:3150/recall?q=llm-routing&limit=100' | \
  python3 -c "
import sys, json
from collections import Counter
d = json.load(sys.stdin)
models = []
for r in d['results']:
  if r.get('type') == 'llm-routing':
    try: models.append(json.loads(r['content']).get('model','?'))
    except: pass
c = Counter(models)
print('LLMルーティング実績:')
for model, count in c.most_common():
  print(f'  {model}: {count}回')
"

# MLX生成サーバー稼働確認
curl -s http://127.0.0.1:3162/health | python3 -c "import sys,json; print('MLX:', json.load(sys.stdin))"
curl -s http://127.0.0.1:3150/ai/status | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('generate:', d.get('mlx_generate_available'))
print('embed:', d.get('mlx_available'))
print('model:', d.get('mlx_generate_model'))
"
```

## no_think最適化（Qwen3専用）

```javascript
// 抽出系タスクはthinkingをスキップして高速化
function buildPrompt(task, content, noThink = false) {
  const prefix = noThink ? '/no_think\n\n' : '';
  return prefix + content;
}

// no_think適用タスク: summarize, keyword-extract, classify
// thinking維持タスク: skill-create, reason, architecture, conflict-resolve
const NO_THINK_TASKS = ['summarize', 'keyword-extract', 'classify', 'translate'];
```

## Workflow

1. タスク仕様 (`task`, `tokens`, `complexity`) を組み立てる
2. `routeLLM(taskSpec)` でモデル・エンドポイントを決定
3. MLXが稼働中なら優先使用、ダウン時はAPIにフォールバック
4. no_think適用可否を判断してプロンプトを構築
5. 実行結果とルーティング選択をvcontextに記録（コスト最適化の学習データ）

## Gotchas

- MLXはmacOS専用 — CI/CD環境ではAPIフォールバック必須
- Tier 2(8B)のウォームアップに30秒かかる — 初回は遅い
- embedding と generation は別ポート (3161 vs 3162) — 混在注意
- `no_think`はQwen3のみ有効 — 他モデルに渡すと `/no_think` がそのまま出力される
