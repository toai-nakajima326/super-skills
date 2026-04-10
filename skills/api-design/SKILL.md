---
name: api-design
description: "Use when designing or reviewing HTTP APIs, choosing between REST and GraphQL, or establishing API contracts and conventions."
origin: unified
---

## Rules

- Use consistent naming conventions across all endpoints: plural nouns for collections (`/users`, `/orders`), kebab-case for multi-word resources (`/line-items`), and camelCase for JSON field names.
- Follow proper HTTP semantics: GET is safe and idempotent, PUT replaces the full resource, PATCH applies partial updates, DELETE is idempotent, POST creates new resources and returns 201.
- Version from day one. Use URL path versioning (`/v1/`) for public APIs or header-based versioning (`Accept: application/vnd.api+json;version=1`) for internal APIs. Never ship an unversioned API.
- Error responses are part of the contract. Define a consistent error envelope (`{ "error": { "code", "message", "details" } }`), use appropriate HTTP status codes, and document every error a client might receive.
- Design for evolvability: add fields freely but never remove or rename them without a version bump. Treat the response schema as a public promise.
- Authentication and authorization belong in middleware, not in individual handlers. Use standard mechanisms (OAuth 2.0, API keys in headers) and never pass credentials in query parameters.

## Workflow

1. **Define the resource model** -- identify the nouns (resources) and their relationships before writing any endpoint.
2. **Map operations to HTTP methods** -- for each resource, decide which CRUD operations are needed and map them to GET/POST/PUT/PATCH/DELETE.
3. **Design the URL hierarchy** -- nest resources only when there is a true parent-child ownership (`/users/{id}/orders`); prefer flat structures otherwise.
4. **Specify request and response schemas** -- define the shape of every request body and response body, including error cases, before implementing.
5. **Add pagination, filtering, and sorting** -- for any list endpoint, support cursor-based or offset pagination, filterable fields, and sort parameters from the start.
6. **Document rate limits and quotas** -- decide on rate limiting strategy (token bucket, sliding window) and communicate limits via response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`).
7. **Write the OpenAPI spec** -- produce a machine-readable specification that serves as the single source of truth for the API contract.

## Gotchas

- Avoid deeply nested URLs (more than two levels) as they create tight coupling and make endpoints harder to discover and cache.
- Do not use verbs in URLs (`/getUser`, `/createOrder`). The HTTP method already expresses the action.
- Returning 200 for everything and embedding status in the body defeats the purpose of HTTP status codes and breaks client libraries that rely on status code semantics.
- Pagination without a stable sort order produces duplicates and missing items when data changes between page fetches.
- GraphQL does not eliminate the need for API design discipline. Unbounded queries without depth limits or complexity analysis can take down your server.
- HATEOAS adds navigability but also complexity. Adopt it intentionally for public APIs where discoverability matters, not as a dogmatic default.
- Be cautious with PATCH semantics: JSON Merge Patch (RFC 7386) cannot distinguish between "set to null" and "omit"; use JSON Patch (RFC 6902) when null has meaning.
