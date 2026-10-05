# Return slim results by default and keep full output as an opt-out

## Context

The reader of a tool result is a model with a finite context window. Full LogSeq block and page entities carry numeric ids, `page`, `parent` and `left` objects, `format`, `refs`, timestamps and more, none of which a model can use. Commit c8543fb (2026-01-23) added an opt-in `slim_results` parameter to cut tokens, but an opt-in only helps callers who know to ask. The default output stayed full, and the tool descriptions carried the cost of explaining the option (issue #13, section 1; issue #42).

The alternatives were to leave slim opt-in and document it in the skills (the skills did pass `slim_results` on every call), or to remove full output entirely. Removing it would break any caller that needs the extra fields, with no way back.

Measured through the real MCP server on a ~2k-page graph (`scripts/measure-output-size.ts`, byte counts only), slim output was approximately 38% smaller for a 50-result search, 50% smaller with context included, 47% smaller for a recent-journals query, and 24% smaller for a small property query.

## Decision

`slim_results` defaults to `true` on the three tools that have it: `search_blocks`, `query_by_property` and `query_by_date_range`. An explicit `false` returns the full entities, byte for byte as before. The MCP handlers apply the default through `wantsSlim`. The underlying tool functions still default to full output, so internal callers are unchanged.

Slim output leaves out fields that say nothing: a blank `pageName`, properties with no value, and empty `references` or `tags`. It never repeats `pageName` on child blocks or on blocks inside a date-range entry. `uuid` and `content` always stay. `hasMore`, `warnings` and `totals` in result meta stay even when empty, because `hasMore: false` is the positive signal that nothing was cut (see `resultmeta-for-capped-results`). Every tool writes minified JSON.

## Consequences

- Cheaper results by default, with no change needed in skills or prompts, which stopped passing `slim_results`.
- This changed default output for existing callers. Fields they could have relied on, such as numeric block `id`, nested `page` objects and timestamps, are gone unless they pass `slim_results: false`. The block `uuid` is the stable id, and `get_block` takes it. The change was called out in the PR and the CHANGELOG as a deliberate exception to `additive-tool-contracts`.
- Two output shapes per tool to test and document.
- Only three tools have a slim mode. `get_page`, `build_context` and the rest are unchanged, and are a candidate for further work (issue #43).

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/index.slim-default.test.ts` (omitted means slim, `false` means full, every tool that advertises `slim_results` goes through `wantsSlim`, the schema advertises `default: true`)
- test: `src/index.minified.test.ts` (every tool writes minified JSON)
- test: `src/utils/slim-entities.test.ts`
