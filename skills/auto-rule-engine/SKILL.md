---
name: auto-rule-engine
description: |
  カスタマーサポートの自動化ルールエンジン実装ワークフロー。
  イベント→条件→アクション（ECA）パターンで、自動割り当て・自動返信・
  ラベル付け・SLA管理・エスカレーションを設定駆動で実装する。
  Use when implementing automation rules, SLA management, auto-assignment,
  auto-reply, or any condition-based workflow automation in a support system.
origin: unified
---

# Auto Rule Engine (ECA Pattern)

## ECA アーキテクチャ

```
Event (イベント)
  ticket_created | message_received | status_changed |
  time_elapsed | ticket_assigned | tag_added

  ↓

Condition (条件) — AND/OR 組み合わせ
  channel = 'email' AND subject CONTAINS '注文'
  contact.email ENDS_WITH '@priority.com'
  ticket.created_at > 1h AND status = 'open'

  ↓

Action (アクション)
  assign_to_team | assign_to_agent | add_label |
  change_status | send_reply | send_notification |
  add_note | set_priority | escalate
```

## ルール定義スキーマ（DB JSONB）

```typescript
// automation_rules テーブルの conditions/actions カラム

interface AutomationRule {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  triggerEvent: TriggerEvent;
  conditions: Condition[];
  conditionLogic: 'AND' | 'OR';  // 条件の結合方法
  actions: Action[];
  priority: number;  // 低い数値が先に評価
  runOnce: boolean;  // チケット1件につき1回のみ
}

type TriggerEvent =
  | 'ticket_created'
  | 'message_received'
  | 'status_changed'
  | 'ticket_assigned'
  | 'time_elapsed'   // SLA用
  | 'tag_added';

interface Condition {
  field: string;     // 'ticket.channel' | 'contact.email' | 'message.content' ...
  operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'regex' | 'greater_than' | 'less_than';
  value: string | number | boolean;
}

type Action =
  | { type: 'assign_team';      teamId: string }
  | { type: 'assign_agent';     agentId: string }
  | { type: 'add_label';        label: string }
  | { type: 'change_status';    status: TicketStatus }
  | { type: 'send_reply';       templateId: string }
  | { type: 'send_notification'; agentId: string; message: string }
  | { type: 'escalate';         toTeamId: string; reason: string }
  | { type: 'add_note';         content: string }
  | { type: 'set_priority';     priority: 'high' | 'medium' | 'low' };
```

## ルールエンジン実装

```typescript
// auto-rule-engine/engine.ts
export class AutoRuleEngine {

  async evaluate(event: TriggerEvent, context: RuleContext): Promise<void> {
    // このイベントに対応するルールをworkspaceから取得（優先度順）
    const rules = await this.db.automationRules.findByEvent(
      context.workspaceId, event, { enabled: true, orderBy: 'priority' }
    );

    for (const rule of rules) {
      // 1. 条件評価
      const matched = this.evaluateConditions(rule.conditions, rule.conditionLogic, context);
      if (!matched) continue;

      // 2. runOnce チェック（既に実行済みか）
      if (rule.runOnce) {
        const alreadyRan = await this.db.ruleExecutions.exists(rule.id, context.ticket.id);
        if (alreadyRan) continue;
      }

      // 3. アクション実行
      await this.executeActions(rule.actions, context);

      // 4. 実行ログ記録
      await this.db.ruleExecutions.create({ ruleId: rule.id, ticketId: context.ticket.id });

      // ログ（デバッグ用）
      console.log(`[rule-engine] "${rule.name}" matched for ticket ${context.ticket.id}`);
    }
  }

  private evaluateConditions(conditions: Condition[], logic: 'AND' | 'OR', ctx: RuleContext): boolean {
    const results = conditions.map(c => this.evaluateCondition(c, ctx));
    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private evaluateCondition(cond: Condition, ctx: RuleContext): boolean {
    const value = this.resolveField(cond.field, ctx);
    const target = cond.value;

    switch (cond.operator) {
      case 'equals':      return String(value) === String(target);
      case 'contains':    return String(value).toLowerCase().includes(String(target).toLowerCase());
      case 'starts_with': return String(value).startsWith(String(target));
      case 'ends_with':   return String(value).endsWith(String(target));
      case 'regex':       return new RegExp(String(target), 'i').test(String(value));
      case 'greater_than': return Number(value) > Number(target);
      case 'less_than':    return Number(value) < Number(target);
      default: return false;
    }
  }

  private resolveField(field: string, ctx: RuleContext): unknown {
    // 'ticket.channel' → ctx.ticket.channel
    // 'contact.email' → ctx.contact?.email
    // 'message.content' → ctx.message?.content
    const parts = field.split('.');
    let obj: unknown = ctx;
    for (const part of parts) {
      obj = (obj as Record<string, unknown>)?.[part];
    }
    return obj;
  }

  private async executeActions(actions: Action[], ctx: RuleContext): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case 'assign_team':
          await this.assignmentService.assignToTeam(ctx.ticket.id, action.teamId, 'system');
          break;
        case 'add_label':
          await this.ticketService.addLabel(ctx.ticket.id, action.label);
          break;
        case 'change_status':
          await this.ticketService.transition(ctx.ticket.id, action.status, 'system');
          break;
        case 'send_reply':
          const template = await this.templateService.render(action.templateId, ctx);
          await this.messageSendService.send(ctx.ticket.id, template.content);
          break;
        case 'escalate':
          await this.assignmentService.assignToTeam(ctx.ticket.id, action.toTeamId, 'system');
          await this.ticketService.addLabel(ctx.ticket.id, 'escalated');
          break;
      }
    }
  }
}
```

## SLA管理（時間経過イベント）

```typescript
// SLAチェッカー — Cronで定期実行
export class SLAChecker {
  
  // 5分ごとに実行
  async check() {
    const now = new Date();

    // 未対応1時間以上のチケット → エスカレーション
    const overdue = await this.db.tickets.findWhere({
      status: 'open',
      createdAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) }
    });

    for (const ticket of overdue) {
      await this.ruleEngine.evaluate('time_elapsed', {
        ticket,
        workspaceId: ticket.workspaceId,
        elapsedMinutes: Math.floor((now.getTime() - ticket.createdAt.getTime()) / 60000)
      });
    }
  }
}

// BullMQ でスケジュール
import { Queue, Worker } from 'bullmq';
const slaQueue = new Queue('sla-check', { connection: redis });
await slaQueue.add('check', {}, { repeat: { every: 5 * 60 * 1000 } });
```

## よく使うルール例

```javascript
// ルール例1: VIPメール → 高優先度チームに自動アサイン
{
  name: 'VIPメール自動割り当て',
  triggerEvent: 'ticket_created',
  conditions: [
    { field: 'contact.email', operator: 'ends_with', value: '@vip-corp.com' }
  ],
  actions: [
    { type: 'assign_team', teamId: 'team-vip' },
    { type: 'add_label', label: 'VIP' },
    { type: 'set_priority', priority: 'high' }
  ]
}

// ルール例2: 「注文」「購入」を含む → 注文サポートチームへ
{
  name: '注文関連自動分類',
  triggerEvent: 'message_received',
  conditionLogic: 'OR',
  conditions: [
    { field: 'message.content', operator: 'contains', value: '注文' },
    { field: 'ticket.subject', operator: 'contains', value: '購入' }
  ],
  actions: [
    { type: 'assign_team', teamId: 'team-orders' },
    { type: 'add_label', label: '注文' }
  ]
}

// ルール例3: 1時間未対応 → エスカレーション
{
  name: '1時間SLAエスカレーション',
  triggerEvent: 'time_elapsed',
  conditions: [
    { field: 'ticket.status', operator: 'equals', value: 'open' },
    { field: 'elapsedMinutes', operator: 'greater_than', value: 60 }
  ],
  actions: [
    { type: 'assign_team', teamId: 'team-escalation' },
    { type: 'add_label', label: 'SLA-breach' },
    { type: 'send_notification', agentId: 'manager-id', message: 'SLA超過チケット' }
  ]
}
```

## Workflow

1. `automation_rules` テーブルにルールをCRUD管理するAPI実装
2. 各サービス（MessageIngestion, TicketService）から `ruleEngine.evaluate()` を呼び出す
3. `SLAChecker` をBullMQ repeatジョブで登録
4. ルール実行ログ（`rule_executions`テーブル）でデバッグ可能に

## Gotchas

- ルール評価はトランザクション外で実行 — ルール失敗でメイン処理を止めない
- 無限ループ防止: `send_reply` アクションは受信メッセージイベントでは発火させない
- テンプレートのレンダリングは handlebars/mustache — XSS対策は必須
- SLAチェッカーは複数インスタンス起動時に重複実行注意 — pg-boss の排他ロックを使う
- 条件フィールドは enumで管理 — 任意文字列を許可するとSQLインジェクションリスク
