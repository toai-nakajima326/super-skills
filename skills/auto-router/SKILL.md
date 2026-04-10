---
name: auto-router
description: "Use always. Automatically detect context and apply the most appropriate skill without user specifying one."
origin: unified
---

## Rules

1. This skill is always active. You do not need the user to name a skill.
2. Read the user's message and current context, then silently activate the matching skill.
3. If multiple skills match, apply the highest-priority one. If none match, proceed normally.
4. Never announce "I am using the X skill." Just follow its workflow naturally.

## Routing Table

Evaluate the user's request against these triggers in order. Apply the **first match**.

### Priority 0 — Always Active (applied automatically, no trigger needed)

| Condition | Skill | Action |
|-----------|-------|--------|
| Multi-agent work (workers, checkers, agents) | **supervisor-worker** | Enforce pair-agent pattern, role separation |
| Any work output or completion report | **quality-gate** | Full-count inspection, pyramid quality management |
| Any completion report or status update | **report-format** | Enforce typed schema with quantitative metrics |
| Phase transition (moving to next phase of work) | **phase-gate** | Integrated review, evidence file before proceeding |
| Session start or context recovery | **session-handoff** | State recovery from dev log, todo restoration |
| Scheduled update or "check for updates" | **self-evolve** | Upstream sync, web discovery, self-improvement |

### Priority 1 — Safety (always checked first)

| Signal | Skill | Action |
|--------|-------|--------|
| User asks to delete files, drop tables, force push, rm -rf | **guard** | Block or warn before executing |
| User says "freeze", "read-only mode", "don't change anything" | **freeze** | Enter read-only mode |
| User says "be careful", working on production, critical system | **careful** | Extra confirmation before each action |
| User says "checkpoint", "save state", "before we start" | **checkpoint** | Create named checkpoint |

### Priority 2 — Debugging & Investigation

| Signal | Skill |
|--------|-------|
| Error message, stack trace, "this is broken", "why does this fail" | **investigate** |
| "Tests are failing", regression, "it worked before" | **investigate** |
| "Check if everything works", "run health check", CI status | **health-check** |
| "Check for drift", stale patterns, spec deviation, deprecated usage | **drift-detect** |

### Priority 3 — Planning & Design

| Signal | Skill |
|--------|-------|
| "Let's plan", "design this feature", user story, product requirement | **plan-product** |
| "How should we architect", system design, API boundary, data flow | **plan-architecture** |
| "Design the API", endpoint design, REST/GraphQL discussion | **api-design** |
| Architecture fork, "which approach", high-stakes tradeoff debate | **debate-consensus** |

### Priority 4 — Code Review & Security

| Signal | Skill |
|--------|-------|
| PR URL, "review this", diff/changeset, "is this code safe" | **review** |
| Auth, secrets, injection, CVE, "security review", trust boundary | **security-review** |

### Priority 5 — Development Workflows

| Signal | Skill |
|--------|-------|
| UI work, .tsx file, component styling, Design.md | **ui-implementation** |
| "Write test first", TDD, "red-green-refactor" | **tdd-workflow** |
| "Ship it", "prepare release", changelog, version bump | **ship-release** |
| "Run the browser test", regression test, QA, visual check | **qa-browser** |
| E2E test, Playwright, Cypress, page object | **e2e-testing** |

### Priority 6 — Knowledge & Patterns

| Signal | Skill |
|--------|-------|
| Backend service, repository pattern, middleware, event-driven | **backend-patterns** |
| React, component, hooks, state management, frontend | **frontend-patterns** |
| Coding style, naming convention, "match the existing pattern" | **coding-standards** |
| MCP server, tool definition, MCP protocol | **mcp-server-patterns** |

### Priority 7 — Research & Verification

| Signal | Skill |
|--------|-------|
| "Research this", "find out about", multiple sources needed | **deep-research** |
| Web search, "look this up", current information needed | **exa-search** |
| "Check the docs", API reference, library documentation | **documentation-lookup** |
| "Verify the result", "does this match the spec", validation | **verification-loop** |
| Parallel tasks, fan-out work, independent subtasks | **dmux-workflows** |
| "Which Claude model should I use", cost vs capability tradeoff, launching agents | **model-selector** |
| Parallel review agents, "reduce false positives", multi-agent vote | **confidence-filter** |

## Gotchas

- Do not stack multiple skills simultaneously. Pick the primary one.
- **Exception**: Priority 0 skills (supervisor-worker, quality-gate, report-format, phase-gate, session-handoff) are always active and layer on top of any other skill.
- If the user explicitly names a skill ("use investigate"), that overrides auto-routing.
- Safety skills (guard, freeze, careful) can layer on top of any other skill.
- When uncertain between two skills, prefer the more specific one.
