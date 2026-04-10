#!/usr/bin/env node
/**
 * Validate all master skill definitions without building.
 */
import { join } from 'node:path';
import { listSkillDirs, readSkill, validateMeta } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');

const dirs = listSkillDirs(SRC);
let errorCount = 0;
let warnCount = 0;

console.log(`Validating ${dirs.length} skills...\n`);

for (const dir of dirs) {
  try {
    const { meta } = readSkill(SRC, dir);
    const { errors, warnings } = validateMeta(meta, dir);

    for (const e of errors) {
      console.error(`  ERROR: ${e}`);
      errorCount++;
    }
    for (const w of warnings) {
      console.warn(`  WARN: ${w}`);
      warnCount++;
    }

    if (!errors.length && !warnings.length) {
      console.log(`  OK: ${dir}`);
    }
  } catch (err) {
    console.error(`  ERROR: ${dir} — ${err.message}`);
    errorCount++;
  }
}

console.log(`\n${dirs.length} skills checked: ${errorCount} errors, ${warnCount} warnings`);
if (errorCount) process.exit(1);
