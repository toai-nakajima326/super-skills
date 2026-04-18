#!/bin/bash
# test-auto-commit-gate.sh — exercise scripts/auto-commit-gate.sh in isolation.
#
# Does NOT invoke `git commit`. Instead, simulates the environment
# (staged file list + COMMIT_EDITMSG) that the gate would see, and
# asserts the exit code.
#
# Usage: bash scripts/test-auto-commit-gate.sh
# Exit 0 if all 4 cases pass; 1 otherwise.

set -u

GATE="$(cd "$(dirname "$0")" && pwd)/auto-commit-gate.sh"
[[ -x "$GATE" ]] || { echo "FAIL: gate not executable at $GATE"; exit 1; }

# Build a throwaway git repo so `git diff --cached --name-only` works
# without disturbing the real one.
TMP="$(mktemp -d -t autogate-XXXXX)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email test@example.com
git -C "$TMP" config user.name Test

# Seed: initial commit so HEAD exists.
mkdir -p "$TMP/skills/demo" "$TMP/docs" "$TMP/scripts"
echo "seed" > "$TMP/README.md"
git -C "$TMP" add README.md
git -C "$TMP" commit -q -m seed

PASS=0
FAIL=0
pass() { printf "  PASS: %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

# Helper: stage files, set commit msg, run gate, check exit.
#   run_case <label> <expected-exit> <msg> <env-prefix> <file1> [<file2> ...]
run_case() {
  local label="$1"; local expect="$2"; local msg="$3"; local envp="$4"; shift 4
  # Reset index.
  git -C "$TMP" reset -q --mixed HEAD >/dev/null
  # Materialize + stage each path.
  local p
  for p in "$@"; do
    mkdir -p "$(dirname "$TMP/$p")"
    echo "content-$label" > "$TMP/$p"
    git -C "$TMP" add -- "$p"
  done
  # Write commit message.
  echo "$msg" > "$TMP/.git/COMMIT_EDITMSG"
  # Invoke gate.
  local actual
  (
    cd "$TMP"
    export GIT_COMMIT_MSG_FILE="$TMP/.git/COMMIT_EDITMSG"
    eval "$envp" bash "$GATE" >/dev/null 2>&1
    echo $?
  ) > "$TMP/exit"
  actual="$(cat "$TMP/exit")"
  if [[ "$actual" == "$expect" ]]; then
    pass "$label (exit=$actual)"
  else
    fail "$label (expected=$expect, got=$actual)"
  fi
}

echo "=== auto-commit-gate.sh test suite ==="

# Case 1: low-stakes paths under [auto] → ALLOW (exit 0)
run_case \
  "Case1 low-stakes [auto] allowed" \
  0 \
  "[auto] feat: add demo skill" \
  "" \
  "skills/demo/SKILL.md" "docs/notes.md"

# Case 2: high-stakes path under [auto] without override → BLOCK (exit 1)
run_case \
  "Case2 high-stakes [auto] blocked" \
  1 \
  "[auto] test: touch vcontext-server" \
  "" \
  "scripts/vcontext-server.js"

# Case 3: high-stakes path under [auto] with HUMAN_APPROVED=1 → ALLOW
run_case \
  "Case3 HUMAN_APPROVED=1 overrides block" \
  0 \
  "[auto] test: touch vcontext-server" \
  "HUMAN_APPROVED=1" \
  "scripts/vcontext-server.js"

# Case 4: normal (non-[auto]) commit on high-stakes path → ALLOW (gate silent)
run_case \
  "Case4 non-[auto] commit bypasses gate" \
  0 \
  "feat: hand-edit vcontext-server" \
  "" \
  "scripts/vcontext-server.js"

echo ""
echo "=== Summary: $PASS pass, $FAIL fail ==="
[[ "$FAIL" -eq 0 ]]
