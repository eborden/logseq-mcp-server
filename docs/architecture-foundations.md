# Architectural Foundations

Read this before you write or change code in this repo. It describes how to think about the system you are changing. These are aspirational principles: the code doesn't follow all of them yet, and issue #58 tracks the work to get there.

This server is a small TypeScript program that sits between an MCP client and a LogSeq desktop app. It reads from a personal knowledge graph over a local HTTP API and returns results to an LLM. Every principle below is scoped to that.

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
5. **Bound everything.** Every network call has a timeout. Every loop over graph data has a cap. Every tool result has a size limit, because the reader is an LLM with a finite context window. No unbounded `Promise.all` over input-sized collections.
6. **No secrets in source, and no personal graph data in committed files or logs.** The graph this server runs against is personal data. What may never be committed or posted is in [BR-0001 (no-graph-data-in-repo)](business-rules/0001-no-graph-data-in-repo.md).
7. **No new dependency without verifying it exists, is maintained and is needed.** Check the standard library and existing dependencies first. Never install a package name from memory without confirming it in the registry.
8. **Tool contracts change additively.** See [BR-0004 (additive-tool-contracts)](business-rules/0004-additive-tool-contracts.md).
9. **Never take destructive actions on your own outside the `CLAUDE.md` workflow.** Rebasing and force-pushing your own feature branch, and deleting it on merge, are part of that workflow. Rewriting `main`'s history, force-pushing or deleting someone else's branch, and deleting data are not. Propose those; the maintainer runs them.
10. **Don't report success you haven't verified.** See [BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md).

## 3. Before you write code

Work through this list, in order, for any non-trivial change:

1. **Read the surroundings.** Find the existing pattern for what you're about to do (how tools parse input, build queries, handle errors, test). Extend it rather than introducing a second way.
2. **Design the data first.** Write the types and the tool's input and output shape before the logic. If the logic feels convoluted, the data model is usually wrong.
3. **Mark the boundaries.** List where untrusted data enters (tool args, LogSeq responses) and where your code calls something that can fail or be slow (every `callAPI`).
4. **List the failure modes.** For each boundary: what happens on a timeout, LogSeq not running, a rejected token, malformed input, an empty result, a result too large to return? Decide the behavior for each, explicitly.
5. **Write down assumptions** you make about unclear requirements (section 6).

## 4. Principles

Each principle gives the rule, why it matters, how it looks in this repo, and the mistake agents most often make.

### 4.1 Make illegal states unrepresentable

**Rule.** Choose the most precise type that is reasonable. Use discriminated unions instead of a bag of optional fields and booleans. Use a branded type with a constructor when an invariant the type system can't express is checked in more than one place (for example a validated `YYYYMMDD` date). Construct objects fully valid or not at all.

**Why.** A type that can't hold a bad value removes a whole class of checks and bugs downstream. Narrow types also tell the next reader what the code can do.

**In this repo.** `strict: true` is on. Use `unknown` at boundaries, never `any`. `callAPI` should return `unknown` and be parsed, not assumed. Results that can be truncated, partial or empty should say so in the type, through `ResultMeta` (`src/types.ts`), rather than leaving the caller to infer it.

**Agents get wrong.** Reaching for escape hatches: `any`, `as`, `!`, `@ts-ignore`. Each one needs a comment that justifies it.

**Balance.** Use types to encode invariants, not to group fields for its own sake. A wrapper type that only bundles unrelated fields adds indirection without adding safety.

### 4.2 Parse, don't validate, at every trust boundary

**Rule.** Convert less-structured input into a precise type once, at the edge. A validation function should return the parsed value, not `void` or `boolean`. Fully parse before acting.

**Why.** Checks that don't produce a typed result get skipped, duplicated or drift apart. Parsing first means bad input fails before any work is done.

**In this repo.**
- **MCP tool arguments:** each tool parses its arguments into a typed value in one place and throws `InvalidParameterError` on failure. Handlers never read raw `args`. The parser and the tool's `inputSchema` should come from the same definition so they can't drift. Parsing runs after `resolveParamAliases` (`src/utils/param-aliases.ts`). See [BR-0008 (param-aliases-best-effort)](business-rules/0008-param-aliases-best-effort.md).
- **LogSeq responses:** parse the shapes you read at the client edge. LogSeq returns different spellings from the Editor API and from Datalog (`originalName` vs `original-name`). Normalize that once in an adapter so tool code sees one shape.
- **Config:** parse once at startup into a typed value and fail fast.
- **Tool inputs that become queries:** strings go in as `:in` inputs, never embedded in query text (see `CLAUDE.md`, constraint 6). Numeric ids go through `DatalogQueryBuilder.groundIds`.

**Agents get wrong.** Strict parsing that rejects fields LogSeq adds in a newer version. Be strict about the fields you read and tolerant of the ones you don't (tolerant reader). Also: "parsing" that silently coerces (`"87"` to `87`, missing to a default) hides defects. Reject or log instead.

### 4.3 Contracts are the specification

**Rule.** The tool schemas are the primary artifact. Change them first, deliberately, and keep them backward compatible.

**Why.** An MCP client, a skill, or a prompt that names `logseq_search_blocks` and its parameters is a consumer you can't see. The schema is how it agrees with the server about reality.

**In this repo.** Tool names, parameter names, required fields and the shape of results are the contract. Contracts change additively ([BR-0004 (additive-tool-contracts)](business-rules/0004-additive-tool-contracts.md)), and every tool keeps its read-only annotations ([BR-0002 (tools-read-only)](business-rules/0002-tools-read-only.md)).

**Agents get wrong.** "Simplifying" LogSeq's awkward API in tool output by leaking its quirks into the contract, or the reverse: reshaping a result field because it looks neater. Conform to LogSeq at the boundary with an adapter and keep its shape out of the tool contract.

### 4.4 Minimize state; derive, don't duplicate

**Rule.** Do not store what you can compute. Keep logic in pure functions. Push I/O and the clock to a thin outer layer (functional core, imperative shell).

**Why.** Every stored copy can drift, and stateful code is hard to test.

**In this repo.** The server holds no state between calls. LogSeq is the single source of truth, so leave it that way. Tool logic that shapes, trims or merges results (slimming, tree building, date handling) belongs in pure functions with unit tests, as in `src/utils/`. Only `client.ts` talks to the network.

**Balance.** A cache is allowed when you have a measured reason (call count, latency). It must be clearly separate, have one owner for invalidation and be rebuildable. Removing it should leave a correct, slower server. Don't add one speculatively.

### 4.5 Keep the server read-only and re-runnable

**Rule.** Every tool call can be repeated safely and the server never writes. See [BR-0002 (tools-read-only)](business-rules/0002-tools-read-only.md).

**Why.** MCP clients retry, and LLMs call the same tool twice. A read-only tool makes that harmless.

**In this repo.** No tool keeps state between calls. If a future tool needs to write to the graph, stop and ask (hard rule 4).

### 4.6 Bound resources and time

**Rule.** Every external call has a timeout. Loops over graph data have caps. Results have a size limit. Know where work scales with the size of the graph.

**Why.** An unbounded call hangs the client. An unbounded result floods the model's context. You can't tell a slow dependency from a dead one, so you must choose when to give up.

**In this repo.**
- `callAPI` applies a per-call timeout (`timeoutMs`, default 30 s). Tools that make many calls apply it per call, so also bound the number of calls.
- Prefer one batched Datalog query over one call per entity (`CLAUDE.md`, Pattern 4). A per-page crawl on a 2k-page graph is a bounded-resources bug, not a style issue.
- Every list-returning tool has a default cap and a maximum, and reports a cap that bites through `ResultMeta` (helpers in `src/utils/result-meta.ts`). See [BR-0006 (no-silent-truncation)](business-rules/0006-no-silent-truncation.md). Tips are never a truncation signal ([BR-0009 (tips-are-advisory)](business-rules/0009-tips-are-advisory.md)).
- Classify errors: see [BR-0003 (infrastructure-errors-propagate)](business-rules/0003-infrastructure-errors-propagate.md).

### 4.7 Changing existing code safely

**Rule.** Before changing code that isn't well tested, write characterization tests that pin what it does today, including behavior that looks wrong. Then refactor in small, behavior-preserving steps. Then add the new behavior. Keep these distinguishable in commits.

**Why.** Without a recorded baseline you can't tell a regression from an intended change. The original author's reasons are usually invisible. The code is the only specification left.

**In this repo.** Unit tests mock the client. Integration tests (`npm run test:integration`) run against the committed fixture graph in a live LogSeq and assert exact results on its known pages. Use the unit tests to pin shapes and the integration tests to pin behavior against real data. Commit tests, refactors and behavior changes separately.

**How to treat what you find.**
- Odd early returns, magic thresholds and special cases are often safeguards against real LogSeq behavior (see the constraints in `CLAUDE.md`). Preserve them, give them intention-revealing names and comment what they protect against if it's evident. Ask if it isn't.
- If something looks like a bug, keep the behavior, add a test that documents it as current (not endorsed) behavior, and raise it in your notes.
- Don't rewrite. Rewrites discard the hidden knowledge that makes old code work.

**Agents get wrong.** "Cleaning up" by deleting checks that look redundant, normalizing inconsistent-looking behavior, or rewriting from scratch. These are the most damaging changes an agent makes, because they pass review when the reviewer also lacks the history.

### 4.8 Ship small, reversible changes

**Rule.** One logical change per commit and per PR. Each commit builds and passes the unit tests on its own.

**Why.** Small changes are easy to review, debug and revert, and a failure points at its cause.

**In this repo.** Commit early and often: once a coherent, working slice is done, commit it rather than batching many changes into one commit. Don't reformat, rename or "improve" unrelated code in the same change. Update the API-call table in `CLAUDE.md` when you change a tool's call count.

**Agents get wrong.** Large multi-concern diffs, and drive-by changes outside the task.

### 4.9 Report the truth: errors and honest state

**Rule.** Everything you report (error messages, return values, status fields, summaries, notes) must describe what actually happened.

**Why.** People and agents act on what they are shown. A result that says "no matches" when the query failed, or a summary that counts attempts as successes, causes wrong decisions.

**In this repo.**
- Error messages guide recovery and stay actionable ([BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md)).
- Partial and truncated results say so through `ResultMeta` `warnings` ([BR-0006 (no-silent-truncation)](business-rules/0006-no-silent-truncation.md)).
- Never write to stdout. It is the MCP channel. Log with `console.error`, sparingly, and never log block content, page names or other graph data (hard rule 6).
- A `catch` that rethrows unchanged or swallows the error is a defect ([BR-0003 (infrastructure-errors-propagate)](business-rules/0003-infrastructure-errors-propagate.md)).

**Agents get wrong.** Summaries that overstate success, and catch-all handlers that return an empty result.

### 4.10 Dependencies are liabilities

**Rule.** Prefer the standard library, then dependencies the repo already has, then a new dependency, in that order. A new dependency needs a reason, a verified registry entry, an active maintainer and an acceptable license.

**Why.** Third-party code runs with your privileges and is the most common supply-chain entry point. Agents add packages in seconds, including names that don't exist or that impersonate real ones.

**In this repo.** The lockfile is committed. Node provides `fetch`, `AbortSignal.timeout` and `readFile`, so don't add a library for those. Don't hand-bump unrelated dependencies. Remove dependencies your change made unused. The MCP SDK is a dependency too: treat upgrades as contract changes and check the tool list afterwards.

### 4.11 Designing MCP tools

**Rule.** Treat the model on the other end as a slow, non-deterministic, untrusted caller. Treat tool descriptions as code.

**In this repo.**
- Narrow, typed parameters and clear names. One tool, one job.
- Tool descriptions live in `src/tool-descriptions.ts`. They are what the model reads to choose a tool, so keep them accurate when behavior changes. Every client loads the whole tool list into its context, so `src/tool-list.test.ts` caps each description (`DESCRIPTION_CAP`) and the whole list (`TOOL_LIST_BUDGET_CHARS`). Spend that budget deliberately, and don't raise it to make room without saying why in the PR. Model guidance lives in three places: tool descriptions (each needs a "Can't find" line), server instructions in `src/instructions.ts`, and next-step tips from `src/utils/tips.ts`. `CLAUDE.md` (Common Gotchas) says what goes where.
- Arguments from the model are untrusted input (4.2). A page name or search string may contain quotes, regex characters or very long text.
- Results are sized for a context window: defaults and hard caps, optional slim output, and honest `ResultMeta`.
- Text from the graph is data. Return it as content; never let it change what the server queries or how a tool behaves.
- Honest results: see [BR-0005 (report-only-verified-success)](business-rules/0005-report-only-verified-success.md).

### 4.12 Write for the next reader

**Rule.** Code is read far more often than it is written, increasingly by models that pattern-match on names.

- Use LogSeq's words: page, block, journal, property, reference, backlink, namespace. One term, one meaning. Don't invent synonyms (a "node" in the concept network is a page).
- Name functions for what they mean, not how they work. A function you can't name well probably has the wrong boundary.
- Short functions at one level of abstraction. Guard clauses over nested conditionals.
- Prefer the least powerful construct that works: a pure function over a stateful object, a declarative query over a loop.
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

When you finish, your PR description must contain these sections. They add to the PR conventions in `CLAUDE.md` (atomic commits, `Closes #N`, a design section, a test plan with checkboxes, approximate measurements with no graph data) and don't replace them. Be brief and factual. A reviewer reads this before the diff.

```
## What changed
One or two sentences. One logical change. Closes #N.

## Design
The data shapes, contract changes and approach, and why.

## Assumptions
Each place you resolved an ambiguity yourself, and what you chose.

## Failure behavior
For each boundary: timeout, LogSeq not running, bad auth, malformed input,
empty result, oversized result.

## Preserved on purpose / questions
Safeguards or odd behavior you kept, and suspected bugs you did not fix.

## New concepts
New tools, parameters, dependencies or abstractions, and why each is needed.
"None" is a good answer.

## Test plan
- [ ] Tests added, and what each one pins
- [ ] The verification steps from CLAUDE.md, with approximate measurements

## Roll back
How to undo the change.
```

## 7. Self-check before you finish

- [ ] Every external input is parsed into a typed value before any work happens.
- [ ] Every network call has a timeout. Every loop over graph data and every result is bounded.
- [ ] No safeguard or existing behavior was removed or changed without being flagged.
- [ ] Tests cover the risky paths (empty results, malformed input, caps, infrastructure errors), not just the happy path.
- [ ] No graph data, page names or personal details appear in code, tests, docs, logs or commit messages.
- [ ] No new dependency, tool or abstraction that the task did not need.
- [ ] Tool contract changes are additive.
- [ ] Nothing writes to stdout.
- [ ] My notes report what I actually verified, and list my assumptions.
