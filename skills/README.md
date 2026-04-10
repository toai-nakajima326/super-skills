# Skills

This directory is the single source of truth for all skills. Each skill lives in its own directory with a required `SKILL.md` file.

## Structure

```
skills/<name>/
├── SKILL.md        # Required — skill definition
├── references/     # Optional — reference materials
├── scripts/        # Optional — skill-specific scripts
└── assets/         # Optional — images, templates, etc.
```

## SKILL.md Format

```yaml
---
name: <directory-name>
description: "Use when..."
origin: unified
---
```

Required frontmatter: `name`, `description`, `origin`

### Rules
- `name` must match the directory name
- `description` should start with "Use when..." or "Use for..."
- Include a `## Gotchas` section for high-signal failure modes

## Building

```bash
node scripts/build-skills.js        # Codex
node scripts/build-claude-skills.js # Claude Code
node scripts/build-cursor-skills.js # Cursor
node scripts/build-kiro-skills.js   # Kiro
node scripts/build-antigravity-skills.js # Antigravity
```
