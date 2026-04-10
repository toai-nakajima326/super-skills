#!/usr/bin/env node
/**
 * Build Antigravity skills from master definitions.
 * Output: .antigravity/skills/<name>/SKILL.md + manifest.json
 *
 * Antigravity reads markdown instructions and uses a manifest
 * to register available skills.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { listSkillDirs, readSkill, validateMeta, copyRecursive, toDisplayName, truncateDesc, ensureDir, removeDirContents } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');
const OUT = join(ROOT, '.antigravity', 'skills');

function build() {
  removeDirContents(OUT);
  const dirs = listSkillDirs(SRC);
  let built = 0;
  const allErrors = [];
  const catalog = [];

  for (const dir of dirs) {
    const { meta, body } = readSkill(SRC, dir);
    const { errors, warnings } = validateMeta(meta, dir);

    if (errors.length) {
      allErrors.push(...errors);
      continue;
    }
    for (const w of warnings) console.warn(`  WARN: ${w}`);

    const destDir = join(OUT, dir);
    copyRecursive(join(SRC, dir), destDir);

    catalog.push({
      name: meta.name,
      displayName: toDisplayName(meta.name),
      description: truncateDesc(meta.description),
      path: `skills/${dir}/SKILL.md`
    });
    built++;
  }

  if (allErrors.length) {
    console.error('\nErrors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  // Write top-level catalog
  writeFileSync(
    join(OUT, '..', 'skills-catalog.json'),
    JSON.stringify({ version: 1, skills: catalog }, null, 2) + '\n'
  );

  console.log(`[antigravity] Built ${built} skills → .antigravity/skills/`);
}

build();
