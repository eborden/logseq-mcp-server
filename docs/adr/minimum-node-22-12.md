# Require Node 22.12 or newer

## Context

`engines.node` first said `>=18` (PR #70, which prepared the npm package). The reasoning was that the client only needs global `fetch` and `AbortSignal.timeout`, and the MCP SDK itself supports 18. The packed server was run under Node 18 as well as 24 to confirm.

That floor did not match what the project could actually be developed and tested on. The dev toolchain (vite 7, through vitest) needs Node 22.12, and Node 18 and 20 are past end of life. A published floor lower than the toolchain's means CI cannot test the floor it advertises, and users on those versions get no security fixes from Node itself. The CI workflow (PR #67) was the point where the mismatch became concrete: it had to pick versions to test.

The alternative was to keep `>=18` and support old runtimes with a separate smoke job. CI briefly did that (a Node 18 smoke job beside the main tests), and it was dropped.

## Decision

We set `engines.node` to `>=22.12.0`, the floor of the dev toolchain. CI runs type-check and unit tests on Node 22, the oldest major that satisfies the floor, and on Node 24, the newest. The lockfile root entry matches `package.json`. We do not carry code paths or workarounds for older Node versions.

## Consequences

- One supported range that CI can test end to end: no untested promise of old-runtime support.
- Users on Node 18 or 20 cannot install without overriding `engines`. The README and CHANGELOG state the floor. Since nothing had been published when this changed, nobody was broken by it.
- We can use current Node and TypeScript features without a compatibility check.
- The floor moves when the toolchain's does. A bump to `engines.node` must go with a CI matrix change and a README note.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/package-metadata.test.ts` (the Node floor matches the dev toolchain)
- ci: `.github/workflows/ci.yml` (type-check and unit tests on Node 22 and 24 for every PR and push to `main`)
