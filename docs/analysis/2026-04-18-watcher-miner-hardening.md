# Watcher / Miner Hardening Analysis (M7)

Date: 2026-04-18
Scope: `scripts/new-feature-watcher.cjs`, `scripts/conversation-skill-miner.cjs`
Retroactive review reference: `docs/analysis/2026-04-18-autonomous-commits-retroactive-review.md`

## Summary

Severity: **LOW** (theoretical, no realized risk).

Both scripts were flagged KEEP-WITH-FOLLOWUP for (1) fragile JSON regex extraction and
(2) un-sanitized skill-name used in a path-shaped string. Investigation confirms:

- Neither script writes to the filesystem; both only POST `pending-patch` and
  `skill-suggestion` entries to vcontext (`http://127.0.0.1:3150/store`).
- The `target_path` field is display metadata inside the JSON content — the server's
  approve flow uses its own `FILE:/BEFORE:/AFTER:` schema and already has strict
  path validation (`vcontext-server.js:6603-6616`).
- `auto_approve: false` is always set; dashboard human review is required before any
  filesystem change.

So the risk is LOW: the two failure modes at worst produce a malformed/unusable
pending-patch entry that a human rejects at the dashboard. However, hardening is
still worthwhile because:

- Corrupt tag strings (e.g., `target:../../evil`) contaminate the vcontext tag index
  and may appear in search results.
- Fragile JSON regex can silently drop LLM output whose text contains a stray brace
  inside a string value, wasting an API call.
- Defense-in-depth: if the downstream approve flow ever shifts to using `target_path`
  directly, these hardening measures become load-bearing.

## Concrete risk sites

### 1. `new-feature-watcher.cjs`

**Fragile JSON regex (line 191):**
```js
const raw = await callLLM(prompt);
const match = raw.match(/\{[\s\S]*\}/);
if (!match) return [];
try {
  const parsed = JSON.parse(match[0]);
```
If LLM returns ` ```json\n{...}\n``` ` or `Here is the output:\n{...}\nNote: ...`,
the regex will match a superset span including non-JSON noise and fail `JSON.parse`.

**Unsanitized skill name in target_path and tag (lines 307, 319):**
```js
target_path: `skills/${tool.name}/SKILL.md`,
tags: ['pending-patch', `source:new-feature-watcher`, `target:${tool.name}`, ...]
```
`tool.name` comes straight from the LLM JSON; no regex validation.
Theoretical inputs: `"../../etc/passwd"`, `"; rm -rf /"`, 500-char strings, empty
string, non-string (e.g., `null` / object).

### 2. `conversation-skill-miner.cjs`

Same two patterns:
- Line 224: `const match = raw.match(/\{[\s\S]*\}/);`
- Line 329: `target_path: \`skills/${cand.name}/SKILL.md\``
- Line 344: `\`target:${cand.name}\``

### 3. Frontmatter extraction (both scripts)

`generateSkillMd` uses `raw.match(/^---[\s\S]*?---[\s\S]*/m)`. If the LLM emits
markdown without frontmatter, we fall back to raw (already handled). Acceptable.

## Fixes applied

- Extracted a shared `scripts/lib/llm-parse.cjs` helper (CJS — the repo
  is `"type":"module"`, so library files need `.cjs` to be required from
  the two `.cjs` scripts).
- `extractJson(text)`: (1) try ` ```json ` fenced block, (2) try generic
  fenced block, (3) try whole-string `JSON.parse`, (4) fall back to
  first-`{` to last-`}` span (original behavior).
- `sanitizeSkillName(raw)`: **rejects** outright when the raw input
  contains path separators, shell metacharacters, or `..` — does not
  silently strip them (otherwise `../../etc/passwd` would become valid
  `etcpasswd`). After the reject check, normalizes cosmetic messiness
  (case, underscores, whitespace), then checks
  `^[a-z0-9][a-z0-9-]{1,63}$`.
- Path-traversal defense-in-depth: `assertSkillPathSafe(root, name)`
  resolves the joined path and throws if it escapes the root.

### Lines changed

**`scripts/new-feature-watcher.cjs`** (+22, -4):
- L20: import from new lib.
- L191-206: `detectNewTools` now uses `extractJson` and filters
  through `sanitizeSkillName`.
- L304-312: `main` asserts `assertSkillPathSafe` before queuing
  the pending-patch.

**`scripts/conversation-skill-miner.cjs`** (+24, -6):
- L22: import from new lib.
- L224-241: `inferSkillCandidates` uses `extractJson` + `sanitizeSkillName`.
- L325-333: `main` asserts `assertSkillPathSafe` before queuing.

**`scripts/lib/llm-parse.cjs`** (new, 105 lines).

## Test

`scripts/test-watcher-miner-hardening.sh` — 21 assertions covering:
- Pure JSON, fenced json/generic, prose + JSON, embedded brace, empty input.
- Normal kebab-case, uppercase normalization, underscore/whitespace
  normalization, leading/trailing hyphen stripping.
- Path traversal (`../../../etc/passwd`), shell metacharacters
  (`; rm -rf /`), over-length (80 chars), under-length (1 char),
  empty, non-string, all-hyphen.
- 64-char boundary (accepted).
- `assertSkillPathSafe` with normal and traversal inputs.

Current result: **21/21 PASS**, exit 0.
