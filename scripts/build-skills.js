#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const AGENTS_SKILLS_DIR = path.join(ROOT, ".agents", "skills");

function readDirSafe(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function extractFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    throw new Error("missing frontmatter");
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("unterminated frontmatter");
  }

  const raw = content.slice(4, end);
  const body = content.slice(end + 5);
  const lines = raw.split("\n");
  const data = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const blockMatch = line.match(/^([A-Za-z0-9_-]+):\s*\|\s*$/);
    if (blockMatch) {
      const key = blockMatch[1];
      const block = [];
      for (i += 1; i < lines.length; i += 1) {
        const next = lines[i];
        if (/^\S/.test(next)) {
          i -= 1;
          break;
        }
        block.push(next.replace(/^  /, ""));
      }
      data[key] = block.join("\n").trim();
      continue;
    }

    const inlineMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (inlineMatch) {
      data[inlineMatch[1]] = inlineMatch[2];
    }
  }

  return { data, body };
}

function sentenceCaseToDisplayName(value) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortDescription(description) {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 120) return collapsed;
  const slice = collapsed.slice(0, 117);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 40 ? lastSpace : 117)}...`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDirContents(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function buildOpenAIYaml(name, description) {
  const displayName = sentenceCaseToDisplayName(name);
  const short = shortDescription(description);
  return `interface:\n  display_name: ${JSON.stringify(displayName)}\n  short_description: ${JSON.stringify(short)}\n  default_prompt: ${JSON.stringify(`Use ${displayName} for this task.`)}\npolicy:\n  allow_implicit_invocation: true\n`;
}

function main() {
  ensureDir(AGENTS_SKILLS_DIR);
  removeDirContents(AGENTS_SKILLS_DIR);

  const skillDirs = readDirSafe(SKILLS_DIR)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dirName of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dirName, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Missing SKILL.md in skills/${dirName}`);
    }

    const source = fs.readFileSync(skillPath, "utf8");
    const { data } = extractFrontmatter(source);

    if (!data.name || !data.description) {
      throw new Error(`skills/${dirName}/SKILL.md must declare name and description`);
    }

    const outDir = path.join(AGENTS_SKILLS_DIR, dirName);
    const metaDir = path.join(outDir, "agents");
    ensureDir(metaDir);

    fs.writeFileSync(path.join(outDir, "SKILL.md"), source);
    fs.writeFileSync(path.join(metaDir, "openai.yaml"), buildOpenAIYaml(data.name, data.description));
  }

  console.log(`Generated ${skillDirs.length} skill packages in .agents/skills`);
}

main();

