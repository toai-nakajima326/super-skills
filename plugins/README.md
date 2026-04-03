# Plugins

Plugins are host adapters, not workflow sources.

## Philosophy

- Keep adapters thin.
- Keep execution opt-in.
- Keep core workflow semantics in `docs/`, `skills/`, and `manifests/`, not in host glue.
- Prefer explicit user actions over hidden automation.
- Do not ship auto-approval, telemetry, or broad background execution.

## Repository Shape

- `plugins/claude/`
- `plugins/opencode/`
- `plugins/cursor/`
- `plugins/hooks-allowlist.md`

Each host directory is a placeholder for host-specific wiring only. The directory may hold brief setup notes, small config snippets, or installation guidance, but it must not become the place where core behavior lives.

## Allowed Hook Ideas

Only the behaviors listed in `plugins/hooks-allowlist.md` are in scope for host adapters.

## Explicit Non-Goals

- auto-approval
- telemetry collection
- hidden command execution
- implicit git mutation
- default-on browser control
- default-on MCP expansion
