# Tool contracts change additively

## Statement

Tool names, parameter names, required fields and the shape of results are the contract. Clients and skills call tools by name with named parameters, so tool contracts change additively: add optional parameters, new tools and new optional result fields. A rename or removal needs an explicit decision and a migration note.

## Rationale

An MCP client, a skill, or a prompt that names a tool and its parameters is a consumer the server can't see. The schema is how it agrees with the server about reality. A silent rename or removal breaks those callers. The recorded tool list (#39; now `scripts/parity/expected/tool-list.json`) makes any change to a name, description or schema visible in review. Restated as a hard rule in the foundations doc (#38).

## Mechanical enforcement

test: `tests/guards/tool-list.test.ts`
test: `tests/rust-guards/tool-list-live.test.ts`
test: `rust/tests/data/parity/tool-list.json`
test: `rust/tests/parity.rs`

`tool-list-live.test.ts` holds the Rust server's own list to the size budget and the description cap, since the recorded list is smaller than what a client receives. The parity test (`cargo test`, `rust/tests/parity.rs`) fails on any difference in meaning between the Rust server's `tools/list` and the recorded one in a tool's name, title, annotation, description or input schema, so a rename or removal can't land unseen. Change the recorded file only for additive changes and call out the diff in the PR. The comparison can't tell an additive change from a breaking one, so a reviewer still checks the diff.
reviewer: A diff of `rust/tests/data/parity/tool-list.json` only adds optional parameters, tools or result fields.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a hard rule in the foundations doc. | #38 |
| 2026-10-05 | Tool-list snapshot added as the mechanism. | #47 |
| 2026-10-08 | Mechanical enforcement: the tool-list snapshot of the TypeScript server is replaced by the recorded tool list, which the parity harness compares by meaning (ADR-0031). Statement unchanged. Added the live-list guard. | #370 |
| 2026-10-08 | Rationale only: the tool-list snapshot is the recorded `tools/list` the parity harness compares by meaning. Statement unchanged. | #372 |
| 2026-10-08 | Mechanical enforcement: the parity check of the recorded `tools/list` is `rust/tests/parity.rs` (`cargo test`), no longer a Node CI step. Added it as a `test:` line. Statement unchanged. | #376 |
