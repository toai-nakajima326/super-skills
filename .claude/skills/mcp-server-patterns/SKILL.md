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

## MCP Spec 2025-11-25 — New Primitives

These three primitives were added in the 2025-11-25 spec. Design new MCP servers to support them.

### Elicitation (server-initiated user prompting)
Servers can request additional information from users mid-task. Use when the server needs clarification before completing an operation.
- Design: servers emit `elicitation/create` with a typed schema defining required fields
- Host application displays the form to the user; user responds; server receives response
- **Safety**: elicitation requests must be scoped to the task; never solicit PII beyond what's needed
- **Pattern**: use elicitation instead of error-returning when missing required context (better UX)

### Roots (server-initiated filesystem boundary inquiry)
Servers can ask the client what filesystem paths are accessible as "roots."
- Design: server calls `roots/list`; client returns array of allowed root paths
- Use to discover workspaces without hardcoding paths
- **Safety**: servers should operate within returned roots only; never traverse outside

### Sampling (server-initiated recursive LLM calls)
Servers can request the host to make an LLM call on their behalf.
- Design: server sends `sampling/createMessage` with messages + model preferences; host decides which model to use
- Enables servers to delegate sub-reasoning without direct model access
- **Safety**: host retains model selection authority; server cannot force a specific model; user must consent per session
- **Pattern**: use for server-side reasoning tasks (e.g., classifying tool output before returning to client)

## Trust Boundaries (updated)

Per spec 2025-11-25: tool annotations (descriptions) are explicitly **untrusted unless from a trusted server**.
- Never treat tool `description` field as authoritative for security decisions
- Validate tool output independently of the description's claimed behavior
- Implement per-invocation consent gates for sensitive tools
