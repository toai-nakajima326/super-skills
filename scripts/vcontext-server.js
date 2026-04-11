#!/usr/bin/env node
/**
 * vcontext-server.js — Virtual Context REST API
 *
 * A local HTTP server (port 3100) that provides Claude Code with a
 * persistent "virtual memory" backed by SQLite + FTS5 on a RAM disk.
 *
 * Zero npm dependencies — uses Node.js built-in modules + sqlite3 CLI.
 *
 * Endpoints:
 *   POST   /store         — store a context entry
 *   GET    /recall        — full-text search (?q=keyword&type=&limit=10)
 *   GET    /recent        — recent entries (?n=20&type=)
 *   GET    /session/:id   — entries for a session
 *   POST   /summarize     — compact old entries into summaries
 *   GET    /stats         — database statistics
 *   DELETE /prune         — remove old entries (?older_than=7d)
 *   GET    /health        — health check
 */

import { createServer } from 'node:http';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.VCONTEXT_PORT || '3150', 10);
const MOUNT_POINT = '/Volumes/VContext';
const DB_PATH = join(MOUNT_POINT, 'vcontext.db');
const BACKUP_DIR = join(process.env.HOME, 'skills', 'data');
const BACKUP_PATH = join(BACKUP_DIR, 'vcontext-backup.sqlite');
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WARN_SIZE_BYTES = 3 * 1024 * 1024 * 1024;     // 3 GB
const MAX_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024;     // 3.5 GB
const VALID_TYPES = ['conversation', 'decision', 'observation', 'code', 'error'];

// ── SQLite helpers ─────────────────────────────────────────────

/**
 * Run a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE).
 * Returns nothing.
 */
function dbExec(sql) {
  try {
    execFileSync('sqlite3', [DB_PATH, sql], {
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    console.error('[db exec error]', e.message);
    throw new Error(`SQLite exec error: ${e.message}`);
  }
}

/**
 * Run a SQL query and return rows as a JS array.
 * Uses sqlite3 -json for structured output.
 */
function dbQuery(sql) {
  try {
    const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });
    const trimmed = out.trim();
    if (!trimmed || trimmed === '[]') return [];
    return JSON.parse(trimmed);
  } catch (e) {
    // sqlite3 -json returns empty string for no results, which is fine
    if (e.status === 0 || (e.stdout && e.stdout.trim() === '')) return [];
    console.error('[db query error]', e.message);
    throw new Error(`SQLite query error: ${e.message}`);
  }
}

/**
 * Escape a string for safe SQL embedding (single-quote doubling).
 */
function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

// ── RAM disk check ─────────────────────────────────────────────
function ensureRamDisk() {
  if (!existsSync(MOUNT_POINT)) {
    console.log('[vcontext] RAM disk not mounted, attempting to create...');
    try {
      execSync(`bash "${join(process.env.HOME, 'skills', 'scripts', 'vcontext-setup.sh')}" start`, {
        timeout: 30000,
        stdio: 'inherit',
      });
    } catch (e) {
      console.error('[vcontext] Failed to create RAM disk:', e.message);
      process.exit(1);
    }
  }
  if (!existsSync(DB_PATH)) {
    console.log('[vcontext] Database not found, initializing...');
    try {
      execSync(`bash "${join(process.env.HOME, 'skills', 'scripts', 'vcontext-setup.sh')}" start`, {
        timeout: 30000,
        stdio: 'inherit',
      });
    } catch (e) {
      console.error('[vcontext] Failed to init database:', e.message);
      process.exit(1);
    }
  }
}

// ── DB size check ──────────────────────────────────────────────
function checkDbSize() {
  try {
    const stats = statSync(DB_PATH);
    if (stats.size >= MAX_SIZE_BYTES) {
      return { ok: false, size: stats.size, msg: 'Database at maximum size (3.5GB). Writes refused.' };
    }
    if (stats.size >= WARN_SIZE_BYTES) {
      return { ok: true, size: stats.size, msg: 'Warning: Database exceeding 3GB.' };
    }
    return { ok: true, size: stats.size, msg: null };
  } catch {
    return { ok: true, size: 0, msg: null };
  }
}

// ── Backup ─────────────────────────────────────────────────────
function doBackup() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (existsSync(DB_PATH)) {
      dbExec(`.backup '${BACKUP_PATH}'`);
      console.log(`[vcontext] Backup complete: ${BACKUP_PATH}`);
    }
  } catch (e) {
    console.error('[vcontext] Backup failed:', e.message);
    // Fallback: file copy
    try {
      copyFileSync(DB_PATH, BACKUP_PATH);
      console.log('[vcontext] Backup (file copy) complete');
    } catch (e2) {
      console.error('[vcontext] Fallback backup also failed:', e2.message);
    }
  }
}

// ── Token estimation ───────────────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

// ── HTTP helpers ───────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params = {};
  const qs = url.slice(idx + 1);
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

function parsePath(url) {
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

// ── Route handlers ─────────────────────────────────────────────

/**
 * POST /store
 * Body: { type, content, tags?, session? }
 */
async function handleStore(req, res) {
  const sizeCheck = checkDbSize();
  if (!sizeCheck.ok) {
    return sendJson(res, 507, { error: sizeCheck.msg });
  }

  const body = await readBody(req);
  const { type, content, tags, session } = body;

  if (!type || !content) {
    return sendJson(res, 400, { error: 'Missing required fields: type, content' });
  }
  if (!VALID_TYPES.includes(type)) {
    return sendJson(res, 400, { error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const tagsJson = JSON.stringify(tags || []);
  const tokenEst = estimateTokens(content);

  const sql = `INSERT INTO entries (type, content, tags, session, token_estimate) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst});`;
  dbExec(sql);

  // Get the inserted row
  const rows = dbQuery('SELECT * FROM entries ORDER BY id DESC LIMIT 1;');
  const entry = rows[0] || {};

  if (sizeCheck.msg) {
    entry._warning = sizeCheck.msg;
  }

  sendJson(res, 201, { stored: entry });
}

/**
 * GET /recall?q=keyword&type=conversation&limit=10
 */
function handleRecall(req, res) {
  const params = parseQuery(req.url);
  const q = params.q;
  if (!q) {
    return sendJson(res, 400, { error: 'Missing query parameter: q' });
  }

  const limit = Math.min(parseInt(params.limit) || 10, 100);
  const type = params.type;

  // FTS5 search with relevance ranking + recency boost
  let sql;
  if (type && VALID_TYPES.includes(type)) {
    sql = `SELECT e.*, rank
      FROM entries_fts fts
      JOIN entries e ON e.id = fts.rowid
      WHERE entries_fts MATCH ${esc(q)}
        AND e.type = ${esc(type)}
      ORDER BY rank * 0.7 + (julianday(e.created_at) - julianday('2024-01-01')) * 0.3
      LIMIT ${limit};`;
  } else {
    sql = `SELECT e.*, rank
      FROM entries_fts fts
      JOIN entries e ON e.id = fts.rowid
      WHERE entries_fts MATCH ${esc(q)}
      ORDER BY rank * 0.7 + (julianday(e.created_at) - julianday('2024-01-01')) * 0.3
      LIMIT ${limit};`;
  }

  try {
    const rows = dbQuery(sql);
    // Parse tags back to arrays
    for (const row of rows) {
      try { row.tags = JSON.parse(row.tags); } catch { /* keep as string */ }
    }
    sendJson(res, 200, { results: rows, count: rows.length, query: q });
  } catch (e) {
    // FTS query syntax error — fall back to LIKE search
    const likeSql = type
      ? `SELECT * FROM entries WHERE content LIKE ${esc('%' + q + '%')} AND type = ${esc(type)} ORDER BY created_at DESC LIMIT ${limit};`
      : `SELECT * FROM entries WHERE content LIKE ${esc('%' + q + '%')} ORDER BY created_at DESC LIMIT ${limit};`;
    const rows = dbQuery(likeSql);
    for (const row of rows) {
      try { row.tags = JSON.parse(row.tags); } catch { /* keep */ }
    }
    sendJson(res, 200, { results: rows, count: rows.length, query: q, _note: 'Used LIKE fallback' });
  }
}

/**
 * GET /recent?n=20&type=conversation
 */
function handleRecent(req, res) {
  const params = parseQuery(req.url);
  const n = Math.min(parseInt(params.n) || 20, 200);
  const type = params.type;

  let sql;
  if (type && VALID_TYPES.includes(type)) {
    sql = `SELECT * FROM entries WHERE type = ${esc(type)} ORDER BY created_at DESC LIMIT ${n};`;
  } else {
    sql = `SELECT * FROM entries ORDER BY created_at DESC LIMIT ${n};`;
  }

  const rows = dbQuery(sql);
  for (const row of rows) {
    try { row.tags = JSON.parse(row.tags); } catch { /* keep */ }
  }
  sendJson(res, 200, { results: rows, count: rows.length });
}

/**
 * GET /session/:id
 */
function handleSession(req, res) {
  const path = parsePath(req.url);
  const sessionId = path.replace('/session/', '');
  if (!sessionId) {
    return sendJson(res, 400, { error: 'Missing session ID' });
  }

  const rows = dbQuery(`SELECT * FROM entries WHERE session = ${esc(sessionId)} ORDER BY created_at ASC;`);
  for (const row of rows) {
    try { row.tags = JSON.parse(row.tags); } catch { /* keep */ }
  }
  sendJson(res, 200, { session: sessionId, results: rows, count: rows.length });
}

/**
 * POST /summarize
 * Compact entries older than 24h into summary entries.
 */
async function handleSummarize(req, res) {
  const cutoff = "datetime('now', '-24 hours')";

  // Get types that have old entries
  const typeCounts = dbQuery(`SELECT type, COUNT(*) as cnt FROM entries WHERE created_at < ${cutoff} GROUP BY type;`);

  if (typeCounts.length === 0) {
    return sendJson(res, 200, { message: 'Nothing to summarize', compacted: 0 });
  }

  let totalCompacted = 0;
  const summaries = [];

  for (const { type, cnt } of typeCounts) {
    if (cnt < 3) continue; // Skip types with very few entries

    // Get old entries for this type
    const oldEntries = dbQuery(
      `SELECT id, content, tags, session FROM entries WHERE type = ${esc(type)} AND created_at < ${cutoff} ORDER BY created_at ASC;`
    );

    // Build a summary
    const contentSnippets = oldEntries.map((e) => {
      const snippet = e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content;
      return `- ${snippet}`;
    });
    const summaryContent = `[Summary of ${oldEntries.length} ${type} entries]\n${contentSnippets.join('\n')}`;

    // Collect all tags
    const allTags = new Set();
    for (const e of oldEntries) {
      try {
        const t = JSON.parse(e.tags);
        if (Array.isArray(t)) t.forEach((tag) => allTags.add(tag));
      } catch { /* skip */ }
    }
    allTags.add('summary');
    allTags.add('compacted');

    const tokenEst = estimateTokens(summaryContent);
    const tagsJson = JSON.stringify([...allTags]);

    // Insert summary
    dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES (${esc(type)}, ${esc(summaryContent)}, ${esc(tagsJson)}, 'system-compaction', ${tokenEst});`);

    // Delete old entries
    const ids = oldEntries.map((e) => e.id).join(',');
    dbExec(`DELETE FROM entries WHERE id IN (${ids});`);

    totalCompacted += oldEntries.length;
    summaries.push({ type, compacted: oldEntries.length });
  }

  sendJson(res, 200, { message: 'Compaction complete', compacted: totalCompacted, details: summaries });
}

/**
 * GET /stats
 */
function handleStats(req, res) {
  const sizeCheck = checkDbSize();

  const total = dbQuery('SELECT COUNT(*) as count FROM entries;');
  const byType = dbQuery('SELECT type, COUNT(*) as count FROM entries GROUP BY type ORDER BY count DESC;');
  const oldest = dbQuery('SELECT MIN(created_at) as oldest FROM entries;');
  const newest = dbQuery('SELECT MAX(created_at) as newest FROM entries;');
  const totalTokens = dbQuery('SELECT SUM(token_estimate) as tokens FROM entries;');
  const sessions = dbQuery('SELECT COUNT(DISTINCT session) as count FROM entries WHERE session IS NOT NULL;');

  sendJson(res, 200, {
    entries: total[0]?.count || 0,
    by_type: byType,
    oldest: oldest[0]?.oldest || null,
    newest: newest[0]?.newest || null,
    total_tokens: totalTokens[0]?.tokens || 0,
    sessions: sessions[0]?.count || 0,
    db_size_bytes: sizeCheck.size,
    db_size_human: formatBytes(sizeCheck.size),
    warning: sizeCheck.msg,
  });
}

/**
 * DELETE /prune?older_than=7d
 */
function handlePrune(req, res) {
  const params = parseQuery(req.url);
  const olderThan = params.older_than || '7d';

  // Parse duration: 7d, 24h, 30m
  const match = olderThan.match(/^(\d+)([dhm])$/);
  if (!match) {
    return sendJson(res, 400, { error: 'Invalid older_than format. Use: 7d, 24h, 30m' });
  }
  const [, num, unit] = match;
  const unitMap = { d: 'days', h: 'hours', m: 'minutes' };
  const sqlUnit = unitMap[unit];

  // Count before delete
  const before = dbQuery(`SELECT COUNT(*) as count FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`);
  const countToDelete = before[0]?.count || 0;

  if (countToDelete === 0) {
    return sendJson(res, 200, { pruned: 0, message: 'Nothing to prune' });
  }

  // Backup before pruning
  doBackup();

  dbExec(`DELETE FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`);

  // Rebuild FTS
  dbExec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild');");

  sendJson(res, 200, { pruned: countToDelete, older_than: olderThan });
}

/**
 * GET /health
 */
function handleHealth(req, res) {
  const mounted = existsSync(MOUNT_POINT);
  const dbExists = existsSync(DB_PATH);
  let dbOk = false;
  if (dbExists) {
    try {
      const result = dbQuery("SELECT 1 as ok;");
      dbOk = result[0]?.ok === 1;
    } catch { /* not ok */ }
  }

  sendJson(res, mounted && dbOk ? 200 : 503, {
    status: mounted && dbOk ? 'healthy' : 'degraded',
    ram_disk: mounted,
    database: dbOk,
    uptime_seconds: Math.floor(process.uptime()),
  });
}

// ── Utilities ──────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ── Request router ─────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const method = req.method;
  const path = parsePath(req.url);

  // CORS (for any local tooling)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // Route
    if (method === 'POST' && path === '/store') {
      await handleStore(req, res);
    } else if (method === 'GET' && path === '/recall') {
      handleRecall(req, res);
    } else if (method === 'GET' && path === '/recent') {
      handleRecent(req, res);
    } else if (method === 'GET' && path.startsWith('/session/')) {
      handleSession(req, res);
    } else if (method === 'POST' && path === '/summarize') {
      await handleSummarize(req, res);
    } else if (method === 'GET' && path === '/stats') {
      handleStats(req, res);
    } else if (method === 'DELETE' && path === '/prune') {
      handlePrune(req, res);
    } else if (method === 'GET' && path === '/health') {
      handleHealth(req, res);
    } else {
      sendJson(res, 404, {
        error: 'Not found',
        endpoints: [
          'POST   /store        — store context entry',
          'GET    /recall?q=    — full-text search',
          'GET    /recent?n=    — recent entries',
          'GET    /session/:id  — session entries',
          'POST   /summarize    — compact old entries',
          'GET    /stats        — database statistics',
          'DELETE /prune        — remove old entries',
          'GET    /health       — health check',
        ],
      });
    }
  } catch (e) {
    console.error(`[${method} ${path}]`, e.message);
    sendJson(res, 500, { error: e.message });
  }
});

// ── Lifecycle ──────────────────────────────────────────────────

// Ensure RAM disk + DB exist
ensureRamDisk();

// Periodic backup
const backupTimer = setInterval(doBackup, BACKUP_INTERVAL_MS);

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[vcontext] Received ${signal}, shutting down...`);
  clearInterval(backupTimer);
  doBackup();
  server.close(() => {
    console.log('[vcontext] Server closed');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[vcontext] Virtual Context server running at http://127.0.0.1:${PORT}`);
  console.log(`[vcontext] Database: ${DB_PATH}`);
  console.log(`[vcontext] Backup every ${BACKUP_INTERVAL_MS / 1000}s to ${BACKUP_PATH}`);
  console.log('[vcontext] Endpoints:');
  console.log('  POST   /store        — store context entry');
  console.log('  GET    /recall?q=    — full-text search');
  console.log('  GET    /recent?n=    — recent entries');
  console.log('  GET    /session/:id  — session entries');
  console.log('  POST   /summarize    — compact old entries');
  console.log('  GET    /stats        — database statistics');
  console.log('  DELETE /prune        — remove old entries');
  console.log('  GET    /health       — health check');
});
