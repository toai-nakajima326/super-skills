---
name: frontend-patterns
description: "Use when building or reviewing frontend applications, choosing component patterns, or structuring client-side state and data flow."
origin: unified
---

## Rules

- Favor component composition over inheritance. Build complex UIs by combining small, focused components rather than extending base classes or using deep prop drilling.
- Co-locate related code. Keep a component's styles, tests, types, and utilities next to the component file. Discoverability beats arbitrary separation by file type.
- Minimize shared mutable state. Lift state only as high as it needs to go, prefer derived/computed values over redundant state, and use context or state management libraries only when prop threading becomes genuinely painful.
- Treat the network boundary explicitly. Data fetching, loading states, and error states are first-class UI concerns, not afterthoughts. Every component that fetches data must handle loading, error, and empty states.
- Keep components pure when possible. Given the same props, a component should render the same output. Side effects belong in hooks, event handlers, or effect boundaries, not in the render path.
- Optimize deliberately, not prematurely. Profile before memoizing. Use React.memo, useMemo, and useCallback only when you have measured evidence of unnecessary re-renders causing user-visible lag.

## Workflow

1. **Map the component tree** -- sketch the hierarchy of components and identify which are containers (data-aware) and which are presentational (pure rendering).
2. **Define the data flow** -- determine where state lives, how it flows down via props, and where events flow up via callbacks.
3. **Choose the state strategy** -- local state for UI-only concerns, shared context for cross-cutting state (theme, auth), external store for complex domain state with many consumers.
4. **Implement presentational components first** -- build the UI from the leaves up, using hardcoded data, so the visual layer is testable in isolation.
5. **Wire up data fetching** -- connect container components to APIs using a data fetching library (React Query, SWR, Apollo) that handles caching, deduplication, and background refetching.
6. **Add interaction and effects** -- implement event handlers, form logic, and side effects in hooks that are decoupled from the rendering components.
7. **Test at the right level** -- unit test utilities and hooks, integration test user-facing behavior with a DOM testing library, and visually test component states with a storybook or snapshot approach.

## Gotchas

- Prop drilling three levels deep is not a problem. Reaching for context or Redux to avoid passing two props through one intermediate component adds complexity without benefit.
- Putting everything in global state (Redux, Zustand) turns local concerns into global coupling. If only one component needs the data, keep it local.
- useEffect is not a lifecycle method. Using it to synchronize state with props usually means you have redundant state that should be derived instead.
- Premature abstraction (DRY at all costs) creates components with ten boolean props and impossible-to-follow conditional rendering. Duplication is cheaper than the wrong abstraction.
- Client-side routing does not excuse broken URLs. Every meaningful view should have a shareable, bookmarkable URL that restores the expected state.
- CSS-in-JS, CSS modules, and utility-first CSS all work. Mixing multiple approaches in one project creates maintenance burden. Pick one strategy and stay consistent.
- Accessibility is not a feature to add later. Semantic HTML, keyboard navigation, ARIA attributes, and focus management must be part of the initial implementation.
