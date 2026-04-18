#!/bin/bash
# auto-commit-gate.sh — classify [auto]-tagged commits against high-stakes paths.
#
# Invoked by .git/hooks/pre-commit. Reads the commit message from
# $GIT_COMMIT_MSG_FILE (exported by the hook) and staged paths from git.
#
# Exit 0 → allow commit.
# Exit 1 → block commit (prints diagnostic to stderr).
#
# Bypass: HUMAN_APPROVED=1 wins unconditionally.
# See docs/design/2026-04-18-auto-commit-tag.md for the contract.

set -u

# --- 0. Human override wins unconditionally ---------------------------------
if [[ "${HUMAN_APPROVED:-0}" == "1" ]]; then
  exit 0
fi

# --- 1. Read commit message -------------------------------------------------
MSG_FILE="${GIT_COMMIT_MSG_FILE:-}"
if [[ -z "$MSG_FILE" || ! -f "$MSG_FILE" ]]; then
  # No message file means nothing to classify; allow.
  exit 0
fi

SUBJECT="$(head -n 1 "$MSG_FILE")"

# --- 2. Not an [auto] commit → not our business -----------------------------
if [[ ! "$SUBJECT" =~ ^\[auto\]\  ]]; then
  exit 0
fi

# --- 3. Collect staged files ------------------------------------------------
STAGED="$(git diff --cached --name-only)"
if [[ -z "$STAGED" ]]; then
  exit 0
fi

# --- 4. High-stakes path patterns (shell globs, one per line) ---------------
# Keep in sync with docs/design/2026-04-18-auto-commit-tag.md §4.1.
HIGH_STAKES_PATTERNS=(
  'scripts/vcontext-server.js'
  'scripts/vcontext-hooks.js'
  'scripts/aios-task-runner.js'
  'scripts/aios-learning-bridge.cjs'
  'scripts/self-evolve'          # prefix match (self-evolve.js, self-evolve-*.cjs, etc.)
  'scripts/mlx-'                 # prefix match (mlx-flux-server.py, mlx-chunk-server.py)
  'scripts/pre-commit-gate.sh'
  'scripts/auto-commit-gate.sh'
  'docs/policy/'                 # prefix match (everything under docs/policy/)
  '.claude/settings'             # prefix match (settings.json, settings.local.json)
  'package.json'
  'CLAUDE.md'
)

# --- 5. Scan staged files against patterns ----------------------------------
OFFENDERS=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  for pat in "${HIGH_STAKES_PATTERNS[@]}"; do
    # Exact match OR prefix match (patterns ending in / or - or without extension)
    if [[ "$path" == "$pat" ]] || [[ "$path" == "$pat"* ]]; then
      OFFENDERS+=("$path")
      break
    fi
  done
done <<< "$STAGED"

# --- 6. Decide ---------------------------------------------------------------
if [[ ${#OFFENDERS[@]} -gt 0 ]]; then
  {
    echo ""
    echo "[auto-commit-gate] BLOCKED"
    echo "  Commit message: $SUBJECT"
    echo "  High-stakes paths staged under [auto] tag:"
    for p in "${OFFENDERS[@]}"; do
      echo "    - $p"
    done
    echo ""
    echo "  Resolution options:"
    echo "    1. If this change was reviewed by a human:"
    echo "       HUMAN_APPROVED=1 git commit ..."
    echo "    2. Drop the [auto] prefix if this is a human commit."
    echo "    3. Remove the high-stakes paths from staging and commit them separately."
    echo ""
    echo "  See docs/policy/autonomous-commit-gate.md"
  } >&2
  exit 1
fi

exit 0
