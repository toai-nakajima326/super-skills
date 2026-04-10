---
name: mcp-server-patterns
description: "Use when building, reviewing, or debugging MCP (Model Context Protocol) servers, designing tool interfaces, or integrating external services via MCP."
origin: unified
---

## Rules

- Tools should be atomic. Each tool performs one well-defined operation. A tool that "creates a user and sends a welcome email" should be two separate tools so the caller can compose them as needed.
- Handle errors gracefully. Return structured error information that helps the caller understand what went wrong and how to fix it. Never let unhandled exceptions crash the server or return raw stack traces.
- Validate inputs strictly. Check all required parameters, enforce type constraints, and validate value ranges before executing any operation. Return clear validation error messages that name the offending parameter and explain the constraint.
- Document clearly. Every tool needs a precise description of what it does, what parameters it accepts (with types and constraints), what it returns on success, and what errors it can produce. The description is the contract.
- Be predictable. Tools with the same name should always behave the same way given the same inputs. Avoid hidden state, implicit defaults that vary by context, or behavior that depends on the order of previous tool calls.
- Respect resource boundaries. Tools that access external resources (databases, APIs, files) must handle connection failures, timeouts, and rate limits without leaving resources in an inconsistent state.

## Workflow

1. **Define the tool interface** -- for each capability the server exposes, specify the tool name, description, input schema (JSON Schema), and output format before writing implementation code.
2. **Implement input validation** -- validate every parameter against the schema and business rules. Return descriptive errors early rather than failing deep in the implementation.
3. **Build the core logic** -- implement the tool's operation with proper error handling, timeout management, and resource cleanup. Separate the MCP protocol handling from the business logic.
4. **Add resource management** -- implement proper lifecycle for any resources the server manages: database connections, file handles, API clients. Use connection pooling and cleanup on shutdown.
5. **Handle errors at every layer** -- catch and translate errors from external services into meaningful tool errors. Distinguish between client errors (bad input) and server errors (infrastructure failure).
6. **Write tests** -- test each tool in isolation with valid inputs, invalid inputs, edge cases, and simulated external failures. Test the MCP protocol interaction separately from the business logic.
7. **Document and publish** -- write tool descriptions that are clear enough for an LLM to use correctly without examples. Include parameter descriptions, return value schemas, and error catalogs.

## Gotchas

- Tool descriptions are consumed by LLMs, not just humans. Write them to be unambiguous and specific. A vague description leads to incorrect tool usage and confusing errors.
- Tools that require complex multi-step setup before they can be used effectively need that sequence documented. If tool B depends on the output of tool A, say so in tool B's description.
- Stateful tools (those that depend on previous calls) are harder for LLMs to use correctly. Prefer stateless tools that take all necessary context as parameters.
- Long-running tools risk timeouts in the MCP protocol layer. For operations that take more than a few seconds, consider a pattern where one tool starts the operation and another polls for completion.
- Returning too much data in a tool response wastes context window. Filter and summarize results server-side rather than returning raw database dumps or full API responses.
- Input schemas that are too permissive (accepting strings where enums are appropriate, optional parameters that are actually required in practice) lead to confusing runtime failures.
- MCP servers should be defensive about resource consumption. A tool that accepts user-provided queries against a database needs safeguards against runaway queries that exhaust memory or CPU.
