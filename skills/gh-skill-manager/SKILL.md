---
name: gh-skill-manager
description: |
  Workflow for installing, updating, publishing, and auditing agent skills via the
  GitHub CLI `gh skill` package manager (v2.90.0+). Use when managing skills across
  agents, pinning versions for reproducibility, or publishing a skill to a repo.
origin: unified
---

# GitHub Skill Manager

## Rules

- Always preview a skill before installing: `gh skill preview`
- Pin versions for team/production installs to prevent unexpected updates
- Cross-agent installs require `--agent` flag (default is GitHub Copilot)
- SHA pinning > tag pinning for maximum reproducibility

## Workflow — Install

```bash
# Browse and install interactively from a repo
gh skill install owner/repo

# Install a specific named skill
gh skill install owner/repo skill-name

# Pin to version tag (recommended for teams)
gh skill install owner/repo skill-name@v1.2.0

# Pin to exact commit SHA (maximum reproducibility)
gh skill install owner/repo skill-name@abc123def

# Target a specific agent host
gh skill install owner/repo skill-name --agent claude-code
```

Supported `--agent` targets: `claude-code`, `cursor`, `codex`, `gemini`, `antigravity`

## Workflow — Discover

```bash
gh skill search <keyword>   # search available skills
gh skill preview            # inspect content before installing
```

## Workflow — Update

```bash
gh skill update             # interactive check across all installed skills
gh skill update skill-name  # update one skill
gh skill update --all       # update all without prompts
```

## Workflow — Publish

```bash
gh skill publish            # validate against spec and publish
gh skill publish --fix      # auto-correct metadata issues first
```

## Security Properties

- **Immutable releases**: git tag-tied, cannot be altered after publish
- **Content-addressed tracking**: git tree SHA stored in frontmatter; tampering is detectable
- **Portable provenance**: install metadata travels with the skill in SKILL.md frontmatter
- **Version pinning**: prevents accidental upgrades from silent supply chain changes

## Gotchas

- Requires GitHub CLI v2.90.0 or later: `gh --version`
- Default `--agent` is GitHub Copilot, not Claude Code — always specify `--agent claude-code` for this system
- Pinned SHAs cannot be updated with `gh skill update`; re-install to change the pin
