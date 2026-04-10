#!/usr/bin/env node

import { buildPlan, formatPlan, loadManifestBundle, parseArgs, printJson } from "./install-lib.mjs";

function usage() {
  return [
    "Usage: node scripts/install-plan.mjs [options]",
    "Options:",
    "  --profile <name>",
    "  --target <codex|claude|opencode|cursor>",
    "  --with <component>[,<component>...]",
    "  --without <component>[,<component>...]",
    "  --config <json-file>",
    "  --target-root <path>",
    "  --dry-run",
    "  --json"
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const bundle = loadManifestBundle();
  const plan = buildPlan(bundle, options);

  if (options.json) {
    printJson(plan);
  } else {
    process.stdout.write(`${formatPlan(plan)}\n`);
  }

  process.exit(plan.status === "ok" ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
