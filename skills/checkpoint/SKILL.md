---
name: checkpoint
description: Use when making risky changes to save and restore named state checkpoints, enabling safe rollback if something goes wrong.
origin: unified
---

## Rules

- Create a checkpoint before any risky or multi-step change. This is mandatory, not optional, when the upcoming work could leave the project in a broken state.
- Name checkpoints descriptively. Use names that indicate the state being captured (e.g., "before-auth-refactor", "pre-migration-v2"), not generic labels like "checkpoint-1."
- Preserve full context in each checkpoint. A checkpoint must capture enough state to fully restore: file contents, git state (branch, commit hash, staged changes), and any relevant environment details.
- Never overwrite an existing checkpoint without confirmation. If a checkpoint name already exists, warn the user and ask whether to overwrite or choose a new name.
- Keep checkpoints accessible until explicitly cleaned up. Do not auto-delete checkpoints after restoration or after a time limit.
- Document what each checkpoint covers. Record which files, branches, or states are included so the user knows exactly what restoring will affect.

## Steps

1. **Capture current state** -- Record the full current state before changes begin:
   - Note the current git branch and commit hash.
   - Identify modified, staged, and untracked files via `git status`.
   - For non-git-tracked state (environment variables, config files outside the repo), note their current values.
2. **Create named checkpoint** -- Save the captured state under a descriptive name:
   - Use `git stash` or create a temporary commit/branch to preserve the working state.
   - For files outside git, copy them to a checkpoint directory (e.g., `.checkpoints/<name>/`).
   - Record a manifest listing everything included in the checkpoint.
3. **Proceed with changes** -- Perform the planned modifications. Reference the checkpoint name in any progress notes so it is clear which checkpoint covers this work.
4. **Restore if needed** -- If something goes wrong or the user requests a rollback:
   - Retrieve the checkpoint by name.
   - Restore all files and git state to the checkpointed versions.
   - Verify the restoration by comparing current state to the checkpoint manifest.
   - Inform the user of exactly what was restored and confirm the project is back to the checkpointed state.

## Gotchas

- `git stash` operates per-branch. Switching branches between creating and restoring a stash-based checkpoint can cause conflicts. Prefer temporary branches or commit-based checkpoints for cross-branch safety.
- Checkpoints do not capture running processes, database state, or external service state. Make this clear to the user if the risky change involves more than local files.
- Large binary files or build artifacts may make checkpoints slow or large. Exclude build output directories (node_modules, dist, build) from file-based checkpoints unless specifically needed.
- Restoration is not always clean. If new files were created after the checkpoint, they will not be removed by a git-based restore. A full restore may require manual cleanup of added files.
- Nested checkpoints (checkpoint within a checkpoint) should be supported. Use unique names and maintain a flat list rather than a stack to avoid confusion about restore order.
