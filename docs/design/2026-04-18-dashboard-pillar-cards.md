# Dashboard Pillar Cards — Design Note (2026-04-18)

Three backend endpoints shipped today but have no UI visibility. This doc
captures the exact response shape (verified against the running server at
127.0.0.1:3150) so the dashboard cards render correctly.

## 1. GET /trace/:id — Pillar 3 (Causal Observability)

Handler: `handleTrace()` at `scripts/vcontext-server.js:2094`
Routing: `scripts/vcontext-server.js:6357` — regex `^\/trace\/\d+$`

### Auth
- `validateApiKey()` — localhost bypass grants owner role.
- 401 on invalid Bearer key.
- No role gate beyond valid-auth (any role can trace).

### Response shape (HTTP 200)
```json
{
  "id": 138442,
  "found": true,
  "depth": 1,
  "truncated": false,
  "ancestry": [
    {"id":138442,"type":"tool-use","session":"...","parent_id":null,
     "created_at":"2026-04-18 08:02:53","preview":"..."}
  ],
  "children": [
    {"id":138443,"type":"tool-result","session":"...",
     "created_at":"...","preview":"..."}
  ]
}
```
- `ancestry` is root-first (index 0 = oldest cause), target last.
- Hard cap 50 hops upward; `truncated:true` if hit.
- `children` capped at 50.
- `preview` = `substr(content,1,200)`.

### Errors
- 400 `{"error":"Usage: GET /trace/:id (numeric id)"}` — non-numeric id.
- 400 `{"error":"Invalid id"}` — id ≤ 0 or NaN.
- 404 `{"id":<n>,"found":false}` — entry doesn't exist.
- 401 `{"error":"Invalid API key"}` — bad Bearer.

## 2. GET /predict/next — Pillar 4 (Predictive Ambience)

Handler: `handlePredictNext()` at `scripts/vcontext-server.js:5742`
Routing: `scripts/vcontext-server.js:7629`

### Auth
- `validateApiKey()` only. No role gate.

### Query params
- `session=<id>` — scopes last-tool detection to that session.
- `limit=<int>` — default 5, max 20.

### Response shape (HTTP 200)
```json
{
  "generated_at": "2026-04-18T08:02:51.638Z",
  "signals": {
    "last_tool": "Bash",
    "active_gap_count": 5,
    "top_skills": [{"name":"investigate","count":11}, ...]
  },
  "predictions": [
    {"kind":"gap|skill|tool|suggestion",
     "label":"<string, truncated>",
     "score":0.9,
     "reason":"<human explanation>",
     "parent_id": 137971}
  ]
}
```
- `predictions` already sorted by score desc, capped to `limit`.
- `parent_id` only present for `kind:'gap'` and `kind:'suggestion'`.

### Errors
- 401 on bad key. No other explicit error paths — handler best-effort
  catches per-signal and returns empty `predictions` if nothing matches.

## 3. GET /export — Pillar 5 (Open Substrate)

Handler: `handleExport()` at `scripts/vcontext-server.js:2169`
Routing: `scripts/vcontext-server.js:6361`

### Auth
- `validateApiKey()` + `hasRole(auth, 'owner')` required.
- 401 on bad key. 403 `{"error":"Export requires owner role."}` on non-owner.
- Localhost bypass = owner, so dashboard calls succeed without a Bearer.

### Query params
- `since=<id>` (default 0) — skip entries ≤ this id.
- `limit=<n>` (default 500, max 2000) — per-page batch.
- `max_entries=<n>` (default 50 000, max 500 000) — hard cap.
- `include_sensitive=1` — include api-key/credential types (logged).

### Response format
- `Content-Type: application/x-ndjson; charset=utf-8`
- `Content-Disposition: attachment; filename="aios-export-YYYY-MM-DD.ndjson"`
- `X-AIOS-Export-Version: 1`
- Body: NDJSON. Line 1 = header, lines 2..N = entries, last line = trailer.
  - Header: `{aios_export_version, generated_at, source_host, exported_by,
     schema, excluded_types, since_id, page_limit, max_entries,
     include_sensitive, notes}`
  - Entry: all schema columns (id, type, content, tags, …, parent_id).
  - Trailer: `{"__trailer":true,"written":N,"last_id":M,"batches":K}`

### Errors
- 401 on bad key.
- 403 on non-owner.
- Inline DB errors written as `{"__error":"..."}` NDJSON line (stream already open).

## UI decisions

- Card A (/trace): user-triggered only, input + Trace button.
- Card B (/predict/next): polled on refresh cycle (new 19th endpoint in
  `Promise.all`), renders top-N with confidence bars.
- Card C (/export): single button + danger-confirmation modal, downloads
  via `Blob`+anchor. Never auto-called.

All cards added after `🧰 AIOS Task Queue` and before `Recent Entries`.
Card C uses `wide` class to emphasise danger; A and B use normal width.
