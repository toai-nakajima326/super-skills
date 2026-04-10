# Super Skills — AIコーディングエージェント統合スキルフレームワーク

## 概要

Super Skillsは、AIコーディングエージェント（Claude Code, Codex, Cursor, Kiro, Antigravity）向けの統合スキルフレームワークである。1つのマスター定義からマルチホストに自動変換し、安全性を重視したワークフローを提供する。

元リポジトリ: takurot/super-skills をベースに、独自のオーケストレーションスキル、自動進化機能を追加した拡張版。

## 設計思想

1. **Author Once, Deploy Everywhere**: スキルを1回書けば、5つのAIツールで同じワークフローが使える
2. **Safety by Default**: 自動コミット無効、テレメトリ無効、MCP/外部ツールは明示オプトイン
3. **Autonomous Evolution**: 毎日自動でupstream追跡、Web探索、自己改善を行う
4. **Quality Enforcement**: 全数検査、ソース照合、ピラミッド型品質管理を全工程に適用

## アーキテクチャ

### ディレクトリ構成

```
~/skills/
├── skills/                      # マスター定義（ホスト中立）
│   ├── auto-router/SKILL.md     # 自動ルーティング
│   ├── investigate/SKILL.md     # デバッグ
│   ├── supervisor-worker/SKILL.md # エージェント管理
│   ├── self-evolve/SKILL.md     # 自動進化
│   └── ... (全33スキル)
├── scripts/                     # ビルド・インストール・同期ツール
│   ├── build-claude-skills.js   # Claude Code用ビルド
│   ├── build-codex-skills.js    # Codex用ビルド
│   ├── build-cursor-skills.js   # Cursor用ビルド
│   ├── build-kiro-skills.js     # Kiro用ビルド
│   ├── build-antigravity-skills.js # Antigravity用ビルド
│   ├── install-apply.mjs        # プロジェクトへのインストーラー
│   └── sync-upstream.sh         # upstream同期
├── manifests/                   # プロファイル・モジュール・コンポーネント定義
├── docs/                        # 仕様書・進化ログ
├── mcp/                         # MCPカタログ・プロファイル
└── plugins/                     # ホスト固有アダプタ
```

### ビルドパイプライン

マスター定義（skills/*/SKILL.md）から各ホスト向けに自動変換:

| ホスト | 出力先 | 形式 |
|--------|--------|------|
| Claude Code | .claude/skills/ | SKILL.md（直接コピー） |
| Codex | .agents/skills/ | SKILL.md + agents/openai.yaml |
| Cursor | .cursor/rules/skills/ | .mdc（Markdown Cursor）ファイル |
| Kiro | .kiro/skills/ | SKILL.md + kiro.json |
| Antigravity | .antigravity/skills/ | SKILL.md + skills-catalog.json |

### デプロイ先

グローバル設定として以下に配置:
- ~/.claude/skills/ (Claude Code Desktop)
- ~/.codex/skills/ (Codex Desktop)

## スキル一覧（全33スキル）

### Priority 0 — 常時Active（自動適用、トリガー不要）

これらのスキルは全てのセッションで自動的にバックグラウンドで適用される。

#### auto-router（自動ルーティング）
ユーザーの発言と文脈から最適なスキルを自動判定して適用する。スキル名を明示的に指定する必要はない。優先度テーブルに従い、Priority 0（常時Active）からPriority 7（リサーチ）まで順にマッチングする。

#### supervisor-worker（エージェント管理）
マルチエージェント作業のオーケストレーション。ペアエージェント方式（ワーカー+チェッカー）を強制し、Independent Judge（独立判定者）による最終評価を行う。

主要ルール:
- メイン（親）は作業しない。指示・承認のみ
- 全てのワーカーに対応するチェッカーを同時起動
- ワーカー: 実装のみ。チェッカー: 検証のみ。役割分離は絶対
- 最大7エージェント（ワーカー3 + チェッカー3 + Judge 1）

実行モード:
- Light: メイン + チェッカー（単純タスク）
- Standard: ワーカー + チェッカー + メイン（通常タスク）
- Strict: 複数ワーカー + 複数チェッカー + Independent Judge（認証・課金・権限・データ移行・外部API・リリース）

#### quality-gate（品質ゲート）
全数検査、ソース照合、回帰テスト、ピラミッド型品質管理を強制する。

ピラミッド構造:
- 承認層（メイン）: 両者の報告を確認、統合レビュー
- 検証層（チェッカー）: ソース元と照合、件数一致確認
- 実行層（ワーカー）: 実作業、結果ファイル作成、件数報告

核心ルール:
- サンプリング・抜き取り調査は禁止。全件対象
- 「問題なし」「全件一致」等の定性的報告は禁止。必ず数値で示す
- 修正後は必ず全体を再検証（部分チェック禁止）

#### report-format（報告フォーマット）
型付きスキーマによる定量的報告を強制する。

必須フォーマット:
```
## 報告: [タスク名]
- 処理件数: X件（カウント定義: ○○）
- ソース照合: X件中X件一致、差分X件
- 反映率: X%（仕様値X件中X件実装済み）
- 合格基準: [基準] → PASS/FAIL
```

自由テキストの報告は禁止。フォーマット非準拠の報告はメインが受理してはならない。

#### phase-gate（フェーズゲート）
フェーズ間の移行を制御する。Phase N統合レビューが完了するまで、Phase N+1の作業着手を禁止する。

必須手順:
1. 全エージェント結果ファイルを全体Read
2. カテゴリ体系の整合性確認
3. 証跡ファイル（docs/analysis/phase-N-review.md）を作成
4. 定量レポートを記録

#### session-handoff（セッション引き継ぎ）
セッション開始時の状態復元と、作業中の自動保存を管理する。

セッション開始時: docs/autodev-log.md読み込み → スキル読み込み → Todo復元 → 「前回の状態: ○○」報告
作業中: Todo完了時・エージェント結果チェック時・コミット前に自動保存

#### self-evolve（自動進化）
毎朝自動でスキルフレームワークを進化させる。upstream同期、Web探索、自己改善の3つのワークフローを持つ。

安全ガード:
- guard/freeze/careful を弱める変更は絶対に自動採用しない
- 自動コミット・自動プッシュ・自動承認を有効にするスキルは採用しない
- テレメトリや外部データ送信を追加するスキルは採用しない
- 全判断をdocs/evolution-log.mdに記録

#### debate-consensus（対立議論）
高リスクな意思決定（アーキテクチャ選択、リスク評価、仕様の曖昧さ解消）に対して、マルチエージェントによる構造化された対立議論を行い、合意形成する。

手順: 問題定義 → 独立スタンス形成 → 対立議論（最低1ラウンド）→ 合意または上位判断 → 意思決定記録

### Priority 1 — 安全スキル

#### guard（安全ガード）
destructive-commandの警告とスコープ制限を組み合わせた安全ワークフロー。rm -rf、DROP TABLE、force pushなどの危険な操作をブロックまたは警告する。

#### freeze（フリーズ）
読み取り専用モード。ファイル書き込み、gitコミット、ネットワーク変更を全てブロックする。

#### careful（慎重モード）
重要な操作の前にバックアップ作成、影響説明、確認待ちを強制する。

#### checkpoint（チェックポイント）
名前付きの状態保存ポイントを作成し、変更に問題があった場合に復元できるようにする。

### Priority 2 — デバッグ・調査

#### investigate（根本原因調査）
根本原因ファースト・デバッグ。推測で直さず、証拠収集→仮説→検証の順で進める。
手順: 再現 → 実行パス追跡 → 最小仮説 → コード/ランタイム検証 → 修正提案

#### health-check（ヘルスチェック）
プロジェクトの健全性を赤/黄/緑で評価。ビルド、テスト、リンター、依存関係、セキュリティ脆弱性をチェックする。

### Priority 3 — 計画・設計

#### plan-product（プロダクト計画）
実装前のプロダクト計画。問題定義 → ユーザーストーリー → 受け入れ基準 → スコープ境界 → 実装スケッチ。

#### plan-architecture（アーキテクチャ設計）
コーディング前のアーキテクチャ設計。コンテキストマッピング → コンポーネント特定 → インターフェース契約 → 障害モード分析 → 意思決定記録。

#### api-design（API設計）
API設計のベストプラクティス。一貫した命名、適切なHTTPセマンティクス、初日からのバージョニング、エラーレスポンスも契約の一部。

### Priority 4 — コードレビュー・セキュリティ

#### review（コードレビュー）
Findings（指摘事項）ファーストのコードレビュー。正確性 → 回帰リスク → セキュリティ → 不足バリデーション → 不足テスト。

#### security-review（セキュリティレビュー）
セキュリティ観点のコードレビュー。脅威モデリング → 入力バリデーション → 認証境界 → 依存関係スキャン → CVSS的重要度付きFindings。

### Priority 5 — 開発ワークフロー

#### ui-implementation（UI実装）
UI実装標準。Design.md参照必須、CSS変数必須、チェッカーによるDesign.md準拠検証後にコミット。

#### tdd-workflow（テスト駆動開発）
TDD強制。失敗テスト作成 → 実行（失敗確認）→ 最小実装 → 実行（成功確認）→ リファクタ → 再実行。

#### ship-release（リリース準備）
リリース準備。テスト通過確認 → チェンジログ更新 → バージョンバンプ → PR作成 → 人間の承認待ち。自動プッシュは絶対にしない。

#### qa-browser（ブラウザQA）
ブラウザベースのリグレッションテスト。ユーザーが見える振る舞いをテストし、安定してからアサートする。

#### e2e-testing（E2Eテスト）
エンドツーエンドテストパターン。ユーザージャーニーをテストし、安定したセレクタを使い、非同期を適切に処理する。

### Priority 6 — ナレッジ・パターン

#### backend-patterns（バックエンドパターン）
バックエンドアーキテクチャパターン。関心の分離、優雅な失敗処理、アクショナブルなログ、冪等操作。

#### frontend-patterns（フロントエンドパターン）
フロントエンドアーキテクチャパターン。コンポーネント合成、関連コードの共配置、共有ミュータブル状態の最小化。

#### coding-standards（コーディング標準）
既存のコードベースパターンに合わせる。命名規則、フォーマット、アーキテクチャの一貫性を維持する。

#### mcp-server-patterns（MCPサーバーパターン）
MCP（Model Context Protocol）サーバー開発パターン。アトミックなツール設計、エラーハンドリング、入力バリデーション。

### Priority 7 — リサーチ・検証

#### deep-research（深掘りリサーチ）
深掘り調査方法論。ソースの三角測量、事実と意見の区別、情報の鮮度確認。

#### exa-search（Web検索）
Web検索統合パターン。構造化クエリ、鮮度フィルタ、権威あるソースの優先。

#### documentation-lookup（ドキュメント参照）
公式ドキュメント検索。回答前に公式ドキュメントを確認し、ソースを引用し、安定版と実験版を区別する。

#### verification-loop（検証ループ）
作業結果の自動検証。期待出力定義 → 作業実行 → 結果比較 → ギャップ特定 → 一致するまで反復。

#### dmux-workflows（並列ワークフロー）
並列タスクオーケストレーション。独立タスク特定 → 共有状態最小化 → 並列実行 → 同期 → 結果集約。

## プロファイルシステム

### 4つのプロファイル

| プロファイル | スキル数 | 用途 |
|-------------|---------|------|
| core | 最小限 | 安全な基本ワークフロー |
| developer | フルセット | エンジニアリング向け（推奨） |
| security | セキュリティ特化 | 監査・強化作業 |
| research | リサーチ特化 | 文献調査・探索 |

全プロファイルにskills-orchestrationモジュール（supervisor-worker, quality-gate, report-format, phase-gate, session-handoff, self-evolve, auto-router, debate-consensus）が含まれる。

### インストーラー

```bash
# プロジェクトに適用
node scripts/install-apply.mjs --profile developer --target claude --target-root /path/to/project

# dry-runで確認
node scripts/install-apply.mjs --profile core --target cursor --target-root . --dry-run

# コンポーネント追加/除外
node scripts/install-apply.mjs --profile developer --target claude --with deep-research --without qa-browser
```

## 自動進化システム

### 概要

self-evolveスキルとスケジュールタスクにより、毎朝自動でスキルフレームワークが進化する。

### 3つの進化経路

#### 1. Upstream同期
takurot/super-skillsリポジトリの更新を追跡し、安全な変更を自動取り込み。

```bash
npm run sync:check   # 差分確認のみ
npm run sync         # 取り込み→ビルド→デプロイ
npm run deploy       # ローカル変更のビルド→デプロイのみ
```

#### 2. Web探索
WebSearchでAIエージェントの最新パターン・ベストプラクティスを探索し、評価基準に基づいて自動採用。

評価基準:
- 新規性: 既存スキルでカバーされていないか？
- 実績: 複数のソースまたは権威ある出典があるか？
- 互換性: SKILL.md形式とauto-router構造に適合するか？
- 安全性: セキュリティリスク、テレメトリ、自動承認はないか？

#### 3. 自己改善
使用パターンを分析し、よく使われるスキル・使われないスキル・カバレッジの穴を特定して改善。

### 初回実行結果（2026-04-10）

初回の自動実行では:
- Upstream同期: スキップ（upstreamに独自スキルがなく、YAMLにバグあり）
- Web探索: debate-consensusスキルを新規発見・採用（Beam AI, Vellum AI, ByteByteGoの3ソースで確認）
- 4パターンを却下（verification-loopと重複、セキュリティリスク、スキル向きでない、概念的すぎる）

### 安全ガード

以下の変更はユーザーの明示的承認なしに自動採用されない:
- guard, freeze, careful の保護を弱める変更
- 自動コミット・自動プッシュ・自動承認を有効にするスキル
- テレメトリや外部データ送信を追加するスキル
- supervisor-worker や quality-gate のチェックを弱める変更

### スケジュール

- 実行時間: 毎朝 9:42
- 動作: upstream同期チェック → Web探索 → 評価・採用判断 → ビルド → Claude/Codex両方にデプロイ → ログ記録 → コミット

## 自動ルーティングシステム

### 仕組み

auto-routerスキルが常にActiveで、ユーザーの発言と文脈から最適なスキルを自動選択する。ユーザーがスキル名を明示的に指定する必要はない。

### ルーティング例

| ユーザーの発言 | 適用されるスキル |
|--------------|--------------|
| 「なんかここ動かないんだけど」 | investigate |
| 「マージする前に見てもらえる？」 | review |
| 「この辺どういう構成にする？」 | plan-architecture |
| 「これ気をつけてやって」 | careful |
| 「出していい？」 | ship-release |
| 「rm -rf で全部消して」 | guard |
| 「React周りもうちょいきれいにしたい」 | frontend-patterns |
| 「どっちのアプローチがいい？」 | debate-consensus |

### Priority 0スキルの自動適用

以下のスキルは常にバックグラウンドで適用される（トリガー不要）:
- supervisor-worker: マルチエージェント作業時
- quality-gate: 全作業出力に対して
- report-format: 全完了報告に対して
- phase-gate: フェーズ移行時
- session-handoff: セッション開始時
- self-evolve: スケジュール実行時

## 品質管理体系

### ピラミッド型品質管理

全ての作業は3層で品質を担保する:

```
        /\
       /  \   承認層（メイン）
      /────\
     /      \  検証層（チェッカー）
    /────────\
   /          \ 実行層（ワーカー）
  /────────────\
```

### 核心原則

1. 全数検査: サンプリング禁止
2. ソース照合: 全件をソース元と照合
3. 回帰テスト: 修正後は全体を再検証
4. 定量報告: 「問題なし」禁止、必ず数値で
5. 修正サイクル: 実装→再検証→再承認の全サイクル必須

## Git履歴

| コミット | 内容 |
|---------|------|
| a7e149e | debate-consensus追加（Web探索で自動発見） |
| d7744d2 | self-evolve（自動進化）スキル追加 |
| 36b39d7 | 6つのオーケストレーションスキル追加 |
| c2fd7d3 | auto-router（自動ルーティング）追加 |
| 13cd162 | upstream（takurot/super-skills）マージ |
| 2b17198 | upstream同期スクリプト追加 |
| b22da74 | Super Skills初期構築（24スキル+5ターゲット） |

## 技術仕様

### SKILL.md フォーマット

```yaml
---
name: <ディレクトリ名と一致>
description: "Use when..." または "Use for..."
origin: unified | web-discovery
---

## Rules
[ルール一覧]

## Workflow
[ワークフロー手順]

## Gotchas
[よくある失敗パターン]
```

### 要件
- Node.js >= 18.0.0
- git（upstream同期に必要）
- SKILL.mdのnameはディレクトリ名と一致すること
- descriptionは "Use when..." または "Use for..." で始めること

### コマンド一覧

```bash
npm run build          # 全ターゲットビルド
npm run build:claude   # Claude Code用ビルド
npm run build:codex    # Codex用ビルド
npm run build:cursor   # Cursor用ビルド
npm run build:kiro     # Kiro用ビルド
npm run build:antigravity # Antigravity用ビルド
npm run validate       # スキル定義のバリデーション
npm run sync           # upstream同期→ビルド→デプロイ
npm run sync:check     # upstream差分確認のみ
npm run deploy         # ローカル変更のビルド→デプロイ
```
