/**
 * llm-parse.js — shared helpers for parsing LLM output and validating
 * skill-name candidates before they flow into pending-patch entries.
 *
 * Used by:
 *   - scripts/new-feature-watcher.cjs
 *   - scripts/conversation-skill-miner.cjs
 *
 * Risks addressed (see docs/analysis/2026-04-18-watcher-miner-hardening.md):
 *   1. Fragile JSON regex: original greedy `/\{[\s\S]*\}/` mis-matches when LLM
 *      wraps JSON in a code fence or adds prose before/after. extractJson() tries
 *      (1) fenced block → (2) full-string parse → (3) greedy fallback.
 *   2. Skill-name from LLM interpolated into a path-shaped string. sanitizeSkillName()
 *      enforces an allowlist regex; assertSkillPathSafe() adds a path.resolve
 *      defense-in-depth check.
 */

'use strict';

const path = require('path');

/**
 * Best-effort JSON extraction from free-form LLM output.
 * Returns the parsed object on success, or null.
 */
function extractJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // (1) Fenced ```json block (strict form, then lenient).
  const fencedJson = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fencedJson) {
    try { return JSON.parse(fencedJson[1]); } catch { /* fall through */ }
  }
  const fencedAny = text.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedAny) {
    try { return JSON.parse(fencedAny[1]); } catch { /* fall through */ }
  }

  // (2) Try parsing the whole string — works when the LLM returns pure JSON.
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }

  // (3) Last-resort: first `{` to last `}` span (original behavior).
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const span = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(span); } catch { /* give up */ }
  }
  return null;
}

/**
 * Allowlist regex for skill directory names.
 * - must start with [a-z0-9]
 * - 2-64 chars total
 * - only [a-z0-9-] allowed
 * This matches the de-facto pattern used across existing skills
 * (see `ls ~/skills/skills/`).
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Inputs containing any of these indicate an attack attempt rather than
 * a messy-but-legitimate name. We reject outright — silently stripping
 * `..` or `;` etc. would turn e.g. `../../etc/passwd` into a valid
 * `etcpasswd`, hiding the attack from reviewers.
 */
const UNSAFE_RE = /[\/\\;&|<>`$(){}\[\]*?!'"\n\r\t\0]|\.\./;

/**
 * Normalize + validate a candidate skill name produced by an LLM.
 * Returns the sanitized name, or null if validation fails.
 *
 * Policy:
 *   - Reject outright when `raw` contains path separators, shell metachars,
 *     or `..` — these are attack indicators, not cosmetic issues.
 *   - Otherwise normalize cosmetic messiness:
 *     - trim whitespace
 *     - lowercase
 *     - collapse underscores / whitespace runs into a single `-`
 *     - drop leftover non-[a-z0-9-] characters
 *     - collapse runs of `-` into one
 *     - strip leading/trailing `-`
 *   - Final allowlist check against SKILL_NAME_RE.
 */
function sanitizeSkillName(raw) {
  if (typeof raw !== 'string') return null;
  if (UNSAFE_RE.test(raw)) return null;
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!SKILL_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Path-traversal defense-in-depth. Even when `name` passes the allowlist,
 * verify the resolved path stays inside SKILLS_ROOT. Throws on escape.
 * Returns the resolved absolute target path.
 */
function assertSkillPathSafe(skillsRoot, name) {
  const root = path.resolve(skillsRoot);
  const target = path.resolve(path.join(root, name, 'SKILL.md'));
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`skill path escapes SKILLS_ROOT: name=${JSON.stringify(name)} resolved=${target}`);
  }
  return target;
}

module.exports = {
  extractJson,
  sanitizeSkillName,
  assertSkillPathSafe,
  SKILL_NAME_RE,
};
