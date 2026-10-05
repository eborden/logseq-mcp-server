# `null` from an API call is not `[]`

## Statement

`null` from an API call is not `[]`. When `logseq.Editor.getAllPages` returns `null` (possibly no graph open or a re-index in progress; unconfirmed until the manual probes M1-M4 in `scripts/probe-constraints.ts` are run), `list_pages` returns the empty list plus a `pages_unavailable` warning, with `hasMore` false and no `howToFetchAll` (no parameter fetches a list that does not exist). A real `[]` carries no warning. Do the same for other tools that read `null` as "none".

## Rationale

An absent answer and an empty answer mean different things to the caller. Reporting `null` as a plain empty list looks like "your graph has no pages". Introduced in #64.

## Mechanical enforcement

test: `src/tools/list-pages.test.ts`
test: `src/truncation-meta.test.ts`

Both pin the `pages_unavailable` warning for `null` and the absence of a warning for a real `[]`. Other tools that read `null` as "none" have no test yet; the reviewer applies the rule to them.
reviewer: A tool that maps a `null` API response to an empty result adds a warning that says the data was unavailable.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a pinned probe for `getAllPages` returning `null`. | #68 |
| 2026-10-05 | `pages_unavailable` warning added to `list_pages`. | #71 |
