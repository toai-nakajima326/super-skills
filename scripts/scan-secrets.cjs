#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  ".tmp-install-root",
]);
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".toml",
  ".yaml",
  ".yml",
  ".env",
  ".txt",
]);

const RULES = [
  { name: "OpenAI key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "Inline secret assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'$\n][^"'\n]{7,}["']/gi,
  },
  {
    name: "Basic auth URL",
    pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s:@]+@/gi,
  },
];

const ALLOWLIST_SNIPPETS = [
  "${",
  "YOUR_",
  "EXAMPLE",
  "example",
  "placeholder",
  "<package>@latest",
  "GITHUB_TOKEN",
  "EXA_API_KEY",
  "SEMGREP_APP_TOKEN",
];

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (base === ".env" || base.endsWith(".env")) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(filePath));
}

function walk(dirPath, results = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
      continue;
    }
    if (entry.isFile() && isTextFile(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function lineNumberFor(content, index) {
  return content.slice(0, index).split("\n").length;
}

function isAllowed(match) {
  return ALLOWLIST_SNIPPETS.some((snippet) => match.includes(snippet));
}

const findings = [];
for (const filePath of walk(ROOT)) {
  const relPath = path.relative(ROOT, filePath);
  const content = fs.readFileSync(filePath, "utf8");

  for (const rule of RULES) {
    const matches = content.matchAll(rule.pattern);
    for (const match of matches) {
      const value = match[0];
      if (isAllowed(value)) {
        continue;
      }
      findings.push({
        file: relPath,
        line: lineNumberFor(content, match.index ?? 0),
        rule: rule.name,
        sample: value.slice(0, 120),
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} [${finding.rule}] ${finding.sample}`);
  }
  process.exit(1);
}

console.log("No secret-like literals detected in scanned text files.");
