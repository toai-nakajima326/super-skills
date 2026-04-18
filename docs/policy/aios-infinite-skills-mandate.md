# AIOS Policy — infinite-skills is an OS-level invariant

**Version**: 1.0
**Effective**: 2026-04-18
**Scope**: ALL AI clients connecting to AIOS (vcontext, MLX servers,
LaunchAgents, any tool that uses `POST /store`, `GET /recall`,
`GET /recent`, or reads/writes anything under `~/skills/`)

---

## The rule (per user directive 2026-04-18)

> AIOS は無限スキル (infinite-skills) を使い、使わせること。
> これは OS の機能です、全てのつながっている、スキルが使える AI に適用してください。

In English:
1. AIOS USES infinite-skills itself.
2. AIOS MAKES every connecting AI use it.
3. This is an OS function — not a session rule, not a user preference.
4. Applies to EVERY AI that can use skills AND is connected to AIOS.

## Who this applies to

**Any AI client that**:
- Reads from or writes to vcontext (`POST /store`, `GET /recall`,
  `GET /recent`, `/admin/*`)
- Runs in `~/.claude/` or `~/skills/` (Claude Code sessions, agents,
  sub-agents, background loops)
- Uses MLX servers (:3161 embed, :3162 generate)
- Is referenced by any LaunchAgent `com.vcontext.*`
- Is Codex, ChatGPT Atlas, other VS Code extensions, or any future AI
  tool that gains AIOS access
- Is a sub-agent spawned from any of the above

**NOT in scope**:
- Pure read-only tools with no file-write or DB-write intent (e.g., a
  dashboard that only visualizes)
- Human actions at the shell (user is trusted as ground truth)

## Enforcement per-exchange

**Every user prompt** an AI receives that touches AIOS must:

1. **Consult infinite-skills routing**. The UserPromptSubmit hook in
   `scripts/vcontext-hooks.js:routeSkills()` does this automatically
   for Claude Code sessions. Other AIs MUST invoke the equivalent
   (e.g., via `GET /recall?q=<prompt-keywords>&type=skill-registry`).
2. **For each matched skill, APPLY it**. "Applied" means the skill's
   headline workflow step runs. Not "noticed", not "acknowledged".
   - `spec-driven-dev` matched → write a spec document.
   - `investigate` matched → gather evidence before editing.
   - `debate-consensus` matched → actually run adversarial rounds.
   - `careful`/`guard` matched → warn + confirm before destructive op.
3. **Record the application**. A `type=skill-usage` entry in vcontext
   with matched skill names. This is what the hard-gate hook checks.
4. **Sub-agents inherit**. Every delegated agent prompt MUST include
   the mandate (or reference this policy doc).

## Enforcement per-write

The AIOS hard-gate hook (commit `e0bafb5`) already enforces this for
Claude Code via PreToolUse. When an Edit/Write/Bash targets an AIOS
path AND this session has no `skill-usage` entry, the tool is blocked.

**For non-Claude AIs** (Codex, etc.), the same invariant applies and
MUST be enforced server-side (see §Planned enforcement below).

## Planned enforcement (2026-04-19 and beyond)

| Layer | Where | Status |
|-------|-------|--------|
| CLAUDE.md rule | `~/.claude/CLAUDE.md` | ✅ Updated 2026-04-18 |
| This policy doc | `docs/policy/aios-infinite-skills-mandate.md` | ✅ (this file) |
| Sub-agent prompt template | Every delegated agent prompt | ⚠️ Partial — being enforced in all tonight's agents |
| vcontext PreToolUse hook | `scripts/vcontext-hooks.js` (Claude Code only) | ✅ Live (`e0bafb5`) |
| vcontext POST /store server-side gate | `scripts/vcontext-server.js` `handleStore()` | ⏳ TODO 2026-04-19 |
| Session-start policy injection | `GET /recall` on session-start returns this doc | ⏳ TODO 2026-04-19 |
| Codex / Atlas / other AI client discipline | Each AI's own rule file + the server gate above | ⏳ TODO (multi-AI) |

## Rationale

Today (2026-04-18) the cost of skipped skills became measurable:
- `spec-driven-dev` matched ~6 times, applied 0 times → big
  architectural change (RAM→SSD migration) shipped without a formal
  spec, leaving 20+ stale heuristics that caused the 2h server hang.
- `debate-consensus` matched once for the "RAM vs SSD vs hybrid"
  architecture question, not applied → chose one path without
  adversarial test.
- `careful`/`guard` matched many times, applied most times ✓.
- `investigate` matched many times, applied partially.

The gap between "matched" and "applied" is where today's complexity
came from. This policy closes that gap by making "application" a
first-class invariant enforceable at the OS layer, not a per-session
nicety.

## Bypass

There is no bypass for AIOS-connected writes without `INFINITE_SKILLS_OK=1`
(the existing hard-gate env). Setting that env is:
- OK in an emergency (documented in commit message)
- NOT ok as a habit (each bypass is a reason to improve the routing
  table instead)

## Revision

This policy is versioned (see header). Changes require a commit to
this file + update to `CLAUDE.md` + note in the next phase review.
Sub-agents SHOULD read the policy doc (latest version) before starting
if they are new to the session.

## Related docs

- `~/.claude/CLAUDE.md` §"AIOS-Connected Work — infinite-skills is MANDATORY"
- `docs/policy/autonomous-commit-gate.md` (Option C tiered trust)
- `docs/design/2026-04-18-auto-commit-tag.md` (`[auto]` tag contract)
- `docs/analysis/2026-04-18-phase-integrated-review.md` (Phase 1 review)
- `docs/analysis/2026-04-18-phase-2-integrated-review.md` (Phase 2 review)
