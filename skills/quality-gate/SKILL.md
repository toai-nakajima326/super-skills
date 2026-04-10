---
name: quality-gate
description: "Use for all work output. Enforces full-count inspection, source reconciliation, regression testing, and pyramid quality management."
origin: unified
---

## Rules

1. **Full-count inspection**: Sampling and spot-checking are prohibited. Every item must be verified.
2. **Source reconciliation**: All work results must be reconciled against the original source before marking complete.
3. **Regression testing**: When fixing a gap, re-verify the entire output, not just the fixed portion.
4. **Supervisor review**: Always re-access the source independently to verify. Never trust self-reported results.
5. **No qualitative reports**: "No problems" or "all good" is prohibited. Always report with numbers.

## Workflow — Pyramid Quality Management

```
        /\
       /  \   Approval Layer (Main): verify both reports, integrated review
      /────\
     /      \  Verification Layer (Checker): reconcile against source, count match
    /────────\
   /          \ Execution Layer (Worker): implement, create result files, report counts
  /────────────\
```

### For agent work:
1. Execution: Worker implements → creates result files → reports count
2. Verification: Checker reconciles against source → reports count → if mismatch, instructs worker to redo
3. Approval: Main confirms both reports → integrated review → phase completion gate

### For main's own work:
1. Execution: Main implements → creates result files → reports count
2. Verification: Main re-accesses source via different method to reconcile
3. Approval: Creates evidence file with quantitative report

### Required output per layer:
- Execution: "Processed: X items"
- Verification: "Reconciled: X of X match, X differences"
- Approval: Evidence file with both numbers recorded

### On mismatch:
- Verification finds mismatch → return to Execution (redo) → re-verify → repeat
- Approval finds mismatch → return to Verification (re-reconcile) → re-approve

### Post-fix mandatory re-verification cycle:
1. After worker fix: restart checker for full re-verification (regression test)
2. After checker re-verifies: main re-executes approval duties
3. Do not mark pair as completed until full implement → re-verify → re-approve cycle completes
4. "Fixed so it's fine" and "totals match so it's fine" are prohibited

## Gotchas

- Approval layer must verify not just calculation results but calculation inputs (premises)
- "X items are duplicates" → verify each ID against source
- "Approximately" or "estimated" numbers must be resolved before approval
- When comparing numbers, verify not just values match but definitions match (what was counted?)
