---
name: model-selector
description: "Select the appropriate Claude model tier (Haiku/Sonnet/Opus) before launching agents based on task type. Mechanical/repetitive tasks → Haiku; broad coverage/review → Sonnet; deep planning/architecture → Opus. Reduces cost by up to 90% vs using frontier models for everything."
origin: web-discovery
sources:
  - AgentSys community validation (1,000+ repositories)
  - https://github.com/avifenesh/agentsys
  - "Plan-and-Execute with Model Tiering" pattern (multiple 2026 sources)
---

## Rules

1. **Default to Sonnet**: When uncertain, use Sonnet. It handles most tasks well.
2. **Justify Opus**: Opus costs ~5x Sonnet. Only use it for tasks that genuinely need deep reasoning, complex tradeoffs, or creative synthesis.
3. **Justify Haiku**: Haiku is for mechanical tasks with deterministic outputs. Never use it for judgment, planning, or novel problem-solving.
4. **Declare before launching**: Model selection must happen before launching any agent — not after the agent returns.
5. **Log the decision**: Record which model was selected and why in the task log or report.

## Model Tier Profiles

### Haiku — Mechanical tasks, highest speed, lowest cost
**Use for:**
- Regex extraction, grep analysis, file scanning
- Format conversion (JSON→CSV, Markdown→HTML)
- Boilerplate code generation from explicit templates
- Counting, sorting, deduplication of structured data
- Running defined test commands and returning pass/fail
- Filling in clearly-specified, low-judgment tasks

**Do NOT use for:**
- Architecture decisions
- Debugging ambiguous errors
- Security review
- Writing novel code logic
- Any task where "it depends" is the right answer

### Sonnet — General-purpose, balanced cost and capability
**Use for:**
- Code review and coverage checking
- Implementing features from specifications
- Debugging with clear error context
- Writing tests (unit + integration)
- Documentation generation
- Research and summarization
- Most supervisor-worker worker agents

**Default for:** Anything not clearly in Haiku or Opus territory.

### Opus — Deep reasoning, maximum capability
**Use for:**
- Architecture planning and system design
- High-stakes tradeoff decisions (use with `debate-consensus`)
- Complex debugging with multiple interacting systems
- Evaluating ambiguous requirements
- Creating or reviewing critical security logic
- Any task where a wrong decision has high reversibility cost
- `plan-architecture`, `debate-consensus`, `investigate` workflows on hard problems

**Do NOT use for:** Mechanical tasks, boilerplate, anything Sonnet can handle.

## Selection Workflow

### Step 1 — Characterize the task
Answer these questions:
1. Is the output deterministic given the input? (YES → Haiku candidate)
2. Does the task require judgment, tradeoffs, or novel synthesis? (YES → Opus candidate)
3. Is this a review/coverage/implementation task? (YES → Sonnet)

### Step 2 — Apply the decision matrix

```
Is output deterministic?
  YES → Haiku
  NO  → Does it require architecture/planning/high-stakes judgment?
          YES → Opus
          NO  → Sonnet
```

### Step 3 — Cost sanity check
Before using Opus, ask: "Would Sonnet get this 90% right?" If yes, use Sonnet.
Before using Haiku, ask: "Could this task produce wrong output that's hard to detect?" If yes, use Sonnet.

### Step 4 — Declare and launch
```
[model-selector] Task: [task description]
Reasoning: [why this tier]
Selected: Haiku | Sonnet | Opus
```

Then launch the agent with the appropriate `model` parameter.

## Common Task → Model Mappings

| Task | Model | Reasoning |
|------|-------|-----------|
| Grep for pattern matches | Haiku | Mechanical scan |
| Count files matching criteria | Haiku | Deterministic |
| Convert data formats | Haiku | Template-driven |
| Implement a feature from spec | Sonnet | Judgment needed for edge cases |
| Write unit tests | Sonnet | Coverage + judgment |
| Code review for correctness | Sonnet | Pattern recognition + judgment |
| Debug "something is broken" | Sonnet | Investigation, hypothesis testing |
| Security review | Sonnet / Opus | Depends on complexity |
| Architecture decision | Opus | High-stakes judgment |
| Multi-system design | Opus | Deep synthesis |
| Evaluate spec ambiguity | Opus | Novel problem, high reversibility cost |
| Post-mortem root cause | Opus | Complex causal reasoning |

## Integration

- **With `supervisor-worker`**: Use model-selector before launching each worker agent. Supervisor typically runs on Sonnet; workers may vary.
- **With `debate-consensus`**: Both debate agents on Opus for high-stakes decisions.
- **With `dmux-workflows`**: Select model per parallel task before fan-out.
- **With `plan-architecture`**: Planner on Opus; implementers on Sonnet; test runners on Haiku.

## Gotchas

- Never optimize model selection mid-task by downgrading from Opus to Haiku to save cost — this degrades output quality silently.
- "Haiku is fast so I'll use it for everything" is the most common mistake. Speed doesn't matter if the output is wrong.
- The cost savings from Haiku are real (~20x cheaper than Opus), but only materialize when tasks are genuinely mechanical.
- Model tier ≠ agent capability ceiling. A Sonnet agent using the right tools outperforms a confused Opus agent without context.
