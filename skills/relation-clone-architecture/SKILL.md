---
name: relation-clone-architecture
description: |
  Team Re:lation クローンの全体システム設計ワークフロー。
  マルチチャネル統合受信ボックス・チケット管理・CRM・自動化ルールエンジン・
  AI連携を含むカスタマーサポートSaaSのアーキテクチャ設計。
  Use when designing the system architecture for a Re:lation clone or
  customer support platform, defining service boundaries, or planning the DB schema.
origin: unified
---

# Re:lation Clone Architecture

## システム全体像

```
┌─────────────────────────────────────────────────────────┐
│                    Channel Adapters                      │
│  Email│LINE│WebChat│Instagram│Facebook│SMS│フォーム      │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│              Message Ingestion Service                   │
│  正規化 → 顧客解決 → チケット生成/紐付け → ルール評価     │
└──────────────────────┬──────────────────────────────────┘
                       ↓
┌──────────┬───────────┬──────────────┬────────────────────┐
│ Ticket   │ Customer  │ Auto Rule    │ AI Assistant       │
│ Service  │ CRM       │ Engine       │ Service            │
│ (FSM)    │ Service   │ (ECA)        │ (LLM)              │
└──────────┴───────────┴──────────────┴────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│              Realtime Push (WebSocket)                   │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│                   Frontend SPA                          │
│  統合受信ボックス | CRM | ダッシュボード | 設定            │
└─────────────────────────────────────────────────────────┘
```

## コアDBスキーマ

```sql
-- チャネル定義
CREATE TABLE channels (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  type TEXT NOT NULL,  -- email|line|webchat|instagram|facebook|sms|form
  name TEXT,
  config JSONB,        -- APIキー・Webhook設定など
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 顧客
CREATE TABLE contacts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  channel_identifiers JSONB,  -- {line: "Uxxxxx", email: "a@b.com"}
  custom_fields JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- チケット（問い合わせ）
CREATE TABLE tickets (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id),
  channel_id UUID REFERENCES channels(id),
  status TEXT DEFAULT 'open',  -- open|waiting_reply|waiting_confirm|resolved|no_action
  assignee_id UUID,
  team_id UUID,
  labels TEXT[],
  subject TEXT,
  locked_by UUID,   -- 二重対応防止
  locked_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- メッセージ
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  ticket_id UUID REFERENCES tickets(id),
  direction TEXT,   -- inbound|outbound|internal_note
  channel_type TEXT,
  content TEXT,
  html_content TEXT,
  attachments JSONB,
  author_id UUID,   -- NULL = 顧客
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 自動ルール
CREATE TABLE automation_rules (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  name TEXT,
  enabled BOOLEAN DEFAULT true,
  trigger_event TEXT,  -- ticket_created|message_received|status_changed|...
  conditions JSONB,    -- [{field, operator, value}]
  actions JSONB,       -- [{type, params}]
  priority INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- テンプレート
CREATE TABLE reply_templates (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  name TEXT,
  content TEXT,
  variables TEXT[],  -- {{customer_name}} など
  labels TEXT[],
  use_count INT DEFAULT 0
);
```

## サービス分割（マイクロサービス or モジュラーモノリス）

```
推奨: モジュラーモノリス（初期フェーズ）
理由: チームサイズ・コスト・デプロイ複雑性を考慮

modules/
  channel-adapters/    # チャネル別受信・送信アダプター
  ticket-service/      # チケットFSM・担当割り当て
  customer-crm/        # 顧客管理・タイムライン
  auto-rule-engine/    # ECAルールエンジン
  ai-assistant/        # LLM連携（返信提案・要約）
  notification/        # WebSocket・メール通知
  analytics/           # レポート・ダッシュボード
  auth/                # ワークスペース・チーム・権限
```

## 代替コンポーネント（Re:lation本家との違い）

| 本家 | クローンでの代替 | 理由 |
|------|-----------------|------|
| 独自CTI | Twilio Voice API | コスト・実装工数 |
| 楽天R-Messe連携 | 汎用EC Webhook | 初期スコープ外 |
| Salesforce/kintone連携 | REST API + Webhook | シンプルな統合 |
| 独自ナレッジベース | Notion API or MDX | 既存コンテンツ活用 |
| Re:Chat | Chatwoot or 自前 | OSS活用 |

## 技術スタック推奨

```
Backend:  Node.js (Hono/Fastify) or Python (FastAPI)
DB:       PostgreSQL + Redis (セッション/キュー)
Realtime: WebSocket (ws) or Socket.io
Queue:    BullMQ (Redis) or pg-boss (Postgres)
AI:       Claude API (+ MLX ローカルフォールバック)
Frontend: Next.js (App Router) + shadcn/ui
Auth:     Clerk or Auth.js
Deploy:   Railway or Fly.io (初期)
```

## Workflow

1. DBスキーマを上記から作成・マイグレーション
2. `omnichannel-inbox` でチャネルアダプター実装
3. `support-ticket-fsm` でチケット状態管理実装
4. `auto-rule-engine` で自動化ルール実装
5. `customer-crm-timeline` でCRM実装
6. `ai-support-assistant` でLLM連携実装
7. `support-analytics` でレポート実装
8. フロントエンドSPA構築（統合受信ボックスUI）

## Gotchas

- マルチテナント設計必須 — workspace_id を全テーブルに含める
- 二重対応防止ロックはredisのdistributed lockが確実
- チャネルアダプターは非同期キューで受信 — 受信サーバーは即座にACK返す
- PostgreSQL JSONBインデックスはcontacts.channel_identifiersに必須
- 大量メッセージのタイムラインページネーションはcursor-basedで実装
