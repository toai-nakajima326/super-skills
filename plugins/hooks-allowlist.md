# Safe Hook Allowlist

These are the only hook ideas this repository treats as acceptable candidates for host adapters. They still must remain explicit, visible, and user-controlled.

## Allowlisted Ideas

- formatting reminder after edits
- typecheck reminder after code changes
- validation reminder after manifest changes
- MCP health-check reminder before risky workflows
- checkpoint reminder before long-running work
- compact-state reminder when context grows large

## Constraints

- Each hook idea must have a visible non-hook fallback path.
- Hooks must not auto-approve actions.
- Hooks must not send telemetry.
- Hooks must not run broad command suites without an explicit user trigger.
- Hooks must not broaden permissions silently.
- Hooks must not rewrite git state on their own.

## Not Allowed

- auto-approval
- telemetry
- hidden execution
- broad auto-execution
- browser automation by default
- secret exfiltration or secret scanning that leaves the repository unexpectedly
