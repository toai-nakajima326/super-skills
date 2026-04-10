---
name: report-format
description: "Use when reporting task completion. Enforces typed schema with quantitative metrics, coverage rate, and pass/fail criteria."
origin: unified
---

## Rules

1. Free-text completion reports are prohibited. All reports must follow the typed schema.
2. Reports without coverage rate (反映率) are rejected.
3. Reports without evidence (証跡) are rejected.
4. Reports without explicit PASS/FAIL are rejected.
5. If there are remaining items, the task is not complete.
6. Main must not accept reports that violate this format.

## Report Schema

```md
## Report: [Task Name]
- Scope: [files / screens / features]
- Items processed: X items
- Count definition: [what counts as 1 item]
- Source reconciliation: X of X match
- Coverage rate: X% (X of X spec items implemented)
- Acceptance criteria: [criteria] → PASS/FAIL
- Verification command: [command used to verify]
- Evidence: [grep result / artifact path / screenshot / log]
- Remaining items: [list, or "none"]
```

## Acceptance Criteria for Reports

The report receiver (main) must verify:
1. Format compliance — all fields present
2. Coverage rate present and numeric
3. Evidence present and verifiable
4. PASS/FAIL explicitly stated
5. If remaining items exist → not complete

## Completion Checklist

Before saying "complete", "OK", "next", or "shall we proceed":
1. Read the result file with Read tool (not just the summary)
2. Access the source via browser and reconcile counts/IDs
3. Show reconciliation quantitatively (diff/comm)
4. Report in format: "Reconciled: X of X match, X differences"
5. For implementation tasks: verify spec quantitative values are reflected in code via grep/script

## Gotchas

- "Code exists" ≠ "complete". Spec values must be reflected in implementation.
- Qualitative reports like "no issues" or "all good" are rejected.
- Every number must include its count definition (what was counted).
- Coverage rate must be calculated against the spec, not against what was built.
