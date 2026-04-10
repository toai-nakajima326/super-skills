---
name: phase-gate
description: "Use when transitioning between work phases. Enforces integrated review, evidence file creation, and todo completion before proceeding."
origin: unified
---

## Rules

1. **No phase transition without review**: Before starting Phase N+1, Phase N integrated review must be completed.
2. **Evidence file required**: Review results must be saved as `docs/analysis/phase-N-review.md`.
3. **Todo enforcement**: Cannot create Phase N+1 todos or launch Phase N+1 agents while Phase N review todo is incomplete.
4. **Full read required**: Read entire agent result files (not just first 50 lines).

## Workflow

1. All Phase N agents complete
2. Create "Phase N Integrated Review" todo item, set to in_progress
3. Read ALL Phase N agent result files in full (entire file, not truncated)
4. Check category/schema consistency across files, create mapping table if inconsistent
5. Report integrated review results (count reconciliation + consistency check + issues found)
6. Save review to `docs/analysis/phase-N-review.md`
7. Mark "Phase N Integrated Review" todo as completed
8. Only then begin Phase N+1 work

## Evidence File Requirements

The `phase-N-review.md` file must contain:
- Line count of each agent result file (proof of full read)
- Category/schema consistency check results (including mapping table)
- Issues discovered and remediation plan
- Quantitative report: "Reconciled: X of X match, X differences"

## Trigger Guard

Before using any of these phrases, verify Todo list has no pending/in_progress items:
- "Complete", "OK", "Next", "Shall we proceed?"
- If pending/in_progress items remain, execute those first
- Do not report completion or suggest next steps until ALL Todo items are completed

## Gotchas

- Phase review todo marked complete without evidence file is a rule violation.
- "All agents completed" ≠ "Phase complete". Phase gate must pass first.
- Reading only the summary or first 50 lines is a rule violation. Read the full file.
- Launching Phase N+1 agents before Phase N review is completed is prohibited.
