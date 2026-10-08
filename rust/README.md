# Rust spike

The LogSeq MCP server in Rust, beside the TypeScript one in `src/`. It's a bounded spike
([ADR-0025](../docs/adr/0025-rust-implementation-alongside-typescript.md), #122) that ends in a
go/no-go call (#127). The TypeScript server is the one that ships, and its tool contract is the
specification this crate must match.

For now it has the skeleton (#123): the LogSeq HTTP client, EDN-encoded Datalog inputs, the
config file, and an MCP stdio server with one stub tool, `logseq_spike_ping`. The first real
tool is #125.

| File | What it holds |
|---|---|
| `src/config.rs` | `~/.logseq-mcp/config.json` (or `LOGSEQ_MCP_CONFIG`), parsed once. Its errors never show a file value (ADR-0003) |
| `src/client.rs` | `call_api` and `execute_datalog_query`: bearer token, a timeout per call, and the same error mapping as `src/client.ts` |
| `src/edn.rs` | What goes into a query, typed by meaning so an invalid value can't be built: `PageName` (lowercase on construction), `JournalDay` (a real `YYYYMMDD` date), `PageId` (positive `:db/id`), `BlockUuid` (strict, lowercase). `DatalogInput` binds them to `:in` as `JSON.stringify` would (ADR-0013); `ground_ids` and `ground_uuids` write the embedded `ground` literals |
| `src/server.rs` | rmcp `ServerHandler`: `initialize`, `tools/list`, `tools/call`. Each input schema comes from the type that parses the arguments |
| `tests/no_stdout.rs` | Fails on any write to stdout, which is the MCP channel (ADR-0004) |

## Build and test

`rust-toolchain.toml` pins the compiler, and CI (`.github/workflows/rust.yml`) uses the same one.
Run these from this directory so rustup picks it up:

```bash
cargo build
cargo test
cargo build --release   # target/release/logseq-mcp-server
```

The unit tests never contact LogSeq. The client tests run their own mock HTTP server on a free
local port.

## Running it

It reads the same config file as the TypeScript server. To point it at this worktree's fixture
instance rather than the personal graph, run `npx tsx scripts/logseq-instance.ts start` and set
the `LOGSEQ_MCP_CONFIG` it prints.
