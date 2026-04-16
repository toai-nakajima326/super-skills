---
name: claude-routines
description: "Use when setting up automated, recurring Claude Code tasks that run on cloud infrastructure. Covers Anthropic Routines — scheduled, API-triggered, and GitHub-event-triggered autonomous Claude Code sessions."
origin: web-discovery
---

## Rules

1. **Self-contained prompts only**: routines run with no human present. The prompt must fully specify what to do, what success looks like, and what to do when something is unexpected. Never write prompts that depend on follow-up clarification.
2. **Minimum-scope access**: only include the repositories and connectors the routine actually needs. Remove all others. Over-permissioned routines are a security risk.
3. **Branch safety**: by default Claude only pushes to `claude/`-prefixed branches. Enable unrestricted pushes only when explicitly needed.
4. **Routines vs. local scheduling**: use Routines for tasks that must run when the laptop is closed, use `/loop` or Desktop scheduled tasks when local file access or local tools are needed.
5. **Log and review**: every routine run creates a reviewable session. Check sessions periodically — autonomous agents make unexpected decisions.

## When to Use

| Trigger | Use when |
|---------|----------|
| **Schedule** | Recurring maintenance: grooming issues, docs drift, nightly smoke tests |
| **API** | Integrating Claude into alerting, CD pipelines, or internal tools |
| **GitHub** | Code review automation, cross-repo porting, external-contributor triage |

## Workflow — Create a Routine

### From the CLI (fastest for scheduled routines)
```
/schedule daily PR review at 9am
```
Claude walks through the setup conversationally. Saves to your cloud account.

### From the web
1. Go to claude.ai/code/routines → **New routine**
2. Write the prompt (see prompt template below)
3. Select repositories (minimum needed)
4. Select environment (configure env vars and setup script if needed)
5. Add triggers (schedule / API / GitHub)
6. Remove unused connectors
7. Click **Create**

### Add an API trigger
After creating the routine on the web:
1. Edit routine → Add another trigger → **API**
2. Copy the URL and click **Generate token** (shown once — save immediately)
3. Call the endpoint from your system:
```bash
curl -X POST https://api.anthropic.com/v1/claude_code/routines/<ROUTINE_ID>/fire \
  -H "Authorization: Bearer <TOKEN>" \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"text": "Optional run-specific context, e.g. alert body"}'
```
Returns: `{"claude_code_session_id": "...", "claude_code_session_url": "..."}`

### Add a GitHub trigger
Edit routine → Add another trigger → **GitHub event** → install Claude GitHub App if prompted → select repo + event + filters.

Supported events: `pull_request` (opened/closed/labeled/synchronized/...), `release` (created/published/edited/deleted).

## Prompt Template for Autonomous Routines

```
You are running an automated routine with no human present.

## Goal
<one-sentence description of what success looks like>

## Steps
1. <concrete, unambiguous step>
2. ...

## Scope
- Read from: <explicit list of repos/services>
- Write to: <explicit branches/issues/channels>
- Do NOT: <explicit prohibitions>

## On unexpected state
If you encounter <situation>, <what to do>. When in doubt, stop and leave a comment on the PR/issue explaining what you found.

## Output
When complete, post a summary to <channel/PR/issue> with:
- What was done
- What was skipped and why
- Any items needing human review
```

## Use Case Examples

**Backlog maintenance (schedule)**
Prompt: every weeknight, read issues opened since the last run via the Linear connector, apply labels, assign owners based on the code area referenced, post a summary to Slack.

**Alert triage (API)**
Your monitoring system calls the routine's endpoint with the alert body in `text`. Claude pulls the stack trace, correlates with recent commits, opens a draft PR with a proposed fix.

**PR code review (GitHub)**
Trigger on `pull_request.opened`. Claude applies your team's review checklist, leaves inline comments for security and style issues, adds a summary comment.

**Docs drift (schedule)**
Weekly routine scans merged PRs since the last run, flags docs that reference changed APIs, opens update PRs for an editor to review.

**Cross-repo port (GitHub)**
Trigger on `pull_request.closed` (merged) in one SDK. Claude ports the change to a parallel SDK and opens a matching PR.

## Safety Scope Checklist

Before creating a routine, verify:
- [ ] Prompt is fully self-contained (no clarification needed to run)
- [ ] Prompt has an explicit "on unexpected state" fallback
- [ ] Only needed repositories are selected
- [ ] Only needed connectors are included
- [ ] Branch push restriction is appropriate (default: `claude/` prefix only)
- [ ] GitHub trigger has filters to avoid over-triggering
- [ ] API token stored in a secret store (not hardcoded)

## Plan Limits (as of April 2026)

| Plan | Daily routine runs |
|------|--------------------|
| Pro | 5 |
| Max | 15 |
| Team / Enterprise | 25 |

Routines draw the same subscription usage as interactive sessions.

## Gotchas

- The `/schedule` CLI creates **scheduled** routines only. Add API or GitHub triggers from the web.
- GitHub trigger sessions do not reuse — each event starts a fresh session.
- `matches regex` in GitHub filters tests the whole field. To match a substring, use `.*keyword.*` or use the `contains` operator.
- The API beta header (`experimental-cc-routine-2026-04-01`) may change. Two most recent previous headers remain supported for migration time.
- Routines appear as you on GitHub commits, Slack messages, and connector actions. Review the routine's identity surface before connecting external services.
