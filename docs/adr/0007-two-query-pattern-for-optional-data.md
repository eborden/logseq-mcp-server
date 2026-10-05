# Split queries when related data may be empty

## Context

`build_context` needs a page and its blocks. Many pages in a real graph have no blocks and no file: they exist only because something links to them. The first Datalog version fetched page and blocks in one query and tried to make the blocks optional with `or-join` and `[(ground nil) ?block]`. For a page with no blocks it returned nothing at all, so an existing page looked missing.

The cause is LogSeq's Datalog: `(pull ?block [*])` on a `nil` binding yields `nil`, and LogSeq drops any result row containing `nil`. There is no usable optional binding, so the single query fails exactly when data is absent (commit d6c3151).

## Decision

We fetch required and optional data in separate queries. The first query gets the main entity and fails if it is absent. Later queries get related data, and an empty result there is a valid answer. We do not use `or-join` with `ground nil` to express optional data.

## Consequences

- Pages with no blocks, no connections or no references return a valid result with empty lists, instead of looking like a missing page.
- Each tool spends at least one more call than a single query would. The cost is small and fixed: `build_context` is 3 calls in total.
- Each tool must handle empty arrays explicitly and keep "entity not found" distinct from "entity has nothing attached". PR #57 later made that distinction uniform across page-taking tools: a missing page throws `PageNotFoundError`, while an existing page with no mentions returns an empty result (see [ADR-0014 (resolve-page-names-via-shared-resolver)](0014-resolve-page-names-via-shared-resolver.md)).
- Queries stay simple to read and to test one at a time.

## Status

accepted

Date: 2025-11-24

## Mechanical enforcement

- test: `src/tools/build-context.test.ts` (a page with no blocks and no references returns empty lists)
- test: `src/tools/get-concept-network.test.ts` (a page with no connections returns the root alone)
