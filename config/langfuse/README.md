# Langfuse self-hosted stack — AIOS Pillar 3

OTEL trace backend for `~/skills` (vcontext-server + AIOS loops).
See `docs/analysis/2026-04-18-pillar3-observability-design.md` for context.

## One-time setup

```bash
# 1. Pull images (~3 GB total: langfuse x2, postgres, clickhouse, redis, minio)
docker compose -f config/langfuse/docker-compose.yml pull

# 2. Start the stack (first boot = ~30 s for migrations)
docker compose -f config/langfuse/docker-compose.yml up -d

# 3. Open UI, create org + project
open http://localhost:9091

# 4. Settings -> API keys -> Create new, then export:
export LANGFUSE_HOST=http://localhost:9091
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...

# 5. Restart vcontext-server so it picks up the env vars
#    (or add them to your launchd plist / shell rc)
```

## Daily operations

```bash
# Check status
docker compose -f config/langfuse/docker-compose.yml ps

# Tail web logs
docker compose -f config/langfuse/docker-compose.yml logs -f langfuse-web

# Stop (keeps data)
docker compose -f config/langfuse/docker-compose.yml down

# Full wipe (DELETES ALL TRACES)
docker compose -f config/langfuse/docker-compose.yml down -v
```

## Ports

- **9091** — Langfuse web UI (host-exposed, shared 9000-9499 range)
- All other services (postgres, clickhouse, redis, minio) are **docker-internal only**

## If you want to skip Langfuse entirely

Just leave `LANGFUSE_HOST` unset. `scripts/lib/otel.js` detects this and
returns a noop tracer — vcontext-server runs identically without any trace
export overhead.

## Security notes (dev defaults)

- `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, DB passwords in
  `docker-compose.yml` are dev-grade. Rotate before sharing the stack on a
  network. Single-user localhost is fine as-is.
- `data/langfuse-config.json` stores your public/secret API keys — gitignored.
