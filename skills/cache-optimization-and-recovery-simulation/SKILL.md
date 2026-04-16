---  
name: cache-optimization-and-recovery-simulation  
description: "Use when automating cache size adjustments (e.g., 1.5GB) and simulating recovery processes for system resilience."  
origin: auto-generated  
---  
## Rules  
1. Only applicable to systems with explicit cache thresholds or recovery triggers.  
2. Requires prior validation of Bash/Script tools for cache interaction.  
## Workflow  
1. Automate cache size tuning via Bash scripts with dynamic thresholds.  
2. Simulate recovery scenarios (e.g., cache eviction, reload) using predefined scripts.  
## Gotchas  
- Avoid overwriting critical cache data during simulations.  
- Ensure scripts include rollback mechanisms for testing environments.