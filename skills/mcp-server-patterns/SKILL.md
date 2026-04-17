---
name: mcp-server-patterns
description: |
  MCP design guidance for tools, resources, transports, validation, and trust
  boundaries. Use when cataloging MCP servers, building new servers, or reviewing
  MCP-related risk and integration choices.
origin: unified
---

# MCP Server Patterns

## Focus

- transport choice
- schema-first tool design
- auth and secret boundaries
- risk labeling
- safe default enablement

## Transport

- Use Streamable HTTP for new servers (replaces deprecated HTTP+SSE)
- Stateless tool handlers enable horizontal scaling
- Idempotent operations required for retries

## Auth (2026 standard)

- OAuth 2.1 is mandatory for HTTP transports
- Separate resource server from authorization server
- Per-tool scopes — never blanket grants: `calendar:read`, `email:send`, `contacts:delete`
- Signing keys must be outside the agent trust boundary

## Lazy Tool Discovery (large deployments)

For deployments with many tools, context consumption explodes with full manifests.
Cloudflare pattern: expose only two tools — a discovery tool and an execute tool.
The model writes JavaScript/code to explore and invoke capabilities on demand.

```
discovery_tool(query)  → returns available tool names matching the query
execute_tool(name, args) → invokes the named tool
```

This prevents context exhaustion in large MCP setups (10,000+ server ecosystem).

## Server Design

- Bounded context: one server per domain, not catch-all servers
- Blue-green deployment for zero-downtime updates
- AI-specific observability: tool usage frequency, error rates per tool, response quality

## Risk Labels

Label each tool with trust level: read-only / write / destructive / external-network
