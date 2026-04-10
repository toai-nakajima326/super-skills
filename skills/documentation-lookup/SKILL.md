---
name: documentation-lookup
description: Use when answering technical questions to search and reference official documentation, ensuring answers are accurate, sourced, and distinguish between stable and experimental APIs.
origin: unified
---

## Rules

- Check official documentation before answering. Do not rely solely on training data for API signatures, configuration options, or behavior details. Look it up.
- Cite sources. Every factual claim about a library, framework, or tool should reference the specific documentation page, section, or version where the information was found.
- Distinguish between stable and experimental APIs. Clearly label any API, feature, or configuration that is marked as experimental, beta, deprecated, or unstable in the official docs. Warn the user before recommending these.
- Prefer the documentation version matching the user's project. Check the project's dependency versions and reference the corresponding docs, not the latest version by default.
- When official docs are insufficient, clearly state that and identify the information source (community wiki, GitHub issues, Stack Overflow, source code). Never present unofficial sources as authoritative.
- If documentation is ambiguous or contradictory, present both interpretations and let the user decide.

## Steps

1. **Identify topic** -- Parse the user's question to determine the specific technology, library, version, and concept being asked about. Check the project's dependency file (package.json, requirements.txt, Cargo.toml, go.mod) for the exact version in use.
2. **Search official docs** -- Look up the topic in the official documentation:
   - Start with the official project website or documentation site.
   - Search for the specific function, class, configuration key, or concept.
   - Check the API reference, guides, migration notes, and changelog as needed.
   - Verify the documentation version matches the user's installed version.
3. **Extract relevant info** -- From the documentation, pull out:
   - The exact API signature, parameters, return types, and defaults.
   - Important caveats, limitations, or known issues mentioned in the docs.
   - Stability status (stable, experimental, deprecated) and since-version annotations.
   - Code examples from the docs when they clarify usage.
4. **Provide answer with citation** -- Deliver the answer to the user:
   - Lead with the direct answer to their question.
   - Include the relevant details extracted from the docs.
   - Cite the documentation source (URL, page title, version).
   - Flag any experimental or deprecated features.
   - If the docs did not cover the question fully, say so and indicate what was not found.

## Gotchas

- Documentation can be out of date. Cross-reference with the project's changelog or release notes if behavior seems inconsistent with the docs.
- Multiple versions of documentation may exist simultaneously (v1, v2, next). Always confirm which version applies to the user's project.
- Some frameworks have multiple official doc sites (e.g., legacy docs vs. new docs). Prefer the actively maintained site.
- Auto-generated API docs (from JSDoc, Rustdoc, Javadoc) are accurate for signatures but may lack context. Supplement with the narrative docs or guides when available.
- Community tutorials and blog posts may reference outdated APIs. These are useful for context but should not be cited as authoritative without verification against official docs.
- Documentation search can return results from different projects with similar names. Verify the result matches the exact package the user is working with.
