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
- Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone so local `git blame` skips the commits that moved the crate to the repo root (GitHub's blame view already reads the file).
- `scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts` count calls and bytes per tool. They read the personal graph by default (BR-0001): never commit or post their output.

## Running a build

The server reads `~/.logseq-mcp/config.json`, or the absolute path in `LOGSEQ_MCP_CONFIG`. To point it at a worktree's fixture instance instead of your own graph, run `npx tsx scripts/logseq-instance.ts start` and set the `LOGSEQ_MCP_CONFIG` it prints. The unit tests never contact LogSeq: the client tests run their own mock HTTP server on a free local port.

The full workflow (issues, PR template, review gate, merge policy) is in `CLAUDE.md`. Principles for writing code are in [architecture-foundations.md](architecture-foundations.md).

## Useful Commands

```bash
# The Rust server: build, then its unit and call-count tests (touch no LogSeq)
cargo build && cargo test --locked
cargo build --release --locked   # the binary the measure scripts and the smoke run use

# The Node tooling's dependencies (the harness, the guards, the scripts), from the lockfile
npm ci

# The golden-result test and its self-check (#124, #371, #375); the cases and their results are tests/data/parity/
cargo test --locked --test parity --test parity_self_check
# Re-record the golden results on purpose, from the Rust debug build, never in CI (#299, #379)
PARITY_RECORD=1 cargo test --test parity_record -- --nocapture

# The repo's guard tests (docs format, templates, privacy, workflows, tool-list guardrails) and the type-check
npx vitest run tests/guards tests/rust-guards
npm run typecheck
npx tsx scripts/docs-format.ts

# A release binary against the fixture instance, tool by tool (#359; start the instance first)
node node_modules/vite-node/vite-node.mjs scripts/smoke-rust-server.ts target/release/logseq-mcp-server

# Integration tests against this worktree's fixture instance (macOS; own profile, port and random API token)
npx tsx scripts/logseq-instance.ts start
npm run test:integration          # picks up .logseq-instance/config.json while the instance runs
npx tsx scripts/logseq-instance.ts stop
git status                        # sanity check: nothing under tests/fixtures/graph/ (the instance opens a copy, #151)

# The suites run the Rust server (#352, #356): build the crate first (`cargo build`); details in tests/integration/setup.md

# Verify Datalog/API constraints (read-only); the fixture reproduces all of them
npx tsx scripts/probe-constraints.ts   # uses the running instance; never the personal config

# Count API calls per tool (read-only): the default config is the real-graph baseline; the fixture gives reproducible counts
npx tsx scripts/measure-api-calls.ts

# Output size per tool: slim vs full, markdown and compact vs json (read-only; prints byte counts only)
npx tsx scripts/measure-output-size.ts
```

## References

- **LogSeq HTTP API:** http://127.0.0.1:12315/api (default)
- **DataScript Docs:** https://github.com/tonsky/datascript (note: LogSeq subset only)
- **Decisions and rules:** [`docs/adr/`](adr/README.md) (why we chose X) and [`docs/business-rules/`](business-rules/README.md) (what must stay true). The Datalog migration is recorded in [ADR-0002 (datalog-over-editor-api)](adr/0002-datalog-over-editor-api.md) and [ADR-0005 (datalog-only-no-feature-flags)](adr/0005-datalog-only-no-feature-flags.md).
- **Example Scripts:** `scripts/probe-constraints.ts`
- **The crate's map:** [`docs/architecture.md`](architecture.md)
- **MCP Spec:** https://github.com/modelcontextprotocol
