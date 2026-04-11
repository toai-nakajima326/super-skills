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

// ── Main ───────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'tool-use':
    handleToolUse().catch(() => process.exit(0));
    break;
  case 'notification':
    handleNotification().catch(() => process.exit(0));
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
