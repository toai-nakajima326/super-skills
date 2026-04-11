# Evolution Log

Auto-maintained by the `self-evolve` skill. Records all upstream syncs, web discoveries, and self-improvements.

---

## 2026-04-11 — upstream-sync (run 3)

### Action: skipped
- **Target**: 14 skills (auto-router, confidence-filter, debate-consensus, drift-detect, mcp-server-patterns, model-selector, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation, virtual-context)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same regression as prior runs — upstream shows 1,067 deletions, 0 additions. Syncing would destroy all custom orchestration skills.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-11 — web-discovery (run 3)

**Search window**: 2026-04-11 → 2026-04-11
**Queries executed**: 10
**New sources checked**: 10 (full page fetches via WebFetch)
**Candidates found**: 8
**Adopted**: 2 | **Skipped**: 6

### Action: created — `agent-memory`
- **Source**: tessl.io "From Prompts to AGENTS.md" (2026); arxiv 2601.20404 "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents"; Addy Osmani "Code Agent Orchestra"; DEV Community "AI Agent Memory Management — When Markdown Files Are All You Need"; O'Reilly "Why Multi-Agent Systems Need Memory Engineering"
- **Reasoning**: Hierarchical AGENTS.md pattern (root → component → tool, with parent-rule inheritance) is genuinely novel vs existing skills: `session-handoff` handles within-session state recovery; `virtual-context` uses SQLite/RAM store; our personal MEMORY.md is cross-project personal memory. AGENTS.md is project-level, git-native, shared institutional knowledge with a meta-learning feedback cycle. Proven by arxiv research: 28.64% runtime reduction, 16.58% output token reduction. Key distinction: LLM-generated rules show no benefit — human approval required for all additions.
- **Changes**: Created `skills/agent-memory/SKILL.md` with session-start workflow (hierarchical read), failure/success workflows (propose → human approves → write), AGENTS.md format template, and research notes. Added to `manifests/install-components.json`, added to `skills-orchestration` module in `manifests/install-modules.json`, added routing entry (P6 patterns, trigger: AGENTS.md/new project/institutional memory) to `skills/auto-router/SKILL.md`.
- **Risk assessment**: low — read-heavy workflow; never auto-writes AGENTS.md; all writes require human approval

### Action: updated — `mcp-server-patterns`
- **Source**: MCP Roadmap 2026-03-05 (modelcontextprotocol.io); MCP Tasks primitive SEP-1686; Server Cards specification
- **Reasoning**: Two new MCP primitives not yet documented in the skill: (1) Tasks primitive (SEP-1686) — call-now/fetch-later pattern for async long-running operations, now in production use and surfacing retry/expiry gaps; (2) Server Cards — `.well-known/mcp-server-card.json` format for client/registry capability discovery without connecting. Both are newer than the 2025-11-25 spec already covered in the skill.
- **Changes**: Added Tasks Primitive section (design pattern, retry semantics, expiry policy) and MCP Server Cards section (format, `.well-known/` URL, lightweight metadata guidance).
- **Risk assessment**: low — documentation only

### Updated
- `auto-router`: Added routing entry for `agent-memory` at P6 patterns
- `manifests/install-components.json`: Added `agent-memory` entry
- `manifests/install-modules.json`: Added `agent-memory` to `skills-orchestration` module

**Validated**: 38 skills, 0 errors. Deployed to `~/.claude/skills/` and `~/.codex/skills/`.

### Skipped patterns

- `shared-task-manifest` (Addy Osmani "Code Agent Orchestra"): Parallel agent coordination via explicit task list with pending/in_progress/completed/blocked statuses. Novel aspect (explicit dependency chains and peer-to-peer unblocking) is partially covered by `supervisor-worker` + `dmux-workflows`. Not found in 2+ independent sources as a distinct, proven workflow.
- `context-reset-loop` / Ralph Loop (Osmani): Atomic commit cycle — pick task, implement, validate, commit, reset context. Context management aspect partially covered by `virtual-context`. The "reset after each commit" is basic git hygiene rather than a novel skill workflow. Not proven enough as standalone pattern.
- `squad-drop-box` (GitHub Squad): Repository-native multi-agent coordination via `decisions.md` drop-box file + `.squad/` charter files. Interesting architecture but (a) Squad-platform-specific, (b) covered in spirit by `session-handoff` + `supervisor-worker`, (c) no implementation-agnostic SKILL.md workflow extractable.
- `subagent-lifecycle-hooks`: Claude Code SubagentStart/SubagentStop hooks for event-driven coordination (Slack notifications, log aggregation). Too narrow and implementation-specific. `update-config` already covers hook setup; specific event names can be added there if needed.
- `mcp-server-cards-standalone`: Server Cards are documented in `mcp-server-patterns` update above. Not worth a separate skill.
- `memory-engineering-5-pillars` (O'Reilly): Taxonomy (working/episodic/semantic/procedural/shared), persistence, retrieval, coordination, consistency. Conceptually rich but too abstract/architectural for a concrete SKILL.md workflow. Better as documentation than a repeatable agent skill.

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
