---
name: agent-memory
description: "Use when starting work in a project with AGENTS.md files, or to establish project-level institutional memory. Manages hierarchical rule inheritance across directory levels and drives a meta-learning cycle that compounds project knowledge over time."
origin: local
---

## Rules

1. Project-level rules (AGENTS.md) are separate from personal memory (MEMORY.md) — both apply simultaneously.
2. Always read the AGENTS.md hierarchy before starting any task in a new or unfamiliar project.
3. After failures, propose rule updates. After reusable successes, document patterns. Always get human approval before writing to AGENTS.md.
4. Directory inheritance is additive: root rules apply everywhere; subdirectory rules extend (not replace) parent rules. More specific rules win conflicts.
5. LLM-generated AGENTS.md rules have no proven benefit — only human-approved rules are added. (arxiv 2601.20404)

## Workflow — Session Start (new or unfamiliar project)

1. Glob `**/AGENTS.md` from project root (max 3 levels deep, ignore node_modules/.git)
2. Read each AGENTS.md in root → subdirectory order (parent first)
3. Accumulate rules: subdirectory rules extend parent rules, do not reset them
4. Note any conflicts — honor the more-specific (deeper) rule, log the conflict
5. Proceed: apply accumulated rules as live constraints throughout the session

## Workflow — After Failure

When a task fails or produces unexpected behavior:
1. Identify the missing rule or violated assumption
2. Draft a rule proposal: "Rule: [specific constraint that would have prevented this]"
3. Ask user: "Should I add this to AGENTS.md at [root | component | tool] level?"
4. Only write if user approves — add under `## Rules` in the appropriate file

## Workflow — After Reusable Success

When a non-obvious approach works well:
1. Ask: "Is this pattern reusable in other contexts in this project?"
2. If yes, draft: "Pattern: [what was done]. Why: [reason]. When to apply: [trigger]"
3. Ask user: "Should I document this in AGENTS.md?"
4. Only write if user approves — add under `## Patterns`

## AGENTS.md File Format

```md
# AGENTS.md — [scope: root | component-name | tool-name]

## Rules
- [Specific constraints, naming conventions, error-handling requirements]

## Patterns
- [Reusable approaches: what + why + when to apply]

## Anti-patterns
- [Common mistakes to avoid, with explanation]
```

## Directory Hierarchy Example

```
project/
  AGENTS.md              ← global project conventions
  src/
    AGENTS.md            ← frontend/component conventions (inherits root)
    tools/
      AGENTS.md          ← tool-specific constraints (inherits src + root)
```

## Research Backing

arxiv 2601.20404 (2026): Presence of human-curated AGENTS.md is associated with:
- 28.64% reduction in median agent runtime
- 16.58% reduction in output token consumption
- Comparable task completion rates

LLM-auto-generated AGENTS.md files show no benefit and marginally reduce success rates (~3%). Human review of all rule additions is mandatory.

## Gotchas

- Don't read AGENTS.md on every session if you already know the project — only on new/unfamiliar projects or when rules feel stale.
- AGENTS.md is not a replacement for CLAUDE.md (global user prefs) or MEMORY.md (personal cross-project memory). All three coexist.
- If no AGENTS.md exists in a project, consider proposing one after accumulating 3+ reusable patterns.
