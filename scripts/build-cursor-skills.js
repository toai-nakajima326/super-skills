#!/usr/bin/env node
/**
 * Build Cursor rules from master skill definitions.
 * Output: .cursor/rules/skills/<name>.mdc
 *
 * Cursor uses .mdc (Markdown Cursor) files with frontmatter:
 *   ---
 *   description: ...
 *   globs: (optional)
 *   alwaysApply: true|false
 *   ---
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { listSkillDirs, readSkill, validateMeta, truncateDesc, ensureDir, removeDirContents } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');
const OUT = join(ROOT, '.cursor', 'rules', 'skills');

function toMdc(meta, body) {
  return `---
description: "${truncateDesc(meta.description)}"
alwaysApply: false
---

# ${meta.name}

${body.trim()}
`;
}

function build() {
  removeDirContents(OUT);
  const dirs = listSkillDirs(SRC);
  let built = 0;
  const allErrors = [];

  for (const dir of dirs) {
    const { meta, body } = readSkill(SRC, dir);
    const { errors, warnings } = validateMeta(meta, dir);

    if (errors.length) {
      allErrors.push(...errors);
      continue;
    }
    for (const w of warnings) console.warn(`  WARN: ${w}`);

    // Only deploy infinite-skills to file system — rest lives in vcontext
    const DEPLOY_ONLY = ['infinite-skills'];
    if (!DEPLOY_ONLY.includes(dir)) continue;

    ensureDir(OUT);
    writeFileSync(join(OUT, `${dir}.mdc`), toMdc(meta, body));
    built++;
  }

  if (allErrors.length) {
    console.error('\nErrors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  console.log(`[cursor] Built ${built} rules → .cursor/rules/skills/`);
}

build();
