#!/usr/bin/env node
/**
 * Build Claude Code skills from master definitions.
 * Output: .claude/skills/<name>/SKILL.md
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { listSkillDirs, readSkill, validateMeta, copyRecursive, ensureDir, removeDirContents } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');
const OUT = join(ROOT, '.claude', 'skills');

function build() {
  removeDirContents(OUT);
  const dirs = listSkillDirs(SRC);
  let built = 0;
  const allErrors = [];

  // Only deploy infinite-skills to .claude/skills/ — all other skills
  // live in vcontext skill-registry and are loaded on demand via recall
  const CLAUDE_DEPLOY = ['infinite-skills'];

  for (const dir of dirs) {
    const { meta, body, filePath } = readSkill(SRC, dir);
    const { errors, warnings } = validateMeta(meta, dir);

    if (errors.length) {
      allErrors.push(...errors);
      continue;
    }
    for (const w of warnings) console.warn(`  WARN: ${w}`);

    if (!CLAUDE_DEPLOY.includes(dir)) continue; // vcontext handles the rest

    const destDir = join(OUT, dir);
    copyRecursive(join(SRC, dir), destDir);
    built++;
  }

  if (allErrors.length) {
    console.error('\nErrors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  console.log(`[claude] Built ${built} skills → .claude/skills/`);
}

build();
