# AIOS 自動実行スケジュール

**Last updated**: 2026-04-18 (cadence review — AI trends move fast, daily at minimum)

## 現行スケジュール

| ジョブ | 頻度 | 実行時刻 (JST) | 所要 | MLX 負荷 |
|--------|------|--------------|------|--------|
| **chunk-summary L1** | 5分おきチェック | 常時 (前 10-20 分対象) | ~10秒 | 軽 |
| **chunk-summary L2** | 30分おきチェック | 常時 (前日 UTC 対象) | ~60秒/日 | 軽 |
| **chunk-summary L3** | 60分おきチェック | 常時 (前週 ISO 対象) | ~60秒/週 | 軽 |
| **embed-loop** | 2秒おき | 常時 | ~500ms | 軽 |
| **discovery-loop** | 5分おき | 常時 | ~30秒 | 中 |
| **predictive-search** | 30分おき | 常時 | ~60秒 | 中 |
| **article-scanner (朝)** | 毎日 | **06:00** | 20-30分 | 重 |
| **article-scanner (夕)** | 毎日 | **18:00** | 20-30分 | 重 |
| **self-evolve** (obs モード) | **毎日** | **07:00** | ~10秒 | 極軽 |
| **keyword-expander** | **毎日** | **05:00** | ~75秒 | 中 |
| **watchdog** | 1分おき | 常時 | 1秒 | 極軽 |
| **maintenance** | 毎日 02:00 | 02:00 | 数分 | 軽 |
| **morning-brief** | 毎日 08:00 | 08:00 | ~30秒 | 中 |

## 2026-04-18 の cadence 見直し履歴

owner 指摘: 「AI の世界は早いから、月次 / 週次は遅すぎる」

| ジョブ | Before | After | 変更理由 |
|--------|--------|-------|---------|
| keyword-expander | 月次 1日 05:00 | **毎日 05:00** | トレンド追随を最速化、Mode C (L2→MLX) は日次 L2 に対して意味あり |
| self-evolve | 週次 日曜 07:00 | **毎日 07:00** (観察モード) | cycle_id=YYYY-WW で週内 idempotent、候補収集を 7× 高速化 |
| article-scanner | 毎日 06:00 | **毎日 06:00 + 18:00** | 海外タイムゾーンの夜リリース (SF夜=JP昼) を翌朝でなくその夜に捕捉 |

## 各ジョブの入力→出力関係 (データフロー)

```
            ┌────────────────────────────────────────────┐
            │  article-scanner  (daily × 2)              │
            │    11 sources、曜日ローテーション           │
            └────────────────┬───────────────────────────┘
                             │ pending-idea (score ≥ 7)
                             │ external-article (raw)
                             │ article-evaluation
                             ▼
            ┌────────────────────────────────────────────┐
            │  vcontext entries (SQLite + FTS5 + vec)    │
            │  Hook: 全 AI IDE tool-use 記録              │
            └────┬───────────────┬───────────────────────┘
                 │               │
                 │               │ L0 raw entries
                 │               │  ↓ 10分おき
                 │               │ L1 chunk-summary
                 │               │  ↓ 日次集約
                 │               │ L2 (pain_signals, triggered_change)
                 │               │  ↓ 週次集約
                 │               │ L3 (themes, decisions_made)
                 │               ▼
                 │      (hierarchical memory — Pillar 1)
                 │
                 │ skill-gap / skill-suggestion
                 │ (from discovery-loop 5分おき)
                 │
                 │      ┌──────────────────────────────────┐
                 ├─────▶│  self-evolve (daily 07:00, obs)  │
                 │      │  5 入力ストリームから候補収集    │
                 │      │   ↓ dedupeCandidates (cross-stream)│
                 │      │   ↓ fitness score (stub)         │
                 │      │   ↓ 観察モード: ログのみ          │
                 │      │  出力: evolution-digest,          │
                 │      │        (将来 pending-patch)       │
                 │      └──────────────────────────────────┘
                 │
                 │      ┌──────────────────────────────────┐
                 └─────▶│  keyword-expander (daily 05:00)  │
                        │  Mode A: SearXNG × 7 trending    │
                        │  Mode C: L2 → MLX suggest        │
                        │  出力: keyword-suggestion entries │
                        │        human-in-loop review       │
                        └──────────────────────────────────┘
```

## 負荷シミュレーション (1日の MLX 利用時間)

```
 article-scanner (朝)    30分
+article-scanner (夕)    30分
+discovery-loop          30秒 × 288回 =  144分
+predictive-search       60秒 × 48回  =   48分
+chunk-summary L1        10秒 × 144回 =   24分
+chunk-summary L2        60秒 × 1回   =    1分
+self-evolve (daily)     10秒 × 1回   =  0.2分
+keyword-expander (daily) 75秒 × 1回  =  1.3分
+その他 (L3, morning-brief 等)        =    5分
──────────────────────────────────────
合計                                   ~283分/日 ≈ 4.7時間
MLX 利用率                             ~20%
```

→ Mac mini / MBP M3 Pro なら余裕。残り 19時間は idle 状態、他タスクと競合しない。

## 将来の cadence 拡張

owner レビュー待ちの提案:

1. **self-evolve 実モード (Phase b-e 有効化)** — 観察モードで十分データ集まってから
2. **article-scanner on-demand trigger** — pending-idea score 10/10 が未知 keyword を含む時、即時 keyword-expander 起動
3. **急行 cadence mode** — 重要カンファレンス週 (NeurIPS, ICLR 等) は 4時間おきに article-scanner
4. **旧コンテンツ decay** — `pending-idea` status=pending が 14日超えたら auto-reject

## LaunchAgent plist 一覧 (実体は `~/Library/LaunchAgents/`)

| Label | plist 所在 | Git 管理 |
|-------|-----------|---------|
| com.vcontext.server | 個人 Library | No |
| com.vcontext.watchdog | 個人 Library | No |
| com.vcontext.mlx-embed | 個人 Library | No |
| com.vcontext.mlx-generate | 個人 Library | No |
| com.vcontext.ramdisk | 個人 Library | No |
| com.vcontext.maintenance | 個人 Library | No |
| com.vcontext.hooks-setup | 個人 Library | No |
| com.vcontext.morning-brief | 個人 Library | No |
| com.vcontext.article-scanner | 個人 Library | No |
| **com.vcontext.article-scanner-evening** (NEW 2026-04-18) | 個人 Library | No |
| com.vcontext.self-evolve | 個人 Library | No |
| **com.vcontext.keyword-expander** | 個人 Library | No |
| com.vcontext.skill-discovery | 個人 Library | No |

plist 内容は Git 管理外 (個人環境依存)。このドキュメントが唯一の schedule 真実源。
