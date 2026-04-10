---
name: qa-browser
description: "Use for browser-based regression testing of user-facing features and workflows."
origin: unified
---

## Rules

- Test user-visible behavior, not implementation details. Assert on what the user sees and can interact with, not internal state or DOM structure.
- Wait for stability before asserting. Never assert immediately after a navigation or action. Wait for the page to settle -- loading indicators gone, animations complete, network requests finished.
- Screenshot on failure. Capture a screenshot at the moment of failure to provide visual evidence for debugging.
- Each test scenario must be independent. No test should depend on the outcome of another test.
- Test the critical paths first. Prioritize flows that block users or generate revenue over edge cases.

## Workflow

1. **Identify critical paths** -- List the user-facing workflows that must not break: login, core feature flows, checkout, data submission, navigation between key pages. Prioritize by business impact.
2. **Write test scenarios** -- For each critical path, define step-by-step scenarios with: preconditions, actions (click, type, navigate), and expected outcomes (visible text, element state, URL).
3. **Execute in browser** -- Run each scenario in an actual browser. Perform each action, wait for stability, and verify the expected outcome. Capture screenshots at key checkpoints.
4. **Compare against baseline** -- Compare current behavior and screenshots against the known-good baseline. Flag any deviations in layout, content, functionality, or response time.
5. **Report regressions** -- For each regression found, report: the scenario that failed, the step where it diverged, the expected versus actual outcome, and a screenshot showing the failure.

## Gotchas

- Flaky tests are worse than no tests. If a test fails intermittently, fix the wait/stability logic before trusting it.
- Testing against hardcoded data makes tests brittle. Use stable selectors (data-testid, aria labels) over CSS classes or positional selectors.
- Viewport size affects layout. Specify and document the viewport used for each test run.
- Browser caching and stale state can produce false passes. Start each scenario from a clean state.
