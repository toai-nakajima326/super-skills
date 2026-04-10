---
name: plan-architecture
description: "Use when designing system architecture or making structural decisions before writing code."
origin: unified
---

## Rules

- Diagram before code. A visual representation of components and their relationships must exist before implementation begins.
- Identify failure modes. For every component and integration point, ask "what happens when this fails?"
- Consider operational cost. Architecture that is elegant in theory but expensive or painful to operate is a bad architecture.
- Make trade-offs explicit. Every decision favors some qualities over others -- name them.
- Defer decisions that can be deferred. Commit only to what must be decided now.

## Workflow

1. **Context mapping** -- Document the current system landscape: existing components, external dependencies, data flows, and constraints. Identify what is changing and why.
2. **Component identification** -- Break the solution into distinct components with clear responsibilities. Name each component and state its single purpose.
3. **Interface contracts** -- Define the API or communication protocol between components. Specify inputs, outputs, error cases, and versioning strategy.
4. **Failure mode analysis** -- For each component and integration point, enumerate what can go wrong: network partitions, data corruption, resource exhaustion, dependency outages. Document the mitigation for each.
5. **Decision record** -- Write an Architecture Decision Record (ADR) capturing the context, decision, alternatives considered, trade-offs, and consequences. This becomes the permanent record of why this architecture was chosen.

## Gotchas

- Over-engineering for hypothetical scale wastes time. Design for current needs with clear extension points.
- Missing failure modes in distributed systems is the norm, not the exception. Be thorough.
- Architecture diagrams that are never updated become misleading artifacts. Plan for how the diagram stays current.
- Ignoring operational concerns (deployment, monitoring, on-call burden) produces architectures that look good on a whiteboard but hurt in production.
