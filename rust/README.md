# Rust spike

The LogSeq MCP server in Rust. It began as a bounded spike
([ADR-0025](../docs/adr/0025-rust-implementation-alongside-typescript.md), #122) beside a TypeScript server, and
since the Go on #349 (2026-10-08) it is the only server on this branch: the TypeScript server was removed in #356.
The tool contract it keeps is that server's. Comments in this crate that name `src/*.ts` files mean that server as
of commit `10103c8` (its last version is readable there, as `10103c8:src/client.ts`), and
`tests/data/parity/` holds its recorded results, which the parity test holds this crate to (`cargo test`, below).
`// PARITY(#299)` tags the code that exists only to match it.

It lists all 16 tools, the five prompts, the reading guide and the page resource, and the server
`instructions`, and the parity test holds each to the recorded output (#316). It began
as a skeleton (#123): the LogSeq HTTP client, EDN-encoded Datalog inputs, the config file
and an MCP stdio server. The first tool was `logseq_get_page_outline` (#125), which exercises the
pieces most likely to differ between implementations: the shared page resolver, a Datalog query
bound with `:in`, a capped result with a warning, sibling order by the `:block/left` chain, and
2 API calls. `logseq_get_backlinks` (#307) adds the alias groups (#69) and a result that is the Editor API's own entities, kept as sent. The Markdown renderer (#310) is `src/markdown.rs`, behind `format: "markdown"` on `logseq_get_page` and `logseq_get_block` and the `logseq://page/{name}` resource.

| File | What it holds |
|---|---|
| `src/env.rs` | The environment, read once at startup into `Env`: `config_path` (`LOGSEQ_MCP_CONFIG` or `~/.logseq-mcp/config.json`, absolute by type), `tips` (`LOGSEQ_MCP_TIPS`) and `clock` (`LOGSEQ_MCP_NOW`, a fixed instant in milliseconds for the parity test; unset is the system clock; a release build ignores it). Nothing else reads a variable (`tests/env_reads.rs`) |
| `src/config.rs` | The config file, parsed once. Its errors never show a file value (ADR-0003) |
| `src/client.rs` | `call_api` and `execute_datalog_query`: bearer token, a timeout per call, and the same error mapping as the TypeScript server's client |
| `src/edn.rs` | What goes into a query, typed by meaning so an invalid value can't be built: `PageName` (lowercase on construction), `JournalDay` (a real `YYYYMMDD` date), `PageId` (positive `:db/id`), `BlockUuid` (strict, lowercase). `DatalogInput` binds them to `:in` as `JSON.stringify` would (ADR-0013); `ground_ids` and `ground_uuids` write the embedded `ground` literals |
| `src/server.rs` | rmcp `ServerHandler`: `initialize` (the name, `serverInfo.version` from `../package.json` and the `instructions`), `tools/list`, `tools/call`, and the prompt and resource requests. It only wires: each tool is in `src/tools/`, what they share is in `src/tool.rs` |
| `src/prompts.rs`, `src/instructions.rs`, `src/mcp_error.rs` | The five prompts (`prompts.ts`: `prompts/list` and `prompts/get`, each one short user message that names the tools; arguments are strings, an unknown or malformed one is `InvalidParams`; the week and month come from the server's clock, never read inside a builder). The server `instructions` (`instructions.ts`, byte for byte; the guide resource's recorded bytes hold them). And the JSON-RPC error the TypeScript SDK's `McpError` sends, shared by the prompts and the resources |
| `src/markdown.rs`, `src/resources.rs` | The one Markdown renderer (`markdown.ts`: title, resolved-from note, page properties and the pre-block rule, the block outline with its cap, a single block, the warnings/hasMore/tips footer); `compact`, `show_uuid` and `show_page` on the outline are the context tools' (#312). And the resources (`resources.ts`): `resources/templates/list` and `resources/read` of `logseq://page/{name}`, cut at `MAX_PAGE_CHARS`. `resources/list` and the reading guide `logseq://guide` (the instructions plus a one-line index of the tools, prompts and resources) are here too |
| `src/tool.rs` | What every tool shares: the read-only hints, the input schema generated from the argument type (every named type written in place: the MCP SDK's client drops `$defs`), argument parsing at the boundary, and the TypeScript server's result shapes |
| `src/tools/<tool>/` | One directory per tool: `mod.rs` (`NAME`, `definition`, `call`) and everything only that tool uses: its queries, the LogSeq answers it reads (`wire.rs`), its tip and its tests. `src/tools/mod.rs` registers them. Today: `get_page_outline/` (#125), `get_backlinks/` (#307), `get_graph_info/`, `list_pages/` and `search_blocks/` (#306), `get_block/` and `get_page/` (#308), `query_by_date_range/` (#311), `build_context/` and `get_context_for_query/` (#312), `search_by_relationship/` and `check_links/` (#314), `get_concept_network/` and `get_concept_evolution/` (#313) |
| `src/markdown_context.rs`, `src/compact.rs`, `src/snippet.rs` | Markdown for the context tools (`markdown-context.ts`: a topic's blocks, related pages and references by source page, and a query's topics and keyword hits, and a concept network's pages by depth and its links, #313); `compact` JSON (`compact.ts`: a block is `{ uuid, snippet }`, a page `{ id, name, originalName }`); and the first-line snippet (`snippet.ts`), also the outline's |
| `src/args.rs` | `Arguments`: a tool's arguments read one by one in the order of its schema, `null` as absent, nothing coerced, a bad one worded as `parseArgs` words it (`an integer, not a fraction`, `at least 0`, zod's own `Too big`) |
| `src/entity.rs`, `src/slim.rs` | A page or block as LogSeq spells it, in either key spelling (`entity-fields.ts`) with the checks of the entity schemas; and slim output (`slim-entities.ts`, BR-0012). Entities stay the `Value`s LogSeq sent, so a full result carries them as they came |
| `src/truncation.rs`, `src/escape.rs` | The warnings a capped list carries (`result-meta.ts`) and regex escaping (`escape-regex.ts`) |
| `src/wire.rs` | The reader every wire type is written with: LogSeq's answers parsed into typed values at the boundary (`src/response-schemas.ts`). A mismatch is a `ResponseError` naming the path in zod's words, never "no data" |
| `src/resolve/` | The shared page resolver (BR-0010): exact name, alias, ISO date, namespace leaf, the closest names for a miss. Its queries and wire types are in the directory, since only it reads them. `resolve/alias.rs` holds the alias groups (#69): one query for any number of pages, none for a page with no alias link. `resolve/link_targets.rs` resolves the many names of a `[[link]]` pass by name or alias in one query (#146) |
| `src/pages_by_ids.rs` | The query that pulls full page entities for some ids (`getPagesByIds`), shared by `search_blocks` (`include_context`) and `get_current_context` (#327) |
| `src/block_tree.rs` | `camelizeKeys` and `camelizeBlock`: a pulled block in the Editor API's spelling; `orderSiblings`: sibling blocks in page order, by their `:block/left` chain; and `buildBlockTrees`: the trees of many pages from the flat blocks one query pulls |
| `src/dates.rs`, `src/block_budget.rs` | Calendar dates (`date-utils.ts`, `date-presets.ts`): the eight presets as plain calendar arithmetic, and a `Clock` that reads today's date in the host's local zone through `localtime_r`, so it honours `TZ` as Node does. And `block-budget.ts`: cutting block trees to a count of blocks, nested ones included |
| `src/resolve_refs/`, `src/output_format.rs` | `((uuid))` refs and `{{embed}}`s resolved in returned blocks, one batched query per nesting level (BR-0007; `resolve-refs.ts`), with the ref and embed patterns written out since the crate has no regex engine; and the `format` parameter, `json` or `markdown` |
| `src/errors.rs`, `src/meta.rs`, `src/tips.rs`, `src/params.rs` | What tools share: the errors (messages word for word as `src/errors.ts`), `ResultMeta` and the ambiguous-name result, next-step tips, parameter aliases and the wording of a bad argument |
| `src/fuzzy.rs` | The closest names for a missing page, picked with `nucleo-matcher` (`Pattern::new`, `AtomKind::Fuzzy`): names equal to the input first, then names that start with it, then names that contain each of its words in order, best score first. The parity test holds the list to ADR-0032's rules, not to the TypeScript server's bytes |
| `src/js.rs` | The JavaScript rules the output depends on: `trim`, number formatting, `JSON.stringify` key order, UTF-16 strings and `localeCompare` (ICU root collation, from `icu_collator`) |
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

`cargo test --locked` runs the golden-result test (#124, #371). `tests/parity.rs` starts the binary cargo built,
answers its LogSeq calls from a stub on a random local port, and holds it to what the TypeScript server did
before it was retired, as recorded in `tests/data/parity/`: each result (a JSON tool result by deep equality, then
minified; markdown, prompts, resources and the frame of a page-not-found message byte for byte; the closest names
of a page-not-found message by the rules of ADR-0032, below), the LogSeq calls (by a bounded count and an effect, not
by text or order: every call matches a recorded call, at most a ceiling are made, all are reads; below) and
`tools/list` by meaning (ADR-0031). `parity_self_check.rs` runs the cases once more with the last answer of each
changed and requires every case with a LogSeq call to fail, again with every ceiling one lower, and the closest-name
rules to catch every kind of wrong list. `parity_comparator.rs` and `parity_harness.rs` hold the
comparator, the stub and the run to their own rules. Fixtures are made up (BR-0001). `cargo-mutants` (ADR-0033)
counts the cases: a mutant dies when a case notices it. Every comparison rule is in `tests/parity_support/compare.rs`:
`compare_results` judges a result, and `same_tool_text` and `same_text` are the only places that decide whether two
texts match.

The cases and their golden results live in `tests/data/parity/*.json` and nowhere else (#379). A group file holds its
cases, one to a line: the stub answers, the MCP request, the recorded calls (as `steps`) and, under `expected`, the
golden result. `tool-list.json` is the recorded `tools/list`, `clock-cases.json` lists the cases that read today's
date, and `call-ceilings.json` holds each case's call ceiling (below). They are in `rust/` because a copy of it is all `cargo-mutants` has. To add or change a case, edit its line, leave
out `expected` for a case that has none yet, and record it:

```bash
cd rust && PARITY_RECORD=1 cargo test --test parity_record -- --nocapture
```

The recorder runs every case against the stub with the debug build and rewrites only what changed in meaning. A
case with no `expected` takes its result. One whose result differs from the recorded one, by the comparison the
test uses, takes the new one. One that is the same by meaning keeps the bytes recorded for it, so the diff is the
change and not the spelling of the Rust server's output. The tool list is done the same way, tool by tool. It
refuses to run when `CI` is set or in a release build, and writes nothing when a case's LogSeq calls are wrong or the
closest names would break ADR-0032's rules. A recorded result is the tool contract: a change to one needs the
maintainer's explicit OK, recorded on the pull request, and the `golden-change` label that the `golden-files` job of
`ci.yml` looks for.

### LogSeq calls: a count and an effect

ADR-0034 Decision 5. What a tool asks LogSeq is not part of its contract, so long as the asking is bounded and right.
For each case `compare_calls` (`tests/parity_support/compare.rs`) and the stub (`tests/parity_support/stub.rs`) hold
the server to this:

- Every call the server makes matches a recorded call in method, query text (layout ignored) and inputs. A call
  that matches none fails the case, whatever the server does with the error, so a best-effort path that swallows it
  still fails. A query asked twice is matched to its recorded answers in the recorded order, and a call asked more
  often than it was recorded has no answer left.
- At most the case's ceiling of calls are made (ADR-0011). A recorded call the server never makes is not a failure
  by itself, but a run of the cases as committed that makes **fewer** calls than the ceiling fails until the ceiling
  is lowered (below), so a saved call can't be spent again later without asking.
- Every recorded call is a read, and so is every call made (BR-0002, `is_read_method`).
- The order of the calls, their grouping into the `steps` of a case and whether they ran at once are not compared.

The ceiling is in `tests/data/parity/call-ceilings.json`, a case name to a number, apart from the fixtures, so adding
or rewriting a fixture can't raise it. It starts at the number of calls the case records, and no ceiling may exceed
that number. A PR that makes fewer calls lowers it: `PARITY_RECORD=1 cargo test --test parity_record -- --nocapture`
does it for every case that made fewer calls than its ceiling, and the failure for a ceiling above the calls made
names that command. Lowering needs no OK. **Raising a ceiling, or adding one, needs the
maintainer's explicit OK**, and the second step of the `golden-files` job in `ci.yml` fails a PR that does either
unless it carries the `golden-change` label, which only the maintainer adds. The recorder never raises one.

**Re-recording a call** (a leaner query, a merged or narrowed call, a removed shim). ADR-0034 allows it when no golden
result changes, the case's call count stays within its ceiling, every call is a read and the new query is right on
real LogSeq:

1. Edit the call in the case's line of `tests/data/parity/<group>.json`: its `method`, `args` (the query text and its
   inputs) and the `response` the stub gives. Derive the new `response` from the answers it replaces (a merged call
   answers with the union of the old answers, a narrowed one with a subset), not from what the server happens to need,
   and show that derivation in the PR.
2. Run `cd rust && cargo test --locked --test parity --test parity_self_check`. It must pass with no `expected` edited
   and no ceiling raised. If the case now makes fewer calls, the run fails with "under the case's ceiling": lower the
   ceiling with the recorder (above) or by hand.
3. Run the integration suite against this worktree's fixture graph, which shows that the query is right on LogSeq (the
   parity answers are made up, so the parity test can't): `npx tsx scripts/logseq-instance.ts start`, then
   `npm run test:integration`, then `npx tsx scripts/logseq-instance.ts stop`.
4. In the PR, say that no golden changed and no ceiling was raised, and show the derivation. A reviewer reads it
   against the diff.

The test runs the server in one time zone (`America/New_York`) with one instant as "now" (`LOGSEQ_MCP_NOW`,
2025-03-12T03:30Z, which is still the evening of the 11th there): a result that depends on today's date (`last_n`, a
preset) is then the same on every day, and a server that reads the date in UTC fails. The Rust server reads the
variable itself.

The whole `tools/list` is compared, and the cases cover every tool, `prompts/list`, `prompts/get`,
`resources/list` and `resources/read` (the guide, a page and the unknown-URI error). The release binary
(`cargo build --release --locked`) ignores `LOGSEQ_MCP_NOW`, so it reads the real date and can't match the recorded
results that depend on today (`last_n`, a preset, a weekly or monthly prompt for "this week"). Under `--release` those
cases leave the run: `clock-cases.json` lists them, and `parity_harness.rs` checks that it names exactly the cases
whose result moves with the clock. CI runs the others against the release build after it, on `main` and on a manual
run (#359):

```bash
cargo test --release --locked --test parity --test parity_self_check
```

The closest names after `Closest:` in a page-not-found message are not compared byte for byte (ADR-0032 Decision 3,
`tests/parity_support/suggestion_rules.rs`): the test checks the message frame, that the list is one to three distinct
page names, that exact and prefix matches come first, that every name covers every word typed, and that there are as
many as there are to list, up to three. It fails when the recorded cases lack one the ADR requires.

## Running it

It reads the same config file as the TypeScript server. To point it at this worktree's fixture
instance rather than the personal graph, run `npx tsx scripts/logseq-instance.ts start` and set
the `LOGSEQ_MCP_CONFIG` it prints.
