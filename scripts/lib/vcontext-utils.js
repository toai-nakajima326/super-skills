/**
 * Pure utility functions for vcontext-server.
 * No state, no I/O, no side effects. Safe to import anywhere.
 *
 * Extracted from vcontext-server.js (2026-04-17) as a proof-of-concept
 * for the module-split refactor. Further extractions (MLX client, DB
 * layer, route handlers) can follow the same pattern.
 */

/**
 * Escape a string for safe SQL embedding (single-quote doubling).
 * Returns the literal 'NULL' for null/undefined so callers can drop
 * this straight into a VALUES (..., ${esc(x)}, ...) tuple.
 */
export function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

/**
 * Sanitize a user query string for SQLite FTS5 MATCH.
 * Strips characters that cause FTS5 parse errors (period, brackets,
 * common operators). Keeps alphanumerics + CJK + spaces.
 */
export function ftsQuery(q) {
  return String(q)
    .replace(/[<>\/\\(),;:!@#$%^&*+=\[\]{}|~`".'?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rough token estimate: 1 token ≈ 4 characters (OpenAI/Anthropic English
 * heuristic). Not accurate for CJK or code, but close enough for cost
 * tracking and budget limits.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * Parse the `tags` column of each row in-place from JSON string to array.
 * Idempotent — already-parsed arrays are left alone.
 */
export function parseTags(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const r of rows) {
    if (r && typeof r.tags === 'string') {
      try { r.tags = JSON.parse(r.tags); }
      catch { r.tags = []; }
    }
  }
  return rows;
}
