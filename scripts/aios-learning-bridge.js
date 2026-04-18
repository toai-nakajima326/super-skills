#!/usr/bin/env node
/**
 * aios-learning-bridge.js
 *
 * self-evolve の pending-patch を監視し、自動承認条件を満たすものを
 * 自動で SKILL.md に適用する自律学習ブリッジ。
 *
 * 実行方法:
 *   node scripts/aios-learning-bridge.js         # 1回実行
 *   node scripts/aios-learning-bridge.js --watch  # 定期実行 (60分ごと)
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SKILLS_ROOT = path.join(process.env.HOME, 'skills', 'skills');
const VCONTEXT_URL = 'http://127.0.0.1:3150';
const LOG_PREFIX = '[aios-learning-bridge]';

// 自動承認条件
const AUTO_APPROVE = {
  min_fitness: 0.85,
  safety_skills: ['guard', 'freeze', 'careful', 'checkpoint',
                  'supervisor-worker', 'quality-gate', 'phase-gate'],
};

// ── ユーティリティ ──────────────────────────────

function log(...args) {
  console.log(`${LOG_PREFIX}`, ...args);
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

function vcGet(path_) {
  return new Promise((res, rej) => {
    http.get(`${VCONTEXT_URL}${path_}`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({ results: [] }); } });
    }).on('error', rej);
  });
}

// ── クエリ生成トリガー ────────────────────────────
function triggerQueryGenerator() {
  const script = path.join(process.env.HOME, 'skills', 'scripts', 'skill-query-generator.js');
  if (!fs.existsSync(script)) return;
  const nodePath = fs.existsSync(path.join(process.env.HOME, '.nvm/versions/node/v25.9.0/bin/node'))
    ? path.join(process.env.HOME, '.nvm/versions/node/v25.9.0/bin/node')
    : 'node';
  const child = spawn(nodePath, [script], {
    cwd: path.join(process.env.HOME, 'skills'),
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  log('triggered skill-query-generator.js (background)');
}

// ── メイン処理 ──────────────────────────────────

async function runBridge() {
  log('=== bridge cycle start ===');

  // vcontext 稼働確認
  try {
    const health = await vcGet('/health');
    if (health.status !== 'healthy') {
      log('vcontext not healthy, skipping');
      return;
    }
  } catch {
    log('vcontext unreachable, skipping');
    return;
  }

  // 未処理の pending-patch を取得
  const data = await vcGet('/recall?type=pending-patch&limit=20');
  const patches = (data.results || []).filter(p => {
    try {
      const c = JSON.parse(p.content);
      return !c.processed_at;
    } catch { return false; }
  });

  log(`${patches.length} unprocessed pending-patches found`);

  let applied = 0, skipped = 0;

  for (const patch of patches) {
    let content;
    try { content = JSON.parse(patch.content); }
    catch { continue; }

    const skillName = (content.target_path || '').split('/')[1];
    if (!skillName) continue;

    // 安全スキルは自動適用しない
    if (AUTO_APPROVE.safety_skills.includes(skillName)) {
      log(`SKIP safety skill: ${skillName}`);
      skipped++;
      continue;
    }

    // fitness チェック
    if ((content.fitness || 0) < AUTO_APPROVE.min_fitness) {
      log(`SKIP low fitness ${content.fitness}: ${skillName}`);
      skipped++;
      continue;
    }

    // proposed_content チェック
    if (!content.proposed_content || content.proposed_content.length < 100) {
      log(`SKIP no/short content: ${skillName}`);
      skipped++;
      continue;
    }

    // 適用
    const result = await applyPatch(skillName, content, patch.id);
    if (result) applied++;
    else skipped++;
  }

  log(`cycle complete: applied=${applied} skipped=${skipped}`);

  // 結果を vcontext に記録
  await vcPost({
    type: 'aios-learning-run',
    content: JSON.stringify({
      run_at: new Date().toISOString(),
      patches_found: patches.length,
      applied,
      skipped
    }),
    tags: ['aios-learning-run', 'aios-autonomous-learning'],
    session: 'system'
  });

  // スキルギャップの蓄積に基づいてクエリを動的生成
  triggerQueryGenerator();
}

async function applyPatch(skillName, content, patchId) {
  const skillDir = path.join(SKILLS_ROOT, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const isNew = !fs.existsSync(skillFile);

  log(`${isNew ? 'CREATE' : 'UPDATE'} skill: ${skillName} (fitness=${content.fitness})`);

  // ディレクトリ作成
  fs.mkdirSync(skillDir, { recursive: true });

  // 書き込み前に既存ファイルをバックアップ
  const backup = isNew ? null : fs.readFileSync(skillFile, 'utf8');
  fs.writeFileSync(skillFile, content.proposed_content);

  // バリデーション
  try {
    execFileSync('node', ['scripts/validate-skills.js'], {
      cwd: path.join(process.env.HOME, 'skills'),
      stdio: 'pipe'
    });
  } catch (err) {
    log(`VALIDATION FAILED for ${skillName}, rolling back`);
    if (backup !== null) fs.writeFileSync(skillFile, backup);
    else fs.unlinkSync(skillFile);
    await markProcessed(patchId, content, 'validation_failed');
    return false;
  }

  // git add & commit
  try {
    const gitRoot = path.join(process.env.HOME, 'skills');
    execFileSync('git', ['add', `skills/${skillName}/SKILL.md`], { cwd: gitRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m',
      `feat: auto-apply ${skillName} (fitness=${content.fitness}, source=${content.source || '?'})\n\nCycle: ${content.cycle_id || '?'}\nReasoning: ${(content.reasoning || '').slice(0, 200)}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
    ], { cwd: gitRoot, stdio: 'pipe' });
  } catch (err) {
    log(`git commit failed for ${skillName}: ${err.message}`);
    // git失敗でもスキルファイル自体は有効なので続行
  }

  // vcontext skill-registry に登録
  const desc = extractDescription(content.proposed_content);
  await vcPost({
    type: 'skill-registry',
    content: JSON.stringify({
      name: skillName,
      description: desc,
      priority: 'P6',
      origin: 'auto-applied',
      fitness: content.fitness,
      cycle_id: content.cycle_id,
      registered_at: new Date().toISOString()
    }),
    tags: ['skill-registry', `skill:${skillName}`, 'auto-applied'],
    session: 'aios-autonomous-learning'
  });

  // 処理済みマーク
  await markProcessed(patchId, content, 'applied');

  log(`✓ Applied: ${skillName}`);
  return true;
}

function extractDescription(skillMd) {
  const m = skillMd.match(/description:\s*\|?\s*\n([\s\S]*?)(?=\n\w|\n---)/);
  if (m) return m[1].replace(/^\s+/gm, '').trim().slice(0, 200);
  return 'Auto-generated skill';
}

async function markProcessed(patchId, content, status) {
  await vcPost({
    type: 'pending-patch',
    content: JSON.stringify({
      ...content,
      processed_at: new Date().toISOString(),
      processed_status: status
    }),
    tags: ['pending-patch', `status:${status}`, `patch:${patchId}`],
    session: 'aios-autonomous-learning'
  });
}

// ── エントリポイント ─────────────────────────────

const watchMode = process.argv.includes('--watch');
const intervalMs = 60 * 60 * 1000; // 60分

runBridge().catch(err => {
  console.error(LOG_PREFIX, 'ERROR:', err.message);
  process.exit(1);
});

if (watchMode) {
  log(`watch mode: running every ${intervalMs / 60000} minutes`);
  setInterval(() => {
    runBridge().catch(err => console.error(LOG_PREFIX, 'ERROR:', err.message));
  }, intervalMs);
}
