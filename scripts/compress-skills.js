#!/usr/bin/env node

// compress-skills.js
//
// Compresses SKILL.md files from skills/*/SKILL.md (master source)
// and writes compressed versions to ~/.claude/skills/*/SKILL.md.
//
// Target: ~60% token reduction while preserving all actionable information.
//
// Usage: node scripts/compress-skills.js

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKILLS_SRC = path.join(__dirname, "..", "skills");
const SKILLS_DEST = path.join(os.homedir(), ".claude", "skills");

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: match[2] };
}

function compressFrontmatter(fm) {
  const lines = fm.split("\n");
  const out = [];
  let inDesc = false;
  let descBuf = [];
  let inSources = false;

  for (const line of lines) {
    if (line.match(/^sources:\s*$/)) { inSources = true; continue; }
    if (inSources && line.match(/^\s+-/)) continue;
    if (inSources && line.match(/^\S/)) inSources = false;
    if (inSources) continue;

    if (line.match(/^description:\s*\|/)) {
      inDesc = true;
      descBuf = [];
      continue;
    }
    if (inDesc) {
      if (line.match(/^\S/)) {
        out.push(`description: "${descBuf.join(" ").replace(/\s+/g, " ").trim()}"`);
        inDesc = false;
        out.push(line);
      } else {
        descBuf.push(line.trim());
      }
      continue;
    }
    out.push(line);
  }
  if (inDesc && descBuf.length > 0) {
    out.push(`description: "${descBuf.join(" ").replace(/\s+/g, " ").trim()}"`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Core text transforms
// ---------------------------------------------------------------------------

function strip(s) {
  let t = s;
  // Remove bold/italic
  t = t.replace(/\*\*\*/g, "");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  // Remove inline backticks
  t = t.replace(/`([^`\n]{1,80})`/g, "$1");
  return t;
}

function shorten(s) {
  let t = s.trim();
  // Remove trailing period
  t = t.replace(/\.\s*$/, "");
  // Phrase compression
  const replacements = [
    [/\bfor example\b/gi, "e.g."],
    [/\bsuch as\b/gi, "e.g."],
    [/\bin order to\b/gi, "to"],
    [/\bmake sure to\b/gi, ""],
    [/\bas well as\b/gi, "+"],
    [/\band also\b/gi, "+"],
    [/\bin addition to\b/gi, "+"],
    [/\bwhether or not\b/gi, "whether"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bwith regard to\b/gi, "re:"],
    [/\bwith respect to\b/gi, "re:"],
    [/\bthe fact that\b/gi, "that"],
    [/\bthat being said\b/gi, ""],
    [/\bat this point\b/gi, "now"],
    [/\bthe following\b/gi, "these"],
    [/\bit is important to note that\b/gi, "note:"],
    [/\bplease note that\b/gi, "note:"],
    [/\bkeep in mind that\b/gi, "note:"],
    [/\bReproduce the issue and capture exact symptoms\b/g, "Reproduce+capture symptoms"],
    [/\bForm the smallest plausible root-cause hypothesis\b/g, "Minimal root-cause hypothesis"],
    [/\bVerify the hypothesis against code or runtime evidence\b/g, "Verify against code/runtime"],
    [/\bOnly then propose or implement a fix\b/g, "Then propose fix"],
    [/\bseparate observations, hypotheses, and fixes\b/g, "separate observation/hypothesis/fix"],
    [/\bgather evidence before changing code\b/g, "evidence before code changes"],
  ];
  for (const [re, rep] of replacements) {
    t = t.replace(re, rep);
  }
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// ---------------------------------------------------------------------------
// Section-based compression
// ---------------------------------------------------------------------------

function compressSkill(raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const compressedFM = compressFrontmatter(frontmatter);

  let text = body;

  // Remove HTML comments/tags
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Remove top-level # Title line
  text = text.replace(/^# .+\n*/m, "");

  // Strip all markdown formatting
  text = strip(text);

  // Process line by line with section awareness
  const lines = text.split("\n");
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Header line -> section label
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const label = headerMatch[2].trim().replace(/[:.]+$/, "");
      i++;

      // Skip blank lines after header
      while (i < lines.length && lines[i].trim() === "") i++;

      // Collect section content
      const sectionLines = [];
      while (i < lines.length && !lines[i].match(/^#{1,6}\s+/)) {
        sectionLines.push(lines[i]);
        i++;
      }

      const compressed = compressSectionContent(label, sectionLines);
      if (compressed.trim()) {
        output.push(compressed);
      }
      continue;
    }

    // Non-section content (before first header or between headers)
    if (line.trim() !== "") {
      output.push(shorten(line));
    }
    i++;
  }

  let result = output.join("\n");

  // Final cleanup
  result = result.replace(/\n{3,}/g, "\n");
  result = result.replace(/^\n+/, "");
  result = result.trimEnd();

  return `---\n${compressedFM}\n---\n${result}\n`;
}

function compressSectionContent(label, lines) {
  // Trim blank lines
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";

  // Check for table content
  if (hasTable(lines)) {
    return label + ":\n" + compressWithTables(lines);
  }

  // Check: is it purely simple bullets (no sub-items, no colons)?
  const simpleBullets = extractSimpleBullets(lines);
  if (simpleBullets) {
    const merged = simpleBullets.map((b) => shorten(b)).join(", ");
    return `${label}: ${merged}`;
  }

  // Check: is it purely numbered steps with no sub-items?
  const simpleSteps = extractSimpleSteps(lines);
  if (simpleSteps) {
    const inline = simpleSteps.map((s, idx) => `${idx + 1}) ${shorten(s)}`).join(" ");
    return `${label}: ${inline}`;
  }

  // Mixed content: compress aggressively
  return label + ":\n" + compressMixed(lines);
}

function hasTable(lines) {
  return lines.some((l, idx) =>
    isTableRow(l) && idx + 1 < lines.length && isTableSep(lines[idx + 1])
  );
}

function extractSimpleBullets(lines) {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return null;
  const bullets = [];
  for (const line of nonEmpty) {
    const m = line.match(/^[-*]\s+(.+)/);
    if (!m) return null; // not a bullet
    if (line.match(/^\s{2,}/)) return null; // indented sub-item
    bullets.push(m[1].trim());
  }
  return bullets;
}

function extractSimpleSteps(lines) {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return null;
  const steps = [];
  for (const line of nonEmpty) {
    const m = line.match(/^\d+[.)]\s+(.+)/);
    if (!m) return null;
    steps.push(m[1].trim());
  }
  return steps;
}

function compressWithTables(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      i += 2; // skip header + sep
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseRow(lines[i]);
        out.push(cells[0] + " -> " + cells.slice(1).join(", "));
        i++;
      }
    } else {
      const trimmed = lines[i].trim();
      if (trimmed) out.push(shorten(trimmed));
      i++;
    }
  }
  return out.join("\n");
}

function compressMixed(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blanks (compact output)
    if (trimmed === "") { i++; continue; }

    // Table
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseRow(lines[i]);
        out.push(cells[0] + " -> " + cells.slice(1).join(", "));
        i++;
      }
      continue;
    }

    // Code block
    if (trimmed.match(/^```/)) {
      const lang = (trimmed.match(/^```(\w*)/) || [])[1] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().match(/^```$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing

      const code = codeLines.join("\n").trim();
      const execLangs = ["bash", "sh", "javascript", "js", "typescript", "ts", "python", "py"];
      if (code.split("\n").length > 4 && lang && execLangs.includes(lang.toLowerCase())) {
        out.push("```\n" + code + "\n```");
      } else {
        // Short or template: inline
        out.push(code);
      }
      continue;
    }

    // Run of top-level bullets
    if (line.match(/^[-*]\s+/) && !line.match(/^\s{2,}/)) {
      const bullets = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/) && !lines[i].match(/^\s{2,}[-*]/)) {
        // Collect bullet and any indented sub-content
        const bulletText = lines[i].replace(/^[-*]\s+/, "").trim();
        let full = bulletText;
        i++;
        // Gather indented continuation lines
        while (i < lines.length && lines[i].match(/^\s{2,}/) && !lines[i].match(/^\s{2,}[-*]/)) {
          full += " " + lines[i].trim();
          i++;
        }
        // Gather indented sub-bullets as part of this bullet
        while (i < lines.length && lines[i].match(/^\s{2,}[-*]\s+/)) {
          full += "; " + lines[i].trim().replace(/^[-*]\s+/, "");
          i++;
        }
        bullets.push(shorten(full));
      }
      // Merge if all short and no colons
      if (bullets.length >= 2 && bullets.every((b) => b.length < 50 && !b.includes(":"))) {
        out.push("- " + bullets.join(", "));
      } else {
        for (const b of bullets) {
          out.push("- " + b);
        }
      }
      continue;
    }

    // Run of numbered items
    if (trimmed.match(/^\d+[.)]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].trim().match(/^\d+[.)]\s+/)) {
        const m = lines[i].trim().match(/^\d+[.)]\s+(.*)/);
        let itemText = m ? m[1].trim() : "";
        i++;
        // Gather indented continuation
        while (i < lines.length && lines[i].match(/^\s{2,}/) && !lines[i].trim().match(/^\d+[.)]\s+/) && !lines[i].match(/^\s*[-*]\s+/)) {
          itemText += " " + lines[i].trim();
          i++;
        }
        // Check for sub-bullets
        const subBullets = [];
        while (i < lines.length && lines[i].match(/^\s{2,}[-*]\s+/)) {
          subBullets.push(lines[i].trim().replace(/^[-*]\s+/, ""));
          i++;
          // Sub-bullet continuation
          while (i < lines.length && lines[i].match(/^\s{4,}/) && !lines[i].match(/^\s{2,}[-*]/)) {
            subBullets[subBullets.length - 1] += " " + lines[i].trim();
            i++;
          }
        }
        if (subBullets.length > 0) {
          itemText += " (" + subBullets.map((s) => shorten(s)).join("; ") + ")";
        }
        items.push(shorten(itemText));
      }
      // If items are short enough, inline them
      const totalLen = items.reduce((sum, it, idx) => sum + `${idx + 1}) ${it} `.length, 0);
      if (totalLen < 300 && items.every((it) => !it.includes("\n"))) {
        out.push(items.map((it, idx) => `${idx + 1}) ${it}`).join(" "));
      } else {
        for (let j = 0; j < items.length; j++) {
          out.push(`${j + 1}) ${items[j]}`);
        }
      }
      continue;
    }

    // Regular text line
    out.push(shorten(trimmed));
    i++;
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

function isTableRow(line) {
  if (!line) return false;
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.split("|").length >= 3;
}

function isTableSep(line) {
  if (!line) return false;
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parseRow(line) {
  return line.split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());
}

// ---------------------------------------------------------------------------
// File I/O and reporting
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(SKILLS_SRC)) {
    console.error(`Source directory not found: ${SKILLS_SRC}`);
    process.exit(1);
  }

  const skillDirs = fs
    .readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  let totalBefore = 0;
  let totalAfter = 0;
  let processed = 0;
  let skipped = 0;
  const results = [];

  for (const dir of skillDirs) {
    const srcFile = path.join(SKILLS_SRC, dir, "SKILL.md");
    if (!fs.existsSync(srcFile)) { skipped++; continue; }

    const raw = fs.readFileSync(srcFile, "utf-8");
    const compressed = compressSkill(raw);

    const destDir = path.join(SKILLS_DEST, dir);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "SKILL.md"), compressed, "utf-8");

    const beforeBytes = Buffer.byteLength(raw, "utf-8");
    const afterBytes = Buffer.byteLength(compressed, "utf-8");
    const ratio = ((1 - afterBytes / beforeBytes) * 100).toFixed(1);

    totalBefore += beforeBytes;
    totalAfter += afterBytes;
    processed++;
    results.push({ name: dir, before: beforeBytes, after: afterBytes, ratio });
  }

  console.log("Skill Compression Report");
  console.log("========================\n");

  const nw = Math.max(...results.map((r) => r.name.length), 4);
  console.log(
    `${"Skill".padEnd(nw)}  ${"Before".padStart(7)}  ${"After".padStart(7)}  ${"Saved".padStart(6)}`
  );
  console.log(`${"-".repeat(nw)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(6)}`);

  for (const r of results) {
    console.log(
      `${r.name.padEnd(nw)}  ${String(r.before).padStart(7)}  ${String(r.after).padStart(7)}  ${(r.ratio + "%").padStart(6)}`
    );
  }

  const totalRatio = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
  console.log(`${"-".repeat(nw)}  ${"-".repeat(7)}  ${"-".repeat(7)}  ${"-".repeat(6)}`);
  console.log(
    `${"TOTAL".padEnd(nw)}  ${String(totalBefore).padStart(7)}  ${String(totalAfter).padStart(7)}  ${(totalRatio + "%").padStart(6)}`
  );

  console.log(`\nProcessed: ${processed} skills`);
  if (skipped > 0) console.log(`Skipped: ${skipped} dirs (no SKILL.md)`);
  console.log(`Source: ${SKILLS_SRC}`);
  console.log(`Output: ${SKILLS_DEST}`);
}

main();
