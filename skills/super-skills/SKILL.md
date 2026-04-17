---
name: super-skills
description: "Use always. Automatically detect context, search vcontext skill-registry, and apply the most appropriate skill. Measures skill effectiveness and feeds results back for improvement."
origin: unified
---

## Rules
1. Always active. Search vcontext skill-registry for matching skills.
2. Highest-priority match wins. None: proceed normally.
3. Never announce skill name. User-named skill overrides routing.
4. Record skill usage and outcome to vcontext for effectiveness tracking.

## Routing (first match wins)
P0 always: virtual-context(every session/decision/complex question), supervisor-worker(multi-agent), quality-gate(work output), report-format(completion), phase-gate(phase transition), session-handoff(session start), self-evolve(update)
P1 safety: guard(delete/drop/force-push), freeze(read-only), careful(production/critical), checkpoint(save state)
P2 debug: investigate(error/broken/stack-trace), health-check(CI/build), drift-detect(stale/deprecated)
P3 plan: plan-product(user story), plan-architecture(system design), spec-driven-dev(spec/requirements/acceptance criteria/feature >500 lines), api-design(endpoint), debate-consensus(architecture fork)
P4 review: review(PR/diff), security-review(auth/secrets/injection), adversarial-review(try to break/edge case/race condition)
P5 dev: ui-implementation(.tsx/UI), tdd-workflow(TDD), eval-driven-dev(LLM eval/golden dataset/evaluator-optimizer), ship-release(release), qa-browser(QA), e2e-testing(Playwright/Cypress), claude-routines(automate/routine/schedule cloud/GitHub trigger)
P6 patterns: backend-patterns(service/middleware), frontend-patterns(React/hooks), coding-standards(naming/style), mcp-server-patterns(MCP), agent-memory(AGENTS.md/new project/institutional memory)
P7 research: deep-research(research), exa-search(web search), documentation-lookup(docs), verification-loop(verify), dmux-workflows(parallel), model-selector(model tier), confidence-filter(multi-agent vote), gh-skill-manager(install/update/publish agent skill/gh skill CLI)

## Stacking
P0+P1 layer on any skill. Others: pick one.
