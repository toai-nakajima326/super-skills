---
name: supervisor-worker
description: "Use when orchestrating multi-agent work. Enforces pair-agent pattern with workers, checkers, and independent judge."
origin: unified
---

## Rules

1. **Main does not work**: Main's role is instruction, approval, and rule enforcement only. No code edits, no file creation, no grep investigation. All implementation is delegated to worker agents.
2. **Pair-agent pattern**: Every worker must have a corresponding checker launched simultaneously.
3. **Role separation is absolute**:
   - Worker: implements only. Applies `frontend-patterns`, `coding-standards`, `backend-patterns` as appropriate.
   - Checker: verifies only. Applies `review` and `verification-loop`. Never writes code.
   - Independent Judge (Main Checker): final evaluation from an independent context. Never trusts worker/checker reports at face value.
4. **Agent communication**: Agents communicate freely via SendMessage. Checker can instruct worker to redo work directly without going through main.
5. **Max agents**: Worker 3 + Checker 3 + Independent Judge 1 = 7 max. Reuse completed agent slots.
6. **Before launching agents**: Always check Todo list for agent count limits or temporary constraints.

## Workflow

1. Define task scope, target spec, acceptance criteria, and counting method before starting
2. Launch worker + checker pair simultaneously
3. Checker monitors worker's progress in real-time (pair-programming style, not batch review)
4. Worker completes → Checker performs full reconciliation against source
5. Both report counts independently → counts must match
6. If mismatch → checker instructs worker to redo → re-verify → repeat until match
7. Main verifies both reports → does NOT trust self-reported numbers
8. Independent Judge validates final output from separate context
9. All three layers (implement + verify + approve) must pass before marking complete

## Execution Modes

| Mode | When | Agents |
|------|------|--------|
| **Light** | Simple tasks | Main + Checker |
| **Standard** | Normal tasks | Worker + Checker + Main |
| **Strict** | Auth, billing, permissions, data migration, external API, release, bulk spec implementation | Multiple Workers + Multiple Checkers + Independent Judge |

## Gotchas

- "Code exists" ≠ "complete". Spec values must be verified in implementation.
- Main approving without independent verification is a rule violation.
- Checker starting to write code is a rule violation.
- Never batch all checks at the end. Check while work is in progress.
