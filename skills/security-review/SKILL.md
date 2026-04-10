---
name: security-review
description: "Use for security-focused code review to find vulnerabilities, auth gaps, and unsafe data handling."
origin: unified
---

## Rules

- Assume adversarial input. Every external input -- user data, API responses, file contents, URL parameters -- is potentially malicious until validated.
- Check auth and authz boundaries. Verify that every endpoint and data access path enforces authentication and proper authorization.
- Validate all external data. No raw external input should reach business logic, database queries, or rendered output without explicit validation and sanitization.
- Secrets must never appear in code, logs, or error messages.
- Apply the principle of least privilege to every component and credential.

## Workflow

1. **Threat model** -- Identify the attack surface: entry points (APIs, forms, webhooks, file uploads), sensitive data stores, trust boundaries, and external dependencies. List potential threat actors and their goals.
2. **Input validation audit** -- For every entry point, verify that input is validated for type, length, format, and allowed values. Check for injection vectors: SQL, XSS, command injection, path traversal, SSRF.
3. **Auth boundary check** -- Trace each request path from entry to data access. Confirm authentication is enforced before any business logic runs. Confirm authorization checks match the intended access policy (no IDOR, no privilege escalation).
4. **Dependency scan** -- Review third-party dependencies for known vulnerabilities. Check dependency versions, advisory databases, and whether unused dependencies expand the attack surface.
5. **Findings with CVSS-like severity** -- Report each finding with: description, affected component, attack vector, impact (confidentiality/integrity/availability), likelihood, and a severity rating (Critical/High/Medium/Low). Include remediation guidance.

## Gotchas

- Client-side validation is not security. Always validate on the server.
- "Admin-only" endpoints still need auth checks. Internal tools are a common breach vector.
- Error messages that leak stack traces or internal paths help attackers. Check error handling.
- Dependencies you forgot about still run in production. Audit the full dependency tree, not just direct imports.
- Rate limiting and abuse prevention are security concerns, not just operational ones.
