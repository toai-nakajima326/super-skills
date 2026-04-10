---
name: e2e-testing
description: "Use when writing, reviewing, or debugging end-to-end tests, setting up test infrastructure, or designing test strategies for user-facing applications."
origin: unified
---

## Rules

- Test user journeys, not unit behavior. Each E2E test should walk through a meaningful workflow that a real user would perform, not assert on internal component state.
- Use stable selectors. Prefer data-testid attributes, ARIA roles, or accessible names over CSS classes, tag names, or DOM structure that changes with styling refactors.
- Handle async gracefully. Never use fixed sleeps. Wait for specific conditions: element visibility, network request completion, URL change, or text appearance.
- Keep tests independent. Each test must set up its own state and clean up after itself. Shared mutable state between tests creates ordering dependencies and flaky failures.
- Write tests that fail for the right reason. A test that breaks because a CSS class was renamed is a maintenance burden, not a safety net. Tests should only fail when user-visible behavior changes.
- Treat test code as production code. Apply the same standards for readability, naming, and structure. If the test is hard to understand, it will be hard to maintain and diagnose when it fails.

## Workflow

1. **Identify critical user journeys** -- list the workflows that matter most (signup, checkout, core feature usage) and prioritize those for E2E coverage.
2. **Set up test infrastructure** -- configure the test runner, browser automation tool, and test environment with deterministic data seeding.
3. **Build page objects or screen models** -- encapsulate page structure and interactions behind a clean API so tests read like user stories, not DOM manipulation scripts.
4. **Create test data factories** -- build helpers that generate realistic test data on demand, avoiding reliance on shared fixtures or production data snapshots.
5. **Write the tests** -- for each journey, write the test as a series of user actions and observable outcomes. Keep assertions focused on what the user sees.
6. **Add retry and recovery strategies** -- configure automatic retries for known flaky conditions (network latency, animation timing) at the assertion level, not the entire test.
7. **Integrate into CI** -- run E2E tests in parallel across browsers, fail the build on regression, and produce artifacts (screenshots, videos, traces) for failed tests.

## Gotchas

- Flaky tests erode trust faster than missing tests. If a test fails intermittently, fix it or delete it. A test suite people ignore is worse than no suite at all.
- Testing against a shared staging environment introduces coupling to other teams' deployments. Prefer ephemeral environments spun up per test run.
- Screenshot-based visual regression testing generates noise from subpixel rendering differences across OS and browser versions. Use perceptual diff thresholds or component-level visual tests.
- Mocking the entire backend in E2E tests defeats the purpose. The value of E2E is testing the full stack. Mock only external third-party services you do not control.
- Running all E2E tests on every commit is often too slow. Run the critical path on every PR; run the full suite on merge to main or on a schedule.
- Page objects that expose implementation details (CSS selectors, DOM structure) are no better than inline selectors. The page object API should describe user intent: `loginPage.signIn(user)`, not `loginPage.clickElement('#btn-submit')`.
- Parallel execution requires tests that do not share database rows, user accounts, or server-side state. Design test data isolation from the start, not as an afterthought.
