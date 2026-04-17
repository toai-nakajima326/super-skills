---
name: aios-memory-provider
description: |
  vcontextをAIOS MemoryProvider抽象として扱うワークフロー。
  短期(context内)・長期(vcontext RAM/SSD)・センサリ(ストリーミング)の
  3層メモリ設計と、外部プロバイダ(Pinecone/Qdrant/Mem0)への拡張パターン。
  Use when designing memory architecture or integrating external vector DBs.
origin: unified
---

# AIOS Memory Provider

## 3層メモリアーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Sensory Memory   ストリーミング入力・即時処理    │ TTL: ~数秒
├─────────────────────────────────────────────┤
│  Short-term (STM) コンテキストウィンドウ内       │ TTL: セッション中
├─────────────────────────────────────────────┤
│  Long-term (LTM)  vcontext RAM → SSD → Cloud │ TTL: 永続
└─────────────────────────────────────────────┘
```

## vcontext MemoryProvider API

```javascript
// vcontextをMemoryProviderとして使う標準パターン
const MemoryProvider = {
  
  // 記憶を追加
  async add(content, type, tags = [], session = 'default') {
    const payload = JSON.stringify({ type, content: JSON.stringify(content), tags, session });
    return fetch('http://127.0.0.1:3150/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).then(r => r.json());
  },

  // 意味検索で想起
  async retrieve(query, limit = 10, type = null) {
    const params = new URLSearchParams({ q: query, limit });
    if (type) params.set('type', type);
    return fetch(`http://127.0.0.1:3150/recall?${params}`)
      .then(r => r.json())
      .then(d => d.results);
  },

  // セッション単位で取得
  async getSession(sessionId, limit = 50) {
    return fetch(`http://127.0.0.1:3150/session/${sessionId}`)
      .then(r => r.json());
  },

  // 記憶を要約・圧縮
  async summarize(entryIds) {
    return fetch('http://127.0.0.1:3150/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: entryIds })
    }).then(r => r.json());
  }
};
```

## 記憶タイプ設計

| type文字列 | 用途 | TTL目安 |
|-----------|------|---------|
| `agent-working-memory` | エージェントの作業中間状態 | タスク完了まで |
| `agent-episodic` | エージェントの過去経験 | 永続 |
| `agent-semantic` | 抽出された知識・ルール | 永続 |
| `task-context` | 実行中タスクのコンテキスト | タスク中 |
| `tool-result` | ツール実行結果キャッシュ | TTL付き |
| `inter-agent-message` | エージェント間メッセージ | 受信後削除 |

## 記憶の読み書きワークフロー

```bash
# 1. エージェント作業中間状態を保存
curl -s -X POST http://127.0.0.1:3150/store \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "agent-working-memory",
    "content": "{\"agent\": \"my-agent\", \"step\": 3, \"state\": \"analyzing\"}",
    "tags": ["agent:my-agent", "task:task-001"],
    "session": "task-001"
  }'

# 2. エージェントの過去経験を想起
curl -s 'http://127.0.0.1:3150/recall?q=previous+similar+task&limit=5' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d['results']:
  print(f'  [{r[\"type\"]}] {str(r[\"content\"])[:80]}')
"

# 3. 古い作業記憶を圧縮
curl -s 'http://127.0.0.1:3150/recall?q=agent-working-memory&limit=100' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [r['id'] for r in d['results'] if r.get('type') == 'agent-working-memory']
print('compress targets:', ids[:10])
" 
```

## 外部MemoryProviderの追加（Qdrant例）

```python
# aios/memory/providers/vcontext_provider.py
import requests

class VContextProvider:
    """既存vcontextサーバーをAIOS MemoryProviderとして公開"""
    
    BASE_URL = "http://127.0.0.1:3150"
    
    def initialize(self, config: dict):
        self.base_url = config.get("url", self.BASE_URL)
    
    def add_memory(self, memory_note) -> dict:
        return requests.post(f"{self.base_url}/store", json={
            "type": memory_note.type,
            "content": memory_note.content,
            "tags": memory_note.tags or [],
            "session": memory_note.agent_id
        }).json()
    
    def retrieve_memory(self, query) -> list:
        r = requests.get(f"{self.base_url}/recall", params={
            "q": query.query, "limit": query.top_k
        })
        return r.json().get("results", [])
    
    def close(self): pass  # HTTPサーバーは常時稼働
```

## 記憶層の監視

```bash
# 各層のエントリ数確認
curl -s http://127.0.0.1:3150/tier/stats | python3 -c "
import sys, json; d=json.load(sys.stdin)
print(json.dumps(d, indent=2, ensure_ascii=False))
"

# セマンティック検索の動作確認
curl -s 'http://127.0.0.1:3150/search/semantic?q=agent+memory+state&limit=5' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('results',[])), 'semantic hits')"
```

## Gotchas

- STM(短期記憶)はセッションIDで分離する — 別エージェントの記憶が混入しないように
- 圧縮(summarize)は定期実行しないとRAMディスクが圧迫される
- センサリメモリ(ストリーム)はvcontextではなくNode.jsのEventEmitterで実装
- セマンティック検索はMLX embedが稼働中のときのみ有効 — フォールバックはFTS
