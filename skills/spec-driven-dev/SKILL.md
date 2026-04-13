---
name: spec-driven-dev
description: |
  Spec-driven development workflow: write a structured spec document first, then
  use it as both AI agent guidance and post-implementation verification artifact.
  Use before any feature spanning >500 lines or multiple files, when requirement
  clarity is low, or when agent hallucination/drift is a risk.
origin: unified
---

# Spec-Driven Development

## Why

Vibe coding (freeform prompts) produces unreliable output past ~500 lines because
agents guess at unstated requirements. A formal spec defines explicit contracts
that the agent references throughout implementation, preventing hallucination drift
and enabling acceptance-criteria-based verification.

Proven by community adoption: GitHub Spec Kit (84K+ stars), Kiro's spec-first SDLC,
and arxiv 2602.00180 ("Spec-Driven Development: From Code to Contract in the Age of
AI Coding Assistants").

## Three Levels of Rigor

Choose the level appropriate to project scope:

| Level | Description | When to use |
|-------|-------------|-------------|
| **Spec-First** | Write spec to guide AI, may discard after delivery | Quick features, prototypes, CLAUDE.md-style context |
| **Spec-Anchored** | Spec lives alongside code and evolves with it | Team projects, multi-session features |
| **Spec-as-Source** | Humans edit only specs; generated code is DO-NOT-EDIT | Formal systems, high-reliability components |

## Workflow (Three Phases)

### Phase 1 — Requirements
Define **what** the system does, not how.

```md
## Requirements
### Goal
<one-sentence statement of what this feature accomplishes>

### Acceptance Criteria
- As a <role>, I can <action>, so that <value>
- As a <role>, when <condition>, the system <response>
- Performance: <measurable constraint, e.g. "query returns in <2s">
- Error cases: <explicit failure modes and expected behavior>

### Out of Scope
- <explicitly excluded behaviors>
```

### Phase 2 — Design
Translate requirements into **technical contracts**.

```md
## Design
### Data Model
<schemas, types, field names with types>

### API / Interface
<endpoint signatures, function signatures, event names>

### Sequence
<ordered steps or sequence diagram in prose>

### Constraints
<dependencies, environment assumptions, security requirements>
```

### Phase 3 — Tasks
Break design into **discrete, traceable implementation steps**.

```md
## Tasks
- [ ] 1. <task> — satisfies AC: <criterion ref>
- [ ] 2. <task> — satisfies AC: <criterion ref>
- [ ] 3. Add tests for <criterion ref>
- [ ] 4. Verify: run <test/command> confirms <expected output>
```

## Activation Triggers

Proactively propose spec creation when:
- Request references "feature", "new endpoint", "implement X", or "build Y"
- Task clearly spans multiple files or systems
- Requirements are stated ambiguously ("make it work", "add auth", "improve performance")
- User says "I'm not sure what I want yet"

## Verification Use

After implementation, the spec doubles as a checklist:
1. Read each acceptance criterion
2. Run the associated test/command from Phase 3 Tasks
3. Mark passing criteria; flag failing ones for iteration
4. If criteria were missed during implementation, note in spec for next session

## Key Distinction from Plan-Architecture

`plan-architecture` traces components and data flows for known requirements.
`spec-driven-dev` formalizes the requirements themselves before planning begins —
it answers "what should be built and why" so that planning answers "how."

Use both in sequence for large features: spec-driven-dev → plan-architecture.
