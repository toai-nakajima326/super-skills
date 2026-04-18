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
      numResults: 20,
      startPublishedDate: afterDate,  // 例: '2025-01-01' — no result cap
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

## 発見ソース一覧（制限なし — 全ソースを網羅する）

### Tier 1: 必須（毎サイクル）
| ソース | 検索方法 | 対象 |
|--------|---------|------|
| Exa neural search | `exa-search`スキル / SearXNG | AI/dev記事、パターン |
| arXiv | Exa + site:arxiv.org | 最新論文・実装パターン |
| Papers with Code | site:paperswithcode.com | 再現実装パターン |
| Semantic Scholar | site:semanticscholar.org | 引用・関連研究 |
| Hugging Face Papers | site:huggingface.co/papers | 話題の論文 |
| GitHub Trending (全言語) | github.com/trending?since=weekly | 週間トレンドライブラリ |
| GitHub Trending (Python) | github.com/trending?l=python&since=weekly | Python新ライブラリ |
| GitHub Trending (TypeScript) | github.com/trending?l=typescript&since=weekly | TS新ライブラリ |
| Hacker News | Exa + site:news.ycombinator.com | コミュニティ実践知 |
| Zenn | site:zenn.dev | 日本語技術記事 |
| Qiita | site:qiita.com | 日本語実装記事 |
| Classmethod | site:dev.classmethod.jp | 日本語AWS/AI記事 |

### Tier 2: 優先（毎サイクル）
| ソース | 検索方法 | 対象 |
|--------|---------|------|
| Reddit r/LocalLLaMA | site:reddit.com/r/LocalLLaMA | ローカルLLM動向 |
| Reddit r/MachineLearning | site:reddit.com/r/MachineLearning | 研究動向 |
| Reddit r/ClaudeAI | site:reddit.com/r/ClaudeAI | Claude活用パターン |
| Reddit r/programming | site:reddit.com/r/programming | 汎用開発パターン |
| Lobsters | site:lobste.rs | 高品質技術記事 |
| Dev.to | site:dev.to | 実装チュートリアル |
| Medium | site:medium.com (AI/ML tag) | 解説・ユースケース |
| Anthropic Blog | site:anthropic.com/news | モデル・SDK変更 |
| Anthropic Docs changelog | docs.anthropic.com (直接確認) | API変更・新機能 |
| OpenAI Blog | site:openai.com/blog | 競合動向・パターン |

### Tier 3: 補完（必要に応じて）
| ソース | 検索方法 | 対象 |
|--------|---------|------|
| npm new packages | npmjs.com/search?q=claude+agent | 新しいJS/TSツール |
| PyPI new packages | pypi.org/search/?q=agent+llm | 新しいPythonツール |
| Product Hunt | producthunt.com (AI category) | 新サービス・ツール |
| Changelog.com | site:changelog.com AI | ポッドキャスト要約 |
| Latent Space | site:latent.space | AI Podcastまとめ |
| super-skills upstream | `git fetch upstream` | コミュニティスキル |
| YouTube (タイトルのみ) | "Claude Code" site:youtube.com | チュートリアル傾向 |
| Discord公開サーバー | Exa検索 | コミュニティ発見 |

## 深掘り戦略（制限なし）

- **リンク追跡**: 発見した記事の参照リンクを全件追跡する。リンク数・深さに制限なし。
- **GitHubリポジトリ**: README + docs/ + src/ + Issueリスト + PRコメントまで確認
- **論文**: Abstract → Full text → References → Cited-by（Semantic Scholarで確認）
- **時間制限なし**: どれだけ時間がかかっても、見落としゼロを優先する
- **複数エンジン**: SearXNG（優先）→ Exa → WebSearch の順で使い、同じクエリを複数で確認してよい
- **言語バリア不要**: 日本語・英語・中国語・スペイン語の記事も対象にする

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
- ギャップ分析頻度: self-evolveに合わせて週1回が基本だが、AIOS経由で大量のskill-gapが蓄積された場合は随時実行してよい
- 生成スキルは `origin: discovered` タグを付けて手動作成と区別する
- 類似スキルが既存にある場合はマージを検討 — スキル数が増えすぎると管理コスト増
