# Parameter aliases are best-effort and never the contract

## Statement

Parameter aliases (`resolve_param_aliases` in `rust/src/params.rs`) are handler-only, unadvertised, and only for parameters that mean exactly the same. A conflicting alias and canonical value is an `InvalidParameter` error. Aliases are best-effort, not a contract: a client that validates against `inputSchema` rejects an alias-only call before it reaches the server where the canonical name is `required`, and the model never sees them. They are no substitute for canonical names. Tips and docs always use the canonical name, and the canonical name stays `required`. The one exception is a tool that takes a `cursor` ([ADR-0038 (one-forward-only-cursor-for-paging)](../adr/0038-one-forward-only-cursor-for-paging.md)): a call with a `cursor` carries its arguments in the token and takes no other, so the canonical name is optional in the schema there, and the handler refuses a call with neither it nor a `cursor`. On such a tool a call that leaves the name out gets a handler error, not a schema error, and an alias-only call passes the schema and works. The aliases stay handler-only.

## Rationale

An alias that leaked into the advertised schema, or replaced a required canonical name, would make the contract depend on a convenience. Introduced with the aliases (#44). A tool that takes a `cursor` is the one exception: its canonical name is optional in the schema, so a cursor call can carry no other argument (ADR-0038).

## Mechanical enforcement

test: `rust/src/params.rs`
test: `tests/guards/tool-list.test.ts`
test: `rust/tests/parity.rs`
test: `rust/tests/get_page_block_cursor_calls.rs` (`get_page` and `get_block`, the first tools with a required canonical name that take a `cursor`: a call with neither the name nor a `cursor` is refused before any call, `{cursor, <alias>}` is refused on the alias-folded arguments, and an alias alone is a call that works)
test: `rust/tests/context_cursor_calls.rs` (`explore_context`, another tool with a required canonical name that takes a `cursor`: a call with neither the name nor a `cursor` is refused before any call, and `{cursor, <alias>}` is refused on the alias-folded arguments)
test: `rust/tests/network_cursor_calls.rs` (`explore_network`, whose `page` is optional beside a `cursor` too: a call with neither is refused before any call, `{cursor, name}` is refused on the alias-folded arguments, and an alias alone is a call that works)

Tests pin that a conflicting alias and canonical value is refused, that the alias is folded into the canonical name, and `tests/guards/tool-list.test.ts` asserts that the recorded `tools/list` (which the parity test, `rust/tests/parity.rs`, holds the server to) keeps the canonical name `required` for every aliased tool and advertises no alias, checking its table of aliases against the `ALIASES` constants in `rust/src/tools`.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #56 |
| 2026-10-08 | Mechanical enforcement: the test moved to the Rust crate with the TypeScript server's removal. Statement unchanged. Added the recorded-list assertions for the canonical parameter and the absent aliases. | #370 |
| 2026-10-08 | Statement: the TypeScript path and error name (`src/utils/param-aliases.ts`, `InvalidParameterError`) are the Rust crate's (`rust/src/params.rs`, `InvalidParameter`). The rule is unchanged. | #372 |
| 2026-10-08 | Mechanical enforcement: the parity check the recorded `tools/list` is held to is `rust/tests/parity.rs` (`cargo test`), no longer a Node CI step. Added it as a `test:` line. Statement unchanged. | #376 |
| 2026-10-14 | Statement: the canonical name stays `required` except on a tool that takes a `cursor` (ADR-0038), where a cursor call carries the arguments in its token. The implementation, and the exception in the guard, land with the cursor core task (#528); no tool takes a `cursor` yet, so every canonical name is still `required`. | #546 |
| 2026-10-14 | Mechanical enforcement: the `none-yet` line points at the migration of `get_page` and `get_block` (#552), the first tool with a required canonical name that takes a `cursor`, instead of the cursor core (#528), whose tool, `find_blocks`, has none. The Statement is unchanged. | #560 |
| 2026-10-14 | Mechanical enforcement: the tests of `get_page` and `get_block`, the first tools with a required canonical name that take a `cursor`, replace the `none-yet: #552` line, and the `required` check of `tests/guards/tool-list.test.ts` takes the exception for a tool that takes a `cursor`. Additive; the Statement is unchanged. | #565 |
| 2026-10-14 | Mechanical enforcement: the tests of `explore_context`, whose `page` is optional beside a `cursor` like `get_page` and `get_block`, join the `test:` lines. Additive; the Statement is unchanged. | #568 |
