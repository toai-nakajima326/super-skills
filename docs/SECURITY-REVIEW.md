# Security Review

## Scope

This review covers the current unified baseline implemented in this repository:

- `skills/` and generated `.agents/skills/`
- `.codex/` runtime defaults
- `mcp/` catalog and profiles
- `plugins/` host adapters
- `manifests/` and installer scripts

Review date: 2026-04-02

## Current Strengths

- The default Codex baseline is lean and explicit. `.codex/config.toml` enables multi-agent support but keeps the MCP baseline narrow.
- MCP capabilities are risk-labeled and profile-scoped. High-risk localhost and `npx -y` patterns are isolated in `unsafe-local`.
- Plugin adapters are documented as thin, opt-in glue only. Auto-approval, telemetry, hidden execution, and broad automation are explicitly banned.
- Skill generation keeps authored and generated content separate, which reduces accidental mutation of source skill definitions.
- Installer planning and validation are explicit about target support, scaffold-only targets, prerequisites, and risk notes.

## Key Risks Remaining

- `scripts/install-apply.mjs` is scaffold-level. It records state and pending operations but does not yet perform copy or generation, so the final safety model of real installation is not yet exercised.
- Config validation uses presence and invariants rather than full TOML parsing. Structural drift inside TOML files could still slip through if token-level checks continue to pass.
- Secret scanning is heuristic. It is useful for obvious leaks, but it is not a replacement for a mature secret scanning service or CI enforcement.
- Dependency audit is not yet automated in CI. The repository documents the need for audit commands, but enforcement still depends on local execution.

## Security Decisions Locked In

- No telemetry by default
- No auto-approval by default
- No auto-commit or auto-push flows by default
- No implicit MCP expansion beyond the safe core profile
- No plaintext secret storage scheme in repository-local defaults

## Recommended Next Steps

- Finish `install-apply` so it can safely copy authored assets and regenerate generated assets with drift detection.
- Add CI execution for `npm run check`, `npm audit`, and any language-specific dependency audits that become relevant.
- Replace token-level TOML validation with parser-backed validation once a TOML dependency is acceptable.
- Add a dedicated security review pass over installer copy rules once real file writes are implemented.
