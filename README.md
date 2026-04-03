# Super Skills

Unified skill framework that combines:

- gstack-style high-agency workflow skills
- ECC-style modular packaging, Codex config, and MCP profiling
- security-first defaults

## Structure

- `skills/`: authored source-of-truth skills
- `.agents/skills/`: generated Codex-facing skills
- `.codex/`: Codex runtime configuration
- `mcp/`: MCP catalog and profiles
- `plugins/`: host-specific adapters
- `manifests/`: installer components, profiles, and modules
- `scripts/`: generators, validators, and installer tooling
- `docs/`: architecture, spec, and execution plan

## Commands

```bash
node scripts/build-skills.mjs
node scripts/validate-skills.mjs
```

## Status

The repository is being built from `docs/SPEC.md` and `docs/PLAN.md`.

