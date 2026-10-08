# Next-step tips are advice, never part of a result

## Statement

Next-step tips are built by the tools' tip functions (`rust/src/tips.rs` and each tool's own `tips.rs`) into `meta.tips`, never into a tool's result, with suggested args written as JSON (`suggest_call`). `"tips": false` in the config file or `LOGSEQ_MCP_TIPS=off` disables them. `meta.tips` is next-step advice that the handler adds. It is never a truncation signal, and no result's correctness may depend on it, because tips can be turned off.

## Rationale

Tips are a convenience for the model. If a result needed them to be correct or complete, turning them off would make the server lie. Introduced with the server instructions and tips work (#44); the truncation-signal clause came with `ResultMeta` (#40).

## Mechanical enforcement

test: `rust/src/tips.rs`
reviewer: No tool result field, and no truncation or correctness signal, is carried only by `meta.tips`.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #56 |
| 2026-10-08 | Mechanical enforcement: the test moved to the Rust crate with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-08 | Statement: the TypeScript names (`buildTips`, `src/utils/tips.ts`, `JSON.stringify`) are the Rust crate's (`rust/src/tips.rs`, `suggest_call`). The rule is unchanged. | #372 |
