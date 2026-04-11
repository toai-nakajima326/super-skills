#!/usr/bin/env node
/**
 * Install skills into a target project.
 *
 * Usage:
 *   node scripts/install-apply.mjs --profile developer --target claude --target-root /path/to/project
 *   node scripts/install-apply.mjs --profile core --target cursor --target-root . --dry-run
 *
 * Options:
 *   --profile <name>         Profile: core | developer | security | research
 *   --target <host>          Target: claude | codex | cursor | kiro | antigravity
 *   --target-root <path>     Project root to install into
 *   --with <comp,...>        Additional components to include
 *   --without <comp,...>     Components to exclude
 *   --dry-run               Show what would be done without doing it
 *   --json                  Output plan as JSON
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const SELF_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// ─── Argument Parsing ───────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { profile: 'core', target: 'claude', targetRoot: '.', with: [], without: [], dryRun: false, json: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--profile':    opts.profile = args[++i]; break;
      case '--target':     opts.target = args[++i]; break;
      case '--target-root': opts.targetRoot = args[++i]; break;
      case '--with':       opts.with = args[++i].split(','); break;
      case '--without':    opts.without = args[++i].split(','); break;
      case '--dry-run':    opts.dryRun = true; break;
      case '--json':       opts.json = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// ─── Manifest Loading ───────────────────────────────────────────────

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadManifests() {
  const dir = join(SELF_ROOT, 'manifests');
  return {
    profiles: loadJson(join(dir, 'install-profiles.json')),
    modules: loadJson(join(dir, 'install-modules.json')),
    components: loadJson(join(dir, 'install-components.json')),
  };
}

// ─── Target Configuration ───────────────────────────────────────────

const TARGET_MAP = {
  claude:       { buildScript: 'build-claude-skills.js',       outputDir: '.claude/skills' },
  codex:        { buildScript: 'build-codex-skills.js',        outputDir: '.agents/skills' },
  cursor:       { buildScript: 'build-cursor-skills.js',       outputDir: '.cursor/rules/skills' },
  kiro:         { buildScript: 'build-kiro-skills.js',         outputDir: '.kiro/skills' },
  antigravity:  { buildScript: 'build-antigravity-skills.js',  outputDir: '.antigravity/skills' },
};

// ─── Plan Building ──────────────────────────────────────────────────

function buildPlan(opts, manifests) {
  const profile = manifests.profiles.profiles.find(p => p.name === opts.profile);
  if (!profile) {
    console.error(`Unknown profile: ${opts.profile}`);
    console.error(`Available: ${manifests.profiles.profiles.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  const targetConfig = TARGET_MAP[opts.target];
  if (!targetConfig) {
    console.error(`Unknown target: ${opts.target}`);
    console.error(`Available: ${Object.keys(TARGET_MAP).join(', ')}`);
    process.exit(1);
  }

  // Resolve modules → components
  const moduleNames = new Set(profile.modules);
  const componentNames = new Set();

  for (const mod of manifests.modules.modules) {
    if (moduleNames.has(mod.name)) {
      for (const comp of mod.components) {
        componentNames.add(comp);
      }
    }
  }

  // Apply --with / --without
  for (const c of opts.with) componentNames.add(c);
  for (const c of opts.without) componentNames.delete(c);

  // Resolve component definitions
  const components = [];
  for (const comp of manifests.components.components) {
    if (componentNames.has(comp.name)) {
      components.push(comp);
    }
  }

  return {
    profile: opts.profile,
    target: opts.target,
    targetRoot: resolve(opts.targetRoot),
    targetConfig,
    components,
    dryRun: opts.dryRun,
  };
}

// ─── Plan Execution ─────────────────────────────────────────────────

function applyPlan(plan) {
  const { target, targetRoot, targetConfig, components, dryRun } = plan;

  // Step 1: Run the build script to generate target-specific outputs
  console.log(`\n[1/3] Building ${target} skills...`);
  const buildCmd = `node ${join(SELF_ROOT, 'scripts', targetConfig.buildScript)}`;
  if (!dryRun) {
    execSync(buildCmd, { cwd: SELF_ROOT, stdio: 'inherit' });
  } else {
    console.log(`  (dry-run) Would run: ${buildCmd}`);
  }

  // Step 2: Copy selected components to target project
  console.log(`\n[2/3] Installing ${components.length} components into ${targetRoot}...`);
  const builtDir = join(SELF_ROOT, targetConfig.outputDir);
  const destDir = join(targetRoot, targetConfig.outputDir);

  for (const comp of components) {
    const srcPath = join(builtDir, comp.name);
    const destPath = join(destDir, comp.name);

    if (!existsSync(srcPath)) {
      // For cursor, files are flat .mdc
      const mdcSrc = join(builtDir, `${comp.name}.mdc`);
      const mdcDest = join(destDir, `${comp.name}.mdc`);
      if (existsSync(mdcSrc)) {
        if (!dryRun) {
          mkdirSync(destDir, { recursive: true });
          cpSync(mdcSrc, mdcDest);
        }
        console.log(`  ${dryRun ? '(dry-run) ' : ''}${comp.name}.mdc`);
        continue;
      }
      console.warn(`  SKIP: ${comp.name} (not found in build output)`);
      continue;
    }

    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
      cpSync(srcPath, destPath, { recursive: true });
    }
    console.log(`  ${dryRun ? '(dry-run) ' : ''}${comp.name}/`);
  }

  // Step 2b: Install vcontext hooks for the target
  console.log(`\n[2b/3] Installing vcontext hooks for ${target}...`);
  const pluginsDir = join(SELF_ROOT, 'plugins');

  if (target === 'codex') {
    const hooksSrc = join(pluginsDir, 'codex', 'hooks.json');
    const hooksDest = join(targetRoot, '.codex', 'hooks.json');
    if (existsSync(hooksSrc)) {
      if (!dryRun) {
        mkdirSync(join(targetRoot, '.codex'), { recursive: true });
        if (existsSync(hooksDest)) {
          // Merge: load existing, add vcontext hooks
          try {
            const existing = JSON.parse(readFileSync(hooksDest, 'utf-8'));
            const incoming = JSON.parse(readFileSync(hooksSrc, 'utf-8'));
            for (const [event, hooks] of Object.entries(incoming.hooks || {})) {
              if (!existing.hooks) existing.hooks = {};
              if (!existing.hooks[event]) existing.hooks[event] = [];
              // Avoid duplicates by checking command strings
              for (const hook of hooks) {
                const isDuplicate = existing.hooks[event].some(
                  h => h.command === hook.command
                );
                if (!isDuplicate) existing.hooks[event].push(hook);
              }
            }
            writeFileSync(hooksDest, JSON.stringify(existing, null, 2) + '\n');
          } catch {
            cpSync(hooksSrc, hooksDest);
          }
        } else {
          cpSync(hooksSrc, hooksDest);
        }
      }
      console.log(`  ${dryRun ? '(dry-run) ' : ''}.codex/hooks.json`);
    }
  } else if (target === 'cursor') {
    const hooksSrc = join(pluginsDir, 'cursor', 'hooks.json');
    const hooksDest = join(targetRoot, '.cursor', 'hooks.json');
    if (existsSync(hooksSrc)) {
      if (!dryRun) {
        mkdirSync(join(targetRoot, '.cursor'), { recursive: true });
        if (existsSync(hooksDest)) {
          try {
            const existing = JSON.parse(readFileSync(hooksDest, 'utf-8'));
            const incoming = JSON.parse(readFileSync(hooksSrc, 'utf-8'));
            for (const [event, hooks] of Object.entries(incoming.hooks || {})) {
              if (!existing.hooks) existing.hooks = {};
              if (!existing.hooks[event]) existing.hooks[event] = [];
              for (const hook of hooks) {
                const isDuplicate = existing.hooks[event].some(
                  h => h.command === hook.command
                );
                if (!isDuplicate) existing.hooks[event].push(hook);
              }
            }
            writeFileSync(hooksDest, JSON.stringify(existing, null, 2) + '\n');
          } catch {
            cpSync(hooksSrc, hooksDest);
          }
        } else {
          cpSync(hooksSrc, hooksDest);
        }
      }
      console.log(`  ${dryRun ? '(dry-run) ' : ''}.cursor/hooks.json`);
    }
  } else if (target === 'kiro') {
    const kiroHooksDir = join(pluginsDir, 'kiro', 'hooks');
    const kiroDestDir = join(targetRoot, '.kiro', 'hooks');
    if (existsSync(kiroHooksDir)) {
      if (!dryRun) {
        mkdirSync(kiroDestDir, { recursive: true });
        for (const file of ['vcontext-recall.md', 'vcontext-store.md', 'vcontext-end.md']) {
          const src = join(kiroHooksDir, file);
          if (existsSync(src)) {
            cpSync(src, join(kiroDestDir, file));
          }
        }
      }
      console.log(`  ${dryRun ? '(dry-run) ' : ''}.kiro/hooks/vcontext-*.md`);
    }
  } else if (target === 'claude') {
    console.log(`  Claude Code — hooks configured via global settings.json (no per-project action)`);
  }

  // Step 3: Copy extra target-specific files (e.g., antigravity catalog)
  if (target === 'antigravity') {
    const catalogSrc = join(SELF_ROOT, '.antigravity', 'skills-catalog.json');
    const catalogDest = join(targetRoot, '.antigravity', 'skills-catalog.json');
    if (existsSync(catalogSrc)) {
      if (!dryRun) {
        mkdirSync(join(targetRoot, '.antigravity'), { recursive: true });
        cpSync(catalogSrc, catalogDest);
      }
      console.log(`  ${dryRun ? '(dry-run) ' : ''}skills-catalog.json`);
    }
  }

  // Step 3: Write install state
  console.log(`\n[3/3] Saving install state...`);
  const state = {
    installedAt: new Date().toISOString(),
    profile: plan.profile,
    target: plan.target,
    components: components.map(c => c.name),
    superSkillsVersion: '1.0.0',
  };
  const statePath = join(targetRoot, '.install-state.json');
  if (!dryRun) {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  console.log(`  ${dryRun ? '(dry-run) ' : ''}State → ${statePath}`);
}

// ─── Main ───────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);
const manifests = loadManifests();
const plan = buildPlan(opts, manifests);

if (opts.json) {
  console.log(JSON.stringify(plan, null, 2));
  if (opts.dryRun) process.exit(0);
}

console.log(`Profile: ${plan.profile}`);
console.log(`Target:  ${plan.target}`);
console.log(`Root:    ${plan.targetRoot}`);
console.log(`Skills:  ${plan.components.map(c => c.name).join(', ')}`);

applyPlan(plan);

console.log('\nDone!');
