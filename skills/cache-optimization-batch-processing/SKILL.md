---
name: cache-optimization-batch-processing
description: "Use when automating cache clearing after batch processing to prevent size limits"
origin: auto-generated
---

## Rules

1. Only trigger cache clear after explicit batch completion confirmation
2. Prioritize non-destructive cache reset commands before using rm -rf

## Workflow

1. Monitor batch processing completion status
2. Execute cache reset command: `echo > /path/to/cache` followed by `rm -rf /cache/*`

## Gotchas

- Avoid using rm -rf on production caches without full path verification
- Ensure cache path permissions allow write operations for the executing user