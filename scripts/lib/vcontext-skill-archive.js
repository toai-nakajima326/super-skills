/**
 * Archive skill versions to vcontext before build overwrites them.
 *
 * On each build:
 *   1. Read current generated skills from target dirs
 *   2. Compare with source skills
 *   3. If changed, store the old version + diff in vcontext
 *
 * This makes skill evolution searchable via semantic search.
 * Gracefully skips if vcontext server is not running.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { listSkillDirs, readSkill } from './utils.js';

const VCONTEXT_PORT = process.env.VCONTEXT_PORT || '3150';
const VCONTEXT_URL = `http://127.0.0.1:${VCONTEXT_PORT}`;

function post(path, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = request(`${VCONTEXT_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({ _skipped: true }));
    req.on('timeout', () => { req.destroy(); resolve({ _skipped: true }); });
    req.write(body);
    req.end();
  });
}

function simpleDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined && newLine !== undefined) {
      diff.push(`-${i + 1}: ${oldLine}`);
      diff.push(`+${i + 1}: ${newLine}`);
    } else if (oldLine !== undefined) {
      diff.push(`-${i + 1}: ${oldLine}`);
    } else {
      diff.push(`+${i + 1}: ${newLine}`);
    }
  }
  return diff.join('\n');
}

/**
 * Archive changed skills before a build target overwrites them.
 *
 * @param {string} srcRoot  - Source skills dir (e.g. skills/)
 * @param {string} outRoot  - Generated skills dir (e.g. .claude/skills/)
 * @param {string} target   - Target name (e.g. 'claude', 'codex')
 * @param {string} skillFile - Filename to compare (e.g. 'SKILL.md')
 */
export async function archiveChangedSkills(srcRoot, outRoot, target, skillFile = 'SKILL.md') {
  // Quick health check — skip if server is down
  const health = await post('/health', {}).catch(() => null);
  if (!health || health._skipped) {
    return { archived: 0, skipped: true, reason: 'vcontext server not running' };
  }

  const dirs = listSkillDirs(srcRoot);
  let archived = 0;

  for (const dir of dirs) {
    const oldPath = join(outRoot, dir, skillFile);
    if (!existsSync(oldPath)) continue; // New skill, nothing to archive

    const newPath = join(srcRoot, dir, skillFile);
    if (!existsSync(newPath)) continue;

    let oldContent, newContent;
    try {
      oldContent = readFileSync(oldPath, 'utf-8');
      newContent = readFileSync(newPath, 'utf-8');
    } catch { continue; }

    if (oldContent === newContent) continue; // No change

    // Store old version
    await post('/store', {
      type: 'skill-version',
      content: oldContent,
      tags: ['skill-version', dir, target, `skill:${dir}`],
      session: `build-${Date.now()}`,
    });

    // Store diff
    const diff = simpleDiff(oldContent, newContent);
    if (diff) {
      await post('/store', {
        type: 'skill-diff',
        content: JSON.stringify({
          skill: dir,
          target,
          timestamp: new Date().toISOString(),
          diff: diff.slice(0, 100000),
          old_lines: oldContent.split('\n').length,
          new_lines: newContent.split('\n').length,
        }),
        tags: ['skill-diff', dir, target, `skill:${dir}`],
        session: `build-${Date.now()}`,
      });
    }

    archived++;
  }

  return { archived, total: dirs.length };
}
