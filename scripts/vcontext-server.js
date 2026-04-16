#!/usr/bin/env node
/**
 * vcontext-server.js — Virtual Context REST API
 *
 * A local HTTP server (port 3150) that provides Claude Code with a
 * persistent "virtual memory" backed by SQLite + FTS5 on a RAM disk.
 *
 * Tiered storage: RAM (hot) → SSD (warm) → Cloud (cold, stub)
 *
 * Zero npm dependencies — uses Node.js built-in modules + sqlite3 CLI.
 *
 * Endpoints:
 *   POST   /store           — store a context entry
 *   GET    /recall          — full-text search (?q=keyword&type=&limit=10)
 *   GET    /recent          — recent entries (?n=20&type=)
 *   GET    /session/:id     — entries for a session
 *   POST   /summarize       — compact old entries into summaries
 *   GET    /stats           — database statistics
 *   DELETE /prune           — remove old entries (?older_than=7d)
 *   GET    /health          — health check
 *   POST   /tier/migrate    — manually trigger tier migration
 *   GET    /tier/stats      — per-tier statistics
 *   POST   /tier/config     — configure cloud provider
 *   POST   /resolve         — resolve conflicting decisions
 *   POST   /consult         — create multi-model consultation
 *   POST   /consult/:id/response — submit model response
 *   GET    /consult/:id     — check consultation status
 *   GET    /search/semantic — semantic similarity search (?q=text&limit=10&threshold=0.5)
 *   POST   /analytics/track — track usage event
 *   GET    /analytics/report — usage analytics report (?days=30)
 *   WS     /ws              — WebSocket real-time push notifications
 */

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.VCONTEXT_PORT || '3150', 10);
const MOUNT_POINT = '/Volumes/VContext';
const DB_PATH = join(MOUNT_POINT, 'vcontext.db');
const BACKUP_DIR = join(process.env.HOME, 'skills', 'data');
const BACKUP_PATH = join(BACKUP_DIR, 'vcontext-backup.sqlite');
const SSD_DB_PATH = join(BACKUP_DIR, 'vcontext-ssd.db');
const CLOUD_CONFIG_PATH = join(BACKUP_DIR, 'vcontext-cloud.json');
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WARN_SIZE_BYTES = 3 * 1024 * 1024 * 1024;     // 3 GB
const MAX_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024;     // 3.5 GB
// All hook event types + legacy types. Accept any non-empty string.
const LEGACY_TYPES = ['conversation', 'decision', 'observation', 'code', 'error'];
const isValidType = (t) => typeof t === 'string' && t.length > 0 && t.length < 100;
const NAMESPACE_TAG_PREFIX = 'project:';
// RAM→SSD migration: overflow-only.
// RAM is faster — keep everything in RAM until it's actually full.
// Only spill to SSD when RAM disk exceeds 85%. Below that, no migration.
// Promote from SSD back to RAM is always free (already implemented).
function getRamMigrateDays() {
  try {
    const s = require('node:fs').statSync(DB_PATH);
    const pct = s.size / (3.5 * 1024 * 1024 * 1024) * 100;
    if (pct < 85) return 999; // keep in RAM — plenty of room
    return 0; // overflow: migrate oldest entries to free space
  } catch { return 999; }
}
const RAM_TO_SSD_DAYS = getRamMigrateDays();
const SSD_TO_CLOUD_DAYS = 30;

// ── User identity ─────────────────────────────────────────────
import { userInfo, hostname } from 'node:os';
const LOCAL_USER = userInfo().username;
const LOCAL_HOST = hostname();
const LOCAL_USER_ID = `${LOCAL_USER}@${LOCAL_HOST}`;

// ── API Key auth (for cloud/remote access) ────────────────────
const API_KEYS_PATH = join(BACKUP_DIR, 'vcontext-api-keys.json');
function loadApiKeys() {
  try {
    const data = JSON.parse(readFileSync(API_KEYS_PATH, 'utf-8'));
    // Ensure groups object exists (backward compat)
    if (!data.groups) data.groups = {};
    if (!data.keys) data.keys = {};
    return data;
  } catch { return { keys: {}, groups: {} }; }
}
function saveApiKeys(data) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(API_KEYS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function validateApiKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!key) {
    // No key = local access, owner role with wildcard groups
    return { valid: true, userId: LOCAL_USER_ID, local: true, role: 'owner', groups: ['*'] };
  }
  const keys = loadApiKeys();
  const entry = keys.keys[key];
  if (!entry) return { valid: false, userId: null, local: false, role: null, groups: [] };
  return {
    valid: true,
    userId: entry.userId,
    local: false,
    role: entry.role || 'member',
    groups: entry.groups || [],
  };
}

// ── RBAC helpers ──────────────────────────────────────────────
const ROLES = ['viewer', 'member', 'admin', 'owner'];
const ROLE_LEVEL = { viewer: 0, member: 1, admin: 2, owner: 3 };

function hasRole(auth, minRole) {
  return (ROLE_LEVEL[auth.role] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

function canAccessGroup(auth, group) {
  if (auth.groups.includes('*')) return true; // owner sees all
  return auth.groups.includes(group);
}

function getAccessibleGroups(auth) {
  if (auth.groups.includes('*')) return null; // null = no filter (sees all)
  return auth.groups;
}

// ── SQLite helpers ─────────────────────────────────────────────

// In-process SQLite via better-sqlite3 (replaces execFileSync child processes)
const Database = require('better-sqlite3');
let ramDb, ssdDb;

function openDatabases() {
  ramDb = new Database(DB_PATH);
  ramDb.pragma('journal_mode = WAL');
  ramDb.pragma('busy_timeout = 5000');

  if (existsSync(SSD_DB_PATH)) {
    ssdDb = new Database(SSD_DB_PATH);
    ssdDb.pragma('journal_mode = WAL');
    ssdDb.pragma('busy_timeout = 5000');
  }
}

/**
 * Run a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE).
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbExec(sql, dbPath = DB_PATH) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = dbPath === DB_PATH ? ramDb : (dbPath === SSD_DB_PATH ? ssdDb : null);
      if (!db) {
        const tmpDb = new Database(dbPath);
        try {
          tmpDb.exec(sql);
        } finally {
          tmpDb.close();
        }
        return;
      }
      db.exec(sql);
      return;
    } catch (e) {
      if (e.message && e.message.includes('database is locked') && attempt < 2) {
        // busy_timeout should handle this, but retry as safety net
        continue;
      }
      console.error(`[db exec error @ ${dbPath}]`, e.message?.slice(0, 100));
      throw new Error(`SQLite exec error: ${e.message}`);
    }
  }
}

/**
 * Run a SQL query and return rows as a JS array.
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbQuery(sql, dbPath = DB_PATH) {
  try {
    const db = dbPath === DB_PATH ? ramDb : (dbPath === SSD_DB_PATH ? ssdDb : null);
    if (!db) {
      // Fallback for unknown paths - open temporarily
      const tmpDb = new Database(dbPath, { readonly: true });
      try {
        return tmpDb.prepare(sql).all();
      } finally {
        tmpDb.close();
      }
    }
    return db.prepare(sql).all();
  } catch (e) {
    if (e.message && e.message.includes('database is locked')) {
      // Retry once after short delay
      try {
        const db2 = dbPath === DB_PATH ? ramDb : ssdDb;
        if (db2) return db2.prepare(sql).all();
      } catch { return []; }
    }
    if (e.message && (e.message.includes('no such table') || e.message.includes('no such column'))) {
      return [];
    }
    // Legacy ENOBUFS/spawnSync errors no longer apply with in-process SQLite,
    // but keep this pattern for defensive error handling
    console.error(`[db query error @ ${dbPath}]`, e.message?.slice(0, 100));
    return [];
  }
}

/**
 * Escape a string for safe SQL embedding (single-quote doubling).
 */
function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

/** Sanitize query for FTS5 MATCH — strip chars that cause syntax errors */
function ftsQuery(q) {
  // Remove FTS5 operators and special chars, keep alphanumeric + spaces + CJK.
  // Period "." causes "syntax error near ." — must be stripped.
  return String(q).replace(/[<>\/\\(),;:!@#$%^&*+=\[\]{}|~`".'?-]/g, ' ').replace(/\s+/g, ' ').trim();
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

// ── Schema migration for tiered storage columns ───────────────
function migrateRamSchema() {
  // Enable WAL mode for better concurrent read/write (reduces "database is locked")
  try {
    dbExec("PRAGMA journal_mode=WAL;");
    dbExec("PRAGMA busy_timeout=5000;");
  } catch {}

  // Add tiered-storage columns if they do not already exist.
  // SQLite does not support ADD COLUMN IF NOT EXISTS, so we check
  // the table_info pragma first.
  try {
    const cols = dbQuery("PRAGMA table_info(entries);");
    const colNames = cols.map(c => c.name);

    if (!colNames.includes('last_accessed')) {
      dbExec("ALTER TABLE entries ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'));");
      console.log('[vcontext] Added last_accessed column to RAM DB');
    }
    if (!colNames.includes('access_count')) {
      dbExec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;");
      console.log('[vcontext] Added access_count column to RAM DB');
    }
    if (!colNames.includes('tier')) {
      dbExec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'ram';");
      console.log('[vcontext] Added tier column to RAM DB');
    }

    // Decision resolution metadata columns
    if (!colNames.includes('reasoning')) {
      dbExec("ALTER TABLE entries ADD COLUMN reasoning TEXT;");
      console.log('[vcontext] Added reasoning column to RAM DB');
    }
    if (!colNames.includes('conditions')) {
      dbExec("ALTER TABLE entries ADD COLUMN conditions TEXT;");
      console.log('[vcontext] Added conditions column to RAM DB');
    }
    if (!colNames.includes('supersedes')) {
      dbExec("ALTER TABLE entries ADD COLUMN supersedes INTEGER;");
      console.log('[vcontext] Added supersedes column to RAM DB');
    }
    if (!colNames.includes('confidence')) {
      dbExec("ALTER TABLE entries ADD COLUMN confidence TEXT DEFAULT 'medium';");
      console.log('[vcontext] Added confidence column to RAM DB');
    }
    if (!colNames.includes('status')) {
      dbExec("ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'active';");
      console.log('[vcontext] Added status column to RAM DB');
    }
    if (!colNames.includes('embedding')) {
      dbExec("ALTER TABLE entries ADD COLUMN embedding TEXT;");
      console.log('[vcontext] Added embedding column to RAM DB');
    }

    // Back-fill last_accessed (small batch to avoid ENOBUFS)
    try { dbExec("UPDATE entries SET last_accessed = created_at WHERE last_accessed IS NULL LIMIT 100;"); } catch {}
  } catch (e) {
    console.error('[vcontext] Schema migration for RAM DB failed:', e.message?.slice(0, 80));
  }

  // Analytics table for usage tracking
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      skill_name TEXT,
      session TEXT,
      user_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_analytics_skill ON analytics(skill_name);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event_type);`);
  } catch {}

  // Lightweight metadata index — avoids parsing raw JSON on every search
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS entry_index (
      entry_id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      session TEXT,
      tool_name TEXT,
      file_path TEXT,
      command TEXT,
      token_estimate INTEGER DEFAULT 0,
      has_embedding INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_type ON entry_index(type);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_session ON entry_index(session);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_tool ON entry_index(tool_name);`);
  } catch {}

  // Per-request API metrics
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS api_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      request_chars INTEGER DEFAULT 0,
      response_chars INTEGER DEFAULT 0,
      estimated_tokens_in INTEGER DEFAULT 0,
      estimated_tokens_out INTEGER DEFAULT 0,
      result_count INTEGER DEFAULT 0,
      used_ids TEXT,
      task_kind TEXT,
      session TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_am_op ON api_metrics(operation);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_am_created ON api_metrics(created_at);`);
  } catch {}

  // Backfill entry_index (small batch to avoid ENOBUFS at startup)
  try { backfillIndex(50); } catch {}
}

// ── SSD database initialisation ───────────────────────────────
function ensureSsdDb() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  if (!existsSync(SSD_DB_PATH)) {
    console.log('[vcontext] Creating SSD database at', SSD_DB_PATH);
    const schema = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  session TEXT,
  token_estimate INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT DEFAULT (datetime('now')),
  access_count INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'ssd',
  reasoning TEXT,
  conditions TEXT,
  supersedes INTEGER,
  confidence TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'active',
  embedding TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  content,
  tags,
  content=entries,
  content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
  INSERT INTO entries_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
`;
    dbExec(schema, SSD_DB_PATH);
    dbExec("PRAGMA journal_mode=WAL;", SSD_DB_PATH);
    dbExec("PRAGMA busy_timeout=5000;", SSD_DB_PATH);
    console.log('[vcontext] SSD database initialised');
  } else {
    // Enable WAL on existing SSD DB
    try { dbExec("PRAGMA journal_mode=WAL;", SSD_DB_PATH); } catch {}
    try { dbExec("PRAGMA busy_timeout=5000;", SSD_DB_PATH); } catch {}
    // Ensure tiered columns exist in SSD DB too
    try {
      const cols = dbQuery("PRAGMA table_info(entries);", SSD_DB_PATH);
      const colNames = cols.map(c => c.name);
      if (!colNames.includes('last_accessed')) {
        dbExec("ALTER TABLE entries ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'));", SSD_DB_PATH);
      }
      if (!colNames.includes('access_count')) {
        dbExec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;", SSD_DB_PATH);
      }
      if (!colNames.includes('tier')) {
        dbExec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'ssd';", SSD_DB_PATH);
      }
      // Decision resolution metadata columns
      if (!colNames.includes('reasoning')) {
        dbExec("ALTER TABLE entries ADD COLUMN reasoning TEXT;", SSD_DB_PATH);
      }
      if (!colNames.includes('conditions')) {
        dbExec("ALTER TABLE entries ADD COLUMN conditions TEXT;", SSD_DB_PATH);
      }
      if (!colNames.includes('supersedes')) {
        dbExec("ALTER TABLE entries ADD COLUMN supersedes INTEGER;", SSD_DB_PATH);
      }
      if (!colNames.includes('confidence')) {
        dbExec("ALTER TABLE entries ADD COLUMN confidence TEXT DEFAULT 'medium';", SSD_DB_PATH);
      }
      if (!colNames.includes('status')) {
        dbExec("ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'active';", SSD_DB_PATH);
      }
      if (!colNames.includes('embedding')) {
        dbExec("ALTER TABLE entries ADD COLUMN embedding TEXT;", SSD_DB_PATH);
      }
    } catch (e) {
      console.error('[vcontext] SSD schema migration failed:', e.message);
    }
  }

  // Ensure index + metrics tables exist on SSD too
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS entry_index (
      entry_id INTEGER PRIMARY KEY, type TEXT NOT NULL, session TEXT,
      tool_name TEXT, file_path TEXT, command TEXT,
      token_estimate INTEGER DEFAULT 0, has_embedding INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`, SSD_DB_PATH);
    dbExec(`CREATE TABLE IF NOT EXISTS api_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL,
      latency_ms REAL NOT NULL, request_chars INTEGER DEFAULT 0,
      response_chars INTEGER DEFAULT 0, estimated_tokens_in INTEGER DEFAULT 0,
      estimated_tokens_out INTEGER DEFAULT 0, result_count INTEGER DEFAULT 0,
      used_ids TEXT, task_kind TEXT, session TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`, SSD_DB_PATH);
  } catch {}
}

// ── Cloud store (stub) ────────────────────────────────────────
function loadCloudConfig() {
  try {
    if (existsSync(CLOUD_CONFIG_PATH)) {
      return JSON.parse(readFileSync(CLOUD_CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

const cloudStore = {
  /** Upload entries to cloud storage (stub). */
  upload(entries) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) {
      console.log('[vcontext:cloud] Cloud not configured — skipping upload of', entries.length, 'entries');
      return { uploaded: 0, error: 'Cloud not configured' };
    }
    // Future: actual S3/GCS/R2 upload
    console.log(`[vcontext:cloud] Would upload ${entries.length} entries to ${cfg.provider}://${cfg.bucket}/${cfg.prefix || ''}`);
    return { uploaded: 0, error: 'Cloud upload not yet implemented' };
  },

  /** Search cloud storage (stub). */
  search(query, limit) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) return [];
    // Future: actual search against cloud index
    console.log(`[vcontext:cloud] Would search cloud for "${query}" limit=${limit}`);
    return [];
  },

  /** Download entries from cloud by IDs (stub). */
  download(ids) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) return [];
    console.log(`[vcontext:cloud] Would download ${ids.length} entries from cloud`);
    return [];
  },

  /** Check whether cloud is configured. */
  isConfigured() {
    const cfg = loadCloudConfig();
    return !!(cfg && cfg.provider);
  },
};

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
    if (existsSync(DB_PATH) && ramDb) {
      // better-sqlite3 backup() returns a Promise; fire-and-forget with error logging
      ramDb.backup(BACKUP_PATH)
        .then(() => console.log(`[vcontext] Backup complete: ${BACKUP_PATH}`))
        .catch((err) => {
          console.error('[vcontext] Async backup failed:', err.message);
          try {
            copyFileSync(DB_PATH, BACKUP_PATH);
            console.log('[vcontext] Backup (file copy fallback) complete');
          } catch (e2) {
            console.error('[vcontext] Fallback backup also failed:', e2.message);
          }
        });
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

// ── Index + Metrics helpers ─────────────────────────────────────

function extractIndexFields(content) {
  try {
    const d = JSON.parse(content);
    return {
      tool_name: d.tool_name || null,
      file_path: (d.tool_input && d.tool_input.file_path) || d.file_path || null,
      command: (d.tool_input && d.tool_input.command) || d.command || null,
    };
  } catch { return { tool_name: null, file_path: null, command: null }; }
}

function insertIndex(entryId, type, session, content, tokenEst, hasEmbedding) {
  try {
    const f = extractIndexFields(content);
    dbExec(`INSERT OR REPLACE INTO entry_index (entry_id, type, session, tool_name, file_path, command, token_estimate, has_embedding, created_at) VALUES (${Number(entryId)}, ${esc(type)}, ${esc(session)}, ${esc(f.tool_name)}, ${esc(f.file_path)}, ${esc(f.command)}, ${tokenEst || 0}, ${hasEmbedding ? 1 : 0}, datetime('now'));`);
  } catch {}
}

function recordMetric({ operation, startTime, requestChars, responseChars, resultCount, usedIds, taskKind, session }) {
  setImmediate(() => {
    try {
      const latency = Date.now() - startTime;
      const tokIn = estimateTokens(String(requestChars || ''));
      const tokOut = estimateTokens(String(responseChars || ''));
      dbExec(`INSERT INTO api_metrics (operation, latency_ms, request_chars, response_chars, estimated_tokens_in, estimated_tokens_out, result_count, used_ids, task_kind, session) VALUES (${esc(operation)}, ${latency}, ${requestChars || 0}, ${responseChars || 0}, ${tokIn}, ${tokOut}, ${resultCount || 0}, ${esc(usedIds || null)}, ${esc(taskKind || null)}, ${esc(session || null)});`);
    } catch {}
  });
}

function backfillIndex(batchSize) {
  try {
    const missing = dbQuery(`SELECT e.id, e.type, e.session, e.content, e.token_estimate, e.embedding FROM entries e LEFT JOIN entry_index ei ON e.id = ei.entry_id WHERE ei.entry_id IS NULL ORDER BY e.id ASC LIMIT ${batchSize};`);
    for (const row of missing) {
      const f = extractIndexFields(row.content || '');
      dbExec(`INSERT OR IGNORE INTO entry_index (entry_id, type, session, tool_name, file_path, command, token_estimate, has_embedding, created_at) VALUES (${row.id}, ${esc(row.type)}, ${esc(row.session)}, ${esc(f.tool_name)}, ${esc(f.file_path)}, ${esc(f.command)}, ${row.token_estimate || 0}, ${row.embedding ? 1 : 0}, datetime('now'));`);
    }
    if (missing.length > 0) console.log(`[vcontext:index] Backfilled ${missing.length} entries`);
  } catch {}
}

// ── Access tracking ────────────────────────────────────────────
/**
 * Update last_accessed and increment access_count for given entry IDs.
 * @param {number[]} ids
 * @param {string} [dbPath=DB_PATH]
 */
function touchEntries(ids, dbPath = DB_PATH) {
  if (!ids || ids.length === 0) return;
  try {
    dbExec(
      `UPDATE entries SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id IN (${ids.join(',')});`,
      dbPath,
    );
  } catch (e) {
    console.error('[vcontext] touchEntries failed:', e.message);
  }
}

// ── Tier migration logic ──────────────────────────────────────

/**
 * Move cold entries from RAM → SSD.
 * Returns the count of moved entries.
 */
function migrateRamToSsd() {
  // Prepared-statement version — eliminates string-concat SQL injection
  // class of bugs (previously "near '01'" / "SQL logic error" when
  // supersedes had weird values). Batches in a transaction for speed.
  try {
    if (!ramDb || !ssdDb) return 0;
    const staleRows = ramDb.prepare(
      `SELECT id, type, content, tags, session, token_estimate, created_at, last_accessed, access_count, reasoning, conditions, supersedes, confidence, status, content_hash FROM entries WHERE last_accessed < datetime('now', ?) ORDER BY last_accessed ASC LIMIT 500;`
    ).all(`-${RAM_TO_SSD_DAYS} days`);
    if (staleRows.length === 0) return 0;

    const insert = ssdDb.prepare(
      `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ssd', ?, ?, ?, ?, ?, ?)`
    );
    const del = ramDb.prepare(`DELETE FROM entries WHERE id = ?`);

    const migrate = ssdDb.transaction((rows) => {
      let ok = 0;
      for (const r of rows) {
        try {
          // Normalise numeric/nullable fields so the bound parameters match
          // the column types. Integer columns get null (not '').
          const tok = Number.isFinite(+r.token_estimate) ? +r.token_estimate : 0;
          const acc = Number.isFinite(+r.access_count) ? +r.access_count : 0;
          const sup = (r.supersedes != null && r.supersedes !== '' && Number.isFinite(+r.supersedes))
            ? +r.supersedes : null;
          insert.run(
            r.type, r.content, r.tags || '[]', r.session || null,
            tok, r.created_at, r.last_accessed, acc,
            r.reasoning || null, r.conditions || null, sup,
            r.confidence || 'medium', r.status || 'active',
            r.content_hash || null
          );
          ok++;
        } catch (rowErr) {
          console.error(`[vcontext:tier] skip id=${r.id} type=${r.type}: ${rowErr.message}`);
        }
      }
      return ok;
    });

    const migratedCount = migrate(staleRows);
    if (migratedCount > 0) {
      // Delete migrated rows from RAM. FTS triggers can fail on corrupt
      // indexes ("SQL logic error"); in that case, fall back to soft-delete
      // by marking status='migrated' so subsequent queries skip them and
      // the next maintenance rebuilds FTS. Bound by per-id try/catch so
      // one broken FTS entry doesn't abort the whole batch.
      const softMark = ramDb.prepare(`UPDATE entries SET status='migrated' WHERE id = ?`);
      let hardDel = 0, softDel = 0;
      for (const r of staleRows.slice(0, migratedCount)) {
        try {
          del.run(r.id);
          hardDel++;
        } catch {
          try { softMark.run(r.id); softDel++; } catch {}
        }
      }
      console.log(`[vcontext:tier] RAM cleanup: ${hardDel} deleted, ${softDel} soft-marked (FTS issue)`);
    }
    console.log(`[vcontext:tier] Migrated ${migratedCount}/${staleRows.length} entries RAM → SSD`);
    return migratedCount;
  } catch (e) {
    console.error('[vcontext:tier] RAM→SSD migration error:', e.message, e.stack?.split('\n')[1]);
    return 0;
  }
}

/**
 * Move cold entries from SSD → Cloud (if configured).
 * Returns the count of moved entries.
 */
function migrateSsdToCloud() {
  if (!cloudStore.isConfigured()) return 0;
  try {
    const staleRows = dbQuery(
      `SELECT * FROM entries WHERE last_accessed < datetime('now', '-${SSD_TO_CLOUD_DAYS} days') ORDER BY last_accessed ASC;`,
      SSD_DB_PATH,
    );
    if (staleRows.length === 0) return 0;

    const result = cloudStore.upload(staleRows);
    if (result.error) {
      console.log('[vcontext:tier] Cloud upload not ready:', result.error);
      return 0;
    }

    // Only delete from SSD if upload succeeded
    const ids = staleRows.map(r => r.id).join(',');
    dbExec(`DELETE FROM entries WHERE id IN (${ids});`, SSD_DB_PATH);

    console.log(`[vcontext:tier] Migrated ${staleRows.length} entries SSD → Cloud`);
    return staleRows.length;
  } catch (e) {
    console.error('[vcontext:tier] SSD→Cloud migration error:', e.message);
    return 0;
  }
}

/**
 * Auto-promote: copy an entry found in SSD/Cloud back to RAM for fast access.
 * @param {object[]} rows - rows from a lower tier to promote
 * @param {string} sourceTier - 'ssd' or 'cloud'
 */
function promoteToRam(rows, sourceTier) {
  if (!rows || rows.length === 0 || !ramDb) return;
  const existsStmt = ramDb.prepare(
    `SELECT id FROM entries WHERE created_at = ? AND type = ? AND content = ? LIMIT 1`
  );
  const insertStmt = ramDb.prepare(
    `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 'ram', ?, ?, ?, ?, ?, ?)`
  );
  const crypto = require('node:crypto');
  let promoted = 0;
  for (const r of rows) {
    try {
      if (existsStmt.get(r.created_at, r.type, r.content)) continue;
      const tok = Number.isFinite(+r.token_estimate) ? +r.token_estimate : 0;
      const acc = Number.isFinite(+r.access_count) ? +r.access_count : 0;
      const sup = (r.supersedes != null && r.supersedes !== '' && Number.isFinite(+r.supersedes))
        ? +r.supersedes : null;
      const hash = r.content_hash || crypto.createHash('sha256').update(String(r.content)).digest('hex');
      insertStmt.run(
        r.type, r.content, r.tags || '[]', r.session || null,
        tok, r.created_at, acc + 1,
        r.reasoning || null, r.conditions || null, sup,
        r.confidence || 'medium', r.status || 'active',
        hash
      );
      promoted++;
    } catch (e) {
      console.error(`[vcontext:tier] promote skip id=${r.id || '?'} type=${r.type || '?'}: ${e.message}`);
    }
  }
  if (promoted > 0) console.log(`[vcontext:tier] Promoted ${promoted}/${rows.length} from ${sourceTier} → RAM`);
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

/**
 * Parse tags JSON safely.
 */
function parseTags(rows) {
  for (const row of rows) {
    try { row.tags = JSON.parse(row.tags); } catch { /* keep as string */ }
  }
}

// ── Route handlers ─────────────────────────────────────────────

/**
 * POST /store
 * Body: { type, content, tags?, session?, reasoning?, conditions?, supersedes?, confidence?, status? }
 */
async function handleStore(req, res) {
  const _startTime = Date.now();
  // Auth check
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Write permission: viewer cannot store
  if (!hasRole(auth, 'member')) {
    return sendJson(res, 403, { error: 'Viewers cannot store entries. Requires member role or above.' });
  }

  const sizeCheck = checkDbSize();
  if (!sizeCheck.ok) {
    return sendJson(res, 507, { error: sizeCheck.msg });
  }

  const body = await readBody(req);
  const { type, content, tags, session, namespace } = body;
  // Decision resolution metadata (all optional)
  const reasoning = body.reasoning || null;
  const conditions = body.conditions || null;
  const supersedes = (body.supersedes != null && Number.isFinite(Number(body.supersedes))) ? Number(body.supersedes) : null;
  const confidence = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : 'medium';
  const status = ['active', 'deprecated', 'temporary', 'experimental'].includes(body.status) ? body.status : 'active';

  if (!type || !content) {
    return sendJson(res, 400, { error: 'Missing required fields: type, content' });
  }
  if (!isValidType(type)) {
    return sendJson(res, 400, { error: 'Invalid type. Must be a non-empty string.' });
  }

  // Global dedup via content_hash + UNIQUE index (atomic, race-free).
  // Migration path: after /admin/dedup-migration has added the column
  // and index, any duplicate INSERT collides with the UNIQUE constraint
  // and we return the existing row. Skip types where repetition is
  // legitimate (periodic heartbeats, test entries).
  const DEDUP_SKIP = new Set(['test', 'working-state', 'session-recall', 'anomaly-alert']);
  let contentHash = null;
  if (!DEDUP_SKIP.has(type)) {
    try {
      const crypto = require('node:crypto');
      contentHash = crypto.createHash('sha256').update(String(content)).digest('hex');
      // If the hash already exists for this (session, type), return it.
      const dup = dbQuery(
        `SELECT id FROM entries WHERE session = ${esc(session || '')} AND type = ${esc(type)} AND content_hash = ${esc(contentHash)} LIMIT 1;`
      );
      if (dup.length > 0) {
        return sendJson(res, 200, { ok: true, deduped: true, existing_id: dup[0].id });
      }
    } catch {}
  }

  // Group permission check for non-owner: can only store to own groups
  const targetGroup = body.group || (auth.groups[0] !== '*' ? auth.groups[0] : null);
  if (targetGroup && !hasRole(auth, 'owner') && !canAccessGroup(auth, targetGroup)) {
    return sendJson(res, 403, { error: `Cannot store to group '${targetGroup}'. Not a member of this group.` });
  }

  // Auto-inject namespace and user identity as tags
  const tagList = Array.isArray(tags) ? [...tags] : [];
  if (namespace) {
    const nsTag = NAMESPACE_TAG_PREFIX + namespace;
    if (!tagList.includes(nsTag)) tagList.push(nsTag);
  }
  const userTag = `user:${auth.userId}`;
  if (!tagList.includes(userTag)) tagList.push(userTag);
  // Auto-inject group tag
  if (targetGroup) {
    const groupTag = `group:${targetGroup}`;
    if (!tagList.includes(groupTag)) tagList.push(groupTag);
  }
  const tagsJson = JSON.stringify(tagList);
  const tokenEst = estimateTokens(content);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  // INSERT OR IGNORE so the UNIQUE(session,type,content_hash) index can
  // atomically reject duplicates at the DB level (race-free). Includes
  // content_hash column populated above when dedup is active.
  const hashSql = contentHash ? esc(contentHash) : 'NULL';
  const sql = `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst}, datetime('now'), 0, 'ram', ${esc(reasoning)}, ${esc(conditions)}, ${supersedes === null ? 'NULL' : supersedes}, ${esc(confidence)}, ${esc(status)}, ${hashSql});`;
  dbExec(sql);

  // Get the inserted row
  const rows = dbQuery('SELECT * FROM entries ORDER BY id DESC LIMIT 1;');
  const entry = rows[0] || {};

  // Index this entry
  insertIndex(entry.id, type, session, content, tokenEst, 0);

  // Write-through: immediately sync to SSD for crash safety
  try {
    const ssdSql = `INSERT OR REPLACE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst}, ${esc(entry.created_at || now)}, ${esc(entry.created_at || now)}, 0, 'ssd', ${esc(reasoning)}, ${esc(conditions)}, ${supersedes === null ? 'NULL' : supersedes}, ${esc(confidence)}, ${esc(status)});`;
    dbExec(ssdSql, SSD_DB_PATH);
  } catch (e) {
    // SSD write failure is non-fatal, log but don't block
    console.error('[write-through] SSD sync failed:', e.message);
  }

  // Auto-summarize with MLX generate (24/7)
  if (mlxGenerateAvailable && content.length > 200) {
    setImmediate(async () => {
      try {
        const summary = await mlxGenerate(
          `Summarize this in one sentence (max 50 words). Output ONLY the summary, nothing else:\n\n${content.slice(0, 2000)}`,
          { maxTokens: 4000 }
        );
        if (summary && summary.length > 5) {
          dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${entry.id} AND reasoning IS NULL;`);
        }
      } catch {} // Non-fatal
    });
  }

  // Generate embedding with MLX.
  // Skip ephemeral / high-volume types from the start — they flood the
  // embed worker with no semantic-search benefit (they rely on FTS).
  // Old behaviour pruned after 1d, but still queued them first which
  // displaced useful work. Backlog was growing 500+/h.
  // Embed EVERYTHING. Measured throughput: 268ms/embed × 8.8K writes/day
  // = 40 min/day MLX work (~2.7% load). The semantic graph is the AI
  // OS's main value proposition — skipping types cripples cross-type
  // recall, workflow inference, and anomaly detection. Empty set =
  // embed all (handler still skips empty content).
  const NO_EMBED_TYPES = new Set();
  if (mlxAvailable && !NO_EMBED_TYPES.has(type)) {
    setImmediate(async () => {
      try {
        let embedding = null;
        try {
          embedding = await mlxEmbed(content.slice(0, 1000));
        } catch (e) {
          console.log(`[store] MLX embed failed: ${e.message}`);
        }
        if (embedding && embedding.length > 0) {
          const embJson = esc(JSON.stringify(embedding));
          dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${entry.id};`);
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${entry.id};`, SSD_DB_PATH); } catch {}
          vecUpsert(entry.id, embedding);
          try { dbExec(`UPDATE entry_index SET has_embedding = 1 WHERE entry_id = ${entry.id};`); } catch {}
        }
      } catch {} // Non-fatal
    });
  }

  if (sizeCheck.msg) {
    entry._warning = sizeCheck.msg;
  }

  // Auto-conflict detection for decision entries
  if (type === 'decision') {
    try {
      // Search for potentially conflicting decisions
      const keywords = content.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(' ');
      if (keywords.length > 5) {
        const existing = dbQuery(
          `SELECT e.id, e.content, e.conditions, e.status, e.confidence
           FROM entries_fts fts JOIN entries e ON e.id = fts.rowid
           WHERE entries_fts MATCH ${esc(ftsQuery(keywords))}
           AND e.type = 'decision' AND e.status = 'active' AND e.id != ${entry.id}
           LIMIT 5;`
        );
        if (existing.length > 0) {
          entry._conflicts = {
            count: existing.length,
            entries: existing.map(e => ({ id: e.id, content: e.content.slice(0, 100), conditions: e.conditions })),
            resolve_hint: `POST /resolve with candidates [${entry.id}, ${existing.map(e => e.id).join(', ')}] to evaluate which applies`,
          };

          // Auto-create consultation for conflicting decisions
          try {
            const conflictIds = [entry.id, ...existing.map(e => e.id)];
            const consultId = `auto_${Date.now()}`;
            const candidates = conflictIds.map(id => {
              const rows = dbQuery(`SELECT * FROM entries WHERE id = ${id};`);
              return rows[0] || null;
            }).filter(Boolean);

            // Build consultation
            const candidateText = candidates.map((c, i) =>
              `[${i+1}] (${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})\nContent: ${c.content}\nReasoning: ${c.reasoning || 'not recorded'}\nConditions: ${c.conditions || 'not recorded'}`
            ).join('\n\n');

            const basePrompt = `Evaluate these conflicting decisions. Context: ${conditions || content}\n\n${candidateText}\n\nRespond ONLY with JSON: {"chosen":<1-N>,"reasoning":"<why>","confidence":"high|medium|low"}`;

            const autoModels = ['claude', 'codex'];
            const autoPackages = {};
            for (const model of autoModels) {
              autoPackages[model] = { prompt: basePrompt };
            }

            const consultation = {
              id: consultId,
              consultationId: consultId,
              query: content,
              context: conditions || '',
              candidates,
              models: autoModels,
              packages: autoPackages,
              responses: {},
              consensus: null,
              status: 'pending_responses',
              created_at: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              auto: true,
            };

            consultations.set(consultId, consultation);
            entry._auto_consultation = consultId;

            // If MLX generate available, auto-resolve immediately
            if (mlxGenerateAvailable) {
              setImmediate(async () => {
                try {
                  const aiResponse = await mlxGenerate(basePrompt, { maxTokens: 4000, temperature: 0.1 });
                  if (aiResponse) {
                    try {
                      const aiParsed = JSON.parse(aiResponse);
                      // Store as 'local' model response
                      consultation.responses['local'] = {
                        chosen: aiParsed.chosen,
                        reasoning: aiParsed.reasoning || aiResponse.slice(0, 200),
                        confidence: aiParsed.confidence || 'medium',
                        responded_at: new Date().toISOString(),
                        model_used: MLX_GENERATE_MODEL,
                      };
                      // Add 'local' to models if not there
                      if (!consultation.models.includes('local')) consultation.models.push('local');
                      console.log(`[mlx-generate] Auto-resolved consultation ${consultId}: chose ${aiParsed.chosen}`);
                      wsBroadcast('consultation_updated', { consultation_id: consultId, local_response: consultation.responses['local'] });
                    } catch {
                      // Response wasn't valid JSON, store raw
                      consultation.responses['local'] = {
                        chosen: null,
                        reasoning: aiResponse.slice(0, 200),
                        confidence: 'low',
                        responded_at: new Date().toISOString(),
                        model_used: aiModel,
                      };
                    }
                  }
                } catch {} // Non-fatal
              });
            }

            // Broadcast to WebSocket clients
            wsBroadcast('consultation_request', {
              consultation_id: consultId,
              query: content,
              candidate_count: candidates.length,
              prompt: basePrompt,
            });
          } catch (e) {
            console.error('[auto-consult] Failed to create:', e.message);
          }
        }
      }
    } catch {} // Non-fatal
  }

  sendJson(res, 201, { stored: entry });
  recordMetric({ operation: 'store', startTime: _startTime, requestChars: content.length, responseChars: JSON.stringify(entry).length, resultCount: 1, taskKind: type, session });

  // Broadcast to WebSocket clients
  wsBroadcast('new_entry', entry);
  if (entry._conflicts) {
    wsBroadcast('conflict_detected', { ...entry, _conflicts: entry._conflicts });
  }
}

/**
 * GET /recall?q=keyword&type=conversation&limit=10
 * Searches all tiers: RAM → SSD → Cloud (if configured)
 */
async function handleRecall(req, res) {
  const _startTime = Date.now();
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const q = params.q;
  if (!q) {
    return sendJson(res, 400, { error: 'Missing query parameter: q' });
  }

  const limit = Math.min(parseInt(params.limit) || 10, 100);
  const type = params.type;
  const namespace = params.namespace; // filter by project:xxx
  const userFilter = params.user || (params.my === 'true' ? auth.userId : null);
  // Auto-filter by accessible groups (unless owner)
  const accessibleGroups = getAccessibleGroups(auth);
  const allResults = [];
  const seenIds = new Map(); // created_at+content → true (for cross-tier dedup)

  // --- Tier 1: RAM ---
  const ramResults = searchTier(DB_PATH, q, type, limit, namespace, userFilter, accessibleGroups);
  for (const row of ramResults) {
    row._tier = 'ram';
    const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
    seenIds.set(key, true);
    allResults.push(row);
  }
  // Touch accessed entries in RAM
  touchEntries(ramResults.map(r => r.id), DB_PATH);

  // --- Tier 2: SSD (if still need more results) ---
  if (allResults.length < limit) {
    const ssdLimit = limit - allResults.length;
    const ssdResults = searchTier(SSD_DB_PATH, q, type, ssdLimit, namespace, userFilter, accessibleGroups);
    const promoted = [];
    for (const row of ssdResults) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'ssd';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    // Touch accessed entries in SSD
    touchEntries(ssdResults.map(r => r.id), SSD_DB_PATH);
    // Auto-promote SSD hits to RAM
    if (promoted.length > 0) {
      promoteToRam(promoted, 'ssd');
    }
  }

  // --- Tier 3: Cloud (if configured and still need more) ---
  if (allResults.length < limit && cloudStore.isConfigured()) {
    const cloudLimit = limit - allResults.length;
    const cloudResults = cloudStore.search(q, cloudLimit);
    const promoted = [];
    for (const row of cloudResults) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'cloud';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    if (promoted.length > 0) {
      promoteToRam(promoted, 'cloud');
    }
  }

  // --- Semantic boost: if FTS returned few results, supplement with vector search ---
  if (allResults.length < limit && mlxAvailable && vecDb) {
    try {
      const queryEmbed = await mlxEmbed(q.slice(0, 500));
      if (queryEmbed && queryEmbed.length > 0) {
        const vecResults = vecSearch(queryEmbed, limit * 2);
        const vecIds = vecResults
          .filter(v => v.distance < 2.0) // reasonable threshold
          .map(v => v.rowid)
          .filter(id => !allResults.some(r => r.id === id));
        if (vecIds.length > 0) {
          const needed = limit - allResults.length;
          const idList = vecIds.slice(0, needed).join(',');
          const typeFilter2 = type && isValidType(type) ? ` AND type = ${esc(type)}` : '';
          const semanticRows = dbQuery(`SELECT *, 'semantic' as _match FROM entries WHERE id IN (${idList})${typeFilter2};`);
          for (const row of semanticRows) {
            row._tier = 'ram';
            row._semantic = true;
            allResults.push(row);
          }
        }
      }
    } catch {} // Non-fatal: semantic is a bonus
  }

  parseTags(allResults);

  // Context budget: caller can pass &budget=N (token estimate cap).
  // We rank by score = freshness*0.3 + tier*0.2 + recency-of-access*0.2 +
  // length-penalty*0.3, then prune from the bottom until under budget.
  const budget = parseInt(params.budget, 10) || 0;
  if (budget > 0 && allResults.length > 0) {
    const now = Date.now();
    const scored = allResults.map(r => {
      const ageDays = Math.max(0.1, (now - Date.parse((r.created_at || '').replace(' ', 'T') + 'Z')) / 86400000);
      const accessAgeDays = r.last_accessed
        ? Math.max(0.1, (now - Date.parse(r.last_accessed.replace(' ', 'T') + 'Z')) / 86400000)
        : ageDays;
      const tierWeight = r._tier === 'ram' ? 1.0 : r._tier === 'ssd' ? 0.7 : 0.4;
      const lenPenalty = 1 / Math.log2(2 + (r.token_estimate || 100));
      const score = (1/ageDays)*0.3 + tierWeight*0.2 + (1/accessAgeDays)*0.2 + lenPenalty*0.3;
      return { ...r, _score: score };
    }).sort((a, b) => b._score - a._score);
    let used = 0;
    const kept = [];
    for (const r of scored) {
      const cost = r.token_estimate || 100;
      if (used + cost > budget) break;
      kept.push(r);
      used += cost;
    }
    sendJson(res, 200, { results: kept, count: kept.length, query: q, budget, used_tokens: used, dropped: allResults.length - kept.length });
    recordMetric({ operation: 'recall', startTime: _startTime, requestChars: (q || '').length, responseChars: JSON.stringify(kept).length, resultCount: kept.length, usedIds: JSON.stringify(kept.map(r => r.id)), taskKind: 'search' });
    return;
  }

  sendJson(res, 200, { results: allResults, count: allResults.length, query: q });
  recordMetric({ operation: 'recall', startTime: _startTime, requestChars: (q || '').length, responseChars: JSON.stringify(allResults).length, resultCount: allResults.length, usedIds: JSON.stringify(allResults.map(r => r.id)), taskKind: 'search' });
}

/**
 * Search a single tier's database using FTS5, with LIKE fallback.
 * @param {string} dbPath
 * @param {string} q - search query
 * @param {string} type - entry type filter
 * @param {number} limit
 * @param {string} namespace - project namespace filter
 * @param {string} userFilter - user identity filter
 * @param {string[]|null} accessibleGroups - null = no filter (owner), array = restrict to these groups
 */
function searchTier(dbPath, q, type, limit, namespace, userFilter, accessibleGroups) {
  if (!existsSync(dbPath)) return [];
  const typeFilter = type && isValidType(type) ? ` AND e.type = ${esc(type)}` : '';
  const nsFilter = namespace ? ` AND e.tags LIKE ${esc('%project:' + namespace + '%')}` : '';
  const userFlt = userFilter ? ` AND e.tags LIKE ${esc('%user:' + userFilter + '%')}` : '';
  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      // No groups at all — can only see entries without group tags
      groupFilter = ` AND e.tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `e.tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (e.tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }

  // Skip soft-migrated rows — they've moved to SSD tier but couldn't be
  // hard-deleted due to FTS issues. The SSD tier query will return the
  // real copy.
  const migrateFilter = ` AND (e.status IS NULL OR e.status != 'migrated')`;

  const ftsSql = `SELECT e.*, rank
    FROM entries_fts fts
    JOIN entries e ON e.id = fts.rowid
    WHERE entries_fts MATCH ${esc(ftsQuery(q))}${typeFilter}${nsFilter}${userFlt}${groupFilter}${migrateFilter}
    ORDER BY rank * 0.7 + (julianday(e.created_at) - julianday('2024-01-01')) * 0.3
    LIMIT ${limit};`;

  try {
    return dbQuery(ftsSql, dbPath);
  } catch {
    // FTS query syntax error — fall back to LIKE search
    const likeSql = `SELECT * FROM entries WHERE content LIKE ${esc('%' + q + '%')}${typeFilter}${nsFilter}${userFlt}${groupFilter.replace(/e\./g, '')} AND (status IS NULL OR status != 'migrated') ORDER BY created_at DESC LIMIT ${limit};`;
    try {
      return dbQuery(likeSql, dbPath);
    } catch {
      return [];
    }
  }
}

/**
 * GET /recent?n=20&type=conversation
 * Cascading across tiers.
 */
function handleRecent(req, res) {
  const _startTime = Date.now();
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const n = Math.min(parseInt(params.n) || 20, 200);
  const type = params.type;
  const namespace = params.namespace;
  // Auto-filter by accessible groups (unless owner)
  const accessibleGroups = getAccessibleGroups(auth);
  const allResults = [];
  const seenIds = new Map();

  // --- Tier 1: RAM ---
  const ramRows = recentFromTier(DB_PATH, type, n, namespace, accessibleGroups);
  for (const row of ramRows) {
    row._tier = 'ram';
    const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
    seenIds.set(key, true);
    allResults.push(row);
  }
  touchEntries(ramRows.map(r => r.id), DB_PATH);

  // --- Tier 2: SSD ---
  if (allResults.length < n) {
    const ssdLimit = n - allResults.length;
    const ssdRows = recentFromTier(SSD_DB_PATH, type, ssdLimit, namespace, accessibleGroups);
    const promoted = [];
    for (const row of ssdRows) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'ssd';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    touchEntries(ssdRows.map(r => r.id), SSD_DB_PATH);
    if (promoted.length > 0) {
      promoteToRam(promoted, 'ssd');
    }
  }

  // --- Tier 3: Cloud ---
  if (allResults.length < n && cloudStore.isConfigured()) {
    // Cloud search stub returns [] for now
    // Future: cloudStore.recent(type, n - allResults.length)
  }

  // Sort merged results by created_at descending
  allResults.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  parseTags(allResults);

  sendJson(res, 200, { results: allResults.slice(0, n), count: Math.min(allResults.length, n) });
  recordMetric({ operation: 'recent', startTime: _startTime, responseChars: JSON.stringify(allResults.slice(0, n)).length, resultCount: Math.min(allResults.length, n), taskKind: 'recent' });
}

/**
 * Query recent entries from a specific tier DB.
 * @param {string} dbPath
 * @param {string} type
 * @param {number} limit
 * @param {string} namespace
 * @param {string[]|null} accessibleGroups - null = no filter (owner), array = restrict to these groups
 */
function recentFromTier(dbPath, type, limit, namespace, accessibleGroups) {
  if (!existsSync(dbPath)) return [];
  const typeFilter = type && isValidType(type) ? ` AND type = ${esc(type)}` : '';
  const nsFilter = namespace ? ` AND tags LIKE ${esc('%project:' + namespace + '%')}` : '';
  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      groupFilter = ` AND tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }
  const where = ` WHERE 1=1${typeFilter}${nsFilter}${groupFilter}`;
  const sql = `SELECT * FROM entries${where} ORDER BY created_at DESC LIMIT ${limit};`;
  try {
    return dbQuery(sql, dbPath);
  } catch {
    return [];
  }
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

  // Search RAM
  const ramRows = dbQuery(`SELECT * FROM entries WHERE session = ${esc(sessionId)} ORDER BY created_at ASC;`);
  for (const r of ramRows) r._tier = 'ram';
  touchEntries(ramRows.map(r => r.id), DB_PATH);

  // Search SSD
  let ssdRows = [];
  if (existsSync(SSD_DB_PATH)) {
    try {
      ssdRows = dbQuery(`SELECT * FROM entries WHERE session = ${esc(sessionId)} ORDER BY created_at ASC;`, SSD_DB_PATH);
      for (const r of ssdRows) r._tier = 'ssd';
      touchEntries(ssdRows.map(r => r.id), SSD_DB_PATH);
    } catch { /* ignore */ }
  }

  const allRows = [...ramRows, ...ssdRows];
  allRows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  parseTags(allRows);

  sendJson(res, 200, { session: sessionId, results: allRows, count: allRows.length });
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
    dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES (${esc(type)}, ${esc(summaryContent)}, ${esc(tagsJson)}, 'system-compaction', ${tokenEst}, datetime('now'), 0, 'ram');`);

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

  // Write-through: also prune matching entries from SSD
  let ssdPruned = 0;
  try {
    if (existsSync(SSD_DB_PATH)) {
      const ssdBefore = dbQuery(`SELECT COUNT(*) as count FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`, SSD_DB_PATH);
      ssdPruned = ssdBefore[0]?.count || 0;
      if (ssdPruned > 0) {
        dbExec(`DELETE FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`, SSD_DB_PATH);
        dbExec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild');", SSD_DB_PATH);
      }
    }
  } catch (e) {
    console.error('[write-through] SSD prune failed:', e.message);
  }

  sendJson(res, 200, { pruned: countToDelete, ssd_pruned: ssdPruned, older_than: olderThan });
}

/**
 * GET /health
 */
function handleHealth(req, res) {
  const mounted = existsSync(MOUNT_POINT);
  const dbExists = existsSync(DB_PATH);
  const ssdExists = existsSync(SSD_DB_PATH);
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
    ssd_database: ssdExists,
    cloud_configured: cloudStore.isConfigured(),
    mlx_generate_available: mlxGenerateAvailable,
    mlx_generate_model: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
    mlx_available: mlxAvailable,
    coreml_available: mlxAvailable,
    ws_clients: wsClients.size,
    uptime_seconds: Math.floor(process.uptime()),
    features: {
      semantic_search: mlxAvailable,  // MLX embed only
      mlx_embed: mlxAvailable,
      usage_analytics: true,
    },
  });
}

/**
 * POST /tier/migrate — Manually trigger tier migration.
 */
function handleTierMigrate(req, res) {
  const ramToSsd = migrateRamToSsd();
  const ssdToCloud = migrateSsdToCloud();

  sendJson(res, 200, {
    ram_to_ssd: ramToSsd,
    ssd_to_cloud: ssdToCloud,
  });
}

/**
 * GET /tier/stats — Per-tier statistics.
 */
function handleTierStats(req, res) {
  // RAM stats
  const ramCount = dbQuery('SELECT COUNT(*) as count FROM entries;');
  const ramOldest = dbQuery('SELECT MIN(created_at) as oldest FROM entries;');
  const ramNewest = dbQuery('SELECT MAX(created_at) as newest FROM entries;');
  let ramSize = 0;
  try { ramSize = statSync(DB_PATH).size; } catch { /* ok */ }

  // SSD stats
  let ssdCount = 0, ssdOldest = null, ssdNewest = null, ssdSize = 0;
  if (existsSync(SSD_DB_PATH)) {
    try {
      const sc = dbQuery('SELECT COUNT(*) as count FROM entries;', SSD_DB_PATH);
      ssdCount = sc[0]?.count || 0;
      const so = dbQuery('SELECT MIN(created_at) as oldest FROM entries;', SSD_DB_PATH);
      ssdOldest = so[0]?.oldest || null;
      const sn = dbQuery('SELECT MAX(created_at) as newest FROM entries;', SSD_DB_PATH);
      ssdNewest = sn[0]?.newest || null;
      ssdSize = statSync(SSD_DB_PATH).size;
    } catch { /* ok */ }
  }

  // Cloud stats
  const cloudCfg = loadCloudConfig();

  sendJson(res, 200, {
    ram: {
      entries: ramCount[0]?.count || 0,
      size: formatBytes(ramSize),
      oldest: ramOldest[0]?.oldest || null,
      newest: ramNewest[0]?.newest || null,
    },
    ssd: {
      entries: ssdCount,
      size: formatBytes(ssdSize),
      oldest: ssdOldest,
      newest: ssdNewest,
    },
    cloud: {
      configured: !!(cloudCfg && cloudCfg.provider),
      provider: cloudCfg?.provider || null,
      bucket: cloudCfg?.bucket || null,
      entries: 0, // stub — no cloud entry count available yet
    },
  });
}

/**
 * GET /feed?since=<ISO-timestamp>&exclude_user=<userId>
 * Returns entries created after the given timestamp, excluding the specified user's entries.
 * Lets a session ask "what happened since I last checked, by other users/sessions?"
 */
function handleFeed(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const since = params.since;
  if (!since) {
    return sendJson(res, 400, { error: 'Missing required query parameter: since (ISO timestamp)' });
  }

  const excludeUser = params.exclude_user || null;
  const accessibleGroups = getAccessibleGroups(auth);

  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      groupFilter = ` AND tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }

  const excludeFilter = excludeUser ? ` AND tags NOT LIKE ${esc('%user:' + excludeUser + '%')}` : '';

  // Query RAM tier
  const ramSql = `SELECT * FROM entries WHERE created_at > ${esc(since)}${excludeFilter}${groupFilter} ORDER BY created_at DESC LIMIT 20;`;
  let allEntries = [];
  try {
    const ramRows = dbQuery(ramSql, DB_PATH);
    for (const r of ramRows) r._tier = 'ram';
    allEntries.push(...ramRows);
  } catch { /* ignore */ }

  // Query SSD tier if we need more
  if (allEntries.length < 20 && existsSync(SSD_DB_PATH)) {
    try {
      const ssdSql = `SELECT * FROM entries WHERE created_at > ${esc(since)}${excludeFilter}${groupFilter} ORDER BY created_at DESC LIMIT ${20 - allEntries.length};`;
      const ssdRows = dbQuery(ssdSql, SSD_DB_PATH);
      for (const r of ssdRows) r._tier = 'ssd';
      allEntries.push(...ssdRows);
    } catch { /* ignore */ }
  }

  // Sort merged results by created_at descending
  allEntries.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  allEntries = allEntries.slice(0, 20);
  parseTags(allEntries);

  // Determine latest timestamp
  const latest = allEntries.length > 0 ? allEntries[0].created_at : since;

  sendJson(res, 200, {
    entries: allEntries,
    count: allEntries.length,
    since,
    latest,
  });
}

/**
 * POST /tier/config — Configure cloud provider.
 * Body: { provider, bucket, region?, prefix? }
 */
async function handleTierConfig(req, res) {
  const body = await readBody(req);
  const { provider, bucket, region, prefix } = body;

  if (!provider || !bucket) {
    return sendJson(res, 400, { error: 'Missing required fields: provider, bucket' });
  }

  const validProviders = ['s3', 'gcs', 'r2'];
  if (!validProviders.includes(provider)) {
    return sendJson(res, 400, { error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
  }

  const config = {
    provider,
    bucket,
    region: region || null,
    prefix: prefix || 'vcontext/',
    configured_at: new Date().toISOString(),
  };

  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(CLOUD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    sendJson(res, 200, { message: 'Cloud config saved', config, _note: 'Cloud storage is not yet implemented. Config saved for future use.' });
  } catch (e) {
    sendJson(res, 500, { error: `Failed to save config: ${e.message}` });
  }
}

// ── Auth handlers ─────────────────────────────────────────────

import { randomBytes, createHash } from 'node:crypto';

/**
 * POST /auth/create-key — Create a new API key for a user.
 * Body: { userId, name, role?, groups? }
 * Returns: { apiKey: "vctx_...", userId, name, role, groups }
 *
 * Permissions:
 *   owner  — can create any role, assign any group
 *   admin  — can create member/viewer in their own groups only
 *   member/viewer — cannot create keys (403)
 */
async function handleCreateKey(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Require at least admin role
  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to create API keys' });
  }

  const body = await readBody(req);
  const { userId, name } = body;
  if (!userId || !name) {
    return sendJson(res, 400, { error: 'Required: userId, name' });
  }

  const role = body.role || 'member';
  const groups = Array.isArray(body.groups) ? body.groups : [];

  // Validate role
  if (!ROLES.includes(role)) {
    return sendJson(res, 400, { error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
  }

  // Admin cannot assign admin/owner role
  if (!hasRole(auth, 'owner') && ROLE_LEVEL[role] >= ROLE_LEVEL['admin']) {
    return sendJson(res, 403, { error: 'Admin cannot assign admin or owner role. Requires owner.' });
  }

  // Admin cannot assign groups they don't belong to
  if (!hasRole(auth, 'owner')) {
    for (const g of groups) {
      if (!canAccessGroup(auth, g)) {
        return sendJson(res, 403, { error: `Cannot assign group '${g}'. You are not a member of this group.` });
      }
    }
  }

  const apiKey = 'vctx_' + randomBytes(32).toString('hex');
  const keys = loadApiKeys();
  keys.keys[apiKey] = {
    userId,
    name,
    role,
    groups,
    createdAt: new Date().toISOString(),
    createdBy: auth.userId,
  };

  saveApiKeys(keys);

  sendJson(res, 201, {
    apiKey,
    userId,
    name,
    role,
    groups,
    _setup: `On the remote PC, set:\n  export VCONTEXT_API_KEY="${apiKey}"\n  export VCONTEXT_URL="http://<this-pc-ip>:${PORT}"\nThen curl with: -H "Authorization: Bearer ${apiKey}"`,
  });
}

/**
 * GET /auth/whoami — Show current user identity, role, and groups.
 */
function handleWhoami(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  sendJson(res, 200, {
    userId: auth.userId,
    local: auth.local,
    role: auth.role,
    groups: auth.groups,
    host: LOCAL_HOST,
  });
}

/**
 * POST /auth/create-group — Create a new group. Owner only.
 * Body: { groupId: "dev-team/chatai", name: "開発チーム / chatai" }
 */
async function handleCreateGroup(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'owner')) {
    return sendJson(res, 403, { error: 'Only owner can create groups' });
  }

  const body = await readBody(req);
  const { groupId, name } = body;
  if (!groupId || !name) {
    return sendJson(res, 400, { error: 'Required: groupId, name' });
  }

  // Validate groupId format (alphanumeric, hyphens, slashes)
  if (!/^[a-zA-Z0-9/_-]+$/.test(groupId)) {
    return sendJson(res, 400, { error: 'groupId must contain only alphanumeric, hyphens, underscores, and slashes' });
  }

  const keys = loadApiKeys();
  if (keys.groups[groupId]) {
    return sendJson(res, 409, { error: `Group '${groupId}' already exists` });
  }

  keys.groups[groupId] = {
    name,
    createdAt: new Date().toISOString(),
    createdBy: auth.userId,
  };

  saveApiKeys(keys);

  sendJson(res, 201, { groupId, name, created: true });
}

/**
 * GET /auth/groups — List groups.
 * Owner sees all, admin/member sees their own groups.
 */
function handleListGroups(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const keys = loadApiKeys();
  const allGroups = keys.groups || {};

  if (hasRole(auth, 'owner') || auth.groups.includes('*')) {
    // Owner sees all groups
    sendJson(res, 200, { groups: allGroups });
  } else {
    // Non-owner sees only their own groups
    const filtered = {};
    for (const gid of (auth.groups || [])) {
      if (allGroups[gid]) filtered[gid] = allGroups[gid];
    }
    sendJson(res, 200, { groups: filtered });
  }
}

/**
 * POST /auth/update-key — Update a key's role or groups.
 * Body: { apiKey: "vctx_...", role?: "admin", groups?: ["dev-team/chatai"] }
 *
 * Permissions:
 *   owner — can update any key
 *   admin — can update keys within their own groups (cannot escalate to admin/owner)
 *   member/viewer — cannot update keys (403)
 */
async function handleUpdateKey(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to update keys' });
  }

  const body = await readBody(req);
  const { apiKey } = body;
  if (!apiKey) {
    return sendJson(res, 400, { error: 'Required: apiKey' });
  }

  const keys = loadApiKeys();
  const entry = keys.keys[apiKey];
  if (!entry) {
    return sendJson(res, 404, { error: 'API key not found' });
  }

  // Admin: check target key is within their groups
  if (!hasRole(auth, 'owner')) {
    const targetGroups = entry.groups || [];
    const hasOverlap = targetGroups.some(g => canAccessGroup(auth, g));
    if (!hasOverlap && targetGroups.length > 0) {
      return sendJson(res, 403, { error: 'Cannot update keys outside your groups' });
    }
  }

  // Update role if provided
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) {
      return sendJson(res, 400, { error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
    }
    // Admin cannot escalate to admin/owner
    if (!hasRole(auth, 'owner') && ROLE_LEVEL[body.role] >= ROLE_LEVEL['admin']) {
      return sendJson(res, 403, { error: 'Admin cannot assign admin or owner role. Requires owner.' });
    }
    entry.role = body.role;
  }

  // Update groups if provided
  if (Array.isArray(body.groups)) {
    // Admin cannot assign groups they don't belong to
    if (!hasRole(auth, 'owner')) {
      for (const g of body.groups) {
        if (!canAccessGroup(auth, g)) {
          return sendJson(res, 403, { error: `Cannot assign group '${g}'. You are not a member of this group.` });
        }
      }
    }
    entry.groups = body.groups;
  }

  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = auth.userId;
  keys.keys[apiKey] = entry;
  saveApiKeys(keys);

  sendJson(res, 200, {
    apiKey: apiKey.slice(0, 10) + '...',
    userId: entry.userId,
    name: entry.name,
    role: entry.role,
    groups: entry.groups,
    updated: true,
  });
}

/**
 * GET /auth/keys — List all API keys.
 * Owner sees all, admin sees keys in their groups.
 * member/viewer cannot list keys (403).
 */
function handleListKeys(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to list keys' });
  }

  const keys = loadApiKeys();
  const result = [];

  for (const [key, entry] of Object.entries(keys.keys)) {
    // Admin: only show keys in their groups
    if (!hasRole(auth, 'owner')) {
      const entryGroups = entry.groups || [];
      const hasOverlap = entryGroups.some(g => canAccessGroup(auth, g));
      if (!hasOverlap && entryGroups.length > 0) continue;
    }
    result.push({
      apiKey: key.slice(0, 10) + '...',
      userId: entry.userId,
      name: entry.name,
      role: entry.role || 'member',
      groups: entry.groups || [],
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
    });
  }

  sendJson(res, 200, { keys: result, count: result.length });
}

// ── Consultations storage (SQLite-backed, persists across restarts) ──

function ensureConsultationsTable() {
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      context TEXT,
      models TEXT DEFAULT '[]',
      candidates TEXT DEFAULT '[]',
      packages TEXT DEFAULT '[]',
      responses TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      consensus TEXT,
      created_by TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      closed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_consult_status ON consultations(status);`);
  } catch {}
}

function getConsultation(id) {
  const rows = dbQuery(`SELECT * FROM consultations WHERE id = ${esc(id)};`);
  if (!rows[0]) return null;
  const r = rows[0];
  try { r.models = JSON.parse(r.models); } catch { r.models = []; }
  try { r.candidates = JSON.parse(r.candidates); } catch { r.candidates = []; }
  try { r.packages = JSON.parse(r.packages); } catch { r.packages = []; }
  try { r.responses = JSON.parse(r.responses); } catch { r.responses = []; }
  try { r.consensus = JSON.parse(r.consensus); } catch {}
  return r;
}

function saveConsultation(c) {
  dbExec(`INSERT OR REPLACE INTO consultations (id, query, context, models, candidates, packages, responses, status, consensus, created_by, claimed_by, claimed_at, closed_at, created_at)
    VALUES (${esc(c.id)}, ${esc(c.query)}, ${esc(c.context || null)}, ${esc(JSON.stringify(c.models || []))}, ${esc(JSON.stringify(c.candidates || []))}, ${esc(JSON.stringify(c.packages || []))}, ${esc(JSON.stringify(c.responses || []))}, ${esc(c.status || 'pending')}, ${esc(c.consensus ? JSON.stringify(c.consensus) : null)}, ${esc(c.created_by || null)}, ${esc(c.claimed_by || null)}, ${esc(c.claimed_at || null)}, ${esc(c.closed_at || null)}, ${esc(c.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19))});`);
}

function listConsultations(filter) {
  const where = filter ? `WHERE status = ${esc(filter)}` : '';
  const rows = dbQuery(`SELECT * FROM consultations ${where} ORDER BY created_at DESC LIMIT 50;`);
  return rows.map(r => {
    try { r.models = JSON.parse(r.models); } catch { r.models = []; }
    try { r.responses = JSON.parse(r.responses); } catch { r.responses = []; }
    try { r.consensus = JSON.parse(r.consensus); } catch {}
    return r;
  });
}

// ── Decision Resolution handlers ─────────────────────────────

/**
 * POST /resolve
 * Body: { query, context, candidates? }
 * Evaluates conflicting decisions and provides resolution prompts + heuristic suggestions.
 */
async function handleResolve(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { query, context } = body;
  if (!query) {
    return sendJson(res, 400, { error: 'Missing required field: query' });
  }

  let candidates = [];

  if (Array.isArray(body.candidates) && body.candidates.length > 0) {
    // Fetch specific entries by ID from RAM, then SSD
    for (const id of body.candidates) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) continue;
      let rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`);
      if (rows.length > 0) {
        rows[0]._tier = 'ram';
        candidates.push(rows[0]);
        continue;
      }
      // Try SSD
      if (existsSync(SSD_DB_PATH)) {
        try {
          rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`, SSD_DB_PATH);
          if (rows.length > 0) {
            rows[0]._tier = 'ssd';
            candidates.push(rows[0]);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    // Search by query (recall-style) to find potential matches
    const accessibleGroups = getAccessibleGroups(auth);
    const ramResults = searchTier(DB_PATH, query, 'decision', 20, null, null, accessibleGroups);
    for (const r of ramResults) r._tier = 'ram';
    candidates.push(...ramResults);

    if (candidates.length < 20 && existsSync(SSD_DB_PATH)) {
      const ssdResults = searchTier(SSD_DB_PATH, query, 'decision', 20 - candidates.length, null, null, accessibleGroups);
      for (const r of ssdResults) r._tier = 'ssd';
      candidates.push(...ssdResults);
    }
  }

  // Filter to only "decision" type entries
  candidates = candidates.filter(c => c.type === 'decision');
  parseTags(candidates);

  // 0-1 results: no conflict
  if (candidates.length <= 1) {
    return sendJson(res, 200, {
      conflict: false,
      candidates,
      resolution_prompt: null,
      suggestion: null,
      note: candidates.length === 0 ? 'No decision entries found' : 'Single decision, no conflict',
    });
  }

  // 2+ results: build resolution prompt
  const prompt = `Given these conflicting decisions and the current context, determine which one applies.

Current context: ${context || 'not provided'}
Question: ${query}

Decisions:
${candidates.map((c, i) => `
[${i + 1}] (${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})
Content: ${c.content}
Reasoning: ${c.reasoning || 'not recorded'}
Conditions: ${c.conditions || 'not recorded'}
Supersedes: ${c.supersedes ? 'entry #' + c.supersedes : 'none'}
`).join('\n')}

Respond in JSON:
{
  "chosen": <number 1-N>,
  "reasoning": "<why this one applies to the current context>",
  "confidence": "high|medium|low",
  "note": "<any caveats or conditions>"
}`;

  // Build heuristic suggestions
  const suggestion = {};

  // By recency
  const byRecency = [...candidates].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  suggestion.by_recency = { id: byRecency[0].id, reason: 'most recent' };

  // By confidence
  const confOrder = { high: 3, medium: 2, low: 1 };
  const byConf = [...candidates].sort((a, b) => (confOrder[b.confidence] || 2) - (confOrder[a.confidence] || 2));
  suggestion.by_confidence = { id: byConf[0].id, reason: byConf[0].confidence === byConf[1]?.confidence ? 'tied confidence' : 'higher confidence' };

  // By status (active > experimental > temporary > deprecated)
  const statusOrder = { active: 4, experimental: 3, temporary: 2, deprecated: 1 };
  const byStatus = [...candidates].sort((a, b) => (statusOrder[b.status] || 4) - (statusOrder[a.status] || 4));
  suggestion.by_status = { id: byStatus[0].id, reason: `${byStatus[0].status || 'active'} vs ${byStatus[byStatus.length - 1].status || 'active'}` };

  // By supersedes chain
  const superseders = candidates.filter(c => c.supersedes != null);
  if (superseders.length > 0) {
    const latest = superseders[superseders.length - 1];
    suggestion.by_supersedes = { id: latest.id, reason: `explicitly supersedes #${latest.supersedes}` };
  } else {
    suggestion.by_supersedes = { id: null, reason: 'no supersedes relationships found' };
  }

  sendJson(res, 200, {
    conflict: true,
    candidates,
    resolution_prompt: prompt,
    suggestion,
  });
}

/**
 * POST /consult
 * Body: { query, context, models, candidates? }
 * Creates a consultation package for multiple AI models to evaluate conflicting decisions.
 */
async function handleConsult(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { query, context, models } = body;
  if (!query) {
    return sendJson(res, 400, { error: 'Missing required field: query' });
  }
  if (!Array.isArray(models) || models.length === 0) {
    return sendJson(res, 400, { error: 'Missing required field: models (array of model names)' });
  }

  // Gather candidates (same logic as /resolve)
  let candidates = [];

  if (Array.isArray(body.candidates) && body.candidates.length > 0) {
    for (const id of body.candidates) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) continue;
      let rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`);
      if (rows.length > 0) {
        rows[0]._tier = 'ram';
        candidates.push(rows[0]);
        continue;
      }
      if (existsSync(SSD_DB_PATH)) {
        try {
          rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`, SSD_DB_PATH);
          if (rows.length > 0) {
            rows[0]._tier = 'ssd';
            candidates.push(rows[0]);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    const accessibleGroups = getAccessibleGroups(auth);
    const ramResults = searchTier(DB_PATH, query, 'decision', 20, null, null, accessibleGroups);
    for (const r of ramResults) r._tier = 'ram';
    candidates.push(...ramResults);

    if (candidates.length < 20 && existsSync(SSD_DB_PATH)) {
      const ssdResults = searchTier(SSD_DB_PATH, query, 'decision', 20 - candidates.length, null, null, accessibleGroups);
      for (const r of ssdResults) r._tier = 'ssd';
      candidates.push(...ssdResults);
    }
  }

  candidates = candidates.filter(c => c.type === 'decision');
  parseTags(candidates);

  const consultationId = `consult_${Date.now()}`;

  // Build model-specific prompt packages
  const candidateBlock = candidates.map((c, i) => `
[${i + 1}] (ID: ${c.id}, ${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})
Content: ${c.content}
Reasoning: ${c.reasoning || 'not recorded'}
Conditions: ${c.conditions || 'not recorded'}
Supersedes: ${c.supersedes ? 'entry #' + c.supersedes : 'none'}
`).join('\n');

  const packages = {};
  for (const model of models) {
    const modelName = String(model).toLowerCase();
    const prompt = `You are evaluating conflicting decisions stored in a virtual context system.

Context: ${context || 'not provided'}
Question: ${query}

Candidate decisions:
${candidateBlock}

Analyze each candidate and determine which best applies to the current context. Consider recency, confidence level, active/deprecated status, and supersedes chains.

Respond in JSON:
{
  "chosen": <number 1-N corresponding to candidate index>,
  "reasoning": "<your analysis of why this decision best applies>",
  "confidence": "high|medium|low"
}`;

    packages[modelName] = {
      url: `Use via ${modelName === 'claude' ? 'Claude Code session' : modelName === 'codex' ? 'Codex session' : modelName + ' session'}`,
      prompt,
      instructions: `Run this prompt in a ${modelName} session and POST the result back to /consult/${consultationId}/response with body: { "model": "${modelName}", "chosen": <N>, "reasoning": "...", "confidence": "high|medium|low" }`,
    };
  }

  // Store consultation (SQLite-backed)
  saveConsultation({
    id: consultationId,
    query,
    context: context || null,
    models,
    candidates,
    packages: Object.values(packages),
    responses: [],
    status: 'pending',
    consensus: null,
    created_by: auth.userId,
  });

  sendJson(res, 201, {
    consultation_id: consultationId,
    packages,
    candidates,
    status: 'pending_responses',
  });
}

/**
 * POST /consult/:id/response
 * Body: { model, chosen, reasoning, confidence }
 * Collect a model's response to a consultation.
 */
async function handleConsultResponse(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const path = parsePath(req.url);
  // Extract consultation ID: /consult/<id>/response
  const parts = path.split('/');
  // parts: ['', 'consult', '<id>', 'response']
  const consultId = parts[2];

  const consultation = getConsultation(consultId);
  if (!consultation) {
    return sendJson(res, 404, { error: 'Consultation not found' });
  }

  const body = await readBody(req);
  const { model, chosen, reasoning, confidence } = body;
  if (!model || chosen == null) {
    return sendJson(res, 400, { error: 'Missing required fields: model, chosen' });
  }

  // Add response
  const responses = consultation.responses || [];
  responses.push({
    model: String(model).toLowerCase(),
    chosen: Number(chosen),
    reasoning: reasoning || null,
    confidence: confidence || 'medium',
    responded_at: new Date().toISOString(),
    responded_by: auth.userId,
  });
  consultation.responses = responses;

  // Calculate consensus and status
  const responseCount = responses.length;
  const totalModels = (consultation.models || []).length;

  consultation.status = responseCount >= totalModels ? 'complete' : 'partial';

  // Check for consensus (majority agreement on chosen)
  const votes = {};
  for (const resp of responses) {
    const key = String(resp.chosen);
    votes[key] = (votes[key] || 0) + 1;
  }
  const maxVoteEntry = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (maxVoteEntry && maxVoteEntry[1] > responseCount / 2) {
    consultation.consensus = { chosen: Number(maxVoteEntry[0]), agreement: `${maxVoteEntry[1]}/${responseCount}` };
  } else {
    consultation.consensus = null;
  }

  saveConsultation(consultation);

  sendJson(res, 200, {
    consultation_id: consultId,
    model: String(model).toLowerCase(),
    accepted: true,
    status: consultation.status,
    consensus: consultation.consensus,
  });
}

/**
 * GET /consult/:id
 * Check consultation status and aggregated results.
 */
function handleConsultStatus(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const path = parsePath(req.url);
  // /consult/<id>
  const parts = path.split('/');
  const consultId = parts[2];

  const consultation = getConsultation(consultId);
  if (!consultation) {
    return sendJson(res, 404, { error: 'Consultation not found' });
  }

  sendJson(res, 200, {
    consultation_id: consultation.id,
    query: consultation.query,
    context: consultation.context,
    candidates: consultation.candidates,
    responses: consultation.responses,
    consensus: consultation.consensus,
    status: consultation.status,
    claimed_by: consultation.claimed_by,
    closed_at: consultation.closed_at,
    created_at: consultation.created_at,
  });
}

/**
 * GET /consult/pending?model=claude
 * Returns consultations that still need responses from the given model.
 * AI sessions poll this to discover work they need to evaluate.
 */
function handleConsultPending(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const model = params.model || 'claude';

  const all = listConsultations();
  const pending = [];
  for (const c of all) {
    if (c.status === 'pending' || c.status === 'partial') {
      // Check if this model hasn't responded yet
      const responded = (c.responses || []).some(r => r.model === model);
      // Check if this model is in the target list
      const targeted = (c.models || []).includes(model);
      if (targeted && !responded) {
        pending.push({
          consultation_id: c.id,
          query: c.query,
          context: c.context,
          candidate_count: (c.candidates || []).length,
          created_at: c.created_at,
        });
      }
    }
  }

  sendJson(res, 200, { pending, count: pending.length });
}

/**
 * POST /consult/auto-respond
 * Body: { model: "claude", responses: [{ consultation_id, chosen, reasoning, confidence }] }
 * Allows an AI session to evaluate and respond to ALL pending consultations in one call.
 */
async function handleConsultAutoRespond(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { model, responses } = body;
  if (!model || !responses || !Array.isArray(responses)) {
    return sendJson(res, 400, { error: 'Required: model, responses[]' });
  }

  const results = [];
  for (const r of responses) {
    const consultation = getConsultation(r.consultation_id);
    if (!consultation) {
      results.push({ id: r.consultation_id, status: 'not_found' });
      continue;
    }
    const already = (consultation.responses || []).some(resp => resp.model === model);
    if (already) {
      results.push({ id: r.consultation_id, status: 'already_responded' });
      continue;
    }

    consultation.responses.push({
      model, chosen: r.chosen, reasoning: r.reasoning,
      confidence: r.confidence, responded_at: new Date().toISOString(), responded_by: auth.userId,
    });

    const total = (consultation.models || []).length;
    consultation.status = consultation.responses.length >= total ? 'complete' : 'partial';

    const votes = {};
    for (const resp of consultation.responses) { votes[resp.chosen] = (votes[resp.chosen] || 0) + 1; }
    const maxVote = Math.max(...Object.values(votes));
    const winner = Object.keys(votes).find(k => votes[k] === maxVote);
    if (maxVote > total / 2) {
      consultation.consensus = { chosen: parseInt(winner), agreement: `${maxVote}/${consultation.responses.length}` };
    }

    saveConsultation(consultation);
    results.push({ id: r.consultation_id, status: consultation.status, consensus: consultation.consensus || null });

    wsBroadcast('consultation_updated', { consultation_id: r.consultation_id, status: consultation.status, consensus: consultation.consensus });
  }

  sendJson(res, 200, { processed: results.length, results });
}


/**
 * POST /consult/:id/claim - Claim a consultation (lock for this model)
 */
async function handleConsultClaim(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const parts = parsePath(req.url).split('/');
  const consultId = parts[2];
  const consultation = getConsultation(consultId);
  if (!consultation) return sendJson(res, 404, { error: 'Consultation not found' });
  const body = await readBody(req);
  if (consultation.claimed_by && consultation.claimed_by !== body.model) {
    return sendJson(res, 409, { error: 'Already claimed by ' + consultation.claimed_by });
  }
  consultation.claimed_by = body.model || auth.userId;
  consultation.claimed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveConsultation(consultation);
  sendJson(res, 200, { consultation_id: consultId, claimed_by: consultation.claimed_by });
}

/**
 * POST /consult/:id/close - Close a consultation
 */
async function handleConsultClose(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const parts = parsePath(req.url).split('/');
  const consultId = parts[2];
  const consultation = getConsultation(consultId);
  if (!consultation) return sendJson(res, 404, { error: 'Consultation not found' });
  consultation.status = 'closed';
  consultation.closed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveConsultation(consultation);
  wsBroadcast('consultation_updated', { consultation_id: consultId, status: 'closed' });
  sendJson(res, 200, { consultation_id: consultId, status: 'closed', closed_at: consultation.closed_at });
}

/**
 * GET /consult/list - List all consultations with optional status filter
 */
function handleConsultList(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const params = parseQuery(req.url);
  const results = listConsultations(params.status || null);
  sendJson(res, 200, { consultations: results, count: results.length });
}

// ── Utilities ──────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ── Streaming embed (MLX: always-on, GPU-accelerated) ──────────
let embedLoopRunning = false;

async function startEmbedLoop() {
  if (embedLoopRunning) return;
  embedLoopRunning = true;

  while (embedLoopRunning) {
    // Ensure MLX embed backend is available
    if (!mlxAvailable) {
      checkMlx();
      if (!mlxAvailable) {
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
    }

    // Pause if flag file exists
    if (existsSync('/tmp/vcontext-embed-pause')) {
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    try {
      // Batch of 10 — uses MLX /embed_batch endpoint. ~10x throughput
      // with only ~80MB peak memory increase.
      const BATCH = 1; // single — stable, no OOM risk
      const rows = dbQuery(`SELECT id, content FROM entries WHERE embedding IS NULL ORDER BY id ASC LIMIT ${BATCH};`);
      if (rows.length === 0) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      let embeddings = null;
      if (mlxAvailable) {
        try {
          embeddings = await mlxEmbedBatch(rows.map(r => String(r.content).slice(0, 1000)));
        } catch (e) {
          console.log(`[embed-loop] batch failed (${rows.length} rows): ${e.message}`);
        }
      }
      if (embeddings && embeddings.length === rows.length) {
        for (let i = 0; i < rows.length; i++) {
          const emb = embeddings[i];
          if (!emb || emb.length === 0) continue;
          const embJson = esc(JSON.stringify(emb));
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${rows[i].id};`); } catch {}
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${rows[i].id};`, SSD_DB_PATH); } catch {}
          try { vecUpsert(rows[i].id, emb); } catch {}
          try { dbExec(`UPDATE entry_index SET has_embedding = 1 WHERE entry_id = ${rows[i].id};`); } catch {}
        }
      }
      // Gap between batches — 2s to let MLX clear_cache + avoid server hang
      await new Promise(r => setTimeout(r, 2000));
    } catch {
      await new Promise(r => setTimeout(r, 60000));
    }
  }
  embedLoopRunning = false;
}

// ── Periodic migration check (piggybacks on backup timer) ─────
function doBackupAndMigrate() {
  doBackup();
  // Sync any entries that write-through missed (RAM → SSD catch-up)
  try {
    syncRamToSsd();
  } catch (e) {
    console.error('[vcontext:auto] RAM→SSD sync failed:', e.message);
  }
  // Sync new embeddings to vec index + SSD
  try {
    vecSync();
  } catch {}
  try {
    syncEmbeddingsToSsd(100);
  } catch {}
  // Incremental index backfill
  try { backfillIndex(200); } catch {}
  // Recheck AI availability
  checkMlxGenerate();
  checkMlx(); // MLX embed server (always-on embedding)
  // Ensure embed loop is running (self-healing — restarts if stopped)
  if (mlxAvailable && !embedLoopRunning) {
    startEmbedLoop().catch(() => {});
  }
  // Content hash backfill — other INSERT paths (anomaly-alert,
  // skill-discovery, skill-registry, predictive-search, etc.) bypass
  // handleStore and leave content_hash NULL. Without a hash those rows
  // skip dedup and will accumulate duplicates again. Backfill in the
  // same scheduler that already migrates tiers.
  try {
    const crypto = require('node:crypto');
    const rows = ramDb.prepare(`SELECT id, content, session, type FROM entries WHERE content_hash IS NULL AND type NOT IN ('test','working-state','session-recall','anomaly-alert') LIMIT 500;`).all();
    if (rows.length > 0) {
      const upd = ramDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
      let filled = 0, dupes = 0;
      for (const r of rows) {
        try {
          upd.run(crypto.createHash('sha256').update(String(r.content)).digest('hex'), r.id);
          filled++;
        } catch (e) {
          // UNIQUE constraint: another row already has this (session,type,hash).
          // This row IS a duplicate — safe to delete.
          if (/UNIQUE constraint/i.test(e.message)) {
            try { ramDb.prepare(`DELETE FROM entries WHERE id = ?`).run(r.id); dupes++; } catch {}
          }
        }
      }
      if (filled + dupes > 0) console.log(`[vcontext:auto] Backfilled ${filled}, deduped ${dupes} rows`);
    }
  } catch (e) { console.error('[vcontext:auto] hash backfill failed:', e.message); }

  // Quick migration check
  try {
    const moved = migrateRamToSsd();
    if (moved > 0) console.log(`[vcontext:auto] Auto-migrated ${moved} entries RAM → SSD`);
  } catch (e) {
    console.error('[vcontext:auto] Auto-migration RAM→SSD failed:', e.message);
  }
  try {
    const moved = migrateSsdToCloud();
    if (moved > 0) console.log(`[vcontext:auto] Auto-migrated ${moved} entries SSD → Cloud`);
  } catch (e) {
    console.error('[vcontext:auto] Auto-migration SSD→Cloud failed:', e.message);
  }
  // Ensure discovery loop is running (self-healing)
  if (mlxGenerateAvailable && !discoveryLoopRunning) {
    startDiscoveryLoop().catch(() => {});
  }
  // Anomaly detection
  try { detectAnomalies(); } catch {}
}

// ── Anomaly detection ─────────────────────────────────────────
function detectAnomalies() {
  const alerts = [];

  // 1. Error spike: >10 errors in last 30 min
  const errorCount = dbQuery("SELECT COUNT(*) as c FROM entry_index WHERE type = 'tool-error' AND created_at >= datetime('now', '-30 minutes');");
  if ((errorCount[0]?.c || 0) > 10) {
    alerts.push({ level: 'high', msg: `Error spike: ${errorCount[0].c} errors in last 30 min` });
  }

  // 2. Embedding stall: no new embeddings in 30 min while backlog exists
  const embedBacklog = dbQuery("SELECT COUNT(*) as c FROM entries WHERE embedding IS NULL;");
  const recentEmbeds = dbQuery("SELECT COUNT(*) as c FROM entries WHERE embedding IS NOT NULL AND created_at >= datetime('now', '-30 minutes');");
  if ((embedBacklog[0]?.c || 0) > 50 && (recentEmbeds[0]?.c || 0) === 0) {
    alerts.push({ level: 'medium', msg: `Embedding stalled: ${embedBacklog[0].c} pending, 0 in last 30 min` });
  }

  // 3. RAM/SSD sync anomaly.
  // By design SSD ≥ RAM always (RAM→SSD migration keeps SSD as the
  // long-term store; migrated entries leave RAM). Only a POSITIVE gap
  // (RAM > SSD, i.e. SSD is missing data that's in RAM) is a real
  // anomaly — it would mean the server's tier migration has failed.
  // Negative gap is normal and grows linearly with cold storage.
  const ramCount = dbQuery("SELECT COUNT(*) as c FROM entries;");
  const ssdCount = dbQuery("SELECT COUNT(*) as c FROM entries;", SSD_DB_PATH);
  const gap = (ramCount[0]?.c || 0) - (ssdCount[0]?.c || 0);
  if (gap > 100) {
    alerts.push({ level: 'medium', msg: `RAM ahead of SSD by ${gap} entries — tier migration may be failing` });
  }

  // 4. Disk usage >80%
  try {
    const ramSize = statSync(DB_PATH).size;
    if (ramSize > 3 * 1024 * 1024 * 1024) {
      alerts.push({ level: 'high', msg: `RAM disk >3GB (${(ramSize/1024/1024/1024).toFixed(1)}GB)` });
    }
  } catch {}

  // Store alerts
  if (alerts.length > 0) {
    const content = JSON.stringify({ alerts, detected_at: new Date().toISOString() });
    try {
      dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('anomaly-alert', ${esc(content)}, '["anomaly-alert","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
      console.log(`[vcontext:alert] ${alerts.length} anomalies detected`);
    } catch {}
  }
}

// ── SearXNG dynamic URL detection ─────────────────────────────
let searxngUrl = process.env.SEARXNG_URL || '';
function detectSearxngUrl() {
  if (process.env.SEARXNG_URL) return; // env var takes priority
  try {
    const port = execFileSync('docker', ['port', 'searxng', '8080'], {
      timeout: 5000, encoding: 'utf-8',
    }).trim().split(':').pop();
    if (port && /^\d+$/.test(port)) {
      searxngUrl = `http://127.0.0.1:${port}`;
      return;
    }
  } catch {}
  searxngUrl = 'http://127.0.0.1:8888'; // fallback
}
detectSearxngUrl();

// ── Streaming skill discovery + user need prediction ──────────
let discoveryLoopRunning = false;
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;   // 5 min between searches
const PREDICTION_INTERVAL_MS = 30 * 60 * 1000;  // 30 min between predictions
let lastPredictionRun = 0;

async function startDiscoveryLoop() {
  if (discoveryLoopRunning) return;
  discoveryLoopRunning = true;

  while (discoveryLoopRunning) {
    // Ensure MLX generate is available
    if (!mlxGenerateAvailable) { checkMlxGenerate(); }
    if (!mlxGenerateAvailable) {
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      continue;
    }
    if (existsSync('/tmp/vcontext-embed-pause')) {
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    try {
      await runOneDiscovery();
    } catch {}

    // User need prediction every 30 min
    if (Date.now() - lastPredictionRun >= PREDICTION_INTERVAL_MS) {
      lastPredictionRun = Date.now();
      try {
        await runOnePrediction();
      } catch {}
      // Auto-create skill (MLX generate — no model unload needed)
      try {
        await autoCreateSkill();
      } catch {}
    }

    // Wait 5 min before next search
    await new Promise(r => setTimeout(r, DISCOVERY_INTERVAL_MS));
  }
  discoveryLoopRunning = false;
}

async function runOneDiscovery() {
  detectSearxngUrl(); // re-detect port in case Docker restarted

  // ── 1. Skill discovery: multi-direction search ──
  // Rotate through categories + activity-based topic each cycle
  const DISCOVERY_CATEGORIES = [
    'Claude Code skills best practices',
    'AI coding agent workflow patterns',
    'MCP server new tools',
    'agentic orchestration patterns',
    'AI agent quality assurance',
    'AI pair programming techniques',
  ];
  try {
    // Pick category by rotation (cycle through all directions)
    const cycleIndex = Math.floor(Date.now() / DISCOVERY_INTERVAL_MS) % (DISCOVERY_CATEGORIES.length + 1);
    let topic;

    if (cycleIndex < DISCOVERY_CATEGORIES.length) {
      // Fixed category rotation
      topic = DISCOVERY_CATEGORIES[cycleIndex] + ' 2026';
    } else {
      // Activity-based dynamic topic
      topic = 'AI agent workflow best practices 2026'; // fallback
      if (mlxGenerateAvailable) {
        try {
          const recentActivity = dbQuery(`SELECT tool_name, type FROM entry_index WHERE created_at >= datetime('now', '-6 hours') AND tool_name IS NOT NULL ORDER BY entry_id DESC LIMIT 20;`);
          const recentPrompts = dbQuery(`SELECT substr(content, 1, 200) as c FROM entries WHERE type = 'user-prompt' AND created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 5;`);
          const agentTasks = dbQuery(`SELECT substr(content, 1, 200) as c FROM entries WHERE type = 'subagent-start' AND created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 10;`);

          const activityStr = recentActivity.map(r => r.tool_name).filter(Boolean).join(', ');
          const promptStr = recentPrompts.map(r => {
            try { const d = JSON.parse(r.c); return d.prompt || d.content || ''; } catch { return r.c || ''; }
          }).filter(s => s.length > 5).join('; ');
          const agentStr = agentTasks.map(r => {
            try { const d = JSON.parse(r.c); return d.description || ''; } catch { return ''; }
          }).filter(Boolean).join('; ');

          const topicPrompt = `Based on this developer and their AI agents' recent work, generate ONE search query to find the most useful new tool, library, or best practice. Output ONLY the search query, nothing else.

Recent tools: ${activityStr || 'Bash, Edit, Read'}
Recent questions: ${sanitizeForExternalSearch(promptStr || 'general development')}
Agent tasks: ${sanitizeForExternalSearch(agentStr || 'code review, testing')}

Search query:`;
          const generated = await mlxGenerate(topicPrompt, { maxTokens: 4000, temperature: 0.7 });
          if (generated && generated.length > 5) {
            topic = sanitizeForExternalSearch(generated.trim().split('\n')[0]);
          }
        } catch {}
      }
    }
    console.log(`[vcontext:discover] Topic: "${topic}" (cycle ${cycleIndex}/${DISCOVERY_CATEGORIES.length})`);

    // Dedup: skip if we searched this topic in the last 24 hours
    const existing = dbQuery(`SELECT id FROM entries WHERE type = 'skill-discovery' AND content LIKE ${esc('%' + topic.slice(0, 30) + '%')} AND created_at >= datetime('now', '-24 hours') LIMIT 1;`);
    if (existing.length > 0) {
      console.log(`[vcontext:discover] Skipped (searched in last 24h)`);
    } else {

    const searchResult = await new Promise((resolve) => {
      const req = httpRequest(new URL(`${searxngUrl}/search?q=${encodeURIComponent(topic + ' 2026')}&format=json&language=auto`), {
        method: 'GET', timeout: 10000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (searchResult && searchResult.results && searchResult.results.length > 0) {
      const snippets = searchResult.results.slice(0, 5).map(r =>
        `[${r.engine || '?'}] ${r.title || ''}: ${(r.content || '').slice(0, 200)}`
      );
      const content = JSON.stringify({
        topic,
        results: snippets,
        discovered_at: new Date().toISOString(),
      });
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-discovery', ${esc(content)}, '["skill-discovery","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:discover] Searched "${topic}" → ${snippets.length} results`);
      } catch {}
    }
    } // end dedup else
  } catch {}
}

async function runOnePrediction() {
  try {
    console.log(`[vcontext:predict] entering runOnePrediction, mlxGen=${mlxGenerateAvailable}`);
    if (!mlxGenerateAvailable) { console.log('[vcontext:predict] skipped: mlx unavailable'); return; }
    console.log('[vcontext:predict] building prompt...');

    // PRIORITY: generate routing triggers from skill-gaps FIRST —
    // before the heavy DB queries that can hang on embed-loop write lock.
    // Uses direct MLX call (queue bypass) + lightweight entries query.
    try {
      const gapRows = dbQuery(`SELECT content FROM entries WHERE type = 'skill-gap' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 5;`);
      const gaps = gapRows.map(r => { try { return JSON.parse(r.content).prompt || ''; } catch { return ''; } }).filter(Boolean);
      if (gaps.length > 0) {
        console.log(`[vcontext:predict] generating triggers for ${gaps.length} gaps...`);
        const triggerPrompt = `Given these user prompts that matched NO skill:\n${gaps.map(g => `- "${g}"`).join('\n')}\n\nFor each prompt, output 2-3 Japanese/English keywords (pipe-separated) that would identify similar future prompts. Format: one line per prompt, keywords only.\nExample: 改善|improve|better`;
        // Queue normally — serial queue ensures it runs when MLX is free.
        // No bypass, no retry loop, no fighting for immediate access.
        const triggerOut = await mlxGenerate(triggerPrompt, { maxTokens: 500, temperature: 0.2, caller: 'auto-trigger', priority: 0 });
        if (triggerOut && triggerOut.length > 5) {
          const lines = triggerOut.trim().split('\n').filter(l => l.includes('|'));
          for (const line of lines.slice(0, 5)) {
            const keywords = line.replace(/^[-\s*]+/, '').trim();
            if (keywords.length >= 3) {
              dbExec(`INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, status, content_hash)
                VALUES ('skill-trigger', ${esc(JSON.stringify({ keywords, for_skills: ['auto-router'], generated_at: new Date().toISOString() }))},
                '["skill-trigger","auto"]', 'system', 10, datetime('now'), 0, 'ram', 'active',
                ${esc(require('node:crypto').createHash('sha256').update(keywords).digest('hex'))});`);
            }
          }
          console.log(`[vcontext:predict] Auto-generated ${lines.length} routing triggers`);
        }
      }
    } catch (e) { console.log(`[vcontext:predict] trigger gen failed: ${e.message}`); }

    // Get recent activity patterns (can hang on embed lock — non-critical)
    const recentTools = dbQuery(`SELECT tool_name, COUNT(*) as cnt FROM entry_index WHERE tool_name IS NOT NULL AND created_at >= datetime('now', '-24 hours') GROUP BY tool_name ORDER BY cnt DESC LIMIT 10;`);
    const recentErrors = dbQuery(`SELECT COUNT(*) as cnt FROM entry_index WHERE type = 'tool-error' AND created_at >= datetime('now', '-24 hours');`);
    const recentTopics = dbQuery(`SELECT type, COUNT(*) as cnt FROM entry_index WHERE created_at >= datetime('now', '-24 hours') GROUP BY type ORDER BY cnt DESC LIMIT 5;`);

    const activitySummary = `Tools used: ${recentTools.map(r => `${r.tool_name}(${r.cnt})`).join(', ')}
Errors: ${recentErrors[0]?.cnt || 0}
Event types: ${recentTopics.map(r => `${r.type}(${r.cnt})`).join(', ')}`;

    // Get existing skills
    const skillList = dbQuery(`SELECT DISTINCT tool_name FROM entry_index WHERE type IN ('skill-version','skill-diff');`);
    const existingSkills = skillList.map(r => r.tool_name).filter(Boolean).join(', ');

    // Skill effectiveness feedback
    const usageRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-usage' ORDER BY id DESC LIMIT 200;");
    const usageCounts = {};
    for (const row of usageRows) {
      try { const d = JSON.parse(row.content); for (const n of (d.skills || [])) usageCounts[n] = (usageCounts[n] || 0) + 1; } catch {}
    }
    const topSkills = Object.entries(usageCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ');
    const neverUsed = (existingSkills ? existingSkills.split(', ') : []).filter(s => !usageCounts[s]).slice(0, 5).join(', ');

    // Agent activity analysis
    const agentActivity = dbQuery(`SELECT content FROM entries WHERE type = 'subagent-start' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 20;`);
    const agentTasks = agentActivity.map(r => {
      try { const d = JSON.parse(r.content); return d.description || ''; } catch { return ''; }
    }).filter(Boolean).slice(0, 10);
    const agentErrors = dbQuery(`SELECT COUNT(*) as cnt FROM entries WHERE type = 'tool-error' AND tags LIKE '%agent%' AND created_at >= datetime('now', '-24 hours');`);

    // Skill-gap feedback: recent prompts that matched ZERO skills.
    // These are the highest-signal gaps — user actually asked for
    // something and the system had nothing. Priority over generic
    // activity-based suggestions.
    const gapRows = dbQuery(`SELECT content FROM entries WHERE type = 'skill-gap' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 5;`);
    const gaps = gapRows.map(r => {
      try { return JSON.parse(r.content).prompt || ''; } catch { return ''; }
    }).filter(Boolean);
    const gapSection = gaps.length > 0
      ? `\nRecent unmatched prompts (skill gaps):\n${gaps.map(g => `- "${g}"`).join('\n')}\nPrioritize creating skills that would have matched these prompts.\n`
      : '';

    // (trigger gen moved to top of function — runs before heavy DB queries)

    const prompt = `Based on user AND agent activity, suggest 1-2 NEW skills.

User activity (24h):
${activitySummary}

Agent tasks (24h): ${agentTasks.join('; ') || 'none'}
Agent errors: ${agentErrors[0]?.cnt || 0}
${gapSection}
Most used skills: ${topSkills || 'none yet'}
Never used skills: ${neverUsed || 'none'}
Existing skills: ${existingSkills || 'standard set'}

Focus on gaps: what patterns in user OR agent activity does NO existing skill cover?
Consider: what skills would help agents work more autonomously?
Do NOT suggest skills similar to never-used ones (they were not useful).
Output ONLY the suggestion in 2-3 sentences. Be specific.`;

    const suggestion = await mlxGenerate(prompt, { maxTokens: 4000, temperature: 0.5, caller: 'skill-suggestion', priority: 0 });
    if (suggestion && suggestion.length > 20) {
      const content = JSON.stringify({
        activity: activitySummary,
        suggestion: suggestion.trim(),
        suggested_at: new Date().toISOString(),
      });
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-suggestion', ${esc(content)}, '["skill-suggestion","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:predict] Skill suggestion generated`);
      } catch {}
    }
  } catch {}
}

// ── Auto skill creation from suggestions ──────────────────────

async function autoCreateSkill() {
  if (!mlxGenerateAvailable) return;

  try {

    // Get ALL unprocessed suggestions
    const suggestions = dbQuery(`SELECT id, content FROM entries WHERE type = 'skill-suggestion' AND tags NOT LIKE '%skill-created%' ORDER BY id ASC LIMIT 10;`);
    if (suggestions.length === 0) return;

    // Get existing skill names to avoid duplicates
    const skillsDir = join(process.env.HOME, 'skills', 'skills');
    let existingSkills = [];
    try { existingSkills = readdirSync(skillsDir).filter(d => statSync(join(skillsDir, d)).isDirectory()); } catch {}
    // Also check vcontext registry
    const registeredSkills = dbQuery("SELECT content FROM entries WHERE type = 'skill-registry';");
    for (const r of registeredSkills) {
      try { const s = JSON.parse(r.content); if (s.name) existingSkills.push(s.name); } catch {}
    }
    existingSkills = [...new Set(existingSkills)];

    let created = 0;
    for (const suggestion of suggestions) {
      let suggestionText = '';
      try { suggestionText = JSON.parse(suggestion.content).suggestion || ''; } catch { suggestionText = suggestion.content; }
      if (suggestionText.length < 20) continue;

      const genPrompt = `Create a new AI workflow skill based on this suggestion:
"${suggestionText.slice(0, 300)}"

Existing skills (do NOT duplicate): ${existingSkills.join(', ')}

Output in this EXACT format (nothing else):
SKILL_NAME: kebab-case-name
---
name: kebab-case-name
description: "One line description starting with Use when..."
origin: auto-generated
---

## Rules

1. First rule
2. Second rule

## Workflow

1. First step
2. Second step

## Gotchas

- First gotcha`;

      const generated = await mlxGenerate(genPrompt, { maxTokens: 8000, temperature: 0.3, caller: 'skill-creation', priority: 0 });
      await new Promise(r => setTimeout(r, 30000));
      if (!generated || generated.length < 50) continue;

      const nameMatch = generated.match(/SKILL_NAME:\s*([a-z0-9-]+)/);
      if (!nameMatch) continue;
      const skillName = nameMatch[1];

      if (existingSkills.includes(skillName)) {
        console.log(`[vcontext:skill] Skipped "${skillName}" — already exists`);
        // Mark as processed anyway
        try { const t = dbQuery(`SELECT tags FROM entries WHERE id = ${suggestion.id};`); if (t[0]) { let tags = JSON.parse(t[0].tags || '[]'); tags.push('skill-created'); dbExec(`UPDATE entries SET tags = ${esc(JSON.stringify(tags))} WHERE id = ${suggestion.id};`); } } catch {}
        continue;
      }

      const skillContent = generated.slice(generated.indexOf('---'));
      if (!skillContent || skillContent.length < 50) continue;

      // Write SKILL.md
      const skillDir = join(skillsDir, skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

      // Register in vcontext
      const descMatch = skillContent.match(/description:\s*["']?(.*?)(?:["']?\n|$)/s);
      const desc = descMatch ? descMatch[1].trim().slice(0, 200) : '';
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-registry', ${esc(JSON.stringify({ name: skillName, description: desc, full_content: skillContent }))}, ${esc(JSON.stringify(['skill-registry', 'skill:' + skillName]))}, 'system', ${estimateTokens(skillContent)}, datetime('now'), 0, 'ram');`);
      } catch {}

      // Mark suggestion as processed
      try { const t = dbQuery(`SELECT tags FROM entries WHERE id = ${suggestion.id};`); if (t[0]) { let tags = JSON.parse(t[0].tags || '[]'); tags.push('skill-created'); dbExec(`UPDATE entries SET tags = ${esc(JSON.stringify(tags))} WHERE id = ${suggestion.id};`); } } catch {}

      // Record creation
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-created', ${esc(JSON.stringify({ skill_name: skillName, source_suggestion_id: suggestion.id, created_at: new Date().toISOString() }))}, '["skill-created","auto"]', 'system', 20, datetime('now'), 0, 'ram');`);
      } catch {}

      existingSkills.push(skillName);
      created++;
      console.log(`[vcontext:skill] Auto-created skill: ${skillName}`);
    }

    // Build all targets once after all skills created
    if (created > 0) {
      try {
        execSync(`node ${join(process.env.HOME, 'skills', 'scripts', 'build-all.js')}`, {
          cwd: join(process.env.HOME, 'skills'), timeout: 60000, encoding: 'utf-8',
        });
        console.log(`[vcontext:skill] Built ${created} new skills`);
      } catch (e) {
        console.error(`[vcontext:skill] Build failed: ${e.message?.slice(0, 80)}`);
      }
    }
  } catch (e) {
    console.error(`[vcontext:skill] Error: ${e.message?.slice(0, 80)}`);
  }
}

// ── RAM → SSD catch-up sync (fills gaps from failed write-through) ─
function syncRamToSsd() {
  if (!existsSync(SSD_DB_PATH)) return;
  const ssdMax = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;", SSD_DB_PATH);
  const ssdMaxId = ssdMax[0]?.max_id || 0;
  const ramMax = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;");
  const ramMaxId = ramMax[0]?.max_id || 0;
  const gap = ramMaxId - ssdMaxId;
  if (gap <= 0) return;
  // Use ATTACH to copy missing entries in one shot (including embedding)
  dbExec(`
    ATTACH '${SSD_DB_PATH}' AS ssd;
    INSERT OR IGNORE INTO ssd.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, embedding)
      SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ssd', reasoning, conditions, supersedes, confidence, status, embedding
      FROM main.entries WHERE id > ${ssdMaxId};
    DETACH ssd;
  `);
  console.log(`[vcontext:sync] Caught up ${gap} entries RAM→SSD (${ssdMaxId}→${ramMaxId})`);
}

// ── Embedding backfill RAM → SSD (batch via ATTACH)
function syncEmbeddingsToSsd() {
  if (!existsSync(SSD_DB_PATH)) return;
  try {
    dbExec(`
      ATTACH '${SSD_DB_PATH}' AS ssd;
      UPDATE ssd.entries SET embedding = (
        SELECT main.entries.embedding FROM main.entries
        WHERE main.entries.id = ssd.entries.id AND main.entries.embedding IS NOT NULL
      )
      WHERE ssd.entries.embedding IS NULL
      AND ssd.entries.id IN (
        SELECT id FROM main.entries WHERE embedding IS NOT NULL LIMIT 200
      );
      DETACH ssd;
    `);
    const ssdCount = dbQuery("SELECT count(*) as c FROM entries WHERE embedding IS NOT NULL;", SSD_DB_PATH);
    const ramCount = dbQuery("SELECT count(*) as c FROM entries WHERE embedding IS NOT NULL;");
    const gap = (ramCount[0]?.c || 0) - (ssdCount[0]?.c || 0);
    if (gap > 0) console.log(`[vcontext:sync] Embedding SSD sync: ${ssdCount[0]?.c || 0} done, ${gap} remaining`);
  } catch (e) {
    console.error('[vcontext:sync] Embedding SSD sync error:', e.message?.slice(0, 80));
  }
}

// ── SSD → RAM restore (after reboot / RAM disk wipe) ────────────
function restoreRamFromSsd() {
  if (!existsSync(SSD_DB_PATH)) return;
  const ramCount = dbQuery("SELECT COALESCE(COUNT(*),0) as c FROM entries;");
  const ssdCount = dbQuery("SELECT COALESCE(COUNT(*),0) as c FROM entries;", SSD_DB_PATH);
  const ramC = ramCount[0]?.c || 0;
  const ssdC = ssdCount[0]?.c || 0;

  if (ramC >= ssdC) return; // RAM already has everything

  const gap = ssdC - ramC;
  const ramMaxId = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;")[0]?.max_id || 0;

  console.log(`[vcontext:restore] RAM has ${ramC} entries, SSD has ${ssdC} (${gap} missing). Restoring...`);

  try {
    dbExec(`
      ATTACH '${SSD_DB_PATH}' AS ssd;
      INSERT OR IGNORE INTO main.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, embedding)
        SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ram', reasoning, conditions, supersedes, confidence, status, embedding
        FROM ssd.entries WHERE id > ${ramMaxId};
      DETACH ssd;
    `);
    const afterCount = dbQuery("SELECT COUNT(*) as c FROM entries;")[0]?.c || 0;
    console.log(`[vcontext:restore] Restored ${afterCount - ramC} entries from SSD → RAM (now ${afterCount} total)`);
  } catch (e) {
    console.error(`[vcontext:restore] SSD → RAM restore failed: ${e.message}`);
    // Fallback: try backup file
    if (existsSync(BACKUP_PATH)) {
      console.log('[vcontext:restore] Trying backup file...');
      try {
        dbExec(`
          ATTACH '${BACKUP_PATH}' AS bak;
          INSERT OR IGNORE INTO main.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status)
            SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ram', reasoning, conditions, supersedes, confidence, status
            FROM bak.entries WHERE id > ${ramMaxId};
          DETACH bak;
        `);
        const afterCount = dbQuery("SELECT COUNT(*) as c FROM entries;")[0]?.c || 0;
        console.log(`[vcontext:restore] Restored from backup → RAM (now ${afterCount} total)`);
      } catch (e2) {
        console.error(`[vcontext:restore] Backup restore also failed: ${e2.message}`);
      }
    }
  }
}

// ── WebSocket (minimal, zero-dep) ─────────────────────────────
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5B56-A3CE3E4E2D';
const wsClients = new Map(); // id -> { socket, userId, groups, subscriptions }
let wsIdCounter = 0;

function handleWsUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  // Auth: check API key from query params or headers
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const apiKey = url.searchParams.get('key') || '';
  let auth;
  if (apiKey) {
    const keys = loadApiKeys();
    const entry = keys.keys[apiKey];
    if (!entry) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    auth = { userId: entry.userId, role: entry.role || 'member', groups: entry.groups || [] };
  } else {
    auth = { userId: LOCAL_USER_ID, role: 'owner', groups: ['*'] };
  }

  // WebSocket handshake
  const acceptKey = createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  const clientId = ++wsIdCounter;
  const client = {
    socket,
    userId: auth.userId,
    role: auth.role,
    groups: auth.groups,
    subscriptions: new Set(['all']), // default: receive all events
  };
  wsClients.set(clientId, client);
  console.log(`[ws] Client ${clientId} connected (${auth.userId})`);

  socket.on('data', (buf) => {
    try {
      const msg = decodeWsFrame(buf);
      if (!msg) return;
      const data = JSON.parse(msg);
      // Handle subscription changes
      if (data.action === 'subscribe') {
        if (data.namespace) client.subscriptions.add(`ns:${data.namespace}`);
        if (data.type) client.subscriptions.add(`type:${data.type}`);
        wsSend(client, { event: 'subscribed', subscriptions: [...client.subscriptions] });
      } else if (data.action === 'unsubscribe') {
        if (data.namespace) client.subscriptions.delete(`ns:${data.namespace}`);
        if (data.type) client.subscriptions.delete(`type:${data.type}`);
        wsSend(client, { event: 'unsubscribed', subscriptions: [...client.subscriptions] });
      } else if (data.action === 'ping') {
        wsSend(client, { event: 'pong', ts: new Date().toISOString() });
      }
    } catch {} // Ignore malformed messages
  });

  socket.on('close', () => {
    wsClients.delete(clientId);
    console.log(`[ws] Client ${clientId} disconnected`);
  });

  socket.on('error', () => {
    wsClients.delete(clientId);
  });

  // Send welcome
  wsSend(client, { event: 'connected', clientId, userId: auth.userId });
}

// Minimal WebSocket frame encoder/decoder (text frames only)
function encodeWsFrame(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const buf = Buffer.from(json, 'utf-8');
  const len = buf.length;
  let frame;
  if (len < 126) {
    frame = Buffer.alloc(2 + len);
    frame[0] = 0x81; // text frame, FIN
    frame[1] = len;
    buf.copy(frame, 2);
  } else if (len < 65536) {
    frame = Buffer.alloc(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    buf.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    buf.copy(frame, 10);
  }
  return frame;
}

function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x08) return null; // close frame
  if (opcode !== 0x01) return null; // only text frames
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  const payload = buf.slice(offset, offset + payloadLen);
  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return payload.toString('utf-8');
}

function wsSend(client, data) {
  try {
    client.socket.write(encodeWsFrame(data));
  } catch {} // Client may have disconnected
}

// Broadcast to relevant clients based on entry metadata
function wsBroadcast(eventType, entry) {
  const entryTags = entry.tags || '[]';
  const entryTagsStr = typeof entryTags === 'string' ? entryTags : JSON.stringify(entryTags);

  for (const [, client] of wsClients) {
    // Group access check
    if (!client.groups.includes('*')) {
      const hasGroupAccess = client.groups.some(g => entryTagsStr.includes(`group:${g}`));
      // If entry has group tags but client can't access them, skip
      if (entryTagsStr.includes('group:') && !hasGroupAccess) continue;
    }

    // Subscription check
    const subs = client.subscriptions;
    let match = subs.has('all');
    if (!match && entry.type) match = subs.has(`type:${entry.type}`);
    if (!match) {
      // Check namespace subscriptions
      for (const sub of subs) {
        if (sub.startsWith('ns:') && entryTagsStr.includes(`project:${sub.slice(3)}`)) {
          match = true;
          break;
        }
      }
    }

    if (match) {
      wsSend(client, {
        event: eventType,
        entry: {
          id: entry.id,
          type: entry.type,
          content: entry.content ? entry.content.slice(0, 200) : '',
          tags: entry.tags,
          session: entry.session,
          created_at: entry.created_at,
          userId: entryTagsStr.match(/user:([^",\]]+)/)?.[1] || null,
        },
      });
    }
  }
}

// ── sqlite-vec (optional, for fast vector search) ────────────
let vecDb = null; // better-sqlite3 instance with vec0 extension
let EMBED_DIM = 4096; // Qwen3-Embedding-8B (auto-detected from first embedding if available)

function initVecDb() {
  try {
    // Auto-detect embedding dimension (skip if DB under pressure)
    try {
      const dimRows = dbQuery("SELECT embedding FROM entries WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT 1;");
      if (dimRows[0]) { try { EMBED_DIM = JSON.parse(dimRows[0].embedding).length; } catch {} }
    } catch {}

    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    vecDb = new Database(join(MOUNT_POINT, 'vcontext-vec.db'));
    sqliteVec.load(vecDb);
    vecDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(embedding float[${EMBED_DIM}])`);
    console.log(`[sqlite-vec] Loaded — dim=${EMBED_DIM}, fast vector search enabled`);
  } catch (e) {
    console.log(`[sqlite-vec] Not available (${e.message}) — falling back to JS cosine`);
    vecDb = null;
  }
}

function vecUpsert(id, embedding) {
  if (!vecDb || !embedding || embedding.length !== EMBED_DIM) return;
  try {
    const embJson = JSON.stringify(embedding).replace(/'/g, "''");
    vecDb.exec(`INSERT OR REPLACE INTO vec_entries(rowid, embedding) VALUES (${Number(id)}, vec_f32('${embJson}'))`);
  } catch {}
}

function vecSearch(queryEmbedding, limit = 10) {
  if (!vecDb) return [];
  try {
    const qJson = JSON.stringify(queryEmbedding).replace(/'/g, "''");
    return vecDb.prepare(`SELECT rowid, distance FROM vec_entries WHERE embedding MATCH vec_f32('${qJson}') ORDER BY distance LIMIT ${Number(limit)}`).all();
  } catch { return []; }
}

function vecSync() {
  if (!vecDb) return;
  try {
    // Find entries with embeddings not yet in vec_entries (handles gaps + new)
    const vecIds = new Set(vecDb.prepare('SELECT rowid FROM vec_entries').pluck().all());
    const rows = dbQuery(`SELECT id, embedding FROM entries WHERE embedding IS NOT NULL ORDER BY id;`)
      .filter(r => !vecIds.has(r.id))
      .slice(0, 1000);
    let synced = 0;
    for (const row of rows) {
      try {
        const emb = JSON.parse(row.embedding);
        if (emb.length === EMBED_DIM) {
          const embStr = row.embedding.replace(/'/g, "''");
          vecDb.exec(`INSERT OR IGNORE INTO vec_entries(rowid, embedding) VALUES (${Number(row.id)}, vec_f32('${embStr}'))`);
          synced++;
        }
      } catch {}
    }
    if (synced > 0) console.log(`[sqlite-vec] Synced ${synced} vectors`);
  } catch {}
}

// ── MLX Embedding Server (Apple Silicon GPU-accelerated) ──────
const MLX_EMBED_URL = process.env.MLX_EMBED_URL || process.env.COREML_EMBED_URL || 'http://127.0.0.1:3161';
let mlxAvailable = false;
let mlxEmbedDim = 0;    // auto-detected from health check
let mlxModelName = '';   // e.g. 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ'
// Back-compat alias
let coremlAvailable = false;

/**
 * Check if MLX embed server is running on port 3161.
 * Tries /api/health (new MLX server) then /health (legacy CoreML).
 * This is a fast local server for search-time query embedding.
 */
async function checkMlx() {
  try {
    const parsed = new URL(`${MLX_EMBED_URL}/api/health`);
    const data = await new Promise((resolve, reject) => {
      const req = httpRequest(parsed, { method: 'GET', timeout: 2000 }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    // MLX server returns status='healthy', legacy CoreML returns status='ok'
    mlxAvailable = data && (data.status === 'healthy' || data.status === 'ok');
    coremlAvailable = mlxAvailable; // back-compat
    if (mlxAvailable) {
      mlxEmbedDim = data.embedding_dim || 0;
      mlxModelName = data.model_name || data.model || '';
      console.log(`[mlx-embed] Available: model=${mlxModelName} (dim=${mlxEmbedDim})`);
    }
  } catch {
    mlxAvailable = false;
    coremlAvailable = false;
  }
}
// Back-compat alias
const checkCoreml = checkMlx;

/**
 * Generate embedding via MLX server (/api/embeddings).
 * Returns N-dim normalized embedding array or null on failure.
 * Runs on Apple Silicon GPU (24/7, no restrictions).
 * Default model: Qwen3-Embedding-8B-4bit-DWQ (4096-dim, ~30-100ms per embed).
 */
const MLX_DEFAULT_MODEL = process.env.MLX_EMBED_MODEL || 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ';

function mlxEmbed(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MLX_DEFAULT_MODEL, prompt: text });
    const parsed = new URL(`${MLX_EMBED_URL}/api/embeddings`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000, // 60s — MLX is fast but system under swap pressure may delay
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.embedding || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx embed timeout')); });
    req.write(body);
    req.end();
  });
}

// Batch embed via /embed_batch (10x throughput vs single calls)
function mlxEmbedBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ texts, model: MLX_DEFAULT_MODEL, normalize: true });
    const parsed = new URL(`${MLX_EMBED_URL}/embed_batch`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000, // 10min
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve((data.embeddings || []).map(e => e.embedding || e));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx embed_batch timeout')); });
    req.write(body);
    req.end();
  });
}
// Back-compat alias
const coremlEmbed = mlxEmbed;

// ── MLX Generate Server (Apple Silicon, 24/7) ────────────────

const MLX_GENERATE_URL = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162';
const MLX_GENERATE_MODEL = process.env.MLX_GENERATE_MODEL || 'mlx-community/Qwen3-8B-4bit';
let mlxGenerateAvailable = false;

async function checkMlxGenerate() {
  try {
    const data = await httpGet(`${MLX_GENERATE_URL}/v1/models`);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    mlxGenerateAvailable = parsed && parsed.data && parsed.data.length > 0;
    if (mlxGenerateAvailable) {
      console.log(`[mlx-generate] Available: ${MLX_GENERATE_MODEL}`);
    }
  } catch {
    mlxGenerateAvailable = false;
  }
}

// Simple HTTP GET helper
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(parsed, { method: 'GET', timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Call MLX generate server (OpenAI-compatible chat completions)
// Attempt a single MLX chat/completions call. Returns the assistant
// content (may be '') on HTTP 200, or throws with status on 4xx/5xx.
// ── Cost / token tracker ────────────────────────────────────────
// Aggregates MLX token usage by feature so /metrics can report cost.
const _mlxUsage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, by_caller: {} };
function trackMlxUsage(caller, promptTokens, completionTokens) {
  _mlxUsage.calls++;
  _mlxUsage.prompt_tokens += promptTokens;
  _mlxUsage.completion_tokens += completionTokens;
  if (!_mlxUsage.by_caller[caller]) _mlxUsage.by_caller[caller] = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  _mlxUsage.by_caller[caller].calls++;
  _mlxUsage.by_caller[caller].prompt_tokens += promptTokens;
  _mlxUsage.by_caller[caller].completion_tokens += completionTokens;
}

function mlxGenerateOnce(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    // Qwen3 emits <think>...</think> before the real answer. When
    // max_tokens is hit mid-think, the real answer never appears.
    // Set to Qwen3's full config ceiling (40,960 = prompt 8,192 +
    // output 32,768) so slow thinking is never truncated.
    // User explicitly prefers stability over speed.
    // Reproducibility: caller may pass a seed to force deterministic
    // generation (debug + replay). Temperature 0 + seed = bitwise repro.
    const body = JSON.stringify({
      model: MLX_GENERATE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 40960,
      temperature: options.temperature ?? 0.3,
      ...(options.seed != null ? { seed: options.seed } : {}),
    });
    const parsed = new URL(`${MLX_GENERATE_URL}/v1/chat/completions`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000, // 10min
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (status === 200) {
            const content = data.choices?.[0]?.message?.content || '';
            const usage = data.usage || {};
            trackMlxUsage(options.caller || 'unknown', usage.prompt_tokens || 0, usage.completion_tokens || 0);
            return resolve(content.trim());
          }
          const err = new Error(`mlx http ${status}: ${data.error || data.detail || 'unknown'}`);
          err.status = status;
          reject(err);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx generate timeout')); });
    req.write(body);
    req.end();
  });
}

// JS-side serialization: only ONE mlxGenerate call can be in flight
// server-wide. Prevents the server's own background tasks from self-DoS
// against MLX's lock (we saw 12+ concurrent node→MLX sockets all waiting
// on the same lock, each returning 503 repeatedly).
// Priority queue for MLX generate. Skills = high, everything else = normal.
// High-priority items jump ahead in the queue so skills are usable ASAP.
const MLX_PRIORITY = { high: 0, normal: 1, low: 2 };
const _mlxQueue = [];      // { resolve, reject, fn, priority }
let _mlxRunning = false;

async function _mlxDrain() {
  if (_mlxRunning) return;
  _mlxRunning = true;
  while (_mlxQueue.length > 0) {
    // Sort by priority (stable: same-priority preserves insertion order)
    _mlxQueue.sort((a, b) => a.priority - b.priority);
    const item = _mlxQueue.shift();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    }
  }
  _mlxRunning = false;
}

async function mlxGenerate(prompt, options = {}) {
  const priority = options.priority ?? MLX_PRIORITY.normal;
  return new Promise((resolve, reject) => {
    _mlxQueue.push({
      priority,
      resolve,
      reject,
      fn: async () => {
        const delays = [30000, 60000, 120000];
        let lastErr;
        for (let i = 0; i < delays.length + 1; i++) {
          try {
            return await mlxGenerateOnce(prompt, options);
          } catch (e) {
            lastErr = e;
            const transient = e.status === 503
              || e.code === 'ECONNREFUSED'
              || (e.message && /ECONNREFUSED|ECONNRESET|socket hang up/i.test(e.message));
            if (transient && i < delays.length) {
              await new Promise(r => setTimeout(r, delays[i]));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    });
    _mlxDrain();
  });
}

// ── Local AI endpoint handlers ────────────────────────────────

// GET /ai/status — Show local AI status
function handleAiStatus(req, res) {
  let embeddingCount = 0;
  let embeddingBacklog = 0;       // 24h-recent eligible rows still missing embedding
  let embeddingEligibleTotal = 0; // total ELIGIBLE rows (denominator)
  try {
    // Total = SSD (permanent store, has everything including overflow from RAM)
    const ssdTotal = dbQuery(`SELECT count(*) as c FROM entries;`, SSD_DB_PATH);
    embeddingEligibleTotal = ssdTotal[0]?.c || 0;
    // Embedded = RAM embedded + SSD-only embedded (use RAM count as fast proxy)
    const ramEmb = dbQuery(`SELECT count(*) as c FROM entries WHERE embedding IS NOT NULL;`);
    embeddingCount = ramEmb[0]?.c || 0;
    embeddingBacklog = embeddingEligibleTotal - embeddingCount;
  } catch {}

  sendJson(res, 200, {
    mlx_generate_available: mlxGenerateAvailable,
    mlx_generate_url: MLX_GENERATE_URL,
    mlx_generate_model: MLX_GENERATE_MODEL,
    coreml_available: mlxAvailable,
    mlx_available: mlxAvailable,
    mlx_url: MLX_EMBED_URL,
    mlx_model: mlxModelName,
    mlx_dim: mlxEmbedDim,
    embedding_count: embeddingCount,
    embedding_eligible_total: embeddingEligibleTotal,
    embedding_backlog: embeddingBacklog,
    preferred: {
      summarize: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
      embed: mlxAvailable ? `${mlxModelName} (mlx)` : null,
      judge: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
      code: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
    },
    features: {
      auto_summarize: mlxGenerateAvailable,
      auto_embed: mlxAvailable,
      auto_conflict_resolve: mlxGenerateAvailable,
      semantic_search: mlxAvailable,
    },
  });
}

// POST /ai/summarize — Summarize entries using MLX generate
async function handleAiSummarize(req, res) {
  if (!mlxGenerateAvailable) {
    return sendJson(res, 503, { error: 'MLX generate server not available at ' + MLX_GENERATE_URL });
  }
  const body = await readBody(req);
  const ids = body.ids || [];

  if (ids.length === 0) {
    // Summarize all entries older than 24h that don't have a summary
    const rows = dbQuery(`SELECT id, content FROM entries WHERE reasoning IS NULL AND created_at < datetime('now', '-1 day') LIMIT 20;`);
    for (const row of rows) {
      try {
        const summary = await mlxGenerate(`Summarize in one sentence (max 50 words):\n\n${row.content.slice(0, 2000)}`, { maxTokens: 4000 });
        if (summary) dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${row.id};`);
      } catch {}
    }
    return sendJson(res, 200, { summarized: rows.length, model: MLX_GENERATE_MODEL });
  }

  // Summarize specific entries
  let count = 0;
  for (const id of ids) {
    const rows = dbQuery(`SELECT content FROM entries WHERE id = ${id};`);
    if (rows[0]) {
      try {
        const summary = await mlxGenerate(`Summarize in one sentence (max 50 words):\n\n${rows[0].content.slice(0, 2000)}`, { maxTokens: 4000 });
        if (summary) { dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${id};`); count++; }
      } catch {}
    }
  }
  sendJson(res, 200, { summarized: count, model: MLX_GENERATE_MODEL });
}

// ── Cosine similarity for semantic search ─────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// GET /search/semantic — Semantic similarity search using embeddings
async function handleSemanticSearch(req, res) {
  const params = parseQuery(req.url);
  const q = params.q;
  if (!q) return sendJson(res, 400, { error: 'Missing query parameter: q' });
  const typeFilter = params.type || ''; // NEW: restrict to a specific type

  // No embedding source at all → immediate FTS fallback
  // MLX is the sole embedding provider
  if (!mlxAvailable) {
    const limit = Math.min(parseInt(params.limit) || 10, 50);
    const typeClause = typeFilter ? ` AND type=${esc(typeFilter)}` : '';
    const ftsResults = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(q))} LIMIT ${limit * 3})${typeClause} LIMIT ${limit};`);
    parseTags(ftsResults);
    return sendJson(res, 200, { results: ftsResults, count: ftsResults.length, engine: 'fts-fallback', model_used: null, threshold: 0 });
  }

  const limit = Math.min(parseInt(params.limit) || 10, 50);
  const threshold = parseFloat(params.threshold) || 0.5;
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Generate query embedding — try MLX (fast ~30ms), then FTS fallback
  let queryEmbed;
  let embedSource = null;

  // Strategy 1: MLX (fast ~30ms on Apple Silicon GPU)
  // Only usable for vector search if MLX embedding dimension matches stored embeddings
  if (mlxAvailable) {
    try {
      const mlxResult = await mlxEmbed(q);
      if (mlxResult && mlxResult.length > 0) {
        // Check if MLX embedding dimension matches stored embeddings
        if (mlxResult.length === EMBED_DIM) {
          queryEmbed = mlxResult;
          embedSource = 'mlx';
        } else {
          // Dimension mismatch — MLX dim differs from stored embeddings
          // Can't use for vector search, but MLX is confirmed working
          // Fall through to FTS
        }
      }
    } catch (e) {
      // MLX failed — fall through to FTS
      console.log(`[search/semantic] MLX embed failed: ${e.message}`);
    }
  }

  // MLX is sole embedding provider
  // Strategy 2: FTS fallback if MLX embedding could not be generated
  if (!queryEmbed || queryEmbed.length === 0) {
    const ftsResults = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(q))} LIMIT ${limit});`);
    parseTags(ftsResults);
    return sendJson(res, 200, {
      results: ftsResults,
      count: ftsResults.length,
      engine: 'fts-fallback',
      model_used: null,
      threshold,
      _note: mlxAvailable
        ? `MLX available (dim=${mlxEmbedDim}) but mismatch with stored embeddings (dim=${EMBED_DIM}); fell back to FTS`
        : 'MLX embed server unavailable, fell back to FTS keyword search',
    });
  }

  const model_used = `${mlxModelName} (mlx)`;

  const results = [];

  // Type-scoped semantic search: when a type filter is active and the type
  // has relatively few entries, skip vec index (which is unfiltered) and
  // do JS cosine over embeddings of that type only. Guarantees the most
  // relevant entries of that type reach the caller even when dwarfed by
  // other types in the index.
  if (typeFilter) {
    const rows = dbQuery(`SELECT id, type, content, tags, created_at, reasoning, embedding FROM entries WHERE type=${esc(typeFilter)} AND embedding IS NOT NULL;`);
    for (const row of rows) {
      try {
        const entryEmbed = JSON.parse(row.embedding);
        const sim = cosineSimilarity(queryEmbed, entryEmbed);
        if (sim >= threshold || threshold <= 0.1) {
          results.push({
            id: row.id, type: row.type, content: row.content,
            tags: row.tags, created_at: row.created_at, reasoning: row.reasoning,
            similarity: Math.round(sim * 1000) / 1000, _engine: 'type-scoped',
          });
        }
      } catch {}
    }
    results.sort((a, b) => b.similarity - a.similarity);
    if (results.length > limit) results.length = limit;
    parseTags(results);
    return sendJson(res, 200, { results, count: results.length, engine: 'type-scoped', model_used, threshold });
  }

  // Fast path: sqlite-vec index search (no type filter)
  if (vecDb) {
    const vecResults = vecSearch(queryEmbed, limit * 2);
    if (vecResults.length > 0) {
      const ids = vecResults.map(r => r.rowid);
      const entries = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (${ids.join(',')});`);
      const entryMap = {};
      for (const e of entries) entryMap[e.id] = e;

      for (const vr of vecResults) {
        const entry = entryMap[vr.rowid];
        if (!entry) continue;
        // vec0 returns L2 distance; convert to similarity via 1/(1+d)
        const similarity = Math.round(1 / (1 + vr.distance) * 1000) / 1000;
        if (similarity >= threshold || threshold <= 0.1) {  // always include at low threshold
          results.push({
            id: entry.id, type: entry.type, content: entry.content,
            tags: entry.tags, created_at: entry.created_at, reasoning: entry.reasoning,
            similarity, _engine: 'sqlite-vec',
          });
        }
      }
      results.sort((a, b) => b.similarity - a.similarity);
    }
  }

  // Slow path fallback: JS cosine over all entries (if sqlite-vec unavailable or empty)
  if (results.length === 0 && !vecDb) {
    const typeClause = typeFilter ? ` AND type=${esc(typeFilter)}` : '';
    const rows = dbQuery(`SELECT id, type, content, tags, created_at, embedding, reasoning FROM entries WHERE embedding IS NOT NULL${typeClause};`);
    for (const row of rows) {
      try {
        const entryEmbed = JSON.parse(row.embedding);
        const sim = cosineSimilarity(queryEmbed, entryEmbed);
        if (sim >= threshold) {
          results.push({
            id: row.id, type: row.type, content: row.content,
            tags: row.tags, created_at: row.created_at, reasoning: row.reasoning,
            similarity: Math.round(sim * 1000) / 1000, _engine: 'js-cosine',
          });
        }
      } catch {}
    }
    results.sort((a, b) => b.similarity - a.similarity);
  }

  // Apply group access filter
  const accessibleGroups = getAccessibleGroups(auth);
  const filtered = accessibleGroups ? results.filter(r => {
    const tags = r.tags || '';
    if (!tags.includes('group:')) return true;
    return accessibleGroups.some(g => tags.includes(`group:${g}`));
  }) : results;

  parseTags(filtered.slice(0, limit));

  sendJson(res, 200, {
    results: filtered.slice(0, limit),
    count: Math.min(filtered.length, limit),
    engine: results[0]?._engine || (vecDb ? 'sqlite-vec' : 'js-cosine'),
    model_used: model_used,
    embed_source: embedSource,
    threshold,
  });
}

// ── Usage analytics ───────────────────────────────────────────

// POST /analytics/track — Track a usage event
async function handleAnalyticsTrack(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { event_type, skill_name, session, metadata } = body;

  if (!event_type) {
    return sendJson(res, 400, { error: 'Missing required field: event_type' });
  }

  const metaStr = metadata ? JSON.stringify(metadata) : '{}';
  const userId = auth.userId || null;

  dbExec(
    `INSERT INTO analytics (event_type, skill_name, session, user_id, metadata)
     VALUES (${esc(event_type)}, ${esc(skill_name || null)}, ${esc(session || null)}, ${esc(userId)}, ${esc(metaStr)});`
  );

  sendJson(res, 201, { tracked: true, event_type, skill_name: skill_name || null });
}

// GET /analytics/report — Usage analytics report
function handleAnalyticsReport(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const days = parseInt(params.days) || 30;
  const since = `datetime('now', '-${days} days')`;

  // Total events in period
  const totalRows = dbQuery(`SELECT COUNT(*) as count FROM analytics WHERE created_at >= ${since};`);
  const totalEvents = totalRows[0]?.count || 0;

  // Skill usage breakdown
  const skillRows = dbQuery(
    `SELECT skill_name, COUNT(*) as count, MAX(created_at) as last_used
     FROM analytics
     WHERE skill_name IS NOT NULL AND created_at >= ${since}
     GROUP BY skill_name
     ORDER BY count DESC;`
  );
  const skillUsage = skillRows.map(r => ({
    skill: r.skill_name,
    count: r.count,
    last_used: r.last_used,
  }));

  // Find skills that were never used (compare against known skills from entries tags)
  const knownSkillRows = dbQuery(
    `SELECT DISTINCT skill_name FROM analytics WHERE skill_name IS NOT NULL;`
  );
  const usedSkills = new Set(knownSkillRows.map(r => r.skill_name));
  // Try to discover skill names from entry tags
  const tagRows = dbQuery(
    `SELECT DISTINCT tags FROM entries WHERE tags LIKE '%skill:%';`
  );
  const allSkills = new Set();
  for (const r of tagRows) {
    try {
      const tags = JSON.parse(r.tags);
      for (const t of tags) {
        if (t.startsWith('skill:')) allSkills.add(t.slice(6));
      }
    } catch {}
  }
  const neverUsed = [...allSkills].filter(s => !usedSkills.has(s));

  // Daily activity
  const dailyRows = dbQuery(
    `SELECT DATE(created_at) as date, COUNT(*) as events
     FROM analytics
     WHERE created_at >= ${since}
     GROUP BY DATE(created_at)
     ORDER BY date DESC;`
  );
  const dailyActivity = dailyRows.map(r => ({
    date: r.date,
    events: r.events,
  }));

  // Top users
  const userRows = dbQuery(
    `SELECT user_id, COUNT(*) as events
     FROM analytics
     WHERE user_id IS NOT NULL AND created_at >= ${since}
     GROUP BY user_id
     ORDER BY events DESC
     LIMIT 20;`
  );
  const topUsers = userRows.map(r => ({
    user: r.user_id,
    events: r.events,
  }));

  sendJson(res, 200, {
    period: `${days} days`,
    total_events: totalEvents,
    skill_usage: skillUsage,
    never_used: neverUsed,
    daily_activity: dailyActivity,
    top_users: topUsers,
  });
}

// ── Predictive search with privacy filter ─────────────────────

// Privacy filter: strip sensitive info before sending to external search
function sanitizeForExternalSearch(text) {
  return redactPII(text, { collapseWhitespace: true });
}

// Centralised PII redaction. Use everywhere data crosses a trust
// boundary (external search, audit log, dashboard, exports). Keep
// patterns conservative — false positives are less harmful than leaks.
function redactPII(text, opts = {}) {
  if (!text) return '';
  let s = String(text);
  // File paths
  s = s.replace(/\/(?:Users|home|var|tmp|etc|opt)\/[\w\-./]+/g, '[PATH]');
  // URLs
  s = s.replace(/https?:\/\/[^\s)]+/g, '[URL]');
  // Email
  s = s.replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[EMAIL]');
  // API keys / tokens (alnum >=20)
  s = s.replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[TOKEN]');
  // IPv4
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]');
  // SSN-like (XXX-XX-XXXX)
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
  // Credit card (13-19 digits w/ optional dashes/spaces)
  s = s.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CC]');
  // Phone (Japanese / E.164 / common formats)
  s = s.replace(/(?:\+?\d{1,3}[- ]?)?(?:\(?\d{2,4}\)?[- ]?){2,4}\d{2,4}/g, m => m.length >= 10 ? '[PHONE]' : m);
  // Tag-style user identifiers
  s = s.replace(/\b(?:user|userId|email):\S+/gi, '[USERID]');
  if (opts.collapseWhitespace) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * POST /predictive-search
 * Body: { prompt }
 * Extracts keywords from user prompt (via MLX generate, local only),
 * sanitizes for privacy, searches the web, stores results in vcontext.
 * Fully async — returns immediately, results stored in background.
 */
/**
 * POST /completion-check
 * Body: { session, assistant_message }
 * Auto-detects completion claims, runs checklist, stores violations as rules.
 */
async function handleCompletionCheck(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const msg = body.assistant_message || '';
  const session = body.session || '';

  // Detect completion claims
  const completionPatterns = /完了|complete|done|finished|100%|全て.*完了|実装.*済|修正.*済|対応.*済|コミット.*済/i;
  if (!completionPatterns.test(msg)) {
    return sendJson(res, 200, { checked: false, reason: 'no completion claim detected' });
  }

  // Completion check uses MLX generate (24/7)
  if (!mlxGenerateAvailable) {
    return sendJson(res, 200, { checked: true, analyzing: false, reason: 'MLX generate not available' });
  }

  sendJson(res, 202, { checked: true, analyzing: true });

  // Background: analyze recent work for gaps
  setImmediate(async () => {
    try {

      // Gather recent session activity
      const recentWork = dbQuery(`SELECT type, tool_name, substr(content,1,200) as preview FROM entry_index WHERE session = ${esc(session)} AND created_at >= datetime('now', '-1 hour') ORDER BY entry_id DESC LIMIT 30;`);

      const workSummary = recentWork.map(r =>
        `[${r.type}] ${r.tool_name || ''} ${r.preview || ''}`
      ).join('\n').slice(0, 2000);

      // Search for latest best practices relevant to this work
      let latestPractices = '';
      try {
        const tools = recentWork.map(r => r.tool_name).filter(Boolean);
        const mainTool = tools[0] || 'code';
        const searchQuery = sanitizeForExternalSearch(`${mainTool} completion checklist best practices`);
        const searchResult = await new Promise((resolve) => {
          const req = httpRequest(new URL(`${searxngUrl}/search?q=${encodeURIComponent(searchQuery + ' 2026')}&format=json&language=auto`), {
            method: 'GET', timeout: 8000,
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (searchResult && searchResult.results) {
          latestPractices = searchResult.results.slice(0, 3).map(r =>
            `- ${(r.content || '').slice(0, 150)}`
          ).join('\n');
        }
      } catch {}

      const checkPrompt = `An AI just claimed this work is complete: "${msg.slice(0, 300)}"

Recent actions in this session:
${workSummary}

${latestPractices ? `Latest best practices from web (2026):\n${latestPractices}\n` : ''}Check for these common AI omissions:
1. Did it update documentation (README, CLAUDE.md, roadmap)?
2. Did it run tests, build, lint?
3. Are there workarounds left (grep -v, TODO, FIXME, skip)?
4. Did it verify git status is clean (stash, untracked)?
5. Did it check related files that should change together?
6. Did it verify previous session claims independently?

List ONLY the violations found (omissions). If none, say "NONE".
Be specific about what was missed.`;

      const violations = await mlxGenerate(checkPrompt, { maxTokens: 4000, temperature: 0.2 });
      if (!violations || violations.trim() === 'NONE' || violations.length < 10) {
        console.log('[vcontext:check] Completion check passed');
        return;
      }

      // Store violations
      const content = JSON.stringify({
        completion_claim: msg.slice(0, 300),
        violations: violations.trim(),
        session,
        detected_at: new Date().toISOString(),
      });
      dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('completion-violation', ${esc(content)}, '["completion-violation","auto"]', ${esc(session)}, ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);

      // Auto-generate a new rule from the violation pattern
      const rulePrompt = `Based on this violation, write a short MANDATORY RULE (1-2 sentences) to prevent it from happening again. Output ONLY the rule text.

Violation: ${violations.trim().slice(0, 300)}`;
      const newRule = await mlxGenerate(rulePrompt, { maxTokens: 4000, temperature: 0.2 });
      if (newRule && newRule.length > 20) {
        // Check if a similar rule already exists
        const existing = dbQuery(`SELECT id FROM entries WHERE type = 'decision' AND content LIKE ${esc('%' + newRule.trim().slice(0, 30) + '%')} AND tags LIKE '%global-rule%' LIMIT 1;`);
        if (existing.length === 0) {
          dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, confidence, status) VALUES ('decision', ${esc('MANDATORY RULE: ' + newRule.trim())}, '["global-rule","quality-gate","mandatory","auto-generated"]', 'global', ${estimateTokens(newRule)}, datetime('now'), 0, 'ram', 'high', 'active');`);
          console.log(`[vcontext:check] New rule auto-generated: ${newRule.trim().slice(0, 80)}`);
        }
      }

      console.log(`[vcontext:check] Violations found: ${violations.trim().slice(0, 100)}`);
    } catch (e) {
      console.error('[vcontext:check] Error:', e.message);
    }
  });
}

async function handlePredictiveSearch(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const prompt = body.prompt || '';
  if (!prompt || prompt.length < 10) {
    return sendJson(res, 200, { status: 'skipped', reason: 'prompt too short' });
  }

  // Predictive search uses MLX generate (24/7)
  if (!mlxGenerateAvailable) {
    return sendJson(res, 200, { status: 'skipped', reason: 'MLX generate not available' });
  }

  // Return immediately — do work in background
  sendJson(res, 202, { status: 'searching', prompt_length: prompt.length });

  setImmediate(async () => {
    console.log(`[vcontext:predict] handler entered, prompt_len=${prompt.length}`);
    try {
      if (!mlxGenerateAvailable) { console.log('[vcontext:predict] MLX unavailable, abort'); return; }

      // Step 1: Extract search keywords using MLX generate (no external call)
      const keywordPrompt = `Extract 2-3 search keywords from this user request. Output ONLY the keywords separated by spaces, nothing else. No explanation.

Request: ${prompt.slice(0, 500)}

Keywords:`;

      // Qwen3 emits <think>…</think> before answering. If max_tokens
      // is consumed by thinking, content is empty. 4000 leaves room
      // for think + short answer. If MLX still returns empty, fall back
      // to the user's prompt words so the pipeline keeps moving.
      let keywordsRaw = '';
      try {
        keywordsRaw = await mlxGenerate(keywordPrompt, { maxTokens: 4000, temperature: 0.1 });
      } catch (e) {
        console.error(`[vcontext:predict] mlxGenerate failed: ${e.message}`);
      }
      let keywords = (keywordsRaw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!keywords || keywords.length < 3) {
        const words = prompt.match(/[\p{L}\p{N}]{3,}/gu) || [];
        keywords = words.slice(0, 3).join(' ');
        if (!keywords || keywords.length < 3) {
          console.log('[vcontext:predict] No usable keywords (empty MLX + empty prompt)');
          return;
        }
        console.log(`[vcontext:predict] Fallback keywords from prompt: "${keywords}"`);
      }
      const keywordsClean = keywords.split('\n')[0].trim();

      // Step 2: Privacy filter — sanitize before external search
      const sanitized = sanitizeForExternalSearch(keywordsClean);
      if (!sanitized || sanitized.length < 3) return;
      console.log(`[vcontext:predict] Keywords: "${keywordsClean}" → sanitized: "${sanitized}"`);

      // Step 3: Multi-source search with rate limiting
      // Sources: (a) vcontext FTS, (b) SearXNG, (c) MLX generate, (d) Wikipedia
      const parts = [];
      const searchWords = sanitized.split(' ').filter(w => w.length > 2);

      // 3a: Search own vcontext for related entries
      try {
        const related = dbQuery(`SELECT id, type, content, created_at FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(sanitized))} LIMIT 5);`);
        for (const r of related) {
          parts.push(`[past:${r.type}] ${String(r.content).slice(0, 200)}`);
        }
      } catch {}

      // 3b: SearXNG meta-search (Google+Bing+DDG+Brave, local instance)
      detectSearxngUrl(); // re-detect in case Docker restarted
      try {
        const searchQuery = sanitized + ' 2026';
        const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(searchQuery)}&format=json&language=auto`;
        const searchResult = await new Promise((resolve) => {
          const req = httpRequest(new URL(searchUrl), {
            method: 'GET', timeout: 10000,
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (searchResult && searchResult.results) {
          for (const r of searchResult.results.slice(0, 5)) {
            const engine = r.engine || '?';
            const title = r.title || '';
            const content = r.content || '';
            if (content.length > 20) {
              parts.push(`[web:${engine}] ${title}: ${content.slice(0, 300)}`);
            }
          }
          console.log(`[vcontext:predict] SearXNG: ${searchResult.results.length} results`);
        } else {
          console.log(`[vcontext:predict] SearXNG: no results or null response`);
        }
      } catch (e) {
        console.log(`[vcontext:predict] SearXNG error: ${e.message}`);
      }

      // 3c: Generate background knowledge with MLX (local, no external call)
      try {
        const bgPrompt = `List 3 key technical facts or best practices about: ${sanitized}
Output as a numbered list. Be specific and actionable. Max 100 words.`;
        const bgKnowledge = await mlxGenerate(bgPrompt, { maxTokens: 4000, temperature: 0.3 });
        if (bgKnowledge && bgKnowledge.length > 20) {
          parts.push(`[knowledge] ${bgKnowledge.trim()}`);
        }
      } catch {}

      // 3d: Wikipedia (one request for first keyword)
      try {
        const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(searchWords[0] || sanitized.split(' ')[0])}`;
        const wikiResult = await new Promise((resolve) => {
          const req = httpsRequest(new URL(wikiUrl), {
            method: 'GET', timeout: 5000,
            headers: { 'User-Agent': 'vcontext/2.0' },
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (wikiResult && wikiResult.extract) {
          parts.push(`[wiki] ${wikiResult.extract.slice(0, 300)}`);
        }
      } catch {}

      if (parts.length === 0) return;

      const content = JSON.stringify({
        query: sanitized,
        original_keywords: keywords.trim(),
        results: parts,
        source: 'vcontext+mlx+wikipedia',
        fetched_at: new Date().toISOString(),
      });

      // Step 5: Store in vcontext (use handleStore-compatible direct insert)
      try {
        const tagsJson = JSON.stringify(['predictive-search', 'auto']);
        const tokenEst = estimateTokens(content);
        // Use parameterized-safe esc() for the insert
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('predictive-search', ${esc(content)}, ${esc(tagsJson)}, ${esc(body.session || 'predictive')}, ${tokenEst}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:predict] Searched: "${sanitized}" → ${parts.length} results stored`);
      } catch (storeErr) {
        // Fallback: store a simplified version if content has problematic chars
        const simpleContent = JSON.stringify({ query: sanitized, results: parts.map(p => p.slice(0, 200)), source: 'searxng' });
        try {
          dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('predictive-search', ${esc(simpleContent)}, '["predictive-search","auto"]', ${esc(body.session || 'predictive')}, ${estimateTokens(simpleContent)}, datetime('now'), 0, 'ram');`);
          console.log(`[vcontext:predict] Searched: "${sanitized}" → ${parts.length} results stored (simplified)`);
        } catch (e2) {
          console.error(`[vcontext:predict] Store failed: ${e2.message}`);
        }
      }
    } catch (e) {
      // Non-fatal
      console.error('[vcontext:predict] Error:', e.message);
    }
  });
}

// GET /skills/effectiveness — Skill usage stats + effectiveness
function handleSkillEffectiveness(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Count skill usage from skill-usage entries
  const usageRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-usage' ORDER BY id DESC LIMIT 500;");
  const skillCounts = {};
  for (const row of usageRows) {
    try {
      const d = JSON.parse(row.content);
      for (const name of (d.skills || [])) {
        skillCounts[name] = (skillCounts[name] || 0) + 1;
      }
    } catch {}
  }

  // Count skill creation
  const createdRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-created';");
  const created = createdRows.map(r => { try { return JSON.parse(r.content).skill_name; } catch { return null; } }).filter(Boolean);

  // Count total registered skills
  const registeredRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-registry';");
  const registered = registeredRows.map(r => { try { return JSON.parse(r.content).name; } catch { return null; } }).filter(Boolean);

  // Find never-used skills
  const neverUsed = registered.filter(name => !skillCounts[name]);

  // Sort by usage
  const ranked = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  sendJson(res, 200, {
    total_registered: registered.length,
    total_auto_created: created.length,
    usage_ranking: ranked,
    never_used: neverUsed,
    never_used_count: neverUsed.length,
  });
}

// GET /metrics/report — API performance metrics
function handleMetricsReport(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const params = parseQuery(req.url);
  const hours = parseInt(params.hours) || 24;
  const since = esc(new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19));

  // Per-operation aggregates
  const opRows = dbQuery(`SELECT operation, COUNT(*) as count, AVG(latency_ms) as avg_latency, AVG(result_count) as avg_results, SUM(estimated_tokens_in) as total_tokens_in, SUM(estimated_tokens_out) as total_tokens_out FROM api_metrics WHERE created_at >= ${since} GROUP BY operation;`);
  const operations = {};
  for (const r of opRows) {
    operations[r.operation] = {
      count: r.count,
      avg_latency_ms: Math.round((r.avg_latency || 0) * 10) / 10,
      avg_result_count: Math.round((r.avg_results || 0) * 10) / 10,
      total_tokens_in: r.total_tokens_in || 0,
      total_tokens_out: r.total_tokens_out || 0,
    };
  }

  // Derived: resume cost (tokens used in session-recall operations)
  const resumeRows = dbQuery(`SELECT SUM(estimated_tokens_out) as cost FROM api_metrics WHERE task_kind = 'session-recall' AND created_at >= ${since};`);
  const resumeCost = resumeRows[0]?.cost || 0;

  // Derived: search hit rate (avg results / requested limit proxy)
  const recallOp = operations['recall'];
  const hitRate = recallOp ? Math.min(1, (recallOp.avg_result_count || 0) / 10) : 0;

  // Recent operations
  const recentRows = dbQuery(`SELECT * FROM api_metrics ORDER BY id DESC LIMIT 20;`);

  // Index stats
  const indexCount = dbQuery('SELECT COUNT(*) as c FROM entry_index;');
  const entryCount = dbQuery('SELECT COUNT(*) as c FROM entries;');

  // Credit savings calculation (two views):
  //
  // 24h savings: "of today's work, how much was served by prior context?"
  //   = prior_stored / (prior_stored + period_new)
  //   prior_stored = all tokens stored BEFORE this period
  //   period_new = tokens created in this period
  //
  // Cumulative: "of all knowledge, how much is reusable?"
  //   = all_stored / (all_stored + period_new)

  // All stored tokens
  const allStoredRows = dbQuery(`SELECT SUM(token_estimate) as total FROM entries;`);
  const allStoredTokens = allStoredRows[0]?.total || 0;

  // Tokens created in this period (new work)
  const periodNewRows = dbQuery(`SELECT SUM(token_estimate) as total FROM entries WHERE created_at >= ${since};`);
  const periodNewTokens = periodNewRows[0]?.total || 0;

  // Prior context = all stored minus what was created in this period
  const priorStoredTokens = Math.max(0, allStoredTokens - periodNewTokens);

  // 24h savings: prior context that didn't need regenerating / total needed
  const periodTotal = priorStoredTokens + periodNewTokens;
  const periodSavingsRate = periodTotal > 0 ? priorStoredTokens / periodTotal : 0;

  // Cumulative savings: all_stored / (all_stored + period_new)
  const cumulativeTotal = allStoredTokens + periodNewTokens;
  const cumulativeSavingsRate = cumulativeTotal > 0 ? allStoredTokens / cumulativeTotal : 0;

  // Session count for context
  const sessionCountRows = dbQuery(`SELECT COUNT(DISTINCT session) as c FROM entry_index WHERE created_at >= ${since};`);
  const activeSessions = sessionCountRows[0]?.c || 0;

  // Per-session breakdown
  const sessionRows = dbQuery(`SELECT session, COUNT(*) as events, SUM(token_estimate) as tokens FROM entry_index WHERE session IS NOT NULL AND created_at >= ${since} GROUP BY session ORDER BY events DESC LIMIT 20;`);
  const perSession = sessionRows.map(r => {
    const sessionNewTok = r.tokens || 0;
    const sessionTotal = allStoredTokens + sessionNewTok;
    return {
      session: r.session,
      events: r.events,
      tokens: sessionNewTok,
      savings_rate: sessionTotal > 0 ? Math.round(allStoredTokens / sessionTotal * 1000) / 1000 : 0,
    };
  });

  // Per-user breakdown (from entry tags)
  const userRows = dbQuery(`SELECT tags FROM entries WHERE created_at >= ${since} AND tags LIKE '%user:%';`);
  const userMap = {};
  for (const row of userRows) {
    try {
      const tags = JSON.parse(row.tags);
      for (const t of tags) {
        if (t.startsWith('user:')) {
          const u = t.slice(5);
          userMap[u] = (userMap[u] || 0) + 1;
        }
      }
    } catch {}
  }
  const perUser = Object.entries(userMap).sort((a, b) => b[1] - a[1]).map(([user, events]) => ({ user, events }));

  // Determine project (cwd) breakdown from entry_index content
  const projectRows = dbQuery(`SELECT ei.session, e.content FROM entry_index ei JOIN entries e ON ei.entry_id = e.id WHERE ei.created_at >= ${since} AND ei.session IS NOT NULL GROUP BY ei.session LIMIT 20;`);
  const projectMap = {};
  for (const row of projectRows) {
    try {
      const d = JSON.parse(row.content);
      const cwd = d.cwd || '';
      const project = cwd.split('/').filter(Boolean).pop() || 'unknown';
      projectMap[project] = (projectMap[project] || 0) + 1;
    } catch {}
  }
  const perProject = Object.entries(projectMap).sort((a, b) => b[1] - a[1]).map(([project, sessions]) => ({ project, sessions }));

  // Skill inventory for dashboard Metrics panel.
  // Note: some skill-registry contents contain YAML-style `"description":"|"`
  // which makes the string invalid JSON, so json_extract fails. Count by
  // distinct entry id instead and fall back to total if empty.
  const skillCountRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-registry';`);
  const skillCount = skillCountRow[0]?.c || 0;
  const skillCreatedRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-created';`);
  const skillCreated = skillCreatedRow[0]?.c || 0;
  const skillUsageRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-usage' AND created_at >= ${since};`);
  const skillUsageRecent = skillUsageRow[0]?.c || 0;

  sendJson(res, 200, {
    period_hours: hours,
    operations,
    skills: {
      registered: skillCount,
      auto_created: skillCreated,
      usage_in_period: skillUsageRecent,
    },
    derived: {
      resume_cost_tokens: resumeCost,
      search_hit_rate: Math.round(hitRate * 1000) / 1000,
      period_savings_rate: periodSavingsRate,
      prior_stored_tokens: priorStoredTokens,
      period_new_tokens: periodNewTokens,
      cumulative_savings_rate: cumulativeSavingsRate,
      cumulative_stored_tokens: allStoredTokens,
      active_sessions: activeSessions,
    },
    per_session: perSession,
    per_user: perUser,
    per_project: perProject,
    index: {
      indexed: indexCount[0]?.c || 0,
      total: entryCount[0]?.c || 0,
      coverage: entryCount[0]?.c ? Math.round((indexCount[0]?.c || 0) / entryCount[0].c * 1000) / 1000 : 0,
    },
    recent_operations: recentRows,
  });
}

// ── Request router ─────────────────────────────────────────────
const ENDPOINTS_LIST = [
  'POST   /store             — store context entry (body: {type,content,tags?,session?,namespace?,group?,reasoning?,conditions?,supersedes?,confidence?,status?})',
  'GET    /recall?q=         — full-text search (cascading tiers, &namespace=project-name)',
  'GET    /recent?n=         — recent entries (cascading tiers, &namespace=project-name)',
  'GET    /session/:id       — session entries',
  'POST   /summarize         — compact old entries',
  'GET    /stats             — database statistics',
  'DELETE /prune             — remove old entries',
  'GET    /health            — health check',
  'GET    /feed?since=       — activity feed since timestamp (&exclude_user=userId)',
  'POST   /tier/migrate      — trigger tier migration',
  'GET    /tier/stats        — per-tier statistics',
  'POST   /tier/config       — configure cloud provider',
  'POST   /auth/create-key   — create API key {userId, name, role?, groups?}',
  'GET    /auth/whoami       — show current user identity, role, groups',
  'POST   /auth/create-group — create group (owner only) {groupId, name}',
  'GET    /auth/groups       — list groups (owner=all, others=own)',
  'POST   /auth/update-key   — update key role/groups {apiKey, role?, groups?}',
  'GET    /auth/keys         — list API keys (admin+ only)',
  'POST   /resolve           — resolve conflicting decisions {query, context?, candidates?}',
  'POST   /consult           — create multi-model consultation {query, context?, models, candidates?}',
  'POST   /consult/:id/response — submit model response to consultation {model, chosen, reasoning?, confidence?}',
  'GET    /consult/:id       — check consultation status and aggregated results',
  'GET    /consult/pending?model= — list pending consultations for a model',
  'POST   /consult/auto-respond — batch respond to pending consultations {model, responses[]}',
  'GET    /ai/status         — local AI (MLX) status and capabilities',
  'POST   /ai/summarize      — summarize entries using local AI {ids?:[]}',
  'GET    /search/semantic?q= — semantic similarity search (&limit=10&threshold=0.5)',
  'POST   /analytics/track   — track usage event {event_type, skill_name?, session?, metadata?}',
  'GET    /analytics/report?days= — usage analytics report (default 30 days)',
  'GET    /metrics/report?hours= — API performance metrics (default 24h)',
  'WS     /ws                — WebSocket real-time push notifications (upgrade)',
  'WS     /ws?key=<apikey>   — WebSocket with API key auth',
  'GET    /dashboard         — browser dashboard UI',
];

const server = createServer(async (req, res) => {
  const method = req.method;
  const path = parsePath(req.url);

  // CORS (for any local tooling)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // Public-but-sensitive endpoints require API key when server is
    // bound to a non-loopback interface (LAN exposure). Loopback callers
    // are trusted as before.
    const PUBLIC_OPEN = new Set(['/dashboard', '/auth/whoami']);
    const isLoopback = (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1');
    const bindHost = process.env.VCONTEXT_BIND || '127.0.0.1';
    if (bindHost !== '127.0.0.1' && !isLoopback && !PUBLIC_OPEN.has(path)) {
      const auth = validateApiKey(req);
      if (!auth.valid) return sendJson(res, 401, { error: 'API key required (LAN access)' });
    }
    // Route
    if (method === 'POST' && path === '/store') {
      await handleStore(req, res);
    } else if (method === 'GET' && path === '/recall') {
      await handleRecall(req, res);
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
    } else if (method === 'GET' && path === '/feed') {
      handleFeed(req, res);
    } else if (method === 'POST' && path === '/federation/route') {
      // Routes a prompt to an AI tier based on declared task complexity.
      // Local MLX is "default"; if external_url + external_api_key is
      // provided in body, federates there for high-tier tasks.
      // Body: { prompt, tier?: 'haiku'|'sonnet'|'opus', maxTokens?, external? }
      const body = await readBody(req);
      const tier = body.tier || 'sonnet';
      try {
        // For now: all tiers go to local MLX (stub for future external).
        // Different temperature per tier as a stand-in for real model differentiation.
        const tempByTier = { haiku: 0.1, sonnet: 0.3, opus: 0.5 };
        const out = await mlxGenerate(body.prompt || '', {
          maxTokens: body.maxTokens || 4000,
          temperature: tempByTier[tier] ?? 0.3,
          caller: `federation:${tier}`,
        });
        sendJson(res, 200, { tier, used: 'mlx-local', content: out });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/vote') {
      // Consensus: same prompt, N samples (different seeds), majority wins.
      // Body: { prompt, samples?: 3 }
      const body = await readBody(req);
      const n = Math.max(2, Math.min(parseInt(body.samples, 10) || 3, 5));
      const responses = [];
      for (let i = 0; i < n; i++) {
        try {
          const r = await mlxGenerate(body.prompt || '', { maxTokens: 2000, temperature: 0.4, seed: 1000 + i, caller: 'vote' });
          responses.push(r.trim());
        } catch (e) { responses.push(`__error__: ${e.message}`); }
      }
      // Simple majority by exact-match
      const counts = {};
      for (const r of responses) counts[r] = (counts[r] || 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const winner = sorted[0];
      sendJson(res, 200, {
        samples: n,
        consensus: winner ? winner[0] : null,
        confidence: winner ? winner[1] / n : 0,
        all_responses: responses,
      });
    } else if (method === 'POST' && path === '/admin/multi-role-check') {
      // Runs 6 role-perspective checks in parallel and aggregates findings.
      // Each role asks different questions against the same live system
      // so no single blind spot hides a bug. Part of the AI OS's checker
      // discipline (not just a memory rule).
      const out = { roles: {}, findings: [], checked_at: new Date().toISOString() };
      const ramCount = (q) => { try { return ramDb.prepare(q).get(); } catch { return null; } };
      const ssdCount = (q) => { try { return ssdDb.prepare(q).get(); } catch { return null; } };

      // 1. QA
      const qa = {
        tool_errors_1h: ramCount(`SELECT COUNT(*) c FROM entries WHERE type='tool-error' AND created_at > datetime('now','-1 hour')`)?.c || 0,
        completion_violations_24h: ramCount(`SELECT COUNT(*) c FROM entries WHERE type='completion-violation' AND created_at > datetime('now','-1 day')`)?.c || 0,
        null_hash_rows: ramCount(`SELECT COUNT(*) c FROM entries WHERE content_hash IS NULL AND type NOT IN ('test','working-state','session-recall','anomaly-alert')`)?.c || 0,
      };
      if (qa.tool_errors_1h > 20) out.findings.push({ role: 'qa', msg: `tool-error spike: ${qa.tool_errors_1h}/1h` });
      if (qa.null_hash_rows > 500) out.findings.push({ role: 'qa', msg: `${qa.null_hash_rows} rows missing content_hash (dedup ineffective)` });
      out.roles.qa = qa;

      // 2. Architect
      const ramE = ramCount(`SELECT COUNT(*) c FROM entries`)?.c || 0;
      const ssdE = ssdCount(`SELECT COUNT(*) c FROM entries`)?.c || 0;
      const arch = { ram: ramE, ssd: ssdE, ram_pct: ramE + ssdE > 0 ? +(ramE / (ramE + ssdE) * 100).toFixed(1) : 0 };
      if (arch.ram_pct > 60) out.findings.push({ role: 'architect', msg: `tier imbalance: RAM ${arch.ram_pct}% (target <60%)` });
      out.roles.architect = arch;

      // 3. UX / dashboard clarity
      let dashOk = false;
      try {
        const tierStats = ramCount(`SELECT MIN(created_at) o FROM entries`);
        dashOk = /^20\d\d-\d\d-\d\d/.test(tierStats?.o || '');
      } catch {}
      out.roles.ux = { dashboard_dates_valid: dashOk };
      if (!dashOk) out.findings.push({ role: 'ux', msg: 'dashboard timestamps corrupted' });

      // 4. Security — secret patterns with WORD BOUNDARIES to avoid
      // matching path fragments like 'serene-keller' for 'sk-'.
      const sec = {
        api_key_perm: (() => { try { return require('node:fs').statSync(join(BACKUP_DIR, 'vcontext-api-keys.json')).mode & 0o777; } catch { return null; } })(),
        bind_host: process.env.VCONTEXT_BIND || '127.0.0.1',
        // GLOB with explicit prefix boundaries
        secret_pattern_hits: ramCount(`SELECT COUNT(*) c FROM entries WHERE created_at > datetime('now','-1 hour') AND (
          content GLOB '*[^a-zA-Z0-9-]sk-[A-Za-z0-9]*' OR
          content GLOB '*[^a-zA-Z0-9-]ghp_[A-Za-z0-9]*' OR
          content GLOB '*[^a-zA-Z0-9-]AKIA[A-Z0-9]*' OR
          content GLOB '*Bearer eyJ*'
        )`)?.c || 0,
      };
      if (sec.api_key_perm && sec.api_key_perm !== 0o600) out.findings.push({ role: 'security', msg: `api-key file perm ${sec.api_key_perm.toString(8)} (expected 600)` });
      if (sec.secret_pattern_hits > 0) out.findings.push({ role: 'security', msg: `${sec.secret_pattern_hits} entries with known-secret patterns` });
      out.roles.security = sec;

      // 5. Holistic — cross-subsystem consistency
      const ftsMatch = (ramCount(`SELECT COUNT(*) c FROM entries`)?.c || 0) === (ramCount(`SELECT COUNT(*) c FROM entries_fts`)?.c || 0);
      const holistic = { fts_in_sync: ftsMatch, queue_pending: (() => { try { return require('node:fs').readFileSync('/tmp/vcontext-queue.jsonl', 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } })() };
      if (!ftsMatch) out.findings.push({ role: 'holistic', msg: 'FTS out of sync with entries' });
      if (holistic.queue_pending > 100) out.findings.push({ role: 'holistic', msg: `queue backlog ${holistic.queue_pending}` });
      out.roles.holistic = holistic;

      // 6. Meta-checker — did other checks miss anything?
      const audit_recent = (() => {
        try {
          const r = spawnSync('sqlite3', [join(BACKUP_DIR, 'vcontext-audit.db'), `SELECT COUNT(*) FROM audit WHERE at > datetime('now','-1 hour')`], { encoding: 'utf-8' });
          return parseInt((r.stdout || '0').trim(), 10) || 0;
        } catch { return 0; }
      })();
      const meta = { audit_events_1h: audit_recent, checks_emitting_findings: new Set(out.findings.map(f => f.role)).size };
      if (audit_recent === 0) out.findings.push({ role: 'meta', msg: 'audit log silent 1h — maintenance may not be running' });
      out.roles.meta = meta;

      sendJson(res, 200, out);
    } else if (method === 'POST' && path === '/admin/mlx-test') {
      // Reproducibility / debug endpoint — calls mlxGenerate with a seed.
      const body = await readBody(req);
      try {
        const out = await mlxGenerate(body.prompt || '', { maxTokens: 200, temperature: 0, seed: body.seed, caller: 'repro' });
        sendJson(res, 200, { content: out, seed: body.seed });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/metrics/cost') {
      // MLX token usage since server start. Local model so no $ cost,
      // but useful for capacity planning and per-feature attribution.
      sendJson(res, 200, _mlxUsage);
    } else if (method === 'POST' && path === '/admin/wipe-user') {
      // Compliance: delete all entries tagged user:<id>. Returns count.
      const body = await readBody(req);
      const userId = body.userId;
      if (!userId) return sendJson(res, 400, { error: 'userId required' });
      try {
        const stmt = ramDb.prepare(`DELETE FROM entries WHERE tags LIKE ?`);
        const r = stmt.run(`%user:${userId}%`);
        const ssdR = ssdDb ? ssdDb.prepare(`DELETE FROM entries WHERE tags LIKE ?`).run(`%user:${userId}%`) : { changes: 0 };
        sendJson(res, 200, { ram_deleted: r.changes, ssd_deleted: ssdR.changes, userId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/verify-backup') {
      // Backup verification: open the latest snapshot read-only and run
      // integrity_check + a sample SELECT. Catches "I thought we had
      // backups but they were all corrupt" disasters.
      try {
        const SNAP_DIR = join(BACKUP_DIR, 'snapshots');
        const fs = require('node:fs');
        const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
        if (files.length === 0) return sendJson(res, 404, { error: 'no snapshots found' });
        const latest = join(SNAP_DIR, files[0]);
        const probe = new Database(latest, { readonly: true });
        try {
          const ok = probe.prepare('PRAGMA integrity_check').get();
          const cnt = probe.prepare('SELECT COUNT(*) as c FROM entries').get();
          sendJson(res, 200, {
            snapshot: files[0],
            integrity: ok.integrity_check === 'ok' ? 'ok' : ok.integrity_check,
            entry_count: cnt.c,
            verified_at: new Date().toISOString(),
          });
        } finally { probe.close(); }
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/pipeline/health') {
      // Per-feature heartbeat derived from entry recency — in a loosely
      // coupled AI OS, silent degradation is the biggest risk. This
      // endpoint lets the dashboard surface each pipeline's last
      // successful run alongside green/yellow/red thresholds.
      // Thresholds reflect each feature's INTENDED cadence:
      //  - Hook-driven (working-state, skill-usage, handoff): should fire
      //    every few minutes during active work
      //  - Scheduler-driven (predict 30m, discovery 5m with 24h dedup per
      //    topic, suggestion 30m): tens of minutes to hours
      //  - Condition-driven (completion-violation): no cadence — only
      //    fires when a completion is claimed; never = OK
      const features = [
        { key: 'predictive-search',  label: 'Predictive search',   type: 'predictive-search',   yellowMin: 60,    redMin: 360,  condition: false },
        { key: 'skill-discovery',    label: 'Skill discovery',     type: 'skill-discovery',     yellowMin: 1500,  redMin: 2880, condition: false }, // 24h topic cooldown
        { key: 'skill-suggestion',   label: 'Skill suggestion',    type: 'skill-suggestion',    yellowMin: 120,   redMin: 720,  condition: false },
        { key: 'skill-created',      label: 'Auto-create skill',   type: 'skill-created',       yellowMin: 360,   redMin: 1440, condition: false },
        { key: 'anomaly-alert',      label: 'Anomaly detection',   type: 'anomaly-alert',       yellowMin: null,  redMin: null, condition: true  }, // only fires when anomaly exists — silence = healthy
        { key: 'completion-violation', label: 'Completion check',  type: 'completion-violation',yellowMin: null,  redMin: null, condition: true  },
        { key: 'skill-usage',        label: 'Skill routing',       type: 'skill-usage',         yellowMin: 30,    redMin: 180,  condition: false },
        { key: 'working-state',      label: 'Per-turn snapshot',   type: 'working-state',       yellowMin: 10,    redMin: 60,   condition: false },
        { key: 'handoff',            label: 'Session handoff',     type: 'handoff',             yellowMin: 120,   redMin: 1440, condition: false },
        { key: 'session-recall',     label: 'Session recall',      type: 'session-recall',      yellowMin: null,  redMin: null, condition: true  }, // fires on session start — silence = no new session
      ];
      const now = Date.now();
      const features_out = features.map(f => {
        const row = dbQuery(
          `SELECT MAX(created_at) as last, COUNT(*) as total, SUM(CASE WHEN created_at > datetime('now','-24 hours') THEN 1 ELSE 0 END) as today FROM entries WHERE type = ${esc(f.type)};`
        );
        const last = row[0]?.last || null;
        const total = row[0]?.total || 0;
        const today = row[0]?.today || 0;
        let ageMin = null;
        if (last) {
          // SQLite returns 'YYYY-MM-DD HH:MM:SS' (UTC). Parse as UTC.
          ageMin = Math.floor((now - Date.parse(last.replace(' ', 'T') + 'Z')) / 60000);
        }
        let status = 'green';
        if (f.condition) {
          // Condition-driven features are idle by default; only flag
          // when there's been specific activity that aged out.
          status = 'idle';
        } else if (ageMin == null || ageMin > f.redMin) {
          status = 'red';
        } else if (ageMin > f.yellowMin) {
          status = 'yellow';
        }
        return { key: f.key, label: f.label, last, age_min: ageMin, total, today, status, condition: !!f.condition };
      });
      const summary = {
        green:  features_out.filter(f => f.status === 'green').length,
        yellow: features_out.filter(f => f.status === 'yellow').length,
        red:    features_out.filter(f => f.status === 'red').length,
        idle:   features_out.filter(f => f.status === 'idle').length,
      };
      sendJson(res, 200, { summary, features: features_out });
    } else if (method === 'POST' && path === '/admin/run-all') {
      // Manually fire the AI-driven loops whose scheduler has gone quiet.
      // MLX uses a single serialized lock — run tasks SEQUENTIALLY so
      // they don't starve each other with 503 busy responses.
      sendJson(res, 202, { status: 'triggered' });
      setImmediate(async () => {
        const results = {};
        const safeRun = async (name, fn) => {
          const t0 = Date.now();
          try { await fn(); results[name] = `ok in ${Date.now()-t0}ms`; }
          catch (e) { results[name] = `err: ${e.message}`; }
        };
        await safeRun('discovery', () => runOneDiscovery());
        await safeRun('prediction', () => runOnePrediction());
        await safeRun('auto-create-skill', () => autoCreateSkill());
        console.log(`[vcontext:admin] run-all: ${JSON.stringify(results)}`);
      });
    } else if (method === 'POST' && path === '/admin/fts-rebuild') {
      // Rebuild the FTS5 index (recovers DELETE triggers after corruption).
      try {
        ramDb.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
        sendJson(res, 200, { status: 'rebuilt' });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/dedup-ssd') {
      // Focused SSD dedup. Creates index first to avoid O(n²) scan,
      // then uses MIN(id) GROUP BY (O(n log n)).
      const result = { deleted: 0, schema_fixed: 0, vacuumed: false, indexed: false, error: null };
      try {
        try {
          ssdDb.exec(`CREATE INDEX IF NOT EXISTS idx_ssd_dedup ON entries(type, content_hash);`);
          result.indexed = true;
        } catch {}
        try {
          const fix = ssdDb.prepare(
            `UPDATE entries SET created_at = token_estimate, token_estimate = CAST(created_at AS INTEGER)
             WHERE created_at NOT LIKE '20__-%' AND token_estimate LIKE '20__-%';`
          ).run();
          result.schema_fixed = fix.changes;
        } catch {}
        // Fast dedup: IDs to KEEP = MIN(id) per (type, content_hash);
        // DELETE everything else (within non-skip types).
        const del = ssdDb.prepare(`
          DELETE FROM entries
          WHERE type NOT IN ('test','working-state','session-recall','anomaly-alert')
            AND content_hash IS NOT NULL
            AND id NOT IN (
              SELECT MIN(id) FROM entries
              WHERE type NOT IN ('test','working-state','session-recall','anomaly-alert')
                AND content_hash IS NOT NULL
              GROUP BY type, content_hash
            );`).run();
        result.deleted = del.changes;
        try { ssdDb.exec(`VACUUM;`); result.vacuumed = true; } catch {}
        sendJson(res, 200, result);
      } catch (e) { result.error = e.message; sendJson(res, 500, result); }
    } else if (method === 'POST' && path === '/admin/dedup-migration') {
      // One-shot migration: add content_hash column, backfill for all
      // rows, delete duplicate entries (keep oldest id per group), then
      // add a UNIQUE index so future writes are atomically deduped.
      // Skip types where repetition is legitimate.
      const SKIP = ['test', 'working-state', 'session-recall', 'anomaly-alert'];
      const skipSql = SKIP.map(t => `'${t}'`).join(',');
      const crypto = require('node:crypto');
      const result = { added_column: false, backfilled: 0, deleted: 0, index_created: false, error: null };
      try {
        // 1. Add column (idempotent)
        try {
          ramDb.exec(`ALTER TABLE entries ADD COLUMN content_hash TEXT;`);
          result.added_column = true;
        } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

        // 2. Backfill hashes for rows that don't have one
        const rows = ramDb.prepare(`SELECT id, content FROM entries WHERE content_hash IS NULL OR content_hash = '';`).all();
        const update = ramDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
        const tx = ramDb.transaction((rs) => {
          for (const r of rs) {
            const h = crypto.createHash('sha256').update(String(r.content)).digest('hex');
            update.run(h, r.id);
          }
        });
        tx(rows);
        result.backfilled = rows.length;

        // 3. Identify + delete duplicates (keep MIN(id) per group)
        const delSql = `
          DELETE FROM entries WHERE id IN (
            SELECT id FROM entries e1
            WHERE type NOT IN (${skipSql})
              AND EXISTS (
                SELECT 1 FROM entries e2
                WHERE e2.session = e1.session
                  AND e2.type = e1.type
                  AND e2.content_hash = e1.content_hash
                  AND e2.id < e1.id
              )
          );`;
        const delInfo = ramDb.prepare(delSql).run();
        result.deleted = delInfo.changes;

        // 4. Create UNIQUE index
        try {
          ramDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_entry_hash ON entries(session, type, content_hash) WHERE type NOT IN (${skipSql});`);
          result.index_created = true;
        } catch (e) { result.error = 'index: ' + e.message; }

        // 5. Same for SSD DB (best-effort): backfill hashes AND delete
        //    duplicates cross-session (SSD is long-term cold store, rarely
        //    accessed; repeat content is always waste).
        if (ssdDb) {
          try {
            try { ssdDb.exec(`ALTER TABLE entries ADD COLUMN content_hash TEXT;`); } catch {}
            // 5a. Fix column-shift corruption from old migrateRamToSsd bug
            //     (some rows have integer in created_at, date in token_estimate).
            try {
              const fix = ssdDb.prepare(
                `UPDATE entries SET created_at = token_estimate, token_estimate = CAST(created_at AS INTEGER)
                 WHERE created_at NOT LIKE '20__-%' AND token_estimate LIKE '20__-%';`
              ).run();
              result.ssd_schema_fixed = fix.changes;
            } catch {}
            // 5b. Backfill hashes
            const ssdRows = ssdDb.prepare(`SELECT id, content FROM entries WHERE content_hash IS NULL OR content_hash = '';`).all();
            const ssdUpd = ssdDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
            const ssdTx = ssdDb.transaction((rs) => {
              for (const r of rs) {
                const h = crypto.createHash('sha256').update(String(r.content)).digest('hex');
                ssdUpd.run(h, r.id);
              }
            });
            ssdTx(ssdRows);
            result.ssd_backfilled = ssdRows.length;
            // 5c. Delete duplicates (keep MIN(id) per type+hash; SSD is
            //     cross-session so ignore session)
            const ssdDel = ssdDb.prepare(`
              DELETE FROM entries WHERE id IN (
                SELECT id FROM entries e1
                WHERE type NOT IN (${skipSql})
                  AND EXISTS (
                    SELECT 1 FROM entries e2
                    WHERE e2.type = e1.type AND e2.content_hash = e1.content_hash AND e2.id < e1.id
                  )
              );`).run();
            result.ssd_deleted = ssdDel.changes;
            try { ssdDb.exec(`VACUUM;`); } catch {}
          } catch (e) { result.ssd_error = e.message; }
        }

        // 6. VACUUM
        ramDb.exec(`VACUUM;`);
        sendJson(res, 200, result);
      } catch (e) {
        result.error = e.message;
        sendJson(res, 500, result);
      }
    } else if (method === 'POST' && path === '/admin/fts-full-rebuild') {
      // Nuclear rebuild: drop FTS + triggers, recreate, reindex from entries,
      // then hard-delete all status='migrated' rows. Done in a single
      // transaction on the live DB (no server restart needed).
      const result = { dropped: false, recreated: false, reindexed: 0, cleaned: 0, error: null };
      try {
        const tx = ramDb.transaction(() => {
          // Drop delete trigger FIRST so DROP TABLE doesn't cascade-fire it
          ramDb.exec(`DROP TRIGGER IF EXISTS entries_ai;`);
          ramDb.exec(`DROP TRIGGER IF EXISTS entries_ad;`);
          ramDb.exec(`DROP TABLE IF EXISTS entries_fts;`);
          result.dropped = true;
          // Recreate FTS virtual table + triggers
          ramDb.exec(`CREATE VIRTUAL TABLE entries_fts USING fts5(content, tags, type);`);
          ramDb.exec(`CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, content, tags, type) VALUES (new.id, new.content, new.tags, new.type);
          END;`);
          // DELETE trigger: use FTS5 contentless-deletion. The previous
          // form (VALUES('delete', rowid, content, tags, type)) requires
          // the stored columns to exactly match the old row — any drift
          // yields "SQL logic error" and blocks every DELETE on entries.
          // A plain DELETE from the FTS shadow table by rowid is safer.
          ramDb.exec(`CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
            DELETE FROM entries_fts WHERE rowid = old.id;
          END;`);
          result.recreated = true;
          // Reindex all rows
          const reindex = ramDb.prepare(
            `INSERT INTO entries_fts(rowid, content, tags, type) SELECT id, content, tags, type FROM entries;`
          );
          const info = reindex.run();
          result.reindexed = info.changes;
          // Hard-delete soft-migrated rows — trigger now works
          const del = ramDb.prepare(`DELETE FROM entries WHERE status='migrated'`);
          const delInfo = del.run();
          result.cleaned = delInfo.changes;
        });
        tx();
        // Vacuum to reclaim space
        ramDb.exec(`VACUUM;`);
        sendJson(res, 200, result);
      } catch (e) {
        result.error = e.message;
        console.error('[admin:fts-rebuild]', e.message);
        sendJson(res, 500, result);
      }
    } else if (method === 'POST' && path === '/admin/fts-hard-cleanup') {
      // After a successful FTS rebuild, attempt hard-delete of soft-
      // migrated rows. Returns counts.
      let deleted = 0, failed = 0;
      try {
        const rows = ramDb.prepare(`SELECT id FROM entries WHERE status='migrated'`).all();
        const del = ramDb.prepare(`DELETE FROM entries WHERE id = ?`);
        for (const r of rows) {
          try { del.run(r.id); deleted++; } catch { failed++; }
        }
      } catch {}
      sendJson(res, 200, { deleted, failed });
    } else if (method === 'POST' && path === '/tier/migrate') {
      handleTierMigrate(req, res);
    } else if (method === 'GET' && path === '/tier/stats') {
      handleTierStats(req, res);
    } else if (method === 'POST' && path === '/tier/config') {
      await handleTierConfig(req, res);
    } else if (method === 'POST' && path === '/auth/create-key') {
      await handleCreateKey(req, res);
    } else if (method === 'GET' && path === '/auth/whoami') {
      handleWhoami(req, res);
    } else if (method === 'POST' && path === '/auth/create-group') {
      await handleCreateGroup(req, res);
    } else if (method === 'GET' && path === '/auth/groups') {
      handleListGroups(req, res);
    } else if (method === 'POST' && path === '/auth/update-key') {
      await handleUpdateKey(req, res);
    } else if (method === 'GET' && path === '/auth/keys') {
      handleListKeys(req, res);
    } else if (method === 'POST' && path === '/resolve') {
      await handleResolve(req, res);
    } else if (method === 'POST' && path === '/consult') {
      await handleConsult(req, res);
    } else if (method === 'GET' && path === '/consult/pending') {
      handleConsultPending(req, res);
    } else if (method === 'POST' && path === '/consult/auto-respond') {
      await handleConsultAutoRespond(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/response$/)) {
      await handleConsultResponse(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/claim$/)) {
      await handleConsultClaim(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/close$/)) {
      await handleConsultClose(req, res);
    } else if (method === 'GET' && path === '/consult/list') {
      handleConsultList(req, res);
    } else if (method === 'GET' && path.match(/^\/consult\/[^/]+$/) && !path.endsWith('/response')) {
      handleConsultStatus(req, res);
    } else if (method === 'GET' && path === '/ai/status') {
      handleAiStatus(req, res);
    } else if (method === 'POST' && path === '/ai/summarize') {
      await handleAiSummarize(req, res);
    } else if (method === 'GET' && path === '/search/semantic') {
      await handleSemanticSearch(req, res);
    } else if (method === 'POST' && path === '/analytics/track') {
      await handleAnalyticsTrack(req, res);
    } else if (method === 'GET' && path === '/analytics/report') {
      handleAnalyticsReport(req, res);
    } else if (method === 'GET' && path === '/metrics/report') {
      handleMetricsReport(req, res);
    } else if (method === 'GET' && path === '/skills/effectiveness') {
      handleSkillEffectiveness(req, res);
    } else if (method === 'POST' && path === '/predictive-search') {
      await handlePredictiveSearch(req, res);
    } else if (method === 'POST' && path === '/completion-check') {
      await handleCompletionCheck(req, res);
    } else if (method === 'GET' && path === '/dashboard') {
      const html = readFileSync(join(SCRIPT_DIR, 'vcontext-dashboard.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      sendJson(res, 404, {
        error: 'Not found',
        endpoints: ENDPOINTS_LIST,
      });
    }
  } catch (e) {
    console.error(`[${method} ${path}]`, e.message);
    sendJson(res, 500, { error: e.message });
  }
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  handleWsUpgrade(req, socket);
});

// ── Lifecycle ──────────────────────────────────────────────────

// Ensure RAM disk + DB exist
ensureRamDisk();

// Open in-process SQLite connections (must precede schema migrations)
try { openDatabases(); } catch (e) { console.error('[startup] openDatabases:', e.message?.slice(0, 60)); }

// Startup tasks — each wrapped to prevent crash on memory pressure
try { migrateRamSchema(); } catch (e) { console.error('[startup] migrateRamSchema:', e.message?.slice(0, 60)); }
try { ensureSsdDb(); } catch (e) { console.error('[startup] ensureSsdDb:', e.message?.slice(0, 60)); }
// Open ssdDb if ensureSsdDb just created the file (was null at openDatabases time)
if (!ssdDb && existsSync(SSD_DB_PATH)) {
  try {
    ssdDb = new Database(SSD_DB_PATH);
    ssdDb.pragma('journal_mode = WAL');
    ssdDb.pragma('busy_timeout = 5000');
  } catch (e) { console.error('[startup] ssdDb late-open:', e.message?.slice(0, 60)); }
}
try { ensureConsultationsTable(); } catch (e) { console.error('[startup] ensureConsultationsTable:', e.message?.slice(0, 60)); }
try { restoreRamFromSsd(); } catch (e) { console.error('[startup] restoreRamFromSsd:', e.message?.slice(0, 60)); }
try { initVecDb(); if (vecDb) vecSync(); } catch (e) { console.error('[startup] initVecDb:', e.message?.slice(0, 60)); }

// Periodic backup + migration check (replaces plain backup timer)
const backupTimer = setInterval(doBackupAndMigrate, BACKUP_INTERVAL_MS);

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[vcontext] Received ${signal}, shutting down...`);
  clearInterval(backupTimer);
  // Close all WebSocket connections
  for (const [id, client] of wsClients) {
    try { client.socket.destroy(); } catch {}
  }
  wsClients.clear();
  // Synchronous backup on shutdown (doBackup is async now, so use copyFileSync directly)
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (existsSync(DB_PATH)) {
      copyFileSync(DB_PATH, BACKUP_PATH);
      console.log('[vcontext] Shutdown backup (file copy) complete');
    }
  } catch (e) { console.error('[vcontext] Shutdown backup failed:', e.message); }
  embedLoopRunning = false;
  discoveryLoopRunning = false;
  if (vecDb) { try { vecDb.close(); } catch {} }
  if (ramDb) { try { ramDb.close(); } catch {} }
  if (ssdDb) { try { ssdDb.close(); } catch {} }
  server.close(() => {
    console.log('[vcontext] Server closed');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Check local AI availability + start background loops
checkMlx().then(() => {
  if (mlxAvailable) {
    startEmbedLoop().catch(() => {});
  }
}).catch(() => {});
checkMlxGenerate().then(() => {
  if (mlxGenerateAvailable) {
    startDiscoveryLoop().catch(() => {});
    console.log('[discovery] Loop started (MLX generate available)');
  }
}).catch(() => {});

// Start — default 127.0.0.1 for safety, set VCONTEXT_BIND=0.0.0.0 for LAN.
const BIND_HOST = process.env.VCONTEXT_BIND || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`[vcontext] Virtual Context server running at http://${BIND_HOST}:${PORT}`);
  console.log(`[vcontext] Tier 1 (RAM):   ${DB_PATH}`);
  console.log(`[vcontext] Tier 2 (SSD):   ${SSD_DB_PATH}`);
  console.log(`[vcontext] Tier 3 (Cloud): ${cloudStore.isConfigured() ? 'configured' : 'not configured'}`);
  console.log(`[vcontext] Backup every ${BACKUP_INTERVAL_MS / 1000}s to ${BACKUP_PATH}`);
  console.log(`[vcontext] Auto-migrate: RAM→SSD after ${RAM_TO_SSD_DAYS}d, SSD→Cloud after ${SSD_TO_CLOUD_DAYS}d`);
  console.log(`[vcontext] WebSocket:   ws://127.0.0.1:${PORT}/ws`);
  console.log('[vcontext] Endpoints:');
  for (const ep of ENDPOINTS_LIST) {
    console.log(`  ${ep}`);
  }
});
