#!/usr/bin/env node
// keyword-expander.js — Monthly dynamic keyword generator
//
// Mission: prevent article-scanner and skill-discovery from getting stuck
// in a fixed-keyword neighborhood. Two modes:
//
//   Mode A (external trending) — query SearXNG for trending AI/dev
//     content over the past month, extract high-frequency salient terms
//     that are NOT already in the article-scanner's KEYWORDS list.
//
//   Mode C (internal activity) — pull chunk-summary L2 (daily summaries)
//     for the past 30 days from vcontext, ask MLX to propose 5-10 new
//     keywords that match what the user has actually been doing.
//
// Output: keyword-suggestion entries in vcontext + a JSON snapshot on
// disk at data/keyword-suggestions-YYYY-MM-DD.json. Human reviews and
// manually promotes promising ones into article-scanner.js (we do NOT
// auto-edit the hardcoded KEYWORDS array — human-in-the-loop).
//
// Schedule: com.vcontext.keyword-expander LaunchAgent, 1st of each
// month at 05:00 JST. Env:
//   VCONTEXT_URL, SEARXNG_URL, MLX_GENERATE_URL (all sane defaults)
//
// CLI:
//   node scripts/keyword-expander.js              # full run
//   node scripts/keyword-expander.js --dry-run    # no writes
//   node scripts/keyword-expander.js --mode-a     # trending only
//   node scripts/keyword-expander.js --mode-c     # LLM-suggest only
//   node scripts/keyword-expander.js --verbose

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const VCONTEXT    = process.env.VCONTEXT_URL     || 'http://127.0.0.1:3150';
const SEARXNG     = process.env.SEARXNG_URL      || 'http://127.0.0.1:8888';
const MLX_GEN     = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162';
const MLX_MODEL   = process.env.MLX_GENERATE_MODEL || 'mlx-community/Qwen3-8B-4bit';

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const VERBOSE  = args.includes('--verbose') || args.includes('-v');
const MODE_A   = args.includes('--mode-a') || !args.includes('--mode-c');
const MODE_C   = args.includes('--mode-c') || !args.includes('--mode-a');

function log(...m) { console.log(new Date().toISOString(), '[kw-expander]', ...m); }
function vlog(...m) { if (VERBOSE) log(...m); }

// ── HTTP helpers (same pattern as article-scanner) ─────────────

function httpGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      timeout: opts.timeout || 15000,
      headers: { 'User-Agent': 'AIOS-keyword-expander/1.0', ...(opts.headers || {}) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', c => { data += c; if (data.length > 2_000_000) { req.destroy(); reject(new Error('too large')); } });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function httpPostJson(urlStr, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      timeout: opts.timeout || 90000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

// ── Load existing keywords (from article-scanner) ─────────────

function loadExistingKeywords() {
  // Parse article-scanner.js for its KEYWORDS const. Naive but stable
  // against small reformatting — we only need the set for diff.
  const scannerPath = join(REPO_ROOT, 'scripts', 'article-scanner.js');
  if (!existsSync(scannerPath)) return new Set();
  const src = readFileSync(scannerPath, 'utf-8');
  const m = src.match(/const KEYWORDS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return new Set();
  const items = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]);
  return new Set(items.map(s => s.toLowerCase()));
}

// ── Mode A: external trending via SearXNG ─────────────────────

const TRENDING_QUERIES = [
  'github trending AI agent 2026',
  'arxiv recent LLM paper 2026',
  'huggingface trending model 2026',
  'claude code new pattern 2026',
  'mcp protocol 2026',
  'local LLM benchmark 2026',
  'AI observability tool 2026',
];

const STOP_WORDS = new Set([
  'the','a','an','is','are','be','and','or','of','in','on','for','to','with','by','at',
  'from','as','this','that','you','your','they','their','it','its','we','our',
  '一','つ','こと','もの','ため','よう','とき','それ','これ','ある','いる','する',
  'ai','llm','model','paper','new','best','top','2026','code','use','using',
]);

function tokenize(text, minLen = 3) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s\u3040-\u30ff\u4e00-\u9fff-]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= minLen && !STOP_WORDS.has(w));
}

function extractTopTerms(texts, topN = 30) {
  const freq = new Map();
  // single-word
  for (const t of texts) {
    for (const w of tokenize(t, 4)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  // bigrams (biased toward AI phrases like "agent skills")
  for (const t of texts) {
    const words = tokenize(t, 3);
    for (let i = 0; i < words.length - 1; i++) {
      const bg = words[i] + ' ' + words[i + 1];
      if (bg.length <= 50) freq.set(bg, (freq.get(bg) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)   // seen in 2+ search results
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term, count]) => ({ term, count }));
}

async function modeA_trending() {
  log('Mode A — scanning SearXNG for trending terms');
  const titles = [];
  for (const q of TRENDING_QUERIES) {
    try {
      const { body } = await httpGet(`${SEARXNG}/search?q=${encodeURIComponent(q)}&format=json&language=auto`, { timeout: 8000 });
      const data = JSON.parse(body);
      for (const r of (data.results || []).slice(0, 10)) {
        if (r.title) titles.push(r.title);
        if (r.content) titles.push(r.content.slice(0, 200));
      }
      vlog(`  "${q}" → ${(data.results || []).length} results`);
    } catch (e) { vlog(`  "${q}" err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
  const terms = extractTopTerms(titles);
  log(`Mode A done — ${terms.length} trending terms extracted from ${titles.length} titles+snippets`);
  return terms;
}

// ── Mode C: LLM-suggest from internal activity ────────────────

async function fetchL2Summaries(days = 30) {
  // L2 = daily chunk-summary (tagged level:2)
  try {
    const { body } = await httpGet(`${VCONTEXT}/summaries?level=2&days=${days}`, { timeout: 10000 });
    const data = JSON.parse(body);
    return (data.summaries || []).map(s => s.summary || s.content?.summary || '').filter(Boolean);
  } catch (e) {
    log(`fetchL2Summaries failed: ${e.message}`);
    return [];
  }
}

async function modeC_llmSuggest(existingKeywords) {
  log('Mode C — gathering L2 summaries + MLX keyword suggestion');
  const summaries = await fetchL2Summaries(30);
  if (summaries.length === 0) {
    log('  (no L2 summaries yet — fallback to L1 last 48h)');
    try {
      const { body } = await httpGet(`${VCONTEXT}/summaries?level=1&hours=48`, { timeout: 10000 });
      const data = JSON.parse(body);
      for (const s of (data.summaries || []).slice(0, 20)) {
        const t = s.summary || s.content?.summary;
        if (t) summaries.push(t);
      }
    } catch {}
  }
  if (summaries.length === 0) {
    log('  no summaries available; Mode C returns empty');
    return [];
  }

  const existingList = [...existingKeywords].slice(0, 50).join(', ');
  const prompt = `You are suggesting NEW search keywords for a research scanner.

EXISTING keywords already scanned daily:
${existingList}

Below are daily summaries of my actual AI/dev activity (past 30 days). Suggest 5-10 NEW keywords (in English or Japanese) that match topics I'm actively engaged with but that are NOT already covered above. Prefer specific technical terms over generic phrases.

SUMMARIES:
${summaries.slice(0, 25).join('\n---\n').slice(0, 6000)}

Respond in STRICT JSON (no markdown, no preamble):
{"suggested_keywords": ["keyword1", "keyword2", ...], "rationale": "one sentence"}
/no_think`;

  try {
    const { status, body } = await httpPostJson(`${MLX_GEN}/v1/chat/completions`, {
      model: MLX_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.4,
    }, { timeout: 120000 });
    if (status !== 200) throw new Error(`mlx status ${status}`);
    const data = JSON.parse(body);
    const content = data.choices?.[0]?.message?.content || '';
    const json = content.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('no JSON in response');
    const parsed = JSON.parse(json[0]);
    const kws = Array.isArray(parsed.suggested_keywords) ? parsed.suggested_keywords.slice(0, 15) : [];
    log(`Mode C done — ${kws.length} LLM-suggested keywords; rationale: ${parsed.rationale || 'n/a'}`);
    return kws.map(k => ({ term: String(k).slice(0, 80), count: 1, rationale: parsed.rationale }));
  } catch (e) {
    log(`Mode C failed: ${e.message}`);
    return [];
  }
}

// ── Merge + write ─────────────────────────────────────────────

function mergeNew(modeA, modeC, existing) {
  const seen = new Set([...existing].map(s => s.toLowerCase()));
  const merged = new Map();
  for (const t of modeA) {
    const k = t.term.toLowerCase();
    if (seen.has(k)) continue;
    merged.set(k, { term: t.term, count: t.count, sources: ['trending'] });
  }
  for (const t of modeC) {
    const k = t.term.toLowerCase();
    if (seen.has(k)) continue;
    const existing = merged.get(k);
    if (existing) {
      existing.sources.push('llm_suggest');
      existing.count += 1;
      existing.rationale = existing.rationale || t.rationale;
    } else {
      merged.set(k, { term: t.term, count: t.count, sources: ['llm_suggest'], rationale: t.rationale });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

async function storeSuggestionEntry(payload) {
  if (DRY_RUN) { vlog('[DRY] would store keyword-suggestion'); return; }
  try {
    const body = {
      type: 'keyword-suggestion',
      content: JSON.stringify(payload),
      tags: ['keyword-suggestion', `date:${new Date().toISOString().slice(0, 10)}`],
      session: 'keyword-expander',
    };
    const { status } = await httpPostJson(`${VCONTEXT}/store`, body);
    if (status !== 200 && status !== 201) log(`store status ${status}`);
  } catch (e) { log(`store failed: ${e.message}`); }
}

function writeSnapshot(payload) {
  const dir = join(REPO_ROOT, 'data', 'keyword-suggestions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
  if (DRY_RUN) { vlog(`[DRY] would write ${file}`); return; }
  writeFileSync(file, JSON.stringify(payload, null, 2));
  log(`wrote ${file}`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  log(`starting  mode_a=${MODE_A}  mode_c=${MODE_C}  dry=${DRY_RUN}`);

  const existing = loadExistingKeywords();
  log(`existing keywords loaded: ${existing.size}`);

  const [trending, llmSuggest] = await Promise.all([
    MODE_A ? modeA_trending() : Promise.resolve([]),
    MODE_C ? modeC_llmSuggest(existing) : Promise.resolve([]),
  ]);

  const proposed = mergeNew(trending, llmSuggest, existing);

  const payload = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    existing_count: existing.size,
    mode_a_count: trending.length,
    mode_c_count: llmSuggest.length,
    new_unique_count: proposed.length,
    new_keywords: proposed.slice(0, 30),
    notes: 'Review and promote promising keywords into scripts/article-scanner.js KEYWORDS list. Keep original as comment for history.',
  };

  log(`new unique candidates: ${proposed.length} (dropping duplicates with existing ${existing.size})`);
  if (VERBOSE || proposed.length > 0) {
    for (const p of proposed.slice(0, 15)) {
      log(`  ${p.term}  (count=${p.count} sources=${p.sources.join(',')})`);
    }
  }

  writeSnapshot(payload);
  await storeSuggestionEntry(payload);
  log(`done in ${(payload.duration_ms/1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch(e => { log('FATAL:', e.stack || e.message); process.exit(1); });
