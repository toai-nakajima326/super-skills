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
    content: String(content).slice(0, 50000), // Cap at ~12.5k tokens
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

    // Skip noisy tools
    const skipTools = ['TodoRead', 'TodoWrite', 'Read'];
    if (skipTools.includes(toolName)) return;

    const content = `Tool: ${toolName}\nInput: ${typeof toolInput === 'string' ? toolInput.slice(0, 500) : JSON.stringify(toolInput).slice(0, 500)}\nOutput: ${typeof toolOutput === 'string' ? toolOutput.slice(0, 1000) : JSON.stringify(toolOutput).slice(0, 1000)}`;

    // Detect error patterns
    const isError = /error|exception|failed|ENOENT|EACCES|timeout/i.test(toolOutput);
    const type = isError ? 'error' : 'observation';
    const tags = [toolName];
    if (isError) tags.push('error');

    await store(type, content, tags);

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
  default:
    console.log(`vcontext-hooks — Claude Code context auto-capture

Usage:
  node vcontext-hooks.js <command> [args]

Hook commands (called by Claude Code):
  tool-use          Process PostToolUse hook (reads stdin)
  notification      Process Notification hook (reads stdin)

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
