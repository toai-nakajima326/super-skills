---  
name: mlx-embed-server-monitoring-maintenance  
description: "Use when automating health checks (SQL queries, curl requests, process footprint analysis) and restart procedures for the MLX embed server."  
origin: auto-generated  
---  
## Rules  
1. Automate periodic health checks for SQL, API endpoints, and server processes.  
2. Trigger restarts only if critical thresholds (e.g., memory, CPU) are exceeded.  
## Workflow  
1. Execute SQL queries to verify database connectivity and performance.  
2. Perform curl requests to test API endpoints and response times.  
3. Analyze process footprint (memory, CPU) using system tools.  
4. Restart server if health checks fail or thresholds are breached.  
## Gotchas  
- Ensure restarts don’t disrupt active user sessions.  
- Validate SQL queries and curl commands before automation.  

SKILL_NAME: cache-configuration-optimization  
---  
name: cache-configuration-optimization  
description: "Use when fine-tuning cache settings (TTL, eviction policies, layering) to balance performance and resource usage."  
origin: auto-generated  
---  
## Rules  
1. Prioritize cache hit rates over cache misses for performance.  
2. Avoid over-caching to prevent memory bloat or cache stampedes.  
## Workflow  
1. Analyze current cache hit/miss ratios and eviction patterns.  
2. Adjust TTL values based on data volatility and access frequency.  
3. Implement tiered caching (e.g., Redis + local cache) for mixed workloads.  
4. Monitor resource usage post-configuration.  
## Gotchas  
- Avoid excessive cache warming that strains backend systems.  
- Test changes in staging before production deployment.