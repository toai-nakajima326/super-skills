---
name: aios-agent-comms
description: |
  エージェント間のメッセージパッシング・イベント通知・共有状態管理の
  設計と実装ワークフロー。vcontextをメッセージバスとして使い、
  非同期・ファイア&フォーゲット・リクエスト/レスポンスパターンを標準化する。
  Use when designing multi-agent communication or implementing agent coordination.
origin: unified
---

# AIOS Agent Communications

## 通信パターン一覧

```
1. Fire & Forget   — 送信のみ、確認なし  (イベント通知)
2. Request/Reply   — 送信 → 待機 → 受信  (タスク委譲)
3. Broadcast       — 全エージェントに送信  (システム通知)
4. Subscribe       — 型フィルタで受信待機  (イベント駆動)
```

## vcontextをメッセージバスとして使う

```javascript
// scripts/aios-message-bus.js
const MESSAGE_TYPE = 'inter-agent-message';
const BASE_URL = 'http://127.0.0.1:3150';

// メッセージ送信（Fire & Forget）
async function sendMessage(from, to, payload, messageType = 'notification') {
  const msg = {
    from,
    to,             // エージェント名 or 'broadcast'
    type: messageType,
    payload,
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    sent_at: new Date().toISOString(),
    read: false
  };

  const body = JSON.stringify({
    type: MESSAGE_TYPE,
    content: JSON.stringify(msg),
    tags: [MESSAGE_TYPE, `to:${to}`, `from:${from}`, `msg-type:${messageType}`],
    session: from
  });

  await fetch(`${BASE_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  return msg.message_id;
}

// メッセージ受信（ポーリング）
async function receiveMessages(agentName, limit = 10) {
  const r = await fetch(`${BASE_URL}/recall?q=to:${agentName}&limit=${limit}`);
  const d = await r.json();
  return d.results
    .filter(e => e.type === MESSAGE_TYPE)
    .map(e => {
      try { return JSON.parse(e.content); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter(m => !m.read && (m.to === agentName || m.to === 'broadcast'));
}

// Request/Reply パターン
async function request(from, to, payload, timeoutMs = 10000) {
  const replyChannel = `reply-${Date.now()}`;
  
  // リクエスト送信
  await sendMessage(from, to, { ...payload, reply_to: replyChannel }, 'request');

  // レスポンス待機（ポーリング）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await receiveMessages(replyChannel, 1);
    if (msgs.length > 0) return msgs[0].payload;
    await new Promise(r => setTimeout(r, 200)); // 200ms polling
  }
  throw new Error(`[agent-comms] Request to ${to} timed out after ${timeoutMs}ms`);
}
```

## 使用パターン集

```javascript
// パターン1: タスク委譲（Request/Reply）
const result = await request('orchestrator', 'code-agent', {
  task: 'implement feature X',
  spec: specText,
  files: ['src/feature.js']
});
console.log('code-agent result:', result);

// パターン2: 完了通知（Fire & Forget）
await sendMessage('code-agent', 'review-agent', {
  task_id: 'task-001',
  files_changed: ['src/feature.js'],
  diff_summary: '...'
}, 'task-completed');

// パターン3: 全エージェントにシステム通知
await sendMessage('system', 'broadcast', {
  event: 'deploy-started',
  env: 'production',
  triggered_by: 'ship-release'
}, 'system-event');

// パターン4: エージェントがメッセージを受信して処理
async function agentLoop(agentName) {
  while (true) {
    const messages = await receiveMessages(agentName);
    for (const msg of messages) {
      console.log(`[${agentName}] received ${msg.type} from ${msg.from}`);
      await processMessage(agentName, msg);
      await markRead(msg.message_id);
    }
    await new Promise(r => setTimeout(r, 500)); // 500ms間隔でポーリング
  }
}
```

## WebSocket経由のリアルタイム受信

```javascript
// vcontextのWebSocketでリアルタイム受信（ポーリング不要）
const WebSocket = require('ws');

function subscribeToMessages(agentName, onMessage) {
  const ws = new WebSocket('ws://127.0.0.1:3150/ws');
  
  ws.on('open', () => console.log(`[agent-comms] ${agentName} subscribed`));
  
  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data);
      if (event.type === MESSAGE_TYPE) {
        const msg = JSON.parse(event.content);
        if (msg.to === agentName || msg.to === 'broadcast') {
          onMessage(msg);
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    // 自動再接続
    setTimeout(() => subscribeToMessages(agentName, onMessage), 1000);
  });

  return ws;
}
```

## メッセージの監視・デバッグ

```bash
# 直近のエージェント間メッセージ
curl -s 'http://127.0.0.1:3150/recall?q=inter-agent-message&limit=20' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = [r for r in d['results'] if r.get('type') == 'inter-agent-message']
print(f'メッセージ数: {len(msgs)}件')
for r in msgs:
  try:
    m = json.loads(r['content'])
    print(f'  {m[\"from\"]} → {m[\"to\"]} [{m[\"type\"]}] {str(m[\"payload\"])[:60]}')
  except: pass
"

# 特定エージェント宛のメッセージ
curl -s 'http://127.0.0.1:3150/recall?q=to:code-agent&limit=10'
```

## 既読管理

```javascript
async function markRead(messageId) {
  // メッセージを既読タグで更新（vcontextのsupersedes機能を使う）
  await fetch(`${BASE_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'message-read-receipt',
      content: JSON.stringify({ message_id: messageId, read_at: new Date().toISOString() }),
      tags: ['message-read', `msg:${messageId}`],
      session: 'system'
    })
  });
}
```

## Workflow

1. 通信パターンを選択（Fire&Forget / Request/Reply / Broadcast）
2. 送信エージェントが `sendMessage()` でvcontextにメッセージを保存
3. 受信エージェントがポーリングまたはWebSocketで受信
4. Request/Replyの場合、reply_to チャンネルに返信
5. 処理完了後に既読マーク（メッセージ蓄積防止）

## Gotchas

- ポーリング間隔は500ms推奨 — 短すぎるとvcontextに負荷がかかる
- WebSocketはvcontextサーバー再起動で切断される — 自動再接続必須
- メッセージは既読にしないと毎回受信し続ける — markRead()の呼び出しを忘れない
- Request/Replyのreply_toチャンネルはユニーク必須 — タイムスタンプを使う
- broadcastは全エージェントが処理する — 処理量に注意
