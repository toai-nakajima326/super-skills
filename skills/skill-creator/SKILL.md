---
name: skill-creator
description: |
  ~/skills/skills/ 形式のSKILL.mdを設計・作成・登録・デプロイする
  メタスキル。要件からフロントマター・ワークフロー・Gotchasを生成し、
  vcontextへの登録とinfinite-skillsルーティング更新まで自動化する。
  Use when creating a new skill, generating a SKILL.md template, or
  onboarding a new workflow pattern into the skill system.
origin: unified
---

# Skill Creator

## SKILL.md フォーマット

```markdown
---
name: skill-name           # ケバブケース
description: |
  1-3行の説明。いつ使うかを明記。
  Use when <trigger condition>.
origin: unified            # unified | local | upstream
---

# スキル名

## 概要 / 目的

## 主要パターン

\`\`\`javascript / bash / python
# 実装例・コマンド
\`\`\`

## Workflow

1. ステップ1
2. ステップ2
...

## Gotchas

- 注意点1
- 注意点2
```

## スキル設計プロセス

```
1. トリガー条件を特定 — "いつこのスキルが呼ばれるか"
2. ワークフローを3-7ステップで定義
3. 実装パターンをコードブロックで示す
4. Gotchasに既知の落とし穴を書く
5. infinite-skillsの優先度(P0-P7)を決める
```

## 優先度マッピング

| 優先度 | 対象 | 判断基準 |
|--------|------|---------|
| P0 | always-on インフラ | 毎セッション必要 |
| P1 | 安全チェック | 破壊的操作の前 |
| P2 | デバッグ・QA | エラー/テスト文脈 |
| P3 | 計画・設計 | アーキテクチャ文脈 |
| P4 | レビュー | PR/diff文脈 |
| P5 | 実装 | コーディング文脈 |
| P6 | パターン | 特定技術スタック |
| P7 | リサーチ | 情報収集文脈 |

## スキル作成コマンド

```bash
# 1. ディレクトリ作成
mkdir -p ~/skills/skills/<name>

# 2. SKILL.md を作成（このスキルが設計を提供）

# 3. バリデーション
node ~/skills/scripts/validate-skills.js

# 4. vcontextへ登録
node -e "
const http = require('http');
const skill = {
  name: '<name>',
  description: '<description>',
  route_keywords: ['keyword1', 'keyword2'],
  priority: 'P<n>',
  origin: 'unified',
  registered_at: new Date().toISOString()
};
const payload = JSON.stringify({
  type: 'skill-registry',
  content: JSON.stringify(skill),
  tags: ['skill-registry', 'skill:' + skill.name, 'priority:' + skill.priority],
  session: 'skill-deploy'
});
const opts = {host:'127.0.0.1',port:3150,path:'/store',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}};
http.request(opts, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('✓',JSON.parse(d).stored?.id))}).end(payload);
"

# 5. ルーティングテーブル更新
# ~/skills/skills/infinite-skills/SKILL.md の P<n> 行に追加

# 6. ビルド・デプロイ
node ~/skills/scripts/build-claude-skills.js

# 7. git commit
cd ~/skills && git add skills/<name>/SKILL.md skills/infinite-skills/SKILL.md
git commit -m "feat: add <name> skill"
```

## スキル品質チェックリスト

```
□ description に Use when <trigger> が含まれる
□ Workflow は 3-7 ステップ
□ コードブロックに実際のコマンド/コードがある
□ Gotchas に既知の落とし穴が最低1つある
□ origin: unified (共有) or local (プロジェクト固有)
□ validate-skills.js がエラーなし
□ vcontext登録済み
□ infinite-skillsルーティング更新済み
```

## AIOS統合（aios-skill-bridgeと連携）

スキルをAIOSのBaseToolとして公開する場合:

```python
# aios/tools/skills_tool.py に追加
# → aios-skill-bridge スキルを参照
```

## Workflow

1. ユーザーの要件を聞く（何をしたいか、いつ使うか）
2. 優先度・トリガーキーワードを決定
3. SKILL.mdをフォーマットに従って生成
4. `validate-skills.js` でエラーがないか確認
5. vcontextに `skill-registry` エントリとして登録
6. `infinite-skills/SKILL.md` のルーティングを更新
7. `build-claude-skills.js` でデプロイ
8. git commit

## Gotchas

- スキル名はケバブケース必須 — `validate-skills.js` がチェック
- descriptionの `Use when` フレーズは必須 — ルーター判定に使われる
- P0-P1スキルはスタッカブル — 他のスキルと同時に有効になる設計
- vcontext未登録でもファイルベースで動作するが意味検索に引っかからない
- ルーティングキーワードは日本語・英語両方入れると検索精度が上がる
