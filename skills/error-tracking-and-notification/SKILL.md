---
name: error-tracking-and-notification
description: "Use when monitoring user activity for errors and notifying when thresholds are exceeded."
origin: auto-generated
---

## Rules

1. Only track errors within the user's session or activity window.
2. Notifications must be sent via the user's preferred method (e.g., email, in-app alert).

## Workflow

1. Monitor error logs or activity stream for error occurrences.
2. Calculate error count within a defined time window (e.g., last hour).
3. Compare error count to a predefined threshold (e.g., 5 errors).
4. If threshold is exceeded, trigger a notification via the user's preferred method.

## Gotchas

- Ensure error tracking is enabled and configured for the user's session.
- Avoid sending too many notifications to prevent user annoyance.