---
name: careful
description: Use for critical operations where mistakes are costly -- adds backup creation, impact explanation, and confirmation gates before every destructive or significant change.
origin: unified
---

## Rules

- Double-check before any destructive action. Re-read the target file or state immediately before modification to confirm the action is correct and the target has not changed.
- Create backups before every modification. Before editing, deleting, or overwriting any file, copy the original to a recoverable location. Name backups with timestamps for clarity.
- Explain consequences before proceeding. Before any significant action, describe to the user: what will change, what could go wrong, and how to revert if needed.
- Wait for explicit confirmation before executing. Never auto-proceed through destructive or irreversible steps, even if the user previously gave broad permission.
- One change at a time. In careful mode, avoid batching multiple modifications. Apply changes individually so each can be verified and reverted independently.
- Verify after execution. After every change, confirm the result matches expectations. Read back the modified file or check the new state.

## Steps

1. **Identify action risk** -- Assess the operation being requested. Categorize it as destructive (data loss possible), significant (hard to undo), or routine (easily reversible). In careful mode, treat significant and destructive actions with equal caution.
2. **Backup current state** -- Before touching anything, create a backup:
   - For files: copy to a `.backup` or timestamped location.
   - For git: ensure all changes are committed or stashed, note the current commit hash.
   - For databases: export affected rows or create a savepoint.
3. **Explain impact** -- Present to the user:
   - What exactly will change (file paths, line numbers, record counts).
   - What the risks are (data loss, broken dependencies, downtime).
   - How to revert (backup location, git command, restore procedure).
4. **Wait for confirmation** -- Pause and ask the user to confirm. Do not interpret silence or previous instructions as approval. Each action in careful mode requires its own explicit go-ahead.
5. **Execute** -- Perform the action exactly as described. Do not add extra changes or optimizations that were not confirmed.
6. **Verify** -- Immediately after execution, check the result:
   - Read back modified files and compare to expectations.
   - Run relevant tests if available.
   - Confirm the backup is intact and accessible.
   - Report the outcome to the user.

## Gotchas

- Backup locations must not collide. Use timestamps or unique suffixes to prevent overwriting previous backups.
- Git stash can silently fail if there are untracked files. Use `git stash --include-untracked` or commit before proceeding.
- File permissions may prevent backup creation. Check write access to the backup destination before attempting the main operation.
- Large files or databases may make full backups impractical. In those cases, document what was not backed up and get explicit user acknowledgment.
- "Careful mode" should not be silently disabled. If the user requests a fast operation, confirm they want to exit careful mode before proceeding without safeguards.
