#!/usr/bin/env node
/**
 * vcontext-hooks.js — Universal context recorder
 *
 * Design principle: record EVERYTHING, filter NOTHING.
 * Session isolation: each entry is tagged with the session_id
 * from Claude Code's stdin JSON. Recall defaults to own session,
 * with opt-in cross-session search.
 */

import { request } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const VCONTEXT_PORT = process.env.VCONTEXT_PORT || '3150';
const VCONTEXT_URL = `http://127.0.0.1:${VCONTEXT_PORT}`;

// ── HTTP helpers ─────────────────────────────────────────────────

function post(path, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = request(
      `${VCONTEXT_URL}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({ raw: Buffer.concat(chunks).toString() }); }
        });
      }
    );
    req.on('error', () => resolve({ _skipped: true }));
    req.on('timeout', () => { req.destroy(); resolve({ _skipped: true }); });
    req.write(body);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve) => {
    const req = request(
      `${VCONTEXT_URL}${path}`,
      { method: 'GET', timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({ results: [] }); }
        });
      }
    );
    req.on('error', () => resolve({ results: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ results: [] }); });
    req.end();
  });
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf-8')), 1000);
  });
}

// ── Extract session ID from stdin JSON ───────────────────────────
// Claude Code includes session_id in every hook payload.
// Use it for session isolation. Fallback to env or timestamp.

function extractSessionId(input) {
  try {
    const data = JSON.parse(input);
    if (data.session_id) return data.session_id;
  } catch {}
  return process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`;
}

// ── Universal recorder ───────────────────────────────────────────

async function recordEvent(eventName) {
  const input = await readStdin();
  if (!input) return;

  const sessionId = extractSessionId(input);

  await post('/store', {
    type: eventName,
    content: input.slice(0, 500000),
    tags: [eventName],
    session: sessionId,
  });
}

// ── Session recall ───────────────────────────────────────────────
// Reads stdin to get session_id, then:
//   1. Own session context (primary)
//   2. Other sessions summary (secondary, opt-in)

async function handleSessionRecall() {
  const input = await readStdin();
  const sessionId = extractSessionId(input);
  const namespace = process.env.VCONTEXT_NAMESPACE || '';
  const nsParam = namespace ? `&namespace=${namespace}` : '';

  // Own session context
  const own = await get(`/session/${encodeURIComponent(sessionId)}?limit=20`);
  // Recent from all sessions (for cross-session awareness)
  const recent = await get(`/recent?n=10${nsParam}`);
  const stats = await get('/tier/stats');

  const lines = ['## Virtual Context — Session Recall', ''];
  lines.push(`Session: ${sessionId}`);
  lines.push('');

  // Own session entries first
  if (own.results && own.results.length > 0) {
    lines.push('### This Session');
    for (const r of own.results) {
      const preview = r.content && r.content.length > 200
        ? r.content.slice(0, 200) + '...'
        : (r.content || '');
      lines.push(`- [${r.type}] ${preview}`);
    }
    lines.push('');
  }

  // Other sessions (only entries NOT from this session)
  if (recent.results && recent.results.length > 0) {
    const others = recent.results.filter(r => r.session !== sessionId);
    if (others.length > 0) {
      lines.push('### Other Sessions (recent)');
      for (const r of others.slice(0, 5)) {
        const preview = r.content && r.content.length > 150
          ? r.content.slice(0, 150) + '...'
          : (r.content || '');
        lines.push(`- [${r.type}] (${r.session || '?'}) ${preview}`);
      }
      lines.push('');
    }
  }

  if (stats.ram) {
    lines.push(`Memory: RAM ${stats.ram.entries} (${stats.ram.size}) | SSD ${stats.ssd?.entries || 0} (${stats.ssd?.size || '0'})`);
  }

  const output = lines.join('\n');
  if (output.trim().length > 50) {
    process.stdout.write(output);
  }
}

// ── Manual CLI commands ──────────────────────────────────────────

async function manualStore(type, content, tagsStr) {
  if (!content) {
    console.error(`Usage: node vcontext-hooks.js store-${type} "content" ["tag1,tag2"]`);
    process.exit(1);
  }
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];
  tags.push(type, 'manual');
  const sessionId = process.env.CLAUDE_SESSION_ID || `manual-${Date.now()}`;
  const result = await post('/store', {
    type,
    content: String(content).slice(0, 500000),
    tags: [...new Set(tags)],
    session: sessionId,
  });
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);

switch (command) {
  // Hook events — all go through the universal recorder
  case 'user-prompt':
  case 'pre-tool':
  case 'tool-use':
  case 'tool-error':
  case 'subagent-start':
  case 'subagent-stop':
  case 'notification':
  case 'session-end':
  case 'compact':
  case 'pre-compact':
  case 'permission-request':
  case 'permission-denied':
    recordEvent(command).catch(() => process.exit(0));
    break;

  // Read-side: session recall
  case 'session-recall':
    handleSessionRecall().catch(() => process.exit(0));
    break;

  // Manual CLI commands
  case 'store-conversation':
    manualStore('conversation', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-decision':
    manualStore('decision', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-error':
    manualStore('error', args[0], args[1]).catch(() => process.exit(0));
    break;
  case 'store-code':
    manualStore('code', args[0], args[1]).catch(() => process.exit(0));
    break;

  default:
    console.log(`vcontext-hooks — Universal context recorder

Record everything, filter nothing. Session-isolated.

Hook events (via wrapper):
  user-prompt, pre-tool, tool-use, tool-error,
  subagent-start, subagent-stop, notification,
  session-end, compact, pre-compact,
  permission-request, permission-denied

Read-side:
  session-recall    Recall own session + other sessions summary

Manual:
  store-conversation "content" ["tags"]
  store-decision "content" ["tags"]
  store-error "content" ["tags"]
  store-code "content" ["tags"]

Server: ${VCONTEXT_URL} (silent skip if down)`);
    break;
}
