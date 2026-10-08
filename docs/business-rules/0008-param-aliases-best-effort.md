# Parameter aliases are best-effort and never the contract

## Statement

Parameter aliases (`src/utils/param-aliases.ts`) are handler-only, unadvertised, and only for parameters that mean exactly the same. A conflicting alias and canonical value throws `InvalidParameterError`. Aliases are best-effort, not a contract: a client that validates against `inputSchema` rejects an alias-only call before it reaches the server, and the model never sees them. They are no substitute for canonical names. Tips and docs always use the canonical name, and the canonical name stays `required`.

## Rationale

An alias that leaked into the advertised schema, or replaced a required canonical name, would make the contract depend on a convenience. Introduced with the aliases (#44).

## Mechanical enforcement

test: `rust/src/params.rs`
test: `tests/guards/tool-list.test.ts`

Tests pin that a conflicting alias and canonical value is refused, that the alias is folded into the canonical name, and `tests/guards/tool-list.test.ts` asserts that the recorded `tools/list` (which the parity step of CI holds the server to) keeps the canonical name `required` for every aliased tool and advertises no alias, checking its table of aliases against the `ALIASES` constants in `rust/src/tools`.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #56 |
| 2026-10-08 | Mechanical enforcement: the test moved to the Rust crate with the TypeScript server's removal. Statement unchanged. Added the recorded-list assertions for the canonical parameter and the absent aliases. | #370 |
