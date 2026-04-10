---
name: ui-implementation
description: "Use when implementing or modifying UI (.tsx files). Enforces Design.md reference, CSS variable usage, and checker verification before commit."
origin: unified
---

## Rules

1. **Design.md is the source of truth**: Read Design.md before starting any UI work to confirm color, font, spacing, and component specifications.
2. **CSS variables mandatory**: All colors must use `var(--color-*, fallback)` format. Hardcoded HEX values are prohibited.
3. **Design.md spec values**:
   - Base font: 13px
   - Button padding: 6px 16px
   - Border radius: 4px
   - Input border: `var(--color-input-border, #767676)`
4. **Skill application**: Automatically apply `frontend-patterns` (component structure) and `coding-standards` (naming, validation).
5. **Checker verification required**: After implementation, checker must verify Design.md compliance before commit.

## Workflow

1. Read Design.md — confirm current spec values
2. Identify components to create/modify
3. Apply `frontend-patterns` for component structure (composition over inheritance, co-located code)
4. Implement using CSS variables for all colors
5. Verify against Design.md spec values (font size, padding, border-radius, border colors)
6. Checker verifies Design.md compliance
7. Only commit after checker passes

## Gotchas

- Design.md spec values may change per project. Always re-read, don't rely on cached values.
- If Design.md doesn't exist in the project, skip spec value checks but still enforce CSS variable usage.
- Checker's role for UI is specifically "Does this match Design.md?" not general code review.
- Fallback values in CSS variables must be valid (e.g., `var(--color-primary, #0066cc)` not `var(--color-primary)`).
