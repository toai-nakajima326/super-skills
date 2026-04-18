# Autonomous Commit Gate — Policy

Status: **Draft** · Owner: user · Created: 2026-04-18 · Related: `docs/analysis/2026-04-18-phase-integrated-review.md` §3

## 1. Motivation

On 2026-04-18, four commits landed on `main` during active phase work
without an explicit per-commit user review step:

| Commit   | Title (abbreviated)                                             |
|----------|-----------------------------------------------------------------|
| `8508eec` | feat: add claude-design skill                                   |
| `75300d3` | feat: new-feature-watcher                                       |
| `c8e5a80` | feat: conversation-skill-miner                                  |
| `a523bf5` | fix: update internal references to .cjs after rename            |

These were not malicious or broken — none caused regressions in today's
work. But the user explicitly asked "who made these?" when reviewing the
log, which exposes the gap: there is currently no mechanism that
distinguishes "autonomously created" commits from "user-reviewed" commits
at the `main` branch level. In an AIOS context this matters more than in
a normal codebase — AIOS is the user's cognitive substrate, and
un-reviewed state changes can silently feed into self-evolve cycles,
LaunchAgent scheduling, and vcontext memory.

Today the exposure is bounded because Claude Code sessions still produce
the commits (the user is at least adjacent). As `aios-learning-bridge.cjs`
(fitness≥0.85 auto-apply) and `/admin/apply-patch` endpoints mature, the
gap widens into daemon-level commits with no session in the loop at all.
This policy defines the gate before that day arrives.

## 2. Inventory of autonomous commit sources

### 2.1 Scripts that perform `git commit` in code

| Source | Trigger | Commit content | Current approval gate |
|--------|---------|----------------|-----------------------|
| `scripts/aios-learning-bridge.cjs` (`applyPatch`, L194-197) | Periodic poll of `pending-patch` entries; auto-applies when `fitness ≥ 0.85` and target is not a safety skill | `feat: auto-apply <skill> (fitness=…, source=…)` with new/updated `SKILL.md` | **Fitness threshold only** — no human approval. Not currently wired to a LaunchAgent (run_interval_minutes=60 documented but no plist found). |
| `scripts/vcontext-server.js /admin/apply-patch` (L6625, 6642) | HTTP POST from dashboard "Approve" button | `self-improve: patch <id> (user-approved)` | **Explicit user click required** (X-Vcontext-Admin header). Safe by design. |

### 2.2 Loops that generate candidates but do NOT commit

Verified by grep and script comments (e.g. `skill-discovery.sh` line 8:
"Safety: never creates SKILL.md files — all candidates require human review"):

| Loop                            | Output                         | Commit? |
|---------------------------------|--------------------------------|---------|
| `self-evolve.js`                | `pending-patch` entries        | No (observation mode today) |
| `skill-discovery.sh`            | `skill-gap` entries            | No |
| `article-scanner.js`            | `pending-idea` entries         | No |
| `keyword-expander.js`           | keyword entries in vcontext    | No |
| `new-feature-watcher.cjs`       | `pending-patch` entries        | No |
| `conversation-skill-miner.cjs`  | `pending-patch` entries        | No |

### 2.3 The actual source of today's 4 commits

All four have `Co-Authored-By: Claude Sonnet 4.6` in the message body and
user-identity authorship. This commit-message format does not match the
`aios-learning-bridge` template (`feat: auto-apply …`). They were
produced by **Claude Code agent sessions** — launched by self-evolve
Phase-e, skill-discovery follow-ups, or manual phase work — that the
user authorised at session-start but did not review per-commit.

So the gap is **agent-session commits**, not daemon commits. The daemon
path (`aios-learning-bridge`) is the future risk; the agent-session path
is today's risk.

## 3. Proposed gate design

### Option A — Hold-and-review queue (rejected)
Commits land on `autonomous/<loop>/<date>` branches; user merges weekly.
Pro: zero surprises on `main`. Con: feature work stalls until a batched
review session. Does not fit the user's observed cadence (fast-iterating
AIOS work). **Rejected.**

### Option B — Flag-and-proceed (rejected)
All autonomous commits land on `main` tagged `[auto]`; a dashboard card
surfaces them for retroactive review. Pro: preserves momentum. Con:
treats a LaunchAgent plist change the same as a new SKILL.md — but they
are not equally risky. `vcontext-server.js`, hooks, and plists are
cognitive-substrate infra; a new skill file is additive. **Rejected as
too coarse.**

### Option C — Tiered trust (recommended)
Classify the diff by path list:

- **Low-stakes (auto-apply OK, tag `[auto]`)**:
  `skills/**/SKILL.md`, `docs/**` except `docs/policy/**`,
  `data/skill-discovery/*.json`
- **High-stakes (human approval required)**:
  `scripts/vcontext-server.js`, `scripts/vcontext-hooks.js`,
  `scripts/aios-learning-bridge.cjs`, `scripts/self-evolve*`,
  `scripts/pre-commit-gate.sh`,
  `~/Library/LaunchAgents/com.vcontext.*.plist`,
  anything under `docs/policy/**` (including this file),
  `.claude/settings*.json`, `package.json`, `CLAUDE.md`

Pro: matches the actual risk gradient. Con: classification logic must
be maintained as the codebase grows. **Recommended.**

## 4. Implementation plan (Option C)

### 4.1 Tagging
Autonomous commits prepend `[auto]` to the subject line and add a
`Auto-Applied-By: <loop-name>` trailer. Example:

    [auto] feat: add mcp-tool-design skill (fitness=0.87)

    Auto-Applied-By: aios-learning-bridge
    Fitness: 0.87
    Source: article-scanner/2026-04-20
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

Scripts that commit autonomously (`aios-learning-bridge.cjs`, any future
agent-session wrapper) must emit this format. Commits without the
`[auto]` prefix are assumed human-authored.

### 4.2 High-stakes gate enforcement
Extend `scripts/pre-commit-gate.sh` with a second rule: if the staged
diff touches any path in the high-stakes list AND the invoker is not a
human (detected via an `INFINITE_SKILLS_OK=1` env marker or explicit
`HUMAN_APPROVED=1` flag), block the commit. Dashboard gets a
"pending high-stakes change" notification.

Today `pre-commit-gate.sh` already requires `CHECKER_VERIFIED=1` for
source-code changes; extend the same pattern.

### 4.3 Dashboard surface
Extend the existing **Autonomous Loops Digest** card
(`scripts/vcontext-dashboard.html:173`, section C4) with a sub-tab
"Recent [auto] commits (7d)". Each row shows: commit hash, subject,
touched paths, source loop, Undo button. Undo emits a `git revert <hash>`
on `main` (creates a new commit, does not rewrite history).

### 4.4 High-stakes review flow
When a loop wants to touch a high-stakes path, it:
1. Emits a `pending-patch` entry as today.
2. Dashboard surfaces it in the existing pending-patch card
   (already implemented via `/admin/pending-patches`).
3. User approves → `/admin/apply-patch` commits with `user-approved`
   suffix (already implemented).

This means the daemon-level high-stakes path reuses the existing approval
flow; only the classification check is new.

## 5. Migration path for the 4 existing un-reviewed commits

Retroactive appraisal (user confirms before acting):

| Commit   | Appraisal | Recommendation |
|----------|-----------|----------------|
| `8508eec` | New SKILL.md for claude-design. Additive, low-stakes. Touches `infinite-skills/SKILL.md` routing (+1 line). | **Keep.** |
| `75300d3` | New `scripts/new-feature-watcher.js` (368 lines) + updates `skill-discovery/SKILL.md`. **Script is high-stakes under §3 rules but already scrutinised in today's review doc.** | **Keep but flag** — next quality-gate sweep should confirm no secret leakage and verify LaunchAgent plist matches. |
| `c8e5a80` | New `scripts/conversation-skill-miner.js` + skill-discovery doc update. Same profile as `75300d3`. | **Keep but flag** — same sweep. |
| `a523bf5` | Mechanical `.js` → `.cjs` rename follow-up. No logic change, touches 8 files. | **Keep.** Low risk. |

**History rewrite**: no. These commits are already referenced in
`docs/analysis/2026-04-18-phase-integrated-review.md`. Retroactively
adding `[auto]` would break hash-anchored references.

**Forward action**: add a note to the evolution log acknowledging the
gap and referencing this policy.

## 6. Open questions (for next session)

- Should `skills/**/SKILL.md` creations require a fitness floor even
  under low-stakes tier, to prevent skill-file spam?
- Does `CHECKER_VERIFIED=1` double as human-authored proof, or do we
  need a distinct `HUMAN_APPROVED=1` marker?
- Should the Undo button in §4.3 trigger a vcontext `revert-event`
  entry so self-evolve learns which auto-applies get rolled back?

Decision needed before implementation starts.
