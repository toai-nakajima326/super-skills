# Autonomous Commits — Retroactive Review (2026-04-18)

Status: **Review complete** · Reviewer: Claude Opus 4.7 (1M) · Scope: 6 un-gated commits landed on `main` on 2026-04-18 · Policy: `docs/policy/autonomous-commit-gate.md` §5 (Option C — Tiered Trust)

## Commit roster

| # | Hash       | Subject                                                                                  | Author                        |
|---|------------|------------------------------------------------------------------------------------------|-------------------------------|
| 1 | `8508eec`  | feat: add claude-design skill — Anthropic's visual creation tool (launched 2026-04-17)   | toai-nakajima + Claude 4.6    |
| 2 | `75300d3`  | feat: new-feature-watcher — daily scanner for ALL AI tools, products, and concepts       | toai-nakajima + Claude 4.6    |
| 3 | `c8e5a80`  | feat: conversation-skill-miner — infer skills from user's own conversation history       | toai-nakajima + Claude 4.6    |
| 4 | `a523bf5`  | fix: update internal references to .cjs after rename (ESM incompatibility)               | toai-nakajima + Claude 4.6    |
| 5 | `5e03f79`  | merge: weekly skill-discovery LaunchAgent pipeline                                       | toai-nakajima (merge only)    |
| 6 | `99e8820`  | feat: weekly skill-discovery LaunchAgent pipeline                                        | toai-nakajima + Claude 4.6    |

All carry `Co-Authored-By: Claude Sonnet 4.6` in message body; authorship is user-identity. Per policy §2.3, these are **Claude Code agent-session commits** (not daemon-bridge commits).

---

## 1. `8508eec` — claude-design skill

**Classification**: **LOW stakes** — new `skills/claude-design/SKILL.md` (141 lines) + 1-line append to `skills/infinite-skills/SKILL.md` P5 routing. Both paths are in the low-stakes allowlist (§3 Option C).

**What it does**: Documents Anthropic's `claude.ai/design` tool (LP / prototype / pitch-deck generation, Claude Opus 4.7 backing). Adds `claude-design` trigger to infinite-skills P5 routing with JP+EN keywords (`LP/landing page/prototype/pitch deck/ピッチデッキ/デザイン/visual/スライド/マーケティング資料`).

**Risk check**:
- Frontmatter is well-formed (`name:`, `description:` block, `origin: unified`).
- No secrets, no shell execution, no network calls — pure documentation.
- Time-sensitive claim: "launched 2026-04-17" and "Claude Opus 4.7 ベース" — consistent with the user's global `verify-before-assert` rule. The commit message asserts product launch date; per `CLAUDE.md` this would ideally carry a SearXNG-verified source. Not verified in-commit, but low blast radius (docs only).
- P5 routing append preserves trailing existing entries (verified by diff).

**Recommendation**: **KEEP**.

**Rationale**: Additive low-stakes doc. Matches policy §5 prior appraisal ("Keep"). No regression vector.

---

## 2. `75300d3` — new-feature-watcher.js

**Classification**: **HIGH stakes** — new `scripts/new-feature-watcher.js` (368 lines). Under §3 Option C, new scripts that touch vcontext (`POST /store`) and shell out to LaunchAgents count as infrastructure, not skill files. (The exact path is not in the explicit high-stakes list `vcontext-server.js` / hooks / plist, but it is clearly cognitive-substrate infrastructure per CLAUDE.md §AIOS-Connected Work; treat as high-stakes.) Secondary path `skills/skill-discovery/SKILL.md` is low-stakes doc-append.

**What it does**: Daily scanner (LaunchAgent `com.vcontext.new-feature-watcher`, 10:00) that queries SearXNG across 9 AI/product/JP sources, runs MLX Qwen3-8B (port 3162) with Haiku fallback to classify "new tool" candidates (confidence≥0.7), auto-generates SKILL.md drafts, and writes them as `pending-patch` (fitness capped at `confidence * 0.75`) plus `skill-suggestion` entries. Commit message claims "38 sources" but diff shows `WATCH_SOURCES` array of 9; the "38" likely refers to distinct engine/site combinations produced by SearXNG aggregation — mild marketing in the commit msg, not a code defect.

**Risk check**:
- Explicitly sets `auto_approve: false` on every pending-patch — requires dashboard review. **Safety preserved.**
- Vcontext health gate present (skips if `/health` not healthy).
- Uses `ANTHROPIC_API_KEY` env var; no hard-coded secret. Good.
- `https` required only when Claude API path is hit (fallback); main flow is local MLX. Good.
- Dedup by URL (correct).
- `fitness ≤ 0.75` means it would never auto-apply under `aios-learning-bridge` threshold (≥0.85). Consistent with "human-review required" design.
- JSON parsing of LLM output is defensive (regex `\{[\s\S]*\}` + try/catch; returns `[]` on failure) but unsafe if model emits a code-fence block wrapping JSON with a prior `{` inside prose — could mis-parse. Minor robustness concern, not blocking.
- No input validation on `tool.name` before using in `target_path: skills/${tool.name}/SKILL.md` — if the LLM emits something like `../evil`, the path could escape. However, this is consumed by `pending-patch` review (not auto-applied), so a human reviewer would catch it. Note for follow-up.

**Recommendation**: **KEEP-WITH-FOLLOWUP**.

**Rationale**: Matches policy §5 prior appraisal ("Keep but flag"). The concerns above (path validation, JSON parse brittleness) are non-critical because the pipeline terminates at human review. File a followup: add `name.match(/^[a-z0-9-]+$/)` guard before `target_path` interpolation.

---

## 3. `c8e5a80` — conversation-skill-miner.js

**Classification**: **HIGH stakes** — same profile as commit 2 (new script 373 lines, talks to vcontext + MLX, runs under LaunchAgent).

**What it does**: Complementary miner — analyzes vcontext conversation history (types: `user-prompt`, `assistant-response`, `session-summary`, `skill-gap`, `skill-suggestion`, `pain-point`, `unresolved-question`), asks LLM to extract repeated patterns (frequency≥2 AND confidence≥0.5), auto-generates SKILL.md drafts, and writes `pending-patch` entries at fitness ≤0.70 (slightly lower than watcher, reflecting higher uncertainty). Runs daily 11:00. Per commit msg: explicit rationale quote from user — "even if utility is unclear, create the skill — users can't use what doesn't exist."

**Risk check**:
- Same `auto_approve: false` + fitness ≤ 0.70 cap → mandatory human review. Safe.
- Same `ANTHROPIC_API_KEY` env discipline; MLX first, Claude fallback.
- `/recall?type=<type>&limit=100` loops 7 times → up to 700 records × 500 chars = 350 KB prompt input. Could exceed MLX context at worst case; code slices per-record to 500 chars (good) but does not cap total prompt size. Minor scalability concern.
- Same LLM-output JSON parse fragility as commit 2.
- Same `tool.name` / `candidate.name` path-traversal note as commit 2. (Same mitigation: human review gate.)
- **Noted by a follow-up commit already on main** (`208631b` fix: conversation-skill-miner — correct vcontext /recall endpoint usage). That fix is already landed — the miner as originally committed had a bug, which was patched within hours. This is a concrete example of a follow-up that should have been gated; policy as-written would have caught it.

**Recommendation**: **KEEP-WITH-FOLLOWUP**.

**Rationale**: Keep the script (bug already fixed). File follow-up (same as commit 2): name-sanitization guard + total-prompt cap for the miner. Matches policy §5 prior appraisal ("Keep but flag").

---

## 4. `a523bf5` — .cjs rename reference cleanup

**Classification**: **LOW stakes by mechanics** (rename-follow-up, no logic change), but touches paths in the **HIGH-stakes** tier: `scripts/aios-learning-bridge.cjs` and the `self-evolve` SKILL.md. Treat as HIGH under §3 Option C (aios-learning-bridge is explicitly enumerated).

**What it does**: 8-file mechanical rename follow-up. Updates `.js` → `.cjs` in: (a) spawn path inside `aios-learning-bridge.cjs` for `skill-query-generator`, (b) `GENERATOR_SCRIPT` constant + docstrings in `skill_query_trigger.py`, (c) docstring and usage-example updates in the 4 renamed scripts, (d) doc references in 3 SKILL.md files. Diff verified: all 29 insertions / 29 deletions are pure string swap; no control flow changes.

**Risk check**:
- Every change is a string substitution. No new imports, no deletions of functionality.
- `aios-learning-bridge.cjs:65` — critical line `const script = path.join(…'skill-query-generator.cjs')` — verified to point at the renamed file that exists on disk (commit ae1ce3f did the rename). Consistent.
- Commit message claims LaunchAgent plists re-bootstrapped outside repo — not verifiable from this commit alone, but consistent with the repo keeping plists in `~/Library/LaunchAgents/`.
- Commit message claims both new-feature-watcher.cjs and conversation-skill-miner.cjs "load as CommonJS and reach their search/collect stages" — smoke-test assertion, not verifiable from diff. Reasonable.

**Recommendation**: **KEEP**.

**Rationale**: Mechanical rename — low regression risk. The high-stakes tier flag is technically applicable, but the content is purely a path-string fix for an existing breakage (ESM/CJS mismatch introduced by ae1ce3f). Policy §5 prior appraisal: "Keep. Low risk." Agree.

---

## 5. `5e03f79` — merge: skill-discovery LaunchAgent pipeline

**Classification**: **Merge commit, no new code**. The merge is between `08406cf` (docs: DB merge spec) and `99e8820` (feat: skill-discovery pipeline — reviewed separately below).

**What it does**: Non-fast-forward merge bringing `99e8820` onto main. Zero file changes in the merge commit itself (`git show` returns only commit metadata).

**Risk check**: Trivially none — merge commits don't introduce new content. The substantive review target is `99e8820`.

**Recommendation**: **KEEP**.

**Rationale**: Pure merge bookkeeping.

---

## 6. `99e8820` — skill-discovery.sh weekly pipeline

**Classification**: **HIGH stakes** — new 256-line bash script (`scripts/skill-discovery.sh`) that runs under a LaunchAgent plist (`com.vcontext.skill-discovery`, mentioned in commit msg), shells out to `curl` against vcontext, MLX, GitHub, and optionally Exa, and parses HTML. Under §3 Option C, LaunchAgent-backed scripts that write to vcontext are cognitive-substrate infra.

**What it does**: Monday 09:30 weekly pipeline: (1) GitHub trending fetch via HTML regex; (2) optional Exa search if `EXA_API_KEY` set, using a 6-topic allowlist; (3) fetch skill-registry from vcontext; (4) MLX gap-analysis prompt via Qwen3-8B; (5) save result JSON to `~/skills/data/skill-discovery/YYYY-MM-DD.json`; (6) parse `CANDIDATE:/DESCRIPTION:/SOURCE:/PRIORITY:` structured LLM output and register each as a `skill-gap` entry with `status: candidate`. **Explicit safety: never creates SKILL.md files.** Skips execution if vcontext `/health` fails.

**Risk check**:
- Uses `set -u` (undefined var = error) but not `set -e` — silent failures possible on curl timeouts. Mostly handled explicitly with `|| pass` patterns in Python parsers.
- Exports prompt payloads via env vars (`_SD_*`) to avoid heredoc quoting issues — clean technique, avoids shell injection.
- HTML regex parsing of GitHub trending is brittle (GitHub's HTML could change) but fallback text `(GitHub trending unavailable)` is handled.
- Exa API key read via `${EXA_API_KEY:-}` — not logged, safe. Only used if set (graceful degradation).
- Writes to `$HOME/skills/data/skill-discovery/$DATE.json` — path is under user home, no traversal concern.
- `osascript` notifications attempted with `2>/dev/null` suppressed — good for environments without `osascript`.
- All vcontext writes go through `POST /store` with `type: skill-gap` and an explicit `"Human review required before SKILL.md creation."` note embedded in content. Safety-preserving.
- No explicit timeout on MLX `/v1/chat/completions` beyond `curl --max-time 120` — generous but not infinite. OK.
- Commit msg says "Monday 09:30" but the plist itself is not in the repo (mentioned as being in `~/Library/LaunchAgents/` outside repo). Cannot spot-check schedule from diff.

**Recommendation**: **KEEP**.

**Rationale**: The safety constraint ("never creates SKILL.md files") is enforced by construction — the script only writes `skill-gap` entries with `status: candidate` and a human-review note. This aligns exactly with the policy §3 description of `skill-discovery` as a loop that "does NOT commit." No regression risk.

---

## Aggregate

| Recommendation         | Count | Commits                                              |
|------------------------|-------|------------------------------------------------------|
| KEEP                   | 4     | `8508eec`, `a523bf5`, `5e03f79`, `99e8820`           |
| KEEP-WITH-FOLLOWUP     | 2     | `75300d3`, `c8e5a80`                                 |
| REVERT                 | 0     | (none)                                               |

**Cross-cutting concerns**:

1. **LLM-output JSON parsing is fragile across both watchers** (commits 2, 3). The `match(/\{[\s\S]*\}/)` pattern is greedy and can mis-match when the model emits JSON inside a code fence that itself contains braces in prose. Not a safety issue because the output is quarantined to `pending-patch` behind human review, but worth hardening — file one combined followup.

2. **No input sanitization on LLM-proposed skill names before path interpolation** (commits 2, 3). Same mitigation (human review). Same followup — add `/^[a-z0-9-]+$/` guard.

3. **All commits follow `Co-Authored-By: Claude Sonnet 4.6` format**, not the `Auto-Applied-By:` trailer format that policy §4.1 will require for daemon commits. This is correct per policy §2.3 (these are agent-session commits, not daemon commits); the policy already distinguishes the two.

4. **Policy §5 migration path says "no history rewrite"** — agreed. Retagging these hashes to `[auto]` is not recommended; they are already referenced in `docs/analysis/2026-04-18-phase-integrated-review.md` and `docs/policy/autonomous-commit-gate.md`.

5. **Forward action** (per policy §5): the policy's own recommendation — "add a note to the evolution log acknowledging the gap and referencing this policy" — is not done in any of these 6 commits and remains pending.

## Revert commands (none required)

No REVERT recommendations. For reference only, if the user later decides otherwise, these would be:

```bash
# Example revert command (do NOT run):
# git revert 8508eec --no-edit  # claude-design skill
# git revert 75300d3 --no-edit  # new-feature-watcher
# git revert c8e5a80 --no-edit  # conversation-skill-miner
# git revert a523bf5 --no-edit  # .cjs reference update
# git revert 99e8820 --no-edit  # skill-discovery pipeline
# (5e03f79 is a merge — requires `git revert -m 1 5e03f79`)
```

## Open items for a future session

- File a single followup issue: "harden LLM-output parsing + skill-name sanitization in new-feature-watcher and conversation-skill-miner."
- Add "evolution log acknowledgement" entry referencing `docs/policy/autonomous-commit-gate.md` (per §5 forward action).
- Once `pre-commit-gate.sh` §4.2 enforcement lands, verify it would have blocked `75300d3`, `c8e5a80`, and `99e8820` without `HUMAN_APPROVED=1`.
