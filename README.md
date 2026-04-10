# Super Skills

Unified skill framework for AI coding agents. Author once, deploy to **Claude Code**, **Codex**, **Cursor**, **Kiro**, and **Antigravity**.

## Quick Start

```bash
# Validate all skills
node scripts/validate-skills.js

# Build all targets
npm run build

# Install into a project (Claude Code, developer profile)
node scripts/install-apply.mjs --profile developer --target claude --target-root /path/to/project

# Dry run to see what would be installed
node scripts/install-apply.mjs --profile core --target cursor --target-root . --dry-run
```

## Architecture

```
super-skills/
├── skills/                     # Master source (host-neutral)
│   ├── investigate/SKILL.md    # Root-cause debugging
│   ├── plan-product/SKILL.md   # Product planning
│   ├── review/SKILL.md         # Code review
│   ├── guard/SKILL.md          # Safety guard
│   └── ... (24 skills total)
├── scripts/                    # Build & install tools
│   ├── build-all.js            # Build all targets
│   ├── build-claude-skills.js  # → .claude/skills/
│   ├── build-codex-skills.js   # → .agents/skills/
│   ├── build-cursor-skills.js  # → .cursor/rules/skills/
│   ├── build-kiro-skills.js    # → .kiro/skills/
│   ├── build-antigravity-skills.js # → .antigravity/skills/
│   ├── install-apply.mjs       # Project installer
│   └── validate-skills.js      # Validation
├── manifests/                  # Profile/module/component definitions
│   ├── install-profiles.json   # core, developer, security, research
│   ├── install-modules.json    # Module groupings
│   └── install-components.json # Component → source mapping
└── package.json
```

## Profiles

| Profile | Skills | Use Case |
|---------|--------|----------|
| **core** | 10 | Minimal safe baseline |
| **developer** | 20 | Full engineering workflow |
| **security** | 11 | Audit and hardening |
| **research** | 13 | Deep research capabilities |

## Targets

| Target | Output Directory | Format |
|--------|-----------------|--------|
| Claude Code | `.claude/skills/` | SKILL.md (direct copy) |
| Codex | `.agents/skills/` | SKILL.md + openai.yaml |
| Cursor | `.cursor/rules/skills/` | .mdc files |
| Kiro | `.kiro/skills/` | SKILL.md + kiro.json |
| Antigravity | `.antigravity/skills/` | SKILL.md + catalog.json |

## Skills (24)

### Workflow Skills
- **investigate** — Root-cause-first debugging
- **plan-product** — Product planning before implementation
- **plan-architecture** — Architecture design before coding
- **review** — Code review focused on high-signal findings
- **security-review** — Security-focused code review
- **qa-browser** — Browser-based regression testing
- **ship-release** — Release preparation (no auto-push)
- **tdd-workflow** — Test-driven development

### Safety Skills
- **guard** — Block dangerous operations
- **freeze** — Read-only mode
- **careful** — Extra caution for critical operations
- **checkpoint** — Save/restore state
- **verification-loop** — Automated result verification
- **health-check** — Project health assessment
- **coding-standards** — Enforce coding standards
- **documentation-lookup** — Documentation search

### Knowledge Skills
- **api-design** — API design best practices
- **backend-patterns** — Backend architecture patterns
- **frontend-patterns** — Frontend architecture patterns
- **e2e-testing** — End-to-end testing patterns
- **deep-research** — Research methodology
- **exa-search** — Web search integration
- **mcp-server-patterns** — MCP server development
- **dmux-workflows** — Parallel workflow orchestration

## Safety Defaults

- No auto-commit — never pushes without human approval
- No telemetry — no data sent anywhere
- MCP/external tools require explicit opt-in
- `guard`, `freeze`, `careful` skills actively block dangerous operations

## Installer Options

```bash
node scripts/install-apply.mjs \
  --profile <core|developer|security|research> \
  --target <claude|codex|cursor|kiro|antigravity> \
  --target-root <path> \
  [--with component1,component2]   # Add extra components \
  [--without component1]           # Exclude components \
  [--dry-run]                      # Preview only \
  [--json]                         # JSON output
```

## Adding a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: "Use when..."
   origin: unified
   ---
   ```
2. Add sections: `## Rules`, `## Workflow`, `## Gotchas`
3. Register in `manifests/install-components.json`
4. Add to a module in `manifests/install-modules.json`
5. Run `npm run build` to verify

## License

MIT
