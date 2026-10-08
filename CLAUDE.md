# LogSeq MCP Server - Technical Context

## Privacy: Never Commit Details From the Personal Graph

The LogSeq instance this server is developed against is the maintainer's **personal** graph, on port 12315. **`scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts` read real data from it, by design**: with no `LOGSEQ_MCP_CONFIG` they load `~/.logseq-mcp/config.json`, because the measurements in this file are a real-graph baseline. So does anything else pointed at port 12315. The integration tests and `scripts/probe-constraints.ts` never contact it: they use `LOGSEQ_MCP_CONFIG` or this worktree's fixture instance, never fall back to `~/.logseq-mcp/config.json`, and the tests refuse port 12315 before any network call (#90). None of the personal graph's data may leave the machine through this repo or its GitHub project.

**Never put any of the following in committed files** (code, tests, fixtures, docs, skills, CLAUDE.md), **commit messages, GitHub issues, PR descriptions or comments:**
- Page names, journal titles, tags or property values from the graph
- Block content, quotes or paraphrases of what the graph says
- People's names (journals mention real colleagues, friends and family)
- Dates of specific journal entries, or anything that reveals what happened on a given day
- Raw output from any run against the real graph. That is `scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts` (they read it by default), and `scripts/probe-constraints.ts` or an integration-test run that `LOGSEQ_MCP_CONFIG` points at a personal instance on a port other than 12315 (both default to the fixture instance and refuse 12315). Their output includes real page names.

**Do instead:**
- Use made-up examples: `"Alice"`, `"Bob"`, `"my page"`, `"project atlas"`, `"20250101"`.
- Report measurements as approximate aggregates without names: "~2k-page graph", "a hub page with ~100 neighbours", "~120 API calls".
- When a test needs data shaped like the real graph, write a synthetic fixture. Don't copy an entity.
- Before committing or posting anything, grep the diff and text for names you saw in tool output during the session.

**Already in git history:** older commits contain a few real page names that have since been replaced with fictional ones. Removing them would require rewriting history, which is the maintainer's call, not something to do on your own.

Full rule, with rationale and enforcement: [BR-0001 (no-graph-data-in-repo)](docs/business-rules/0001-no-graph-data-in-repo.md).

---

## Architectural Foundations

Read `docs/architecture-foundations.md` before writing or changing code. It sets the principles (parse input at the boundary, bound calls and result sizes, preserve behavior when refactoring, additive tool contracts) and the handoff sections for PR descriptions. The code doesn't meet all of them yet: #58 tracks the gaps and the order of work.

---

## ADRs and business rules

Two kinds of record live in `docs/`. Their READMEs hold the full process. Read the one you're changing before you change it.

- **ADR** ([`docs/adr/`](docs/adr/README.md)): an architectural decision and the context that forced it, such as how queries bind their inputs. It's immutable once accepted.
- **Business rule** ([`docs/business-rules/`](docs/business-rules/README.md)): a promise the tools make to their user, such as staying read-only. It's edited in place, and each edit adds a Changelog row.
- **Process rules** (how to work: vetting dependencies, behaviour-preserving refactors, never publishing from a session) have no file of their own. They stay in this file and [`docs/architecture-foundations.md`](docs/architecture-foundations.md).

**IDs.** Files are named `NNNN-<slug>.md`, numbered per directory. The number is the ID, never changed or reused, and files are never deleted. Cite them as `ADR-0007` or `BR-0003`, optionally followed by the slug: `ADR-0007 (two-query-pattern-for-optional-data)`. A new entry takes the highest number + 1. If another PR merges that number first, renumber on rebase before merge.

**Changing one.**
- An accepted ADR is immutable, with three exceptions. Don't reword its Context, Decision or Consequences.
  - Its status and a pointer to its replacement. A reversal is a new ADR, and the same PR marks the old one `superseded by <NNNN-slug>`.
  - A citation of a file that has since been deleted may be rewritten in place as a pinned `<commit>:<path>` reference to its last version, with no other rewording.
  - Its Mechanical enforcement section may be updated in place, for example `none-yet` becoming `test:` once a guard lands.
- A business rule is edited in place, with a new Changelog row. To retire one, follow the README; don't delete the file.

Adding an ADR or rule, or any of these changes, needs the maintainer's OK before merge (see Merge policy), with one exception. A PR that adds or strengthens Mechanical enforcement lines on ADRs and business rules, and changes no other ADR or business-rule content, needs no OK: `none-yet` to `test:` or `ci:`, a new `type:`, `test:` or `ci:` line, or a stronger tier (order: `type`, `test`, `ci`, `reviewer`, `none-yet`). Dropping a `none-yet` line only because a guard for that same issue replaced it counts as strengthening. Removing or weakening enforcement still needs the OK: any other dropped line, a weaker tier, or back to `none-yet`. So does every other ADR or business-rule change. An additive enforcement edit to a business rule still adds its Changelog row, which is part of the edit, and that row cites the PR itself.

**Format.** `tests/guards/docs-format.test.ts` checks both directories in CI: filenames, the Index table, required headings, ADR status lines, business-rule Changelog tables, `<tier>: <reference>` enforcement lines and relative links. Run `npx tsx scripts/docs-format.ts` to check locally.

---

## Development Workflow

Work is tracked in GitHub issues and the [LogSeq MCP Workflow](https://github.com/users/eborden/projects/1) project board.

### Issue and PR templates
Templates live in `.github/` and are the source of truth for what an issue or PR body contains. Blank issues are off. `gh` applies a template only in its interactive flow (picked by the front-matter name), so agents fill the body to match and pass it with `--body-file`.

| Kind | Template | Label | Use for |
|---|---|---|---|
| Task | [`task.md`](.github/ISSUE_TEMPLATE/task.md) | `task` | A bounded change a subagent implements. The issue is its whole brief: context, scope, out of scope, files, constraints, acceptance, verification, open questions, Definition of Ready |
| Bug | [`bug.md`](.github/ISSUE_TEMPLATE/bug.md) | `bug` | Misbehaviour, reproduced on the fixture graph, never the personal one |
| Plan | [`plan.md`](.github/ISSUE_TEMPLATE/plan.md) | `plan` | A parent: goal, decisions, non-goals, current state, exit criteria |
| Proposal | [`proposal.md`](.github/ISSUE_TEMPLATE/proposal.md) | `proposal` | A new or changed ADR or business rule. Merging its PR needs the maintainer's OK |
| Pull request | [`pull_request_template.md`](.github/pull_request_template.md) | | The handoff from [`docs/architecture-foundations.md`](docs/architecture-foundations.md) section 6, plus the author-attested verification and the conditional rows |

- Sub-issues and "blocked by" edges are set in GitHub (next section), never listed in the issue body.
- A subagent that finds a Ready issue ambiguous, or its premise wrong, comments on the issue instead of starting (the "Open questions" section; foundations section 0).
- Subagents pass `--body-file` filled from the template, since `gh` skips templates when given `--body`. A guard test (`tests/guards/github-templates.test.ts`) keeps the templates and these links in step.

### Plans live in issues
- Write a plan as GitHub issues, not as a file in `docs/plans/` and not only in the conversation. (Plans aren't kept in `docs/`. Git history holds the old ones.)
- Split anything multi-part into sub-issues linked to a parent. Record sequencing (waves, dependencies) in the parent or a comment on it. Close the parent when its sub-issues are done.
- Sequence in waves so at most one open PR touches a given file area. Guardrails and conventions first, features next, output-wide changes last.
- Add new issues to the board: *Backlog*, or *Ready* once the maintainer has approved the plan. When a plan changes, edit the issues (scope comments, new sub-issues, close obsolete ones).
- **Hard ordering uses GitHub issue dependencies.** If B can't start until A merges (file overlap, needs A's code, or a migration order), mark B **blocked by** A and record why in a comment. The edges are the source of truth. A wave list in a comment can summarise the plan, but when a plan changes, update the edges too. Waves are a summary of the edges, not a substitute.
  ```bash
  gh api repos/eborden/logseq-mcp-server/issues/<A> --jq .id    # A's REST id (not its number)
  gh api -X POST repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by -F issue_id=<A's REST id>
  gh api repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by --jq 'map(select(.state=="open") | .number)'    # list B's open blockers
  ```
- **Grouping uses sub-issues.** A multi-part plan is a parent with sub-issues, as above.

### Board statuses
Flow: **Backlog → Ready → In progress → In review → Done**. Move an item to *In progress* when work starts, to *In review* when its PR opens (add the PR to the board too), and to *Done* on merge.

The board has two fields: **Status** (the flow above) and **Size**.

```bash
gh project item-add 1 --owner eborden --url <issue-or-pr-url>
gh project item-edit 1 --owner eborden --url <issue-or-pr-url> --field Status --value "In review"
gh project item-list 1 --owner eborden --format json    # items[].status
```

These need the `project` scope: `gh auth refresh -s project`.

### Ready items go to subagents
- **Anything in *Ready* is implemented by a subagent**, not inline in the main session. The main session picks Ready items, sequences them, briefs one subagent per issue, spawns a separate reviewer subagent for each PR it opens (see Code review) and updates the board.
- Pick unblocked items from *Ready* (no open blocked-by issue, see "Plans live in issues"). Run in parallel only items with no blocked-by edge between them and no file overlap.
- Each subagent works in its own git worktree branched from `origin/main`.
- Run subagents in parallel only when their files don't overlap. Give each its own tool directory (`rust/src/tools/<tool>/`, with its queries in its own `queries.rs`) and its own new test file.
- Subagents open PRs and don't merge. They stage files by explicit path and never commit `node_modules`, `dist`, local settings or draft docs.

### PR conventions
- Fill in `.github/pull_request_template.md`: atomic commits, `Closes #N`, a design section, a test plan with checkboxes, and approximate measurements (no graph data, see Privacy). CI, a clean merge against `main`, the review gate and the maintainer's OK stay with whoever merges (below).
- A PR that edits a business rule adds a row to that rule's Changelog table citing the PR. The format check can't tell whether a row is new, so the reviewer checks it. A new rule also adds its Index row and an `Introduced.` Changelog row. A retired rule's Index summary starts with `Retired.`, and its Changelog row reads `Retired.`.
- A PR that adds an ADR opens it as `proposed` and edits the status to `accepted` in the same PR before merge.
- Rebase-merge so the atomic commits stay on `main`. Delete the branch on merge.

### Code review (required for every PR)
1. After a PR opens, a **separate reviewer subagent** reviews it. It starts fresh, with only the PR number, the linked issue and this file.
2. It posts **one review with inline comments** on specific lines. Each comment says what's wrong, why, and what to do. Focus on correctness, the constraints in this file, privacy, test gaps and contract changes. No nits about style the codebase doesn't enforce.
   - Does the PR add, change, supersede or retire an ADR or business rule, including an edit to its Mechanical enforcement lines? If so, say in the review body that it needs the maintainer's OK before merge, even with self-merge (see Merge policy). The exception is a PR that adds or strengthens Mechanical enforcement lines on ADRs and business rules, and changes no other ADR or business-rule content: it needs no OK. State in the review body whether the ADR or business-rule edit is additive-only, including the rule's Changelog row, after checking that tiers only go stronger, no line is removed except a `none-yet` line replaced by a guard for that same issue, every cited path exists, and no reference is swapped for a different one.
   - Does the PR contradict an accepted ADR or business rule without citing the change that allows it (a superseding ADR or an edited rule)? If so, comment on the contradicting line.
   ```bash
   gh api repos/eborden/logseq-mcp-server/pulls/<n>/reviews --input review.json
   # review.json: {"event": "COMMENT", "body": "...",
   #   "comments": [{"path": "rust/src/x.rs", "line": 12, "side": "RIGHT", "body": "..."}]}
   ```
   Use `event: COMMENT`, never `REQUEST_CHANGES` or `APPROVE`. Every PR is opened by the same GitHub account as the reviewer, and GitHub rejects those two events on your own PR.
3. A fixer subagent (the author or a fresh one) handles each thread. It either fixes it and replies with the commit SHA, or replies with a concrete reason for not changing it.
   ```bash
   # <comment-id> is comments.nodes[0].databaseId from the step 5 query
   gh api repos/eborden/logseq-mcp-server/pulls/<n>/comments/<comment-id>/replies -f body="Fixed in <sha>"
   ```
4. The reviewer re-checks each reply and **resolves** the threads it accepts. Threads it doesn't accept stay open. When done, it posts a short closing review (`event: COMMENT`, no inline comments, non-empty `body` such as "Re-checked all replies, threads resolved") so the gate can see a review on the final commit. A disagreement that survives one round goes to the maintainer, who resolves the thread or tells the fixer what to change. It stays open until then.
   ```bash
   # <thread-id> is nodes[].id from the step 5 query
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread-id>"}) { thread { isResolved } } }'
   ```
5. **Merge gate: no PR merges while any review thread is unresolved, and none merges without a posted reviewer-subagent review on its head commit.** Dismissing a comment means replying with the reason and resolving the thread. Nothing is dropped silently. This one read-only query lists the threads (with the ids steps 3 and 4 need) and the gate result:
   ```bash
   gh api graphql -f query='query { repository(owner: "eborden", name: "logseq-mcp-server") { pullRequest(number: <n>) { headRefOid reviews(first: 100) { nodes { state body submittedAt commit { oid } } } reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId path body } } } } } } }'
   # gate summary: add this flag to the same command
   #   --jq '.data.repository.pullRequest as $pr | {reviewsOnHead: ([$pr.reviews.nodes[] | select(.commit.oid == $pr.headRefOid and (.body | length > 0))] | length), unresolvedThreads: ([$pr.reviewThreads.nodes[] | select(.isResolved | not)] | length)}'
   ```
   The PR is clear only when `reviewsOnHead` (reviews with a non-empty body on the head commit) is at least 1 **and** `unresolvedThreads` is 0. Thread replies create empty reviews and don't count. Zero threads with `reviewsOnHead: 0` is not clear, because an unreviewed PR also has no threads. A push after the last review (fixes, a rebase) moves the head, so the reviewer posts a new closing review (step 4).

### GitHub rate limits
`gh` hides the headers by default, so a failure doesn't say which limit it hit. Diagnose first, then pick a response. There is no wrapper script: the agent decides.

**Diagnose.** Re-run the failing call with `gh api -i ...` to see the status line and headers. `gh api rate_limit` shows the primary buckets (`core`, `graphql`, `search`) and doesn't count against them.
- **Primary:** `X-Ratelimit-Remaining: 0` and a future `X-Ratelimit-Reset` (epoch seconds), or `rate_limit` shows that bucket at 0. Each bucket is separate, so `core` can be empty while `graphql` is not.
- **Secondary:** HTTP 403 or 429, a `Retry-After` header, and a body that says "secondary rate limit". `rate_limit` still shows plenty left, since it doesn't report secondary limits.

**Respond.**
- Primary: wait until the reset time. Don't retry before it.
- Secondary: wait `Retry-After` seconds. With no header, wait at least 60s, and double the wait on each repeat. Never retry in a tight loop, because that extends the block.
- Wait with `sleep` in a background command or a Monitor `until` loop rather than a foreground sleep, and tell the maintainer how long you're waiting and why.
- If the wait is long (a primary reset more than ~10 minutes away, or repeated secondary hits), stop and say so. Don't burn the session polling.

**Avoid secondary limits.** They count bursts of writes (roughly 80 content-creating requests a minute, 500 an hour, 100 concurrent), and they're per account, so parallel subagents share one budget.
- Post a review's inline comments in one `reviews` call (see "Code review"), not one call per comment.
- Don't run several subagents' write phases at once (comments, replies, thread resolutions, issue edits). Reads are cheap. Stagger the writes.
- A fixer with many threads replies and resolves them in sequence, not in parallel.

### Verification before merge
Done by whoever merges:
- CI (`.github/workflows/ci.yml`) must be green. The Rust server is the only server (#356), so its job is the main check: `cargo build` and `cargo test --locked`, the parity harness against the recorded results (and its `--self-check`), and the guard tests that start the binary. The tooling job runs `npm run typecheck` and `npx vitest run tests/guards` on Node 22 and 24 (`engines.node` is `>=22.12.0`, the floor of the dev toolchain, vite 7). The integration tests and the measure scripts stay local.
- Mutation testing on the Rust crate (ADR-0033, #364) is not a CI job yet; the TypeScript Stryker job and its ratchet (ADR-0026 to ADR-0030) were removed with the TypeScript server (#356).
- **The golden files** (`scripts/parity/expected/**`) are the tool contract: the parity step holds the Rust server to them. The `golden-files` job of `ci.yml` fails a PR that changes any of them unless it carries the `golden-change` label, and it names the files. **The label goes on only after the maintainer's explicit OK, recorded on the PR**, and the maintainer adds it. Nobody applies it on their own: not a PR's author, not a reviewer, and not under the feature-branch self-merge grant. A re-record with `--record-from-rust` (#299) writes a file only when its meaning changed, so a re-record that touches a golden file is a contract change, and a cosmetic one can't trip the check.
- Privacy grep of the diff, commit messages, PR body and review comments/replies. Don't paste integration-test or measure-script output anywhere on GitHub. Report pass/fail and approximate counts only.
- `cd rust && cargo test --locked`
- `npx vite-node scripts/parity.ts` (and `--self-check`) against the debug build, `cd rust && cargo build`
- `npm run typecheck` and `npx vitest run tests/guards tests/rust-guards`
- `npm run test:integration` against this worktree's fixture instance (`npx tsx scripts/logseq-instance.ts start`, the run, then `stop`; read-only). The instance opens a copy (#151), so afterwards the repo's status must still show no change under `tests/fixtures/graph/`
- `npx tsx scripts/measure-api-calls.ts` still runs (it needs the Rust binary: `cd rust && cargo build --release --locked`, or `--rust-binary` for another)
- A clean merge against the PR's current base branch (`feature/rust-spike` while the Rust-only work lives there, `main` after it merges). If the base has moved, test the PR merged onto it.

### Merge policy
- **Three actions need the maintainer's explicit OK:** merging a PR, moving a board item from *Backlog* to *Ready*, and merging any PR that adds, changes, supersedes or retires an ADR or business rule, even with self-merge. The exception is a PR that adds or strengthens Mechanical enforcement lines on ADRs and business rules, and changes no other ADR or business-rule content (see "ADRs and business rules"). Everything else (issues, PRs, reviews, resolving threads, pushing to feature branches, other status moves) is allowed by default.
- **The maintainer merges by default.** Claude may merge its own PRs only if the maintainer has explicitly granted self-merge to the session. Without that grant, open the PR and stop.
- **The ADR and business-rule gate applies even with self-merge, except as above.** Before merge, a PR comment records the approval: the maintainer writes it, or Claude posts it quoting the maintainer's message verbatim with its date. If the maintainer merges the PR, the merge is the record (see the Approval gate in [`docs/adr/README.md`](docs/adr/README.md#change-process)). What an approval survives is set here only, not in the READMEs:
  - A rebase or conflict resolution that changes nothing of substance keeps the approval.
  - A renumber on rebase (the stem, Index row and citations only, required when another PR merged the number first) is mechanical and keeps the approval. Whoever merges reports the new number to the maintainer.
  - Any push after the approval that changes the wording of an ADR or rule, or the behaviour of the PR, needs a fresh OK.
- Even with self-merge, the verification and the merge gate above still apply. Raise decisions that belong to the maintainer (behaviour changes, publishing, accounts) instead of merging past them.

---

## Overview

This is an MCP (Model Context Protocol) server that provides Claude with 16 tools for querying LogSeq knowledge graphs. It is written in Rust (the crate in `rust/`, see `rust/README.md` for the file-by-file map) and uses LogSeq's HTTP API and DataScript query engine to enable efficient graph traversal and context building.

The repo is Rust-only since #356 (the Go on #349, ADR-0025). A TypeScript server was the first implementation, and the Rust crate was held to its results byte for byte. Its last version is readable with `git show 10103c8:<path>`, and comments in the crate that name a `src/*.ts` file mean it. Its recorded results, `scripts/parity/expected/`, are the golden tests of the Rust server and the tool contract. Node is still here for the tooling around the crate: the parity harness, the guard tests, the integration suites and the scripts, all dev-only. How the Rust binary is packaged and published is still open (#350, #355): `package.json`'s `bin`, `files` and `publish.yml`, and the plugin's server entry, are left over from the TypeScript server and don't build or run it.

**Key Stats:**
- 16 MCP tools for graph operations, search, and temporal queries
- Rust unit and call-count tests (`cd rust && cargo test --locked`), the golden-result harness (`scripts/parity.ts`), the repo's guard tests (`npx vitest run tests/guards tests/rust-guards`) and integration tests against the committed fixture graph (`npm run test:integration`, which runs the Rust server). `npm test` runs the guards and the integration tests.
- Mostly Datalog: graph traversal, search and date-range queries run as batched Datalog. A few single lookups use `logseq.Editor.*` (see "Current Implementation Status" below)

**Architecture:**
```
Claude (via MCP) → HTTP API → LogSeq Desktop → DataScript Database
```

The server translates high-level queries (e.g., "get context for topic") into calls against LogSeq's HTTP API: Datalog queries via `logseq.DB.datascriptQuery` where implemented, and `logseq.Editor.*` methods elsewhere.

## Why Datalog?

Editor API calls return one entity per call, so a crawl costs O(n) calls for n entities. Batched Datalog costs O(maxDepth) calls, or a fixed few, whatever the graph size. The decision, its history and its costs (a narrower dialect, see the constraints below): [ADR-0002 (datalog-over-editor-api)](docs/adr/0002-datalog-over-editor-api.md).

### Current Implementation Status

Traversal, search and date-range tools now run as batched Datalog queries. `logseq.Editor.*` is still used for single lookups: `get_page`, `get_block`, `get_backlinks`, linked references in `build_context`, the fuzzy-match page list on "not found", and the two block fetches after `connected-within` finds a match. Every page-taking tool resolves its page name first (exact name, alias, ISO date, namespace leaf; #41), which costs one Datalog query that replaces the page query where a tool already ran one. No tool crawls the graph any more. The link-following tools (`get_backlinks`, `build_context`, `get_context_for_query`, `get_concept_evolution`, `get_concept_network`, `search_by_relationship`, and `query_by_date_range` with a `search_term`) also cover every alias of the page they were asked about (#69): a page whose pulled entity has an alias link costs one more Datalog query, a page without costs nothing.

Measured with `npx tsx scripts/measure-api-calls.ts` against the Rust server (Oct 2026, ~2k-page graph, hub page with ~100 direct neighbours). The counts were first taken on the TypeScript server, and #353 found the Rust server's equal in every case (below):

| Tool | API calls | Time | Notes |
|---|---|---|---|
| `build_context` | 3 (4 with an alias) | ~0.2s | 2 Datalog + 1 linked refs. A page with aliases adds 1 alias-group query and takes its blocks and linked references from Datalog over the group instead of the Editor call (#69) |
| `get_context_for_query` (1 topic) | 3 (4 with an alias) | ~0.1s | Delegates to `build_context` |
| `get_concept_network` depth=1 | 2 (3 with an alias) | ~0.1s | Default caps: 16 nodes. A root with aliases adds 1 alias-group query; the depth-1 walk then covers every name in one grouped query (#69) |
| `get_concept_network` depth=2 | 3 (4 with an alias) | ~0.2s | One batched query per depth, both directions. Default caps: 50 nodes. Was ~120 calls (#3). +1 when the root has an alias (#69) |
| `search_blocks` | 1 | ~0.1s | One case-insensitive regex query. Was ~130 calls, or ~2k for a search with no match (#4) |
| `query_by_date_range` (7 days) | 2 (3 with `search_term`) | ~0.2s | Journal pages + blocks, tree rebuilt in Rust. Same at 30 or 90 days. Was 1 + journal days (#5). A `search_term` adds 1 query that looks for a page of that name and its aliases, skipped when no journal is in range (#69) |
| `get_page` | 1 | ~0.01s | Exact name of a page with a file: `Editor.getPage` alone, no resolver query (2 with children). An alias, ISO date, namespace leaf, file-less stub or miss adds one resolver query: 3 for an alias or date, 4 for a miss (first lookup, resolve, leaf, `getAllPages`) (#41) |
| `get_page_outline` | 2 | ~0.05s | 1 resolver query + 1 query for the page's top-level blocks and their direct children, so child counts need no call per block. An alias or ISO date costs the same 2; a namespace leaf adds 1, a miss adds the suggestion lookup. Capped at 200 blocks (#43) |
| `get_backlinks` | 2 (3 with an alias) | ~0.2s | 1 resolver query + 1 linked-references call. Was 1 before page resolution (#41). A page with aliases adds 1 alias-group query, and the references come from one Datalog query over the group in place of the Editor call (#69) |
| `get_concept_evolution` | 4 (5 with an alias) | ~0.1s | 1 resolver query + page tree + page + 1 mentions query. Was 3 before page resolution (#41). A page with aliases adds 1 alias-group query; the mentions query then covers the whole group (#69) |
| `search_by_relationship` | 3 (4 with an alias) | ~0.05s | `references` / `in-pages-linking-to`: 2 resolver queries (run in parallel; 1 when both topics are the same name) + 1 query. Was 1 before page resolution (#41, #7). `connected-within` is O(maxDistance): 2 resolver queries, then 1 per hop, and the resolved ids seed the BFS. Either topic having aliases adds 1 alias-group query for both topics together, and the queries match by the groups' ids (#69). `connected-within` for two names of one page makes no hop query and returns a `same_topic` warning |
| `list_pages` | 1 | ~0.2s (250-page fixture) | `getAllPages` alone, whatever the filter, `limit`, `offset` or number of aliases: the `alias` ids and `file` ride on every page entity, so the alias groups are folded in Rust. Was 1 before aliases were nested (#171) |
| `query_by_property` | 1 | ~0.02s | One query over `:block/properties`, page name inline. Blocks are flat (no `children`). Was ~2k calls, ~10s (#33) |
| `resolve_refs: true` on `get_block`, `get_page` (with children), `build_context`, `query_by_date_range` | +0 to +2 | ~0.03-0.1s | Opt-in (#18). One batched query per nesting level, depth 2: +1 when the refs point at plain blocks, +2 when those hold refs of their own, +0 when nothing in the result has a ref. Same cost for 1 day or 30. Off: calls and output unchanged |
| `format: "markdown"` on `get_page`, `get_block`, `build_context`, `get_context_for_query`, `get_concept_network` | +0 | | Rendering only, no extra call, except a no-topic `get_context_for_query` in markdown: +1 batched query for the hit pages. About 45-85% fewer bytes than the JSON (a long page ~80%, `build_context` ~75-80%, a depth-2 network ~45%). `compact` on `build_context` and `get_context_for_query` also saves calls: it skips `resolve_refs`, with a warning (#43) |
| `get_current_context` | 3-4 | ~0.01s | 3 Editor calls (`getCurrentPage`, `getCurrentBlock`, `getSelectedBlocks`) + 1 Datalog pull by `:db/id` only when a block's page isn't the open page (#15) |
| `check_links` | 0-1 | ~0.01s | One batched query for every distinct `[[term]]` in `after` (name and alias routes of the resolver, `:in $ [?n ...]`), whatever the number of terms; 0 when `after` has none. The prose, bracket and refs-preserved checks run in Rust (#146) |

Re-run the script after changing any of these tools, and update this table.

**Same counts on both servers (#353, Oct 2026).** `scripts/measure-api-calls.ts` ran the same cases on the TypeScript tool functions, the TypeScript server through MCP and the Rust server through MCP stdio, one run each. On the ~2k-page graph with a hub page, 38 cases (the tool rows above except `list_pages`, the `format: "markdown"` row and `compact`, plus the alias, ISO date, `resolve_refs` and not-found variants) gave the same call total and the same split by LogSeq method on all three, in every case. A missing page answers an error through MCP, with the same 4 calls. `list_pages` and `get_graph_info` were added to the script afterwards and checked on the fixture instance only: 1 call each (`getAllPages`, `App.getCurrentGraph`), the same on all three. The call counts of the `format: "markdown"` and `compact` rows were not measured for Rust; `scripts/measure-output-size.ts` (which covers both) gave byte-identical sizes for the TypeScript and Rust servers. The TypeScript server can't be measured any more, so the table is the Rust server's to keep: re-measure after changing a tool and update it.

Times were also about equal, but the machine was under heavy load for all three runs (1-minute load average ~11-13, and it never fell below 3 in the 20 minutes waited), so treat them as order of magnitude: a single-page tool takes a few ms to ~0.1s, and a depth-2 network or `build_context` ~0.2-0.7s, on either server, inside the run-to-run noise. Re-measure on a quiet machine before quoting a time.

The measure scripts drive the Rust server (`--server rust` is the default and the only value), and the binary is the one at `--rust-binary`, default `rust/target/release/logseq-mcp-server`, over MCP stdio. Build it with `cd rust && cargo build --release --locked`. The script counts calls with a forwarding proxy between the binary and LogSeq (`scripts/measure-server.ts`); the binary gets a temporary config with the same token, deleted afterwards. The proxy and the MCP layer add a little to each time.

## Critical LogSeq Datalog Constraints

LogSeq's Datalog implementation (via `logseq.DB.datascriptQuery`) has significant limitations compared to standard DataScript. Understanding these constraints is essential for writing working queries.

Every constraint below marked **Verified** is reproduced by `npx tsx scripts/probe-constraints.ts` (read-only) against this worktree's fixture instance (`npx tsx scripts/logseq-instance.ts start` first; the probe never falls back to the personal config). Row counts in the tables below come from the real graph and differ on the fixture. Re-run it after LogSeq upgrades.

### 1. `:in` Parameters Need EDN-Encoded Inputs

`:in` works, but LogSeq reads every input passed after the query string as EDN. A bare string is read as a **symbol**, so it matches nothing.

| Call | Rows |
|---|---|
| `datascriptQuery(query-with-embedded-literal)` | 1 |
| `datascriptQuery(query-with-:in, "my page")` (bare string) | **0** |
| `datascriptQuery(query-with-:in, "\"my page\"")` (EDN-quoted) | 1 |

**Verified.** The "0 results" recorded in commit c108174 matches the bare-string case: the original example passed `'my-page'` unquoted. Why strings were once embedded and are now bound with `:in`: [ADR-0013 (strings-bound-via-in-inputs)](docs/adr/0013-strings-bound-via-in-inputs.md), which supersedes ADR-0006.

**Current practice:** string parameters go through `:in`. `LogseqClient::execute_datalog_query(query, inputs)` (`rust/src/client.rs`) sends each input as its JSON text (a JSON string literal is also a valid EDN string literal), and every query builder returns a `Query { text, inputs }` (`rust/src/edn.rs`). An input is a `DatalogInput`, a type that says what the value means, and a `PageName` is lowercase by construction:
```rust
let query = get_page_blocks(&PageName::new(page_name)); // inputs: [DatalogInput::PageName(..)], lowercased
client.execute_datalog_query(&query.text, &query.inputs).await?;
// text: [:find (pull ?block [*]) :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/page ?page]]
```

Pass typed inputs. `DatalogInput::to_edn` does the EDN encoding, so never JSON-encode a string yourself (it would be encoded twice). See constraint 6 for what is still embedded.

---

### 2. Most clojure.string Functions Work; `lower-case` Does Not

| Function | Result |
|---|---|
| `clojure.string/lower-case` | **Error:** `Unknown function 'clojure.string/lower-case` |
| `clojure.string/starts-with?` | Works |
| `clojure.string/includes?` | Works, including on `:block/content` |
| `re-pattern` + `re-find`, e.g. `"(?i)foo"` | Works (case-insensitive matching) |

**Verified.** Lowercase in Rust (`PageName::new` does it) and pass the result as an `:in` input, as in constraint 1. Use `includes?` or `re-find` to filter content inside a query instead of fetching every page's blocks.

**DON'T** call `clojure.string/lower-case` in a query. It fails with:
```
LogSeq API error: Unknown function 'clojure.string/lower-case in [(clojure.string/lower-case ?page-name) ?page-name-lower]
```

---

### 3. or-join with ground nil Fails for Optional Bindings

The pattern `(or-join [?x ?y] ... [(ground nil) ?y])` doesn't work as expected for creating optional bindings.

**DON'T (returns 0 results for pages without blocks):**
```clojure
[:find (pull ?page [*]) (pull ?block [*])
 :where
 [?page :block/name "my-page"]

 ;; Attempt to make ?block optional
 (or-join [?page ?block]
   [?block :block/page ?page]
   [(ground nil) ?block])]  ; ← Doesn't work as expected
```

**Problem:** When a page has no blocks:
1. `[?block :block/page ?page]` fails
2. Fallback `[(ground nil) ?block]` binds `?block` to `nil`
3. `(pull ?block [*])` on `nil` returns `nil`
4. LogSeq filters out result rows containing `nil`
5. **Result:** Query returns 0 results (should return page with no blocks)

**DO:** split into separate queries (Pattern 1 below): the page first, failing if it's absent, then its blocks, where an empty array is a valid answer. The decision: [ADR-0007 (two-query-pattern-for-optional-data)](docs/adr/0007-two-query-pattern-for-optional-data.md).

Empty pages are common: in a journal-heavy graph, most non-journal pages may have no file at all (they exist only as link targets).

---

### 4. Datalog Goes to logseq.DB.datascriptQuery; logseq.DB.q Takes the Simple Query DSL

`logseq.DB.q` is LogSeq's *simple query* engine (the `{{query ...}}` language), not a Datalog endpoint.

| Call | Result |
|---|---|
| `DB.q` with a Datalog string | `null` |
| `DB.q` with `(task TODO)` | 30 blocks |
| `DB.q` with `[[page name]]` | 10 blocks |
| `datascriptQuery` with Datalog | Works |

**Verified.**

**DO:**
```rust
client.execute_datalog_query(&query.text, &query.inputs).await?; // calls logseq.DB.datascriptQuery
```

**Don't** treat a `null` from `DB.q` as "no results". It usually means the wrong dialect was sent.

**References:**
- Implemented in: `LogseqClient::execute_datalog_query` in `rust/src/client.rs`

---

### 5. Page Names are Stored Lowercase in :block/name

LogSeq normalizes page names to lowercase in the `:block/name` attribute, but preserves original casing in `:block/original-name`.

**Schema:**
```
Page entity:
  :block/name          - Lowercase normalized name (e.g., "alice")
  :block/original-name - Original casing (e.g., "Alice")
  :db/id              - Numeric ID
```

Lowercase the name before passing it as an `:in` input, so a lookup for `Alice`, `alice` or `ALICE` finds `alice` (Pattern 3 below). This matches LogSeq's own UI, which lowercases before lookup. `PageName::new` (`rust/src/edn.rs`) does it, and the query builders take a `PageName`, not a string, so none can skip it.

---

### 6. Don't Embed Strings; Escape Anything You Must

Embedding a string that contains `"` in the query text produces a malformed query:

```
[?p :block/name "foo "bar"]   →  LogSeq API error: Unexpected EOF reading string starting ""]].
```

**Verified.** A JSON string literal (what `serde_json` writes, and `JSON.stringify` in the scripts) is a valid EDN string literal for quotes, backslashes and newlines, and the escaped form runs correctly.

**DO:** pass strings as `:in` inputs (constraint 1). The client does the escaping, and the value is never part of the query text, so there is nothing to inject into. Every `queries.rs` in `rust/src` works this way ([ADR-0013 (strings-bound-via-in-inputs)](docs/adr/0013-strings-bound-via-in-inputs.md)).

- Numeric IDs are still embedded, in `ground` vectors, because collection `:in` inputs are unprobed. Build them with `ground_ids(&ids, "?p")` (`rust/src/edn.rs`), which takes `PageId`s: a `PageId` is only ever a positive whole number, so nothing else can reach the query text. Bind the ids straight to the entity variable (`ground_ids(&ids, "?p")` followed by a pattern on `?p`). `[?p :db/id ?id]` matches nothing, and a query whose only clause is the `ground` binding errors.
- If you ever must embed a string literal, write it with `serde_json::to_string`. A string used inside `re-pattern` also needs regex metacharacters escaped first (`rust/src/escape.rs`, #4).

---

### 7. `:block/uuid` Holds UUID Values, Not Strings

`:block/uuid` is a UUID type. A string never matches it, whatever the binding form:

| Call | Rows |
|---|---|
| `[(ground ["<uuid>"]) [?u ...]] [?b :block/uuid ?u]` | **0** |
| `[(ground [#uuid "<uuid>"]) [?u ...]] [?b :block/uuid ?u]` | 1 |
| `[(ground [#uuid "<known>" #uuid "<absent>"]) [?u ...]] ...` | 1 (absent ones just have no row) |
| `:in $ [?u ...]` with a JSON string collection | **0** |
| `[(uuid ?s) ?u]` | **Error:** `Unknown function 'uuid` |

**Verified** (`scripts/probe-constraints.ts`). The sketch in #18 used plain strings and would match nothing.

**Current practice:** `ground_uuids(&uuids, "?u")` (`rust/src/edn.rs`) embeds `#uuid "..."` literals. It takes `BlockUuid`s, and `BlockUuid::parse` accepts only the strict 8-4-4-4-12 hex pattern (lowercase), which rules out quotes, brackets and whitespace, so nothing can escape the literal. Page names for embeds still go through `:in $ [?n ...]` (a string collection works for names), with the or-join head `[?e ?n]`. Block uuids come back from pulls as plain strings. See `ref_targets` in `rust/src/resolve_refs/queries.rs` and `rust/src/resolve_refs/mod.rs`.

---

## Design Patterns

### Pattern 1: Two-Query Pattern for Optional Data

When related data might not exist (pages without blocks, pages without connections), split into separate queries instead of an `or-join` (constraint 3):

1. Query the main entity. If it's absent, fail (page-taking tools return `ToolError::PageNotFound` through the resolver).
2. Query the related data. An empty result is a valid answer: an empty `Vec`, not an error. (`null` is its own case, BR-0011.)

Why, and what it costs: [ADR-0007 (two-query-pattern-for-optional-data)](docs/adr/0007-two-query-pattern-for-optional-data.md).

**Used in:** `rust/src/tools/build_context/mod.rs`: page query, blocks query, then linked references via `logseq.Editor.getPageLinkedReferences`.

---

### Pattern 2: Multi-Query BFS for Graph Traversal

Instead of recursive queries or N sequential API calls, use BFS with one batched query per depth level:

```rust
let mut frontier = vec![root_id];

for depth in 1..=max_depth {
    // Query ALL pages at current depth in ONE call
    let query = connected_pages(&page_ids(&frontier)?);
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;

    // Process results for next depth
    frontier = new_pages(connected_rows(&answer)?);
}
```

**Performance:** at most max_depth + 1 calls, asserted by a call-count test (`rust/tests/concept_calls.rs`). Depth 2 from a hub with ~100 neighbours takes 3 calls, down from ~120.

> **Implemented in `rust/src/tools/get_concept_network/` (#3).** Caps matter: journal pages link to almost everything, and an uncapped depth-2 walk from one hub reached ~550 nodes once outbound links were followed. Defaults are `max_nodes` 50 (root included) and `max_fanout` 15 new pages per page. Journal pages are leaves unless `expand_journals` is set, and `truncated: true` is set whenever a cap bites. MCP clients set them with `max_nodes` (≤ 500), `max_fanout` (≤ 100) and `expand_journals` on `logseq_get_concept_network`. Why every walk is capped: [ADR-0011 (bounded-calls-and-results)](docs/adr/0011-bounded-calls-and-results.md).

**Real implementation:** `connected_pages` (`queries.rs`) and `get_concept_network` (`mod.rs`) in `rust/src/tools/get_concept_network/`. When the root has aliases, depth 1 uses `connected_pages_grouped` instead, so one query covers every name in the alias group (#69). One `or-join` covers both directions (outbound: blocks on the source page that ref another page; inbound: blocks on another page that ref the source). Frontier ids are bound with `ground_ids` directly to the entity variable (see constraint 6), and each page pair gets one edge with a reference count.

---

### Pattern 3: Case-Insensitive Lookup

Always lowercase page names before passing them as `:in` inputs, to match `:block/name` (constraints 1, 2 and 5). A `PageName` does it by construction, so build one and pass it on.

**Used in:** every query builder that takes a page name (the `queries.rs` files under `rust/src/tools/` and `rust/src/resolve/`).

**Also case-insensitive:** `search_by_relationship` matches `:block/refs` against lowercased names (#7), and `search_blocks` uses a `(?i)` regex (#4).

---

### Pattern 4: No Per-Page Crawls

Never call `logseq.Editor.getAllPages` and then make one call per page. On a ~2k-page graph, `query_by_property` used to make ~2k calls (one per page) and take ~10s this way (#33).

Use one Datalog query, filtering in the query with `includes?` / `re-find` / `get` / `contains?`, or batched queries with `[(ground [ids...]) [?id ...]]`. No tool crawls any more. The decision: [ADR-0002 (datalog-over-editor-api)](docs/adr/0002-datalog-over-editor-api.md).

---

## Migration History

The history and the reasons are in the ADRs ([index](docs/adr/README.md)):

- Editor API crawls (O(n) calls), then batched Datalog: [ADR-0002 (datalog-over-editor-api)](docs/adr/0002-datalog-over-editor-api.md)
- A feature-flagged dual HTTP/Datalog implementation, replaced by Datalog only (df7503a, 37fe0d6): [ADR-0005 (datalog-only-no-feature-flags)](docs/adr/0005-datalog-only-no-feature-flags.md)
- Strings embedded in query text, later bound with `:in` once probing showed it works: [ADR-0006](docs/adr/0006-embed-strings-in-datalog-queries.md), superseded by [ADR-0013 (strings-bound-via-in-inputs)](docs/adr/0013-strings-bound-via-in-inputs.md)
- Pages without blocks, fixed by splitting queries (d6c3151): [ADR-0007 (two-query-pattern-for-optional-data)](docs/adr/0007-two-query-pattern-for-optional-data.md)
- Redundant tools removed, 13 to 11 (9642558, 34a699a): [ADR-0008 (remove-redundant-tools)](docs/adr/0008-remove-redundant-tools.md). Later work added tools back. There are 16 registered in `rust/src/tools/mod.rs` today.
- A Rust implementation beside the TypeScript server (ADR-0025, ADR-0031, #122), held to its results byte for byte, then the TypeScript server removed after the Go on #349 (#356, last version at `10103c8`)
- Oct 2026: a review of 11 LogSeq, Obsidian, Roam, Notion, Tana and Basic Memory MCP servers set the roadmap in GitHub issues #3–#18. Probing the Datalog constraints and measuring API calls against a live graph (`scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`) corrected constraints 1, 2 and 4.

### Lessons Learned

1. **LogSeq's Datalog ≠ standard DataScript.** Probe before concluding something "doesn't work": the original conclusions on `:in` and `clojure.string` were over-generalized from a single failing case (constraints 1 and 2, ADR-0013).
2. **Simple is better.** Two queries that always work beat one query that sometimes works. No clever `or-join` tricks (Pattern 1, ADR-0007).
3. **Test with real data.** Property-style tests against a live graph found the empty-page and case-sensitivity bugs. The fixture graph now holds those cases, so the tests assert them exactly (Testing Philosophy, below).
4. **Feature flags added complexity.** They maintained dual implementations and were eventually removed in favor of simplicity: one direct Datalog path (ADR-0005).

---

## Common Gotchas

Quick reference checklist for future work:

**Queries**
- [ ] Build page names as `PageName`, which lowercases them, before they reach a query
- [ ] Pass strings as `:in` inputs (`DatalogInput`), never embedded in the query text. `execute_datalog_query` EDN-encodes them (a bare string would be read as a symbol).
- [ ] Embed numeric IDs only through `ground_ids`, which takes `PageId`s
- [ ] Don't use `clojure.string/lower-case`. `includes?`, `starts-with?`, `re-pattern` and `re-find` work.
- [ ] Split queries when data might be empty (don't rely on or-join with ground nil)
- [ ] Send Datalog to `logseq.DB.datascriptQuery`. `logseq.DB.q` takes the simple query DSL and returns `null` for Datalog.
- [ ] Handle empty arrays from queries gracefully (an empty `Vec`; `null` is its own case)
- [ ] Page names in `:block/name` are lowercase, not original casing
- [ ] Use `[(ground [id1 id2 id3]) [?id ...]]` for batch queries
- [ ] Never crawl `getAllPages` + one call per page (Pattern 4)
- [ ] `:with` can't name a variable that's also aggregated in `:find` (error: `:find and :with should not use same variables`)
- [ ] Match `:block/uuid` with `#uuid "..."` literals via `ground_uuids`; strings never match (constraint 7)
- [ ] Remember: LogSeq Datalog ≠ Standard DataScript

**Data shapes** (verified by `scripts/probe-constraints.ts`)
- [ ] `:block/journal-day` is an integer `YYYYMMDD` (e.g. `20260422`). Parse its digits (`JournalDay::parse`); never treat it as a timestamp.
- [ ] A scheduled or deadline date does not put `:block/journal-day` on a block (#140; probed on the fixture, LogSeq 0.10.15: `SCHEDULED`, `DEADLINE` and both, on journal and non-journal pages, 0 of 6). What does carry it is a block LogSeq **creates in the app** on a journal page, whatever its text (today's empty first block; blocks added with `Editor.insertBlock`, scheduled or not); no block on a file-backed page of the ~146-page fixture carries it, on LogSeq 0.10.15 (the `insertBlock` result is a hand check on a throwaway copy that the probe does not repeat, since it never writes). A query for journal pages must still require `[?page :block/name]`, or those blocks match as duplicate "pages" for the same day. The same query without it returns one extra row on a fresh fixture instance, the auto-created block of today's journal.
- [ ] `logseq.Editor.getBlock` returns `page` and `parent` as bare `{id}` objects. Resolve them; don't expect names.
- [ ] `:block/path-refs` includes refs inherited from ancestor blocks. Use it for "anything under a block tagged X".
- [ ] A nested pull works on refs: `(pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])` returns each ref as a page map in the same call (`query_by_date_range` uses it for `topConcepts`). A ref to a block (`((uuid))`) has no `name`, and journal pages carry `journal?` true and `journal-day`.
- [ ] `:block/updated-at` is missing on some pages (roughly 1 in 10 pages lacked it in testing). Use `get-else` with a default.
- [ ] Many pages are empty link targets with no blocks or file. Test with them.
- [ ] Read LogSeq through the typed readers of `rust/src/wire.rs`, never a `Value` picked apart inside a tool (#202). The wire types live beside the code that reads them (the resolver's in `rust/src/resolve/wire.rs`, a tool's in its own `wire.rs`). A reader checks the answer against the fields the code reads and returns a `ResponseError` (method and path, never a value) when one is missing or mistyped. The types name only the fields the code reads (extra keys pass, as LogSeq adds them), give `None` where LogSeq may answer `null` (a tool still treats `null` as its own case, BR-0011), and keep the key spelling LogSeq sent: an entity stays the `Value` LogSeq sent, not a rebuilt copy, because full output carries `original-name` for a pulled page and `originalName` for an Editor API one and BR-0004 forbids renaming either (`rust/src/entity.rs` reads both). A new field a tool reads goes in the wire type first; a type reached through a hot path (thousands of rows) must stay small, since each declared field costs time. A mock in a test must look like LogSeq's answer (a block has `id` and `uuid`; `getPage` answers a page or `null`, never `[]`), or the parse fails (`rust/tests/common/mod.rs` has the mock LogSeq).
- [ ] Resolve page names with `require_page` (`rust/src/resolve/mod.rs`), not a lookup of your own: [BR-0010 (page-names-resolved-via-resolver)](docs/business-rules/0010-page-names-resolved-via-resolver.md)
- [ ] An alias group is the pages that name one thing (#69). `alias:: x` stores `:block/alias` in **both directions** between the declaring page and the stub `x`, and LogSeq keeps a group of three or more as a **clique** (every page links every other), with no self-links. A reference points at whichever page entity the block named, so `[[Jordan]]` and `[[Jordan Rivera]]` are refs to different pages. Any tool that follows links to a page must use the whole group: `resolve_alias_set` in `rust/src/resolve/alias.rs` (one Datalog query for any number of pages, two hops, bound with `ground_ids`; it makes no call for a page whose pulled entity has no `alias` key, which relies on the symmetry above). Don't write the same variable twice in one pattern to test for a self-link (`[?p :block/alias ?p]` matched every link). A runaway query blocks LogSeq's HTTP API until it finishes, so bind every variable in a new `or-join` before running it. `getPageLinkedReferences` spans the group for the declaring page but not exactly for the stub (a few ids differ), which is why the aliased path uses `linked_references_of_pages` (`rust/src/resolve/queries.rs`; same block set as the Editor call for the declaring page, symmetric for every name). A tool that unions names reports them as `resolvedAliases` (original case, sorted; in `meta` for a bare-array result, keyed by topic in `search_by_relationship`), absent when the page has no aliases. Re-run the probe after LogSeq upgrades: its "must be 0" lines are what the resolver assumes.
- [ ] `:block/properties` is a map keyed by **keywords**, lowercase and dashed. `[(get ?props ?key) ?v]` needs a keyword: a string key, or a string `:in` input, matches nothing. Build it with `[(keyword ?key) ?kw]` from a string `:in` input. The Editor API returns the same keys camelCase.
- [ ] A property value is a string, number or boolean, or an array (a set) for multi-value properties and page refs. `(str ?v)` of a set is `#{...}`, so match scalars with `str` and set elements with `contains?`. `string?`, `coll?`, `seq` and `clojure.string/join` are unavailable.
- [ ] Page entities and their first (pre-)block both carry `:block/properties`. Require `[?b :block/page]` to get blocks only.

**HTTP API behaviour** (verified)
- [ ] An unknown method returns **HTTP 200** with body `{"error": "MethodNotExist: ..."}`. Always check the body; `rust/src/client.rs` does.
- [ ] A bad token returns HTTP 401. `client.rs` maps it to `LogseqError::Auth` (the message never contains the token).
- [ ] A hung request is aborted after `timeoutMs` (config field, default 30000, applied per `call_api` call) and surfaces as `LogseqError::Timeout`.
- [ ] `logseq.Editor.getEditingBlockSelection` doesn't exist. Use `getSelectedBlocks`, which returns `null` when nothing is selected.
- [ ] Without `includeChildren`, Editor API blocks carry `children` as unfetched `["uuid", "<id>"]` tuples, not block entities. `getCurrentPage` can return `null` while `getCurrentBlock` returns a block, or return a block when zoomed in. `get_current_context` handles all three.
- [ ] `LOGSEQ_MCP_CONFIG=<absolute path>` replaces `~/.logseq-mcp/config.json` for the server (read once, in `Env::from_process` in `rust/src/env.rs`; a relative path is a `ConfigError::Validation`). Nothing else reads an environment variable or the home directory (`rust/tests/env_reads.rs`), and the config path is never hard-coded. The integration tests and the probe use `resolveFixtureConfigPath()` (`tests/integration/helpers/instance-config.ts`) instead, which has no fallback to `~/.logseq-mcp/config.json`. `scripts/logseq-instance.ts start` prints the value for this worktree's instance (#118).
- [ ] A fresh LogSeq profile opens the demo graph with no API server. Seeding it takes the localStorage keys `current-repo` and `http-server-enabled` plus an empty graph cache file, and isolating `~/.logseq` takes both HOME and `CFFIXED_USER_HOME`. Details: `scripts/logseq-instance/local-storage.ts` and `instance.ts`. The API answers CORS `*` and can run commands, so an instance's token is random per start and never committed.
- [ ] LogSeq writes to the graph it opens: it rewrites `logseq/config.edn` and adds `logseq/bak/`, today's journal and `pages/contents.md`. The instance therefore opens a copy, `.logseq-instance/graph/`, made fresh on every `start` without `logseq/bak/`, and the committed fixture is only read (#151). `stop` leaves the copy for inspection.

**Tool behaviour**
- [ ] Don't turn errors into empty results; propagate infrastructure errors: [BR-0003 (infrastructure-errors-propagate)](docs/business-rules/0003-infrastructure-errors-propagate.md)
- [ ] Never cut results silently; any cap reports `ResultMeta`: [BR-0006 (no-silent-truncation)](docs/business-rules/0006-no-silent-truncation.md)
- [ ] `null` from an API call is not `[]`: [BR-0011 (null-is-not-empty)](docs/business-rules/0011-null-is-not-empty.md)
- [ ] `resolve_refs` is opt-in and non-lossy; one resolver, `resolve_block_refs`: [BR-0007 (resolve-refs-non-lossy)](docs/business-rules/0007-resolve-refs-non-lossy.md)
- [ ] Guidance for the model (#44) lives outside the tools. Server `instructions` are in `rust/src/instructions.rs`. Next-step tips: [BR-0009 (tips-are-advisory)](docs/business-rules/0009-tips-are-advisory.md). Parameter aliases: [BR-0008 (param-aliases-best-effort)](docs/business-rules/0008-param-aliases-best-effort.md). Every tool description needs a "Can't find" line ([ADR-0015 (tool-descriptions-state-limits)](docs/adr/0015-tool-descriptions-state-limits.md)).
- [ ] Prompts and resources (#46) live in `rust/src/prompts.rs` and `rust/src/resources.rs`; `rust/src/server.rs` only declares the capabilities and routes the requests. Both are read-only. A prompt returns one short user message naming the tools to call, defers to the `logseq-skills` workflow rather than copying it, quotes any argument it embeds, and rejects unknown or malformed arguments as `InvalidParams`. A test in `rust/src/prompts.rs` checks that a prompt names only existing tools, so a tool rename fails it. `serverInfo.version` is read from `package.json` (`rust/src/server.rs`), and `tests/rust-guards/version.test.ts` keeps `.claude-plugin/plugin.json` on the same version.
- [ ] Publishing (#46) is manual: `.github/workflows/publish.yml` runs only on `workflow_dispatch`, needs the `NPM_TOKEN` secret, and defaults to a dry run. Never publish, tag or release from a session. Why: [ADR-0017 (manual-npm-publish)](docs/adr/0017-manual-npm-publish.md). The workflow and the npm packaging in `package.json` are the TypeScript server's and stale until #350 and #355 decide how the Rust binary ships; the rule stands for whatever replaces them.
- [ ] Slim output is the default: [BR-0012 (slim-output-default)](docs/business-rules/0012-slim-output-default.md)
- [ ] Output format (#43). `get_page`, `get_block`, `build_context`, `get_context_for_query` and `get_concept_network` take `format: "json" | "markdown"` (default `json`, unchanged). Markdown is one plain text content block, not JSON-escaped, rendered by the one shared renderer in `rust/src/markdown.rs` (`markdown_context.rs` for the context and network tools). `logseq://page/{name}` renders through the same `render_page`: never add a second renderer. Layout: page properties as `key:: value` (the page's pre-block text verbatim when the tree has one, so `[[refs]]` and hyphenated keys survive; only when there is no pre-block does `render_properties` rebuild them from the map: kebab-case keys, multi-value as `[[a]], [[b]]`; never rewrite a pre-block), blocks as tab-indented `- ` bullets, `((uuid))` refs untouched, `resolvedContent` on a `[resolved]` line under its block, related pages as `[[links]]`, references grouped by source page, and a footer after `---` for `warnings`, `hasMore` and tips (tips ride in the footer, not a second content block). Full Markdown omits block uuids on purpose (they bloat every bullet; `compact` adds them), with one exception: keyword search hits in `get_context_for_query` always end with `((uuid)) (in [[Page]])`, since for a query with no topic they are the whole answer and would otherwise be a dead end. That needs one extra batched page query, made only for `format: "markdown"` (`hitPages`). An ambiguous name stays a structured JSON result in both formats; errors stay JSON `{error}`. `format` and `compact` are parsed at the boundary, like every tool argument (#60): read through `Arguments` (`rust/src/args.rs`), with the `inputSchema` generated from the same argument type. Bad values are rejected with an `InvalidParameter` error. Markdown renders the full result, uncapped except the resource's `MAX_PAGE_CHARS`.
- [ ] `compact` (#43) exists on `build_context` and `get_context_for_query` only: block bodies become a first-line snippet (`rust/src/snippet.rs`, 80 characters) plus the block's `((uuid))`; in JSON a block is `{ uuid, snippet }` and pages are `{ id, name, originalName }` (`rust/src/compact.rs`). `summary`, `totals`, `warnings` and `hasMore` stay. It is off for `get_page` and `get_block` (the outline tool covers that), and for `get_concept_network`, which already carries no bodies. Compact skips `resolve_refs`, and `build_context` says so with a `resolve_refs_ignored_in_compact` warning (resolving would put the bodies back and defeat compact; the warning names `compact: false` and `get_block` as the ways to get resolved text). `get_context_for_query` has no `resolve_refs`. For blocks shorter than the uuid, compact can be larger than the full markdown; it pays off on long blocks.
- [ ] `logseq_get_page_outline` (#43): top-level `{ uuid, snippet, childCount }` (direct children only), in two calls. The query (`page_outline_blocks` in `rust/src/tools/get_page_outline/queries.rs`) binds the resolved page id and returns the top-level blocks plus their direct children in one `or-join`; the tool counts children per parent in Rust and orders siblings by the `:block/left` chain. Capped at `MAX_OUTLINE_BLOCKS` (200) with an `outline_truncated` warning and no `howToFetchAll` (an outline cannot be paged; `hasMore` stays false). It is the step before `get_block` in the server `instructions`.
- [ ] Tool results are minified JSON (compact `serde_json` output, no layout whitespace). The parity step of CI fails if any tool adds layout whitespace (it compares each result byte for byte). `format: "markdown"` is the opt-in plain text exception (#43). Pretty output would need an opt-in parameter and an exemption there. Why: [ADR-0009 (minified-json-output)](docs/adr/0009-minified-json-output.md).
- [ ] The config file is parsed once, by `load_config` in `rust/src/config.rs` (#63), into a typed `Config`. Its failures are `ConfigError` variants; tell them apart by variant, never by message text. No config error message shows a config-file value or the file's text, since either can be the token ([ADR-0003 (no-secrets-in-source)](docs/adr/0003-no-secrets-in-source.md)): a JSON parser's message sometimes quotes the file, and those are replaced. Only the `LOGSEQ_MCP_TIPS` error echoes its value, which holds no secret.
- [ ] Never write to stdout (`println!`, `print!`, `dbg!`, `io::stdout`). It's the MCP stdio channel; log with `eprintln!`. `rust/tests/no_stdout.rs` fails on any hit in `rust/src` (#82). Never log graph data either: [ADR-0004 (stderr-only-logging)](docs/adr/0004-stderr-only-logging.md).

---

## Testing Philosophy

### Fixture Graph, Exact Assertions

The integration tests run against `tests/fixtures/graph/`, a small made-up graph in the repo (#86, #90), and nothing else. `connectFixture()` (`tests/integration/helpers/fixture-client.ts`) loads the config and calls `requireFixtureGraph`, and the run's global setup does it once first, so a run against any other graph fails loud. `tests/integration/setup.md` has the run steps; `tests/fixtures/README.md` says what each page is for and what it returns.

**Pattern:**
```typescript
beforeAll(async () => {
  ({ client } = await connectFixture());
});

it('returns every neighbour of a page under the caps', async () => {
  const result = await getConceptNetwork(client, 'bob', 1);

  expect(result.nodes.map(n => n.name).sort()).toEqual(BOB_NETWORK); // known fixture data
  expect(result).toMatchObject({ truncated: false, hasMore: false, warnings: [] });
});
```

- **Exact values from known pages**, never data discovered at run time. A test that needs new data adds it to the fixture and its README in the same PR.
- **Compute what drifts**: today's journal (LogSeq makes it on open; `laterJournalDays`), and page counts that include built-in pages. Use fixed date windows that end before 2026.
- **Caps that pick by `:db/id` order** are stable in count, not by name; the fixture README's hub section says which is which.
- **Invariants** that hold for any graph stay as property tests (`tests/integration/properties/`), run over a fixed list of fixture pages.
- **A known bug** is a plain `it` that pins the current wrong value and names its issue, to be flipped with the fix. Not `it.fails`, which also passes when the body throws for another reason.

**Test Categories:**
- **Rust tests** (`cd rust && cargo test --locked`): query builders, data transformations and call-count tests against a stub LogSeq
- **Golden results** (`npx vite-node scripts/parity.ts`): every tool, prompt and resource result byte for byte against the results recorded from the TypeScript server, the LogSeq calls, and `tools/list` by meaning (ADR-0031)
- **Guard tests** (`npx vitest run tests/guards tests/rust-guards`): the repo's rules (docs format, templates, privacy, fixture, workflows, tool-list guardrails)
- **Integration tests** (`npm run test:integration`, ~215 in 22 files as of Oct 2026, against the fixture graph in a live LogSeq): exact results of every tool, through the Rust server
- Note: `npm test` runs the guard tests, then `npm run test:integration`, so it needs the fixture instance running and the Rust debug build. The default vitest config leaves `tests/integration/` out.
- **Property tests**: Universal invariants, equivalence validation (`tests/integration/properties/`, and the crawl oracles in `query-by-property` and `temporal-queries`)

### Integration Test Requirements (Hard Failures)

Integration tests must fail loud on BOTH setup issues AND missing test data.

**Rules:**
1. **NO it.skipIf() for integration tests** - Tests must run or fail, never skip
2. **NO console.warn() in tests** - Silent warnings hide real failures
3. **REQUIRE prerequisites explicitly** - `connectFixture()` checks the config, the connection and the fixture graph
4. **Fail with helpful messages** - Point to setup.md for resolution steps

**Pattern:**
```typescript
// ❌ BAD: Silent skip/warn
beforeAll(async () => {
  try {
    await access(configPath);
  } catch {
    skipTests = true; // Silent skip - test suite passes without testing!
  }
});
it.skipIf(skipTests)('test', async () => { ... });

// ❌ BAD: Silent warn
const result = await searchBlocks(client, 'test');
if (!result || result.length === 0) {
  console.warn('No data found'); // Test passes without proving anything!
  return;
}

// ✅ GOOD: Fail loud, and assert exactly what the fixture holds
beforeAll(async () => {
  ({ client } = await connectFixture()); // throws, pointing at setup.md, unless LogSeq serves the fixture
});

it('test', async () => {
  const result = await searchBlocks(client, 'importer');
  expect(result).toHaveLength(11); // the fixture's 11 blocks that say "importer"
});
```

**Why:**
- Skipped tests provide false confidence
- Passing tests that found no data prove nothing
- Integration tests must test real integration
- Clear failures guide developers to fix actual problems

---

## Performance Benchmarks

Measured numbers are in "Current Implementation Status" under "Why Datalog?". Regenerate them with:

```bash
npx tsx scripts/measure-api-calls.ts            # picks the most-referenced page
npx tsx scripts/measure-api-calls.ts "my page"  # or a specific page
npx tsx scripts/measure-api-calls.ts --rust-binary rust/target/debug/logseq-mcp-server  # another binary than the release build (both measure scripts take it)
npx tsx scripts/measure-output-size.ts          # output size, slim vs full (#42), markdown and compact vs json (#43); bytes only, no names
```

These runs use the default config, the real ~2k-page graph: time and output size depend on scale, so the table stays a real-graph baseline. With `LOGSEQ_MCP_CONFIG` pointing at the fixture instance they measure the fixture instead (subject `hub central`), which is reproducible and good for checking a change's call count, but don't update the table from it. Decision recorded in #90; `tests/integration/setup.md` ("Probe and measure scripts") has the details.

---

## Code Organization

```
src/
├── client.ts                      - LogseqClient with HTTP + Datalog methods
├── datalog/
│   └── queries.ts                 - DatalogQueryBuilder with all query templates
├── tools/
│   ├── build-context.ts           - Two-query pattern (page + blocks)
│   ├── get-page-outline.ts        - Top-level blocks, snippets and child counts
│   ├── get-concept-network.ts     - Batched BFS with caps (Pattern 2)
│   ├── search-by-relationship.ts  - Relationship search
│   └── [12 other tools]
├── utils/
│   ├── markdown.ts                - The one Markdown renderer (pages, blocks, footer); used by the page resource too
│   ├── markdown-context.ts        - Markdown for build_context, get_context_for_query, get_concept_network
│   ├── compact.ts                 - compact JSON; snippet.ts has firstLineSnippet
│   ├── parse-args.ts              - parseArgs / toInputSchema: tool arguments parsed with zod (#60)
│   ├── parse-response.ts          - callParsed / queryParsed / parseResponse: LogSeq responses checked against the schemas (#202)
│   └── entity-fields.ts           - Reads a page or block field in either key spelling
├── tool-args.ts                   - zod argument schemas, one per tool, which also generate each inputSchema
├── response-schemas.ts            - zod schemas for LogSeq's responses (Editor API camelCase and Datalog kebab-case); the entity types are built from them (#202)
└── types.ts                       - TypeScript interfaces

tests/
├── integration/                   - Tests against real LogSeq
│   └── properties/                - Property-based tests
└── [unit test files]              - Mocked tests (co-located in src/)

scripts/
├── probe-constraints.ts           - Verifies the Datalog/API constraints against a live LogSeq (use the fixture)
├── measure-api-calls.ts           - Counts API calls per tool against a live graph (baseline: the real graph)
├── measure-output-size.ts         - Output bytes per tool, slim vs full and markdown/compact vs json, through the MCP server
├── logseq-instance.ts             - start/stop/status of this worktree's own LogSeq on a copy of the fixture graph (#118, #151, macOS)
├── generate-hub-fixture.ts        - Writes (or --check's) the hub fixture's files from fixture-hub/hub-graph.ts (#89)
├── fixture-hub/hub-graph.ts       - Shape and counts of the hub fixture; tests/guards/fixture-hub.test.ts checks the committed files against it
└── logseq-instance/
    ├── instance.ts                - Instance logic: paths, port, random token, graph copy, launch, readiness, stop (deps injected)
    ├── local-storage.ts           - Writes a fresh profile's Chromium localStorage LevelDB (current-repo, http-server-enabled)
    └── configs.edn.template       - App settings for the instance (API autostart, port and token placeholders)

skills/logseq-skills/              - Claude Code skills (SKILL.md, skills/, references/, scripts/); symlinked from .claude/skills/
.claude-plugin/                    - plugin.json + marketplace.json (server declared inline in plugin.json)
```

**Key files:**
- `src/datalog/queries.ts` - All Datalog query builders (study this for patterns)
- `src/tools/build-context.ts` - Example of two-query pattern
- `src/tools/get-concept-network.ts` - Example of multi-query BFS
- `tests/integration/properties/graph-properties.test.ts` - Property-based testing examples

---

## Useful Commands

```bash
# The Rust server: build, then its unit and call-count tests (touch no LogSeq)
(cd rust && cargo build && cargo test --locked)

# The golden-result harness against the debug build (#124); --self-check proves it can fail
npx vite-node scripts/parity.ts
npx vite-node scripts/parity.ts --self-check
# Re-record the expected results on purpose, from the Rust debug build, never in CI (#299)
npx vite-node scripts/parity.ts --record-from-rust

# The repo's guard tests (docs format, templates, privacy, workflows, tool-list guardrails) and the type-check
npx vitest run tests/guards tests/rust-guards
npm run typecheck
npx tsx scripts/docs-format.ts

# Integration tests against this worktree's fixture instance (macOS; own profile, port and random API token)
npx tsx scripts/logseq-instance.ts start
npm run test:integration          # picks up .logseq-instance/config.json while the instance runs
npx tsx scripts/logseq-instance.ts stop
git status                        # sanity check: nothing under tests/fixtures/graph/ (the instance opens a copy, #151)

# The suites run the Rust server (#352, #356): build rust/ first; details in tests/integration/setup.md

# Verify Datalog/API constraints (read-only); the fixture reproduces all of them
npx tsx scripts/probe-constraints.ts   # uses the running instance; never the personal config

# Count API calls per tool (read-only): the default config is the real-graph baseline; the fixture gives reproducible counts
npx tsx scripts/measure-api-calls.ts

# Output size per tool: slim vs full, markdown and compact vs json (read-only; prints byte counts only)
npx tsx scripts/measure-output-size.ts
```

---

## When Adding New Tools

Checklist for new Datalog-based tools:

1. **Query Builder** - Add static method to `DatalogQueryBuilder`
   - Pre-lowercase any page name parameters
   - Return `{ query, inputs }` and bind strings with `:in`; don't embed them in the query text
   - Don't use `clojure.string/lower-case`
   - No `getAllPages` + per-page crawls

2. **Tool Implementation** - Follow two-query pattern if data is optional
   - Query 1: Main entity (fail if not found)
   - Query 2+: Related data (handle empty results)

3. **Tests** - Write unit tests with mocks
   - Test happy path with data
   - Test empty results (no blocks, no connections)
   - Test case-insensitive lookup

4. **Integration Test** - Add to `tests/integration/`
   - Connect with `connectFixture()` and assert exact results on fixture pages; add fixture data (and its README rows) if the tool needs a case the fixture lacks
   - Fail loud, never skip (see Integration Test Requirements)

5. **Documentation** - Update MCP tool handler in `src/index.ts`
   - Give the tool `annotations: readOnlyAnnotations('Title')` (`tests/guards/tool-list.test.ts` and `rust/src/server.rs` fail without it). Every tool is read-only: [BR-0002 (tools-read-only)](docs/business-rules/0002-tools-read-only.md)
   - Declare the tool's zod schema in `src/tool-args.ts` and parse with `parseArgs`. The guard test (`src/index.args.guard.test.ts`) checks it
   - Read each LogSeq response with `callParsed` / `queryParsed` and a schema from `src/response-schemas.ts` (add one when the shape is new)

6. **Measure** - Add the tool to `scripts/measure-api-calls.ts` and record its call count in "Current Implementation Status"

7. **Tool-list guardrails** - `tests/guards/tool-list.test.ts` checks the recorded `tools/list` (`scripts/parity/expected/tool-list.json`; the parity harness holds the Rust server's list to it by meaning, so a change to a tool's name, description or schema is a change to that file, re-recorded with `--record-from-rust`) ([ADR-0016 (tool-list-size-guardrails)](docs/adr/0016-tool-list-size-guardrails.md))
   - Size budget: `TOOL_LIST_BUDGET_CHARS` (~15% headroom over the size measured when it was added). If your tool or parameters push past it, trim first. If the growth is worth it, raise the constant and justify it in the PR description.
   - Description cap: 400 characters per tool. A new tool gets no allowance. Existing long descriptions are listed in `DESCRIPTION_ALLOWANCES` and may shrink but not grow. Delete an entry once its tool fits the cap.
   - Recorded list: any change to a name, title, annotation, description or input schema fails the parity step. Review the diff of `scripts/parity/expected/tool-list.json` before you accept it.

---

## References

- **LogSeq HTTP API:** http://127.0.0.1:12315/api (default)
- **DataScript Docs:** https://github.com/tonsky/datascript (note: LogSeq subset only)
- **Decisions and rules:** [`docs/adr/`](docs/adr/README.md) (why we chose X) and [`docs/business-rules/`](docs/business-rules/README.md) (what must stay true). The Datalog migration is recorded in [ADR-0002 (datalog-over-editor-api)](docs/adr/0002-datalog-over-editor-api.md) and [ADR-0005 (datalog-only-no-feature-flags)](docs/adr/0005-datalog-only-no-feature-flags.md).
- **Example Scripts:** `scripts/probe-constraints.ts`
- **MCP Spec:** https://github.com/modelcontextprotocol

---

## Summary

Datalog is how this project gets its performance gains (see "Current Implementation Status"), and LogSeq's Datalog needs careful handling. The key is to:

1. **Bind strings with `:in`** (`executeDatalogQuery` EDN-encodes the inputs); never embed them in the query text
2. **Lowercase in TypeScript** (`clojure.string/lower-case` is unavailable; `includes?` / `re-find` work)
3. **Split queries** for optional data (no or-join with ground nil)
4. **Always lowercase** page names before queries
5. **Handle empty results** gracefully, but never turn errors into empty results
6. **Batch, don't crawl**: one query or `ground`-batched queries, never one call per page

When a constraint seems to block you, re-run `scripts/probe-constraints.ts` against the fixture instance before working around it.

When in doubt, look at `src/datalog/queries.ts` for working patterns and `src/tools/build-context.ts` or `src/tools/get-concept-network.ts` for implementation examples.
