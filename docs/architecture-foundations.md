# Architectural Foundations

Read this before you write or change code in this repo. It describes how to think about the system you are changing. These are aspirational principles: the code doesn't follow all of them yet, and issue #58 tracks the work to get there.

This server is a small Rust program (the crate in `rust/`) that sits between an MCP client and a LogSeq desktop app. It reads from a personal knowledge graph over a local HTTP API and returns results to an LLM. Every principle below is scoped to that.

The principles were first written for a TypeScript server, which was retired after the Go on #349 (#356, ADR-0025). The repo is Rust-only now, so each "In this repo" paragraph below names the Rust crate's pieces. Where code or a comment names a `src/*.ts` file, it means that server as of commit `35fa2dd3`, whose last version is readable with `git show 35fa2dd3:<path>`. The tool contract it set lives on as the recorded results in `rust/tests/data/parity/`, which the parity test holds the Rust server to. Code that exists only to match that server's bytes or quirks is tagged `// PARITY(#299)` (`grep -rn 'PARITY(#299)' rust/src` lists it).

## 0. How to use this document

**Precedence.** When instructions conflict, apply them in this order:

1. The maintainer's explicit instruction for the current task.
2. `CLAUDE.md`: its privacy rules, development workflow, review gate, merge policy and conventions. This document never overrides it.
3. The hard rules in section 2. They hold against existing code patterns, unless the maintainer explicitly waives one for this task.
4. The existing patterns in the code.
5. The principles in this document.
6. General habits.

**Existing code vs. new code.** When you edit existing code, follow its local idioms, even if they differ from what this document prefers. Don't migrate a module as a side effect of an unrelated task. Apply the principles fully when you write something new. If a local convention looks harmful, follow it and flag it in your notes. Don't fix it uninvited.

**When to stop and ask.** Stop and ask, rather than guess, when:
- the requirement is ambiguous *and* the two readings lead to different tool contracts or output shapes;
- the change is hard to reverse (a public tool rename or removal, rewriting git history);
- you would need to remove or weaken a safeguard you don't understand.

For everything else, make the reasonable call and write the assumption down (section 6).

## 1. The idea behind everything here

Agents make code nearly free to produce. They don't make it free to understand, review, or change. The scarce resources are human review time and the clarity of the system's concepts. So:

- **Every change you make is input to the next agent.** Types, schemas, tool descriptions, tests and names are the context the next reader (human or model) acts on. Precise inputs raise everyone's first-attempt success. Vague ones cap it.
- **Count concepts, not lines.** A new tool, parameter, abstraction, flag or dependency is a permanent cost. Add one only when the task needs it.
- **The hard part is deciding what to build, not typing it.** Spend your effort on the data shapes, the tool contract and the failure modes. The code usually follows.

## 2. Hard rules

These are not judgment calls for code you add or change. Existing code that doesn't meet them yet is tracked in #58. Don't fix that as a side effect of another task (section 0), but don't make it worse. If your change can't satisfy one, stop and say so.

Rules 4, 6 (graph data), 8 and 10 are also promises the tools make to their user. Their full text, rationale and enforcement live in [`business-rules/`](business-rules/README.md), and the list below keeps a one-line summary of each. The other rules are stated in full here.

1. **Never remove or weaken a safeguard you don't understand.** Caps, guards, odd early returns, "don't touch" comments, timeouts and validation exist for a reason you may not see. Keep them, give them a clear name, and ask about them in your notes.
2. **When refactoring, preserve behavior exactly.** Pin current behavior with tests before you restructure. If you believe existing behavior is a bug, keep it and flag it. Changing it is a separate, explicit decision.
3. **Parse all external input at the boundary before doing work.** External input means MCP tool arguments, LogSeq API responses, the config file and anything read from disk. Invalid input fails early with a clear error.
4. **Tools stay read-only.** See [BR-0002 (tools-read-only)](business-rules/0002-tools-read-only.md).
5. **Bound everything.** Every network call has a timeout. Every loop over graph data has a cap. Every tool result has a size limit, because the reader is an LLM with a finite context window. No unbounded fan-out (a spawned task or a concurrent call per element) over an input-sized collection.
6. **No secrets in source, and no personal graph data in committed files or logs.** The graph this server runs against is personal data. What may never be committed or posted is in [BR-0001 (no-graph-data-in-repo)](business-rules/0001-no-graph-data-in-repo.md).
7. **No new dependency without verifying it exists, is maintained and is needed.** Check the standard library and existing dependencies first. Never add a crate or package name from memory without confirming it in its registry (crates.io for the crate, npm for the dev tooling).
8. **Tool contracts change additively.** See [BR-0004 (additive-tool-contracts)](business-rules/0004-additive-tool-contracts.md).
9. **Never take destructive actions on your own outside the `CLAUDE.md` workflow.** Rebasing and force-pushing your own feature branch, and deleting it on merge, are part of that workflow. Rewriting `main`'s history, force-pushing or deleting someone else's branch, and deleting data are not. Propose those; the maintainer runs them.
10. **Don't report success you haven't verified.** See [BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md).

## 3. Before you write code

Work through this list, in order, for any non-trivial change:

1. **Read the surroundings.** Find the existing pattern for what you're about to do (how tools parse input, build queries, handle errors, test). Extend it rather than introducing a second way.
2. **Design the data first.** Write the types and the tool's input and output shape before the logic. If the logic feels convoluted, the data model is usually wrong.
3. **Mark the boundaries.** List where untrusted data enters (tool args, LogSeq responses) and where your code calls something that can fail or be slow (every `call_api` and `execute_datalog_query`).
4. **List the failure modes.** For each boundary: what happens on a timeout, LogSeq not running, a rejected token, malformed input, an empty result, a result too large to return? Decide the behavior for each, explicitly.
5. **Write down assumptions** you make about unclear requirements (section 6).

## 4. Principles

Each principle gives the rule, why it matters, how it looks in this repo, and the mistake agents most often make.

### 4.1 Make illegal states unrepresentable

**Rule.** Choose the most precise type that is reasonable. Use enums instead of a bag of optional fields and booleans. Use a newtype with a constructor when an invariant the type system can't express is checked in more than one place (for example a validated `YYYYMMDD` date). Construct objects fully valid or not at all.

**Why.** A type that can't hold a bad value removes a whole class of checks and bugs downstream. Narrow types also tell the next reader what the code can do.

**In this repo.** The values that go into a query are types that can only be built valid: `PageName` (lowercase on construction), `JournalDay` (a real calendar date), `PageId` (a positive `:db/id`) and `BlockUuid` (strict hex) in `rust/src/edn.rs`, and `DatalogInput` has no `From<String>`, so a free string can't be bound by accident. What can stop a tool is one enum, `ToolError` (`rust/src/errors.rs`). `call_api` returns the `serde_json::Value` LogSeq sent, and a tool parses it into a typed value before it reads a field (4.2). Results that can be truncated, partial or empty should say so in the type, through `ResultMeta` (`rust/src/meta.rs`), rather than leaving the caller to infer it.

**Agents get wrong.** Reaching for escape hatches: `unwrap()` and `expect()` on anything a user or LogSeq can influence, `as` casts that truncate or wrap, `unsafe`, `#[allow(...)]`, and a `Value` read by hand where a typed value should be parsed. Each one needs a comment that justifies it (the crate's one `unsafe` block is the `localtime_r` call in `rust/src/dates.rs`).

**Balance.** Use types to encode invariants, not to group fields for its own sake. A wrapper type that only bundles unrelated fields adds indirection without adding safety.

### 4.2 Parse, don't validate, at every trust boundary

**Rule.** Convert less-structured input into a precise type once, at the edge. A validation function should return the parsed value, not `void` or `boolean`. Fully parse before acting.

**Why.** Checks that don't produce a typed result get skipped, duplicated or drift apart. Parsing first means bad input fails before any work is done.

**In this repo.**
- **MCP tool arguments:** each tool parses its arguments into a typed value in one place and fails with `InvalidParameter` (`ToolError::InvalidParameter`). A tool parses its arguments into its `Args` type with `parse_args` (`rust/src/args.rs`) before it makes a LogSeq call, so a bad one fails first: `null` counts as absent, nothing is coerced, and the first bad argument in the order the type declares them is the one reported, worded in that one file. The tool's `inputSchema` is generated from the type the arguments are parsed into (`input_schema` in `rust/src/tool.rs`, through schemars), so the schema and the parser can't drift (ADR-0019). Parsing runs after `resolve_param_aliases` (`rust/src/params.rs`). See [BR-0008 (param-aliases-best-effort)](business-rules/0008-param-aliases-best-effort.md).
- **LogSeq responses:** parse every response into a typed value with the reader in `rust/src/wire.rs` before a tool reads it. The wire types live beside the code that reads them (the resolver's in `rust/src/resolve/wire.rs`, a tool's in its own `wire.rs`) and hold only the fields the code reads. The parse is strict about the fields the code reads with no fallback, silent about the rest, and tolerant of what the code already reads with a fallback or skips (an optional field stays optional). A mismatch is a `ResponseError`, never an empty result, and `null` stays distinct from `[]` (the parsers answer `None` for `null` and the tool decides what that means). The error names the method and the path of the first mismatch and never a value. A full result carries each entity as LogSeq sent it, because LogSeq spells the same field differently in the Editor API and in Datalog (`originalName` vs `original-name`) and renaming those output keys is a contract change ([BR-0004 (additive-tool-contracts)](business-rules/0004-additive-tool-contracts.md)). So entities stay `Value`s, and `rust/src/entity.rs` keeps both spellings readable in one place.
- **Config and environment:** parse once at startup into a typed value and fail fast: the file in `rust/src/config.rs`, the environment in `rust/src/env.rs`. Nothing else reads an environment variable (`rust/tests/env_reads.rs` checks it).
- **Tool inputs that become queries:** strings go in as `:in` inputs (`DatalogInput`), never embedded in query text (see `CLAUDE.md`, constraint 6). Numeric ids go through `ground_ids`, which takes `PageId`s, not numbers, and uuids through `ground_uuids`.

**Agents get wrong.** Strict parsing that rejects fields LogSeq adds in a newer version (a serde type with `deny_unknown_fields` on a LogSeq answer). Be strict about the fields you read and tolerant of the ones you don't (tolerant reader). Also: "parsing" that silently coerces (`"87"` to `87`, missing to a default through `#[serde(default)]` or `unwrap_or_default()`) hides defects. Reject or log instead.

### 4.3 Contracts are the specification

**Rule.** The tool schemas are the primary artifact. Change them first, deliberately, and keep them backward compatible.

**Why.** An MCP client, a skill, or a prompt that names `logseq_search_blocks` and its parameters is a consumer you can't see. The schema is how it agrees with the server about reality.

**In this repo.** Tool names, parameter names, required fields and the shape of results are the contract. Contracts change additively ([BR-0004 (additive-tool-contracts)](business-rules/0004-additive-tool-contracts.md)), and every tool keeps its read-only annotations ([BR-0002 (tools-read-only)](business-rules/0002-tools-read-only.md)).

**Agents get wrong.** "Simplifying" LogSeq's awkward API in tool output by leaking its quirks into the contract, or the reverse: reshaping a result field because it looks neater. Validate LogSeq's answer at the boundary and keep its two key spellings behind `rust/src/entity.rs`, so tool code never carries its own fallback from one spelling to the other. Don't rewrite the keys of an entity a tool returns: that changes the output contract (BR-0004), and a canonical shape needs a deliberate, versioned change, not a refactor.

### 4.4 Minimize state; derive, don't duplicate

**Rule.** Do not store what you can compute. Keep logic in pure functions. Push I/O and the clock to a thin outer layer (functional core, imperative shell).

**Why.** Every stored copy can drift, and stateful code is hard to test.

**In this repo.** The server holds no state between calls. LogSeq is the single source of truth, so leave it that way. Tool logic that shapes, trims or merges results (slimming, tree building, date handling) belongs in pure functions with unit tests, such as `slim.rs`, `block_tree.rs`, `dates.rs` and `truncation.rs`. Only `client.rs` talks to the network, and the clock and the environment are read once at the edge (`Clock` in `dates.rs`, `Env` in `env.rs`) and passed in, so a test can fix them.

**Balance.** A cache is allowed when you have a measured reason (call count, latency). It must be clearly separate, have one owner for invalidation and be rebuildable. Removing it should leave a correct, slower server. Don't add one speculatively.

### 4.5 Keep the server read-only and re-runnable

**Rule.** Every tool call can be repeated safely and the server never writes. See [BR-0002 (tools-read-only)](business-rules/0002-tools-read-only.md).

**Why.** MCP clients retry, and LLMs call the same tool twice. A read-only tool makes that harmless.

**In this repo.** No tool keeps state between calls. If a future tool needs to write to the graph, stop and ask (hard rule 4).

### 4.6 Bound resources and time

**Rule.** Every external call has a timeout. Loops over graph data have caps. Results have a size limit. Know where work scales with the size of the graph.

**Why.** An unbounded call hangs the client. An unbounded result floods the model's context. You can't tell a slow dependency from a dead one, so you must choose when to give up.

**In this repo.**
- `call_api` applies a timeout to each request (`timeout_ms`, default 30 s). Tools that make many calls get it per call, so also bound the number of calls.
- Prefer one batched Datalog query over one call per entity (`CLAUDE.md`, Pattern 4). A per-page crawl on a 2k-page graph is a bounded-resources bug, not a style issue.
- Every list-returning tool has a default cap and a maximum, and reports a cap that bites through `ResultMeta` (`rust/src/meta.rs`, with the warnings in `rust/src/truncation.rs`). See [BR-0006 (no-silent-truncation)](business-rules/0006-no-silent-truncation.md). Tips are never a truncation signal ([BR-0009 (tips-are-advisory)](business-rules/0009-tips-are-advisory.md)).
- Classify errors: see [BR-0003 (infrastructure-errors-propagate)](business-rules/0003-infrastructure-errors-propagate.md).

### 4.7 Changing existing code safely

**Rule.** Before changing code that isn't well tested, write characterization tests that pin what it does today, including behavior that looks wrong. Then refactor in small, behavior-preserving steps. Then add the new behavior. Keep these distinguishable in commits.

**Why.** Without a recorded baseline you can't tell a regression from an intended change. The original author's reasons are usually invisible. The code is the only specification left.

**In this repo.** Four kinds of test pin behavior, from the cheapest up:
- **Rust unit tests** (`cd rust && cargo test --locked`) sit beside the code. The call-count tests in `rust/tests/*_calls.rs` run a tool against a mock HTTP LogSeq and assert the exact calls it makes and the result it returns.
- **The golden-result test** (`rust/tests/parity.rs`, run by `cargo test`; `rust/tests/parity_record.rs` is the recorder) starts the built server against a stub LogSeq and compares every tool, prompt and resource result byte for byte with the results recorded from the TypeScript server before it was retired (`rust/tests/data/parity/`, which holds the cases too), and `tools/list` by meaning (ADR-0031). The recorded results are the tool contract and the characterization tests of the whole server: a change to one is a contract change.
- **Guard tests** (`tests/guards`, `tests/rust-guards`) hold the repo's rules.
- **Integration tests** (`npm run test:integration`) run the Rust server against the committed fixture graph in a live LogSeq and assert exact results on its known pages.

Use the unit tests to pin shapes and the harness and integration tests to pin behavior against real data. Commit tests, refactors and behavior changes separately.

**How to treat what you find.**
- Odd early returns, magic thresholds and special cases are often safeguards against real LogSeq behavior (see the constraints in `CLAUDE.md`). Preserve them, give them intention-revealing names and comment what they protect against if it's evident. Ask if it isn't.
- If something looks like a bug, keep the behavior, add a test that documents it as current (not endorsed) behavior, and raise it in your notes.
- Don't rewrite. Rewrites discard the hidden knowledge that makes old code work.

**Agents get wrong.** "Cleaning up" by deleting checks that look redundant, normalizing inconsistent-looking behavior, or rewriting from scratch. These are the most damaging changes an agent makes, because they pass review when the reviewer also lacks the history.

### 4.8 Ship small, reversible changes

**Rule.** One logical change per commit and per PR. Each commit builds and passes `cargo test --locked` on its own.

**Why.** Small changes are easy to review, debug and revert, and a failure points at its cause.

**In this repo.** Commit early and often: once a coherent, working slice is done, commit it rather than batching many changes into one commit. Don't reformat, rename or "improve" unrelated code in the same change. Update the API-call table in `CLAUDE.md` when you change a tool's call count.

**Agents get wrong.** Large multi-concern diffs, and drive-by changes outside the task.

### 4.9 Report the truth: errors and honest state

**Rule.** Everything you report (error messages, return values, status fields, summaries, notes) must describe what actually happened.

**Why.** People and agents act on what they are shown. A result that says "no matches" when the query failed, or a summary that counts attempts as successes, causes wrong decisions.

**In this repo.**
- Error messages guide recovery and stay actionable ([BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md)).
- Partial and truncated results say so through `ResultMeta` `warnings` ([BR-0006 (no-silent-truncation)](business-rules/0006-no-silent-truncation.md)).
- Never write to stdout. It is the MCP channel. Log with `eprintln!`, sparingly (`rust/tests/no_stdout.rs` fails on `println!` and the like), and never log block content, page names or other graph data (hard rule 6).
- An error arm that swallows the error, or maps it to an empty result (`.ok()`, `unwrap_or_default()` or a `match` arm on a `Result` from LogSeq), is a defect ([BR-0003 (infrastructure-errors-propagate)](business-rules/0003-infrastructure-errors-propagate.md)). Propagate with `?`, adding context through a typed `ToolError` when it helps.

**Agents get wrong.** Summaries that overstate success, and catch-all arms that return an empty result.

### 4.10 Dependencies are liabilities

**Rule.** Prefer the standard library, then dependencies the repo already has, then a new dependency, in that order. A new dependency needs a reason, a verified registry entry, an active maintainer and an acceptable license.

**Why.** Third-party code runs with your privileges and is the most common supply-chain entry point. Agents add packages in seconds, including names that don't exist or that impersonate real ones.

**In this repo.** `Cargo.lock` is committed and CI builds with `--locked`, and `rust/rust-toolchain.toml` pins the compiler. `rust/Cargo.toml` says in a comment why each dependency is there, which of its features are on and what it already pulled into the tree: a new one does the same, with its licence (the repo is MIT, ADR-0023). Don't add a crate for what `std` does. Don't hand-bump unrelated dependencies. Remove dependencies your change made unused. `rmcp`, the MCP SDK, is a dependency too: treat upgrades as contract changes and run the parity harness afterwards. The Node tooling (the parity harness, the guard tests and the scripts, locked in `package-lock.json`) is dev-only, and the same care applies to it.

### 4.11 Designing MCP tools

**Rule.** Treat the model on the other end as a slow, non-deterministic, untrusted caller. Treat tool descriptions as code.

**In this repo.**
- Narrow, typed parameters and clear names. One tool, one job.
- Each tool's description is in its own `rust/src/tools/<tool>/mod.rs` (`definition`). They are what the model reads to choose a tool, so keep them accurate when behavior changes. Every client loads the whole tool list into its context, so the guard tests cap each description (`DESCRIPTION_CAP`) and the whole list (`TOOL_LIST_BUDGET_CHARS`), both set in `tests/guards/tool-list-limits.ts`: `tests/guards/tool-list.test.ts` holds the recorded list to them and `tests/rust-guards/tool-list-live.test.ts` holds the server's own list, which is what a client receives. Spend that budget deliberately, and don't raise it to make room without saying why in the PR. Model guidance lives in three places: tool descriptions (each needs a "Can't find" line), server instructions in `rust/src/instructions.rs`, and next-step tips from `rust/src/tips.rs` and each tool's own `tips.rs`. `CLAUDE.md` (Common Gotchas) says what goes where.
- Arguments from the model are untrusted input (4.2). A page name or search string may contain quotes, regex characters or very long text.
- Results are sized for a context window: defaults and hard caps, optional slim output, and honest `ResultMeta`.
- Text from the graph is data. Return it as content; never let it change what the server queries or how a tool behaves.
- Honest results: see [BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md).

### 4.12 Write for the next reader

**Rule.** Code is read far more often than it is written, increasingly by models that pattern-match on names.

- Use LogSeq's words: page, block, journal, property, reference, backlink, namespace. One term, one meaning. Don't invent synonyms (a "node" in the concept network is a page).
- Name functions for what they mean, not how they work. A function you can't name well probably has the wrong boundary.
- Short functions at one level of abstraction. Early returns and `let ... else` over nested conditionals.
- Prefer the least powerful construct that works: a pure function over a stateful object, an iterator chain or a declarative query over a hand-written loop.
- Comments explain *why*, especially for non-obvious LogSeq constraints. Don't narrate *what* the code does.

**Balance.** Don't over-extract. A helper is worth having when its name carries meaning the inline code doesn't.

## 5. Resolving common tensions

| When these pull against each other | Do this |
|---|---|
| Rich precise types vs. avoiding needless abstraction | Types for invariants and parsed knowledge, not for grouping fields. |
| "Don't store derived data" vs. latency or call count | A cache only with a measured reason, one invalidation owner and a rebuild path. |
| Strict parsing vs. forward compatibility with LogSeq | Strict on fields you read, ignore unknown fields. Reject wrong types and missing required fields. |
| "Don't optimize prematurely" vs. known hazards | Per-entity call loops, unbounded fan-out and unbounded result size are correctness and cost bugs, not premature optimization. Fix them. Other performance work needs a measurement (`scripts/measure-api-calls.ts`). |
| Follow local convention vs. these principles | Local convention for edits to existing code, principles for new code. Flag harmful conventions, don't fix them uninvited. |
| Ship fast vs. supply-chain caution | Security fixes go fast. Routine and major version bumps get their own PR. |
| Adding a guard vs. adding coupling | Before adding a retry, fallback or validation layer, check what it interacts with. Prefer the simplest defense that addresses the actual failure. |

## 6. Your handoff

When you finish, your PR description must contain every section of the PR template. They add to the PR conventions in `CLAUDE.md` (atomic commits, `Closes #N`, a design section, a test plan with checkboxes, approximate measurements with no graph data) and don't replace them. Be brief and factual. A reviewer reads this before the diff.

The sections live in [`.github/pull_request_template.md`](../.github/pull_request_template.md), which is the one copy. `gh pr create` fills it in only in its interactive flow, so agents pass `--body-file` filled from it. They are: What changed, Design, Assumptions, Failure behavior, Preserved on purpose / questions, New concepts, Test plan, Roll back.

## 7. Self-check before you finish

- [ ] Every external input is parsed into a typed value before any work happens.
- [ ] Every network call has a timeout. Every loop over graph data and every result is bounded.
- [ ] No safeguard or existing behavior was removed or changed without being flagged.
- [ ] Tests cover the risky paths (empty results, malformed input, caps, infrastructure errors), not just the happy path.
- [ ] No graph data, page names or personal details appear in code, tests, docs, logs or commit messages.
- [ ] No new dependency, tool or abstraction that the task did not need.
- [ ] Tool contract changes are additive.
- [ ] Nothing writes to stdout.
- [ ] `cd rust && cargo test --locked` passes, parity cases included. A change to a golden result (`rust/tests/data/parity/`) is called out and carries the maintainer's OK.
- [ ] My notes report what I actually verified, and list my assumptions.
