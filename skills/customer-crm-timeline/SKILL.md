---
name: customer-crm-timeline
description: |
  顧客プロフィール管理・チャネル横断の対応履歴タイムライン・
  カスタムフィールド・外部CRM連携を実装するワークフロー。
  Re:lationのアドレス帳・顧客タイムライン機能のクローン実装。
  Use when implementing customer profile management, interaction history,
  contact deduplication, or CRM integration in a support platform.
origin: unified
---

# Customer CRM & Timeline

## 顧客プロフィール設計

```typescript
// contacts テーブル + contact_custom_fields テーブル

interface Contact {
  id: string;
  workspaceId: string;
  name: string;
  email?: string;
  phone?: string;
  
  // チャネル別識別子（マルチチャネルで同一顧客を紐付け）
  channelIdentifiers: {
    email?: string;
    line?: string;      // LINE userId: Uxxxx...
    instagram?: string; // Instagram PSID
    facebook?: string;
    [key: string]: string | undefined;
  };
  
  customFields: Record<string, string | number | boolean>; // カスタム項目
  
  tags: string[];
  notes: string;  // 内部メモ
  
  // 統計
  totalTickets: number;
  lastContactAt: Date;
  
  createdAt: Date;
  updatedAt: Date;
}
```

## 顧客解決ロジック（重複防止）

```typescript
// contact-resolution.service.ts
export class ContactResolutionService {

  async resolveByChannelId(
    workspaceId: string,
    channelType: string,
    channelIdentifier: string,
    profile: { name?: string; email?: string; avatar?: string }
  ): Promise<Contact> {
    
    // 1. チャネル識別子で既存顧客を検索
    let contact = await this.db.contacts.findByChannelId(
      workspaceId, channelType, channelIdentifier
    );

    if (contact) {
      // プロフィール更新（最新情報で上書き）
      return this.db.contacts.update(contact.id, {
        name: profile.name || contact.name,
        [`channelIdentifiers.${channelType}`]: channelIdentifier
      });
    }

    // 2. メールアドレスで既存顧客を検索（チャネル統合）
    if (profile.email) {
      contact = await this.db.contacts.findByEmail(workspaceId, profile.email);
      if (contact) {
        // 既存顧客にチャネル識別子を追加（マージ）
        return this.db.contacts.update(contact.id, {
          [`channelIdentifiers.${channelType}`]: channelIdentifier
        });
      }
    }

    // 3. 新規顧客作成
    return this.db.contacts.create({
      workspaceId,
      name: profile.name || channelIdentifier,
      email: profile.email,
      channelIdentifiers: { [channelType]: channelIdentifier },
      customFields: {},
      tags: [],
      totalTickets: 0,
      lastContactAt: new Date()
    });
  }

  // 手動マージ（担当者が重複顧客を統合）
  async merge(primaryId: string, duplicateId: string) {
    const [primary, duplicate] = await Promise.all([
      this.db.contacts.findById(primaryId),
      this.db.contacts.findById(duplicateId)
    ]);

    // チャネル識別子をマージ
    const mergedIdentifiers = {
      ...duplicate.channelIdentifiers,
      ...primary.channelIdentifiers
    };

    // チケットを統合先に付け替え
    await this.db.tickets.updateMany(
      { contactId: duplicateId },
      { contactId: primaryId }
    );

    // プロフィール更新
    await this.db.contacts.update(primaryId, {
      channelIdentifiers: mergedIdentifiers,
      tags: [...new Set([...primary.tags, ...duplicate.tags])]
    });

    // 重複を削除
    await this.db.contacts.delete(duplicateId);
    
    return this.db.contacts.findById(primaryId);
  }
}
```

## 対応履歴タイムライン

```typescript
// timeline.service.ts
export class TimelineService {

  // 顧客の全チケット・メッセージをタイムライン形式で取得
  async getContactTimeline(contactId: string, options: PaginationOptions) {
    const { cursor, limit = 20 } = options;

    // チャネル横断で時系列ソート
    const entries = await this.db.query(`
      SELECT
        'ticket' AS entry_type,
        t.id,
        t.subject,
        t.status,
        t.channel_type,
        t.created_at AS timestamp,
        NULL AS content,
        NULL AS direction,
        u.name AS actor_name
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.contact_id = $1

      UNION ALL

      SELECT
        'message' AS entry_type,
        m.id,
        tk.subject,
        NULL AS status,
        tk.channel_type,
        m.created_at AS timestamp,
        m.content,
        m.direction,
        u.name AS actor_name
      FROM messages m
      JOIN tickets tk ON tk.id = m.ticket_id
      LEFT JOIN users u ON u.id = m.author_id
      WHERE tk.contact_id = $1

      UNION ALL

      SELECT
        'activity' AS entry_type,
        a.id,
        NULL AS subject,
        NULL AS status,
        NULL AS channel_type,
        a.created_at AS timestamp,
        a.payload::text AS content,
        NULL AS direction,
        u.name AS actor_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.contact_id = $1

      ORDER BY timestamp DESC
      LIMIT $2
    `, [contactId, limit + 1]);

    // cursor-based pagination
    const hasMore = entries.length > limit;
    return {
      entries: entries.slice(0, limit),
      hasMore,
      nextCursor: hasMore ? entries[limit - 1].id : null
    };
  }
}
```

## カスタムフィールド管理

```typescript
// カスタムフィールド定義
interface CustomFieldDef {
  id: string;
  workspaceId: string;
  name: string;         // 表示名 e.g. '会員ランク'
  key: string;          // API key e.g. 'member_rank'
  type: 'text' | 'number' | 'boolean' | 'select' | 'date';
  options?: string[];   // select型の選択肢
  required: boolean;
  displayOrder: number;
}

// 使用例
const fields: CustomFieldDef[] = [
  { key: 'member_rank',    type: 'select',  options: ['一般', 'シルバー', 'ゴールド'] },
  { key: 'contract_no',    type: 'text' },
  { key: 'is_enterprise',  type: 'boolean' },
  { key: 'purchase_count', type: 'number' }
];
```

## 外部CRM連携（代替: REST API + Webhook）

```typescript
// 本家はSalesforce/kintone連携 → クローンはシンプルなREST/Webhook
export class ExternalCrmSync {

  // 顧客作成/更新時にWebhookを送出
  async notifyExternal(event: 'contact.created' | 'contact.updated', contact: Contact) {
    const webhooks = await this.db.webhooks.findByEvent(contact.workspaceId, event);
    
    for (const wh of webhooks) {
      await fetch(wh.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': this.sign(wh.secret, contact)
        },
        body: JSON.stringify({
          event,
          contact: this.sanitize(contact),
          timestamp: new Date().toISOString()
        })
      });
    }
  }

  // 外部CRMからの顧客情報pull
  async syncFromExternal(workspaceId: string, externalId: string) {
    const integration = await this.db.integrations.find(workspaceId);
    if (!integration) return;

    const response = await fetch(`${integration.apiUrl}/contacts/${externalId}`, {
      headers: { 'Authorization': `Bearer ${integration.apiKey}` }
    });
    const data = await response.json();

    return this.contactService.upsert({
      workspaceId,
      externalId,
      name: data.name,
      email: data.email,
      customFields: data.custom_fields || {}
    });
  }
}
```

## Workflow

1. `contacts` テーブルと `contact_custom_field_defs` テーブルをマイグレーション
2. `ContactResolutionService.resolveByChannelId()` を `MessageIngestionService` に組み込む
3. `TimelineService.getContactTimeline()` でタイムラインAPIを実装
4. 管理画面でカスタムフィールド定義をCRUD管理
5. 外部CRM連携はWebhookアウトバウンドで対応

## Gotchas

- channel_identifiers は JSONB + GINインデックス必須 — 検索が遅くなる
- 顧客マージは慎重に — チケット履歴を失わないようにFK更新を先に
- LINE userIdはオープンIDで500文字超えることがある — TEXT型を使う
- タイムラインのUNION ALLクエリは大量データで遅くなる — 別途`timeline_events`テーブルに非正規化推奨
- カスタムフィールドのkey変更は既存データとの整合性が取れなくなる — 変更不可にする
