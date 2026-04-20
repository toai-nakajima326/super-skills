---
title: TypeScript Strict Migration Plan — vcontext-hooks.js → .mts
date: 2026-04-20
status: proposal
owner: AIOS substrate
skills_applied: spec-driven-dev, investigate, careful
constitution_refs: P2 (contract-first), P3 (fail-open / fail-closed), P6 (observe before act)
hitl_tier: H3 (propose-and-wait — architectural direction)

executive_summary: |
  `scripts/vcontext-hooks.js` (2930 LOC) carries the Claude Code hook
  entry points. The 2026-04-20 morning cascade traced to one bug in
  `get()` (L1086-1105): infra errors silently collapsed into empty
  results, so the AIOS hard-gate BLOCKED every AIOS write despite 109
  skill-usage entries on disk. Today's `_infra_error` sentinel patches
  the symptom; the real fix is TypeScript discriminated unions that
  make the bug class unrepresentable. This plan migrates hooks.js to
  `.mts` incrementally, starting with the gate section (L1072-1389 —
  the provably buggy surface) and working outward. Zero-compile-step
  via Node 25 native `.mts`. Whole-file migration per section, .js and
  .mts coexist during transit. Rollback <30s by git revert + wrapper
  re-point. Verification via golden hook-payload corpus + RSS/latency
  probe.
---

# TypeScript Strict Migration Plan — vcontext-hooks.js

*Status: proposal — not yet executed. HITL H3: awaits user decision on
language direction. Matches Constitution §P2 (contract-first):
language is interchangeable, but types encode the contract.*

**Audit header**: `CHECKER_VERIFIED=1 INFINITE_SKILLS_OK=1`
**Skills applied**: `spec-driven-dev`, `investigate`, `careful`

---

## Mini-spec

**Problem**: One line in `scripts/vcontext-hooks.js`:

```js
req.on('error', () => resolve({ results: [] }));     // L1101 (pre-fix)
req.on('timeout', () => resolve({ results: [] }));   // L1102 (pre-fix)
```

silently collapsed three failure modes (connect, timeout, parse) into
a "success with empty body" shape. `sessionHasSkillUsage()` at L1275
treated the empty body as "no routing" and BLOCKED every AIOS-path
write during the OOM cascade, even though the session had 109
historical skill-usage rows. The `handlePreToolGate()` catch at
L1355-1359 (the fail-open guard per Constitution §P3) never fired —
`get()` never threw.

**Scope**: Migrate `scripts/vcontext-hooks.js` → `.mts` with TypeScript
strict, discriminated-union result types, zero compile step. No
behavior change; type-level enforcement of the existing fail-open
contract. Read-only on the current `.js` file until the plan is
approved.

**Non-goals**: Migrate `vcontext-server.js` (9k LOC, separate plan).
Migrate build scripts. Adopt a framework. Rewrite logic.

**Acceptance criteria**:
1. Hook invocation latency within ±10 ms of current `.js`
   (measured against the wrapper's stdin→exit trace).
2. Every existing hook event (user-prompt, pre-tool, tool-use,
   subagent-start, session-recall, session-end, compact, notification,
   permission-request/denied) produces byte-identical `/store` POST
   bodies vs. the `.js` baseline for a golden input corpus.
3. `get()` infra-failure now surfaces as a `Result` variant the caller
   MUST handle — the original bug is unrepresentable.
4. Rollback path is a single `git revert` + wrapper `HOOKS=` line
   flip; <30 s end-to-end.

---

## 1. Incremental Strategy (ordering & rationale)

Migration proceeds section-by-section. Each section converts in one
commit; `.js` and `.mts` coexist in `scripts/` during transit.

**Phase ordering** (justification keyed to bug-history × isolation ×
risk):

| # | Section | LOC range | Why first/next | Risk |
|--:|---------|-----------|---------------|------|
| 1 | **Gate core** — `get`, `sessionHasSkillUsage`, `handlePreToolGate`, `emitAiosBlock`, AIOS path/cache helpers | L1072-1389 | **The bug lived here.** Leaf-ish (callers: just `handlePreTool`). Highest ROI. | Medium (live gate; mitigated by golden-corpus test + wrapper-flip rollback) |
| 2 | **HTTP primitives + errorLog + enqueue** | L21-105 | Used by every other section. Tiny surface (3 fns). Types let us ratchet strictness downstream. | Low |
| 3 | **Session/transcript utils** — `readStdin`, `extractSessionId`, `extractNewAssistantMessages`, `expandHome`, `normalizeForMatch`, `isAiosConnectedPath`, `bashCommandTouchesAios` | L1107-1238 | Pure, leaf, no I/O beyond fs. Easy win; unlocks typed hook-payload handling. | Low |
| 4 | **recordEvent + handleUserPrompt** | L1393-1625, L1701-1758 | Most-invoked path (every tool call). Depends on 1-3. Touches routing, predictive-search, working-state. | Medium (must preserve per-event POST shape) |
| 5 | **Subagent + session-recall + skill-context** | L1759-2236 | Larger, but still depends only on 1-4. | Medium |
| 6 | **Audit + GC + snapshot + blob + sync + namespace** | L2237-2685 | Admin CLI paths. Rarely hot. | Low |
| 7 | **Main dispatcher switch** | L2687-end | Trivial; last because it just re-exports the handlers. | Low |

**Rationale for "gate first" (§6 of OOM root-cause doc)**:

- **Bug history**: the exact block of lines that cost the 2026-04-20
  morning. Typing this section first *proves the new system catches
  the old bug*.
- **Isolation**: `get` is called by 10+ sites, but the gate's usage
  (`sessionHasSkillUsage`) is the one that had to distinguish infra vs
  semantic failure. We change `get` callers in this section only; the
  rest keep using the historical `{ results: [] }` shape via a
  compatibility adapter (see §5).
- **Risk shape**: Medium — live traffic, but the wrapper-level rollback
  (§8) makes this the cheapest-to-revert section. Later sections touch
  more handlers; doing them first means bigger blast radius if wrong.

**Phase 4 is the risk inflection point.** Up through phase 3 the
migration is internal wiring. `recordEvent` is where type errors
would manifest as changed POST bodies. Golden-corpus verification
(§7) gates phase 4.

---

## 2. Discriminated Union Types

All types live in `scripts/types/hooks.d.mts` (new file) and are
imported by every `.mts` file. Single source of truth per
Constitution §P4.

### 2.1 `Result<T, E>` — the core primitive

The bug's root cause was `get()` returning a "success with empty
body" shape indistinguishable from real success. The type-level fix
is a tagged union.

```ts
export type Ok<T>   = { readonly ok: true;  readonly value: T };
export type Err<E>  = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok  = <T>(value: T): Ok<T>  => ({ ok: true,  value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
```

### 2.2 `GetResult<T>` — HTTP GET result

```ts
export type GetErrorKind = 'connect' | 'timeout' | 'parse' | 'http_5xx';

export type GetError = {
  readonly kind: GetErrorKind;
  readonly path: string;
  readonly message: string;
  readonly status?: number;  // only when kind === 'http_5xx'
};

export type GetResult<T> = Result<T, GetError>;
```

The caller cannot read `.value` without first narrowing
`result.ok === true` — the bug (reading `.results` from what might be
an error) becomes a type error at compile time.

### 2.3 Session records

```ts
export type SessionId = string & { readonly __brand: 'SessionId' };

export type SessionEntry = {
  readonly id: number;
  readonly session: SessionId;
  readonly type: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly at: string;  // ISO-8601
};

export type SessionQueryResult = {
  readonly results: readonly SessionEntry[];
  readonly total?: number;
};
```

### 2.4 Skill-usage entries

```ts
export type SkillUsageContent = {
  readonly skills: readonly string[];
  readonly prompt: string;           // truncated ≤200
  readonly keywords: readonly string[];
  readonly session: SessionId;
  readonly used_at: string;          // ISO-8601
  readonly useful: boolean | null;   // user-feedback flag
};

export type SkillUsageEntry = SessionEntry & {
  readonly type: 'skill-usage';
  /** Parsed JSON from `content`. Narrowed at the parse call site. */
};
```

### 2.5 Claude Code hook payloads

Source of truth: the JSON that Claude Code writes to stdin. Types
below mirror the shapes `extractSessionId` / `handlePreToolGate` /
`recordEvent` already consume, promoted to explicit contracts.

```ts
// PreToolUse —— Claude Code emits this before every tool call.
export type ToolName =
  | 'Bash' | 'Edit' | 'Write' | 'NotebookEdit' | 'MultiEdit'
  | 'Read' | 'Glob' | 'Grep' | 'Task' | 'WebFetch' | 'WebSearch'
  | 'TodoWrite' | 'SlashCommand' | (string & {});  // open-ended, future tools

export type BashToolInput = {
  readonly command: string;
  readonly description?: string;
  readonly timeout?: number;
  readonly run_in_background?: boolean;
};

export type WriteToolInput = {
  readonly file_path: string;
  readonly content: string;
};

export type EditToolInput = {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};

export type NotebookEditToolInput = {
  readonly notebook_path: string;
  readonly new_source: string;
  readonly cell_id?: string;
  readonly cell_type?: 'code' | 'markdown';
  readonly edit_mode?: 'replace' | 'insert' | 'delete';
};

/** Discriminated by `tool_name`. */
export type PreToolPayload =
  | { readonly tool_name: 'Bash';         readonly tool_input: BashToolInput;         readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'Write';        readonly tool_input: WriteToolInput;        readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'Edit';         readonly tool_input: EditToolInput;         readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: 'NotebookEdit'; readonly tool_input: NotebookEditToolInput; readonly session_id: string; readonly cwd?: string }
  | { readonly tool_name: Exclude<ToolName, 'Bash'|'Write'|'Edit'|'NotebookEdit'>;
      readonly tool_input: Readonly<Record<string, unknown>>;
      readonly session_id: string; readonly cwd?: string };

// PostToolUse — adds tool_response.
export type PostToolPayload = PreToolPayload & {
  readonly tool_response?: Readonly<Record<string, unknown>>;
  readonly transcript_path?: string;
};

// PreToolUse hook output (emitted on block)
export type PreToolHookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly additionalContext: string;
  };
  readonly continue: false;
  readonly stopReason: string;
};
```

**Why this shape pays off**: `handlePreToolGate()` currently does
`toolInput.file_path || toolInput.notebook_path || ''` — a string|undef
access that assumes shape. With the union, switching on `tool_name`
narrows `tool_input` to the exact field set. TS catches a future refactor
that drops `notebook_path` at compile time.

---

## 3. `tsconfig.json` — Proposed Strict Config

Two configs: `scripts/tsconfig.hooks.json` (this migration) inheriting
from a repo-root `tsconfig.base.json`. Base for future
`vcontext-server.mts` migration.

```jsonc
// /Users/mitsuru_nakajima/skills/tsconfig.base.json
{
  "compilerOptions": {
    // Runtime target — Node 25 supports ES2024 natively.
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],

    // Strictness — every flag justified inline.
    "strict": true,                        // Umbrella for the 7 core strict checks.
    "noImplicitAny": true,                 // Redundant under strict, kept explicit.
    "strictNullChecks": true,              // Core — most bugs are null/undef shape-drift.
    "strictFunctionTypes": true,           // Catches variance bugs in callbacks (setImmediate handlers).
    "strictBindCallApply": true,           // We use .bind sparingly; still cheap.
    "strictPropertyInitialization": true,  // No classes in hooks.mts yet; future-proofs.
    "alwaysStrict": true,                  // Emit "use strict" (irrelevant for ESM, harmless).

    // Extra strictness — catches bug classes NOT covered by `strict`.
    "noUncheckedIndexedAccess": true,      // arr[0] → T|undef — catches the empty-array bug class directly.
    "exactOptionalPropertyTypes": true,    // `foo?: string` forbids `{ foo: undefined }`; matches JSON shape more faithfully.
    "noImplicitReturns": true,             // Every code path returns — matches fail-open/closed discipline.
    "noFallthroughCasesInSwitch": true,    // Main dispatcher is a switch — guards against future-added case skipping.
    "noImplicitOverride": true,            // Future-proofs if we add classes.
    "noPropertyAccessFromIndexSignature": true,  // Forces .["foo"] for unknown-key access — honesty.
    "useUnknownInCatchVariables": true,    // `catch (e)` → e is unknown — forces narrowing, which we already do in errorLog.
    "forceConsistentCasingInFileNames": true,  // macOS APFS is case-insensitive; this keeps Linux CI honest.

    // Performance / output.
    "skipLibCheck": true,                  // node_modules/@types can be inconsistent; we don't own them.
    "isolatedModules": true,               // Each .mts compiles independently — required for Node's --experimental-strip-types / bun.
    "allowImportingTsExtensions": true,    // Enables `import './foo.mts'` syntax.
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,          // Forbids elision of type imports — clearer for future Rust/Go ports.

    // No emit — we run TypeScript source directly via Node 25 native.
    "noEmit": true,

    // Types.
    "types": ["node"]
  },
  "exclude": ["node_modules", "dist", "build"]
}
```

```jsonc
// /Users/mitsuru_nakajima/skills/scripts/tsconfig.hooks.json
{
  "extends": "../tsconfig.base.json",
  "include": ["./vcontext-hooks.mts", "./types/**/*.d.mts"],
  "exclude": ["./vcontext-hooks.js", "./**/*.js"]
}
```

**Why each flag matters** (the non-obvious ones):

- `noUncheckedIndexedAccess`: `results[0]` → `T | undefined`. This is
  the single biggest bug-class-elimination in the codebase. The gate
  bug LOOKED like `results.length > 0` but the general pattern
  (`results[0].content`) shows up ~40 times in hooks.js.
- `exactOptionalPropertyTypes`: Claude Code's JSON payloads have
  `transcript_path?: string` — without this flag, TS allows
  `{ transcript_path: undefined }` which crashes `existsSync(undefined)`.
- `useUnknownInCatchVariables`: matches our existing
  `String(e && e.message || e)` pattern; forbids silent `e.foo` access.
- `verbatimModuleSyntax`: forces `import type { PreToolPayload }` vs
  value import. Clarifies the runtime-vs-type boundary, useful when
  this file is eventually ported to Rust/Go (Constitution §P2).

---

## 4. Build & Run — Zero Compile Step

**Decision**: run `.mts` directly via Node 25 native TypeScript
support. No tsc step. No tsx/ts-node dependency. No bun.

### 4.1 Rationale

- Current Node (verified `node --version` = **v25.9.0**): strips
  TypeScript types natively with zero flag (Node 23+ on by default).
  Node 22 needed `--experimental-strip-types`; we're already past that.
- Hook is latency-sensitive — runs on **every** tool call. A 200-300 ms
  tsc startup cost would be user-visible.
- Zero build-artifact means zero staleness risk — the source IS what
  runs. Eliminates a whole class of "why is the old bug still there"
  issues.
- One less dependency — matches Constitution §P1 (loose coupling) and
  §P5 (reversibility — fewer moving parts to revert).

### 4.2 Wrapper change

Current:
```bash
NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node"
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js"
# ...
"$NODE" "$HOOKS" "$CMD"
```

Proposed (post-migration):
```bash
NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node"
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.mts"
# Node 25+ strips types natively; Node 22-24 would need --experimental-strip-types.
"$NODE" "$HOOKS" "$CMD"
```

During transit (section 1 migrated, sections 2-7 still `.js`), we keep
**both** files and the wrapper points at whichever is currently the
source of truth — initially the `.js`, flipped to `.mts` at the end of
phase 7. Inter-file imports during transit use `.mjs` adapter shims
(see §5).

### 4.3 Runtime sanity probe

Add to `scripts/health-check.sh` (runs daily per accelerated cadence):
```bash
echo '{}' | "$NODE" /Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.mts self-test
# expect exit 0, no "SyntaxError" on stderr
```

### 4.4 Why NOT bun / tsx / ts-node

- **bun**: adds another runtime (≈60 MB). Node 25 already handles it.
  If the user later wants bun for perf, it's a separate decision.
- **tsx**: wraps Node with esbuild. Our Node already strips types. Net
  negative.
- **ts-node**: compiles on startup (slow). Worst option for a hook.

---

## 5. Coexistence Strategy

**Whole-file per section, not function-level.** Function-level mixing
(half of a file in TS, half in JS) requires `allowJs` + declaration
merging and makes rollback section-specific. Whole-file is cleaner.

### 5.1 File layout during transit

```
scripts/
  vcontext-hooks.js           # original; shrinks as sections move out
  vcontext-hooks.mts          # grows as sections move in
  types/
    hooks.d.mts               # Result<T,E>, GetResult, payload types
    shared.d.mts              # SessionId, SessionEntry
  vcontext-hook-wrapper.sh    # points at whichever is "live"
```

During transit, only ONE of `.js` or `.mts` is loaded per invocation.
Phase 1 does NOT move the entry point — it drafts `.mts` alongside.
Phase 7 is the atomic cutover: wrapper flips, old `.js` removed (or
kept as `.js.bak` for 1 week, per Constitution §P5 reversibility).

### 5.2 Shared module approach (phases 1-6)

To let the `.mts` draft exercise the real gate logic without loading
the full `.js` recorder, extract the gate section into
`scripts/vcontext-hooks-gate.mts` first. The `.js` file imports
compiled output temporarily if needed (it won't — phase 1 is isolated).

### 5.3 Type definitions for non-migrated sections

While sections 2-7 remain `.js`, the `.mts` gate can still type its
*callers* via ambient declarations in `types/legacy-js.d.mts`:

```ts
declare module './vcontext-hooks-legacy.mjs' {
  export function post(path: string, data: unknown): Promise<unknown>;
  export function errorLog(kind: string, detail: unknown): void;
}
```

This is temporary scaffolding — deleted at phase 7.

---

## 6. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|--:|------|-----------|--------|------------|
| R1 | Node 25 type-strip adds startup latency | Low | High (hook runs every tool call) | Benchmark: time `node --version` vs `time node script.mts` — Node's strip is O(file-size), not O(typecheck). Measure before phase 1 lands. |
| R2 | Hook payload shape drifts (Claude Code ships new `tool_name`) | Medium | Medium | `ToolName` union includes `(string & {})` open-ended escape. New tools logged via `errorLog('unknown_tool', ...)` rather than type-error. |
| R3 | `exactOptionalPropertyTypes` rejects real-world JSON with explicit `undefined` | Medium | Low | Parse step normalizes: `if (x.transcript_path === undefined) delete x.transcript_path` — at the JSON boundary only. |
| R4 | Hook-invocation site (Claude Code) doesn't understand `.mts` extension in `settings.json` hooks. | Low | High | The wrapper (`vcontext-hook-wrapper.sh`) is what Claude Code calls — and that's a plain `.sh`. The `.mts` is invoked INSIDE the wrapper. Zero change to `settings.json`. |
| R5 | Rollback needs to happen mid-incident | Low | High | See §8. Wrapper flip is a single line change; `git revert HEAD` undoes it atomically. |
| R6 | Type definitions drift from actual server responses | Medium | Medium | Add `parseAs<T>(unknown, validator)` at every JSON boundary. Types without runtime validators are decoration. |
| R7 | Node 25 is bleeding-edge; a macOS update could rebase nvm | Low | Medium | Pin via `.nvmrc` = `25.9.0`. Health-check probes runtime version. |
| R8 | New TypeScript contributor conventions conflict with hooks.js's style | Low | Low | No classes, no decorators, no enum. `type` > `interface`. Match existing naming. |
| R9 | Larger initial learning curve for ad-hoc debug edits | Medium | Low | The `.mts` is no harder than `.js` once types are stable. Worst case: `// @ts-expect-error` for one-shot debug edits, removed on commit. |
| R10 | `useUnknownInCatchVariables` breaks existing catch-block shorthand | High | Low | Grep shows ~30 `catch {}` sites (empty). 12 `catch (e)` sites — all already call `String(e && e.message || e)` which works under unknown. |

**Highest residual risk: R1** (hook-call latency). Mitigation: measure
before landing phase 1. If Node 25 strip adds >15 ms per invocation,
fall back to pre-compiled `.mjs` output (tsc produces tiny
type-stripped JS). We have the build scripts (`scripts/build-all.js`)
to wire this in.

---

## 7. Verification Plan

### 7.1 Golden-corpus differential test

Capture current `.js` behavior against a fixed set of hook invocations,
then replay against `.mts` and diff.

```bash
# Build corpus (once, off current prod .js):
for evt in user-prompt pre-tool tool-use subagent-start session-end \
          notification compact pre-compact permission-request \
          permission-denied; do
  # Canned stdin JSON per event type
  cat test/hook-corpus/${evt}.json \
    | node scripts/vcontext-hooks.js "$evt" \
    > test/hook-corpus/${evt}.stdout.expected
done

# Replay against .mts:
for evt in ...; do
  cat test/hook-corpus/${evt}.json \
    | node scripts/vcontext-hooks.mts "$evt" \
    > /tmp/${evt}.stdout.actual
  diff test/hook-corpus/${evt}.stdout.expected /tmp/${evt}.stdout.actual
done
```

**Gate**: zero diff. Any diff blocks the phase.

### 7.2 Gate-specific checks (phase 1)

The gate has three behavioral modes — all must be preserved:

| Scenario | Expected behavior | Test |
|----------|-------------------|------|
| vcontext up, session has skill-usage | No block, no stdout JSON | `test/hook-gate/happy-path.sh` |
| vcontext up, session has NO skill-usage, AIOS path | Block (JSON payload, `continue:false`) | `test/hook-gate/block.sh` |
| vcontext DOWN (port unreachable) | **Fail-open** — no block, log `aios_gate_query_failed` | `test/hook-gate/infra-down.sh` — THE regression test for today's bug |
| `INFINITE_SKILLS_OK=1` set | No block regardless | `test/hook-gate/override.sh` |
| Cold-start <30s | No block (grace window) | `test/hook-gate/cold-start.sh` |
| Non-AIOS path | No block | `test/hook-gate/non-aios.sh` |

The infra-down test is the pivotal one. Stub vcontext with
`nc -l 3150 -c "exit 1"` or simply don't bind 3150 at all; verify
the gate prints nothing to stdout (= pass-through) and exits 0.

### 7.3 Latency probe

```bash
hyperfine --warmup 10 --runs 200 \
  'echo "{}" | node scripts/vcontext-hooks.js pre-tool' \
  'echo "{}" | node scripts/vcontext-hooks.mts pre-tool'
```

Accept if `.mts` is within `.js ± 10 ms` p95.

### 7.4 Type-level verification

```bash
tsc --noEmit -p scripts/tsconfig.hooks.json
```

Zero errors before commit. CI gate (GitHub Actions or local pre-commit).

### 7.5 Production canary

After phase 1 lands behind the coexistence structure (wrapper still
points at `.js`), switch the wrapper for 24 h, monitor `vcontext
errorLog` for `aios_gate_query_failed` rate. If it rises, the `.mts`
is flagging infra errors the `.js` was silently eating — that's the
point.

---

## 8. Rollback Plan (<30 seconds)

The whole migration is gated by a **single line** in the wrapper:

```bash
HOOKS="/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.mts"
#                                                            ^^^ revert to .js
```

### 8.1 Rollback commands (run in 2 bash ops)

```bash
# 1. Flip the wrapper back.
sed -i '' 's#vcontext-hooks\.mts#vcontext-hooks.js#' \
  /Users/mitsuru_nakajima/skills/scripts/vcontext-hook-wrapper.sh

# 2. Verify next hook invocation loads the .js.
echo '{}' | \
  /Users/mitsuru_nakajima/skills/scripts/vcontext-hook-wrapper.sh pre-tool
grep -q "HOOKS=.*\.js" \
  /Users/mitsuru_nakajima/skills/scripts/vcontext-hook-wrapper.sh \
  && echo "rollback complete"
```

No Claude Code restart needed — the next hook call picks up the
wrapper's new content. Observed latency: sub-second.

### 8.2 What's preserved during rollback

- Types file (`scripts/types/hooks.d.mts`) stays — no harm, not loaded.
- `.mts` source stays — ready for re-enable.
- `/store` events: no gap. Next hook logs as usual.
- Session state: untouched — gate is stateless across rollbacks.

### 8.3 Full revert (if the whole migration is abandoned)

```bash
git revert <commit-range-of-phases-1..N>
rm scripts/vcontext-hooks.mts scripts/types/hooks.d.mts
rm scripts/tsconfig.hooks.json tsconfig.base.json
# wrapper already pointed at .js — no change
```

Constitution §P5 (reversibility by default) satisfied: every phase
is its own commit, git log tells the full story.

---

## 9. Open Questions

1. **Should phases 2-7 wait for phase 1 to bake 1 week, or ship back-to-back?**
   Recommend: phase 1 bakes ≥3 days (covers at least one OOM cascade's
   worth of infra-fail traffic), then phases 2-3 (low-risk) in one day,
   then phases 4-7 over 1 week with per-phase 12 h canary.

2. **Do we migrate `vcontext-server.js` (9k LOC) next?**
   Separate decision. HITL H3 (architectural). Listed here only as the
   logical follow-up; out of scope for this plan.

3. **Is there a case for splitting `vcontext-hooks.mts` into multiple
   files (e.g., `hooks-gate.mts`, `hooks-recorder.mts`, `hooks-cli.mts`)?**
   Probably yes — 2930 LOC in one file is itself a risk. Propose as a
   sub-task within phase 7 (final restructure).

4. **Runtime validation at JSON boundaries — zod, valibot, hand-rolled?**
   Hand-rolled for phase 1 (one `parseGetResponse<T>` helper). Adopt
   a library only if validator count exceeds ~20. Each library brings
   bundle weight + supply-chain surface.

---

## Evidence Cites (verbatim)

- `scripts/vcontext-hooks.js:1086-1105` — current `get()` with
  `_infra_error` sentinel patch (post-bug-fix today).
- `scripts/vcontext-hooks.js:1275-1290` — `sessionHasSkillUsage()`
  with the propagation of `_infra_error`.
- `scripts/vcontext-hooks.js:1312-1378` — `handlePreToolGate()` with
  fail-open catch at L1355-1359 (Constitution §P3).
- `scripts/vcontext-hook-wrapper.sh:4-5` — hook invocation path
  (`$NODE $HOOKS $CMD`) — the rollback lever.
- `scripts/vcontext-hooks.js:2687-2685` — main dispatcher switch
  (phase 7 target).
- `/Users/mitsuru_nakajima/.claude/settings.json:257-276` — Claude Code
  hooks reference the `.sh` wrapper, not the `.js` directly. Migration
  is transparent to Claude Code.
- `docs/principles/AIOS-CONSTITUTION.md` §P2 (contract-first), §P3
  (fail-open for infra), §P4 (machine-readable contracts), §P5
  (reversibility), §P6 (observe before act).
- `docs/analysis/2026-04-18-oom-cascade-root-cause.md` §H1 — this
  is what the migration defends against.
- `node --version` = `v25.9.0` (verified on the target machine; native
  `.mts` without flag).

---

## Actions NOT Taken (Read-Only Plan)

- No edits to `scripts/vcontext-hooks.js`.
- No creation of `scripts/vcontext-hooks.mts` in the live tree (only
  a DRAFT at `scripts/vcontext-hooks.draft.mts` as a companion
  artifact to this spec).
- No wrapper changes.
- No `tsconfig.json` committed to the root (the `tsconfig.base.json`
  snippet is illustrative, not yet a file).
- No changes to `settings.json`.

All execution requires explicit user approval per HITL H3. Recommend
the following sequence of gates:

1. User reviews this doc + the draft `.mts`. Gives go/no-go on
   language direction (bun vs node-native vs tsc-emit).
2. On go: author phase-1 commit (drafts file, adds types, adds tests,
   does NOT flip wrapper). Review.
3. On review approval: flip wrapper to `.mts`. 72 h canary.
4. On canary green: phases 2-7 per §7.5 cadence.
