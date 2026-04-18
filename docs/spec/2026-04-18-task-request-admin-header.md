# Mini-spec — `X-Vcontext-Admin` header required for `POST /admin/task-request` (shell-command only)

**Date**: 2026-04-18
**Scope**: `scripts/vcontext-server.js` — `/admin/task-request` handler
**Category**: security (RCE-surface reduction)
**Author**: Agent B (worker)
**Promoted-by**: user (`HIGHは対応しましょう`) despite being a security-category item per `docs/policy/autonomous-commit-gate.md` §0

## Context

Agent A source audit (commit `9078e7b`) identified H3:

> `POST /admin/task-request` for `task_type: 'shell-command'` gates only on
> client-settable `payload.approved_by_user: true`. Missing the
> `X-Vcontext-Admin: yes` header that `/admin/apply-patch` requires.
> Loopback-bound, but any local process (or DNS-rebind attack) can enqueue
> arbitrary shell commands which `aios-task-runner.js` then executes.

Reference pattern — `/admin/approve-patch` (vcontext-server.js:6615-6622) already
gates on `X-Vcontext-Admin: yes`. Applying the same pattern to `shell-command`
dispatch restores parity.

## Goal

Require `X-Vcontext-Admin: yes` header for `POST /admin/task-request` whenever
`task_type === 'shell-command'`. Keep non-shell task types (`locomo-eval`,
`skill-discovery-adhoc`, `article-scan-adhoc`, `self-evolve-dryrun`) header-free
to avoid breaking adhoc dispatch.

## Acceptance Criteria

- **AC1**: Missing `X-Vcontext-Admin` header + `task_type=shell-command` →
  HTTP 403, no task enqueued.
- **AC2**: Missing header + `task_type=locomo-eval` (or any non-shell) →
  still allowed (HTTP 200, task enqueued). Regression check.
- **AC3**: Header `X-Vcontext-Admin: yes` + `task_type=shell-command` +
  `payload.approved_by_user: true` → HTTP 200, task enqueued.
- **AC4**: Header present + `task_type=shell-command` +
  `payload.approved_by_user: false/missing` → HTTP 403 (existing
  `approved_by_user` check still active — defense-in-depth).

## Non-goals

- NOT applying header requirement to other task types (would break
  `test-task-dispatch-paths.sh` and cross-skill dispatch paths).
- NOT removing the existing `approved_by_user` check (defense-in-depth).
- NOT touching the runner (`aios-task-runner.js`) — its `approved_by_user`
  gate stays as second layer.

## Callers audit (regression risk)

Only one in-repo caller of `/admin/task-request` with `task_type=shell-command`:
- `scripts/test-task-queue.sh:47` — will be updated in this change to send the
  header.

Other callers use non-shell task types and are unaffected:
- `scripts/test-task-dispatch-paths.sh:46` — dispatches
  `skill-discovery-adhoc`, `article-scan-adhoc`, `self-evolve-dryrun`.

## Rollback

If the patch causes any regression:
```
git reset --hard HEAD~1
launchctl bootout gui/$UID /Users/mitsuru_nakajima/Library/LaunchAgents/com.vcontext.server.plist
launchctl bootstrap gui/$UID /Users/mitsuru_nakajima/Library/LaunchAgents/com.vcontext.server.plist
```
