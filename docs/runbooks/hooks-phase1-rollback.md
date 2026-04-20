# Hooks TS Migration Phase 1 — Rollback Runbook

**Context**: 2026-04-20 landed `scripts/hooks-gate.mts` as the typed
implementation of the AIOS hard-gate. `scripts/vcontext-hooks.js`'s
`handlePreToolGate()` is now a one-line `await import('./hooks-gate.mts')`.

If Phase 1 misbehaves in production, this runbook brings the system back
to the pre-Phase-1 behavior in under 30 seconds. Per AIOS Constitution
§P5 (reversibility by default).

## Symptoms that warrant rollback

- Hook latency regression > +50 ms on `pre-tool` events (measured via
  dashboard API Metrics card)
- Unexpected `TypeError` / `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in
  `/tmp/vcontext-hooks-err.log` originating from `hooks-gate.mts`
- `aios-gate-block` entries missing when they should be present, OR
  present when they should be fail-open — anything the pre-2026-04-20
  behavior would have handled differently
- Any Claude Code tool invocation hanging longer than the 5-second hook
  timeout

## Rollback procedure

### Option A — revert the single commit (cleanest, preferred)

```bash
cd ~/skills
git log --oneline scripts/vcontext-hooks.js scripts/hooks-gate.mts | head -5
# find the "feat(hooks): phase 1 …" commit — call it $SHA
git revert <SHA>
git push origin main
```

No service restart needed. The next `pre-tool` event picks up the
pre-Phase-1 behavior automatically.

### Option B — inline restore (when git is slow / offline)

Edit `scripts/vcontext-hooks.js`, restore the original
`handlePreToolGate()` function body. The pre-Phase-1 version is preserved
verbatim in git history at the commit immediately before Phase 1.

```bash
# find the commit before Phase 1
cd ~/skills
git log --oneline scripts/vcontext-hooks.js | head -5
# checkout the FULL file from two commits back:
git checkout <PRE_PHASE_1_SHA> -- scripts/vcontext-hooks.js
node --check scripts/vcontext-hooks.js  # sanity
```

### Option C — emergency disable (when rollback itself is broken)

Set `INFINITE_SKILLS_OK=1` globally in the Claude Code environment.
Gate is bypassed for all events; system behaves as if no AIOS gate
existed. **This is the "fail-open maximum" escape hatch** — it removes
the policy entirely, so only use it while a real fix is in flight.

## Verification after rollback

```bash
# Positive pass (session has history, server up):
echo '{"session_id":"91e26874-ad70-4d26-9f22-7547841793c1","tool_name":"Bash","tool_input":{"command":"touch /Users/mitsuru_nakajima/skills/tmp-rollback-test"}}' \
  | node scripts/vcontext-hooks.js pre-tool
# Expected: no stdout output

# Fail-open (server unreachable):
echo '{"session_id":"91e26874-ad70-4d26-9f22-7547841793c1","tool_name":"Bash","tool_input":{"command":"touch /Users/mitsuru_nakajima/skills/tmp-rollback-test"}}' \
  | VCONTEXT_PORT=9999 node scripts/vcontext-hooks.js pre-tool
# Expected: no stdout output + /tmp/vcontext-errors.jsonl gets an
# aios_gate_query_failed entry

# Escape hatch:
echo '{"session_id":"test-never","tool_name":"Bash","tool_input":{"command":"rm -rf /Users/mitsuru_nakajima/skills/"}}' \
  | INFINITE_SKILLS_OK=1 node scripts/vcontext-hooks.js pre-tool
# Expected: no stdout output
```

All three "no stdout output" checks = system healthy post-rollback.

## Why this rollback is <30 seconds

The Phase 1 surgery is ONE function body in hooks.js. Everything else
(aiosCacheRead/Write, sessionHasSkillUsage, emitAiosBlock, helpers) was
intentionally left in hooks.js as dead code precisely so reverting is a
diff of ~15 lines. No files were deleted; hooks-gate.mts can stay
on disk during rollback (nothing imports it after the revert).

## When to expect rollback unnecessary

After 24 hours of normal operation with the Phase 1 code live, and no
hook latency regression surfaced in `api_metrics`, Phase 1 is stable.
Phase 2 can then remove the dead-code helpers from hooks.js. If Phase 2
lands, this runbook's Option B becomes more involved — always revert
Phase 2 before Phase 1 if both need rolling back.
