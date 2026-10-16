# Architecture

```
MCP client (Claude) -> stdio -> Rust server -> HTTP API -> LogSeq desktop -> DataScript database
```

- A **Rust** MCP server (the crate at the repo root, rmcp) that talks to LogSeq's HTTP API over stdio. The TypeScript server it replaced was removed in #356.
- **Datalog, not crawls.** Traversal, search and date-range tools run as batched Datalog queries, so a call costs a fixed few LogSeq calls whatever the graph size: [ADR-0002](adr/0002-datalog-over-editor-api.md).
- **Read-only.** Every tool only reads: [BR-0002](business-rules/0002-tools-read-only.md).
- **Bounded.** Calls and result sizes are capped, and a cut is always reported: [ADR-0011](adr/0011-bounded-calls-and-results.md), [BR-0006](business-rules/0006-no-silent-truncation.md).
- **Golden results.** `tests/data/parity/` holds the cases and the results recorded from the TypeScript server. They are the tool contract.
- **Tests.** `cargo test` for the server (the tests beside the code, and `tests/*.rs`), Vitest for the repo's guard tests and the integration suites, which run against a committed fixture graph. [testing.md](testing.md) has the golden-result contract.

The decisions and the rules the tools keep are in [`docs/adr/`](adr/README.md) and [`docs/business-rules/`](business-rules/README.md). The file-by-file map of the crate is below; the principles for changing it are in [architecture-foundations.md](architecture-foundations.md).

## File map

The crate is at the repo root. Unit tests sit beside the code (`#[cfg(test)]`); the integration tests are `tests/*.rs`.

| File | What it holds |
|---|---|
| `src/env.rs` | The environment, read once at startup into `Env`: `config_path` (`LOGSEQ_MCP_CONFIG` or `~/.logseq-mcp/config.json`, absolute by type), `tips` (`LOGSEQ_MCP_TIPS`) and `clock` (`LOGSEQ_MCP_NOW`, a fixed instant in milliseconds for the parity test; unset is the system clock; a release build ignores it). Nothing else reads a variable (`tests/env_reads.rs`) |
| `src/config.rs` | The config file, parsed once. Its errors never show a file value (ADR-0003) |
| `src/client.rs` | `call_api` and `execute_datalog_query`: bearer token, a timeout per call, and an error type for each way a call fails |
| `src/edn.rs` | What goes into a query, typed by meaning so an invalid value can't be built: `PageName` (lowercase on construction), `JournalDay` (a real `YYYYMMDD` date), `PageId` (positive `:db/id`), `BlockUuid` (strict, lowercase). `DatalogInput` binds them to `:in` as compact JSON text, which LogSeq reads as EDN (ADR-0013); `ground_ids` and `ground_uuids` write the embedded `ground` literals |
| `src/server.rs` | rmcp `ServerHandler`: `initialize` (the name, `serverInfo.version` from `Cargo.toml` and the `instructions`), `tools/list`, `tools/call`, and the prompt and resource requests. For a client on protocol 2026-07-28 it adds `ttlMs` and `cacheScope` to the list results (one hour, public) and to `resources/read` (0, private); older clients get them unchanged. It only wires: each tool is in `src/tools/`, what they share is in `src/tool.rs` |
| `src/prompts.rs`, `src/instructions.rs`, `src/mcp_error.rs` | The five prompts (each one short user message that names the tools; arguments are strings, an unknown or malformed one is `InvalidParams`; the week and month come from the server's clock, never read inside a builder). The server `instructions`. And the JSON-RPC error that answers a bad prompt or resource request, shared by the prompts and the resources |
| `src/markdown.rs`, `src/resources.rs` | The one Markdown renderer (title, resolved-from note, page properties and the pre-block rule, the block outline with its cap, a single block, the warnings/hasMore/tips footer). And the resources: `resources/templates/list` and `resources/read` of `logseq://page/{name}`, cut at `MAX_PAGE_CHARS`, `resources/list` and the reading guide `logseq://guide` (the instructions plus a one-line index of the tools, prompts and resources) |
| `src/tool.rs` | What every tool shares: the read-only hints, the input schema generated from the argument type (every named type written in place: the MCP SDK's client drops `$defs`; an optional parameter is `anyOf` its type and `null`, not a type array, for clients that read one type per parameter), argument parsing at the boundary, and the shapes of a tool's results |
| `src/tools/<tool>/` | One directory per tool: `mod.rs` (`NAME`, `definition`, `call`) and everything only that tool uses: its queries, the LogSeq answers it reads (`wire.rs`), its tip and its tests. `src/tools/mod.rs` registers them. Today: `get_graph/`, `get_current/`, `find_pages/`, `find_blocks/` (the period filter in `period.rs`, the `page` and `links_to` filters in `scope.rs`), `get_block/`, `get_page/` (`get_page/outline/` holds the outline detail), `explore_timeline/` (the journal days of a period in `journals.rs`, a page's days in `mentions.rs`, the day arithmetic in `days.rs`, the `max_blocks` cut in `cap.rs`), `explore_context/` (ranks and pages the references in `references.rs`), `check_links/` and `explore_network/` (the walk, and the shortest path to a second page in `path.rs`) |
| `src/markdown_context.rs`, `src/compact.rs`, `src/snippet.rs` | Markdown for the context tools (a topic's blocks, related pages and references by source page, a concept network's pages by depth and its links, a path's pages with its links); `compact` JSON (a block is `{ uuid, snippet }`, a page `{ id, name, originalName }`); and the first-line snippet, also the outline's |
| `src/args.rs` | `parse_args`: a tool's arguments deserialized once into its `Args` type (the type its `inputSchema` is generated from), `null` as absent, nothing coerced, a bad one an `InvalidParameter` naming the parameter and the rule (`an integer, not a fraction`, `at least 0`, `at most 9007199254740991`), worded in this one file |
| `src/entity.rs`, `src/entity/shape.rs`, `src/slim.rs` | A page or block as LogSeq spells it, in either key spelling; the shapes that check the fields the code reads of one (`entity/shape.rs`); and slim output (BR-0012). Entities stay the `Value`s LogSeq sent, so a full result carries them as they came |
| `src/truncation.rs`, `src/escape.rs` | The warnings a capped list carries and regex escaping |
| `src/wire.rs` | LogSeq's answers parsed into types that derive `Deserialize`, at the boundary, through the deserializer in `src/wire/deserializer.rs`. A type names the fields the code reads and no others; a mismatch is a `ResponseError` that names the method and the path (`answer[0].id: expected a whole number, got a string`) and never a value from the answer (ADR-0004), and is never "no data" |
| `src/resolve/` | The shared page resolver (BR-0010): exact name, alias, ISO date, namespace leaf, the closest names for a miss. Its queries and wire types are in the directory, since only it reads them. `resolve/alias.rs` holds the alias groups: one query for any number of pages, none for a page with no alias link. `resolve/link_targets.rs` resolves the many names of a `[[link]]` pass by name or alias in one query |
| `src/pages_by_ids.rs` | The query that pulls full page entities for some ids, shared by `find_blocks` (`include_context`) and `get_current` |
| `src/block_tree.rs` | A pulled block in the Editor API's spelling (`camelize_keys`, `camelize_block`); sibling blocks in page order, by their `:block/left` chain (`order_siblings`); and the trees of many pages from the flat blocks one query pulls (`build_block_trees`) |
| `src/budget.rs` | The character budget of a tool result: `BUDGET_CHARS` (30,000) and `fit`, which finds by bisection how many entries of a tool's main list keep the text it sends under the budget. Applied after the count caps, each tool in its own unit (named in that tool's `mod.rs`). The cut is reported by the `result_size_truncated` warning (`truncation.rs`, `size_truncation_warning`); a result under the budget is untouched, and the cut costs no LogSeq call |
| `src/cursor.rs`, `src/snapshots.rs`, `src/paging.rs` | The cursor that reads a cut list to the end (ADR-0038): the token (base64url of a versioned payload: the tool, its resolved arguments, the position, the last entry sent and a snapshot key), the bounded per-process cache of the first call's whole list (16 snapshots, 32 MiB, 8 MiB each, 1 minute, constants in `snapshots.rs`), and the helpers a paged tool shares: `page_of` over `budget::fit`, `paged_warning`, the read-through (`serve`), the anchor check (`resume_at`, `cursor_stale`) and `refuse_with_cursor` |
| `src/tree_paging.rs` | A block tree read to the end with the cursor (ADR-0038), for `get_page` with `detail: "full"` and `get_block` with `include_children`: the snapshot (`Tree`: the result as read, with `resolve_refs` applied, and the key of each block in document order), and `read`, which serves it or builds it again with the first page's calls, finds where the page starts (`cursor_stale` when the tree moved), fits the most whole blocks to the budget and writes the page: the frame of a page, or `{ uuid, continued: true, children }` for a later page of a block, with `ancestors` on the blocks that start a page inside a subtree (`block_budget::slice_blocks`) |
| `src/dates.rs`, `src/block_budget.rs` | Calendar dates: the eight presets as plain calendar arithmetic, and a `Clock` that reads today's date in the host's local zone through `localtime_r`, so it honours `TZ`. And cutting block trees to a count of blocks, nested ones included, from any place in document order (`slice_blocks`) |
| `src/period.rs` | The period of `explore_timeline` and `find_blocks` (ADR-0037): exactly one of `start_date` with `end_date`, `last_n` or `preset`, its refusals worded in one place, and the span of days it makes (`last_n` is the last N calendar days ending today, in no call) |
| `src/resolve_refs/`, `src/output_format.rs` | `((uuid))` refs and `{{embed}}`s resolved in returned blocks, one batched query per nesting level (BR-0007), with the ref and embed patterns written out since the crate has no regex engine; and the `format` parameter, `json` or `markdown` (`json` or `toon` for the flat-list tools, written by `src/toon.rs`, BR-0014) |
| `src/errors.rs`, `src/meta.rs`, `src/tips.rs`, `src/params.rs` | What tools share: the errors (their messages are fixed text), `ResultMeta` and the ambiguous-name result, next-step tips, parameter aliases and the wording of a bad argument |
| `src/property.rs` | A property key (as LogSeq stores it or as the Editor API spells it) and what matching a property by value means, shared by the `property` filter of `find_blocks` and of `find_pages` |
| `src/fuzzy.rs` | The closest names for a missing page, picked with `nucleo-matcher` (`Pattern::new`, `AtomKind::Fuzzy`): names equal to the input first, then names that start with it, then names that contain each of its words in order, best score first. The parity test holds the list to the rules of ADR-0034 Decision 4, not to recorded bytes |
| `src/js.rs` | `number_to_string`, how LogSeq (ClojureScript) spells a number in `(str ?v)`, for a `find_blocks` property value. Results are written by `serde_json`, keys in insertion order. `trim` and the white-space set are Rust's, and text lengths and cuts count code points |
| `src/order.rs` | The one fixed order for names: lowercase by code point, then the name itself |
| `tests/no_stdout.rs` | Fails on any write to stdout, which is the MCP channel (ADR-0004) |

## Code Organization

```
Cargo.toml, Cargo.lock             - The crate: dependencies, each justified in a comment; the lockfile is committed
rust-toolchain.toml                - The pinned compiler, which CI reads too
about.toml, about.hbs              - cargo-about config and template for THIRD-PARTY-NOTICES.txt (release)
src/                               - The server: one crate (docs/architecture.md has the file-by-file map)
├── main.rs, lib.rs            - Starts the server on stdio; the crate's module list
├── server.rs                  - rmcp ServerHandler: initialize, tools, prompts, resources. Only wires
├── client.rs                  - LogseqClient: call_api and execute_datalog_query, timeout per call, LogseqError
├── edn.rs                     - Typed query values (PageName, PageId, JournalDay, BlockUuid), DatalogInput, Query, ground_ids / ground_uuids
├── config.rs, env.rs          - The config file and the environment, each parsed once at startup
├── tool.rs, args.rs, params.rs - What every tool shares: read-only hints, schema generated from the argument type, the one argument parse (`parse_args`), parameter aliases
├── wire.rs, entity.rs         - LogSeq's answers parsed at the boundary (ResponseError), and a page or block in either key spelling
├── errors.rs, meta.rs, truncation.rs, tips.rs, slim.rs - ToolError, ResultMeta, the warnings a cap carries, next-step tips, slim output
├── resolve/, resolve_refs/    - The page resolver (BR-0010) with the alias groups, and `((uuid))` / `{{embed}}` resolution (BR-0007)
├── markdown.rs, markdown_context.rs, compact.rs, snippet.rs - The one Markdown renderer, Markdown for the context tools, compact JSON, snippets
├── property.rs                - A property key and the rule for matching a property by value, shared by `find_blocks` and `find_pages`
├── toon.rs                    - The one TOON encoder, for the opt-in `format: "toon"` of the flat-list tools (BR-0014)
├── prompts.rs, resources.rs, instructions.rs - The five prompts, the page resource and guide, the server instructions
└── tools/<tool>/              - One directory per tool (10): mod.rs (NAME, definition, call), queries.rs, wire.rs, tips.rs where it has them

tests/                             - Rust integration tests (Cargo reads tests/*.rs) and the Node tooling around the crate (vitest, dev-only)
├── *.rs, common/, parity_support/, data/ - Call-count tests against a mock LogSeq (common/mod.rs), the no-stdout and env-read checks, and the parity test (parity*.rs) with its data (data/parity/: the cases and the golden results) and its recorder
├── guards/                        - The repo's rules as tests: docs format, templates, privacy, fixture, workflows, tool-list limits, golden files
├── rust-guards/                   - Guard tests that start the Rust binary: the live tool list, wrong-typed arguments, the version
├── integration/                   - Tests against a real LogSeq serving the fixture, through the Rust server
│   └── properties/                - Property-based tests
└── fixtures/                      - The made-up graph (graph/) and the hub fixture

scripts/
├── probe-constraints.ts           - Verifies the Datalog/API constraints against a live LogSeq (use the fixture)
├── measure-api-calls.ts           - Counts API calls per tool against a live graph (baseline: the real graph)
├── measure-output-size.ts         - Output bytes per tool, slim vs full and markdown/compact vs json, through the MCP server
├── measure-footprint.ts, measure-latency.ts - Start-up, memory and size of the release binary (#126), and per-tool latency and call counts (#353), against a stub LogSeq (`lib/stub-logseq.ts`)
├── measure-server.ts, lib/        - Shared code: the call-counting proxy of the measure scripts, and the LogSeq API client, Rust binary lookup and MCP stdio client the suites and scripts use
├── smoke-rust-server.ts           - Drives a release binary through all 10 tools against the fixture instance (#359)
├── logseq-instance.ts             - start/stop/status of this worktree's own LogSeq on a copy of the fixture graph (#118, #151, macOS)
├── docs-format.ts                 - The format check for docs/adr and docs/business-rules (the guard test runs it)
├── generate-hub-fixture.ts        - Writes (or --check's) the hub fixture's files from fixture-hub/hub-graph.ts (#89)
├── fixture-hub/hub-graph.ts       - Shape and counts of the hub fixture; tests/guards/fixture-hub.test.ts checks the committed files against it
└── logseq-instance/
    ├── instance.ts                - Instance logic: paths, port, random token, graph copy, launch, readiness, stop (deps injected)
    ├── local-storage.ts           - Writes a fresh profile's Chromium localStorage LevelDB (current-repo, http-server-enabled)
    └── configs.edn.template       - App settings for the instance (API autostart, port and token placeholders)

skills/logseq-skills/              - Claude Code skills (SKILL.md, skills/, references/, scripts/); symlinked from .claude/skills/
.claude-plugin/                    - plugin.json + marketplace.json (the server entry runs the launcher, `scripts/logseq-mcp-server.sh`, ADR-0035)
```

**Key files:**
- `src/tools/explore_context/queries.rs` - Query builders: typed inputs, `:in` binding and `ground_ids` (study this for patterns)
- `src/tools/explore_context/mod.rs` - Example of two-query pattern
- `src/tools/explore_network/mod.rs` - Example of multi-query BFS
- `tests/concept_calls.rs` - Example of a call-count test against the mock LogSeq
- `tests/integration/properties/graph-properties.test.ts` - Property-based testing examples
