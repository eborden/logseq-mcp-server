# Development

The server is Rust: the crate is at the repo root (`src/`, `Cargo.toml`). The TypeScript tooling (`scripts/`, `tests/`) holds the guard tests, the integration suites and the measure scripts. Node is for that tooling only.

Needs: the Rust toolchain that `rust-toolchain.toml` pins (rustup reads it), and Node 22.12 or newer for the tooling.

```bash
npm ci
cargo build && cargo test --locked   # includes the golden-result test: the Rust server against the recorded results
npx vitest run tests/guards tests/rust-guards  # the repo's guard tests
npm run typecheck
npx tsx scripts/docs-format.ts                 # format check for docs/adr and docs/business-rules
npm run test:integration              # needs LogSeq serving the fixture graph; see tests/integration/setup.md
```

## Build from a clone

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server                  # a clone checks out `main`, which holds the Rust server
cargo build --release --locked        # target/release/logseq-mcp-server
```

## Where things are

- [architecture.md](architecture.md) has the crate's file map, and [testing.md](testing.md) the golden-result contract and how to re-record it.
- `tests/integration/setup.md` has the steps for the integration tests against a per-worktree fixture LogSeq instance (`npx tsx scripts/logseq-instance.ts start`, then `stop`).
- `tests/fixtures/README.md` says what each fixture page is for.
- `tests/data/parity/` holds the golden-result cases and results; `cargo test --test parity` holds the server to them, and `PARITY_RECORD=1 cargo test --test parity_record` records them (never in CI).
- `scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts` count calls and bytes per tool. They read the personal graph by default (BR-0001): never commit or post their output.

## Running a build

The server reads `~/.logseq-mcp/config.json`, or the absolute path in `LOGSEQ_MCP_CONFIG`. To point it at a worktree's fixture instance instead of your own graph, run `npx tsx scripts/logseq-instance.ts start` and set the `LOGSEQ_MCP_CONFIG` it prints. The unit tests never contact LogSeq: the client tests run their own mock HTTP server on a free local port.

The full workflow (issues, PR template, review gate, merge policy) is in `CLAUDE.md`. Principles for writing code are in [architecture-foundations.md](architecture-foundations.md).
