#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SKILLS_DIR = path.join(os.homedir(), 'skills');
const STATE_FILE = path.join(SKILLS_DIR, 'docs', 'session-state.json');
const SNAPSHOTS_FILE = path.join(SKILLS_DIR, 'docs', 'session-snapshots.jsonl');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a shell command and return trimmed stdout, or fallback on error. */
function run(cmd, fallback = '') {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return fallback;
  }
}

/** Derive a short project name from the cwd path. */
function projectName(cwd) {
  const parts = cwd.split(path.sep).filter(Boolean);
  // Skip common prefixes like Users/<name>
  const start = parts.findIndex((p) => p === 'projects' || p === 'repos' || p === 'src');
  if (start !== -1 && start + 1 < parts.length) {
    return parts.slice(start + 1).join('/');
  }
  // Fall back to last path component
  return parts[parts.length - 1] || 'unknown';
}

/** Build a git status summary. */
function gitStatusSummary() {
  const raw = run('git status --porcelain 2>/dev/null');
  if (!raw) return { label: 'clean', files: [] };
  const files = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const status = line.substring(0, 2).trim();
      const file = line.substring(3);
      return { status, file };
    });
  return { label: `dirty (${files.length} file${files.length === 1 ? '' : 's'})`, files };
}

/** Get the most recent commit hash + message. */
function lastCommit() {
  return run('git log -1 --pretty=format:"%h %s" 2>/dev/null', 'no commits');
}

/** Get the current git branch. */
function gitBranch() {
  return run('git branch --show-current 2>/dev/null', 'detached/unknown');
}

/** Detect skills in ~/.claude/skills/ by walking the directory tree. */
function detectActiveSkills() {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  try {
    const entries = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.md')) {
          entries.push(path.relative(skillsDir, full).replace(/\.md$/, ''));
        }
      }
    };
    walk(skillsDir);
    return entries.sort();
  } catch {
    return [];
  }
}

/** Detect recently modified files in the working tree (last few commits + uncommitted). */
function recentlyTouchedFiles() {
  const modified = run('git diff --name-only HEAD 2>/dev/null');
  const staged = run('git diff --cached --name-only 2>/dev/null');
  const recent = run('git diff --name-only HEAD~3..HEAD 2>/dev/null');

  const all = new Set();
  [modified, staged, recent].forEach((block) => {
    block
      .split('\n')
      .filter(Boolean)
      .forEach((f) => all.add(f));
  });
  return [...all].sort();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function capture() {
  const cwd = process.cwd();
  const status = gitStatusSummary();

  const state = {
    capturedAt: new Date().toISOString(),
    cwd,
    activeProject: projectName(cwd),
    gitBranch: gitBranch(),
    gitStatus: status.label,
    gitChangedFiles: status.files,
    lastCommit: lastCommit(),
    todoItems: [],
    activeSkills: detectActiveSkills(),
    openFiles: recentlyTouchedFiles(),
    conversationSummary: '',
    nextActions: '',
    environmentNotes: '',
  };

  // Ensure output directory exists
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`Session state captured to ${STATE_FILE}`);
  console.log(`  Project : ${state.activeProject}`);
  console.log(`  Branch  : ${state.gitBranch}`);
  console.log(`  Status  : ${state.gitStatus}`);
  console.log(`  Commit  : ${state.lastCommit}`);
  console.log(`  Files   : ${state.openFiles.length} recently touched`);
  console.log(`  Skills  : ${state.activeSkills.length} detected`);

  return state;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restore() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`No session state found at ${STATE_FILE}`);
    console.error('Run "node scripts/session-state.js capture" first.');
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // Format todo items
  let todoSection = '(none captured)';
  if (state.todoItems && state.todoItems.length > 0) {
    todoSection = state.todoItems
      .map((item) => {
        const icon =
          item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
        return `- ${icon} ${item.content}`;
      })
      .join('\n');
  }

  // Format changed files
  let gitDetail = state.gitStatus;
  if (state.gitChangedFiles && state.gitChangedFiles.length > 0) {
    const fileList = state.gitChangedFiles.map((f) => `  ${f.status} ${f.file}`).join('\n');
    gitDetail += '\n' + fileList;
  }

  // Format open files
  let filesSection = '';
  if (state.openFiles && state.openFiles.length > 0) {
    filesSection =
      '\n### Recently Touched Files\n' + state.openFiles.map((f) => `- ${f}`).join('\n');
  }

  // Format active skills
  let skillsSection = '';
  if (state.activeSkills && state.activeSkills.length > 0) {
    skillsSection =
      '\n### Active Skills\n' + state.activeSkills.map((s) => `- ${s}`).join('\n');
  }

  const prompt = [
    `## Session Restore -- ${state.capturedAt}`,
    `Project: ${state.activeProject} (${state.cwd})`,
    `Branch: ${state.gitBranch} -- ${state.lastCommit}`,
    `Git: ${gitDetail}`,
    '',
    '### Todo',
    todoSection,
    '',
    '### Active Context',
    state.conversationSummary || '(none captured)',
    '',
    '### Next Actions',
    state.nextActions || '(none captured)',
    '',
    '### Notes',
    state.environmentNotes || '(none captured)',
    filesSection,
    skillsSection,
  ]
    .join('\n')
    .trim();

  console.log(prompt);
  return prompt;
}

// ---------------------------------------------------------------------------
// Auto-capture (append snapshot to JSONL)
// ---------------------------------------------------------------------------

function autoCapture() {
  const state = capture();

  // Also append to the snapshots JSONL for history
  const dir = path.dirname(SNAPSHOTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(SNAPSHOTS_FILE, JSON.stringify(state) + '\n', 'utf8');
  console.log(`Snapshot appended to ${SNAPSHOTS_FILE}`);

  return state;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node scripts/session-state.js <command>

Commands:
  capture   Save current session state to docs/session-state.json
  restore   Output a formatted restore prompt from the saved state
  auto      Capture + append snapshot to docs/session-snapshots.jsonl

Options:
  --help    Show this help message`);
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(command ? 0 : 1);
}

switch (command) {
  case 'capture':
    capture();
    break;
  case 'restore':
    restore();
    break;
  case 'auto':
    autoCapture();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
