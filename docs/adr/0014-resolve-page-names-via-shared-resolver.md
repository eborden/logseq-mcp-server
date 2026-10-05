# Resolve page names in every page-taking tool through one shared resolver

## Context

Page-taking tools each looked a name up their own way, usually by exact lowercase `:block/name`. In LogSeq that goes wrong in several ways:

- `alias:: x` on a page creates an empty stub page `x` with `:block/alias` refs to and from the declaring page. An exact lookup of `x` returns the stub, and the caller sees an empty page.
- A name can match more than one page (an alias declared by several pages, or a namespace leaf).
- A model often has an ISO date such as `2025-01-01`, while journal pages are stored by `:block/journal-day`.
- A missing page returned `null` or an empty result in some tools and an error in others, so "no such page" looked the same as "page with nothing in it".

Issue #41 (part of #13) asked for ambiguity candidates, guidance-style not-found results and ISO date support "wherever a page name is accepted". PR #57 answered it with one resolver shared by six tools (`get_page`, `get_backlinks`, `build_context` and so `get_context_for_query`, `get_concept_network`, `get_concept_evolution` and `search_by_relationship`), "instead of each looking a name up their own way". Inferred, not recorded as an option weighed: patching each tool in place would have left six sets of subtly different rules.

## Decision

All page-taking tools resolve names through one helper, `requirePage` in `src/utils/resolve-page.ts`, rather than each doing its own lookup. The resolver handles exact names, aliases, ISO dates and namespace leaves, returns candidates for an ambiguous name rather than guessing, turns a missing page into guidance, and never redirects silently.

The resolver order, the error classes and the `resolvedFrom` shape are what callers rely on. They live in the business rule [BR-0010 (page-names-resolved-via-resolver)](../business-rules/0010-page-names-resolved-via-resolver.md) (PR #84) and in PR #57's design section, not here.

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
- test: `src/index.page-resolution.test.ts` (candidates, resolvedFrom and guidance reach the caller through MCP, including names given under a parameter alias)
- test: `tests/integration/page-resolution.test.ts` (against a live graph)
