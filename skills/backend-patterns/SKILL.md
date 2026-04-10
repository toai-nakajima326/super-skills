---
name: backend-patterns
description: "Use when building or reviewing backend services, choosing architectural patterns, or structuring server-side application code."
origin: unified
---

## Rules

- Separate concerns into distinct layers: transport (HTTP/gRPC handlers), business logic (services), and data access (repositories). No layer should reach past its neighbor.
- Fail gracefully. Every external call (database, API, message broker) must have timeouts, retries with backoff, and circuit breakers. Never let one failing dependency cascade into a full outage.
- Log actionably. Every log entry should help someone diagnose a problem: include request IDs, operation context, and the specific error. Avoid generic messages like "something went wrong" or logging entire request bodies in production.
- Make operations idempotent wherever possible. Use idempotency keys for mutations, design database writes to be safely retryable, and prefer upserts over blind inserts.
- Keep configuration external. Use environment variables or config services, never hardcoded values. Secrets belong in a secrets manager, not in config files or environment variables on disk.
- Validate at the boundary. Sanitize and validate all input at the entry point (handler/controller level) so that inner layers can trust the data they receive.

## Workflow

1. **Define the service boundary** -- determine what this service owns, what it delegates, and what contracts it exposes.
2. **Design the data model** -- choose the storage engine, define schemas, and plan for migrations from the start.
3. **Implement the repository layer** -- encapsulate all data access behind an interface so the storage engine can be swapped or mocked.
4. **Build the service layer** -- implement business logic that orchestrates repositories and external calls, with no knowledge of HTTP or transport concerns.
5. **Wire up the transport layer** -- map incoming requests to service calls, handle serialization/deserialization, and enforce authentication/authorization via middleware.
6. **Add observability** -- instrument with structured logging, metrics (latency, error rate, throughput), and distributed tracing before going to production.
7. **Harden for production** -- add health checks, graceful shutdown, connection pooling, and load shedding.

## Gotchas

- The repository pattern loses its value if repositories contain business logic. Keep them as pure data access; orchestration belongs in the service layer.
- Middleware order matters. Authentication must run before authorization, which must run before request validation. Getting the order wrong creates security holes.
- Event-driven architectures solve coupling problems but introduce eventual consistency. Design consumers to be idempotent and handle out-of-order delivery.
- Connection pools that are too small cause queuing under load; pools that are too large exhaust database connections. Size them based on measured concurrency, not guesses.
- "Microservices" does not mean "one service per database table." Split on business domain boundaries, not data model boundaries. A service that cannot be deployed and reasoned about independently is just a distributed monolith.
- Distributed transactions (two-phase commit) are fragile across service boundaries. Prefer the saga pattern with compensating actions for cross-service workflows.
- Background jobs need the same observability as request handlers. An unmonitored worker queue is a silent failure waiting to happen.
