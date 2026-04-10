---
name: verification-loop
description: Use for automated verification of work results against specifications, iterating until the output fully matches expected criteria.
origin: unified
---

## Rules

- Verify output against the original specification, not against assumptions. Always re-read the spec or requirements before comparing.
- Check edge cases explicitly. Verification must cover not only the happy path but also boundary conditions, empty inputs, error states, and unexpected data types.
- Run against real data when possible. Synthetic test data may miss issues that only appear with production-like inputs. Use real or realistic data for final verification.
- Iterate until the result fully matches the spec. Partial matches are not acceptable. Each gap found triggers a fix-and-verify cycle.
- Cap iterations to prevent infinite loops. Set a maximum number of verification cycles (default: 5). If the result still does not match after the cap, report the remaining gaps and escalate to the user.
- Document each iteration. Record what was checked, what passed, what failed, and what was changed in each cycle. This creates a traceable verification history.

## Steps

1. **Define expected output** -- Before starting work, establish the acceptance criteria:
   - Extract concrete, testable requirements from the spec or user request.
   - List each requirement as a verifiable checkpoint (e.g., "function returns 404 for missing resources", "CSV contains exactly 12 columns").
   - Include edge cases in the checklist.
2. **Execute work** -- Perform the implementation, generation, or transformation as specified.
3. **Compare result to spec** -- Systematically check each acceptance criterion:
   - Run tests, scripts, or manual checks against every item in the checklist.
   - Record pass/fail for each criterion with evidence (output snippets, test results, file diffs).
4. **Identify gaps** -- For any criterion that fails:
   - Describe what the expected output was versus what was produced.
   - Diagnose the root cause of the discrepancy.
   - Determine the minimal fix needed.
5. **Iterate until match** -- Apply the fix and return to step 3. Repeat until:
   - All criteria pass, OR
   - The iteration cap is reached (report remaining gaps to the user).
   - Each iteration re-checks all criteria, not just the ones that previously failed, to catch regressions.

## Gotchas

- Flaky tests or non-deterministic outputs can cause false failures. If a criterion fails intermittently, run it multiple times before counting it as a real gap.
- Specifications may be ambiguous or incomplete. If a requirement cannot be verified because the spec is unclear, flag it for the user rather than making assumptions.
- Fixing one gap can introduce another (regression). Always re-verify the full checklist after each fix, not just the fixed item.
- Performance or timing-dependent criteria may need special handling (retries, timeouts, or tolerance thresholds).
- The iteration cap exists to prevent wasted effort, not to allow shipping broken work. When the cap is hit, the user must decide next steps.
