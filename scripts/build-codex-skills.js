#!/usr/bin/env node
/**
 * Build Codex (OpenAI) skills from master definitions.
 * Output: .agents/skills/<name>/SKILL.md + agents/openai.yaml
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { listSkillDirs, readSkill, validateMeta, copyRecursive, toDisplayName, truncateDesc, ensureDir, removeDirContents } from './lib/utils.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'skills');
const OUT = join(ROOT, '.agents', 'skills');

function generateOpenAIYaml(meta) {
  const displayName = toDisplayName(meta.name);
  const shortDesc = truncateDesc(meta.description);
  return `interface:
  display_name: "${displayName}"
  short_description: "${shortDesc}"
  default_prompt: "Use ${displayName} for this task."
policy:
  allow_implicit_invocation: true
`;
}

function build() {
  removeDirContents(OUT);
  const dirs = listSkillDirs(SRC);
  let built = 0;
  const allErrors = [];

  for (const dir of dirs) {
    const { meta, body, filePath } = readSkill(SRC, dir);
    const { errors, warnings } = validateMeta(meta, dir);

    if (errors.length) {
      allErrors.push(...errors);
      continue;
    }
    for (const w of warnings) console.warn(`  WARN: ${w}`);

    // Only deploy infinite-skills to file system — rest lives in vcontext
    const DEPLOY_ONLY = ['infinite-skills'];
    if (!DEPLOY_ONLY.includes(dir)) continue;

    // Copy skill directory
    const destDir = join(OUT, dir);
    copyRecursive(join(SRC, dir), destDir);

    // Generate OpenAI agent YAML
    const agentDir = join(destDir, 'agents');
    ensureDir(agentDir);
    writeFileSync(join(agentDir, 'openai.yaml'), generateOpenAIYaml(meta));

    built++;
  }

  if (allErrors.length) {
    console.error('\nErrors:');
    allErrors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
  }

  console.log(`[codex] Built ${built} skills → .agents/skills/`);
}

build();
