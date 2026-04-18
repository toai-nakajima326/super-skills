#!/usr/bin/env node
/**
 * skill-query-generator.cjs
 *
 * past skill-usage / skill-gap / skill-suggestion を vcontext から読み取り、
 * MLX (Qwen3-8B) または Claude API で「今不足している分野」を分析し、
 * 次の self-evolve サイクル向けの検索クエリを動的生成する。
 *
 * 生成されたクエリは vcontext に type='discovery-query' で保存され、
 * self-evolve の Phase(a) Step1 で固定クエリと組み合わせて使用される。
 *
 * 使用方法:
 *   node scripts/skill-query-generator.cjs
 *   node scripts/skill-query-generator.cjs --dry-run  # vcontextに保存しない
 */

'use strict';

const http = require('http');

const VCONTEXT = 'http://127.0.0.1:3150';
const MLX_URL  = 'http://127.0.0.1:3162/v1/chat/completions';
const DRY_RUN  = process.argv.includes('--dry-run');

// ── vcontext ヘルパー ────────────────────────────

function vcGet(path) {
  return new Promise((res, rej) => {
    http.get(`${VCONTEXT}${path}`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({ results: [] }); } });
    }).on('error', rej);
  });
}

function vcPost(payload) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(payload);
    const opts = {
      host: '127.0.0.1', port: 3150, path: '/store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } });
    });
    req.on('error', rej);
    req.end(body);
  });
}

// ── LLM 呼び出し (MLX → Claude フォールバック) ───

async function callLLM(prompt) {
  // まず MLX ローカルを試行
  try {
    const body = JSON.stringify({
      model: 'mlx-community/Qwen3-8B-4bit',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.3
    });
    const result = await new Promise((res, rej) => {
      const opts = {
        host: '127.0.0.1', port: 3162, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000
      };
      const req = http.request(opts, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch { rej(new Error('parse error')); } });
      });
      req.on('error', rej);
      req.on('timeout', () => { req.destroy(); rej(new Error('MLX timeout')); });
      req.end(body);
    });
    const text = result?.choices?.[0]?.message?.content;
    if (text) { console.log('[query-gen] used MLX Qwen3-8B'); return text; }
  } catch (e) {
    console.warn('[query-gen] MLX unavailable:', e.message, '— falling back to Claude API');
  }

  // Claude API フォールバック
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set and MLX unavailable');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((res, rej) => {
    const opts = {
      host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = require('https').request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          res(parsed.content?.[0]?.text || '');
        } catch { rej(new Error('Claude API parse error')); }
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}

// ── データ収集 ───────────────────────────────────

async function collectContext() {
  const [usageData, gapData, suggestionData, existingSkillsData, recentPatchData] =
    await Promise.all([
      vcGet('/recall?type=skill-usage&limit=100'),
      vcGet('/recall?type=skill-gap&limit=30'),
      vcGet('/recall?type=skill-suggestion&limit=30'),
      vcGet('/recall?type=skill-registry&limit=100'),
      vcGet('/recall?type=pending-patch&limit=20'),
    ]);

  // スキル使用頻度集計
  const usageCounts = {};
  for (const r of usageData.results || []) {
    try {
      const c = JSON.parse(r.content);
      usageCounts[c.skill] = (usageCounts[c.skill] || 0) + 1;
    } catch {}
  }

  // 未解決のスキルギャップ
  const gaps = (gapData.results || []).map(r => {
    try { return JSON.parse(r.content); } catch { return null; }
  }).filter(Boolean);

  // スキル提案
  const suggestions = (suggestionData.results || []).map(r => {
    try { return JSON.parse(r.content); } catch { return null; }
  }).filter(Boolean);

  // 既存スキル名一覧
  const existingSkills = (existingSkillsData.results || []).map(r => {
    try { return JSON.parse(r.content).name; } catch { return null; }
  }).filter(Boolean);

  // 最近承認待ちのスキル（重複回避）
  const pendingSkills = (recentPatchData.results || []).map(r => {
    try {
      const c = JSON.parse(r.content);
      return c.target_path?.split('/')[1];
    } catch { return null; }
  }).filter(Boolean);

  return { usageCounts, gaps, suggestions, existingSkills, pendingSkills };
}

// ── プロンプト生成 ────────────────────────────────

function buildPrompt(ctx) {
  const topUsed = Object.entries(ctx.usageCounts)
    .sort(([,a],[,b]) => b-a).slice(0, 10)
    .map(([k,v]) => `  - ${k}: ${v}回`).join('\n');

  const gapSummary = ctx.gaps.slice(0, 10)
    .map(g => `  - ${g.suggested_skill || g.gap || JSON.stringify(g).slice(0,80)}`).join('\n');

  const suggSummary = ctx.suggestions.slice(0, 10)
    .map(s => `  - ${s.suggested_skill}: ${s.reason?.slice(0,60) || ''}`).join('\n');

  return `あなたはAIエージェントシステムのスキルライブラリを管理しています。
以下のデータを分析し、次回のWeb検索サイクルで使うべき検索クエリを生成してください。

## 現在よく使われているスキル（上位10件）
${topUsed || '  （データなし）'}

## 未解決のスキルギャップ（エージェントが失敗した時に記録）
${gapSummary || '  （データなし）'}

## エージェントからのスキル提案
${suggSummary || '  （データなし）'}

## 既存スキル一覧（重複を避けること）
${ctx.existingSkills.slice(0,30).join(', ')}

## 指示
上記を分析し、「現在不足している・今後必要になりそうな」スキルを発見するための
Web検索クエリを**10件**生成してください。

条件:
1. 既存スキルと重複しない新しい分野を狙う
2. 以下のカテゴリから**各2件以上**カバーすること（合計20件以上）:
   - 日本語技術記事 (Zenn/Qiita/dev.classmethod.jp)
   - 英語技術記事/チュートリアル (dev.to/Medium/HackerNews)
   - 学術論文 (arXiv/Semantic Scholar/Papers with Code)
   - GitHub リポジトリ・トレンド
   - パッケージ・ライブラリ (npm/PyPI)
   - コミュニティ (Reddit r/LocalLLaMA / r/MachineLearning)
3. 「2026」などの年号を含め最新情報を狙う
4. ギャップデータがあればそれを優先的にクエリ化する
5. 制限なし — 発見の可能性があるならどんな視点のクエリも歓迎

出力形式（JSONのみ、説明不要）:
{
  "queries": [
    {"query": "...", "lang": "ja|en", "category": "papers|github|community|blog|packages", "rationale": "なぜこのクエリか1行で"},
    ...
  ],
  "analysis_summary": "不足分野を2-3文で説明"
}`;
}

// ── メイン ───────────────────────────────────────

async function main() {
  console.log('[query-gen] collecting context from vcontext...');
  const ctx = await collectContext();

  console.log(`[query-gen] usage=${Object.keys(ctx.usageCounts).length} gaps=${ctx.gaps.length} suggestions=${ctx.suggestions.length} existing=${ctx.existingSkills.length}`);

  const prompt = buildPrompt(ctx);

  console.log('[query-gen] calling LLM...');
  const rawResponse = await callLLM(prompt);

  // JSON 部分を抽出
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[query-gen] LLM did not return valid JSON:', rawResponse.slice(0,200));
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[query-gen] JSON parse error:', e.message);
    process.exit(1);
  }

  const queries = result.queries || [];
  const summary = result.analysis_summary || '';

  console.log(`\n[query-gen] generated ${queries.length} queries`);
  console.log(`[query-gen] analysis: ${summary}\n`);

  queries.forEach((q, i) => {
    console.log(`  ${i+1}. [${q.lang}][${q.category || 'general'}] ${q.query}`);
    console.log(`     → ${q.rationale}`);
  });

  if (DRY_RUN) {
    console.log('\n[query-gen] dry-run: not saving to vcontext');
    return;
  }

  // vcontext に discovery-query として保存
  const cycleId = `${new Date().getFullYear()}-${String(Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 604800000)).padStart(2,'0')}`;

  const saved = [];
  for (const q of queries) {
    const r = await vcPost({
      type: 'discovery-query',
      content: JSON.stringify({
        query: q.query,
        lang: q.lang,
        category: q.category || 'general',
        rationale: q.rationale,
        cycle_id: cycleId,
        generated_at: new Date().toISOString(),
        source: 'skill-query-generator',
        analysis_summary: summary
      }),
      tags: ['discovery-query', `cycle:${cycleId}`, `lang:${q.lang}`, `cat:${q.category || 'general'}`, 'auto-generated'],
      session: 'skill-discovery'
    });
    saved.push(r.stored?.id);
  }

  // 分析サマリーも保存
  await vcPost({
    type: 'skill-gap-analysis',
    content: JSON.stringify({
      cycle_id: cycleId,
      analysis: summary,
      query_count: queries.length,
      input: {
        usage_skills: Object.keys(ctx.usageCounts).length,
        gaps: ctx.gaps.length,
        suggestions: ctx.suggestions.length
      },
      generated_at: new Date().toISOString()
    }),
    tags: ['skill-gap-analysis', `cycle:${cycleId}`],
    session: 'skill-discovery'
  });

  console.log(`\n[query-gen] saved ${saved.length} queries to vcontext (ids: ${saved.join(', ')})`);
  console.log('[query-gen] self-evolve will use these in next Phase(a) Step1 via Stream 5');
}

main().catch(err => {
  console.error('[query-gen] FATAL:', err.message);
  process.exit(1);
});
