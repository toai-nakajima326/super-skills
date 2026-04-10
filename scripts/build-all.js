#!/usr/bin/env node
/**
 * Run all host-specific build scripts sequentially.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const scripts = [
  'build-claude-skills.js',
  'build-codex-skills.js',
  'build-cursor-skills.js',
  'build-kiro-skills.js',
  'build-antigravity-skills.js',
];

console.log('Building all targets...\n');

for (const script of scripts) {
  try {
    const out = execSync(`node ${join(ROOT, 'scripts', script)}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(out.trim());
  } catch (err) {
    console.error(`FAILED: ${script}`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

console.log('\nAll targets built successfully.');
