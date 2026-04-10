---
name: coding-standards
description: Use when writing or reviewing code to enforce consistency with the project's existing patterns, naming conventions, and formatting standards.
origin: unified
---

## Rules

- Follow existing patterns in the codebase. Before writing new code, examine how similar functionality is implemented elsewhere in the project. Match the established approach.
- Match naming conventions exactly. Use the same casing (camelCase, snake_case, PascalCase, kebab-case), prefixes, suffixes, and abbreviation styles already present in the project.
- Maintain consistent formatting. Follow the project's indentation (tabs vs. spaces, indent width), line length limits, brace style, and whitespace conventions. Defer to the project's formatter configuration if one exists (.prettierrc, .editorconfig, rustfmt.toml, etc.).
- Respect the project's architectural patterns. If the project uses specific patterns (MVC, repository pattern, service layers, hooks), follow those patterns in new code rather than introducing alternatives.
- Do not introduce new dependencies or patterns without explicit justification and user approval. Consistency with existing code takes priority over personal preference or theoretical best practices.
- When existing patterns conflict with each other (legacy vs. new style), follow the most recent pattern unless the user specifies otherwise.

## Steps

1. **Analyze existing patterns** -- Before writing any new code, survey the codebase:
   - Examine 3-5 files similar to what you are about to create or modify.
   - Note naming conventions for variables, functions, classes, files, and directories.
   - Identify the import/export style, error handling approach, logging conventions, and test structure.
   - Check for a style guide, linter config, or formatter config in the project root.
2. **Apply to new code** -- Write code that conforms to the observed patterns:
   - Use the same file and directory naming scheme.
   - Follow the same function signature style (parameter ordering, return types, defaults).
   - Match the error handling pattern (exceptions vs. result types, error codes vs. messages).
   - Use the same testing framework and test file naming convention.
3. **Verify consistency** -- After writing, compare the new code against the existing codebase:
   - Run the project's linter and formatter to catch deviations.
   - Manually review naming, structure, and patterns against the reference files identified in step 1.
   - Check that imports follow the project's module resolution and aliasing conventions.
4. **Flag deviations** -- If any inconsistency is found:
   - Fix it if the correct pattern is clear.
   - Ask the user if the project has two competing patterns and the right choice is ambiguous.
   - Document the pattern choice for future reference if this is a new area of the codebase.

## Gotchas

- Projects in transition may have two or more competing styles (e.g., class components vs. functional components in React). Default to the newer pattern unless told otherwise.
- Auto-generated code (protobuf, OpenAPI, ORM models) follows its own conventions. Do not manually restyle generated files.
- Test files sometimes have relaxed standards (longer lines, less strict typing). Match the test conventions, not the production code conventions, when writing tests.
- Some naming conventions are language-specific idioms (e.g., Go exported names are PascalCase, Python private names use leading underscore). Respect language idioms alongside project conventions.
- Monorepos may have different standards per package. Check the local package's conventions, not the root conventions, when they differ.
