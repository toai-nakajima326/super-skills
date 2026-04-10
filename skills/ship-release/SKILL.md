---
name: ship-release
description: "Use when preparing a release -- versioning, changelog, and PR creation without auto-pushing."
origin: unified
---

## Rules

- Never auto-push. All pushes require explicit human approval. Create the PR and stop.
- Verify CI is green before starting the release process. Do not tag or version a broken build.
- Changelog before tag. The changelog must be written and reviewed before any version bump or tag is created.
- Follow semantic versioning. Breaking changes bump major, new features bump minor, bug fixes bump patch.
- One release, one PR. The release PR should contain only release-related changes (version bump, changelog).

## Workflow

1. **Verify tests pass** -- Confirm that all CI checks are green on the branch being released. If any check is failing, stop and fix it before proceeding.
2. **Update changelog** -- Write the changelog entry for this release. Summarize changes grouped by category (added, changed, fixed, removed). Reference relevant PR numbers or issue IDs.
3. **Bump version** -- Update the version number in all relevant files (package.json, pyproject.toml, Cargo.toml, etc.) following semantic versioning.
4. **Create PR** -- Create a pull request with the changelog update and version bump. Title it clearly (e.g., "Release v1.2.3"). Do not merge it.
5. **Wait for human approval** -- Stop here. A human must review the changelog, verify the version bump, approve the PR, and merge it. Do not push tags or publish packages.

## Gotchas

- Forgetting to update the version in one of several config files causes mismatched versions in production.
- Changelog entries written after the fact are less accurate. Write them as part of the release process, not after.
- Tagging before CI is green means the tag may point to a broken commit.
- Force-pushing after tagging rewrites history that others may have already pulled. Never force-push release branches.
