# Remove tools that duplicate or only partly implement another tool

## Context

By 2025-11-24 the server had 13 tools, and every one is a description, schema and set of behaviours that a model must read each session and choose between. Two overlapped with others (`docs/plans/2024-11-24-simplify-mcp-tools.md`; the file name carries a typo in the year, the commits are from 2025):

- `get_entity_timeline` was a strict subset of `get_concept_evolution`, which returns the same data when called without its grouping option.
- `get_related_pages` claimed to support depths 1 to 3 but implemented only depth 1, and `get_concept_network` covered the same ground in full.

The plan also floated merging two search tools into one interface. That was optional and was not taken.

Alternatives were to keep both for backward compatibility, or to finish the partial tool. Both keep a larger surface for no new capability.

## Decision

We remove a tool when another tool already provides its behaviour, or when it promises more than it implements and a complete tool replaces it. Commit 9642558 removed `get_entity_timeline`, and commit 34a699a removed `get_related_pages`, taking the count from 13 to 11. Their code and tests were deleted.

The removal was cheap then because nothing had been released or published. It is not a precedent for removing tools later: once clients and skills depend on tool names, `additive-tool-contracts` applies.

## Consequences

- A smaller tool list: less context spent on every session and less ambiguity about which tool to call.
- Anyone calling a removed name gets "unknown tool". We accepted that, since the replacements were documented in the plan and commit messages.
- The count has since grown again as capabilities were added (14 today), always through new tools rather than overlapping ones.
- Removed tools are only in git history. Reviving one needs a new decision.

## Status

accepted

Date: 2025-11-24

## Mechanical enforcement

The tool-list snapshot lists every tool by name, so adding or removing one shows up in review. The snapshot cannot tell that a new tool overlaps an old one, so overlap is a review judgment.

- test: `src/tool-list.test.ts` (snapshot of every tool name, description and schema)
- test: `src/index.test.ts` (asserts the exact tool count)
- reviewer: Before adding a tool, check whether an existing tool already covers the behaviour with a parameter.
