---
name: investigate
description: "Use when debugging a bug or unexpected behavior by tracing to root cause before changing any code."
origin: unified
---

## Rules

- No speculative fixes. Do not change code until the root cause is confirmed with evidence.
- Collect evidence before changing code. Logs, stack traces, reproduction steps, and runtime state come first.
- Separate observation from hypothesis from fix. Label each explicitly so they never blur together.
- Reproduce the bug reliably before attempting to diagnose it. If you cannot reproduce it, say so.
- Prefer the smallest possible change that addresses the confirmed root cause.

## Workflow

1. **Reproduce** -- Create a minimal, reliable reproduction of the bug. Record exact inputs, environment, and observed output versus expected output.
2. **Trace execution path** -- Follow the code path from input to misbehavior. Use logs, debugger output, print statements, or tests to observe actual runtime values at each step.
3. **Form minimal root-cause hypothesis** -- Based on the trace, propose the simplest explanation that accounts for all observed evidence. State it as a falsifiable claim.
4. **Verify against code and runtime** -- Confirm the hypothesis by checking the relevant source code and validating with a targeted test or log. If the hypothesis does not hold, return to step 2 with new evidence.
5. **Propose fix** -- Write the minimal code change that addresses the confirmed root cause. Explain why this fix is correct and what evidence supports it.

## Gotchas

- Fixing symptoms instead of causes leads to whack-a-mole debugging. Always trace to the origin.
- "It works on my machine" usually means the reproduction is incomplete. Check environment differences.
- Multiple bugs can share the same symptom. Verify the fix actually resolves the original reproduction case.
- Avoid large refactors disguised as bug fixes. Keep the fix scoped to the root cause.
