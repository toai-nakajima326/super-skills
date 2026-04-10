#!/usr/bin/env node

import {
  buildPlan,
  formatValidationReport,
  loadManifestBundle,
  parseArgs,
  printJson
} from "./install-lib.mjs";

function usage() {
  return [
    "Usage: node scripts/install-validate.mjs [options]",
    "Options:",
    "  --profile <name>",
    "  --target <codex|claude|opencode|cursor>",
    "  --with <component>[,<component>...]",
    "  --without <component>[,<component>...]",
    "  --config <json-file>",
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
  const report = buildPlan(bundle, options);

  if (options.json) {
    printJson(report);
  } else {
    process.stdout.write(`${formatValidationReport(report)}\n`);
  }

  process.exit(report.status === "ok" ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
