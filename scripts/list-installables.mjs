#!/usr/bin/env node

import { buildListing, formatListing, loadManifestBundle, parseArgs, printJson } from "./install-lib.mjs";

function usage() {
  return [
    "Usage: node scripts/list-installables.mjs [--json]",
    "Options:",
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
  const listing = buildListing(bundle);

  if (options.json) {
    printJson(listing);
  } else {
    process.stdout.write(`${formatListing(listing)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
