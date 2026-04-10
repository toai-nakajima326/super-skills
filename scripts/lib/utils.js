/**
 * Shared utilities for build scripts.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Parse YAML-like frontmatter from a markdown string. */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: match[2] };
}

/** Validate required frontmatter fields. Returns { errors, warnings }. */
export function validateMeta(meta, skillDir) {
  const errors = [];
  const warnings = [];
  if (!meta.name) errors.push(`${skillDir}: missing "name"`);
  if (!meta.description) errors.push(`${skillDir}: missing "description"`);
  if (!meta.origin) warnings.push(`${skillDir}: missing "origin"`);
  if (meta.name && meta.name !== skillDir) {
    warnings.push(`${skillDir}: name "${meta.name}" does not match directory`);
  }
  return { errors, warnings };
}

/** kebab-case to Display Name. */
export function toDisplayName(kebab) {
  return kebab.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Truncate description to maxLen characters at word boundary. */
export function truncateDesc(desc, maxLen = 120) {
  if (desc.length <= maxLen) return desc;
  const cut = desc.lastIndexOf(' ', maxLen);
  return desc.slice(0, cut > 0 ? cut : maxLen) + '...';
}

/** Ensure directory exists (recursive). */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Remove all contents of a directory (but keep the directory). */
export function removeDirContents(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore if not exists */ }
  ensureDir(dir);
}

/** Recursively copy src to dest. */
export function copyRecursive(src, dest) {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
  } else {
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
  }
}

/** List skill directories under the given root. */
export function listSkillDirs(skillsRoot) {
  return readdirSync(skillsRoot)
    .filter(d => {
      try { return statSync(join(skillsRoot, d)).isDirectory(); } catch { return false; }
    })
    .sort();
}

/** Read and parse a SKILL.md from a skill directory. */
export function readSkill(skillsRoot, skillDir) {
  const filePath = join(skillsRoot, skillDir, 'SKILL.md');
  const content = readFileSync(filePath, 'utf-8');
  return { ...parseFrontmatter(content), filePath };
}
