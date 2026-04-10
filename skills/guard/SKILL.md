---
name: guard
description: Use when executing shell commands or database operations to prevent dangerous destructive actions like rm -rf, DROP TABLE, or force pushes to main.
origin: unified
---

## Rules

- Block all destructive commands before execution. The following patterns must be intercepted:
  - `rm -rf /` or any `rm -rf` targeting root, home, or system directories
  - `DROP TABLE`, `DROP DATABASE`, `TRUNCATE` without explicit confirmation
  - `git push --force` to `main` or `master` branches
  - `git reset --hard` on shared branches
  - `chmod -R 777` on system or project-root directories
  - `> /dev/sda` or any raw disk writes
- Require explicit user confirmation for all irreversible actions, even those not in the blocklist. If an action cannot be undone, the user must approve it.
- Log every blocked attempt with the original command, risk classification, timestamp, and reason for blocking. The log serves as an audit trail.
- Never silently downgrade a dangerous command to a safer variant without informing the user. Always explain what was blocked and why.
- When a command is ambiguous (could be safe or dangerous depending on context), default to blocking and requesting clarification.

## Steps

1. **Intercept command** -- Capture the command before execution. Parse the full command string including pipes, subshells, and chained operators (`&&`, `||`, `;`).
2. **Classify risk level** -- Assign one of three risk levels:
   - **Critical** (auto-block): Commands matching the destructive blocklist. No execution under any circumstance without explicit override.
   - **High** (warn and confirm): Irreversible actions not on the blocklist but with significant consequences (e.g., `DROP INDEX`, large-scale file moves, production deployments).
   - **Normal** (allow): Read-only operations, local file edits, non-destructive git operations.
3. **Block, warn, or allow** -- Based on the risk classification:
   - Critical: Block execution. Present the user with the exact command, explain why it is dangerous, and ask for confirmation.
   - High: Warn the user with a description of the consequences. Proceed only with explicit approval.
   - Normal: Allow execution without interruption.
4. **Log decision** -- Record the command, its risk level, the decision taken (blocked/warned/allowed), and user response if applicable. Store in the session log for audit purposes.

## Gotchas

- Chained commands can hide destructive operations: `echo hello && rm -rf /` looks benign at first glance. Always parse the full chain.
- Shell variable expansion can obscure targets: `rm -rf $DIR` where `$DIR` resolves to `/` at runtime. When variables are involved, flag for review.
- Aliases and functions may wrap destructive commands. If possible, resolve aliases before classification.
- `sudo` prefixes escalate the impact of any command. Treat `sudo` + any high-risk command as critical.
