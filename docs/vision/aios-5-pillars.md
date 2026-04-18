# AIOS 5-Pillar Vision

One-page strategic reference. Five structural bets that separate the current skill
collection from an operating system for long-running agents.

Current position: **Article scanner is live as Pillar 2's external-input loop**
(`scripts/article-scanner.js` + `com.vcontext.article-scanner.plist`, daily 06:00).
Pillars 1, 3, 4, 5 remain at L1 / fragmentary state.

---

## Pillar 1 — Structured Cognition

**3D memory matrix: Time x Kind x Granularity.**

- *Time* — minute / day / week / quarter (chunk-summary axis, already partly built)
- *Kind* — MIRIX 6 classes: Core / Episodic / Semantic / Procedural / Resource / Meta
- *Granularity* — Agent Skills L1 metadata / L2 SKILL.md / L3 reference files

**Current gap** — only the time axis exists (L1 chunk-summary). No MIRIX-style kind
tagging, no L2/L3 granularity switching. Every skill is stored flat.

**Redesign sketch** — every write goes through a classifier producing `{kind, ttl,
granularity}`. Retrieval walks the 3D cube instead of scanning a single SQLite
table. Meta/Core pinned, Episodic decays, Procedural promotes to L2 on reuse-count
threshold.

**AIOS assets that plug in** — `chunk-summary` (time axis exists), 217 skills
(raw Procedural corpus to classify), vcontext SQLite (storage substrate).

**Research**
- MIRIX multi-agent memory (6-class split) — https://arxiv.org/abs/2507.07957
- Letta / MemGPT memory tiers — https://arxiv.org/abs/2310.08560
- Anthropic Agent Skills L1/L2/L3 spec — https://www.anthropic.com/news/skills
- PHOTON long-context retrieval — https://arxiv.org/abs/2402.10790

---

## Pillar 2 — Continuous Evolution

**AlphaEvolve-style evolutionary loop for skills.**

- Weekly: generate N skill variants from a seed (mutation + crossover on SKILL.md)
- A/B in shadow mode against live traffic
- Fitness = success-rate x adoption-rate x tokium pain->structure conversion

**Current gap** — skill-discovery and skill-creator generate skills, but there is
no selection pressure, no variant pool, no fitness function wired to outcomes.
New skills accumulate without pruning.

**Redesign sketch** — nightly GA over the skill corpus. Each SKILL.md carries a
`fitness` block (trailing 30-day win rate). Variants fork on stagnation. Dead
skills archived, top variants promoted. Article scanner is the first external
sensor feeding this loop.

**AIOS assets that plug in** — `skill-discovery` (variant generator), `self-improve`
(already proposes refactors), `article-scanner` (external signal), 217 skills
(population).

**Research**
- AlphaEvolve (DeepMind) — https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- tokium (pain->structure) — https://github.com/tokium-ai/tokium
- engram evolutionary memory — https://github.com/engram-ai/engram

---

## Pillar 3 — Causal Observability

**Every decision OTEL-traced, causal graph self-owned, AIOS can debug itself.**

**Current gap** — logs are scattered across `/tmp/vcontext-*.log`. No trace IDs
across skill boundaries. Causality inferred by hand when something breaks.

**Redesign sketch** — wrap every skill invocation, tool call, and memory write in
OTEL spans. Ship to Langfuse for UI. Build a local causal graph (cause -> effect
edges with confidence). `investigate` skill queries the graph instead of grepping
logs. AIOS answers "why did you do X" in one hop.

**AIOS assets that plug in** — `investigate` skill, `watchdog` + `maintenance`
LaunchAgents (already tracking health), vcontext dashboard.

**Research**
- Langfuse LLM observability — https://langfuse.com/docs
- OpenTelemetry GenAI semantic conventions — https://opentelemetry.io/docs/specs/semconv/gen-ai/
- claude-mem causal memory — https://github.com/claude-mem/claude-mem

---

## Pillar 4 — Predictive Ambience

**Active prediction on 30s interval, pre-warming, proactive notification, cross-device.**

**Current gap** — everything is reactive. User asks -> Claude answers. No
anticipation, no pre-fetch, no context carried to the phone when the laptop sleeps.

**Redesign sketch** — 30s predictor loop looks at calendar + recent activity +
time-of-day patterns, pre-warms likely skills, drafts responses for expected
questions. macOS notification when confidence > threshold. Mobile handoff via
shared vcontext backend.

**AIOS assets that plug in** — `predictive-search` skill, `morning-brief`
LaunchAgent (daily baseline), `vcontext` server (shared state bus).

**Research**
- Proactive conversational agents survey — https://arxiv.org/abs/2305.02750
- Continual pre-training for adaptive agents — https://arxiv.org/abs/2406.14546

---

## Pillar 5 — Open Substrate

**vcontext exposed as an MCP memory protocol. Pluggable backends.**

**Current gap** — vcontext is a single-user SQLite with a bespoke HTTP API on
port 3150. Not callable from other MCP clients. Not swappable to Postgres / pgvector
/ DuckDB without rewrite.

**Redesign sketch** — define an MCP memory-protocol surface (read/write/search/
classify/evict). vcontext becomes the reference implementation. Backend is a
driver interface (sqlite today, postgres-pgvector tomorrow, Turso for sync).
Other AIOS instances can federate through the protocol.

**AIOS assets that plug in** — vcontext server (already on port 3150), `aios-skill-bridge`
(protocol translation layer), MCP ecosystem Claude already speaks.

**Research**
- Anthropic MCP spec — https://modelcontextprotocol.io/docs
- MIRIX multi-tier memory schema — https://arxiv.org/abs/2507.07957
- Letta server-side memory — https://github.com/letta-ai/letta

---

## Quarterly Roadmap

| Quarter | Theme           | Deliverable                                                    |
|---------|-----------------|----------------------------------------------------------------|
| Q1      | Observability   | OTEL spans on every skill, Langfuse dashboard, causal graph v0 |
| Q2      | Structure       | 3D memory matrix live, MIRIX classifier, L2/L3 promotion loop  |
| Q3      | Evolution       | Weekly GA over skill corpus, fitness wired to article-scanner  |
| Q4      | Ambience + Open | 30s predictor loop, MCP memory-protocol v1, mobile handoff     |

---

## Where we are today

- **Pillar 1** — chunk-summary (time axis) only. Kind + granularity unbuilt.
- **Pillar 2** — **article-scanner live** (daily 06:00 external-input loop). Fitness function + variant pool pending.
- **Pillar 3** — log files only. No OTEL, no causal graph.
- **Pillar 4** — morning-brief daily. No 30s loop, no proactive notify.
- **Pillar 5** — vcontext HTTP API internal-only. No MCP surface yet.

Article scanner is the first concrete evolutionary signal. Next step: wire its
output into a fitness score for the 217-skill population.
