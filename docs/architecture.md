# Architecture

```
MCP client (Claude) -> stdio -> Rust server -> HTTP API -> LogSeq desktop -> DataScript database
```

- A **Rust** MCP server (`rust/`, rmcp) that talks to LogSeq's HTTP API over stdio. The TypeScript server it replaced was removed in #356.
- **Datalog, not crawls.** Traversal, search and date-range tools run as batched Datalog queries, so a call costs a fixed few LogSeq calls whatever the graph size: [ADR-0002](adr/0002-datalog-over-editor-api.md).
- **Read-only.** Every tool only reads: [BR-0002](business-rules/0002-tools-read-only.md).
- **Bounded.** Calls and result sizes are capped, and a cut is always reported: [ADR-0011](adr/0011-bounded-calls-and-results.md), [BR-0006](business-rules/0006-no-silent-truncation.md).
- **Golden results.** `rust/tests/data/parity/` holds the cases and the results recorded from the TypeScript server. They are the tool contract.
- **Tests.** `cargo test` for the server, Vitest for the repo's guard tests and the integration suites, which run against a committed fixture graph.

The decisions and the rules the tools keep are in [`docs/adr/`](adr/README.md) and [`docs/business-rules/`](business-rules/README.md). The file-by-file map of the crate is `rust/README.md`; the principles for changing it are in [architecture-foundations.md](architecture-foundations.md).
