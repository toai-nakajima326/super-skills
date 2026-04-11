#!/usr/bin/env node
/**
 * Run all host-specific build scripts sequentially.
 * Before building, archive changed skills to vcontext for version history.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { archiveChangedSkills } from './lib/vcontext-skill-archive.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');

const targets = [
  { script: 'build-claude-skills.js', out: join(ROOT, '.claude', 'skills'), name: 'claude' },
  { script: 'build-codex-skills.js', out: join(ROOT, '.agents', 'skills'), name: 'codex' },
  { script: 'build-cursor-skills.js', out: join(ROOT, '.cursor', 'rules', 'skills'), name: 'cursor' },
  { script: 'build-kiro-skills.js', out: join(ROOT, '.kiro', 'skills'), name: 'kiro' },
  { script: 'build-antigravity-skills.js', out: join(ROOT, '.antigravity', 'skills'), name: 'antigravity' },
];

async function main() {
  console.log('Building all targets...\n');

  // Archive changed skills before overwriting
  let totalArchived = 0;
  for (const t of targets) {
    try {
      const result = await archiveChangedSkills(SRC, t.out, t.name);
      if (result.archived > 0) {
        console.log(`[archive] ${t.name}: ${result.archived} changed skills saved to vcontext`);
        totalArchived += result.archived;
      }
    } catch (e) {
      // Non-fatal: archive failure should not block build
      console.warn(`[archive] ${t.name}: skipped (${e.message})`);
    }
  }
  if (totalArchived > 0) console.log(`[archive] Total: ${totalArchived} skill versions archived\n`);

  // Build each target
  for (const t of targets) {
    try {
      const out = execSync(`node ${join(ROOT, 'scripts', t.script)}`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      console.log(out.trim());
    } catch (err) {
      console.error(`FAILED: ${t.script}`);
      console.error(err.stderr || err.message);
      process.exit(1);
    }
  }

  console.log('\nAll targets built successfully.');
}

main().catch(e => { console.error(e); process.exit(1); });
