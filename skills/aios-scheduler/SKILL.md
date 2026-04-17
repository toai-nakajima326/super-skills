---
name: aios-scheduler
description: |
  複数エージェント・タスクの優先度キュー管理・並列実行制御・
  デッドライン管理を行うスケジューラ設計ワークフロー。
  infinite-skillsのP0-P7をキューイングシステムに昇格させる。
  Use when managing concurrent agents, setting task priorities, or preventing resource contention.
origin: unified
---

# AIOS Scheduler

## スケジューリング戦略

```
Priority Queue (P0最優先) → Round-Robin (同優先度内) → Deadline-aware
```

infinite-skillsのP0-P7をそのままキュー優先度として使用:

| 優先度 | スキル群 | 最大並列数 | タイムアウト |
|--------|---------|-----------|------------|
| P0 | virtual-context, supervisor-worker | 無制限 | なし |
| P1 | guard, careful, checkpoint | 1 (安全のため直列) | 30s |
| P2 | investigate, health-check, comprehensive-qa | 3 | 120s |
| P3 | plan-*, spec-driven-dev | 2 | 300s |
| P4 | review, security-review, adversarial-review | 4 | 180s |
| P5 | tdd-workflow, ship-release, e2e-testing | 3 | 600s |
| P6 | backend-patterns, frontend-patterns | 4 | 120s |
| P7 | deep-research, exa-search | 2 | 60s |

## タスクキューの実装

```javascript
// scripts/aios-scheduler.js
class AIOSScheduler {
  constructor() {
    this.queues = new Map(); // priority → [{task, deadline, enqueued_at}]
    this.running = new Map(); // runId → {task, started_at, worker}
    this.maxWorkers = { P0:99, P1:1, P2:3, P3:2, P4:4, P5:3, P6:4, P7:2 };
  }

  // タスクをエンキュー
  async enqueue(task, priority = 'P7', deadlineMs = null) {
    const runId = `${task.name}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const entry = {
      run_id: runId,
      task,
      priority,
      deadline: deadlineMs ? Date.now() + deadlineMs : null,
      enqueued_at: Date.now()
    };

    if (!this.queues.has(priority)) this.queues.set(priority, []);
    this.queues.get(priority).push(entry);

    // vcontextに記録
    await this._recordSchedule(entry, 'QUEUED');
    this._tryDispatch();
    return runId;
  }

  // キューから取り出して実行
  _tryDispatch() {
    for (const priority of ['P0','P1','P2','P3','P4','P5','P6','P7']) {
      const queue = this.queues.get(priority) || [];
      const maxW = this.maxWorkers[priority] || 2;
      const currentRunning = [...this.running.values()].filter(r => r.priority === priority).length;

      while (queue.length > 0 && currentRunning < maxW) {
        const entry = queue.shift();

        // デッドライン超過チェック
        if (entry.deadline && Date.now() > entry.deadline) {
          this._recordSchedule(entry, 'DEADLINE_EXCEEDED');
          continue;
        }

        this._execute(entry);
      }
    }
  }

  async _execute(entry) {
    this.running.set(entry.run_id, { ...entry, started_at: Date.now() });
    await this._recordSchedule(entry, 'RUNNING');

    try {
      const result = await Promise.race([
        entry.task.run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), entry.task.timeout || 60000))
      ]);
      this.running.delete(entry.run_id);
      await this._recordSchedule(entry, 'COMPLETED', result);
    } catch (err) {
      this.running.delete(entry.run_id);
      await this._recordSchedule(entry, 'FAILED', null, err.message);
    } finally {
      this._tryDispatch(); // 完了後に次のタスクを投入
    }
  }

  async _recordSchedule(entry, status, result = null, error = null) {
    const payload = JSON.stringify({
      type: 'scheduler-run',
      content: JSON.stringify({
        run_id: entry.run_id,
        task_name: entry.task.name,
        priority: entry.priority,
        status,
        result: result ? JSON.stringify(result).slice(0,200) : null,
        error,
        timestamp: new Date().toISOString(),
        wait_ms: entry.started_at ? entry.started_at - entry.enqueued_at : null,
        run_ms: status === 'COMPLETED' || status === 'FAILED' ? Date.now() - entry.started_at : null
      }),
      tags: ['scheduler-run', `priority:${entry.priority}`, `status:${status}`],
      session: 'scheduler'
    });
    // vcontextに非同期で記録（スケジューラをブロックしない）
    return fetch('http://127.0.0.1:3150/store', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: payload
    }).catch(() => {}); // 記録失敗はサイレントに無視
  }
}

module.exports = new AIOSScheduler(); // シングルトン
```

## スケジューラ状態の監視

```bash
# 現在の実行キュー状態
curl -s 'http://127.0.0.1:3150/recall?q=scheduler-run+RUNNING&limit=20' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
running = [r for r in d['results'] if r.get('type') == 'scheduler-run']
print(f'実行中: {len(running)}件')
for r in running:
  try:
    c = json.loads(r['content'])
    if c.get('status') == 'RUNNING':
      print(f'  [{c[\"priority\"]}] {c[\"task_name\"]} run_id={c[\"run_id\"][:12]}')
  except: pass
"

# スループット確認（直近1時間）
curl -s 'http://127.0.0.1:3150/recall?q=scheduler-run+COMPLETED&limit=100' | \
  python3 -c "
import sys, json, statistics
d = json.load(sys.stdin)
completed = []
for r in d['results']:
  try:
    c = json.loads(r['content'])
    if c.get('status') == 'COMPLETED' and c.get('run_ms'):
      completed.append(c)
  except: pass
if completed:
  times = [c['run_ms'] for c in completed]
  print(f'完了: {len(completed)}件')
  print(f'  avg={statistics.mean(times):.0f}ms p95={sorted(times)[int(len(times)*0.95)]:.0f}ms')
"
```

## デッドライン管理

```javascript
// タスクにデッドラインを設定してエンキュー
scheduler.enqueue(
  { name: 'security-scan', run: () => runSecurityScan(), timeout: 180000 },
  'P4',
  300000  // 5分以内に完了しなければ破棄
);

// SLAが必要なタスクはP1で直列実行
scheduler.enqueue(
  { name: 'production-rollback', run: () => rollback(), timeout: 30000 },
  'P1',
  60000  // 1分デッドライン
);
```

## Workflow

1. タスクを `{ name, run(), timeout }` 形式で定義
2. `scheduler.enqueue(task, priority, deadlineMs)` でキューに投入
3. スケジューラが優先度に従い自動で実行
4. 各ステータス変化をvcontextに記録（モニタリング）
5. FAILED/DEADLINE_EXCEEDEDはaios-agent-lifecycleの再試行ポリシーに連携

## Gotchas

- P1は並列1固定 — safety skillsが並列実行されてconflictしないように
- タイムアウトはタスクのtimeoutで個別設定 — スケジューラ全体のタイムアウトは別
- vcontext記録の失敗はサイレント無視 — 記録のためにタスクをブロックしない
- シングルトンのschedulerをプロセス間で共有しない — プロセス内で完結させる
