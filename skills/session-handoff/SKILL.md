---
name: session-handoff
description: "Use at session start and during work. Ensures state recovery from dev log, todo restoration, and continuous auto-save of progress."
origin: unified
---

## Rules

1. Sessions can end at any time without warning. Never batch state saves for "later".
2. At session start, recovery must happen BEFORE responding to user instructions.
3. Dev log must be updated at every meaningful state change.
4. All reads must be actual Read tool calls (no "I recall from before").

## Workflow — Session Start

Detect: new context or compaction summary present.

Before responding to user, execute in order:
1. Read `docs/autodev-log.md` tail — previous progress and interruption state
2. Read `Design.md` if it exists — UI design source of truth
3. Glob `~/.claude/skills/` and read all skills
4. List `docs/analysis/` files, read ones relevant to current phase:
   - `implementation-roadmap.md` — full task list and progress
   - `implementation-detail-specs.md` — implementation specs per task
   - Other analysis files related to current work
5. Check `.claude/plans/` for active plans
6. Restore Todo list from previous state
7. Report: "Previous state: ○○" and "Files loaded: X" before starting work

## Workflow — During Work (Auto-save)

Update dev log at these triggers:
- Todo item marked as completed
- Agent result check completed
- Before executing a commit

Write to dev log immediately at each trigger. "Save everything at the end" is prohibited.

## Workflow — At Commit

1. Verify dev log is up to date
2. Reflect new information to MEMORY.md if applicable
3. Then commit and push

## Gotchas

- "I remember from the previous session" without actual Read is a violation.
- Responding to user before completing session start recovery is a violation.
- If docs/autodev-log.md doesn't exist in the project, skip that step (don't error).
- Session recovery should be fast — read in parallel where possible.
