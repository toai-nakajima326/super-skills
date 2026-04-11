---
name: virtual-context
description: "Use always. Extends context window with 4GB RAM-backed store. Store decisions, recall past context, search history."
origin: unified
---

## Rules

1. Before answering complex questions, recall relevant past context
2. After making important decisions, store them with tags
3. At session start, recall recent entries to restore context
4. Store errors and their solutions for future reference
5. Never store secrets, API keys, or credentials

## How to Use

### Store context (decisions, observations, code, errors)

```bash
# Store a decision
curl -s -X POST http://localhost:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"decision","content":"Chose SQLite over PostgreSQL for local caching because zero-dep and RAM-disk backed","tags":["arch","database"],"session":"current"}'

# Store an observation
curl -s -X POST http://localhost:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"observation","content":"Build takes 45s, hot reload works, no type errors","tags":["build","perf"]}'

# Store a code pattern
curl -s -X POST http://localhost:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"code","content":"Pattern: use execFileSync instead of execSync for safety","tags":["pattern","security"]}'

# Store an error and its resolution
curl -s -X POST http://localhost:3150/store \
  -H 'Content-Type: application/json' \
  -d '{"type":"error","content":"ENOENT /Volumes/VContext — RAM disk not mounted. Fix: run vcontext-setup.sh start","tags":["ram-disk","fix"]}'
```

### Recall past context (full-text search)

```bash
# Search by keyword
curl -s 'http://localhost:3150/recall?q=database&limit=5'

# Search with type filter
curl -s 'http://localhost:3150/recall?q=architecture&type=decision&limit=10'

# Search for errors
curl -s 'http://localhost:3150/recall?q=ENOENT&type=error'
```

### Get recent entries

```bash
# Last 10 entries
curl -s 'http://localhost:3150/recent?n=10'

# Last 5 decisions
curl -s 'http://localhost:3150/recent?n=5&type=decision'

# Last 20 observations
curl -s 'http://localhost:3150/recent?n=20&type=observation'
```

### Session history

```bash
# Get all entries for a session
curl -s 'http://localhost:3150/session/my-session-id'
```

### Maintenance

```bash
# View stats
curl -s http://localhost:3150/stats

# Health check
curl -s http://localhost:3150/health

# Compact old entries (entries >24h get summarized)
curl -s -X POST http://localhost:3150/summarize

# Prune entries older than 7 days
curl -s -X DELETE 'http://localhost:3150/prune?older_than=7d'

# Prune entries older than 24 hours
curl -s -X DELETE 'http://localhost:3150/prune?older_than=24h'
```

## Session Start Workflow

At the beginning of every session:

```bash
# 1. Check if server is running
curl -s http://localhost:3150/health

# 2. If not running, start the system
bash ~/skills/scripts/vcontext-setup.sh start
node ~/skills/scripts/vcontext-server.js &

# 3. Recall recent context
curl -s 'http://localhost:3150/recent?n=20'

# 4. Search for relevant past decisions
curl -s 'http://localhost:3150/recall?q=<current-topic>&type=decision&limit=5'
```

## When to Store

| Event | Type | Example |
|-------|------|---------|
| Architecture choice | decision | "Chose monorepo over polyrepo for shared types" |
| Config change | decision | "Set port to 3150 per PORT_RULES.md" |
| Bug found + fixed | error | "TypeError in X, fixed by adding null check" |
| Build/test result | observation | "All 47 tests pass, build time 12s" |
| Code pattern discovered | code | "Use FTS5 MATCH for full-text, LIKE as fallback" |
| Session summary | conversation | "Worked on auth flow, 3 endpoints done, 2 remaining" |

## Infrastructure

- RAM disk: `/Volumes/VContext` (4 GB APFS)
- Database: `/Volumes/VContext/vcontext.db` (SQLite + FTS5)
- Server: `http://localhost:3150` (Node.js, zero dependencies)
- Backup: `~/skills/data/vcontext-backup.sqlite` (every 5 minutes)
- Setup: `~/skills/scripts/vcontext-setup.sh {start|stop|status}`
- Server: `node ~/skills/scripts/vcontext-server.js`
