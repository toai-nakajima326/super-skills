# `[auto]` Commit Tag Contract — Design

Status: **Implemented (Phase 1–5 of Option C)** · Owner: user · Created: 2026-04-18
Related: `docs/policy/autonomous-commit-gate.md` §3 Option C, §4

## 1. Purpose

Distinguish autonomously-produced commits from human-authored commits at
the `main` branch level so a tiered trust gate can enforce different
rules for low-stakes vs high-stakes changes, per `autonomous-commit-gate.md`.

## 2. Tag format

### 2.1 Literal prefix
Autonomous commits MUST begin the subject line with the exact 7-character
string `[auto] ` (open bracket, lowercase `auto`, close bracket, single
space). Example:

    [auto] feat: add mcp-tool-design skill (fitness=0.87)

### 2.2 Detection regex
Canonical match: `^\[auto\]` (anchored at subject start).

- `[auto]feat: ...` (no space) → **not** recognized. The space is
  required so subjects render cleanly in `git log --oneline`.
- `chore: [auto] ...` (tag mid-subject) → **not** recognized.
- `  [auto] ...` (leading whitespace) → **not** recognized. Commits
  written by scripts never have this, so it is an error signal.

### 2.3 Body trailers (recommended, not enforced)
Autonomous committers SHOULD include:

    Auto-Applied-By: <loop-name>
    Fitness: <float>
    Source: <origin-identifier>

These are trailers for downstream filtering (`git log --grep=
'^Auto-Applied-By:'`), not part of the gate contract. The gate only
inspects the subject line.

## 3. Gate behavior (pseudo-code)

    subject := first line of commit message
    is_auto := subject matches /^\[auto\] /

    IF env HUMAN_APPROVED=1:
      ALLOW (human override wins over everything)
    ELIF is_auto:
      staged := git diff --cached --name-only
      IF any staged path matches HIGH_STAKES_PATHS:
        BLOCK with diagnostic listing the offending path(s)
      ELSE:
        ALLOW (low-stakes auto commit)
    ELSE:
      ALLOW (human-authored, existing CHECKER_VERIFIED etc. still apply)

The gate is additive — existing `CHECKER_VERIFIED=1` and
`INFINITE_SKILLS_OK=1` hooks run independently and remain unchanged.

## 4. Classification — exact path patterns

Source of truth: `scripts/auto-commit-gate.sh` `HIGH_STAKES_PATHS`
array. Documented here for human reference.

### 4.1 HIGH-stakes (blocked under `[auto]` without `HUMAN_APPROVED=1`)

Matched via shell glob against each staged path:

| Pattern | Rationale |
|---------|-----------|
| `scripts/vcontext-server.js` | Core memory server — corrupting this loses all vcontext recall |
| `scripts/vcontext-hooks.js` | Hook orchestration — silent breakage cascades |
| `scripts/aios-task-runner.js` | Task scheduler — affects every background loop |
| `scripts/aios-learning-bridge.cjs` | The committer itself; self-modification requires review |
| `scripts/self-evolve*` | Self-evolve mechanism — amplifies bugs across cycles |
| `scripts/mlx-*-server.*` | MLX inference servers — port conflicts, model loading |
| `scripts/pre-commit-gate.sh` | The gate itself |
| `scripts/auto-commit-gate.sh` | This gate |
| `~/Library/LaunchAgents/com.vcontext.*.plist` | LaunchAgent scheduling — OS-level |
| `docs/policy/**` | Policy docs — authoritative contracts |
| `.claude/settings*.json` | Claude Code harness config |
| `package.json` | Dependency graph |
| `CLAUDE.md` | Global instructions |

### 4.2 LOW-stakes (auto-allowed under `[auto]`)

Implicit — any staged path NOT matching §4.1. Typical examples:

- `skills/**/SKILL.md` (new or updated skills)
- `docs/**` except `docs/policy/**` (analysis, design, runbooks)
- `data/**/*.json` (loop output: skill-discovery, locomo, etc.)
- `docs/analysis/**` (session reports)

## 5. Bypass rules

| Situation | Outcome |
|-----------|---------|
| `HUMAN_APPROVED=1` env set | ALLOW regardless of tag or paths |
| Commit has no `[auto]` prefix | Gate does nothing; pre-existing gates still apply |
| `[auto]` + only low-stakes paths | ALLOW |
| `[auto]` + any high-stakes path, no override | BLOCK with path list |

The `HUMAN_APPROVED=1` override exists for the case where a human
operator deliberately lands a high-stakes change on behalf of an
autonomous source (e.g., replaying a queued patch after review).

## 6. Non-goals

- **Commit history rewriting** — the gate only inspects incoming
  commits; it never modifies past commits.
- **Force-push protection** — out of scope; `pre-push` hook territory.
- **Content inspection** — the gate matches by path only, not diff
  content. A hostile diff to a "low-stakes" file would still land.
  Defense in depth is `quality-gate` + `checker-agent`, not this hook.

## 7. Conflict analysis

- Existing `.git/hooks/post-commit` → no conflict (different phase).
- `scripts/pre-commit-gate.sh` is a Claude **PreToolUse** hook (reads
  stdin JSON from the harness), NOT a git `.git/hooks/pre-commit` hook.
  The new `auto-commit-gate.sh` is the git-side hook. They run in
  different process contexts and do not share state.
- Both the PreToolUse gate and the git hook fire on `git commit`; a
  commit blocked by the PreToolUse gate never reaches the git hook.
  Order is: harness env check → git staging → git hooks. Safe to stack.
