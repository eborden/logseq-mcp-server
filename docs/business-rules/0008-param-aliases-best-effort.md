# Parameter aliases are best-effort and never the contract

## Statement

Parameter aliases (`src/utils/param-aliases.ts`) are handler-only, unadvertised, and only for parameters that mean exactly the same. A conflicting alias and canonical value throws `InvalidParameterError`. Aliases are best-effort, not a contract: a client that validates against `inputSchema` rejects an alias-only call before it reaches the server, and the model never sees them. They are no substitute for canonical names. Tips and docs always use the canonical name, and the canonical name stays `required`.

## Rationale

An alias that leaked into the advertised schema, or replaced a required canonical name, would make the contract depend on a convenience. Introduced with the aliases (#44).

## Mechanical enforcement

test: `src/index.aliases.test.ts`

Tests pin that a conflicting alias and canonical value throws, that the canonical name stays `required` for every aliased tool, and that no input schema advertises an alias.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #56 |
