#!/usr/bin/env node
/**
 * vcontext-hooks.js — Claude Code hook scripts for auto-storing context
 *
 * These hook functions are called by Claude Code's event system to
 * automatically capture conversations, observations, and errors
 * into the Virtual Context store.
 *
 * Usage in .claude/settings.json hooks:
 *   "hooks": {
 *     "PostToolUse": [{ "command": "node ~/skills/scripts/vcontext-hooks.js tool-use" }],
 *     "Notification": [{ "command": "node ~/skills/scripts/vcontext-hooks.js notification" }]
 *   }
 *
 * Or call directly:
 *   node scripts/vcontext-hooks.js store-conversation "content here"
 *   node scripts/vcontext-hooks.js store-decision "chose X over Y" "arch,database"
 *   node scripts/vcontext-hooks.js store-error "TypeError: ..."
 */

import { request } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const VCONTEXT_PORT = process.env.VCONTEXT_PORT || '3150';
const VCONTEXT_URL = `http://127.0.0.1:${VCONTEXT_PORT}`;
const SESSION_ID = process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`;

// ── HTTP client ────────────────────────────────────────────────
function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = request(
      `${VCONTEXT_URL}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ raw: Buffer.concat(chunks).toString() });
          }
        });
      }
    );
    req.on('error', (e) => {
      // Silently fail if server is not running — hooks should not block
      resolve({ error: e.message, _skipped: true });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout', _skipped: true });
    });
    req.write(body);
    req.end();
  });
}

function store(type, content, tags = []) {
  return post('/store', {
    type,
    content: String(content).slice(0, 200000), // Cap at ~50k tokens — full memory mode
    tags,
    session: SESSION_ID,
  });
}

// ── Keyword extraction ────────────────────────────────────────
function extractKeywords(text) {
  if (!text || text.length < 10) return '';
  // Extract meaningful words (>3 chars, no common words)
  const stopWords = new Set(['this','that','with','from','have','will','been','were','they','their','which','would','could','should','about','after','before','these','those','other','there','where','while','being','doing','having']);
  const words = text.toLowerCase()
    .replace(/[^a-zA-Z0-9\u3000-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  // Deduplicate and take top 5
  const unique = [...new Set(words)].slice(0, 5);
  return unique.join(' ');
}

// ── Skill auto-injection triggers ─────────────────────────────
const SKILL_TRIGGERS = [
  {
    name: 'ui-implementation',
    detect: (toolName, input, output) =>
      /\.(tsx|jsx|css|scss)/.test(input) && ['Edit', 'Write', 'MultiEdit'].includes(toolName),
    inject: [
      '[skill:ui-implementation] Design.md準拠を確認:',
      '  - カラー: var(--color-*, fallback) 必須。HEXハードコード禁止',
      '  - フォント: 13px, ボタンpadding 6px 16px, border-radius 4px',
      '  - チェッカー検証後にコミット',
    ]
  },
  {
    name: 'investigate',
    detect: (toolName, input, output) =>
      /error|exception|failed|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|Cannot|undefined is not|null/i.test(output),
    inject: [
      '[skill:investigate] エラー検出 — 根本原因ファースト:',
      '  1) 推測で直さない。まず証拠収集',
      '  2) 実行パスを追跡',
      '  3) 最小仮説を立てて検証',
      '  4) 検証後に修正提案',
    ]
  },
  {
    name: 'guard',
    detect: (toolName, input, output) =>
      toolName === 'Bash' && /rm\s+-rf|drop\s+table|git\s+push\s+-f|git\s+reset\s+--hard|truncate|delete\s+from/i.test(input),
    inject: [
      '[skill:guard] ⚠️ 危険な操作を検出:',
      '  - この操作は不可逆です',
      '  - バックアップを確認してください',
      '  - 本当に実行しますか？',
    ]
  },
  {
    name: 'ship-release',
    detect: (toolName, input, output) =>
      toolName === 'Bash' && /git\s+push|npm\s+publish|deploy/i.test(input),
    inject: [
      '[skill:ship-release] リリース前チェック:',
      '  1) テスト全通過を確認',
      '  2) チェンジログ更新済み',
      '  3) バージョンバンプ済み',
      '  4) 人間の承認を待つ（自動pushしない）',
    ]
  },
  {
    name: 'security-review',
    detect: (toolName, input, output) =>
      /password|secret|token|api.?key|credential|auth|bearer|jwt|oauth/i.test(input + output),
    inject: [
      '[skill:security-review] 機密情報を検出:',
      '  - シークレットがコードにハードコードされていないか確認',
      '  - 環境変数または設定ファイルを使用',
      '  - ログに出力されていないか確認',
    ]
  },
  {
    name: 'careful',
    detect: (toolName, input, output) =>
      /production|本番|prod\.|\-\-force|migrate|migration/i.test(input),
    inject: [
      '[skill:careful] 本番環境/重要操作を検出:',
      '  1) 現在の状態をバックアップ',
      '  2) 影響範囲を確認',
      '  3) 実行前に確認を待つ',
    ]
  },
  {
    name: 'review',
    detect: (toolName, input, output) =>
      toolName === 'Bash' && /git\s+diff|gh\s+pr\s+(view|review|create)/i.test(input),
    inject: [
      '[skill:review] コードレビューモード:',
      '  - 正確性 > 回帰リスク > セキュリティ > バリデーション不足 > テスト不足',
      '  - Findings優先、ファイル名と行番号を明示',
    ]
  },
  {
    name: 'tdd-workflow',
    detect: (toolName, input, output) =>
      toolName === 'Bash' && /jest|vitest|pytest|test.*run|npm\s+test|npx\s+test/i.test(input),
    inject: [
      '[skill:tdd-workflow] テスト実行検出:',
      '  - 失敗テスト → 最小実装 → 成功確認 → リファクタ',
    ]
  },
  {
    name: 'coding-standards',
    detect: (toolName, input, output) =>
      ['Edit', 'Write', 'MultiEdit'].includes(toolName) && /\.(ts|js|py|go|rs|java)/.test(input),
    inject: [
      '[skill:coding-standards] コード変更検出:',
      '  - 既存パターンに合わせる（命名規則、フォーマット）',
      '  - バリデーション・エラーハンドリングを確認',
    ]
  },
  {
    name: 'backend-patterns',
    detect: (toolName, input, output) =>
      ['Edit', 'Write'].includes(toolName) && /(controller|service|repository|middleware|route|handler|api)\.(ts|js|py)/i.test(input),
    inject: [
      '[skill:backend-patterns] バックエンド変更検出:',
      '  - 関心の分離を維持',
      '  - 冪等操作、優雅な失敗処理',
    ]
  },
  {
    name: 'frontend-patterns',
    detect: (toolName, input, output) =>
      ['Edit', 'Write'].includes(toolName) && /(component|hook|context|store|page)\.(tsx|jsx)/i.test(input),
    inject: [
      '[skill:frontend-patterns] フロントエンド変更検出:',
      '  - コンポーネント合成 > 継承',
      '  - 共有ミュータブル状態を最小化',
    ]
  },
  {
    name: 'plan-architecture',
    detect: (toolName, input, output) =>
      /architect|設計|design.*system|data.*flow|api.*boundary/i.test(input + output),
    inject: [
      '[skill:plan-architecture] アーキテクチャ検討:',
      '  1) コンテキストマッピング → 2) コンポーネント特定 → 3) インターフェース契約 → 4) 障害モード分析',
    ]
  },
];

// ── Hook handlers ──────────────────────────────────────────────

/**
 * After a tool use (PostToolUse hook).
 * Reads tool info from stdin (Claude Code passes JSON).
 */
async function handleToolUse() {
  const input = await readStdin();
  if (!input) return;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.name || 'unknown';
    const toolInput = data.tool_input || data.input || '';
    const toolOutput = data.tool_output || data.output || '';

    // Record everything — full memory mode
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
    const outputStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
    const content = `Tool: ${toolName}\nInput: ${inputStr.slice(0, 5000)}\nOutput: ${outputStr.slice(0, 10000)}`;

    // Detect error patterns
    const isError = /error|exception|failed|ENOENT|EACCES|timeout/i.test(toolOutput);
    const type = isError ? 'error' : 'observation';
    const tags = [toolName];
    if (isError) tags.push('error');

    await store(type, content, tags);

    // Track analytics
    try {
      await post('/analytics/track', {
        event_type: 'tool_use',
        skill_name: toolName,
        session: SESSION_ID,
        metadata: { type: isError ? 'error' : 'observation' }
      });
    } catch {}

    // Auto-recall related context from other sessions
    try {
      const keywords = extractKeywords(content);
      if (keywords) {
        const recalled = await get(`/recall?q=${encodeURIComponent(keywords)}&limit=3`);
        if (recalled.results && recalled.results.length > 0) {
          // Only show entries from OTHER sessions
          const otherSession = recalled.results.filter(r => r.session !== SESSION_ID);
          if (otherSession.length > 0) {
            const lines = ['[vcontext] Related past context:'];
            for (const r of otherSession.slice(0, 2)) {
              lines.push(`  [${r.type}${r._tier ? '/' + r._tier : ''}] ${r.content.slice(0, 150)}`);
            }
            process.stdout.write(lines.join('\n') + '\n');
          }
        }
      }
    } catch {} // Never block on recall failure

    // Check for pending consultations (piggyback on tool-use hook)
    try {
      await handleAutoConsult();
    } catch {} // Never block on auto-consult failure

    // ── Skill auto-injection ──────────────────────────────────────
    // Detect context and inject relevant skill workflow into AI's context
    try {
      const triggered = [];
      for (const skill of SKILL_TRIGGERS) {
        try {
          if (skill.detect(toolName, inputStr, outputStr)) {
            triggered.push(skill);
          }
        } catch {}
      }

      // Always inject safety skills; limit other skills to first match
      const safetySkills = triggered.filter(s => ['guard', 'security-review', 'careful'].includes(s.name));
      const otherSkills = triggered.filter(s => !['guard', 'security-review', 'careful'].includes(s.name));
      const toInject = [...safetySkills, ...otherSkills.slice(0, 1)];

      if (toInject.length > 0) {
        const lines = [];
        for (const skill of toInject) {
          lines.push(...skill.inject);
        }
        process.stdout.write(lines.join('\n') + '\n');

        // Track which skills were auto-injected
        for (const skill of toInject) {
          try {
            await post('/analytics/track', {
              event_type: 'skill_auto_inject',
              skill_name: skill.name,
              session: SESSION_ID,
              metadata: { tool: toolName }
            });
          } catch {}
        }
      }
    } catch {} // Never block on skill injection failure
  } catch {
    // Non-JSON input — store as-is
    await store('observation', input.slice(0, 2000), ['raw-hook']);
  }
}

/**
 * After a notification (error, warning, etc.)
 */
async function handleNotification() {
  const input = await readStdin();
  if (!input) return;

  await store('error', input.slice(0, 5000), ['notification']);
}

/**
 * Manually store a conversation entry.
 * Usage: node vcontext-hooks.js store-conversation "content"
 */
async function handleStoreConversation(content) {
  if (!content) {
    console.error('Usage: node vcontext-hooks.js store-conversation "content"');
    process.exit(1);
  }
  const result = await store('conversation', content, ['manual']);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Manually store a decision.
 * Usage: node vcontext-hooks.js store-decision "chose X" "tag1,tag2"
 */
async function handleStoreDecision(content, tagsStr) {
  if (!content) {
    console.error('Usage: node vcontext-hooks.js store-decision "content" "tag1,tag2"');
    process.exit(1);
  }
  const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : ['decision'];
  tags.push('decision');
  const result = await store('decision', content, [...new Set(tags)]);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Manually store an error.
 * Usage: node vcontext-hooks.js store-error "error message"
 */
async function handleStoreError(content) {
  if (!content) {
    console.error('Usage: node vcontext-hooks.js store-error "error message"');
    process.exit(1);
  }
  const result = await store('error', content, ['manual-error']);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Store a code snippet.
 * Usage: node vcontext-hooks.js store-code "snippet" "tag1,tag2"
 */
async function handleStoreCode(content, tagsStr) {
  if (!content) {
    console.error('Usage: node vcontext-hooks.js store-code "snippet" "tag1,tag2"');
    process.exit(1);
  }
  const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : ['code'];
  tags.push('code');
  const result = await store('code', content, [...new Set(tags)]);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Check for pending consultations and auto-respond.
 * Called by PostToolUse hook to piggyback on existing hook calls.
 * The AI model evaluates the consultation prompt itself — the output
 * goes to stdout where the AI session can see it and act on it.
 */
async function handleAutoConsult() {
  const model = process.env.VCONTEXT_MODEL || 'claude'; // 'claude' or 'codex'

  // Check for pending consultations
  const pending = await get(`/consult/pending?model=${encodeURIComponent(model)}`);
  if (!pending.pending || pending.pending.length === 0) return;

  // Output consultation prompts for the AI to evaluate
  // The AI sees this in stdout and can evaluate + respond
  for (const p of pending.pending.slice(0, 2)) { // Max 2 at a time
    const lines = [
      `[vcontext] Consultation requested (${p.consultation_id}):`,
      `  Question: ${p.query}`,
      `  ${(p.prompt || '').slice(0, 300)}`,
      `  → To respond: curl -X POST http://127.0.0.1:${VCONTEXT_PORT}/consult/${p.consultation_id}/response -H 'Content-Type: application/json' -d '{"model":"${model}","chosen":N,"reasoning":"...","confidence":"high|medium|low"}'`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }
}

// ── Stdin reader ───────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    // Timeout: don't hang if nothing comes on stdin
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf-8')), 1000);
  });
}

// ── Session recall (inject past context at session start) ─────

function get(path) {
  return new Promise((resolve) => {
    const req = request(
      `${VCONTEXT_URL}${path}`,
      { method: 'GET', timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ results: [] });
          }
        });
      }
    );
    req.on('error', () => resolve({ results: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ results: [] }); });
    req.end();
  });
}

/**
 * Session start: recall recent context and output as text for Claude to read.
 * Called by PreToolUse hook on first tool use, or manually.
 * Outputs markdown to stdout — Claude Code injects this into the conversation.
 */
async function handleSessionRecall() {
  // Track session start
  try {
    await post('/analytics/track', { event_type: 'session_start', session: SESSION_ID });
  } catch {}

  const namespace = process.env.VCONTEXT_NAMESPACE || '';
  const nsParam = namespace ? `&namespace=${namespace}` : '';

  // Get recent entries (all types)
  const recent = await get(`/recent?n=15${nsParam}`);
  // Get recent decisions specifically
  const decisions = await get(`/recent?n=10&type=decision${nsParam}`);
  // Get recent errors
  const errors = await get(`/recent?n=5&type=error${nsParam}`);

  const lines = [];
  lines.push('## Virtual Context — Session Recall');
  lines.push('');

  if (decisions.results && decisions.results.length > 0) {
    lines.push('### Recent Decisions');
    for (const d of decisions.results) {
      const tags = Array.isArray(d.tags) ? d.tags.join(', ') : '';
      lines.push(`- [${d.created_at}] ${d.content}${tags ? ` (${tags})` : ''}`);
    }
    lines.push('');
  }

  if (errors.results && errors.results.length > 0) {
    lines.push('### Recent Errors');
    for (const e of errors.results) {
      lines.push(`- [${e.created_at}] ${e.content}`);
    }
    lines.push('');
  }

  if (recent.results && recent.results.length > 0) {
    lines.push('### Recent Activity');
    for (const r of recent.results) {
      const preview = r.content.length > 120 ? r.content.slice(0, 120) + '...' : r.content;
      lines.push(`- [${r.type}] ${preview}`);
    }
    lines.push('');
  }

  const stats = await get('/tier/stats');
  if (stats.ram) {
    lines.push(`### Memory: RAM ${stats.ram.entries} entries (${stats.ram.size}) | SSD ${stats.ssd?.entries || 0} entries (${stats.ssd?.size || '0'}) | Cloud ${stats.cloud?.configured ? 'connected' : 'not configured'}`);
  }

  // Activity feed: what changed since last session check
  try {
    const localUser = process.env.USER || process.env.USERNAME || 'unknown';
    const lastCheckFile = `/tmp/vcontext-last-check-${localUser}.txt`;
    let lastCheck = '';
    try {
      lastCheck = readFileSync(lastCheckFile, 'utf-8').trim();
    } catch {
      // No previous check — use 24h ago as default
      lastCheck = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }
    const feedUrl = `/feed?since=${encodeURIComponent(lastCheck)}&exclude_user=${encodeURIComponent(localUser)}`;
    const feed = await get(feedUrl);
    if (feed.entries && feed.entries.length > 0) {
      lines.push('');
      lines.push('### Activity from other sessions');
      for (const entry of feed.entries.slice(0, 10)) {
        const preview = entry.content && entry.content.length > 120 ? entry.content.slice(0, 120) + '...' : (entry.content || '');
        lines.push(`- [${entry.type}] ${preview}`);
      }
      lines.push('');
    }
    // Update last-check timestamp
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      writeFileSync(lastCheckFile, now, 'utf-8');
    } catch {} // Non-fatal if /tmp write fails
  } catch {} // Never block on feed failure

  const output = lines.join('\n');
  if (output.trim().length > 50) {
    process.stdout.write(output);
  }
}

/**
 * Store a session summary when session ends.
 * Usage: node vcontext-hooks.js session-end "summary text"
 */
async function handleSessionEnd(summary) {
  // Track session end
  try {
    await post('/analytics/track', { event_type: 'session_end', session: SESSION_ID });
  } catch {}

  const content = summary || `Session ${SESSION_ID} ended`;
  const result = await store('conversation', content, ['session-end', 'auto']);
  if (!summary) {
    // Auto-generate summary from recent activity
    const recent = await get(`/recent?n=5&session=${SESSION_ID}`);
    if (recent.results && recent.results.length > 0) {
      const types = recent.results.map(r => r.type);
      const autoSummary = `Session had ${recent.results.length} entries: ${[...new Set(types)].join(', ')}`;
      await store('conversation', autoSummary, ['session-summary', 'auto']);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'tool-use':
    handleToolUse().catch(() => process.exit(0));
    break;
  case 'notification':
    handleNotification().catch(() => process.exit(0));
    break;
  case 'session-recall':
    handleSessionRecall().catch(() => process.exit(0));
    break;
  case 'session-end':
    handleSessionEnd(args[0]).catch(() => process.exit(0));
    break;
  case 'store-conversation':
    handleStoreConversation(args[0]).catch(() => process.exit(0));
    break;
  case 'store-decision':
    handleStoreDecision(args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-error':
    handleStoreError(args[0]).catch(() => process.exit(0));
    break;
  case 'store-code':
    handleStoreCode(args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'auto-consult':
    handleAutoConsult().catch(() => process.exit(0));
    break;
  default:
    console.log(`vcontext-hooks — Claude Code context auto-capture

Usage:
  node vcontext-hooks.js <command> [args]

Hook commands (called by Claude Code):
  tool-use          Process PostToolUse hook (reads stdin)
  notification      Process Notification hook (reads stdin)
  auto-consult      Check for pending consultations and output prompts

Manual commands:
  store-conversation "content"       Store a conversation entry
  store-decision "content" "tags"    Store a decision (comma-separated tags)
  store-error "error message"        Store an error
  store-code "snippet" "tags"        Store a code snippet

Environment:
  CLAUDE_SESSION_ID    Session identifier (auto-generated if not set)

The server must be running at ${VCONTEXT_URL} (default port 3150).
If not running, hooks silently skip without blocking.`);
    break;
}
