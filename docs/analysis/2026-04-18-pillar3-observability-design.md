# Pillar 3: Causal Observability — Initial Design

**Date**: 2026-04-18
**Phase**: Scaffolding (Q1 target, in progress)
**Goal**: every decision inside AIOS carries an OTEL trace ID; Langfuse is the UI.

---

## 1. Architecture

```
AIOS components (vcontext-server.js, article-scanner.js, chunk-summary loop, ...)
        |
        |  @opentelemetry/sdk-node + OTLP/HTTP exporter
        v
  scripts/lib/otel.js  (initSdk / getTracer / noop-fallback)
        |
        |  POST http://langfuse-web:3000/api/public/otel/v1/traces
        |  Basic auth: base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)
        v
  Langfuse stack (docker-compose, localhost:9091)
    - langfuse-web        — UI + API (Next.js)
    - langfuse-worker     — async ingest workers
    - postgres            — metadata
    - clickhouse          — traces / observations (v3+ mandatory)
    - redis               — queue
    - minio               — S3-compatible blob store (event payloads)
```

AIOS -> Langfuse is push-only over HTTP. If Langfuse is down or `LANGFUSE_HOST` is
unset, `scripts/lib/otel.js` returns a noop tracer; no span is exported, no error
bubbles up, the server keeps running. This is the **hard contract** — observability
must never take production down.

## 2. Initial instrumentation targets (priority order)

| # | Function                | Why first                                   | Span name                  |
|---|-------------------------|---------------------------------------------|----------------------------|
| 1 | `handleRecall`          | Hottest path, 10+ calls/min, semantic+FTS   | `vcontext.recall`          |
| 2 | `handleStore`           | Every hook write goes through here          | `vcontext.store`           |
| 3 | `mlxGenerate`           | LLM call — most expensive, needs token viz  | `genai.generate`           |
| 4 | `mlxEmbed` / `mlxEmbedFast` | Latency-sensitive, GPU-contended        | `genai.embed`              |
| 5 | `runOneChunkSummary`    | Parent span of 1+ mlxGenerate — causal root | `chunk-summary.run`        |

Phase 2 of this design lands #1-#2 only. #3-#5 tracked in follow-up tasks.

## 3. Span attribute mapping (GenAI semconv)

For **mlxGenerate** / **mlxEmbed** spans (OpenTelemetry GenAI semantic conventions):

| OTEL attr                      | Source in AIOS                             |
|--------------------------------|--------------------------------------------|
| `gen_ai.system`                | `"mlx"`                                    |
| `gen_ai.operation.name`        | `"chat"` or `"embeddings"`                 |
| `gen_ai.request.model`         | `MLX_GENERATE_MODEL` or `MLX_EMBED_MODEL`  |
| `gen_ai.request.max_tokens`    | `options.maxTokens`                        |
| `gen_ai.request.temperature`   | `options.temperature`                      |
| `gen_ai.usage.input_tokens`    | `estimateTokens(prompt)`                   |
| `gen_ai.usage.output_tokens`   | `estimateTokens(response)`                 |
| `gen_ai.response.finish_reasons` | `["stop"]` on success                    |

For **vcontext.recall / vcontext.store** spans (custom AIOS namespace):

| Attr                          | Value                                      |
|-------------------------------|--------------------------------------------|
| `vcontext.op`                 | `"recall"` / `"store"` / `"recent"`        |
| `vcontext.query_tokens`       | `estimateTokens(q)` (recall only)          |
| `vcontext.result_count`       | `allResults.length` (recall/recent)        |
| `vcontext.tier_hits`          | `"ram,ssd"` (comma-list of tiers that hit) |
| `vcontext.entry_type`         | `type` (store) / filter `type` (recall)    |
| `vcontext.user_id`            | `auth.userId`                              |
| `http.response.status_code`   | HTTP status returned                       |

## 4. Trace ID propagation into existing `entries` table

The `entries` table already has a `tags` column (pipe-separated). Every
`handleStore` span that is a CHILD of a parent span (e.g. chunk-summary calls
mlxGenerate calls handleStore) records the active span's `traceId` into a new
tag `trace:<hex16>`. No schema migration — reuses `tags`.

Dashboards can then join `/metrics/trace-overview` (Langfuse) with local entry
IDs by filtering `tags LIKE '%trace:<id>%'`.

## 5. Dashboard integration

New endpoint **`GET /metrics/trace-overview`** on vcontext-server:

- Proxies a Langfuse query (`/api/public/traces?limit=50&orderBy=timestamp.desc`)
- Returns `{ total, last_hour, top_ops: [{name, p50_ms, p95_ms, err_rate}] }`
- Falls back to `{ enabled: false }` if `LANGFUSE_HOST` unset

Dashboard HTML gets a new "Traces" card linking to `http://localhost:9091` for
deep-dive. Ship after Phase 2 validation.

## 6. Failure modes

| Scenario                         | Behavior                                    |
|----------------------------------|---------------------------------------------|
| `LANGFUSE_HOST` env unset        | `otel.js` returns noop tracer, zero overhead |
| Langfuse container stopped       | OTLP export fails silently, in-memory buffer drops oldest |
| Langfuse auth keys wrong         | First export logs warning once, then silent |
| OTLP exporter throws mid-span    | Caught in `otel.js`, span ended with error status, request continues |
| SDK init throws at boot          | `initOtel()` catches, logs, returns false — server boots without tracing |

Principle: **observability is a bonus channel, never a dependency.** All five
scenarios above leave AIOS fully functional.

## 7. Rollout

1. Phase 2 (this PR): docker-compose, otel.js, instrument handleStore/Recall.
2. Phase 3 (next): instrument mlxGenerate/mlxEmbed, add trace_id into tags.
3. Phase 4: /metrics/trace-overview + dashboard Traces card.
4. Phase 5: extend to article-scanner, skill-discovery, predictive-search.

## 8. Ports

Per `~/ai-shared-rules/PORT_RULES.md`, Claude Code range is 3000-3499. Langfuse
is shared infra, not a Claude Code app. Mapping:

- `langfuse-web` -> host **9091** (shared 9000-9499 range)
- `postgres` / `clickhouse` / `redis` / `minio` -> internal docker network only,
  no host port exposure (reduces attack surface + avoids port conflicts)

## 9. References

- OTEL GenAI semconv: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Langfuse self-host: https://langfuse.com/self-hosting/docker-compose
- Langfuse OTEL: https://langfuse.com/docs/opentelemetry/get-started
