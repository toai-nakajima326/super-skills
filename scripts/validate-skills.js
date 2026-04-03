#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  const result = {};

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }

  return result;
}

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    throw new Error("skills/ does not exist");
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const seenNames = new Map();
  let errors = 0;

  for (const entry of entries) {
    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md is missing`);
      errors += 1;
      continue;
    }

    const content = fs.readFileSync(skillFile, "utf8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md has invalid frontmatter`);
      errors += 1;
      continue;
    }

    if (!frontmatter.name) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md missing name`);
      errors += 1;
    }

    if (!content.includes("description: |") && !frontmatter.description) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md missing description`);
      errors += 1;
    }

    const logicalName = frontmatter.name || entry.name;
    if (seenNames.has(logicalName)) {
      console.error(`ERROR: duplicate skill name '${logicalName}' in ${entry.name} and ${seenNames.get(logicalName)}`);
      errors += 1;
    } else {
      seenNames.set(logicalName, entry.name);
    }
  }

  if (errors > 0) {
    process.exit(1);
  }

  console.log(`Validated ${entries.length} source skills`);
}

main();
