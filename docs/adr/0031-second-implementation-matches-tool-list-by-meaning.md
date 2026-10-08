# Hold a second implementation to the tools/list contract by meaning, not by bytes

## Context

[ADR-0025 (rust-implementation-alongside-typescript)](0025-rust-implementation-alongside-typescript.md) Decision 2 says that, until TypeScript is retired, the Rust server "must emit the same `tools/list` (the ADR-0016 snapshot)". Read literally, that is byte-identical to the JSON Schema zod writes. The Rust spike (#122) showed what that costs: the Rust server's schema adapter had to copy zod's serialization quirks, such as inlined enums instead of `$defs` and `$ref`, optional fields that aren't `["T", "null"]`, no `format` keyword, and `50` rather than `50.0`. None of these change what a client may send, and the adapter grows with every schema feature it has to imitate.

The maintainer, 2026-10-08, on #122: "let's copy semantics that are important, not quirks." #292 (PR #294) makes the parity harness compare `tools/list` by meaning, and #291 slims the Rust adapter to match. Both are on `feature/rust-spike`. Proposed in #296.

## Decision

This ADR restates ADR-0025 and changes only its Decision 2, and ADR-0025 is marked superseded by it. Everything else in ADR-0025 stands: the spike and its go/no-go (Decision 1), the per-toolchain re-scoping of the process docs and its interim rule (Decision 3), and the separate decision to retire TypeScript (Decision 4), with their Context and Consequences. Where ADR-0025 says its go/no-go (#127) marks "this ADR" `deprecated` or leaves it accepted, that now applies to this ADR, the live record of all four decisions. The classification of each ADR under Decision 3 (#128) likewise works from this ADR.

**Decision 2, as changed: the TypeScript tool contract is the specification.**

- **`tools/list` is compared by meaning.** Until TypeScript is retired, a second implementation must emit the same `tools/list` contract as the TypeScript server, checked by the parity harness (#292). Both lists are normalized the same way before they are compared, and only these differences are treated as serialization, not meaning:
  1. **`$ref` resolution.** A `$ref` into `$defs` or `definitions` is replaced by what it points at, and the definitions are dropped. A `$ref` with sibling keywords, or an `allOf` of one schema, is merged into one schema; a clash stays an `allOf`, so it still shows as a difference. Only local JSON-pointer refs (`#` or `#/...`) are resolved. An anchor-style (`#Foo`), non-local, recursive or dangling `$ref` isn't resolved and is reported as a difference.
  2. **Null on optional fields.** A **top-level** property of `inputSchema` that isn't in `required` loses the null it also accepts (`[T, "null"]`, a null branch of `anyOf` or `oneOf`, `null` in `enum`), because the TypeScript server treats an explicit top-level `null` as absent (`withoutNulls` in `parseArgs`, `src/utils/parse-args.ts`). A required property, and any property of a nested object or of an object inside `items`, keeps its null, since the TypeScript server rejects a `null` there.
  3. **Non-validating annotation keywords.** The `$schema`, `format` and `title` keywords inside a schema are dropped. A property named `format`, and the tool's own `title` and `annotations`, are kept.
  4. **Numbers by value.** `50`, `50.0` and `5e1` are the same number.
  5. **Set-like `required`.** `required` is compared as a set, and object key order never matters.
- **What stays exact:** tool names, titles, annotations, descriptions, types, `required` members, bounds, enum values (in order), defaults, parameter descriptions and `additionalProperties`.
- **The ADR-0016 snapshot stays byte-exact for TypeScript.** [ADR-0016 (tool-list-size-guardrails)](0016-tool-list-size-guardrails.md) is unchanged: its snapshot is the TypeScript server's byte-exact guard and its size budget. The harness's reference list is recorded from the TypeScript server and held to that snapshot byte for byte, so the reference can't drift from it.
- **Tool results stay byte for byte.** The rest of ADR-0025 Decision 2 is unchanged: for the same stubbed LogSeq responses, the result text is equal byte for byte as the TypeScript server serializes it ([ADR-0009 (minified-json-output)](0009-minified-json-output.md); Markdown likewise), and the same LogSeq calls are made with the same inputs, compared in order when TypeScript makes them one after another and as a set when it makes them concurrently. Contract changes stay additive ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)) and apply to both.

## Consequences

- A second implementation emits the schemas its own library writes, and its adapter copies only what clients rely on.
- The harness, not the snapshot, now defines "same contract" for a second implementation, so the normalization rules are part of the contract. Loosening one is a change to this decision.
- Two clients could still read the two lists differently even when they compare equal: some MCP clients may handle `$ref` or nullable arrays worse than inlined schemas. Whether they do is a client-compatibility check that goes into the go/no-go (#127), not into the harness.
- The TypeScript server's bytes, size budget and description cap are guarded exactly as before.
- The semantic comparison lives on `feature/rust-spike` until the spike merges to `main`, so on `main` it is enforced by nothing yet.

## Status

superseded by 0032-closest-page-suggestions-match-by-meaning

Date: 2026-10-08

## Mechanical enforcement

- test: `src/tool-list.test.ts` (the TypeScript server's byte-exact snapshot, size budget and description cap, unchanged from ADR-0016)
- none-yet: #292 (the parity harness's comparison of `tools/list` by meaning; it lands on `feature/rust-spike` and becomes a `test:` line when the spike merges to `main`)
- none-yet: #124 (adds the differential harness that holds the Rust server to the TypeScript contract; covers Decision 2)
- reviewer: a PR that adds Rust code checks it against every ADR by intent and against Decision 3's interim rule (Decision 3 has no mechanical guard; #128 adds the per-ADR scope lines)
