---
name: ai-support-assistant
description: |
  カスタマーサポートのAIアシスタント実装ワークフロー。
  返信文の自動生成・要約・校正・テンプレート提案・AIチャットボット・
  ナレッジベース参照をClaude API + MLXローカルモデルで実装する。
  Use when adding AI features to a support platform: reply drafting,
  ticket summarization, template suggestions, or chatbot responses.
origin: unified
---

# AI Support Assistant

## AI機能一覧

```
1. 返信文生成   — チケット・会話履歴から返信ドラフト自動作成
2. 要約         — 長い問い合わせ履歴をエージェント向けに要約
3. 校正         — 送信前に文章チェック（敬語・誤字・トーン）
4. テンプレート提案 — 過去の類似返信からベストマッチを推薦
5. AIチャットボット — ナレッジベース参照で24時間一次対応
6. 感情分析     — 顧客の感情（怒り・困惑・満足）を検出してエスカレーション
```

## Claude API統合

```typescript
// ai-assistant/claude.service.ts
import Anthropic from '@anthropic-ai/sdk';

export class ClaudeAssistant {
  private client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 1. 返信文生成
  async draftReply(ticket: Ticket, messages: Message[], instruction?: string) {
    const conversation = messages.map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant' as const,
      content: m.content
    }));

    const systemPrompt = `あなたは${ticket.workspace.name}のカスタマーサポート担当者です。
プロフェッショナルで親切な返信を書いてください。
顧客名: ${ticket.contact.name}
チャネル: ${ticket.channelType}
${instruction ? `特記事項: ${instruction}` : ''}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        ...conversation,
        { role: 'user', content: '上記の問い合わせへの返信を書いてください。' }
      ]
    });

    return (response.content[0] as { text: string }).text;
  }

  // 2. 要約
  async summarizeTicket(ticket: Ticket, messages: Message[]) {
    const history = messages.map(m =>
      `[${m.direction === 'inbound' ? '顧客' : 'サポート'}] ${m.content}`
    ).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5',  // 要約は安価なモデルで
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `以下の問い合わせ対応履歴を担当者向けに3行で要約してください:\n\n${history}`
      }]
    });

    return (response.content[0] as { text: string }).text;
  }

  // 3. 校正
  async proofread(draft: string, channelType: string) {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `以下の${channelType}返信文を校正してください。
誤字・敬語・トーンを確認し、修正版を提示してください。
問題がなければ「問題なし」と答えてください。

---
${draft}
---`
      }]
    });

    return (response.content[0] as { text: string }).text;
  }

  // 6. 感情分析
  async analyzeSentiment(message: string): Promise<'angry' | 'confused' | 'satisfied' | 'neutral'> {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `以下のメッセージの感情を1語で答えてください（angry/confused/satisfied/neutral）:\n${message}`
      }]
    });
    const text = (response.content[0] as { text: string }).text.trim().toLowerCase();
    return (['angry', 'confused', 'satisfied'].includes(text) ? text : 'neutral') as 'angry' | 'confused' | 'satisfied' | 'neutral';
  }
}
```

## テンプレート推薦エンジン

```typescript
// ai-assistant/template-recommender.ts
export class TemplateRecommender {

  // ベクトル類似度でテンプレートを推薦
  async recommend(query: string, workspaceId: string, limit = 3) {
    // vcontextのMLX embedを使用（ローカル）
    const queryEmbed = await this.embed(query);
    
    // PostgreSQL pgvector or vcontext semantic search
    const templates = await this.db.query(`
      SELECT id, name, content,
        1 - (embedding <=> $1::vector) AS similarity
      FROM reply_templates
      WHERE workspace_id = $2
      ORDER BY similarity DESC
      LIMIT $3
    `, [JSON.stringify(queryEmbed), workspaceId, limit]);

    return templates;
  }

  // vcontext MLX embed APIを使用
  private async embed(text: string): Promise<number[]> {
    const r = await fetch('http://127.0.0.1:3150/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const d = await r.json();
    return d.embedding;
  }
}
```

## AIチャットボット（ナレッジベース参照）

```typescript
// ai-assistant/chatbot.service.ts
export class SupportChatbot {
  private claude = new ClaudeAssistant();

  async respond(customerMessage: string, workspaceId: string): Promise<{
    response: string;
    escalate: boolean;
    confidence: number;
  }> {
    // 1. ナレッジベースから関連記事を検索
    const articles = await this.knowledgeBase.search(customerMessage, workspaceId, 3);

    // 2. 記事がない or 感情=angryの場合はエスカレーション
    const sentiment = await this.claude.analyzeSentiment(customerMessage);
    if (sentiment === 'angry' || articles.length === 0) {
      return { response: '', escalate: true, confidence: 0 };
    }

    // 3. ナレッジベースを参照して回答生成
    const context = articles.map(a => `## ${a.title}\n${a.content}`).join('\n\n');

    const response = await this.claude.client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: `あなたはカスタマーサポートAIです。
以下のナレッジベースの情報のみを使って回答してください。
不明な場合は「担当者に確認します」と答えてください。

${context}`,
      messages: [{ role: 'user', content: customerMessage }]
    });

    const text = (response.content[0] as { text: string }).text;
    const escalate = text.includes('担当者に確認');

    return { response: text, escalate, confidence: escalate ? 0.3 : 0.9 };
  }
}
```

## ローカルLLMフォールバック（MLX）

```typescript
// aios-llm-routerと連携 — プライバシー重要データはMLXローカルで処理
async function callWithLocalFallback(prompt: string, task: 'draft' | 'summarize') {
  // まずMLXローカル(Qwen3-8B)を試行
  try {
    const r = await fetch('http://127.0.0.1:3162/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mlx-community/Qwen3-8B-4bit',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: task === 'summarize' ? 256 : 1024
      })
    });
    if (r.ok) return (await r.json()).choices[0].message.content;
  } catch {}

  // MLXが落ちていたらClaude APIにフォールバック
  const claude = new ClaudeAssistant();
  return task === 'summarize'
    ? claude.summarizeTicket(null as any, [{ content: prompt } as any])
    : claude.draftReply(null as any, [{ content: prompt } as any]);
}
```

## API エンドポイント

```
POST /api/ai/draft-reply      { ticketId, instruction? }
POST /api/ai/summarize        { ticketId }
POST /api/ai/proofread        { ticketId, draft }
POST /api/ai/recommend-templates { ticketId }
POST /api/ai/chatbot          { message, workspaceId }
POST /api/ai/sentiment        { messageId }
```

## Workflow

1. `ClaudeAssistant` を初期化（ANTHROPIC_API_KEY必須）
2. 返信フォームの「AI生成」ボタンから `/api/ai/draft-reply` を呼び出し
3. `TemplateRecommender` にはpgvector or vcontext embedが必要
4. チャットボットは `SupportChatbot.respond()` → escalate=trueならチケット作成
5. 感情分析を `auto-rule-engine` のトリガーに組み込み（angry → 即エスカレーション）

## Gotchas

- 要約・校正はclaude-haiku（安価）、返信生成はclaude-sonnet — コスト最適化
- プロンプトにworkspace名・顧客名を入れないと汎用的すぎる返信になる
- ナレッジベースが空だとチャットボットは即エスカレーションになる — 記事登録を先に
- MLXのウォームアップは30秒かかる — プロセス常時起動必須
- 個人情報（メールアドレス等）をAPIに送信する前にマスキングを検討
