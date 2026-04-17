---
name: support-ticket-fsm
description: |
  カスタマーサポートチケットの有限状態機械（FSM）実装ワークフロー。
  未対応/返事待ち/確認待ち/対応完了/対応不要の5状態・二重対応防止ロック・
  承認ワークフロー（Wチェック）・担当者割り当てを標準化する。
  Use when implementing ticket status management, assignment logic,
  double-response prevention, or approval workflows for support tickets.
origin: unified
---

# Support Ticket FSM

## 状態遷移図

```
             新規メッセージ受信
                   ↓
              [OPEN 未対応]
             /      |      \
   担当者割当   手動   自動ルール
            ↓      ↓
    [WAITING_REPLY 返事待ち]  ← 返信送信後
            ↓      ↑
    [WAITING_CONFIRM 確認待ち] ← 上長承認フロー
            ↓
       [RESOLVED 対応完了] ← 解決マーク
       [NO_ACTION 対応不要] ← スパム等

    ※ 対応完了/対応不要 → 顧客返信受信 → OPEN に自動再オープン
```

## 状態定義

```typescript
export const TICKET_STATUSES = {
  OPEN: 'open',                   // 未対応 — 新規・担当待ち
  WAITING_REPLY: 'waiting_reply', // 返事待ち — 返信済み、顧客の返信待ち
  WAITING_CONFIRM: 'waiting_confirm', // 確認待ち — 上長承認待ち（Wチェック）
  RESOLVED: 'resolved',           // 対応完了
  NO_ACTION: 'no_action',         // 対応不要（スパム・迷子メール等）
} as const;

export type TicketStatus = typeof TICKET_STATUSES[keyof typeof TICKET_STATUSES];

// 有効な遷移マップ
const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open:             ['waiting_reply', 'waiting_confirm', 'resolved', 'no_action'],
  waiting_reply:    ['open', 'waiting_confirm', 'resolved', 'no_action'],
  waiting_confirm:  ['waiting_reply', 'resolved'],
  resolved:         ['open'],       // 顧客返信で再オープン
  no_action:        ['open'],
};
```

## TicketService — 状態遷移

```typescript
// ticket.service.ts
export class TicketService {

  async transition(ticketId: string, newStatus: TicketStatus, actorId: string) {
    const ticket = await this.db.tickets.findById(ticketId);
    
    // 有効な遷移か検証
    const allowed = VALID_TRANSITIONS[ticket.status] || [];
    if (!allowed.includes(newStatus)) {
      throw new InvalidTransitionError(
        `Cannot transition from ${ticket.status} to ${newStatus}`
      );
    }

    // ロック確認（二重対応防止）
    if (ticket.lockedBy && ticket.lockedBy !== actorId) {
      throw new TicketLockedError(`Ticket is locked by ${ticket.lockedByName}`);
    }

    const updated = await this.db.tickets.update(ticketId, {
      status: newStatus,
      updatedAt: new Date()
    });

    // 遷移イベントを記録（アクティビティタイムライン）
    await this.activityLog.record({
      ticketId,
      type: 'status_changed',
      actorId,
      payload: { from: ticket.status, to: newStatus }
    });

    // 自動ルールエンジンを発火
    await this.ruleEngine.evaluate('status_changed', { ticket: updated });

    return updated;
  }

  // 顧客返信で自動再オープン
  async reopenOnReply(ticketId: string) {
    const ticket = await this.db.tickets.findById(ticketId);
    if (['resolved', 'no_action'].includes(ticket.status)) {
      return this.transition(ticketId, 'open', 'system');
    }
  }
}
```

## 二重対応防止ロック

```typescript
// 返信入力中にロックを取得・解放
export class TicketLockService {
  private redis: Redis;
  private LOCK_TTL = 30; // 30秒（入力中タイムアウト）

  async acquire(ticketId: string, agentId: string): Promise<boolean> {
    const key = `ticket-lock:${ticketId}`;
    const existing = await this.redis.get(key);
    
    if (existing && existing !== agentId) {
      return false; // 他のエージェントがロック中
    }
    
    await this.redis.set(key, agentId, 'EX', this.LOCK_TTL);
    
    // WebSocketで他のエージェントに通知
    await this.realtime.broadcast(ticketId, 'ticket_locked', {
      ticketId, lockedBy: agentId
    });
    
    return true;
  }

  async release(ticketId: string, agentId: string) {
    const key = `ticket-lock:${ticketId}`;
    const current = await this.redis.get(key);
    if (current === agentId) {
      await this.redis.del(key);
      await this.realtime.broadcast(ticketId, 'ticket_unlocked', { ticketId });
    }
  }

  async extend(ticketId: string, agentId: string) {
    // ユーザーが入力中はTTLを延長
    const key = `ticket-lock:${ticketId}`;
    const current = await this.redis.get(key);
    if (current === agentId) {
      await this.redis.expire(key, this.LOCK_TTL);
    }
  }
}
```

## 担当者割り当て

```typescript
// ticket-assignment.service.ts
export class TicketAssignmentService {

  // 手動割り当て
  async assignTo(ticketId: string, assigneeId: string, actorId: string) {
    await this.db.tickets.update(ticketId, { assigneeId });
    await this.activityLog.record({ ticketId, type: 'assigned', actorId,
      payload: { assigneeId }
    });
    // 担当者に通知
    await this.notifications.send(assigneeId, 'ticket_assigned', { ticketId });
  }

  // ラウンドロビン自動割り当て
  async autoAssignRoundRobin(ticketId: string, teamId: string) {
    const agents = await this.db.agents.findOnlineByTeam(teamId);
    if (agents.length === 0) return;
    
    // 最も未対応チケットが少ないエージェント
    const workloads = await Promise.all(agents.map(async agent => ({
      agent,
      count: await this.db.tickets.countByAssignee(agent.id, { status: 'open' })
    })));
    
    const leastBusy = workloads.sort((a, b) => a.count - b.count)[0].agent;
    return this.assignTo(ticketId, leastBusy.id, 'system');
  }
}
```

## 承認ワークフロー（Wチェック）

```typescript
// 送信前に上長承認が必要なケース
export class ApprovalWorkflow {

  async requestApproval(ticketId: string, draftMessageId: string, requesterId: string) {
    // チケットを確認待ちに遷移
    await this.ticketService.transition(ticketId, 'waiting_confirm', requesterId);
    
    // 承認者に通知
    const approvers = await this.getApprovers(requesterId);
    for (const approver of approvers) {
      await this.notifications.send(approver.id, 'approval_requested', {
        ticketId, draftMessageId, requesterId
      });
    }
  }

  async approve(ticketId: string, draftMessageId: string, approverId: string) {
    // 承認 → 自動送信
    const draft = await this.db.draftMessages.findById(draftMessageId);
    await this.messageSendService.send(ticketId, draft.content, { agentId: approverId });
    await this.ticketService.transition(ticketId, 'waiting_reply', approverId);
  }

  async reject(ticketId: string, approverId: string, reason: string) {
    // 却下 → 担当者に差し戻し
    await this.ticketService.transition(ticketId, 'open', approverId);
    await this.activityLog.record({ ticketId, type: 'approval_rejected',
      actorId: approverId, payload: { reason }
    });
  }
}
```

## API エンドポイント

```typescript
// POST /api/tickets/:id/transition
// POST /api/tickets/:id/assign
// POST /api/tickets/:id/lock
// DELETE /api/tickets/:id/lock
// POST /api/tickets/:id/approvals (承認リクエスト)
// PUT /api/tickets/:id/approvals/:approvalId (承認/却下)
```

## Workflow

1. `channels`テーブルからチケット作成（`support-ticket-fsm`はFSMのみ管理）
2. Redisでロックサービスを起動
3. 遷移はすべて `TicketService.transition()` を経由
4. ロックは返信フォームのfocusで取得、blurで解放
5. 自動ルールエンジン（`auto-rule-engine`）と連携してステータス変化を処理

## Gotchas

- ロックのTTLは短め（30秒）— ブラウザクラッシュで永久ロックを防ぐ
- 状態遷移のバリデーションはDB保存前に必ず実行
- `resolved → open` の再オープンは顧客返信時のみ — エージェントは手動でopen
- 複数タブを開いているエージェントへのロック通知はWebSocket必須
- ページネーションはチケット一覧が大量になるためcursor-based推奨
