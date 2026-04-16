---  
name: system-resource-monitoring  
description: "Use when checking CPU usage, load metrics, or resource constraints for system performance optimization."  
origin: auto-generated  
---  
## Rules  
1. Prioritize checking CPU and memory utilization thresholds.  
2. Flag alerts for sustained low-load states or resource bottlenecks.  
## Workflow  
1. Query system metrics (CPU, memory, disk I/O).  
2. Compare against predefined thresholds for "low load" or "CPU minimum" constraints.  
## Gotchas  
- Avoid overloading the system with frequent checks.  
- Ensure compatibility with platform-specific monitoring tools.  

SKILL_NAME: model-conversion-automation  
---  
name: model-conversion-automation  
description: "Use when converting models between formats (e.g., CoreML, ONNX) for deployment or compatibility."  
origin: auto-generated  
---  
## Rules  
1. Automate format conversion using toolchains like CoreML, TensorFlow, or PyTorch.  
2. Validate output model integrity post-conversion.  
## Workflow  
1. Analyze input model format and target framework.  
2. Execute conversion with minimal manual intervention.  
## Gotchas  
- Some conversions may require retraining or architecture adjustments.  
- Ensure license compliance for proprietary format tools.