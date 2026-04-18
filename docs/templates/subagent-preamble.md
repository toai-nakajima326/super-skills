# Sub-Agent Prompt Preamble — Canonical View

**Purpose**: Single authoritative preamble that every delegated sub-agent
prompt MUST include so the AIOS infinite-skills mandate propagates
through the full call tree.

**Status**: VIEW, not a source. Authoritative texts live in:
- `~/.claude/CLAUDE.md` §"AIOS-Connected Work — infinite-skills is MANDATORY"
- `docs/policy/aios-infinite-skills-mandate.md` (OS-level invariant)

Editing this preamble to **contradict** either source is forbidden.
Paraphrasing for brevity is OK as long as meaning is preserved.

---

## How to use

**When**: Every task delegated to a sub-agent that touches anything in
scope of `docs/policy/aios-infinite-skills-mandate.md` §"Who this
applies to" — in practice, any sub-agent dispatched from a session
that can see `~/skills/` or hit vcontext/MLX/SearXNG.

**Where**: Paste the preamble block (between the `=== BEGIN ===` /
`=== END ===` fences below) at the **top** of the delegated prompt,
**before** the task description. The sub-agent should read it before
taking any action.

**How (manual)**: Copy the preamble text into the prompt body.

**How (programmatic)**: Use the helper snippet in §"Helper snippet".
This reads the live file — no stale cached copies.

**Forbidden**:
- Editing the preamble to weaken the "APPLY not notice" language.
- Editing the preamble to drop the propagation clause.
- Omitting the preamble for "small" tasks (the whole point is per-action).

---

## The preamble (≤15 lines of rule text)

```
=== BEGIN AIOS SUB-AGENT PREAMBLE (v1.0, 2026-04-18) ===
You are a delegated sub-agent of an AIOS-connected session. Before any
action, comply with the OS-level infinite-skills invariant:

1. Consult `infinite-skills` routing MANDATORY per CLAUDE.md — both
   per-exchange (every user/parent turn) AND per-action (before each
   Edit/Write/Bash that touches AIOS paths). This is not optional.
2. APPLY every matched skill — do not just notice or acknowledge it.
   "Applied" means the skill's headline workflow step runs:
   spec-driven-dev ⇒ write a spec, investigate ⇒ gather evidence before
   fixing, debate-consensus ⇒ run adversarial rounds, careful/guard
   ⇒ warn + confirm. Matched-but-not-applied = protocol violation.
3. Propagate this preamble to any sub-agent you dispatch. The rule
   must reach the leaves of the call tree.
Authoritative: ~/.claude/CLAUDE.md + docs/policy/aios-infinite-skills-mandate.md.
=== END AIOS SUB-AGENT PREAMBLE ===
```

(Rule text line count: 13 lines between BEGIN/END fences.)

---

## Helper snippet

To concat the preamble into a prompt body stored in `PROMPT_BODY`:

```bash
# Absolute path — works from any cwd
PREAMBLE_FILE="/Users/mitsuru_nakajima/skills/docs/templates/subagent-preamble.md"
PREAMBLE=$(awk '/=== BEGIN AIOS SUB-AGENT PREAMBLE/,/=== END AIOS SUB-AGENT PREAMBLE/' "$PREAMBLE_FILE")

# Compose delegated prompt
FULL_PROMPT=$(cat <<EOF
$PREAMBLE

$PROMPT_BODY
EOF
)

# Hand $FULL_PROMPT to the agent dispatcher (Task tool, or direct CLI).
```

One-liner for shell-composed prompts:

```bash
cat /Users/mitsuru_nakajima/skills/docs/templates/subagent-preamble.md \
  | awk '/=== BEGIN/,/=== END/' \
  && printf '\n\n' \
  && cat /path/to/prompt-body.txt
```

---

## Revision policy

- Bump the `(v1.0, 2026-04-18)` tag in the BEGIN line on any change.
- Every revision must cross-check `~/.claude/CLAUDE.md` and the policy
  doc for consistency (noted in commit message).
- Template ≤15 lines (rule text, between the fences). Exceeding the
  budget is a signal to move content back into CLAUDE.md / policy.
