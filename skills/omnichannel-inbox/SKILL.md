---
name: omnichannel-inbox
description: |
  メール・LINE・WebChat・Instagram・Facebook・SMS・フォームを
  単一受信ボックスに統合するチャネルアダプター実装ワークフロー。
  各チャネルのWebhook受信・メッセージ正規化・送信APIを標準化する。
  Use when implementing channel integrations for a customer support platform,
  adding a new messaging channel, or normalizing messages across channels.
origin: unified
---

# Omnichannel Inbox

## チャネルアダプターインターフェース

```typescript
// channel-adapters/base.ts
export interface ChannelAdapter {
  type: ChannelType;
  
  // Webhook受信 → 正規化メッセージを返す
  handleWebhook(req: Request): Promise<NormalizedMessage[]>;
  
  // 送信
  sendMessage(params: SendParams): Promise<SendResult>;
  
  // Webhookの検証（署名チェック）
  verifyWebhook(req: Request): boolean;
}

export type ChannelType = 'email' | 'line' | 'webchat' | 'instagram' | 'facebook' | 'sms' | 'form';

export interface NormalizedMessage {
  channelType: ChannelType;
  channelMessageId: string;    // チャネル側のメッセージID
  contactIdentifier: string;   // チャネル側の顧客ID (email addr, LINE userId, etc.)
  contactName?: string;
  contactAvatar?: string;
  subject?: string;            // メール件名
  content: string;             // テキスト本文
  htmlContent?: string;
  attachments: Attachment[];
  receivedAt: Date;
  threadId?: string;           // スレッド識別子（メールIn-Reply-To等）
  raw: unknown;                // 元のペイロード（デバッグ用）
}
```

## メールアダプター（IMAP/SMTP）

```typescript
// channel-adapters/email.ts
import Imap from 'imap';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

export class EmailAdapter implements ChannelAdapter {
  type = 'email' as const;

  // IMAPポーリング or Webhook（Postmark/SendGrid Inbound）
  async handleWebhook(req: Request): Promise<NormalizedMessage[]> {
    const body = await req.json();
    // Postmark inbound example
    return [{
      channelType: 'email',
      channelMessageId: body.MessageID,
      contactIdentifier: body.From,
      contactName: body.FromName,
      subject: body.Subject,
      content: body.TextBody || '',
      htmlContent: body.HtmlBody,
      attachments: (body.Attachments || []).map(a => ({
        name: a.Name, url: a.ContentID, mimeType: a.ContentType
      })),
      receivedAt: new Date(body.Date),
      threadId: body.ReplyToMessageID || body.MessageID,
      raw: body
    }];
  }

  async sendMessage({ to, subject, content, htmlContent, replyToMessageId }: SendParams) {
    const transporter = nodemailer.createTransport({ /* SMTP config */ });
    return transporter.sendMail({
      to, subject, text: content, html: htmlContent,
      inReplyTo: replyToMessageId,
      references: replyToMessageId
    });
  }

  verifyWebhook(req: Request): boolean {
    // Postmark: X-Postmark-Signature ヘッダー検証
    return true;
  }
}
```

## LINE Messaging APIアダプター

```typescript
// channel-adapters/line.ts
import { Client, WebhookEvent, messagingApi } from '@line/bot-sdk';

export class LineAdapter implements ChannelAdapter {
  type = 'line' as const;
  private client: Client;

  constructor(config: { channelAccessToken: string; channelSecret: string }) {
    this.client = new Client(config);
  }

  async handleWebhook(req: Request): Promise<NormalizedMessage[]> {
    const body = await req.json();
    const results: NormalizedMessage[] = [];

    for (const event of body.events as WebhookEvent[]) {
      if (event.type !== 'message') continue;
      const msg = event.message;
      
      results.push({
        channelType: 'line',
        channelMessageId: msg.id,
        contactIdentifier: event.source.userId!,
        content: msg.type === 'text' ? msg.text : `[${msg.type}]`,
        attachments: msg.type === 'image' ? [{ name: 'image', url: `line:${msg.id}` }] : [],
        receivedAt: new Date(event.timestamp),
        threadId: event.source.userId,  // LINEはユーザーがスレッド
        raw: event
      });
    }
    return results;
  }

  async sendMessage({ to, content }: SendParams) {
    return this.client.pushMessage({ to, messages: [{ type: 'text', text: content }] });
  }

  verifyWebhook(req: Request): boolean {
    // X-Line-Signature ヘッダー検証
    const sig = req.headers.get('x-line-signature') || '';
    // HMAC-SHA256 verify
    return true;
  }
}
```

## メッセージ受信パイプライン

```typescript
// message-ingestion.service.ts
export class MessageIngestionService {
  
  async ingest(normalized: NormalizedMessage, workspaceId: string) {
    // 1. 顧客解決（存在確認 or 新規作成）
    const contact = await this.contactService.resolveByChannelId(
      workspaceId,
      normalized.channelType,
      normalized.contactIdentifier,
      { name: normalized.contactName, avatar: normalized.contactAvatar }
    );

    // 2. スレッドからチケットを解決
    let ticket = await this.ticketService.findByThreadId(
      workspaceId, normalized.channelType, normalized.threadId
    );

    if (!ticket) {
      // 新規チケット作成
      ticket = await this.ticketService.create({
        workspaceId,
        contactId: contact.id,
        channelType: normalized.channelType,
        subject: normalized.subject || `New message from ${contact.name}`,
        status: 'open'
      });
    } else {
      // 既存チケットを再オープン（対応完了 → 受信で再オープン）
      if (ticket.status === 'resolved') {
        await this.ticketService.reopen(ticket.id);
      }
    }

    // 3. メッセージ保存
    const message = await this.messageService.create({
      ticketId: ticket.id,
      direction: 'inbound',
      ...normalized
    });

    // 4. 自動ルール評価
    await this.ruleEngine.evaluate('message_received', { ticket, message, contact });

    // 5. WebSocketでリアルタイム通知
    await this.realtime.broadcast(workspaceId, 'new_message', { ticket, message });

    return { ticket, message, contact };
  }
}
```

## 送信API（チャネル横断）

```typescript
// message-send.service.ts
export class MessageSendService {
  private adapters = new Map<ChannelType, ChannelAdapter>();

  async send(ticketId: string, content: string, options: SendOptions = {}) {
    const ticket = await this.ticketService.findById(ticketId);
    const adapter = this.adapters.get(ticket.channelType);
    
    // 送信
    const result = await adapter.sendMessage({
      to: ticket.contact.channelIdentifiers[ticket.channelType],
      content,
      htmlContent: options.htmlContent,
      subject: options.subject || `Re: ${ticket.subject}`,
      replyToMessageId: ticket.lastMessageChannelId
    });

    // メッセージ記録
    await this.messageService.create({
      ticketId,
      direction: 'outbound',
      content,
      authorId: options.agentId,
      sentAt: new Date()
    });

    // ステータス更新（返信 → 返事待ち）
    await this.ticketService.transition(ticketId, 'reply_sent');
  }
}
```

## 代替チャネル実装（シンプル版）

```typescript
// 本家Re:lationにないもの or 代替する場合
// 汎用Webhook受信（フォーム・カスタム）
export class GenericWebhookAdapter implements ChannelAdapter {
  type = 'form' as const;
  
  async handleWebhook(req: Request): Promise<NormalizedMessage[]> {
    const body = await req.json();
    return [{
      channelType: 'form',
      channelMessageId: body.id || crypto.randomUUID(),
      contactIdentifier: body.email || body.phone || body.id,
      contactName: body.name,
      subject: body.subject,
      content: body.message || JSON.stringify(body),
      attachments: [],
      receivedAt: new Date(),
      raw: body
    }];
  }
}
```

## Workflow

1. チャネル設定をDBに保存（`channels`テーブル）
2. 各チャネルのWebhook URLを設定（`/api/webhook/:channelId`）
3. アダプターをWebhookルーターに登録
4. `MessageIngestionService.ingest()` で正規化・チケット紐付け
5. `MessageSendService.send()` で送信

## Gotchas

- LINEはWebhook受信後5秒以内にHTTP 200を返す必須 — 処理はキューに投げる
- メールのスレッド管理は `In-Reply-To` + `References` ヘッダーで行う
- LINE userId は1000文字を超えるため varchar(255) では収まらない場合がある
- Instagram DM APIはビジネスアカウントのみ、審査が必要
- 大量メール受信はIMAPポーリングより Postmark/SendGrid Inbound Webhookが安定
