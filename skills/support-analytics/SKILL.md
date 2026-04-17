---
name: support-analytics
description: |
  カスタマーサポートのダッシュボード・KPI分析・CSAT・
  エージェント別パフォーマンスレポートを実装するワークフロー。
  対応件数・平均応答時間・解決率・SLA達成率をリアルタイムで可視化する。
  Use when building analytics dashboards, generating performance reports,
  implementing CSAT surveys, or tracking SLA compliance for support teams.
origin: unified
---

# Support Analytics

## 主要KPI定義

```
1. 対応件数         — 期間内に受信/解決したチケット数
2. 平均初回応答時間  — ticket_created → 最初のoutboundメッセージまでの時間
3. 平均解決時間      — ticket_created → status=resolved までの時間
4. SLA達成率         — 設定時間内に初回応答できた割合
5. 顧客満足度(CSAT)  — アンケート回答の平均スコア
6. 再オープン率      — resolved → open に戻ったチケットの割合
7. 担当者別対応件数  — エージェントごとのパフォーマンス
```

## SQLクエリ集

```sql
-- 1. 期間内の対応件数（チャネル別）
SELECT
  channel_type,
  COUNT(*) AS total_tickets,
  COUNT(CASE WHEN status = 'resolved' THEN 1 END) AS resolved,
  COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_tickets
FROM tickets
WHERE workspace_id = $1
  AND created_at BETWEEN $2 AND $3
GROUP BY channel_type;

-- 2. 平均初回応答時間（分単位）
SELECT
  AVG(EXTRACT(EPOCH FROM (first_reply.sent_at - t.created_at)) / 60) AS avg_first_reply_minutes
FROM tickets t
JOIN LATERAL (
  SELECT sent_at FROM messages
  WHERE ticket_id = t.id AND direction = 'outbound'
  ORDER BY sent_at ASC LIMIT 1
) first_reply ON true
WHERE t.workspace_id = $1
  AND t.created_at BETWEEN $2 AND $3;

-- 3. 担当者別パフォーマンス
SELECT
  u.id AS agent_id,
  u.name AS agent_name,
  COUNT(DISTINCT t.id) AS handled_tickets,
  AVG(EXTRACT(EPOCH FROM (first_reply.sent_at - t.created_at)) / 60) AS avg_first_reply_minutes,
  COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'resolved') AS resolved_count
FROM tickets t
JOIN users u ON u.id = t.assignee_id
JOIN LATERAL (
  SELECT sent_at FROM messages
  WHERE ticket_id = t.id AND direction = 'outbound' AND author_id = u.id
  ORDER BY sent_at ASC LIMIT 1
) first_reply ON true
WHERE t.workspace_id = $1
  AND t.created_at BETWEEN $2 AND $3
GROUP BY u.id, u.name
ORDER BY handled_tickets DESC;

-- 4. SLA達成率（初回応答1時間以内）
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN first_reply_minutes <= 60 THEN 1 END) AS within_sla,
  ROUND(COUNT(CASE WHEN first_reply_minutes <= 60 THEN 1 END) * 100.0 / COUNT(*), 1) AS sla_rate
FROM (
  SELECT
    EXTRACT(EPOCH FROM (MIN(m.sent_at) - t.created_at)) / 60 AS first_reply_minutes
  FROM tickets t
  LEFT JOIN messages m ON m.ticket_id = t.id AND m.direction = 'outbound'
  WHERE t.workspace_id = $1 AND t.created_at BETWEEN $2 AND $3
  GROUP BY t.id
) sub;

-- 5. 日別トレンド（過去30日）
SELECT
  DATE_TRUNC('day', created_at) AS day,
  COUNT(*) AS new_tickets,
  COUNT(CASE WHEN status = 'resolved' THEN 1 END) AS resolved_tickets
FROM tickets
WHERE workspace_id = $1
  AND created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY day
ORDER BY day;
```

## AnalyticsService

```typescript
// analytics/analytics.service.ts
export class AnalyticsService {

  async getDashboard(workspaceId: string, dateRange: { from: Date; to: Date }) {
    const [overview, channelBreakdown, agentPerformance, trend, slaRate] = await Promise.all([
      this.getOverview(workspaceId, dateRange),
      this.getChannelBreakdown(workspaceId, dateRange),
      this.getAgentPerformance(workspaceId, dateRange),
      this.getDailyTrend(workspaceId),
      this.getSlaRate(workspaceId, dateRange, 60) // 60分SLA
    ]);

    return { overview, channelBreakdown, agentPerformance, trend, slaRate };
  }

  async getOverview(workspaceId: string, { from, to }: DateRange) {
    const rows = await this.db.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END) AS resolved,
        COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_count
      FROM tickets
      WHERE workspace_id = $1 AND created_at BETWEEN $2 AND $3
    `, [workspaceId, from, to]);

    const firstReply = await this.db.query(`...`); // 上記SQL 2番

    return {
      totalTickets: Number(rows[0].total),
      resolvedTickets: Number(rows[0].resolved),
      openTickets: Number(rows[0].open_count),
      avgFirstReplyMinutes: Number(firstReply[0]?.avg_first_reply_minutes || 0)
    };
  }
}
```

## CSAT（顧客満足度調査）

```typescript
// csat/csat.service.ts
export class CsatService {

  // チケット解決後に自動送信
  async sendSurvey(ticketId: string) {
    const ticket = await this.db.tickets.findById(ticketId);
    
    // 解決後30分後に送信（バッチ）
    await this.queue.add('send-csat', { ticketId }, {
      delay: 30 * 60 * 1000
    });
  }

  // アンケート回答を記録
  async submitResponse(ticketId: string, score: 1 | 2 | 3 | 4 | 5, comment?: string) {
    await this.db.csatResponses.create({ ticketId, score, comment });
    
    // スコアが低い場合は通知（フォローアップ）
    if (score <= 2) {
      const ticket = await this.db.tickets.findById(ticketId);
      await this.notifications.send(ticket.assigneeId, 'low_csat', { ticketId, score });
    }
  }

  // CSAT集計
  async getAverageScore(workspaceId: string, dateRange: DateRange) {
    const result = await this.db.query(`
      SELECT
        ROUND(AVG(cr.score), 2) AS avg_score,
        COUNT(*) AS response_count,
        COUNT(CASE WHEN cr.score >= 4 THEN 1 END) * 100.0 / COUNT(*) AS satisfaction_rate
      FROM csat_responses cr
      JOIN tickets t ON t.id = cr.ticket_id
      WHERE t.workspace_id = $1
        AND cr.created_at BETWEEN $2 AND $3
    `, [workspaceId, dateRange.from, dateRange.to]);

    return result[0];
  }
}
```

## ラベル別統計

```typescript
// 問い合わせカテゴリ分析
async getLabelStats(workspaceId: string, dateRange: DateRange) {
  return this.db.query(`
    SELECT
      UNNEST(labels) AS label,
      COUNT(*) AS count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage
    FROM tickets
    WHERE workspace_id = $1 AND created_at BETWEEN $2 AND $3
    GROUP BY label
    ORDER BY count DESC
    LIMIT 20
  `, [workspaceId, dateRange.from, dateRange.to]);
}
```

## フロントエンドダッシュボード（React + Recharts）

```tsx
// components/AnalyticsDashboard.tsx
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function AnalyticsDashboard({ data }: { data: DashboardData }) {
  return (
    <div className="grid grid-cols-2 gap-4 p-6">
      {/* KPIカード */}
      <KpiCard title="総対応件数" value={data.overview.totalTickets} />
      <KpiCard title="平均初回応答" value={`${data.overview.avgFirstReplyMinutes.toFixed(0)}分`} />
      <KpiCard title="SLA達成率" value={`${data.slaRate.sla_rate}%`} />
      <KpiCard title="CSAT" value={`${data.csat.avg_score} / 5.0`} />
      
      {/* 日別トレンド */}
      <div className="col-span-2">
        <h3 className="text-sm font-medium mb-2">日別受信・解決件数</h3>
        <ResponsiveContainer height={200}>
          <LineChart data={data.trend}>
            <XAxis dataKey="day" />
            <YAxis />
            <Tooltip />
            <Line dataKey="new_tickets" stroke="#3b82f6" name="受信" />
            <Line dataKey="resolved_tickets" stroke="#10b981" name="解決" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 担当者別 */}
      <ResponsiveContainer height={200}>
        <BarChart data={data.agentPerformance}>
          <XAxis dataKey="agent_name" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="handled_tickets" fill="#6366f1" name="対応件数" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

## CSVエクスポート

```typescript
// analytics/export.service.ts
import { Parser } from 'json2csv';

async function exportTicketsCsv(workspaceId: string, dateRange: DateRange) {
  const tickets = await this.db.tickets.findMany({ workspaceId, ...dateRange });
  const parser = new Parser({
    fields: ['id', 'subject', 'status', 'channelType', 'assigneeName',
             'createdAt', 'resolvedAt', 'firstReplyMinutes']
  });
  return parser.parse(tickets);
}
```

## Workflow

1. `analytics` DB viewまたはマテリアライズドビューをPostgresに定義
2. `AnalyticsService.getDashboard()` でAPI `/api/analytics/dashboard` を実装
3. `CsatService.sendSurvey()` をticket resolvedイベントに接続
4. フロントエンドにRechartsでダッシュボードを実装
5. CSVエクスポートボタンでレポートダウンロード

## Gotchas

- 大量チケットの集計はマテリアライズドビュー + `REFRESH MATERIALIZED VIEW` で高速化
- SLAしきい値はワークスペース設定で可変にする（60分固定にしない）
- CSATアンケートはメール/LINE両方から回答できるよう各チャネルで送信
- ダッシュボードのリアルタイム更新は5-10秒ポーリングで十分（WebSocket不要）
- エージェントIDがNULLのチケット（未割り当て）はレポートで「未割り当て」として集計
