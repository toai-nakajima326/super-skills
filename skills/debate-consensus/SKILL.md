---
name: debate-consensus
description: "Use for high-stakes decisions (architecture choices, risk assessments, spec ambiguities) requiring adversarial multi-agent deliberation before committing to a path. Structurally requires disagreement before consensus is accepted."
origin: web-discovery
---

## Rules

1. **Disagreement is required**: At least two agents must take opposing or differentiated stances before consensus is valid. A unanimous first round triggers a devil's advocate pass.
2. **Evidence-backed debate**: Each stance must cite specific tradeoffs, constraints, or risks — no unsubstantiated opinions.
3. **Dissent is preserved**: The final output includes losing arguments, not just the winner. Rationale for rejection is documented.
4. **No premature convergence**: Agents may not agree simply to finish faster. Main enforces at least one full debate round.
5. **Scope-limited**: Use only for decisions, not implementation. Once consensus is reached, delegate implementation to `supervisor-worker`.

## When to Trigger

| Signal | Example |
|--------|---------|
| Architecture fork: two valid paths | "Should we use event sourcing or CQRS here?" |
| Risk assessment disagreement | "Is this migration safe to run in production?" |
| Spec ambiguity with real consequences | "Which interpretation of this requirement is correct?" |
| High-stakes trade-off | "Do we prioritize consistency or availability?" |
| Post-mortem root cause dispute | "Was this caused by the deployment or the config change?" |

## Workflow

### Phase 1 — Frame the Decision
1. Define the decision as a clear binary or multi-option question
2. State the acceptance criteria: what does "correct" look like?
3. Identify the constraints (time, reversibility, cost, risk tolerance)
4. Set agent roles: Proponent A, Proponent B (optional: Devil's Advocate C)

### Phase 2 — Independent Stances
1. Launch agents in parallel with the same framing — no cross-contamination before stance formation
2. Each agent independently:
   - States their recommended option
   - Lists top 3 supporting arguments with evidence
   - Identifies the weakest point in their own argument
3. Main collects stances before sharing them between agents

### Phase 3 — Adversarial Debate
1. Share all stances with all agents simultaneously
2. Each agent must:
   - Challenge the strongest argument from opponents (not just the weakest)
   - Concede any valid points from opponents
   - Refine or hold their stance based on new arguments
3. Run minimum 1 debate round; maximum 3 rounds (stop when positions stabilize)

### Phase 4 — Consensus or Escalation
1. If agents converge: document the winning option + dissenting arguments
2. If agents remain split after 3 rounds: escalate to user with full debate transcript
3. Never force consensus — an unresolved split is a valid output

### Phase 5 — Decision Record
Produce a structured decision record:
```md
## Decision: [question]
**Date**: YYYY-MM-DD
**Decision**: [chosen option]
**Confidence**: High / Medium / Low (split)

### Arguments For
- [key argument 1]
- [key argument 2]

### Arguments Against (considered and rejected)
- [counterargument 1] — Rejected because: [reason]
- [counterargument 2] — Rejected because: [reason]

### Dissenting View (if applicable)
[Full losing argument preserved here]

### Constraints That Drove the Decision
- [constraint 1]
```

## Integration

- **Before**: Use `plan-architecture` or `plan-product` to frame the decision space
- **After**: Hand winning option to `supervisor-worker` for implementation
- **During**: Use `report-format` for structured agent reporting

## Gotchas

- Do not use for simple decisions with obvious answers — this is for genuinely contested choices.
- Agents will tend to converge too early. Enforce at least one full adversarial round.
- "Majority vote" is not consensus — a 2-1 split with strong dissent should be escalated, not resolved by voting.
- The decision record is a deliverable, not optional. Skip it and the skill wasn't applied.
