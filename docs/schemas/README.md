# AIOS / vcontext API schemas

This directory holds **machine-readable contracts** for AIOS' HTTP
surface. Per [Constitution P2 — Contract-first over language-first](../principles/AIOS-CONSTITUTION.md#p2--contract-first-over-language-first)
and [P4 — Machine-readable logs / metrics / contracts](../principles/AIOS-CONSTITUTION.md#p4--machine-readable-logs--metrics--contracts),
these specs are the substrate, not the JavaScript source.

## Current specs

| File | Describes | Source of truth |
|---|---|---|
| `vcontext-api-v1.yaml` | 75 HTTP endpoints + `/ws` WebSocket appendix | `scripts/vcontext-server.js` (~8,000 lines) |

## How this spec was extracted

1. **Locate the router.** The routing block in `vcontext-server.js`
   is a `createServer(async (req, res) => { ... })` body with a long
   `if/else if` cascade on `method === 'X' && path === '/y'`. Find
   it with: search for `'/store'` or `createServer`.
2. **Walk every branch.** For each branch:
   - Note the HTTP method + path
   - Jump to the handler function (e.g. `handleStore`, `handleRecall`)
   - Read `validateApiKey(req)` + `hasRole(auth, '...')` calls →
     derives the auth requirement
   - Read `readBody(req)` destructuring → derives the request shape
   - Read every `sendJson(res, STATUS, {...})` → derives each response
     shape + status code
   - Note inline response blocks (long admin branches build the
     response object in-place rather than via a helper)
3. **Document auth.** Two concerns:
   - `Authorization: Bearer vctx_<hex>` — only required when the
     server is bound non-loopback (`VCONTEXT_BIND=0.0.0.0`); local
     callers are always `owner` with wildcard groups.
   - `X-Vcontext-Admin: yes` — CSRF mitigation required on
     destructive `/admin/*` actions (approve/reject patch, wipe,
     replay, rollback, restart, stop, adopt/reject idea,
     shell-command task-request).
4. **Reconcile with `ENDPOINTS_LIST`.** The server's 404 handler
   returns a `ENDPOINTS_LIST` array (see `scripts/vcontext-server.js`
   around line 6419) listing every advertised route. Cross-check
   your extraction against this list to catch missed branches.
5. **Cross-check with client usage.** Grep `~/skills/scripts/*.sh`,
   `~/skills/skills/**`, `~/.claude/hooks/**`, `~/skills/hooks.js`
   and `~/skills/scripts/vcontext-dashboard.html` for every URL to
   confirm the real-world call patterns.
6. **Note experimental / stub endpoints.** Some routes are functional
   stubs (e.g. `/tier/config` saves config but never syncs because
   cloud support is incomplete; `/federation/route` always uses local
   MLX). These are flagged under `x-aios-experimental` at the bottom
   of the YAML.

To regenerate after API changes, repeat steps 1–6. The process takes
about 30 minutes for a full pass. Future: a `scripts/extract-openapi.mjs`
tool could automate most of this by parsing the `if/else` chain via
acorn AST, but until then keep this a human-in-the-loop sweep — the
nuance of destructive-action detection and the occasional
auto-injected tag (`user:<id>`, `project:<ns>`) is easy to miss
mechanically.

## Adding a new endpoint

**Per P2 and the constitutional "contract-first" axiom, write the
spec FIRST, then the handler.** Workflow:

1. Open `vcontext-api-v1.yaml`. Add the new path entry with full
   `requestBody`, `responses`, `parameters`, `security`, and an
   `operationId`.
2. Bump the `info.version` following semver (additive → minor bump;
   breaking → major bump; purely additive fields inside an existing
   response body → patch bump).
3. Run the validators below. The spec must stay valid before any
   JS code lands.
4. Implement the handler in `scripts/vcontext-server.js`. The branch
   and handler should match the spec exactly — same status codes,
   same field names, same error messages for common failures.
5. Add a curl-based smoke test to `scripts/test-suite.sh` (or the
   appropriate sibling). A test is the end-to-end cross-check that
   the implementation matches the spec.
6. Commit with a message like `feat(api): add GET /foo/bar
   (spec-first, implementation follows)`.

## Validation tools

Any of these accept the YAML as-is:

```bash
# swagger-cli (fast, standalone)
npx @apidevtools/swagger-cli validate docs/schemas/vcontext-api-v1.yaml

# redocly (lint + preview)
npx @redocly/cli lint docs/schemas/vcontext-api-v1.yaml
npx @redocly/cli preview docs/schemas/vcontext-api-v1.yaml  # http://localhost:8080

# spectral (rule-based lint)
npx @stoplight/spectral-cli lint docs/schemas/vcontext-api-v1.yaml

# Python: just parse it (sanity check)
python3 -c "import yaml; yaml.safe_load(open('docs/schemas/vcontext-api-v1.yaml'))"
```

`swagger-cli validate` is the gate — CI / pre-commit should block
any commit that fails it.

## 5-line example: a new AI client reading /stats via this spec

```bash
# 1. Fetch the spec (or read it from disk)
curl -s http://127.0.0.1:3150/stats | jq '.entries, .db_size_human'

# 2. Or programmatically, using the spec to generate a typed client:
#    openapi-generator-cli generate -i docs/schemas/vcontext-api-v1.yaml \
#      -g typescript-fetch -o generated/vcontext-client
```

The single grep above shows what a new agent needs: **one URL, one
JSON shape, one auth model, zero source-diving.** That is the whole
point of P2.

## Field conventions

- **`inferred; please verify`** in a `description` means we could not
  determine the exact type or structure from the source and a human
  should confirm (typically for nested stubs like `/federation/route`
  `external` or `/otel/status` body).
- **`x-aios-*`** extensions capture AIOS-specific metadata (WebSocket
  appendix, rate limits, deprecations, experimental flags).
- Timestamps are **SQLite format** (`YYYY-MM-DD HH:MM:SS`, UTC) for
  stored `created_at` and **ISO 8601** elsewhere (generated fields,
  logs). This inconsistency is historical; flagged as future cleanup.
- Tag storage is a **JSON-stringified array** at rest (`"['a','b']"`)
  and parsed to an array on read by `parseTags()` — the `tags` field
  in responses can therefore appear as either shape depending on
  whether the response went through `parseTags` or not. Per-endpoint
  notes call this out.

## Related

- Constitution: [`docs/principles/AIOS-CONSTITUTION.md`](../principles/AIOS-CONSTITUTION.md)
- Implementation: [`scripts/vcontext-server.js`](../../scripts/vcontext-server.js)
- Dashboard: [`scripts/vcontext-dashboard.html`](../../scripts/vcontext-dashboard.html) (consumes many of these endpoints)
- WebSocket broadcast logic: search `wsBroadcast` in `vcontext-server.js`
