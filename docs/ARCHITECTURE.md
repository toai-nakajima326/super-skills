# Architecture

## Overview

Super Skills separates authored workflow content from generated harness-specific artifacts.

## Layers

### 1. Source skills

`skills/<name>/SKILL.md` is the canonical source for each skill. These files are written for humans first and keep workflow semantics in one place.

### 2. Generated Codex artifacts

`.agents/skills/<name>/` is generated from `skills/`. It mirrors the skill content and adds `agents/openai.yaml` metadata for Codex discovery.

### 3. Runtime configuration

`.codex/` holds Codex-safe defaults, agent roles, and lean MCP enablement.

### 4. Capability catalogs

`mcp/` and `plugins/` describe optional runtime expansion. They are not the source of workflow behavior.

### 5. Installation model

`manifests/` and `scripts/install-*` define how a subset of the repository is installed into a target environment.

## Skill contract

Each source skill directory may contain:

- `SKILL.md` required
- `references/` optional
- `scripts/` optional
- `assets/` optional

Required frontmatter keys in `SKILL.md`:

- `name`
- `description`
- `origin`

## Security model

Default behavior is conservative:

- no telemetry
- no auto-approval
- no auto-upgrade
- no broad MCP enablement
- no implicit secret file storage

## Build flow

1. Author or update `skills/<name>/SKILL.md`
2. Run `node scripts/build-skills.mjs`
3. Generated files appear in `.agents/skills/<name>/`
4. Run `node scripts/validate-skills.mjs`

