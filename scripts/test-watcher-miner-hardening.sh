#!/usr/bin/env bash
# test-watcher-miner-hardening.sh
#
# Unit tests for scripts/lib/llm-parse.js — exercises extractJson() and
# sanitizeSkillName() / assertSkillPathSafe() with malformed, malicious,
# and legitimate inputs. Exit 0 on all PASS.
#
# Usage: bash scripts/test-watcher-miner-hardening.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/lib/llm-parse.cjs"

if [[ ! -f "${LIB}" ]]; then
  echo "FAIL: ${LIB} not found"
  exit 1
fi

PASS=0
FAIL=0
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    printf 'PASS %s\n' "${label}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "${label}" "${expected}" "${actual}"
    FAIL=$((FAIL + 1))
  fi
}

# Write a temp .cjs file (so require() works inside Node "type":"module" repos)
# and run it. Silences stderr on expected rejections so tests stay readable.
run_node() {
  local snippet="$1"
  local tmpf="${TMPDIR_TEST}/t_$$_${RANDOM}.cjs"
  printf '%s\n' "${snippet}" > "${tmpf}"
  node "${tmpf}" 2>/dev/null
  local rc=$?
  rm -f "${tmpf}"
  return ${rc}
}

# ── extractJson tests ─────────────────────────────────────────────

# Pure JSON
out=$(run_node "
const { extractJson } = require('${LIB}');
const r = extractJson('{\"tools\":[{\"name\":\"foo\",\"confidence\":0.9}]}');
process.stdout.write(r ? r.tools[0].name : 'null');
")
check "extractJson: pure JSON" "foo" "${out}"

# Fenced ```json block
out=$(run_node "
const { extractJson } = require('${LIB}');
const input = '\`\`\`json\n{\"tools\":[{\"name\":\"bar\"}]}\n\`\`\`';
const r = extractJson(input);
process.stdout.write(r ? r.tools[0].name : 'null');
")
check "extractJson: fenced json block" "bar" "${out}"

# Fenced generic block
out=$(run_node "
const { extractJson } = require('${LIB}');
const input = '\`\`\`\n{\"tools\":[{\"name\":\"baz\"}]}\n\`\`\`';
const r = extractJson(input);
process.stdout.write(r ? r.tools[0].name : 'null');
")
check "extractJson: fenced generic block" "baz" "${out}"

# Prose before/after
out=$(run_node "
const { extractJson } = require('${LIB}');
const input = 'Here is the output:\n{\"tools\":[{\"name\":\"qux\"}]}\nNote: reviewed.';
const r = extractJson(input);
process.stdout.write(r ? r.tools[0].name : 'null');
")
check "extractJson: prose + JSON fallback" "qux" "${out}"

# Nothing parseable
out=$(run_node "
const { extractJson } = require('${LIB}');
const r = extractJson('no json here, sorry');
process.stdout.write(r === null ? 'null' : 'notnull');
")
check "extractJson: no JSON" "null" "${out}"

# Empty / bad types
out=$(run_node "
const { extractJson } = require('${LIB}');
const a = extractJson('');
const b = extractJson(null);
const c = extractJson(undefined);
process.stdout.write([a,b,c].every(x => x === null) ? 'all-null' : 'fail');
")
check "extractJson: empty/null/undefined" "all-null" "${out}"

# Embedded brace inside a string value — original regex would be OK here,
# just confirming we don't regress.
out=$(run_node "
const { extractJson } = require('${LIB}');
const input = '{\"msg\":\"has } brace in string\",\"n\":\"ok\"}';
const r = extractJson(input);
process.stdout.write(r ? r.n : 'null');
")
check "extractJson: brace inside string value" "ok" "${out}"

# ── sanitizeSkillName tests ───────────────────────────────────────

# Legit
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('normal-skill-name')));
")
check "sanitizeSkillName: normal" "normal-skill-name" "${out}"

# Uppercase → lowercase
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('UPPER-Case')));
")
check "sanitizeSkillName: uppercase normalized" "upper-case" "${out}"

# Underscore / whitespace → hyphen
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('my_fancy skill')));
")
check "sanitizeSkillName: _/ws normalized" "my-fancy-skill" "${out}"

# Path traversal
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('../../../etc/passwd')));
")
check "sanitizeSkillName: ../../../etc/passwd rejected" "null" "${out}"

# Shell metacharacters
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('; rm -rf /')));
")
check "sanitizeSkillName: shell metachars rejected" "null" "${out}"

# Over-length
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
const long = 'a'.repeat(80);
process.stdout.write(String(sanitizeSkillName(long)));
")
check "sanitizeSkillName: 80-char rejected" "null" "${out}"

# Exactly 64 chars (upper bound of allowlist)
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
const ok64 = 'a'.repeat(64);
process.stdout.write(String(sanitizeSkillName(ok64)));
")
check "sanitizeSkillName: 64-char accepted" "$(printf 'a%.0s' {1..64})" "${out}"

# Empty
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('')));
")
check "sanitizeSkillName: empty rejected" "null" "${out}"

# Non-string
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
const a = sanitizeSkillName(null);
const b = sanitizeSkillName(42);
const c = sanitizeSkillName({ name: 'x' });
process.stdout.write([a,b,c].every(x => x === null) ? 'all-null' : 'fail');
")
check "sanitizeSkillName: non-string rejected" "all-null" "${out}"

# Single char (too short — needs 2+)
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('a')));
")
check "sanitizeSkillName: 1-char rejected" "null" "${out}"

# Leading hyphen stripped, result must still pass
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('---foo---')));
")
check "sanitizeSkillName: leading/trailing - stripped" "foo" "${out}"

# Starts with hyphen only (all hyphens) → rejected
out=$(run_node "
const { sanitizeSkillName } = require('${LIB}');
process.stdout.write(String(sanitizeSkillName('----')));
")
check "sanitizeSkillName: all-hyphen rejected" "null" "${out}"

# ── assertSkillPathSafe tests ─────────────────────────────────────

out=$(run_node "
const { assertSkillPathSafe } = require('${LIB}');
try {
  const p = assertSkillPathSafe('/tmp/skills-root', 'normal-skill');
  process.stdout.write(p.endsWith('/normal-skill/SKILL.md') ? 'ok' : 'bad-path');
} catch (e) { process.stdout.write('threw:' + e.message); }
")
check "assertSkillPathSafe: normal accepted" "ok" "${out}"

# Pre-sanitized traversal — shouldn't reach here normally, but confirm the guard
out=$(run_node "
const { assertSkillPathSafe } = require('${LIB}');
try {
  assertSkillPathSafe('/tmp/skills-root', '../evil');
  process.stdout.write('no-throw');
} catch { process.stdout.write('threw'); }
")
check "assertSkillPathSafe: ../evil throws" "threw" "${out}"

# ── Summary ───────────────────────────────────────────────────────
printf '\n%d PASS / %d FAIL\n' "${PASS}" "${FAIL}"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
