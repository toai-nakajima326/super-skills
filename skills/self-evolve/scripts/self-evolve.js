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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_ROOT = join(__dirname, '..');
const REPO_ROOT = join(__dirname, '..', '..', '..'); // skills/self-evolve/scripts -> skills/

const VCONTEXT = process.env.VCONTEXT_URL || 'http://127.0.0.1:3150';
const CONFIG_PATH = join(SKILL_ROOT, 'data', 'evolution-config.json');
const EVOLUTION_LOG = join(REPO_ROOT, 'docs', 'evolution-log.md');

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

// ── Phase (b)-(e) — stubs ─────────────────────────────────────

function scoreCandidate(_c, _config) {
  // STUB. Full implementation: see docs/analysis/2026-04-18-self-evolve-redesign.md section 4.
  // Minimum viable scoring here uses only freshness + bias_source.
  const bias = (_config.bias_source || {})[_c.source] || 0;
  const ageDays = _c.created_at
    ? Math.max(0, (Date.now() - new Date(_c.created_at).getTime()) / 86400000)
    : 30;
  const halflife = _config.cycle?.freshness_halflife_days || 90;
  const freshness = Math.exp(-ageDays / halflife);
  return {
    total: (_config.weights?.w5_freshness || 0.1) * freshness + bias,
    components: { adoption_rate: 0, triggered_change_rate: 0, reduced_error_rate: 0, user_approval_rate: 0.5, freshness, bias },
    note: 'stub-fitness — full scoring pending (see redesign doc section 4)',
  };
}

function mutateCandidate(_c) { return null; } // STUB — see redesign section 8 for out-of-scope note
function validateCandidate(_c) { return { ok: false, reason: 'mutate-stub' }; }
async function emitPendingPatch(_c, _fitness, _cycleId) {
  // Intentionally inert in skeleton; future commit wires this.
  return { skipped: 'apply-stub' };
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

  // Phase (b) — Score (stub: freshness + bias only)
  const scored = candidates.map(c => ({ c, fitness: scoreCandidate(c, config) }));
  scored.sort((a, b) => b.fitness.total - a.fitness.total);
  const topK = scored.slice(0, config.cycle?.top_k_mutations_per_cycle || 3);
  if (VERBOSE) topK.forEach((s, i) => log(`  top[${i}] ${s.c.source} fitness=${s.fitness.total.toFixed(3)} note=${s.fitness.note}`));

  // Phase (c)-(e) — Mutate/Validate/Apply (stubs; skipped in observation mode)
  let emitted = 0;
  if (!observationMode) {
    for (const s of topK) {
      const mut = mutateCandidate(s.c);
      if (!mut) continue;
      const val = validateCandidate(mut);
      if (!val.ok) { vlog(`  drop ${s.c.id}: ${val.reason}`); continue; }
      await emitPendingPatch(s.c, s.fitness, cycleId);
      emitted++;
    }
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
    top_k: topK.map(s => ({ source: s.c.source, id: s.c.id, fitness: s.fitness.total })),
    emitted,
    observation_mode: !!observationMode,
  };
  writeEvolutionLog(summary);
  await storeDigest(summary);

  log(`cycle ${cycleId} done in ${(summary.duration_ms/1000).toFixed(1)}s — emitted=${emitted}`);
  process.exit(0);
}

main().catch(e => { log('FATAL:', e.stack || e.message); process.exit(1); });
