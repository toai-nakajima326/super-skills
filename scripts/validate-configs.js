#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing file: ${path.relative(ROOT, filePath)}`);
  }
}

function readJson(filePath) {
  ensureFile(filePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

function ensureTomlLike(filePath, requiredTokens) {
  ensureFile(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  for (const token of requiredTokens) {
    if (!content.includes(token)) {
      fail(`${path.relative(ROOT, filePath)} is missing expected token: ${token}`);
    }
  }
}

function runNodeScript(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    fail(stderr || stdout || `command failed: node ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

readJson(path.join(ROOT, "mcp", "catalog.json"));
for (const fileName of fs.readdirSync(path.join(ROOT, "mcp", "profiles")).filter((name) => name.endsWith(".json"))) {
  readJson(path.join(ROOT, "mcp", "profiles", fileName));
}

readJson(path.join(ROOT, "manifests", "install-components.json"));
readJson(path.join(ROOT, "manifests", "install-profiles.json"));
readJson(path.join(ROOT, "manifests", "install-modules.json"));
readJson(path.join(ROOT, "plugins", "claude", "hooks", "super-skills.hooks.json"));

ensureTomlLike(path.join(ROOT, ".codex", "config.toml"), [
  "approval_policy",
  "sandbox_mode",
  "[features]",
  "[agents]",
]);
ensureTomlLike(path.join(ROOT, ".codex", "agents", "explorer.toml"), ["sandbox_mode", "developer_instructions"]);
ensureTomlLike(path.join(ROOT, ".codex", "agents", "reviewer.toml"), ["sandbox_mode", "developer_instructions"]);
ensureTomlLike(path.join(ROOT, ".codex", "agents", "docs-researcher.toml"), ["sandbox_mode", "developer_instructions"]);
ensureFile(path.join(ROOT, ".claude", "AGENTS.md"));

const skillDirs = fs
  .readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const skillName of skillDirs) {
  ensureFile(path.join(ROOT, "skills", skillName, "SKILL.md"));
  ensureFile(path.join(ROOT, ".agents", "skills", skillName, "SKILL.md"));
  ensureFile(path.join(ROOT, ".agents", "skills", skillName, "agents", "openai.yaml"));
  ensureFile(path.join(ROOT, ".claude", "skills", skillName, "SKILL.md"));
}

const mcpValidation = runNodeScript(["scripts/build-mcp-config.js", "--validate"]);
const installValidation = runNodeScript(["scripts/install-validate.mjs", "--profile", "core", "--target", "codex"]);

console.log("Config validation passed.");
console.log(mcpValidation);
console.log(installValidation);
