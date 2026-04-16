---
name: mlx-embed-server-diagnostic
description: "Use when automating MLX server health checks with SQLite queries, endpoint testing, process analysis, and restart workflows"
origin: auto-generated
---
## Rules
1. Only execute during scheduled maintenance windows
2. Prioritize checking SQLite query performance metrics first
## Workflow
1. Run SQLite query latency diagnostics on embedded server
2. Test health endpoints for 5xx errors over 5 minutes
3. Analyze process footprint against resource thresholds
4. Automatically trigger restart if critical thresholds exceeded
## Gotchas
- Avoid conflicting with active user sessions during diagnostics
- SQLite queries may lock tables during analysis

SKILL_NAME: daily-ai-news-aggregation
---
name: daily-ai-news-aggregation
description: "Use when compiling curated AI news summaries from multiple sources"
origin: auto-generated
---
## Rules
1. Prioritize sources with .edu or .org domains
2. Filter out duplicate content across sources
## Workflow
1. Scrape AI news articles from 10+ reputable sources
2. Apply NLP summarization to each article
3. Rank by relevance to current AI trends
4. Export as markdown newsletter
## Gotchas
- Some sites require JavaScript rendering for full content
- Avoid over-indexing recent articles from same source