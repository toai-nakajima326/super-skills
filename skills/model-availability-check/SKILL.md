---
name: model-availability-check
description: "Use when verifying 4096-model compatibility and resource access before execution to prevent exit code 1 errors."
origin: auto-generated
---

## Rules

1. Check model version and resource requirements against system capabilities
2. Validate execution environment meets minimum hardware/software specifications

## Workflow

1. Query model version and resource requirements
2. Compare with system capabilities and available resources

## Gotchas

- System resource limits may differ across environments
- Model incompatibility with specific hardware configurations

SKILL_NAME: path-validation-automa
---
name: path-validation-automa
---
description: "Use when validating file paths and environment-specific configurations to prevent execution errors in different operating systems."
origin: auto-generated
---

## Rules

1. Verify path existence and permissions across target environments
2. Ensure environment-specific configuration files are accessible

## Workflow

1. Check path existence in target OS file system
2. Validate read/write permissions for all users

## Gotchas

- OS-specific path syntax differences (e.g., / vs \)
- Environment variables may override explicit paths