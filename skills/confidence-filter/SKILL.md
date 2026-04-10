---
name: confidence-filter
description: "Launch multiple parallel agents to independently assess the same target, then aggregate results and suppress findings below a confidence threshold. Reduces false positives in code review, security audit, and quality checks. Different from debate-consensus (which reaches a decision) — this filters noise from parallel reviewers."
origin: web-discovery
sources:
  - claude-code plugins/code-review pattern
  - https://github.com/hesreallyhim/awesome-claude-code
  - AgentSys parallel domain-specialist review (6 agents across dimensions)
---

## Rules

1. **Minimum 2 independent agents**: Confidence filtering requires at least 2 agents assessing independently. A single agent's confidence score is not sufficient.
2. **No cross-contamination before voting**: Agents must not see each other's findings before submitting their own assessment. Share findings only after all agents complete.
3. **Threshold must be declared upfront**: Set the confidence threshold before launching agents, not after seeing results.
4. **Suppress below threshold, don't delete**: Below-threshold findings are logged as "suppressed" with vote count — they're not discarded.
5. **Escalate near-threshold findings**: Findings that land within 10% of threshold are flagged for human review rather than auto-suppressed.

## When to Use

| Scenario | Why confidence-filter |
|----------|----------------------|
| Code review with multiple dimensions (security, performance, correctness) | Multiple specialists reduce blind spots; voting suppresses single-reviewer false positives |
| Security audit with parallel tools/agents | Independent analysis prevents confirmation bias |
| Large PR with many potential issues | Noise reduction focuses human attention on real issues |
| Test coverage analysis across modules | Parallel agents per module, aggregated threshold |

**Do NOT use for:**
- Architecture decisions → use `debate-consensus` (needs adversarial deliberation, not voting)
- Single-domain review where one expert is sufficient → use `review`
- Tasks where any single finding is actionable regardless of others → skip filtering

## Workflow

### Phase 1 — Define the Assessment
1. State what you're assessing (e.g., "PR #123 for security vulnerabilities")
2. Define review dimensions (e.g., security, performance, correctness, test coverage)
3. Set the confidence threshold: what % of agents must flag something for it to be reported?
   - **Strict (75%+)**: High-noise environments; only report what most agents agree on
   - **Standard (50%+)**: Default; majority-vote suppresses noise
   - **Sensitive (33%+)**: High-stakes review; report minority findings
4. Set the agent count (minimum 2, recommended 3–5 for standard confidence filtering)

### Phase 2 — Independent Assessment (parallel, no sharing)
1. Launch N agents in parallel — each with the same target but different review lenses (or same lens, independent context)
2. Each agent produces findings in this format:
   ```
   Finding: [description]
   Location: [file:line or component]
   Severity: critical | high | medium | low
   Confidence: 0.0–1.0 (how certain is THIS agent)
   Evidence: [specific code/pattern that triggered this]
   ```
3. Agents submit findings independently — no SendMessage between agents during assessment

### Phase 3 — Aggregation
1. Collect all findings from all agents
2. Normalize: group findings that refer to the same location/issue (fuzzy match on location + description)
3. For each finding group, compute:
   - **Vote count**: how many agents flagged this finding
   - **Vote ratio**: vote count / total agents
   - **Average confidence**: mean of per-agent confidence scores
   - **Composite score**: (vote ratio × 0.6) + (average confidence × 0.4)
4. Apply threshold: if composite score ≥ threshold → **REPORTED**; else → **SUPPRESSED**

### Phase 4 — Output
Report findings in two sections:

**Reported Findings** (above threshold):
```
[SEVERITY] [Location]
Issue: [description]
Votes: X/N agents | Composite: Y%
Evidence: [supporting code]
Recommended action: [fix/investigate/accept]
```

**Near-threshold Findings** (within 10% of threshold — escalate to human):
```
[SEVERITY] [Location]
Issue: [description]
Votes: X/N agents | Composite: Y% (threshold: Z%)
Note: Near-threshold — human review recommended
```

**Suppressed Findings** (logged, not reported):
```
Suppressed: X findings below threshold (Y% confidence threshold applied)
Available on request.
```

### Phase 5 — Threshold Calibration Log
After each run, log:
```
Confidence Filter Summary
- Target: [what was assessed]
- Agents: N | Threshold: X%
- Total findings (pre-filter): X
- Reported: X | Near-threshold (human): X | Suppressed: X
- Suppression rate: X% (target: <60%; if >80%, threshold may be too strict)
```

## Agent Dimension Templates

For code review, launch agents with these review lenses:

| Agent | Review Lens | Focus |
|-------|------------|-------|
| Security agent | Auth, injection, secret exposure, trust boundaries | Security vulnerabilities |
| Performance agent | N+1 queries, blocking operations, memory leaks | Runtime bottlenecks |
| Correctness agent | Logic errors, edge cases, off-by-one, null handling | Functional bugs |
| Coverage agent | Untested paths, missing assertions, test quality | Test adequacy |
| Architecture agent | Coupling, cohesion, pattern consistency, tech debt | Design quality |

Use 2–3 of these for typical PRs; all 5 for critical system changes.

## Integration

- **With `supervisor-worker`**: Supervisor launches confidence-filter agents as workers; aggregation happens at supervisor level
- **With `review`**: `review` is single-agent; `confidence-filter` is multi-agent parallel. Use confidence-filter when you want false-positive suppression.
- **With `report-format`**: Format the aggregated output using report-format schema
- **With `debate-consensus`**: Not typically combined — these solve different problems (noise filtering vs decision-making)

## Gotchas

- Confidence filtering is NOT a substitute for good agents. Garbage-in with voting still produces garbage-out; the suppression just hides it.
- Setting threshold too high (>80%) causes real issues to be suppressed. Start at 50% and adjust.
- Finding normalization (grouping same-location issues) is critical — without it, the same bug gets counted once per agent and always reports.
- Do not use confidence-filter for issues that are independently actionable: if agent 1 finds a SQL injection and agent 2 doesn't, that SQL injection should still be reported.
  - Solution: Treat critical/security findings as always-reported regardless of threshold.
