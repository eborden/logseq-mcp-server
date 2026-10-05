# Ship one Datalog implementation per tool, with no feature flags

## Context

While moving tools to Datalog (see [ADR-0002 (datalog-over-editor-api)](0002-datalog-over-editor-api.md)), the first plan was a gradual rollout. Each affected tool would keep its Editor API implementation as `<tool>-http.ts`, gain a `<tool>-datalog.ts`, and sit behind a router that read `features.useDatalog` from the config file (`df7503a:docs/plans/2025-11-21-datalog-optimization-design.md`, commit df7503a). Equivalence tests would compare the two implementations, and the rollout plan was to "make Datalog default, remove feature flags after 2 weeks stable".

What existed by 2025-11-24: Datalog implementations for `get_concept_network` and `build_context`, and a router for `search_by_relationship` that still used HTTP (commit ff0c96d). The equivalence tests were not all passing: `df7503a:docs/datalog-debugging-summary.md` (2025-11-21) records depth-1, depth-2 and structural equivalence tests failing. Commit 37fe0d6 then removed the flag architecture and the equivalence tests "(no longer applicable without dual implementations)" while "maintaining all functionality and test coverage". CLAUDE.md, Lessons Learned 4, gives the reason as: feature flags "maintained dual implementations" and were "eventually removed in favor of simplicity".

Inferred; no source records more of the reason: that the dual setup cost more than it protected, since every tool existed twice behind a router and the tests had to cover both paths, and that a rollout switch adds little for a server whose only user at the time was the maintainer.

## Decision

We keep exactly one implementation per tool and no feature flags. The Datalog code was embedded directly in the tools (commit 37fe0d6, "simplify to direct Datalog implementation"). The `-http.ts` and `-datalog.ts` variants, the routers, the `features` config and the equivalence tests were deleted, about 1,100 net lines (624 insertions, 1,734 deletions).

This is about not maintaining parallel implementations. It does not forbid the Editor API: single lookups still use it, as [ADR-0002 (datalog-over-editor-api)](0002-datalog-over-editor-api.md) says.

## Consequences

- One code path per tool to test, read and debug. The config stays small and has no rollout section to document.
- No instant fallback. If a Datalog query misbehaves on some graph shape, the fix is a code change, not a config flip. We accept that and rely on integration tests against a live graph and on property-style tests that discover pages dynamically.
- The equivalence tests that compared the two paths are gone, and they were deleted while some were still failing rather than after they passed. Correctness rests on direct tests of the Datalog behaviour.
- Anyone later tempted to add an experimental flag has to supersede this ADR first.

## Status

accepted

Date: 2025-11-24

## Mechanical enforcement

The config type and loader have no `features` section, so a flag cannot be read without adding one. Nothing blocks adding one, so review is the backstop until a test pins it.

- reviewer: Reject a PR that adds an implementation or rollout flag, or a second implementation of a tool, unless it cites an ADR that supersedes ADR-0005. Config toggles for output, such as tips, are not rollout flags.
- none-yet: #96
