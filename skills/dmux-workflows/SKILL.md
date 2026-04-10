---
name: dmux-workflows
description: "Use when decomposing tasks for parallel execution, orchestrating concurrent agent workflows, or designing fan-out/fan-in processing pipelines."
origin: unified
---

## Rules

- Identify independent tasks before parallelizing. Only work that has no data dependency on other work can safely run concurrently. Map the dependency graph first; parallelize second.
- Minimize shared state between parallel workers. Each worker should operate on its own slice of data with its own workspace. Shared mutable state requires synchronization and is the primary source of concurrency bugs.
- Aggregate results safely. When parallel workers complete, merge their results in a deterministic order. Handle partial failures: decide upfront whether one worker's failure aborts the batch or is tolerated.
- Set timeouts and resource limits per worker. A single stalled worker should not block the entire pipeline. Define maximum execution time and resource consumption for each parallel branch.
- Make work units idempotent. If a worker fails and needs to be retried, re-running it should produce the same result without side effects from the partial first run.
- Plan for uneven completion times. Workers will not finish simultaneously. Design the aggregation step to process results as they arrive rather than waiting for all workers if possible.

## Workflow

1. **Decompose the task** -- break the overall task into discrete work units. Each unit should have clearly defined inputs, outputs, and success criteria.
2. **Map the dependency graph** -- determine which work units depend on the outputs of others and which are fully independent. Only independent units are candidates for parallel execution.
3. **Assign workers** -- allocate one worker per independent task. Define the instructions, input data, and expected output format for each worker. Ensure workers operate on separate files, directories, or data partitions.
4. **Launch parallel execution** -- start all independent workers simultaneously. Monitor their status for failures, timeouts, and resource issues.
5. **Monitor and handle failures** -- track each worker's progress. If a worker fails, decide whether to retry it, skip it and note the gap, or abort the entire batch. Apply the retry policy defined in the planning step.
6. **Synchronize at completion boundaries** -- wait for all workers in a parallel batch to complete (or fail) before proceeding to dependent work. Do not start downstream tasks until their inputs are fully ready.
7. **Aggregate and validate results** -- collect outputs from all workers, merge them in a deterministic order, and validate the combined result for completeness and consistency. Check that the total output accounts for all input work units.

## Gotchas

- Parallelizing CPU-bound work across more workers than available cores (or API rate limits) creates contention, not speedup. Match parallelism to actual resource capacity.
- Workers writing to the same file, database table, or API endpoint without coordination will produce corrupt or incomplete results. Assign each worker its own output target and merge at the end.
- Error messages from parallel workers can interleave, making logs unreadable. Prefix all log output with a worker identifier and capture each worker's output separately.
- A "fan-out" without a matching "fan-in" leaves results scattered. Every decomposition must have a planned aggregation step that produces the final unified output.
- Retrying a failed worker is only safe if the work unit is idempotent. If a worker partially wrote output before failing, the retry must clean up or overwrite the partial result.
- Load imbalance (one worker getting much more work than others) negates the benefit of parallelism. Aim for roughly equal work distribution or use a work-stealing pattern.
- Testing parallel workflows with a single worker masks concurrency issues. Always test with the actual degree of parallelism to catch race conditions, resource contention, and aggregation bugs.
