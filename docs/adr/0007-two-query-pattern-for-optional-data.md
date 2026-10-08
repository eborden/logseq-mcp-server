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

- test: `tests/integration/context-building.test.ts` (a page with no blocks returns an empty context, and a page with one empty block returns that block)
- test: `tests/integration/graph-tools.test.ts` (a page with no connections returns the root alone)
- test: `rust/tests/parity.rs` (the parity cases `build_context: a page with no blocks and no links` in `rust/tests/data/parity/build-context.json` and `network: a page nothing links to or from` in `rust/tests/data/parity/get-concept-network.json` run in `cargo test`, and `compare_results` in `rust/tests/parity_support/compare.rs` holds their results to the recorded ones)
