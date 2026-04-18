# Spec — Canonical Sub-Agent Prompt Preamble

**Spec ID**: `2026-04-18-subagent-prompt-template`
**Author**: main orchestrator session (per user directive 2026-04-18)
**Status**: Draft → Implementation (same day)
**Related**:
- `~/.claude/CLAUDE.md` §"AIOS-Connected Work — infinite-skills is MANDATORY per-exchange AND per-action"
- `docs/policy/aios-infinite-skills-mandate.md` (OS-level invariant, v1.0, 2026-04-18)
- `docs/analysis/2026-04-18-subagent-preamble-audit.md` (retrospective coverage audit)

---

## 1. Problem statement

The infinite-skills mandate (per-exchange consultation, per-matched-skill
application, sub-agent inheritance) is enforced at two layers today:

1. **Main-session**: via `UserPromptSubmit` hook that routes skills, plus
   the `PreToolUse` AIOS hard-gate (commit `e0bafb5`).
2. **Sub-agents**: via the main orchestrator hand-writing the rule into
   every delegated prompt.

Layer 2 is **inconsistent**. Observed today across 22 dispatched sub-agents
(Phase 1 = 7, Phase 2 = 15) there is no single canonical string that every
agent received — prompts were composed ad-hoc from memory. This makes:

- **Coverage** unprovable (the ephemeral prompt text is not re-readable
  from the task-notification JSONL transcripts after delivery).
- **Rule drift** possible (subtle paraphrases erode "APPLY, not notice").
- **Nested sub-agents** silent (if a sub-agent dispatches its own sub-agent
  without the preamble, discipline stops one level down).

This spec defines a single authoritative preamble string + a helper to
concat it into every delegated prompt. It is a **VIEW** of CLAUDE.md and
the policy doc — not a new rule. No source of truth is moved.

## 2. Acceptance criteria

- **AC1** — A canonical preamble exists at `docs/templates/subagent-preamble.md`,
  is **≤15 lines of actual preamble text** (the rule itself), and is
  self-contained (a sub-agent who reads only the preamble has enough to
  comply without opening CLAUDE.md). The how-to-use guide above the
  preamble block is NOT counted toward the 15-line budget.
- **AC2** — The preamble explicitly states:
  - Infinite-skills consultation is **MANDATORY per-exchange AND per-action**
    (re-consult each turn; re-consult before each write).
  - Matched skills must be **APPLIED**, not merely noticed or acknowledged.
    "Applied" means the headline workflow step executes (write spec,
    gather evidence, run debate rounds, warn + confirm).
  - The preamble **propagates**: any sub-agent this agent spawns must
    receive the same preamble.
- **AC3** — A how-to-use guide sits at the top of the template doc
  explaining: when to include the preamble, where to include it
  (top of the delegated prompt before task description), which
  documents to link to, how to concat via shell.
- **AC4** — A helper shell snippet (`cat` + here-string concat) shows
  how to include the preamble in a delegated prompt programmatically.
  Must be usable from any directory (absolute path).
- **AC5** — The template does NOT redefine CLAUDE.md or the policy doc.
  It quotes or references them. Editing the preamble to contradict
  CLAUDE.md / policy is explicitly listed as forbidden in the how-to.

## 3. Non-goals

- Runtime enforcement (a hook that rejects sub-agent prompts without the
  preamble). That is a later phase — first we need the canonical text
  to enforce.
- Changing the AIOS hard-gate hook or vcontext-server.js. The server is
  fragile tonight (see Phase 2 review §5.2) — this spec is text-only.
- Retrofitting today's already-completed sub-agent prompts. Covered by
  the retrospective audit (Phase 3) as estimation-only.

## 4. Dependencies

- `~/.claude/CLAUDE.md` (authoritative, must not be contradicted)
- `docs/policy/aios-infinite-skills-mandate.md` (authoritative, must not
  be contradicted)
- `docs/analysis/2026-04-18-subagent-preamble-audit.md` (Phase 3 output;
  informs whether coverage improvements should be bundled with the
  template ship)

## 5. Risk / mitigation

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Preamble drifts from CLAUDE.md over time | Med | AC5 + versioned header + each revision requires CLAUDE.md cross-check noted in commit msg |
| Agents quote a stale cached copy | Low | Helper concat always reads the live file — no "copy the text into your prompt" anti-pattern |
| Preamble > 15 lines grows by drift | Med | AC1 is a hard limit checked in the Phase 3 audit |
| Nested sub-agents silently drop the rule | Med | Preamble itself demands propagation (AC2 ③) — enforcement is social until runtime hook lands |

## 6. Out-of-scope (explicit)

- Hook at runtime enforcement
- Telemetry / metric collection on preamble coverage
- Codex / Atlas / non-Claude AI clients (policy doc §Planned enforcement
  owns that track)

## 7. Commit / push policy

- Commit with `CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1` (matches the
  AIOS hard-gate contract; skills-used entry already recorded
  via `spec-driven-dev` + `quality-gate` + `investigate`).
- Do NOT push tonight — user has 6 existing unpushed commits already;
  this lands on top and will be pushed in morning handoff.
- Commit scope: this spec + the template + the audit + the one-line
  CLAUDE.md update. Single commit.

## 8. Success metric

At the next phase review (2026-04-19):
- The template file exists and is readable.
- The audit identifies a baseline coverage % for today's dispatches.
- The CLAUDE.md one-line insertion is on `main`.
- A follow-up task is filed for runtime enforcement (out of scope here).
