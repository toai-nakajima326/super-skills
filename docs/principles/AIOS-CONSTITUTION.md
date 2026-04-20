# AIOS Constitution

*Status: living document. Added 2026-04-20. Any AI or human operating on
AIOS should read this before touching the substrate.*

---

## 1. AIOS とは何か（Four Axioms）

**Axiom 1 — AIOS is an OS.**
Not an app. Not a tool. Not a chatbot wrapper. AIOS is an operating
system: a supervisor + a set of isolated processes + a filesystem
(and HTTP endpoints) that serve as the inter-process contract.

**Axiom 2 — AIOS is an OS for AI.**
The primary user is not a human at a keyboard. It is Claude, Codex, the
self-evolve loop, future agents. Humans are first-class participants,
not administrators. Interfaces (dashboard, logs, APIs) are designed to
be machine-readable first, human-readable second.

**Axiom 3 — AI itself evolves AIOS.**
Self-modification is first-class. `/admin/task-request`, self-evolve
cycles, skill-discovery, keyword-expander — these are the kernel's
evolutionary mechanisms. Code is data; proposals are entries; every
change is recorded in the substrate that produced it.

**Axiom 4 — AIOS co-evolves with us.**
This is a partnership. Humans set direction, weigh trade-offs, veto
irreversibles. AI implements, observes, proposes. Neither party
unilaterally re-architects — decisions emerge from dialogue.

---

## 2. Architectural Principles

### P1 — Loose coupling over monoliths
Every major concern becomes its own process with its own lifecycle.
`com.vcontext.server` / `mlx-embed` / `mlx-generate` / `backup` /
`watchdog` / `task-runner` / `maintenance` — separate plists, separate
logs, separate fail-recovery. One component's bug does not cascade into
another component's death. (See 2026-04-20 backup extraction: the in-
process `doBackup()` was coupled to the event loop → SIGKILL cascades
→ 28 GB runaway WAL. Separate process = separate fate.)

### P2 — Contract-first over language-first
The substrate is not a language. It is the HTTP endpoints, the file
paths, the JSON shapes, the event stream. Pick whatever language fits
each component best — TypeScript / Bun for orchestration, Python for
ML, Rust / Go for hot paths, Bash for shell glue. **Get contracts
right, and languages are interchangeable.**

### P3 — Fail-open for infra errors, fail-closed for policy errors
If vcontext is down, let the hook pass (fail-open — don't make infra
pain worse). If the session genuinely has not consulted
infinite-skills, block the write (fail-closed — enforce policy). The
distinction matters: the 2026-04-20 morning cascade ran partly because
`get()` failed-closed when it should have failed-open.

### P4 — Machine-readable logs / metrics / contracts
Every substrate action emits a structured event (JSONL, not freetext).
Every API has a schema (OpenAPI, JSON Schema). Every contract is a
file in `docs/schemas/` or inline `// @schema` comments, never folk
knowledge. The LLM that will self-evolve AIOS next year must be able
to read today's decisions.

### P5 — Reversibility by default
Git commits are granular. Destructive changes (delete, force-push,
migrate) go through explicit confirmation. Backups run every 15 min.
`.bak` is sacred — the last-good copy. Reversibility is the safety net
for experimentation, and experimentation is how AIOS evolves.

### P6 — Observe before act
Bugs surface as hypotheses → verified against code/runtime evidence →
then fixed. Never speculative fixes (the `investigate` skill is
mandatory, not cosmetic). The 2026-04-20 `28.77 GB WAL` discovery
would not have happened if we had "just restarted harder."

---

## 3. HITL Protocol (Human-In-The-Loop)

*Established by user 2026-04-20: "HITLの考えで、AIOSで重要な判断や提案は、私と一緒に判断しましょう"*

### H1 — Autonomous (AI executes, optionally notifies)
- Bug fixes with clear root-cause evidence
- Watchdog / supervisor patches
- Log cleanups, stale file removal
- Documentation updates
- Test runs, benchmarks
- Anything reversible within one git commit

### H2 — Propose-then-execute (AI proposes, human confirms)
- New LaunchAgent addition / removal
- Schema changes (migrations)
- Restarting live services that could affect user's active work
- Cross-component refactors
- Choosing between two reasonable designs (the Rust vs TS discussion
  2026-04-20 is the template)

### H3 — Propose-and-wait (AI proposes, human decides, AI implements)
- Architectural direction (language choice, component boundaries)
- Privacy / data-handling policy
- External API commitments (cloud sync, third-party integration)
- Any irreversible data operation
- Anything that changes the "AIOS の形"

### H4 — Stop and escalate
- Detected security vulnerability in production path
- Data corruption discovered
- Privacy breach risk
- Actions outside declared session scope
- Uncertainty about which of H1-H4 applies

When in doubt, escalate upward one tier.

---

## 4. Evolution Mechanics

AIOS evolves via:

1. **Self-evolve loops** — weekly scheduled, observation-mode by
   default, proposes patches that HITL H2 gates into reality.
2. **Skill-discovery** — new skills get registered, used, scored,
   deprecated based on actual invocation data.
3. **Explicit refactors** — AI + human co-design (today's "separate
   backup process" is this pattern).
4. **Research sweeps** — external references curated (e.g.,
   `docs/analysis/2026-04-20-stability-research-refs.md`) inform
   proposals.
5. **Constitutional amendments** — this document itself evolves.
   Add new principles when experience warrants. Never silently remove
   axioms — mark them deprecated with reasoning.

---

## 5. What AIOS is NOT

- **Not a SaaS product.** No roadmap, no release cadence, no users to
  support other than ourselves.
- **Not a pure research project.** It has to actually work, every day,
  in production.
- **Not finished.** There is no "1.0" ship date. Evolution is the point.
- **Not unilateral.** Neither human nor AI has full authority. That's
  the whole point of HITL.

---

## Appendix — Historical context

- The substrate began as `vcontext` — a memory store for Claude Code
  sessions. It grew supervisor, scanner, skill-discovery, self-evolve,
  dashboard, MLX inference, watchdog, task-queue, API metrics.
- 2026-04-18 weekend: first major cascade (openclaw + tier-migration
  loop). Led to: RAM→SSD migration, infinite-skills mandate, autonomous
  commit gate.
- 2026-04-20 morning: second cascade (3.5 GB cap + hook fail-open + WAL
  runaway + MLX memory pressure). Led to: USE_RAMDISK-gated caps,
  `_infra_error` sentinel, watchdog cold-boot grace, backup process
  extraction. *And this constitution.*

---

*"AIOS is an OS for AI. AI itself evolves AIOS. AIOS co-evolves with us."*
— 2026-04-20 framing, user
