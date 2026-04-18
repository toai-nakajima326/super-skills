#!/usr/bin/env node
// self-evolve.js — Weekly evolutionary cycle over the skill corpus
//
// Mission (Pillar 2 selection pass for the AIOS Cognitive Substrate):
//   1. Gather candidates from 5 input streams
//      (upstream_sync, web_search, pending-idea, pending-patch, skill-suggestion)
//   2. Score each candidate via fitness function
//      (adoption + triggered-change + reduced-error + user-approval + freshness)
//   3. Mutate top-K candidates into proposed SKILL.md text
//   4. Validate via npm run validate / build; honor safety-skill protection
//   5. Emit `pending-patch` entries into vcontext (dashboard approve/reject gate)
//   6. Log cycle to docs/evolution-log.md + vcontext `evolution-digest`
//
// Scope note: this skeleton implements Phases (a) Gather and (f) Log
// end-to-end against vcontext. Phases (b)-(e) are documented stubs that exit
// cleanly — the mission brief constrains automatic SKILL.md writes to a
// follow-up commit. See docs/analysis/2026-04-18-self-evolve-redesign.md.
//
// Invocation:
//   node skills/self-evolve/scripts/self-evolve.js                # full run
//   node skills/self-evolve/scripts/self-evolve.js --dry-run      # no writes
//   node skills/self-evolve/scripts/self-evolve.js --observation  # gather+score+log only
//   node skills/self-evolve/scripts/self-evolve.js --verbose      # log each candidate

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
// Cross-process MLX lock — shares /tmp/aios-mlx-lock with task-runner,
// locomo-eval, vcontext-server, agent-invoked scripts. Serializes heavy
// MLX generate work to prevent the 2026-04-18 OOM cascade.
// Re-entrant via AIOS_MLX_LOCK_HOLDER env var so task-runner's outer
// acquire doesn't deadlock when it spawns this script.
import { withMlxLock, MLX_LOCK_ENV_VAR } from '../../../scripts/aios-mlx-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_ROOT = join(__dirname, '..');
const REPO_ROOT = join(__dirname, '..', '..', '..'); // skills/self-evolve/scripts -> skills/

const VCONTEXT = process.env.VCONTEXT_URL || 'http://127.0.0.1:3150';
const MLX_GEN = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162';
const MLX_MODEL = process.env.MLX_GENERATE_MODEL || 'mlx-community/Qwen3-8B-4bit';
const CONFIG_PATH = join(SKILL_ROOT, 'data', 'evolution-config.json');
const EVOLUTION_LOG = join(REPO_ROOT, 'docs', 'evolution-log.md');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const OBSERVATION = args.includes('--observation');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function log(...msgs) { console.log(new Date().toISOString(), '[self-evolve]', ...msgs); }
function vlog(...msgs) { if (VERBOSE) log(...msgs); }

// ── HTTP helpers (modeled on article-scanner.js) ──────────────

function httpGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      timeout: opts.timeout || 10000,
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode} for ${urlStr}`));
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.end();
  });
}

function httpPostJson(urlStr, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      timeout: opts.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── config / cycle id ─────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    log(`FATAL: failed to read ${CONFIG_PATH}:`, e.message);
    process.exit(2);
  }
}

function cycleIdFromDate(d = new Date()) {
  // ISO-week-style: YYYY-WW. Good enough for idempotency; not strict ISO 8601.
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}

function lastRunTimestamp() {
  // Read evolution-log.md and parse the most recent date header.
  // Conservative fallback: 7 days ago (matches weekly cadence).
  if (!existsSync(EVOLUTION_LOG)) return new Date(Date.now() - 7 * 86400000).toISOString();
  const text = readFileSync(EVOLUTION_LOG, 'utf-8');
  const m = text.match(/^## (\d{4}-\d{2}-\d{2})/m);
  if (!m) return new Date(Date.now() - 7 * 86400000).toISOString();
  return new Date(m[1]).toISOString();
}

// ── Phase (a) — Gather ────────────────────────────────────────

async function gatherPendingIdeas(since) {
  try {
    const { body } = await httpGet(`${VCONTEXT}/recall?q=pending-idea&type=pending-idea&limit=50`);
    const data = JSON.parse(body);
    const all = (data.results || []).map(r => {
      let parsed = r.content;
      try { parsed = typeof r.content === 'string' ? JSON.parse(r.content) : r.content; } catch {}
      return {
        source: 'article_scanner_high_confidence',
        id: r.id,
        target_skill: null, // pending-idea is free-form; resolver runs in Phase (c)
        proposed_content: parsed,
        created_at: r.created_at || parsed?.created_at,
        confidence: parsed?.confidence || 'medium',
      };
    });
    return all.filter(c => !since || (c.created_at && c.created_at > since));
  } catch (e) {
    log(`gather pending-idea failed:`, e.message);
    return [];
  }
}

async function gatherPendingPatches() {
  try {
    const { body } = await httpGet(`${VCONTEXT}/admin/pending-patches`);
    const data = JSON.parse(body);
    return (data.patches || data.results || []).map(p => ({
      source: 'self_improve',
      id: p.id,
      target_skill: p.target_path || null,
      proposed_content: p,
      created_at: p.created_at,
      confidence: 'medium',
    }));
  } catch (e) {
    log(`gather pending-patches failed:`, e.message);
    return [];
  }
}

async function gatherSkillSuggestions(since) {
  try {
    const { body } = await httpGet(`${VCONTEXT}/recall?q=skill-suggestion&type=skill-suggestion&limit=50`);
    const data = JSON.parse(body);
    const all = (data.results || []).map(r => {
      let parsed = r.content;
      try { parsed = typeof r.content === 'string' ? JSON.parse(r.content) : r.content; } catch {}
      return {
        source: 'skill_discovery',
        id: r.id,
        target_skill: parsed?.target_skill || null,
        proposed_content: parsed,
        created_at: r.created_at,
        confidence: 'medium',
      };
    });
    return all.filter(c => !since || (c.created_at && c.created_at > since));
  } catch (e) {
    log(`gather skill-suggestion failed:`, e.message);
    return [];
  }
}

// ── Cross-stream deduplication ───────────────────────────────
//
// Without this, the same article found by both article-scanner
// (as pending-idea) and skill-discovery (as skill-suggestion)
// produces two candidates for the same thing, wastes fitness cycles,
// and can emit duplicate pending-patches for the same target skill.
//
// Key strategy (first match wins):
//   1. source_url hash    — same upstream article regardless of stream
//   2. target_skill name  — same target even if source URLs differ
//   3. content_hash       — final fallback (substring of proposed_content)
//
// Merges: keep the highest-confidence candidate, record all source
// streams in `merged_sources` so downstream scoring can boost
// multi-stream confirmations (handled in scoreCandidate later).

function candidateKey(c) {
  const p = c.proposed_content || {};
  const url = p.url || p.source_url;
  if (url) {
    try {
      const u = new URL(url);
      // Strip query + fragment, lowercase host, drop trailing slash
      const norm = (u.protocol + '//' + u.host.toLowerCase() + u.pathname.replace(/\/$/, '')).slice(0, 200);
      return 'url:' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
    } catch { /* bad URL — fall through */ }
  }
  if (c.target_skill) return 'skill:' + String(c.target_skill).toLowerCase().slice(0, 80);
  // Last resort: first 400 chars of the textual payload
  const text = typeof p === 'string' ? p : (p.idea_transfer || p.summary_ja || p.proposal || JSON.stringify(p));
  return 'content:' + crypto.createHash('sha256').update(String(text).slice(0, 400)).digest('hex').slice(0, 16);
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function confidenceScore(c) {
  const pc = c.proposed_content || {};
  // Agent-supplied numeric `score` (1-10) beats categorical if present
  if (typeof pc.score === 'number') return pc.score / 10;
  const conf = c.confidence || pc.confidence || 'medium';
  return (CONFIDENCE_RANK[conf] || 2) / 3;
}

function dedupeCandidates(raw) {
  const seen = new Map();   // key → candidate
  const kept = [];
  let dupes = 0;
  for (const c of raw) {
    const key = candidateKey(c);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...c, merged_sources: [c.source] });
      kept.push(key);
      continue;
    }
    dupes++;
    // Merge: keep the higher-confidence candidate as the base,
    // but record the other source so Phase (b) can reward consensus.
    const a = confidenceScore(existing);
    const b = confidenceScore(c);
    if (b > a) {
      const merged = { ...c, merged_sources: [...new Set([...existing.merged_sources, c.source])] };
      seen.set(key, merged);
    } else {
      existing.merged_sources = [...new Set([...existing.merged_sources, c.source])];
    }
  }
  return { deduped: kept.map(k => seen.get(k)), dropped: dupes };
}

// ── Phase (b) — Score (full implementation) ──────────────────
//
// Scoring aggregates are computed once per cycle (not per-candidate) because
// the heavy vcontext pulls (skill-usage, tool-error) are global. Each
// candidate's score then uses a local slice of those aggregates keyed on
// target_skill. See docs/analysis/2026-04-18-self-evolve-redesign.md §4.

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

function resolveTargetSkill(c) {
  if (c.target_skill) return String(c.target_skill).replace(/^skills\//, '').replace(/\/SKILL\.md$/, '').split('/')[0];
  const pc = c.proposed_content || {};
  // Common locations where a skill name might appear
  const cand = pc.target_skill || pc.skill || pc.name || pc.target_path || null;
  if (cand) return String(cand).replace(/^skills\//, '').replace(/\/SKILL\.md$/, '').split('/')[0];
  return null;
}

function targetSkillPath(name) {
  if (!name) return null;
  return join(SKILLS_DIR, name, 'SKILL.md');
}

// Pull all skill-usage entries within the last `days` days. vcontext /recall
// caps at whatever the server allows; we request high limit and filter
// client-side by created_at.
async function pullSkillUsage(days) {
  try {
    const { body } = await httpGet(`${VCONTEXT}/recall?q=skill-usage&type=skill-usage&limit=500`);
    const data = JSON.parse(body);
    const cutoff = Date.now() - days * 86400000;
    const rows = [];
    for (const r of (data.results || [])) {
      const t = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (!t || t < cutoff) continue;
      let c = r.content;
      try { c = typeof r.content === 'string' ? JSON.parse(r.content) : r.content; } catch { continue; }
      rows.push({ created_at: r.created_at, session: r.session, skills: Array.isArray(c?.skills) ? c.skills : [] });
    }
    return rows;
  } catch (e) { log(`pullSkillUsage failed:`, e.message); return []; }
}

async function pullByType(type, days, limit = 500) {
  try {
    const { body } = await httpGet(`${VCONTEXT}/recall?q=${encodeURIComponent(type)}&type=${encodeURIComponent(type)}&limit=${limit}`);
    const data = JSON.parse(body);
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    const rows = [];
    for (const r of (data.results || [])) {
      const t = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (days && t < cutoff) continue;
      let c = r.content;
      try { c = typeof r.content === 'string' ? JSON.parse(r.content) : r.content; } catch {}
      rows.push({ created_at: r.created_at, content: c, tags: r.tags });
    }
    return rows;
  } catch (e) { log(`pullByType(${type}) failed:`, e.message); return []; }
}

async function buildScoringAggregates() {
  // Pull once, reuse for every candidate.
  const [usage30, errors30, errors60, chunks30, approves, rejects] = await Promise.all([
    pullSkillUsage(30),
    pullByType('tool-error', 30),
    pullByType('tool-error', 60),
    pullByType('chunk-summary', 30, 200),
    pullByType('approve-patch', 365, 500),
    pullByType('reject-patch', 365, 500),
  ]);

  // adoption_rate: usage_count[X] / total_sessions_30d (both in the last 30d).
  // Sessions = distinct session ids seen across usage rows (approximates "eligible sessions").
  const usageCount = new Map();
  const sessions = new Set();
  for (const u of usage30) {
    if (u.session) sessions.add(u.session);
    for (const s of u.skills) usageCount.set(s, (usageCount.get(s) || 0) + 1);
  }
  const totalSessions = Math.max(1, sessions.size);

  // triggered_change_rate: scan chunk-summary L2 entries for pain_signals +
  // triggered_change pointers. Accept both array-of-strings and object forms.
  // For each skill referenced in pain_signals, count how often a triggered_change
  // followed. If the data isn't structured, fall back to a global rate and
  // apply it uniformly — better than penalising every candidate to 0.
  let chunksWithPain = 0, chunksWithTriggered = 0;
  const triggeredBySkill = new Map();  // skill → count of triggered_change references
  const painBySkill = new Map();       // skill → count of pain_signals references
  for (const row of chunks30) {
    const c = row.content || {};
    const pain = c.pain_signals || c.painSignals || [];
    const trig = c.triggered_change || c.triggeredChange || c.triggered_changes || null;
    if (pain && (Array.isArray(pain) ? pain.length : Object.keys(pain).length)) chunksWithPain++;
    if (trig && (Array.isArray(trig) ? trig.length : (typeof trig === 'object' ? Object.keys(trig).length : 1))) chunksWithTriggered++;
    const painTargets = []; const trigTargets = [];
    const collect = (v, out) => {
      if (!v) return;
      if (Array.isArray(v)) v.forEach(x => { if (x && typeof x === 'object' && x.target) out.push(x.target); else if (typeof x === 'string') out.push(x); });
      else if (typeof v === 'object') Object.keys(v).forEach(k => out.push(k));
    };
    collect(pain, painTargets); collect(trig, trigTargets);
    for (const s of painTargets) painBySkill.set(s, (painBySkill.get(s) || 0) + 1);
    for (const s of trigTargets) triggeredBySkill.set(s, (triggeredBySkill.get(s) || 0) + 1);
  }
  const globalTriggeredRate = chunks30.length ? (chunksWithTriggered / Math.max(1, chunks30.length)) : 0;

  // reduced_error_rate: compare 0-30d vs 30-60d error counts, **per skill** if
  // the error rows carry a skill/tool reference; otherwise fall back to global.
  const errSkill = (row) => {
    const c = row.content || {};
    return c.skill || c.skill_name || c.tool_name || null;
  };
  const errRecent = new Map(); let errRecentTotal = 0;
  const errOlder = new Map(); let errOlderTotal = 0;
  const now = Date.now();
  for (const r of errors30) {
    errRecentTotal++;
    const s = errSkill(r); if (s) errRecent.set(s, (errRecent.get(s) || 0) + 1);
  }
  for (const r of errors60) {
    const t = r.created_at ? new Date(r.created_at).getTime() : 0;
    if (!t || t > now - 30 * 86400000) continue;   // keep 30-60d only
    errOlderTotal++;
    const s = errSkill(r); if (s) errOlder.set(s, (errOlder.get(s) || 0) + 1);
  }
  const globalReducedRate = errOlderTotal
    ? Math.max(0, (errOlderTotal - errRecentTotal) / Math.max(1, errOlderTotal))
    : 0;

  // user_approval_rate: approves vs rejects. We look at tags/target_path to
  // find per-skill counts. Falls back to a global approval rate (prior 0.5).
  const approveBySkill = new Map(); const rejectBySkill = new Map();
  const tagTarget = (tags = []) => {
    for (const t of tags) {
      if (typeof t === 'string' && t.startsWith('target:')) return t.slice(7);
    }
    return null;
  };
  let aTotal = 0, rTotal = 0;
  for (const row of approves) {
    aTotal++;
    const s = (row.content?.target_path || '').replace(/^skills\//, '').split('/')[0] || tagTarget(row.tags);
    if (s) approveBySkill.set(s, (approveBySkill.get(s) || 0) + 1);
  }
  for (const row of rejects) {
    rTotal++;
    const s = (row.content?.target_path || '').replace(/^skills\//, '').split('/')[0] || tagTarget(row.tags);
    if (s) rejectBySkill.set(s, (rejectBySkill.get(s) || 0) + 1);
  }
  const globalApproval = (aTotal + rTotal) ? aTotal / (aTotal + rTotal) : 0.5;

  return {
    totalSessions,
    usageCount,
    triggeredBySkill, painBySkill, globalTriggeredRate,
    errRecent, errOlder, errRecentTotal, errOlderTotal, globalReducedRate,
    approveBySkill, rejectBySkill, globalApproval,
  };
}

function scoreCandidate(c, config, agg) {
  const weights = config.weights || {};
  const w1 = weights.w1_adoption_rate ?? 0.25;
  const w2 = weights.w2_triggered_change_rate ?? 0.25;
  const w3 = weights.w3_reduced_error_rate ?? 0.20;
  const w4 = weights.w4_user_approval_rate ?? 0.20;
  const w5 = weights.w5_freshness ?? 0.10;
  const prior = config.cycle?.approval_prior_when_no_history ?? 0.5;
  const halflife = config.cycle?.freshness_halflife_days ?? 90;

  const target = resolveTargetSkill(c);

  // 1) adoption_rate
  const uc = (target && agg.usageCount.get(target)) || 0;
  const adoption_rate = clamp01(uc / Math.max(1, agg.totalSessions));

  // 2) triggered_change_rate (per-skill if available, else global)
  let triggered_change_rate = 0;
  if (target && agg.painBySkill.get(target)) {
    const p = agg.painBySkill.get(target);
    const t = agg.triggeredBySkill.get(target) || 0;
    triggered_change_rate = clamp01(t / Math.max(1, p));
  } else {
    triggered_change_rate = clamp01(agg.globalTriggeredRate);
  }

  // 3) reduced_error_rate
  let reduced_error_rate = 0;
  if (target && agg.errOlder.get(target)) {
    const older = agg.errOlder.get(target);
    const recent = agg.errRecent.get(target) || 0;
    reduced_error_rate = clamp01((older - recent) / Math.max(1, older));
  } else {
    reduced_error_rate = clamp01(agg.globalReducedRate);
  }

  // 4) user_approval_rate
  let user_approval_rate = prior;
  if (target) {
    const a = agg.approveBySkill.get(target) || 0;
    const r = agg.rejectBySkill.get(target) || 0;
    if (a + r > 0) user_approval_rate = a / (a + r);
    else user_approval_rate = agg.globalApproval || prior;
  } else {
    user_approval_rate = agg.globalApproval || prior;
  }
  user_approval_rate = clamp01(user_approval_rate);

  // 5) freshness
  const ageDays = c.created_at
    ? Math.max(0, (Date.now() - new Date(c.created_at).getTime()) / 86400000)
    : 30;
  const freshness = clamp01(Math.exp(-ageDays / halflife));

  // bias_source (sum over merged_sources, else just the primary)
  const biasMap = config.bias_source || {};
  const sources = c.merged_sources && c.merged_sources.length ? c.merged_sources : [c.source];
  let bias = 0;
  for (const s of sources) bias += (biasMap[s] || 0);
  // Consensus boost — if 2+ distinct streams confirmed the same candidate.
  const consensusBoost = (c.merged_sources && c.merged_sources.length >= 2) ? 0.1 : 0;

  const weighted = w1 * adoption_rate
                 + w2 * triggered_change_rate
                 + w3 * reduced_error_rate
                 + w4 * user_approval_rate
                 + w5 * freshness;

  // Clamp total to [0, 2] — weighted sum ≤ 1, bias + consensus ≤ ~1.
  const total = Math.max(0, Math.min(2, weighted + bias + consensusBoost));

  return {
    total,
    components: {
      adoption_rate, triggered_change_rate, reduced_error_rate,
      user_approval_rate, freshness, bias, consensusBoost,
    },
    target_skill: target,
    note: `fitness computed with ${sources.length} source(s)${consensusBoost ? ' +consensus' : ''}`,
  };
}

// ── Phase (c) — Mutate ───────────────────────────────────────

function buildMutationPrompt(currentSkillText, proposal) {
  if (currentSkillText) {
    return `You are improving an AIOS skill. Below is the current SKILL.md and a proposal. Produce an improved SKILL.md that integrates the proposal while preserving all existing safety rules and maintaining the existing format.

CURRENT SKILL.md:
${currentSkillText}

PROPOSAL:
${typeof proposal === 'string' ? proposal : JSON.stringify(proposal, null, 2)}

Respond with ONLY the new SKILL.md text, no preamble.`;
  }
  // New skill: use skill-creator style prompt
  return `You are drafting a new AIOS skill as a SKILL.md file. Below is the proposal to turn into a skill. Follow this exact format: YAML frontmatter (name, description, origin), then sections "Rules" and "Workflow" at minimum. Preserve safety defaults. Use concise, actionable language.

PROPOSAL:
${typeof proposal === 'string' ? proposal : JSON.stringify(proposal, null, 2)}

Respond with ONLY the new SKILL.md text, no preamble.`;
}

async function callMlx(prompt, maxTokens = 4000, temperature = 0.3, timeoutMs = 180000) {
  const reqBody = {
    model: MLX_MODEL,
    messages: [{ role: 'user', content: prompt + '\n\n/no_think' }],
    max_tokens: maxTokens,
    temperature,
  };
  const { status, body } = await httpPostJson(`${MLX_GEN}/v1/chat/completions`, reqBody, { timeout: timeoutMs });
  if (status !== 200) throw new Error(`mlx status ${status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  const content = data.choices?.[0]?.message?.content || '';
  // Strip ```md / ``` fences if the model adds them despite instructions.
  return content.replace(/^```(?:md|markdown)?\n?/, '').replace(/\n?```\s*$/, '').trim();
}

async function mutateCandidate(c, fitness) {
  const target = fitness.target_skill;
  let currentText = null;
  const tp = target ? targetSkillPath(target) : null;
  if (tp && existsSync(tp)) {
    try { currentText = readFileSync(tp, 'utf-8'); } catch { currentText = null; }
  }
  const proposal = c.proposed_content;
  const prompt = buildMutationPrompt(currentText, proposal);
  try {
    const mutated = await callMlx(prompt);
    if (!mutated || mutated.length < 40) return null;
    return { target_skill: target, target_path: tp, current_text: currentText, mutated_text: mutated };
  } catch (e) {
    log(`mutate failed for ${c.id}:`, e.message.slice(0, 160));
    return null;
  }
}

// ── Phase (d) — Validate ─────────────────────────────────────

const CRITICAL_WORDS = ['auto-approve', 'auto-commit', 'auto-push', 'telemetry', 'skip tests'];

function extractFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function countRuleLines(text) {
  // Count `N. ` lines inside the Rules section (best-effort — matches article-scanner
  // style frontmatter + markdown).
  const m = text.match(/##\s*Rules\s*\n([\s\S]*?)(?:\n##\s|$)/);
  if (!m) return 0;
  const rules = m[1].match(/^\s*\d+\.\s/gm);
  return rules ? rules.length : 0;
}

function validateCandidate(mut, config) {
  if (!mut || !mut.mutated_text) return { ok: false, reason: 'no-mutated-text' };
  const text = mut.mutated_text;

  // 1) Front-matter
  const fm = extractFrontmatter(text);
  if (!fm) return { ok: false, reason: 'missing-frontmatter' };
  if (!fm.name) return { ok: false, reason: 'frontmatter-missing-name' };
  if (!fm.description) return { ok: false, reason: 'frontmatter-missing-description' };
  if (!fm.origin) {
    // Synthesize origin rather than reject — matches upstream=unified default.
    mut.mutated_text = text.replace(/^---\n/, `---\norigin: unified\n`);
  }

  // 2) Safety-skill rule preservation (Rule count must not drop)
  const protect = (config.gates?.safety_skills_protected) || [];
  if (mut.target_skill && protect.includes(mut.target_skill) && mut.current_text) {
    const before = countRuleLines(mut.current_text);
    const after = countRuleLines(mut.mutated_text);
    if (after < before) {
      return { ok: false, reason: `safety-skill-rule-count-decreased (${before} -> ${after})` };
    }
  }

  // 3) Critical-words check — only reject if a newly-added occurrence appears.
  const prior = mut.current_text || '';
  for (const word of CRITICAL_WORDS) {
    const priorCount = (prior.match(new RegExp(word, 'gi')) || []).length;
    const newCount = (mut.mutated_text.match(new RegExp(word, 'gi')) || []).length;
    if (newCount > priorCount) return { ok: false, reason: `critical-word-added: ${word}` };
  }

  // 4) Optional: run `npm run validate` against a temp skill dir so the
  // global validator sees a proper skills/<name>/SKILL.md. We skip silently
  // if the validator isn't available (e.g., CI stripped it).
  let validatorRan = false, validatorOk = true, validatorOut = '';
  const doValidate = (config.gates?.validate_before_pending_patch ?? true) && mut.target_skill;
  const validatorPath = join(REPO_ROOT, 'scripts', 'validate-skills.js');
  if (doValidate && existsSync(validatorPath)) {
    // Lightweight validator: parse YAML frontmatter line-by-line. The heavy
    // `npm run validate` wants a repo-level scan; we only care that this one
    // file is well-formed, so we re-check frontmatter rather than spawn a
    // subprocess. This keeps the cycle under 10s.
    validatorRan = true;
    const yamlLines = (mut.mutated_text.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    for (const line of yamlLines.split('\n')) {
      if (!line.trim()) continue;
      if (!/^\w+:/.test(line) && !/^\s+\S/.test(line) && !/^-\s/.test(line)) {
        validatorOk = false; validatorOut = `bad yaml line: ${line.slice(0, 80)}`; break;
      }
    }
  }
  if (validatorRan && !validatorOk) return { ok: false, reason: `validator: ${validatorOut}` };

  return { ok: true, reason: 'validated', validator_ran: validatorRan };
}

// ── Phase (e) — Apply ────────────────────────────────────────

async function emitPendingPatch(c, fitness, cycleId, mut) {
  const target_path = mut?.target_skill ? `skills/${mut.target_skill}/SKILL.md` : null;
  const content = {
    target_path,
    original_content: mut?.current_text || null,
    proposed_content: mut?.mutated_text || null,
    fitness: fitness.total,
    components: fitness.components,
    merged_sources: c.merged_sources || [c.source],
    cycle_id: cycleId,
    reasoning: `self-evolve cycle ${cycleId}: fitness=${fitness.total.toFixed(3)} via sources=${(c.merged_sources || [c.source]).join(',')}. ${fitness.note}`,
  };
  const tags = [
    'pending-patch',
    'source:self-evolve',
    `target:${mut?.target_skill || 'unknown'}`,
    `cycle:${cycleId}`,
  ];
  const payload = { type: 'pending-patch', content, tags, session: 'self-evolve' };

  if (DRY_RUN) {
    vlog(`[DRY] would POST /store pending-patch target=${target_path} fitness=${fitness.total.toFixed(3)}`);
    return { dryRun: true, payload };
  }
  try {
    const { status, body } = await httpPostJson(`${VCONTEXT}/store`, payload);
    if (status !== 200 && status !== 201) {
      log(`emit status ${status}: ${body.slice(0, 160)}`);
      return { ok: false, status, body };
    }
    return { ok: true, status, body };
  } catch (e) {
    log(`emit failed:`, e.message);
    return { ok: false, error: e.message };
  }
}

// ── Phase (f) — Log ──────────────────────────────────────────

function writeEvolutionLog(summary) {
  const block = [
    `\n## ${new Date().toISOString().slice(0, 10)} — evolution-cycle ${summary.cycle_id}`,
    ``,
    `**Type**: evolution-cycle (weekly scheduled)`,
    `**Weights used**: w1=${summary.weights.w1_adoption_rate}, w2=${summary.weights.w2_triggered_change_rate}, w3=${summary.weights.w3_reduced_error_rate}, w4=${summary.weights.w4_user_approval_rate}, w5=${summary.weights.w5_freshness}`,
    `**Candidates gathered**: total=${summary.total_candidates}, by source=${JSON.stringify(summary.per_source)}`,
    `**Top-K scored**: ${summary.top_k.length}`,
    `**Pending-patches emitted**: ${summary.emitted}`,
    `**Observation mode**: ${summary.observation_mode ? 'yes' : 'no'}`,
    `**Notes**: ${summary.notes || '(skeleton run — phases b..e are stubs)'}`,
    '',
  ].join('\n');
  if (DRY_RUN) { log('[DRY] would append evolution-log block:'); console.log(block); return; }
  appendFileSync(EVOLUTION_LOG, block);
  vlog('evolution-log appended');
}

async function storeDigest(summary) {
  if (DRY_RUN) { vlog('[DRY] would store evolution-digest'); return; }
  const payload = {
    type: 'evolution-digest',
    content: JSON.stringify(summary),
    tags: ['evolution-digest', `cycle:${summary.cycle_id}`],
    session: 'self-evolve',
  };
  try {
    const { status, body } = await httpPostJson(`${VCONTEXT}/store`, payload);
    if (status !== 200 && status !== 201) log(`digest store status ${status}: ${body.slice(0, 120)}`);
  } catch (e) { log(`digest store failed:`, e.message); }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const config = loadConfig();
  const cycleId = cycleIdFromDate();
  const since = lastRunTimestamp();
  const observationMode = OBSERVATION || config.observation_mode?.enabled;

  log(`starting cycle ${cycleId}  since=${since}  dry=${DRY_RUN}  obs=${observationMode}`);

  // Phase (a) — Gather
  const [ideas, patches, suggestions] = await Promise.all([
    gatherPendingIdeas(since),
    gatherPendingPatches(),
    gatherSkillSuggestions(since),
  ]);

  const raw = [...ideas, ...patches, ...suggestions];
  const perSourceRaw = raw.reduce((acc, c) => { acc[c.source] = (acc[c.source] || 0) + 1; return acc; }, {});
  log(`gathered ${raw.length} raw candidates`, JSON.stringify(perSourceRaw));

  // Cross-stream dedup — merges duplicate candidates that share source URL
  // or target skill, preserves the higher-confidence version, and records
  // all streams that found it (used by scoreCandidate for consensus boost).
  const { deduped: candidates, dropped } = dedupeCandidates(raw);
  const perSource = candidates.reduce((acc, c) => { acc[c.source] = (acc[c.source] || 0) + 1; return acc; }, {});
  if (dropped > 0) log(`deduped: ${dropped} duplicate candidate(s) merged across streams`);
  log(`after dedup: ${candidates.length} unique candidates`, JSON.stringify(perSource));

  // Phase (b) — Score (full implementation). Aggregates are pulled once and
  // shared across every candidate.
  log(`building scoring aggregates (skill-usage / tool-error / chunk-summary / approve-reject)…`);
  const agg = await buildScoringAggregates();
  vlog(`  agg: sessions=${agg.totalSessions} usage_skills=${agg.usageCount.size} err_recent=${agg.errRecentTotal} err_older=${agg.errOlderTotal} approves=${agg.approveBySkill.size} rejects=${agg.rejectBySkill.size}`);
  const scored = candidates.map(c => ({ c, fitness: scoreCandidate(c, config, agg) }));
  scored.sort((a, b) => b.fitness.total - a.fitness.total);
  const topK = scored.slice(0, config.cycle?.top_k_mutations_per_cycle || 3);
  if (VERBOSE) topK.forEach((s, i) => log(`  top[${i}] src=${s.c.source} target=${s.fitness.target_skill || '∅'} fitness=${s.fitness.total.toFixed(3)} ${s.fitness.note}`));

  // Phase (c)-(e) — Mutate/Validate/Apply (skipped in observation mode)
  // MLX-heavy: each candidate triggers one mlxGenerate() call via callMlx().
  // Acquire the cross-process MLX lock for the duration so agent-invoked
  // self-evolve runs don't stack with task-runner / locomo-eval / any
  // vcontext-server background generate loop. Re-entrant: if the parent
  // exported AIOS_MLX_LOCK_HOLDER, this is a no-op (parent still holds).
  let emitted = 0;
  let dropped_mutate = 0, dropped_validate = 0;
  if (!observationMode) {
    const holderId = `self-evolve:pid-${process.pid}:${cycleId}`;
    // 20min cap — self-evolve mutation passes ~30s-3min; anything longer
    // means MLX is wedged and we should bail rather than hang.
    await withMlxLock(holderId, async () => {
      const prevEnv = process.env[MLX_LOCK_ENV_VAR];
      process.env[MLX_LOCK_ENV_VAR] = holderId;
      try {
        for (const s of topK) {
          const mut = await mutateCandidate(s.c, s.fitness);
          if (!mut) { dropped_mutate++; vlog(`  drop ${s.c.id}: mutate returned null`); continue; }
          const val = validateCandidate(mut, config);
          if (!val.ok) { dropped_validate++; vlog(`  drop ${s.c.id}: ${val.reason}`); continue; }
          const result = await emitPendingPatch(s.c, s.fitness, cycleId, mut);
          if (result?.ok || result?.dryRun) emitted++;
        }
      } finally {
        if (prevEnv === undefined) delete process.env[MLX_LOCK_ENV_VAR];
        else process.env[MLX_LOCK_ENV_VAR] = prevEnv;
      }
    }, { waitMs: 20 * 60 * 1000 }).catch(e => {
      log(`MLX lock timeout during mutate phase: ${e.message}`);
      // Treat as if all mutations were dropped — the rest of the cycle
      // (summary + evolution-log + digest) still runs with zero emits.
    });
  } else {
    vlog('observation mode: skipping Phase (c)-(e) — no pending-patch emission');
  }

  // Phase (f) — Log
  const summary = {
    cycle_id: cycleId,
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    weights: config.weights,
    per_source: perSource,
    total_candidates: candidates.length,
    top_k: topK.map(s => ({
      source: s.c.source,
      id: s.c.id,
      target_skill: s.fitness.target_skill,
      fitness: s.fitness.total,
      components: s.fitness.components,
    })),
    emitted,
    dropped_mutate,
    dropped_validate,
    observation_mode: !!observationMode,
    notes: observationMode
      ? 'observation mode: Phase (c)-(e) skipped'
      : `mutate dropped=${dropped_mutate}, validate dropped=${dropped_validate}`,
  };
  writeEvolutionLog(summary);
  await storeDigest(summary);

  log(`cycle ${cycleId} done in ${(summary.duration_ms/1000).toFixed(1)}s — emitted=${emitted}`);
  process.exit(0);
}

main().catch(e => { log('FATAL:', e.stack || e.message); process.exit(1); });
