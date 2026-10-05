# Ship one Datalog implementation per tool, with no feature flags

## Context

While moving tools to Datalog (see `datalog-over-editor-api`), the first plan was a gradual rollout. Each affected tool would keep its Editor API implementation as `<tool>-http.ts`, gain a `<tool>-datalog.ts`, and sit behind a router that read `features.useDatalog` from the config file (`docs/plans/2025-11-21-datalog-optimization-design.md`, commit df7503a). Equivalence tests would compare the two implementations, and the flags would be removed after a stable period.

By 2025-11-24 two tools had a Datalog path that matched the old results, and the dual setup was costing more than it protected. Every tool existed twice with a router in front, tests had to cover both paths plus the flag combinations, the config grew a `features` section, and the equivalence tests existed only to keep two implementations in sync. The only user is the maintainer, who can fix a bad release directly, so a rollout switch protected a population of one.

## Decision

We keep exactly one implementation per tool and no feature flags. The Datalog code was embedded directly in the tools (commit 37fe0d6, "simplify to direct Datalog implementation"). The `-http.ts` and `-datalog.ts` variants, the routers, the `features` config and the equivalence tests were deleted, about 1,100 net lines.

This is about not maintaining parallel implementations. It does not forbid the Editor API: single lookups still use it, as `datalog-over-editor-api` says.

## Consequences

- One code path per tool to test, read and debug. The config stays small and has no rollout section to document.
- No instant fallback. If a Datalog query misbehaves on some graph shape, the fix is a code change, not a config flip. We accept that and rely on integration tests against a live graph and on property-style tests that discover pages dynamically.
- The equivalence tests that compared the two paths are gone. Correctness rests on direct tests of the Datalog behaviour.
- Anyone later tempted to add an experimental flag has to supersede this ADR first.

## Status

accepted

Date: 2025-11-24

## Mechanical enforcement

The config type and loader have no `features` section, so a flag cannot be read without adding one. Nothing blocks adding one, so review is the backstop.

- reviewer: Reject a PR that adds a feature flag, a per-tool config toggle or a second implementation of a tool, unless it cites an ADR that supersedes datalog-only-no-feature-flags.
