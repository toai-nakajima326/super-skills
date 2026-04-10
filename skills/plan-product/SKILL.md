---
name: plan-product
description: "Use when planning a product feature or initiative before jumping into implementation."
origin: unified
---

## Rules

- Clarify the user problem before proposing a solution. The problem statement drives everything else.
- Define success metrics upfront. If you cannot measure whether it worked, the plan is incomplete.
- Scope non-goals explicitly. Stating what you will not do prevents scope creep and misaligned expectations.
- Keep user stories grounded in observable behavior, not system internals.
- Acceptance criteria must be testable by someone who did not write them.

## Workflow

1. **Problem statement** -- Write a clear, one-paragraph description of the user problem being solved. Include who is affected, what they cannot do today, and why it matters.
2. **User stories** -- Define user stories in "As a [role], I want [capability], so that [benefit]" format. Cover the primary flow and the most important edge cases.
3. **Acceptance criteria** -- For each user story, list concrete, testable conditions that must be true for the story to be considered done.
4. **Scope boundary** -- Explicitly list non-goals and out-of-scope items. For each, briefly explain why it is excluded from this iteration.
5. **Implementation sketch** -- Outline the high-level technical approach: key components, data flow, and dependencies. This is a sketch, not a design doc -- just enough to confirm feasibility and identify risks.

## Gotchas

- Jumping to solutions before understanding the problem leads to building the wrong thing.
- Vague acceptance criteria ("it should be fast") cause arguments at review time. Use numbers.
- Omitting non-goals invites scope creep mid-sprint.
- An implementation sketch that requires a full design doc is a sign the feature is too large for one iteration.
