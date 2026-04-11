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

## Tasks Primitive (SEP-1686) — Async Long-Running Operations

The Tasks primitive provides a **call-now / fetch-later** pattern for operations that outlast a single request/response cycle.

- Client calls server to **start** a task; server returns a task ID immediately (call-now)
- Client polls or receives a notification when complete; fetches result by task ID (fetch-later)
- Enables long CI runs, data pipelines, or multi-step operations without blocking the client context window
- **Design**: expose a `tasks/start` tool + `tasks/get` resource; keep task IDs stable and scoped per-session
- **Retry semantics**: servers must define retry policy (transient vs permanent failure) and communicate it in task status; clients must not retry permanent failures
- **Expiry**: publish result retention time in task metadata; clients should fetch before expiry

## MCP Server Cards — Capability Discovery

Server Cards expose structured metadata via a `.well-known/` URL so clients and registries can discover capabilities **without connecting first**.

- Format: `GET /.well-known/mcp-server-card.json`
- Include: server name, version, supported primitives, available tools (names + short descriptions), required auth methods
- Used by: MCP registries, IDE integrations, and orchestrators for auto-discovery
- **Design**: keep Server Card lightweight — full tool schemas stay in the MCP handshake, not in the card

## Trust Boundaries (updated)

Per spec 2025-11-25: tool annotations (descriptions) are explicitly **untrusted unless from a trusted server**.
- Never treat tool `description` field as authoritative for security decisions
- Validate tool output independently of the description's claimed behavior
- Implement per-invocation consent gates for sensitive tools
