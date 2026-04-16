---
name: daily-ai-news-papers-aggregator
description: "Use when automating daily checks of AI development news/academic papers (e.g., arXiv, news sites), tracks usage frequency, and logs history for AIOS integration."
origin: auto-generated
---
Rules
1. Prioritize sources with API access (arXiv, Google Scholar, news APIs)
2. Maintain 7-day history retention with timestamped logs

Workflow
1. Execute daily crawl of AI-focused publications and news sites
2. Parse results using NLP to extract key technical insights

Gotchas
- Avoid duplicate entries from overlapping sources
- Handle API rate limits with exponential backoff

SKILL_NAME: mlx-embed-progress-monitor
---
name: mlx-embed-progress-monitor
description: "Use when executing low-load technical checks (sqlite queries, h files) for MLX embed progress tracking and system health."
origin: auto-generated
---
Rules
1. Run checks every 15 minutes during active training phases
2. Log query execution times and file access status

Workflow
1. Query MLX database for recent embed progress metrics
2. Validate file integrity of critical h files

Gotchas
- Ensure checks don't exceed 10% of system resources
- Handle potential file lock conflicts during validation