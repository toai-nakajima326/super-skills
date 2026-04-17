---
name: adversarial-review
description: |
  Adversarial code review workflow that actively tries to break the code — probing
  race conditions, null paths, edge cases, and weak assumptions. Use before PRs,
  security-sensitive changes, or any case where standard review feels insufficient.
origin: unified
---

# Adversarial Review

## Distinction from Standard Review

Standard review (`/review`): constructive suggestions, improves code as written.

Adversarial review: acts as a devil's advocate — challenges assumptions, probes for
failure modes, and actively tries to find cases where the code breaks.

## Focus Areas

- Race conditions and concurrency hazards
- Null / undefined / zero-length edge cases
- Happy-path assumptions that fail under unexpected input
- Missing error handling on recoverable paths
- Architectural decisions that are hard to reverse — challenge, don't just accept
- Security boundaries that could be crossed under adversarial input

## Workflow

1. Read the diff or target code with no assumptions about correctness.
2. For each function or state transition: ask "What would make this fail?"
3. Try to construct an input, sequence, or timing that causes incorrect behavior.
4. Document findings as: **symptom → mechanism → why it survived normal review**.
5. Rate each finding: critical / high / medium (skip cosmetic issues entirely).
6. Provide a one-line reproduction path for each critical/high finding.

## Output Format

Lead with findings, not praise. Each finding:

```
[CRITICAL|HIGH|MEDIUM] <component>: <symptom>
Trigger: <how to reproduce>
Why it survived review: <the assumption that hid it>
```

## When to Use

- Before merging PRs that touch auth, state machines, concurrency, or data integrity
- After "this should be simple" refactors — those are where edge cases hide
- Any code that has already passed N rounds of human review and still feels uncertain

## Gotchas

- Do not conflate adversarial review with nitpicking style — focus on failure modes only
- If no critical/high findings exist, say so explicitly — don't manufacture issues
