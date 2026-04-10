---
name: tdd-workflow
description: "Use when developing features or fixes using strict test-driven development: red, green, refactor."
origin: unified
---

## Rules

- Write the failing test first. No production code is written until a test exists that fails for the right reason.
- Minimal code to pass. Write only enough production code to make the failing test pass. No more.
- Refactor only after green. Restructuring, renaming, and cleanup happen only when all tests are passing.
- Each cycle is small. One test, one behavior. Resist the urge to write multiple tests before implementing.
- Tests must fail for the right reason. A test that fails due to a syntax error or missing import is not a valid red step. The failure must reflect the missing behavior.

## Workflow

1. **Write test** -- Write a single test that describes one unit of expected behavior. Run it and confirm it fails. Read the failure message to verify it fails because the behavior is missing, not because of an error in the test itself.
2. **Run (expect fail)** -- Execute the test suite. The new test must fail (red). All previously passing tests must still pass. If the new test passes without code changes, the test is not testing new behavior -- rewrite it.
3. **Implement minimal fix** -- Write the smallest amount of production code that makes the failing test pass. Do not add code for future tests or anticipated requirements.
4. **Run (expect pass)** -- Execute the full test suite. All tests must pass (green). If any test fails, fix the production code until all tests are green. Do not modify existing tests to make them pass.
5. **Refactor** -- With all tests green, improve the code structure: extract methods, rename variables, remove duplication, simplify logic. Do not change behavior -- tests must still pass after refactoring.
6. **Run again** -- Execute the full test suite one final time after refactoring to confirm nothing was broken. All tests must still pass. Return to step 1 for the next behavior.

## Gotchas

- Writing tests after the code defeats the purpose. The test must drive the design, not document it after the fact.
- Skipping the refactor step leads to passing but messy code. Refactoring is not optional -- it is the third step of every cycle.
- Large steps (writing many tests at once or implementing multiple behaviors) break the feedback loop. Stay small.
- Tests that test implementation details instead of behavior become brittle and block refactoring.
- "Making it pass" by hardcoding return values is valid in TDD -- the next test will force generalization.
