# Return slim results by default and keep full output as an opt-out

## Context

The reader of a tool result is a model with a finite context window. Full LogSeq block and page entities carry numeric ids, `page`, `parent` and `left` objects, `format`, `refs`, timestamps and more, none of which a model can use. On 2026-01-23, commit 6bf0afd added slim entity types and a `slim_results` option to the `search_blocks`, `query_by_property` and `query_by_date_range` tool functions, and commit c8543fb exposed it in the MCP handlers ("Add slim_results parameter to remaining tools"). c8543fb's main change was removing JSON pretty-printing from every handler (see [ADR-0009 (minified-json-output)](0009-minified-json-output.md)). The option was opt-in, so the default output stayed full. Issue #13 (section 1) and issue #42 asked to make slim the default, keep `false` as an opt-out and drop null and empty fields. Inferred: an opt-in only helps callers who know to ask.

Inferred, not recorded as options weighed: the alternatives were to leave slim opt-in, as the skills already passed `slim_results` (the CHANGELOG notes they stopped), or to remove full output entirely, which would break any caller that needs the extra fields with no way back.

Measured through the real MCP server on a ~2k-page graph (`scripts/measure-output-size.ts`, byte counts only), slim output was approximately 38% smaller for a 50-result search, 50% smaller with context included, 47% smaller for a recent-journals query, and 24% smaller for a small property query.

## Decision

`slim_results` defaults to `true` on the three tools that have it: `search_blocks`, `query_by_property` and `query_by_date_range`. An explicit `false` returns the full entities, byte for byte as before. The MCP handlers apply the default through `wantsSlim`. The underlying tool functions still default to full output, so internal callers are unchanged.

What slim output leaves out, and which result-meta fields it keeps, are promises to the caller. They live in the business rules [BR-0012 (slim-output-default)](../business-rules/0012-slim-output-default.md) and [BR-0006 (no-silent-truncation)](../business-rules/0006-no-silent-truncation.md) (PR #84), not here.

## Consequences

- Cheaper results by default, with no change needed in skills or prompts, which stopped passing `slim_results`.
- This changed default output for existing callers. Fields they could have relied on, such as numeric block `id`, nested `page` objects and timestamps, are gone unless they pass `slim_results: false`. The block `uuid` is the stable id, and `get_block` takes it. PR #72 flagged it as a behaviour change, with a before-and-after section per tool, and the CHANGELOG lists it under Changed. Its review noted that leaving `pageName` off children goes against the foundations doc's additive-contract rule (hard rule 8, PR #38) and recommended keeping it, since only the default slim shape changes and `slim_results: false` restores the rest.
- Two output shapes per tool to test and document.
- Only three tools have a slim mode. `get_page`, `build_context` and the rest are unchanged, and are a candidate for further work (issue #43).

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `tests/integration/slim-default.test.ts` (omitted means slim, false means full, through MCP against a live graph)
- test: `tests/guards/tool-list.test.ts` (every `slim_results` parameter of the recorded `tools/list` advertises default: true, so a re-record that drops it fails)
- test: `rust/tests/parity.rs` (every tool's `slim_results` schema is held to the recorded `tools/list` by meaning: `compare_tool_lists` in `rust/tests/parity_support/compare.rs`)
- test: `rust/src/slim.rs` (what a slim block and a slim page keep and leave out)

The default itself is the `slim_results` default in each tool's argument type in `rust/src/tools/`.
