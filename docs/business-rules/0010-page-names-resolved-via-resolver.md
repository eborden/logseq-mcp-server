# Page names resolve the same way in every tool

## Statement

Every tool that takes a page name must resolve it the same way: by exact name in any casing, by alias, by ISO date (`2025-01-01` finds that day's journal) and by namespace leaf. An alias leads to the page that declares it, never to the empty stub page of the same name, and an ISO date prefers the journal over a file-less stub with the same name.

A tool that resolved through an alias, ISO date or namespace leaf must say so: `resolvedFrom: { name, matchedBy, resolvedTo }` in the result, or in `meta` for a bare-array result such as `get_backlinks`. A name that matches more than one page is reported as ambiguous with its candidates (`AmbiguousPageError`). A candidate list cut at its maximum of 10 adds a `candidates_truncated` warning and `totals.candidates`; `hasMore` stays false because no parameter fetches the rest. A page that does not exist is an error with guidance (`PageNotFoundError`), never an empty result, in every page-taking tool, including `get_backlinks`, `get_concept_evolution` and `search_by_relationship` (all relationship types, `connected-within` too).

## Rationale

`alias:: x` makes an empty stub page `x` plus `:block/alias` refs between the pages (stored both ways), so a lookup by exact name alone returns the stub. Results then look empty or incomplete without saying so, and the same name gives different answers in different tools. Some tools used to return empty results for a page that does not exist. Introduced in #41.

## Mechanical enforcement

One resolver serves every page-taking tool: `requirePage` in `src/utils/resolve-page.ts`. Tools call it, not `getPage`.

test: `src/utils/resolve-page.test.ts`
test: `src/index.page-resolution.test.ts`
reviewer: A new page-taking tool resolves its page name with `requirePage` (`src/utils/resolve-page.ts`), not `getPage`.

Known gap: #69 tracks link-following tools that don't resolve aliases yet.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #57 |
