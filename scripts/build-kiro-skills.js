#!/usr/bin/env node
/**
 * Build Kiro skills from master definitions.
 * Output: .kiro/skills/<name>/SKILL.md
 *
 * Kiro reads markdown specs from .kiro/ directory.
 * We copy the SKILL.md as-is and add a kiro.json manifest per skill.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { listSkillDirs, readSkill, validateMeta, copyRecursive, toDisplayName, truncateDesc, ensureDir, removeDirContents } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');
const OUT = join(ROOT, '.kiro', 'skills');

function generateKiroManifest(meta) {
  return JSON.stringify({
    name: meta.name,
    displayName: toDisplayName(meta.name),
    description: truncateDesc(meta.description),
    type: 'skill',
    entryPoint: 'SKILL.md'
  }, null, 2) + '\n';
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

    const destDir = join(OUT, dir);
    copyRecursive(join(SRC, dir), destDir);
    writeFileSync(join(destDir, 'kiro.json'), generateKiroManifest(meta));
    built++;
  }

  if (allErrors.length) {
    console.error('\nErrors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  console.log(`[kiro] Built ${built} skills → .kiro/skills/`);
}

build();
