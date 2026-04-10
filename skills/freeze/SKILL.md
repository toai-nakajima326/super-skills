---
name: freeze
description: Use when exploring a codebase or debugging without risk of accidental modifications -- enables strict read-only mode that blocks all writes, commits, and network mutations.
origin: unified
---

## Rules

- No file writes of any kind. This includes creating, editing, deleting, moving, or renaming files and directories.
- No git mutations. Commits, pushes, branch creation, rebasing, merging, stashing, and tag creation are all blocked.
- No network mutations. POST, PUT, PATCH, DELETE requests are blocked. GET and HEAD requests are allowed.
- Read-only exploration is unrestricted. File reads, grep, glob, git log, git diff, git status, git show, and all search operations proceed normally.
- Freeze mode must be explicitly activated and can only be deactivated by an explicit user command (e.g., "unfreeze", "disable freeze mode").
- While frozen, clearly indicate the frozen state in any status or progress reports so the user always knows mutations are blocked.

## Steps

1. **Activate freeze** -- On user request, enter freeze mode. Confirm activation to the user and list what is now blocked (writes, commits, network mutations) versus what remains available (reads, searches, analysis).
2. **Reject all write operations** -- For every action attempted during freeze mode, check whether it mutates state. If it does, reject it with a clear message: state what was attempted, why it was blocked, and that freeze mode is active.
3. **Allow reads and searches** -- Permit all non-mutating operations without restriction. This includes reading files, searching codebases, viewing git history, inspecting configurations, running read-only database queries (SELECT), and fetching documentation.
4. **Deactivate on explicit command** -- Only exit freeze mode when the user explicitly requests it. Confirm deactivation and inform the user that write operations are now permitted again.

## Gotchas

- Some tools combine reads and writes in a single operation (e.g., `git stash` reads and writes). Block the entire operation if any part mutates state.
- Build commands (`npm run build`, `make`) create output files. These must be blocked in freeze mode even though the user may think of them as "just checking."
- Package manager installs (`npm install`, `pip install`) write to disk and modify lock files. Block these.
- Interactive commands that prompt for input may hang if they expect a write confirmation. Prefer blocking them upfront rather than entering an interactive state that cannot complete.
- Test runners that generate coverage reports or snapshots are performing writes. Block or warn depending on the test configuration.
