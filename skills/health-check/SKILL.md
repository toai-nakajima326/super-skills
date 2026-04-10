---
name: health-check
description: Use for assessing overall project health by running build, tests, linter, dependency audit, and security checks, then reporting status as red/yellow/green.
origin: unified
---

## Rules

- Check all five dimensions: build, tests, linter, dependencies, and security vulnerabilities. Skipping a dimension is not acceptable unless the project genuinely lacks that tool (e.g., no linter configured).
- Report each dimension with a red/yellow/green status:
  - **Green**: Passes completely with no errors or warnings.
  - **Yellow**: Passes but with warnings, deprecations, or minor issues that should be addressed.
  - **Red**: Fails outright or has critical issues (build errors, test failures, high-severity vulnerabilities).
- Run checks in isolation. A failure in one dimension must not prevent checking the others. Always report all five dimensions.
- Use the project's own tooling. Run the build, test, and lint commands defined in the project's configuration (package.json scripts, Makefile targets, CI config), not generic alternatives.
- Report actionable details. For each yellow or red item, include the specific error message, file location, or vulnerability ID so the user can act on it.

## Steps

1. **Run build** -- Execute the project's build command (e.g., `npm run build`, `cargo build`, `go build ./...`). Record success/failure and any warnings or errors. Assign red/yellow/green.
2. **Run tests** -- Execute the project's test suite (e.g., `npm test`, `pytest`, `go test ./...`). Record the number of tests passed, failed, and skipped. Assign red if any fail, yellow if any are skipped, green if all pass.
3. **Run linter** -- Execute the project's lint command (e.g., `npm run lint`, `eslint .`, `golangci-lint run`). Record the count of errors and warnings. Assign red for errors, yellow for warnings only, green if clean.
4. **Audit dependencies** -- Check for outdated or vulnerable dependencies (e.g., `npm audit`, `pip audit`, `cargo audit`). Record the number of vulnerabilities by severity (critical, high, moderate, low). Assign red for critical/high, yellow for moderate, green for low-only or none.
5. **Report health status** -- Present a summary table with all five dimensions, their red/yellow/green status, and key details:
   - Overall project health: red if any dimension is red, yellow if any is yellow, green only if all are green.
   - List the top issues to fix, ordered by severity.
   - Suggest concrete next steps for each red or yellow item.

## Gotchas

- Build commands may have side effects (downloading dependencies, generating files). Run them in the project's existing environment to avoid unexpected changes.
- Test suites may be slow. If the full suite takes more than a few minutes, inform the user and offer to run a subset or check cached results.
- Some projects have multiple build targets or test configurations (e.g., unit tests vs. integration tests). Check the primary/default configuration unless the user specifies otherwise.
- Dependency audit tools may report known issues that the team has intentionally accepted. Do not automatically escalate these -- report them and let the user decide.
- Security vulnerability databases update frequently. An audit that was green yesterday may be yellow today due to newly disclosed CVEs.
- Monorepos may require running checks per-package. Identify the project structure before running checks.
