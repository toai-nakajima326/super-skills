---
name: drift-detect
description: "Tiered-certainty drift detection: run deterministic tools (regex/AST/grep) first, escalate to LLM only for MEDIUM/LOW certainty findings. Reduces token usage by ~77% vs naive LLM-first analysis. Use when checking for code drift, regressions, stale patterns, or spec deviations."
origin: web-discovery
sources:
  - https://github.com/avifenesh/agentsys
  - AgentSys validation across 1,000+ repositories (77% token reduction reported)
---

## Rules

1. **Deterministic first**: Always run regex/grep/AST/static analysis before invoking an LLM. LLM is only called for findings that deterministic tools cannot classify with HIGH certainty.
2. **Certainty tiers are non-negotiable**: Every finding must be assigned HIGH / MEDIUM / LOW. Never skip classification.
3. **HIGH findings auto-fix or auto-flag**: No LLM needed. Action is deterministic.
4. **MEDIUM findings get LLM context window**: Provide surrounding code + spec context to LLM for judgment.
5. **LOW findings escalate to human**: LLM may analyze, but human makes final decision.
6. **Token budget enforcement**: Log how many findings were handled at each tier. If >50% reach LLM, the deterministic ruleset is under-specified — improve it.

## Certainty Tier Definitions

| Tier | Definition | Action | LLM? |
|------|-----------|--------|-------|
| HIGH | Regex/AST match is unambiguous. Pattern is always correct or always wrong. | Auto-fix or auto-flag with no LLM call | No |
| MEDIUM | Deterministic tool detected anomaly but context is needed (edge case, intentional override possible) | Provide surrounding context to LLM for judgment | Yes |
| LOW | Deterministic tool flagged something uncertain, or finding is in conflict with multiple rules | LLM analyzes; human makes final call | Yes (advisory) |

## Workflow

### Phase 1 — Define Drift Criteria (before analysis)
1. List what "drift" means in this context (e.g., stale API calls, deprecated patterns, spec mismatches, missing tests)
2. For each criterion, write a deterministic rule: regex pattern, grep query, AST selector, or static analysis check
3. Assign each rule a default certainty tier (HIGH if rule is binary, MEDIUM if context-dependent)
4. Document the ruleset in a checklist before running

### Phase 2 — Deterministic Scan (HIGH certainty pass)
1. Run all deterministic rules across the codebase
2. For each match: classify as HIGH certainty if rule is unambiguous
3. Apply HIGH-certainty actions immediately (auto-fix or auto-flag)
4. Log: "HIGH certainty findings: X (auto-resolved: Y, flagged: Z)"

### Phase 3 — LLM Escalation (MEDIUM certainty pass)
1. For each MEDIUM finding: collect surrounding code (±20 lines), relevant spec/docs, and the flagging rule
2. Pass context bundle to LLM with: "Is this an intentional pattern or drift? Explain."
3. LLM outputs: `DRIFT` / `INTENTIONAL` / `UNCLEAR` with reasoning
4. `DRIFT` → add to fix list; `INTENTIONAL` → add exemption comment; `UNCLEAR` → downgrade to LOW
5. Log: "MEDIUM certainty findings: X (drift: Y, intentional: Z, escalated to LOW: W)"

### Phase 4 — Human Escalation (LOW certainty pass)
1. Compile all LOW findings with LLM analysis attached
2. Present as a structured review list with: finding, location, LLM judgment, recommended action
3. Human decides: fix / exempt / investigate further
4. Log: "LOW certainty findings: X (sent to human: X)"

### Phase 5 — Token Efficiency Report
At the end, output:
```
Drift Detection Summary
- Total findings: X
- HIGH (no LLM): X  →  Y% of total
- MEDIUM (LLM): X   →  Y% of total
- LOW (human): X    →  Y% of total
- LLM calls used: X (target: <50% of total findings)
- Drift confirmed: X | Intentional overrides: X | Human-pending: X
```

## Common Deterministic Rules

Use these as starting templates:

```bash
# Stale TODO/FIXME markers
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.ts" .

# Console.log left in production code
grep -rn "console\.log" --include="*.ts" src/

# Hardcoded URLs (not env vars)
grep -rn "https://[a-z0-9.-]*\.(com|io|dev)" --include="*.ts" src/ | grep -v "test\|spec\|mock"

# Deprecated API patterns (customize per project)
grep -rn "\.then(\|\.catch(" --include="*.ts" src/  # prefer async/await

# Missing error handling
grep -rn "await " --include="*.ts" src/ | grep -v "try\|catch\|\.catch"
```

## Integration

- **Before**: Use `health-check` for overall build/test status; `drift-detect` is for pattern-level drift
- **After**: Feed confirmed drift into `verification-loop` for iterative fixing
- **With**: `report-format` for structured output; `supervisor-worker` if fixing requires multiple agents

## Gotchas

- Do not run LLM on ALL findings first and then classify. That defeats the purpose (token savings come from deterministic-first ordering).
- HIGH certainty rules must be tested: if they produce false positives, they need to be MEDIUM.
- The 77% token reduction is achievable only when the deterministic ruleset is well-specified. Invest time in Phase 1.
- "Context-dependent" is not the same as "uncertain." If the rule is correct in 95%+ of cases, it's HIGH.
