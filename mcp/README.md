# MCP Catalog

This directory defines the project-local MCP baseline for Super Skills.

## Goals

- Keep the default-enabled baseline lean.
- Make risk and secret requirements explicit.
- Group optional capability sets into named profiles.
- Keep localhost or broad-trust servers out of the default path.

## Files

- `catalog.json`: source of truth for known MCP servers and their risk metadata.
- `profiles/core.json`: safe default engineering baseline.
- `profiles/research.json`: external search, crawling, and documentation retrieval.
- `profiles/browser.json`: browser automation and UI inspection.
- `profiles/security.json`: security scanners and review helpers.
- `profiles/unsafe-local.json`: localhost, wide filesystem, or otherwise high-trust integrations.

## Risk Levels

- `low`: narrow scope, no localhost dependency, and safe for most engineering tasks.
- `medium`: broader external access, browser automation, or write-capable integrations that still fit normal development use.
- `high`: localhost services, broad filesystem reach, package execution from external registries, or tools that materially expand the trust boundary.

## Safe Defaults

`default_enabled` is intentionally restricted to the lean `core` baseline:

- `github`
- `context7`
- `memory`
- `sequential-thinking`

Everything else is opt-in through explicit profile selection.

## Catalog Shape

Each catalog entry includes:

- `id`
- `description`
- `transport`
- `command` or `url`
- `args`
- `env`
- `risk_level`
- `requires_secrets`
- `default_enabled`
- `profiles`
- `notes`

## Maintenance Rules

- Do not add a new default-enabled server unless it is low risk and broadly useful.
- Put external research tools in `research`, not `core`.
- Put browser tools in `browser`, not `core`.
- Put localhost or privileged tools in `unsafe-local`, even if they are developer-friendly.
- Keep `profiles/*.json` as explicit server-id lists; do not infer profile membership elsewhere.

## Helper Script

Use `scripts/build-mcp-config.cjs` to render selected MCP profiles as:

- a `.codex/config.toml` fragment
- a plain install guidance block
- a JSON summary for automation

Examples:

- `node scripts/build-mcp-config.cjs`
- `node scripts/build-mcp-config.cjs --profile core --profile research --format toml`
- `node scripts/build-mcp-config.cjs --profile browser --format guidance`
- `node scripts/build-mcp-config.cjs --validate`

Behavior:

- If no profile is passed, the script uses the catalog `default_profile`.
- Profile selection is explicit and deterministic.
- High-risk servers are never included unless their profile is explicitly requested.
