---
name: skill-discovery
description: |
  最新のAI/開発トレンドをWeb検索・GitHub・論文から収集し、
  現在のスキルライブラリのギャップを特定して新スキルを自動生成するワークフロー。
  self-evolveの「アップストリーム同期」を「Web発見」に拡張したもの。
  Use when you want to generate new skills from the latest AI research,
  trending tools, GitHub patterns, or new frameworks discovered on the web.
origin: unified
---

# Skill Discovery

## 概念

```
Web/GitHub/論文 → トレンド収集 → ギャップ分析 → SKILL.md生成 → 検証・デプロイ
```

`self-evolve` が「既存スキルの更新」なら、  
`skill-discovery` は「**新スキルの発見と創造**」。

## フェーズ1: 最新情報の収集

```bash
# 検索ターゲット例
TOPICS=(
  "AI agent patterns 2025"
  "LLM orchestration framework"
  "MCP server best practices"
  "agentic workflow tools"
  "Claude agent SDK patterns"
  "AIOS multiagent"
  "vibe coding tools 2025"
)

# Exa検索で最新パターンを収集
# (exa-searchスキルと連携)
```

```javascript
// scripts/skill-discovery-fetch.js
const { Exa } = require('exa-js');
const exa = new Exa(process.env.EXA_API_KEY);

async function fetchTrends(topics, afterDate) {
  const results = [];
  for (const topic of topics) {
    const res = await exa.searchAndContents(topic, {
      numResults: 5,
      startPublishedDate: afterDate,  // 例: '2025-01-01'
      useAutoprompt: true,
      type: 'neural',
      highlights: { numSentences: 3 }
    });
    results.push(...res.results.map(r => ({
      topic,
      title: r.title,
      url: r.url,
      summary: r.highlights?.join(' ') || r.text?.slice(0, 300),
      published: r.publishedDate
    })));
  }
  return results;
}
```

## フェーズ2: ギャップ分析

```javascript
// 既存スキルを取得してギャップを特定
async function analyzeGaps(discoveries) {
  // 現在のスキル一覧
  const existingSkills = await fetch('http://127.0.0.1:3150/recall?q=skill-registry&limit=100&type=skill-registry')
    .then(r => r.json())
    .then(d => d.results.map(e => {
      try { return JSON.parse(e.content).name; } catch { return null; }
    }).filter(Boolean));

  console.log(`既存スキル: ${existingSkills.length}件`);
  console.log(`発見情報: ${discoveries.length}件`);

  // MLXでギャップを判定（no_think不可 — 推論が必要）
  const prompt = `
以下の既存スキル一覧と最新の発見情報を比較して、
まだスキル化されていない重要なパターンを3-5個リストアップしてください。

既存スキル:
${existingSkills.join(', ')}

最新発見:
${discoveries.slice(0, 10).map(d => `- ${d.title}: ${d.summary}`).join('\n')}

出力形式:
1. スキル名候補: 説明 (ソース: URL)
`;
  
  // LLMルーターでモデル選択 → aios-llm-routerと連携
  return prompt; // LLMに渡す
}
```

## フェーズ3: SKILL.md自動生成

```javascript
// ギャップ分析結果からSKILL.mdを生成
async function generateSkillMd(skillCandidate, sourceUrls) {
  const prompt = `
次のスキルのSKILL.mdを作成してください。

スキル名: ${skillCandidate.name}
説明: ${skillCandidate.description}
参考ソース: ${sourceUrls.join(', ')}

要件:
- ~/skills/skills/ フォーマットに従う
- frontmatter: name, description(Use when含む), origin: unified
- Workflow: 3-7ステップ
- コードブロック: 実際に動くコード
- Gotchas: 既知の落とし穴
- 優先度: P0-P7から適切なものを選ぶ
`;

  // aios-llm-router: complexity=high → claude-opus
  const result = await callLLM({ task: 'skill-create', complexity: 'high' }, prompt);
  return result;
}
```

## フェーズ4: バリデーション・デプロイ

```bash
# 生成されたSKILL.mdを検証してデプロイ
function deploy_generated_skill() {
  local name="$1"
  local content="$2"

  # ファイル作成
  mkdir -p ~/skills/skills/$name
  echo "$content" > ~/skills/skills/$name/SKILL.md

  # バリデーション
  cd ~/skills && node scripts/validate-skills.js 2>&1 | grep -E "(OK|ERROR): $name"

  # vcontext登録 (skill-creatorのコマンドを使用)
  # ルーティング更新
  # ビルド・コミット
}
```

## 自動実行スケジュール

```bash
# weekly_skill_discovery.sh — 毎週月曜 09:00 に実行
# (self-evolveのスケジュールに組み込む)

LAST_RUN=$(cat ~/.skills-discovery-last-run 2>/dev/null || echo "2025-01-01")
TODAY=$(date +%Y-%m-%d)

echo "=== Skill Discovery: $TODAY ==="
echo "前回実行: $LAST_RUN"

node ~/skills/scripts/skill-discovery-fetch.js --after="$LAST_RUN" \
  | node ~/skills/scripts/skill-gap-analysis.js \
  | node ~/skills/scripts/skill-generator.js \
  | bash  # deploy commands

echo "$TODAY" > ~/.skills-discovery-last-run
```

## 発見ソース一覧

| ソース | 検索方法 | 対象 |
|--------|---------|------|
| Exa neural search | `exa-search`スキル | AI/dev記事 |
| GitHub Trending | `curl github.com/trending` | 新ライブラリ |
| arXiv | Exa + site:arxiv.org | 論文パターン |
| Hacker News | Exa + site:news.ycombinator.com | コミュニティ発見 |
| Claude/Anthropic changelog | Exa + site:anthropic.com | モデル変更 |
| takurot/super-skills | `git fetch upstream` | コミュニティスキル |

## 手動実行（今すぐ発見）

```bash
# 特定トピックから即座にスキル候補を生成
cd ~/skills
node -e "
const topics = process.argv.slice(1);
// fetchTrends → analyzeGaps → generateSkillMd を実行
" -- 'MCP server patterns 2025' 'Claude agent hooks'
```

## Workflow

1. 収集対象トピックを定義（初回は汎用、以降は前回との差分）
2. `exa-search` で最新記事・GitHub・論文を取得（`afterDate`で絞り込み）
3. vcontextの`skill-registry`と比較してギャップを特定
4. `aios-llm-router` 経由で claude-opus に SKILL.md 生成を依頼
5. `validate-skills.js` でフォーマット検証
6. `skill-creator` のデプロイ手順で vcontext登録・routing更新・commit
7. 次回実行用に `last_run` タイムスタンプを更新

## Gotchas

- LLM生成SKILL.mdは必ず人間レビューを挟む — 誤った手順が自動デプロイされると危険
- Exa APIキー必須 — `EXA_API_KEY`環境変数 or `~/.env`
- ギャップ分析は週1回で十分 — 毎日実行するとノイズが多い
- 生成スキルは `origin: discovered` タグを付けて手動作成と区別する
- 類似スキルが既存にある場合はマージを検討 — スキル数が増えすぎると管理コスト増
