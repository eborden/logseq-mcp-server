# Remove tools that duplicate or only partly implement another tool

## Context

By 2025-11-24 the server had 13 tools. The plan in `docs/plans/2024-11-24-simplify-mcp-tools.md` (the file name carries a typo in the year; the commits are from 2025) set the goal of going from 13 tools to 10 or 11 "by removing redundant/incomplete implementations", and the commits give the reason as reducing the API surface. Two tools overlapped with others:

- `get_entity_timeline` was "a complete subset of `get_concept_evolution`", which returns the same data when called without its `groupBy` option (plan, Task 1; commit 9642558).
- `get_related_pages` "claimed to support depth 1-3 but only implemented depth=1", and `get_concept_network` "provides complete, correct implementation" (commit 34a699a).

The plan also floated merging `search_blocks` and `query_by_property` into one tool (Phase 2, marked optional). That was not taken.

Inferred; no source records this: every tool is a description and schema that a model reads each session and chooses between, so overlapping tools also cost context and invite the wrong choice. No alternative, such as keeping the old names for compatibility or finishing the partial tool, is recorded as considered.

## Decision

We remove a tool when another tool already provides its behaviour, or when it promises more than it implements and a complete tool replaces it. Commit 9642558 removed `get_entity_timeline`, and commit 34a699a removed `get_related_pages`, taking the count from 13 to 11. Their code and tests were deleted.

Nothing had been released: the repository has no tags, and `CHANGELOG.md` says nothing has been published to npm. This is not a precedent for removing tools later: once clients and skills depend on tool names, `additive-tool-contracts` applies.

## Consequences

- A smaller API surface: the plan records "15% reduction in API surface, ~195 lines removed, zero functional loss".
- Anyone calling a removed name gets "unknown tool". The commit messages name the replacement for each (`get_concept_evolution` without `groupBy`, and `get_concept_network` at depth 1). No migration note beyond that was written.
- The count has since grown again as capabilities were added (14 today) through new tools.
- Removed tools are only in git history. Reviving one needs a new decision.

## Status

accepted

Date: 2025-11-24

## Mechanical enforcement

The tool-list snapshot lists every tool by name, so adding or removing one shows up in review. The snapshot cannot tell that a new tool overlaps an old one, so overlap is a review judgment.

- test: `src/tool-list.test.ts` (snapshot of every tool name, description and schema)
- test: `src/index.test.ts` (asserts the exact tool count)
- reviewer: Before adding a tool, check whether an existing tool already covers the behaviour with a parameter.
