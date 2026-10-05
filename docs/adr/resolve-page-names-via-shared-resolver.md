# Resolve page names in every page-taking tool through one shared resolver

## Context

Page-taking tools each looked a name up their own way, usually by exact lowercase `:block/name`. In LogSeq that goes wrong in several ways:

- `alias:: x` on a page creates an empty stub page `x` with `:block/alias` refs to and from the declaring page. An exact lookup of `x` returns the stub, and the caller sees an empty page.
- A name can match more than one page (an alias declared by several pages, or a namespace leaf).
- A model often has an ISO date such as `2025-01-01`, while journal pages are stored by `:block/journal-day`.
- A missing page returned `null` or an empty result in some tools and an error in others, so "no such page" looked the same as "page with nothing in it".

Issue #41 (part of #13) asked for ambiguity candidates, guidance-style not-found results and ISO date support. The alternatives were to patch each tool in place or to fix the lookup once. Patching six tools separately means six sets of subtly different rules.

## Decision

All page-taking tools resolve names through one helper, `requirePage` in `src/utils/resolve-page.ts`, built on `resolvePage`. Order, first hit wins: exact name (a real page keeps its own name even if other pages alias it), alias (a file-less stub that others alias sends the caller to the declaring page or pages), ISO date by journal day (preferred over a file-less stub with the same name), then namespace leaf, only if nothing else matched and never for dates.

An ambiguous name throws `AmbiguousPageError`, and the MCP layer returns the candidates (sorted, capped at 10, with a warning when cut) as a normal result rather than guessing. A name that matches nothing throws `PageNotFoundError` with guidance: closest names, then `logseq_search_blocks` or `logseq_list_pages`. Infrastructure errors still propagate and are never turned into "not found".

A redirect is never silent. When a name matched by alias, ISO date or namespace leaf, the result says so in `resolvedFrom: { name, matchedBy, resolvedTo }`, or in `meta` for a bare-array result.

`get_page` first tries the exact name through `Editor.getPage` and only goes to the resolver when that finds no real page.

## Consequences

- Aliases, dates and namespace leaves work everywhere a page name is accepted, and "not found" means the same thing in every tool.
- Behaviour changed for `get_backlinks`, `get_concept_evolution` and `search_by_relationship`, which used to return empty results for a missing page and now throw with guidance.
- Cost: one extra query per call in most tools (for example `get_backlinks` went from 1 call to 2 and `get_concept_evolution` from 3 to 4), and fewer where the exact-name fast path applies.
- Resolution only covers the name the caller typed. Links found while following a graph are not alias-aware, which issue #69 tracks.
- New page-taking tools must call `requirePage`, not `getPage`. Reusing the resolver is cheaper than a second set of rules.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/utils/resolve-page.test.ts` (resolver order, ambiguity, not-found guidance, error propagation)
- test: `src/index.page-resolution.test.ts` (candidates, `resolvedFrom` and guidance reach the caller through MCP, including names given under a parameter alias)
- test: `tests/integration/page-resolution.test.ts` (against a live graph)
