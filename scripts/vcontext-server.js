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
 */

import { createServer } from 'node:http';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.VCONTEXT_PORT || '3150', 10);
const MOUNT_POINT = '/Volumes/VContext';
const DB_PATH = join(MOUNT_POINT, 'vcontext.db');
const BACKUP_DIR = join(process.env.HOME, 'skills', 'data');
const BACKUP_PATH = join(BACKUP_DIR, 'vcontext-backup.sqlite');
const SSD_DB_PATH = join(BACKUP_DIR, 'vcontext-ssd.db');
const CLOUD_CONFIG_PATH = join(BACKUP_DIR, 'vcontext-cloud.json');
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WARN_SIZE_BYTES = 3 * 1024 * 1024 * 1024;     // 3 GB
const MAX_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024;     // 3.5 GB
const VALID_TYPES = ['conversation', 'decision', 'observation', 'code', 'error'];
const NAMESPACE_TAG_PREFIX = 'project:';
const RAM_TO_SSD_DAYS = 7;
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

/**
 * Run a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE).
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbExec(sql, dbPath = DB_PATH) {
  try {
    execFileSync('sqlite3', [dbPath, sql], {
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`[db exec error @ ${dbPath}]`, e.message);
    throw new Error(`SQLite exec error: ${e.message}`);
  }
}

/**
 * Run a SQL query and return rows as a JS array.
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbQuery(sql, dbPath = DB_PATH) {
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
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
    console.error(`[db query error @ ${dbPath}]`, e.message);
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

// ── Schema migration for tiered storage columns ───────────────
function migrateRamSchema() {
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

    // Back-fill last_accessed for existing rows that have NULL
    dbExec("UPDATE entries SET last_accessed = created_at WHERE last_accessed IS NULL;");
  } catch (e) {
    console.error('[vcontext] Schema migration for RAM DB failed:', e.message);
  }
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
  tier TEXT DEFAULT 'ssd'
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
    console.log('[vcontext] SSD database initialised');
  } else {
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
    } catch (e) {
      console.error('[vcontext] SSD schema migration failed:', e.message);
    }
  }
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
  try {
    const staleRows = dbQuery(
      `SELECT * FROM entries WHERE last_accessed < datetime('now', '-${RAM_TO_SSD_DAYS} days') ORDER BY last_accessed ASC;`,
    );
    if (staleRows.length === 0) return 0;

    for (const row of staleRows) {
      // Insert into SSD DB
      dbExec(
        `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier)
         VALUES (${esc(row.type)}, ${esc(row.content)}, ${esc(row.tags)}, ${esc(row.session)}, ${row.token_estimate || 0},
                 ${esc(row.created_at)}, ${esc(row.last_accessed)}, ${row.access_count || 0}, 'ssd');`,
        SSD_DB_PATH,
      );
    }

    // Remove from RAM DB
    const ids = staleRows.map(r => r.id).join(',');
    dbExec(`DELETE FROM entries WHERE id IN (${ids});`);

    console.log(`[vcontext:tier] Migrated ${staleRows.length} entries RAM → SSD`);
    return staleRows.length;
  } catch (e) {
    console.error('[vcontext:tier] RAM→SSD migration error:', e.message);
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
  if (!rows || rows.length === 0) return;
  try {
    for (const row of rows) {
      // Check if already in RAM (by original created_at + content hash to avoid dups)
      const existing = dbQuery(
        `SELECT id FROM entries WHERE created_at = ${esc(row.created_at)} AND type = ${esc(row.type)} AND content = ${esc(row.content)} LIMIT 1;`,
      );
      if (existing.length > 0) continue;

      dbExec(
        `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier)
         VALUES (${esc(row.type)}, ${esc(row.content)}, ${esc(row.tags)}, ${esc(row.session)}, ${row.token_estimate || 0},
                 ${esc(row.created_at)}, datetime('now'), ${(row.access_count || 0) + 1}, 'ram');`,
      );
    }
    console.log(`[vcontext:tier] Promoted ${rows.length} entries from ${sourceTier} → RAM`);
  } catch (e) {
    console.error('[vcontext:tier] Promote to RAM failed:', e.message);
  }
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
 * Body: { type, content, tags?, session? }
 */
async function handleStore(req, res) {
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

  if (!type || !content) {
    return sendJson(res, 400, { error: 'Missing required fields: type, content' });
  }
  if (!VALID_TYPES.includes(type)) {
    return sendJson(res, 400, { error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
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
  const sql = `INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst}, datetime('now'), 0, 'ram');`;
  dbExec(sql);

  // Get the inserted row
  const rows = dbQuery('SELECT * FROM entries ORDER BY id DESC LIMIT 1;');
  const entry = rows[0] || {};

  // Write-through: immediately sync to SSD for crash safety
  try {
    const ssdSql = `INSERT OR REPLACE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst}, ${esc(entry.created_at || now)}, ${esc(entry.created_at || now)}, 0, 'ssd');`;
    dbExec(ssdSql, SSD_DB_PATH);
  } catch (e) {
    // SSD write failure is non-fatal, log but don't block
    console.error('[write-through] SSD sync failed:', e.message);
  }

  if (sizeCheck.msg) {
    entry._warning = sizeCheck.msg;
  }

  sendJson(res, 201, { stored: entry });
}

/**
 * GET /recall?q=keyword&type=conversation&limit=10
 * Searches all tiers: RAM → SSD → Cloud (if configured)
 */
function handleRecall(req, res) {
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

  parseTags(allResults);

  sendJson(res, 200, { results: allResults, count: allResults.length, query: q });
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
  const typeFilter = type && VALID_TYPES.includes(type) ? ` AND e.type = ${esc(type)}` : '';
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

  const ftsSql = `SELECT e.*, rank
    FROM entries_fts fts
    JOIN entries e ON e.id = fts.rowid
    WHERE entries_fts MATCH ${esc(q)}${typeFilter}${nsFilter}${userFlt}${groupFilter}
    ORDER BY rank * 0.7 + (julianday(e.created_at) - julianday('2024-01-01')) * 0.3
    LIMIT ${limit};`;

  try {
    return dbQuery(ftsSql, dbPath);
  } catch {
    // FTS query syntax error — fall back to LIKE search
    const likeSql = `SELECT * FROM entries WHERE content LIKE ${esc('%' + q + '%')}${typeFilter}${nsFilter}${userFlt}${groupFilter.replace(/e\./g, '')} ORDER BY created_at DESC LIMIT ${limit};`;
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
  const typeFilter = type && VALID_TYPES.includes(type) ? ` AND type = ${esc(type)}` : '';
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
    uptime_seconds: Math.floor(process.uptime()),
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

import { randomBytes } from 'node:crypto';

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

// ── Utilities ──────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ── Periodic migration check (piggybacks on backup timer) ─────
function doBackupAndMigrate() {
  doBackup();
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
}

// ── Request router ─────────────────────────────────────────────
const ENDPOINTS_LIST = [
  'POST   /store             — store context entry (body: {type,content,tags?,session?,namespace?,group?})',
  'GET    /recall?q=         — full-text search (cascading tiers, &namespace=project-name)',
  'GET    /recent?n=         — recent entries (cascading tiers, &namespace=project-name)',
  'GET    /session/:id       — session entries',
  'POST   /summarize         — compact old entries',
  'GET    /stats             — database statistics',
  'DELETE /prune             — remove old entries',
  'GET    /health            — health check',
  'POST   /tier/migrate      — trigger tier migration',
  'GET    /tier/stats        — per-tier statistics',
  'POST   /tier/config       — configure cloud provider',
  'POST   /auth/create-key   — create API key {userId, name, role?, groups?}',
  'GET    /auth/whoami       — show current user identity, role, groups',
  'POST   /auth/create-group — create group (owner only) {groupId, name}',
  'GET    /auth/groups       — list groups (owner=all, others=own)',
  'POST   /auth/update-key   — update key role/groups {apiKey, role?, groups?}',
  'GET    /auth/keys         — list API keys (admin+ only)',
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

// ── Lifecycle ──────────────────────────────────────────────────

// Ensure RAM disk + DB exist
ensureRamDisk();

// Migrate schema for tiered storage columns
migrateRamSchema();

// Ensure SSD database exists
ensureSsdDb();

// Periodic backup + migration check (replaces plain backup timer)
const backupTimer = setInterval(doBackupAndMigrate, BACKUP_INTERVAL_MS);

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
  console.log(`[vcontext] Tier 1 (RAM):   ${DB_PATH}`);
  console.log(`[vcontext] Tier 2 (SSD):   ${SSD_DB_PATH}`);
  console.log(`[vcontext] Tier 3 (Cloud): ${cloudStore.isConfigured() ? 'configured' : 'not configured'}`);
  console.log(`[vcontext] Backup every ${BACKUP_INTERVAL_MS / 1000}s to ${BACKUP_PATH}`);
  console.log(`[vcontext] Auto-migrate: RAM→SSD after ${RAM_TO_SSD_DAYS}d, SSD→Cloud after ${SSD_TO_CLOUD_DAYS}d`);
  console.log('[vcontext] Endpoints:');
  for (const ep of ENDPOINTS_LIST) {
    console.log(`  ${ep}`);
  }
});
