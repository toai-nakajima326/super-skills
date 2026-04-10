---
name: review
description: "Use for code review focused on high-signal findings rather than stylistic nits."
origin: unified
---

## Rules

- Findings over nits. Prioritize bugs, security issues, and correctness problems over style preferences.
- Security and correctness first. These categories always rank above performance or readability concerns.
- Suggest, don't demand. Frame feedback as suggestions with reasoning, not commands. The author has context you may lack.
- One finding per comment. Do not bundle unrelated issues into a single comment.
- Acknowledge what is done well. Effective review includes positive signals, not just problems.

## Workflow

1. **Read diff for intent** -- Read the entire diff to understand what the change is trying to accomplish. Check the PR description, linked issues, and commit messages for context.
2. **Check correctness** -- Verify the logic is correct. Look for off-by-one errors, null/undefined handling, race conditions, incorrect state transitions, and missing edge cases.
3. **Check security** -- Look for injection vulnerabilities, authentication/authorization gaps, sensitive data exposure, and unsafe deserialization. Flag anything that accepts external input without validation.
4. **Check performance** -- Identify N+1 queries, unnecessary allocations, missing indexes, unbounded loops, and operations that scale poorly with data size.
5. **Write findings ranked by severity** -- Produce a list of findings ordered from most to least severe. Each finding includes: the file and line, what the issue is, why it matters, and a suggested fix.

## Gotchas

- Reviewing only the changed lines misses context. Check how the change interacts with surrounding code.
- Style nits crowd out real findings. Save style feedback for linters.
- "Looks good to me" without reading the code is not a review. If you cannot find issues, say what you checked.
- Large PRs reduce review quality. If the diff is too big, ask for it to be split.
