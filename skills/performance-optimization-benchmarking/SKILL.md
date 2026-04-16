---  
name: performance-optimization-benchmarking  
description: "Use when testing system performance using tools like `time`, `stress-ng`, or `siege` to balance speed and quality while simulating real-world workloads."  
origin: auto-generated  
---  
## Rules  
1. Prioritize non-intrusive benchmarks to avoid altering system behavior.  
2. Validate results against baseline metrics for accuracy.  
## Workflow  
1. Select benchmarking tool (e.g., `stress-ng` for CPU/memory, `siege` for HTTP load testing).  
2. Run tests with controlled parameters (e.g., concurrent users, duration).  
3. Analyze output for latency, throughput, and resource utilization.  
4. Iterate optimizations based on bottlenecks identified.  
## Gotchas  
- Avoid overloading production systems during testing.  
- Ensure tools are compatible with the target protocol (e.g., HTTP/FTP).