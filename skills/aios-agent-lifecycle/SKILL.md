---
name: aios-agent-lifecycle
description: |
  エージェントの作成→登録→起動→監視→停止→アーカイブの完全ライフサイクル管理。
  vcontextをエージェントレジストリとして使い、状態遷移・ヘルスチェック・
  異常終了の検出と再起動を標準化する。
  Use when creating new agents, monitoring running agents, or handling agent failures.
origin: unified
---

# AIOS Agent Lifecycle

## 状態遷移図

```
DEFINED → REGISTERED → RUNNING → COMPLETED
                ↓           ↓
            FAILED      SUSPENDED
                ↓           ↓
            RETRYING ← ────┘
                ↓
            ARCHIVED
```

## エージェント定義（agent-registry登録）

```bash
# エージェントをvcontextに登録
node -e "
const http = require('http');
const agent = {
  name: 'my-agent',
  version: '1.0.0',
  description: 'エージェントの役割',
  entry: 'skills/my-agent/agent.js',
  tools: ['author/tool1', 'author/tool2'],
  memory_type: 'agent-episodic',
  max_retries: 3,
  timeout_ms: 30000,
  status: 'REGISTERED',
  created_at: new Date().toISOString()
};
const payload = JSON.stringify({
  type: 'agent-registry',
  content: JSON.stringify(agent),
  tags: ['agent-registry', 'agent:' + agent.name, 'status:REGISTERED'],
  session: 'system'
});
const opts = { host:'127.0.0.1', port:3150, path:'/store', method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}};
http.request(opts, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('registered:',JSON.parse(d).stored?.id))}).end(payload);
"
```

## エージェント起動・状態更新

```javascript
// agent-runtime.js — エージェントの起動と状態管理
async function startAgent(agentName, taskInput, sessionId) {
  const runId = `${agentName}-${Date.now()}`;
  
  // 起動記録
  await storeEntry({
    type: 'agent-run',
    content: JSON.stringify({
      run_id: runId,
      agent: agentName,
      task: taskInput,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      pid: process.pid
    }),
    tags: ['agent-run', `agent:${agentName}`, 'status:RUNNING', `run:${runId}`],
    session: sessionId
  });

  try {
    const result = await executeAgent(agentName, taskInput);
    
    // 正常完了
    await storeEntry({
      type: 'agent-run',
      content: JSON.stringify({ run_id: runId, status: 'COMPLETED', result, completed_at: new Date().toISOString() }),
      tags: ['agent-run', `agent:${agentName}`, 'status:COMPLETED', `run:${runId}`],
      session: sessionId
    });
    return result;
    
  } catch (err) {
    // 異常終了
    await storeEntry({
      type: 'agent-run',
      content: JSON.stringify({ run_id: runId, status: 'FAILED', error: err.message, failed_at: new Date().toISOString() }),
      tags: ['agent-run', `agent:${agentName}`, 'status:FAILED', `run:${runId}`],
      session: sessionId
    });
    throw err;
  }
}
```

## ヘルスチェック・監視

```bash
# 実行中エージェントの一覧
curl -s 'http://127.0.0.1:3150/recall?q=agent-run+status:RUNNING&limit=20' | \
  python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
running = [r for r in d['results'] if r.get('type') == 'agent-run']
print(f'実行中: {len(running)}件')
for r in running:
  try:
    c = json.loads(r['content'])
    if c.get('status') == 'RUNNING':
      started = c.get('started_at', '')
      print(f'  {c[\"agent\"]} run_id={c[\"run_id\"]} 開始={started[:19]}')
  except: pass
"

# 直近の失敗
curl -s 'http://127.0.0.1:3150/recall?q=agent-run+FAILED&limit=10' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d['results']:
  try:
    c = json.loads(r['content'])
    if c.get('status') == 'FAILED':
      print(f'FAILED: {c[\"agent\"]} — {c.get(\"error\",\"\")[:80]}')
  except: pass
"
```

## 再試行ポリシー

```javascript
async function runWithRetry(agentName, taskInput, sessionId, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[lifecycle] ${agentName} attempt ${attempt}/${maxRetries}`);
      return await startAgent(agentName, taskInput, sessionId);
    } catch (err) {
      lastError = err;
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      console.warn(`[lifecycle] ${agentName} failed (attempt ${attempt}): ${err.message}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, backoff));
    }
  }
  // 全リトライ失敗 → アーカイブ
  await archiveAgent(agentName, lastError);
  throw lastError;
}
```

## アーカイブ・クリーンアップ

```bash
# 完了済みエージェントラン（24時間以上前）をSSDに移行
curl -s -X POST http://127.0.0.1:3150/tier/migrate \
  -H 'Content-Type: application/json' \
  -d '{"type": "agent-run", "older_than_hours": 24}'

# 古いエントリをprune
curl -s -X DELETE 'http://127.0.0.1:3150/prune?type=agent-run&older_than_days=30'
```

## Workflow

1. エージェントを設計しvcontextのagent-registryに登録
2. タスク受信時に `startAgent()` でRUNNING状態を記録
3. 実行中は進捗をagent-working-memoryに保存（aios-memory-providerと連携）
4. 完了/失敗でステータスを更新
5. 失敗時は `runWithRetry()` で自動再試行
6. 24時間後に古いrunをSSDへアーカイブ

## Gotchas

- run_idはユニーク必須 — `agentName + timestamp` で十分
- タイムアウトはPromise.race()でDEADLINE_EXCEEDEDを実装する
- 並列実行数の上限はaios-schedulerで管理する（このスキルは単一エージェント担当）
- RUNNING状態が長時間続くものはwatchdog(vcontext-watchdog.sh相当)で検出
