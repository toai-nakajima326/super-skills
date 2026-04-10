# Evolution Log

Auto-maintained by the `self-evolve` skill. Records all upstream syncs, web discoveries, and self-improvements.

---

## 2026-04-10 — upstream-sync

### Action: skipped
- **Target**: 8 skills (auto-router, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Diff shows upstream does NOT have these orchestration skills (they are local additions). Additionally, all upstream `.agents/skills/*/agents/openai.yaml` files have regressed `short_description` to literal `"|"` — a clear upstream bug. Syncing would remove our orchestration skills and corrupt agent YAML metadata.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-10 — web-discovery

### Action: created
- **Target**: `debate-consensus`
- **Source**: Beam AI "9 Best Agentic Workflow Patterns 2026", Vellum AI "Emerging Architectures", ByteByteGo "Top AI Agentic Workflow Patterns"
- **Reasoning**: Multi-agent adversarial deliberation pattern is genuinely novel vs existing skills. `supervisor-worker` is hierarchical delegation; `debate-consensus` is structured disagreement before a decision. Multiple reputable 2026 sources confirm this as an emerging best practice. Safe (no destructive actions, no telemetry). Fills gap for high-stakes architecture/tradeoff decisions.
- **Changes**: Created `skills/debate-consensus/SKILL.md`, added to `manifests/install-components.json`, added to `skills-orchestration` module in `manifests/install-modules.json`, added routing entry to `skills/auto-router/SKILL.md`. Validated (33 skills, 0 errors), deployed to `~/.claude/skills/` and `~/.codex/skills/`.
- **Risk assessment**: low

### Skipped patterns
- `self-validate-output`: Overlaps significantly with `verification-loop`. The auto-regenerate nuance is marginal.
- `exploit-confirm`: Requires explicit authorization scoping; too risky without user-defined sandbox constraints.
- `hook-enforcement`: More of a one-time project setup than a repeatable skill workflow. `update-config` skill covers adjacent ground.
- `session-scoped-auth`: Conceptual MCP governance pattern, not actionable as a SKILL.md workflow.

---

## 2026-04-11 — upstream-sync

### Action: skipped
- **Target**: 9 skills (auto-router, debate-consensus, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same as 2026-04-10 — upstream diff shows only deletions (631 lines removed, 0 added). Upstream does not have our orchestration skills; syncing would destroy them. The upstream YAML regression (`short_description: "|"`) persists. Skip remains protective.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-11 — web-discovery

**Search window**: 2026-04-10 → 2026-04-11
**Queries executed**: 6
**New sources checked**: 12 (full page fetches via WebFetch)
**Candidates found**: 8
**Adopted**: 0 | **Skipped**: 8 | **Flagged**: 0

### Action: skipped (all candidates)

**Sources searched:**
- "Claude Code skills new 2026" — [MindStudio](https://www.mindstudio.ai/blog/claude-code-5-workflow-patterns-explained), [Medium unicodeveloper](https://medium.com/@unicodeveloper/10-must-have-skills-for-claude-and-any-coding-agent-in-2026-b5451b013051)
- "agentic workflow patterns 2026" — [Vellum AI](https://www.vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns), [StackAI](https://www.stackai.com/blog/the-2026-guide-to-agentic-workflow-architectures)
- "AI agent orchestration patterns 2026" — [StartupHub.ai](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/multi-agent-orchestration-patterns), [Catalyst & Code](https://www.catalystandcode.com/blog/ai-agent-orchestration-frameworks)
- "MCP new servers April 2026" — [MCP Blog](https://blog.modelcontextprotocol.io/), [The New Stack](https://thenewstack.io/model-context-protocol-roadmap-2026/)
- "AI agent safety patterns 2026" — [QueryPie](https://www.querypie.com/features/documentation/white-paper/28/ai-agent-guardrails-governance-2026), [Authority Partners](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/)
- "github awesome claude code agent skills 2026" — [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code), [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)

**Skipped patterns:**
- `hierarchical-multi-agent`: Identical to `supervisor-worker` — "supervisor delegates to specialist workers." No new workflow steps.
- `decentralized-swarm`: Peer agents converging via rules/time limits. Covered by `debate-consensus` (structured adversarial deliberation before decisions). Swarm adds no actionable workflow difference.
- `sequential-pipeline-with-hard-checks`: "Each step measurable, testable, cost predictable." Fully covered by `quality-gate` + `phase-gate` combination.
- `sandbox-isolation-branch-per-agent`: Containerized parallel agents returning branches for review. Conceptually interesting; partially covered by `dmux-workflows` + worktree isolation. Not yet a proven repeatable SKILL.md pattern — more of a platform feature than a skill workflow.
- `autonomy-spectrum-selection`: Progressive human oversight (in-loop → on-loop → out-of-loop) based on task risk. Conceptually novel but not yet proven as a concrete, repeatable workflow in multiple sources. Worth monitoring.
- `dual-log-audit-trail`: Action log + rationale log with hash chain. Covered by `report-format` + `checkpoint` combined.
- `kill-switch-escalation`: Three-level graduated stops. Covered by `guard` + `careful` combined.
- `domain-specific-agent-team-generator`: Meta-agents that design other agent architectures. Speculative and unproven; no implementation details found.

**Note**: The 1-day freshness window (2026-04-10 → 2026-04-11) yielded limited truly new content from broad pattern searches. However, deep-fetching of specific GitHub repositories (awesome-claude-code, AgentSys, claude-code plugins) surfaced genuinely novel implementation-level patterns not covered by prior searches.

---

## 2026-04-11 — adoptions (web-discovery follow-up)

**Search window**: 2026-04-10 → 2026-04-11 (continued from web-discovery above)
**New sources deep-fetched**: 8 (GitHub repos via WebFetch)
**Candidates adopted**: 3 new skills + 1 skill update

### Action: created — `drift-detect`
- **Source**: AgentSys (avifenesh/agentsys), validated on 1,000+ repositories with 77% token reduction reported
- **Reasoning**: Tiered-certainty analysis (deterministic→LLM escalation) is genuinely novel vs `health-check` (binary pass/fail) and `verification-loop` (iterate until passing). The key insight — run grep/regex/AST first, escalate to LLM only for MEDIUM/LOW certainty findings — reduces cost significantly and is missing from all existing skills.
- **Changes**: Created `skills/drift-detect/SKILL.md` with 5-phase workflow, certainty tier definitions, deterministic rule templates, and token efficiency reporting.
- **Risk assessment**: low — deterministic-first, LLM only for advisory; no auto-actions

### Action: created — `model-selector`
- **Source**: AgentSys + multiple 2026 community sources on Plan-and-Execute with Model Tiering
- **Reasoning**: No current skill addresses explicit Claude model-tier assignment before launching agents. The Haiku/Sonnet/Opus decision matrix (mechanical→Haiku, coverage/review→Sonnet, architecture/planning→Opus) is proven and actionable via the Agent tool's `model` parameter. Can reduce costs by up to 90% vs Opus-for-everything.
- **Changes**: Created `skills/model-selector/SKILL.md` with decision matrix, task→model mappings table, and integration guidance.
- **Risk assessment**: low — guidance only, no auto-actions

### Action: created — `confidence-filter`
- **Source**: claude-code plugins/code-review pattern, AgentSys 6-agent parallel domain-specialist review
- **Reasoning**: Distinct from `debate-consensus` (which reaches a decision through adversarial deliberation) and `review` (single agent). `confidence-filter` is specifically for suppressing false positives from parallel reviewer agents via vote-threshold aggregation. Multiple sources confirm this pattern for high-noise review environments.
- **Changes**: Created `skills/confidence-filter/SKILL.md` with voting aggregation formula, threshold calibration guidance, dimension templates for code review, and escalation rules for critical findings.
- **Risk assessment**: low — aggregation and filtering only; never suppresses critical findings below threshold unconditionally

### Action: updated — `mcp-server-patterns`
- **Source**: modelcontextprotocol.io specification 2025-11-25
- **Reasoning**: Three new primitives (Elicitation, Roots, Sampling) added to official MCP spec are not documented in the existing skill. The tool-annotation trust boundary clarification ("untrusted unless from trusted server") is also new and security-relevant.
- **Changes**: Added Elicitation, Roots, Sampling primitive descriptions with safety notes; added trust boundary update for tool annotations.
- **Risk assessment**: low — documentation only

### Updated
- `auto-router`: Added routing entries for `drift-detect`, `model-selector`, `confidence-filter`
- `manifests/install-components.json`: Added 3 new skill entries
- `manifests/install-modules.json`: Added 3 new skills to `skills-orchestration` module

### Validation & Deploy
- `node scripts/validate-skills.js`: 36 skills, 0 errors, 0 warnings
- Deployed to `~/.claude/skills/` (36 skills) and `~/.codex/skills/` (36 skills)

### Skipped patterns from second-agent batch
- `autonomous-loop` (Ralph Wiggum): Novel bash-restart-from-known-state pattern. Promising but single source (ClaytonFarr/ralph-playbook) with limited independent validation. Monitor for future runs.
- `team-architect` (revfactory/harness): Meta-skill for auto-generating agent team structures. Genuinely novel but complex and speculative — risk of encouraging over-engineering. Revisit when more real-world adoption evidence exists.
- `adaptive-guard` (hookify): Dynamically generates behavioral rules from AI misbehavior. Interesting but single source; rule-generation without human review could undermine predictable safety behavior. Skip.
- `codebase-context` (Claudekit): Auto-inject architecture map at session start. Covered adequately by `session-handoff`. Not a standalone skill pattern.
- `autonomy-spectrum-selection`: Appears in multiple sources but lacks concrete, repeatable workflow steps. Watch for future runs.
