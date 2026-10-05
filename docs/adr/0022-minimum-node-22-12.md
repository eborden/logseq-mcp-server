# Require Node 22.12 or newer

## Context

`engines.node` first said `>=18` (PR #70, which prepared the npm package). The reasoning was that the client only needs global `fetch` and `AbortSignal.timeout`, and the MCP SDK itself supports 18. The packed server was run under Node 18 as well as 24 to confirm.

PR #67, which added the CI workflow, says it "Also raises `engines.node` to `>=22.12.0`" (commit a0cbecf). The commit and the CHANGELOG give the reasons: "Node 18 and 20 are past end of life, and 22.12 is the floor of the dev toolchain (vite 7)." Inferred, not recorded: a published floor below the toolchain's is a floor CI cannot test, and adding CI is what made that concrete.

The alternative was to keep `>=18` and test old runtimes separately. CI briefly had a Node 18 smoke job beside the main tests, and PR #67 records that those commits were dropped from history before merge at the maintainer's request.

## Decision

We set `engines.node` to `>=22.12.0`, the floor of the dev toolchain. CI runs type-check and unit tests on Node 22, the oldest major that satisfies the floor, and on Node 24, the newest. The lockfile root entry matches `package.json`. We do not carry code paths or workarounds for older Node versions.

## Consequences

- One supported range that CI can test end to end: no untested promise of old-runtime support.
- Users on Node 18 or 20 cannot install without overriding `engines`. The README and CHANGELOG state the floor. `CHANGELOG.md` says nothing had been published to npm, so no released version changed.
- We can use current Node and TypeScript features without a compatibility check.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/package-metadata.test.ts` (engines.node is exactly >=22.12.0; it does not read the toolchain's own floor)
- ci: `.github/workflows/ci.yml` (type-check and unit tests on Node 22 and 24 for every PR and push to main; nothing checks the matrix still covers the floor)
- none-yet: #96
