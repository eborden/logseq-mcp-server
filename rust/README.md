# Rust spike

The LogSeq MCP server in Rust, beside the TypeScript one in `src/`. It's a bounded spike
([ADR-0025](../docs/adr/0025-rust-implementation-alongside-typescript.md), #122) that ends in a
go/no-go call (#127). The TypeScript server is the one that ships, and its tool contract is the
specification this crate must match.

It has the skeleton (#123): the LogSeq HTTP client, EDN-encoded Datalog inputs, the config file
and an MCP stdio server. The first tool is `logseq_get_page_outline` (#125), which exercises the
pieces most likely to differ between implementations: the shared page resolver, a Datalog query
bound with `:in`, a capped result with a warning, sibling order by the `:block/left` chain, and
2 API calls. `logseq_get_backlinks` (#307) adds the alias groups (#69) and a result that is the Editor API's own entities, kept as sent. The Markdown renderer (#310) is `src/markdown.rs`, behind `format: "markdown"` on `logseq_get_page` and `logseq_get_block` and the `logseq://page/{name}` resource.

| File | What it holds |
|---|---|
| `src/env.rs` | The environment, read once at startup into `Env`: `config_path` (`LOGSEQ_MCP_CONFIG` or `~/.logseq-mcp/config.json`, absolute by type) and `tips` (`LOGSEQ_MCP_TIPS`). Nothing else reads a variable (`tests/env_reads.rs`) |
| `src/config.rs` | The config file, parsed once. Its errors never show a file value (ADR-0003) |
| `src/client.rs` | `call_api` and `execute_datalog_query`: bearer token, a timeout per call, and the same error mapping as `src/client.ts` |
| `src/edn.rs` | What goes into a query, typed by meaning so an invalid value can't be built: `PageName` (lowercase on construction), `JournalDay` (a real `YYYYMMDD` date), `PageId` (positive `:db/id`), `BlockUuid` (strict, lowercase). `DatalogInput` binds them to `:in` as `JSON.stringify` would (ADR-0013); `ground_ids` and `ground_uuids` write the embedded `ground` literals |
| `src/server.rs` | rmcp `ServerHandler`: `initialize`, `tools/list`, `tools/call`, and the resource requests. It only wires: each tool is in `src/tools/`, what they share is in `src/tool.rs` |
| `src/markdown.rs`, `src/resources.rs` | The one Markdown renderer (`markdown.ts`: title, resolved-from note, page properties and the pre-block rule, the block outline with its cap, a single block, the warnings/hasMore/tips footer); `compact`, `showUuid` and `showPage` come with the tools that take them. And the resources (`resources.ts`): `resources/templates/list` and `resources/read` of `logseq://page/{name}`, cut at `MAX_PAGE_CHARS`. `resources/list` is empty and the guide is an unknown URI until the prompts land (#316) |
| `src/tool.rs` | What every tool shares: the read-only hints, the input schema generated from the argument type (every named type written in place: the MCP SDK's client drops `$defs`), argument parsing at the boundary, and the TypeScript server's result shapes |
| `src/tools/<tool>/` | One directory per tool: `mod.rs` (`NAME`, `definition`, `call`) and everything only that tool uses: its queries, the LogSeq answers it reads (`wire.rs`), its tip and its tests. `src/tools/mod.rs` registers them. Today: `get_page_outline/` (#125), `get_backlinks/` (#307), `get_graph_info/`, `list_pages/` and `search_blocks/` (#306), `get_block/` and `get_page/` (#308) |
| `src/args.rs` | `Arguments`: a tool's arguments read one by one in the order of its schema, `null` as absent, nothing coerced, a bad one worded as `parseArgs` words it (`an integer, not a fraction`, `at least 0`, zod's own `Too big`) |
| `src/entity.rs`, `src/slim.rs` | A page or block as LogSeq spells it, in either key spelling (`entity-fields.ts`) with the checks of the entity schemas; and slim output (`slim-entities.ts`, BR-0012). Entities stay the `Value`s LogSeq sent, so a full result carries them as they came |
| `src/truncation.rs`, `src/escape.rs` | The warnings a capped list carries (`result-meta.ts`) and regex escaping (`escape-regex.ts`) |
| `src/wire.rs` | The reader every wire type is written with: LogSeq's answers parsed into typed values at the boundary (`src/response-schemas.ts`). A mismatch is a `ResponseError` naming the path in zod's words, never "no data" |
| `src/resolve/` | The shared page resolver (BR-0010): exact name, alias, ISO date, namespace leaf, the closest names for a miss. Its queries and wire types are in the directory, since only it reads them. `resolve/alias.rs` holds the alias groups (#69): one query for any number of pages, none for a page with no alias link |
| `src/pages_by_ids.rs` | The query that pulls full page entities for some ids (`getPagesByIds`), shared by `search_blocks` (`include_context`) and `get_current_context` (#327) |
| `src/block_tree.rs` | `camelizeKeys` and `camelizeBlock`: a pulled block in the Editor API's spelling; and `orderSiblings`: sibling blocks in page order, by their `:block/left` chain |
| `src/resolve_refs/`, `src/output_format.rs` | `((uuid))` refs and `{{embed}}`s resolved in returned blocks, one batched query per nesting level (BR-0007; `resolve-refs.ts`), with the ref and embed patterns written out since the crate has no regex engine; and the `format` parameter, `json` or `markdown` |
| `src/errors.rs`, `src/meta.rs`, `src/tips.rs`, `src/params.rs` | What tools share: the errors (messages word for word as `src/errors.ts`), `ResultMeta` and the ambiguous-name result, next-step tips, parameter aliases and the wording of a bad argument |
| `src/fuzzy.rs` | fuzzysort 3.1.0's `go`, ported step for step, because the closest names are in an error message compared byte for byte. Tested against the library's own output (`tests/data/fuzzysort-oracle.json`) |
| `src/js.rs` | The JavaScript rules the output depends on: `trim`, number formatting, `JSON.stringify` key order, UTF-16 strings and an approximation of `localeCompare` |
| `tests/no_stdout.rs` | Fails on any write to stdout, which is the MCP channel (ADR-0004) |

## Parity-only code

Code that exists only to reproduce the TypeScript server's exact bytes or quirks, and that a
Rust-only server wouldn't need, carries a comment `// PARITY(#299): <what it copies> — drop if Rust
becomes the only server.` Where the copied behavior is a suspected TypeScript bug, the comment says
so. `grep -rn 'PARITY(#299)' rust/src` lists them. Real safeguards (the 200-block cap, BR-0011,
the page resolver) are not tagged.

## Build and test

`rust-toolchain.toml` pins the compiler, and CI (`.github/workflows/rust.yml`) uses the same one.
Run these from this directory so rustup picks it up:

```bash
cargo build
cargo test
cargo build --release   # target/release/logseq-mcp-server
```

The unit tests never contact LogSeq. The client and outline tests run their own mock HTTP server on
a free local port.

## Parity with the TypeScript server

The parity harness (#124) starts a server over stdio against a stub LogSeq on a random port, and
compares the tool result byte for byte, the LogSeq calls and `tools/list` by meaning (ADR-0031)
with what the TypeScript server did. From the repo root, after `npm ci` and `cargo build`:

```bash
node node_modules/vite-node/vite-node.mjs scripts/parity.ts --tested-tools-only "$PWD/rust/target/debug/logseq-mcp-server"
node node_modules/vite-node/vite-node.mjs scripts/parity.ts --self-check --tested-tools-only "$PWD/rust/target/debug/logseq-mcp-server"
```

The runner is the `vite-node` that `npm ci` installs from the lockfile (CI uses the same; `npx tsx`
would download an unpinned package). It swallows `--`, so the server command follows the flags
directly; `scripts/parity.ts -- <command>` still works under `npx tsx`.

`--tested-tools-only` is for a server with only some tools: `tools/list` is compared for the tools
the cases call, and the server must list those and no others. Fixtures are made up (BR-0001).

## Running it

It reads the same config file as the TypeScript server. To point it at this worktree's fixture
instance rather than the personal graph, run `npx tsx scripts/logseq-instance.ts start` and set
the `LOGSEQ_MCP_CONFIG` it prints.
