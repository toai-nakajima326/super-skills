# MLX Lazy-Load Proxy — Design Spec

**Status**: active implementation, 2026-04-20
**Author**: co-authored with user (HITL H2 approved)
**Inspired by**: mlx-lm#854 community pattern (surfaced by 2026-04-20 research agent)

---

## Problem

The Qwen3-8B-4bit generate model resident in `mlx-generate` (port 3162)
holds ~6 GB RSS continuously. On a 36 GB MacBook Pro M3 Pro co-tenant
with MLX embed (4.5 GB), Chrome (2 GB+), Codex, Docker, Playwright,
this pushes the system into jetsam territory — triggering the 2026-04-20
cascade that killed `com.vcontext.server` repeatedly.

Today's patch: disabled MLX generate until we can bring it back safely.
But "safely" requires 8B precision + memory discipline. A smaller model
is not acceptable (user: "8Bの精度でやりたい").

## Solution

A lazy-load proxy (port 3163, Node) that:
- Presents the same `/v1/*` interface as MLX generate
- Lazily starts MLX generate on first request
- Unloads MLX generate after configurable idle period (default 10 min)
- Handles the warm-up delay (8B loads in ~30-60s) by holding the first
  request until `/health` passes, up to a 90s timeout
- Never crashes the AIOS substrate — if MLX can't start (memory still
  too tight), the proxy returns a clean 503 to the client instead of
  triggering a cascade

Result: MLX generate exists in the system as a first-class AIOS
service, but its 6 GB footprint is only paid when actively generating.
System idle → 6 GB freed → vcontext has breathing room.

---

## Architecture

```
        ┌──────────────────────────────────────┐
        │  AI client (Claude Code / Codex /    │
        │  vcontext /consult/* handlers)       │
        └───────────────┬──────────────────────┘
                        │ POST /v1/chat/completions
                        │ (same shape as today)
                        ▼
            ┌───────────────────────────────┐
            │  mlx-generate-proxy  :3163   │   <- this component (new)
            │  - Node.js, < 50 MB RSS       │
            │  - stateful: last_request_at  │
            │  - idle timer: 10 min         │
            └───────────┬───────────────────┘
                        │ forward when alive
            ┌───────────▼────────────────┐
            │  mlx-generate      :3162  │   <- existing MLX server
            │  (~6 GB when loaded, 0    │
            │   when unloaded)          │
            └───────────────────────────┘
```

Clients continue to POST to port 3162. We rename the LaunchAgents so:
- **Before**: `com.vcontext.mlx-generate` → listens on 3162
- **After**: `com.vcontext.mlx-generate-proxy` → listens on 3162
  (proxy); `com.vcontext.mlx-generate` → listens on 3172 internally,
  disabled by default, only bootstrapped-on-demand by the proxy.

Alternative (simpler, chosen for v1): keep MLX generate on 3162, put
proxy on 3163, and have clients migrate to 3163 explicitly. See §Migration.

## State machine

```
STOPPED ──first request──► STARTING ──bootstrap + /health poll──► RUNNING
   ▲                                                                 │
   │                                                        idle >10m│
   └─────────launchctl bootout─────────────────────────────────────◄─┘
```

Transitions:

1. **STOPPED → STARTING (on request)**
   - Record `last_request_at = now()`
   - `launchctl enable gui/$(id -u)/com.vcontext.mlx-generate`
   - `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vcontext.mlx-generate.plist`
   - Poll `GET http://127.0.0.1:3162/health` every 3s, up to 90s timeout
   - On timeout: respond 503 to client + stay STOPPED (next request retries)
2. **STARTING → RUNNING (health OK)**
   - Forward original request; record `last_request_at`
3. **RUNNING (steady state)**
   - Every request: update `last_request_at`, forward to 3162
4. **RUNNING → STOPPED (idle)**
   - Timer every 60s checks `now() - last_request_at > IDLE_MS`
   - If true: `launchctl bootout gui/$(id -u)/com.vcontext.mlx-generate`
   - Wait 2s, verify process dead, log memory freed

## Invariants

- **I1**: Proxy process RSS ≤ 80 MB (we're saving memory, not adding
  to the problem).
- **I2**: During STARTING, NO new bootstrap calls (another client could
  arrive during warm-up — they join the wait queue, they don't retrigger).
- **I3**: Idle unload NEVER fires during an in-flight request. Keep a
  counter of active requests; bootout only when counter=0 AND idle time
  exceeds threshold.
- **I4**: Memory-pressure gate — before bootstrapping MLX, check free
  pages. If < 50000, respond 503 "memory tight, try again in 60s" to
  client. Reuses the same constant as watchdog's `MLX_RESTART_MIN_FREE_PAGES`.
- **I5**: If the proxy itself crashes, launchd restarts it. Client
  sees a brief connection error, retries, works. No cascade.

## Non-goals (v1)

- Request queueing. If 10 clients arrive while STARTING, they all wait
  for the same `/health` gate. No priority, no fairness. Good enough.
- Streaming. First version supports only buffered responses. Streaming
  `text/event-stream` can be added when a client needs it.
- Model switching. Single model (`Qwen3-8B-4bit`). Future: multiple
  models could live behind the proxy, each with their own idle timer.

## File layout

| Path | Purpose |
|------|---------|
| `scripts/mlx-generate-proxy.js` | the proxy itself (~200 LOC expected) |
| `~/Library/LaunchAgents/com.vcontext.mlx-generate-proxy.plist` | launchd entry |
| `config/LaunchAgents/com.vcontext.mlx-generate-proxy.plist` | git-mirrored copy |
| `docs/specs/2026-04-20-mlx-lazy-load-proxy.md` | this doc |

## Migration plan

### Phase A (today): proxy exists, separate port 3163
- Implement proxy on 3163
- MLX generate stays on 3162 (disabled, only proxy touches it)
- Clients that want lazy-load → hit 3163
- Clients that hit 3162 directly → get connection refused (MLX is off)
- No existing client breaks — they were already getting refused since
  this morning's launchctl disable

### Phase B (tomorrow): 3162 aliased to proxy
- Once proxy is proven stable (1 day run), rewire:
  - mlx-generate-proxy listens on 3162
  - mlx-generate listens on 3172 (internal)
- Clients continue hitting 3162, now lazy-loaded transparently
- Rollback: revert the port assignment in the plist, one commit

## Risks & mitigations

| Risk | Severity | Mitigation |
|------|---------|------------|
| Proxy crashes during STARTING | medium | launchd KeepAlive=true; client retry works |
| launchctl bootstrap hangs | low | 10s timeout on the bootstrap call itself |
| Memory still too tight after unload | medium | I4 gate — decline requests with 503 |
| Race: two requests arrive, one triggers bootstrap twice | low | I2 mutex — `starting` flag guards bootstrap |
| launchctl throttle ("you're not that important") | low | Bootstrap only fires when STOPPED → STARTING; no hot loops |
| MLX itself takes > 90s to warm up | low | Record warm-up time in metrics; tune timeout |

## Verification

1. Start proxy, verify RSS < 80 MB with no MLX running.
2. `curl -sS 127.0.0.1:3163/v1/chat/completions -d '...'` — expect 503
   initially ("memory tight") OR 200 with warm-up delay (60-90s).
3. Second request within idle window: expect fast response (MLX warm).
4. Wait 11 minutes; expect log "MLX idle, unloading"; RSS drops.
5. New request after idle: expect warm-up pattern again.
6. Kill proxy mid-request: expect launchd restart, next request works.
7. Smoke test under load: 10 concurrent requests during warm-up; all
   succeed (queued behind the single bootstrap).

## Observability

The proxy exposes:

- `GET /proxy/health` — proxy's own health (distinct from MLX's `/health`)
- `GET /proxy/state` — `{ state: 'STOPPED' | 'STARTING' | 'RUNNING',
  last_request_at, active_requests, warm_up_ms_last, idle_ms_remaining }`
- `GET /proxy/metrics` — counters: bootstraps, bootouts, 503s,
  warm-up latencies histogram

Surface these in the vcontext dashboard's `API Metrics` card.

## Why this is the right answer (AIOS Constitution check)

- **P1 loose coupling**: proxy is its own process; MLX is its own
  process; their failure modes are independent.
- **P2 contract-first**: proxy preserves `/v1/*` contract verbatim;
  clients don't know the difference.
- **P3 fail-open for infra**: MLX down + memory tight → 503 + friendly
  retry hint; never cascade.
- **P4 machine-readable**: `/proxy/state` is structured JSON.
- **P5 reversible**: Phase A → B migration has explicit rollback.
- **P6 observe before act**: warm-up timing logged, memory checked
  before bootstrap.

---

*This doc is the design; implementation follows in scripts/mlx-generate-proxy.js.*
