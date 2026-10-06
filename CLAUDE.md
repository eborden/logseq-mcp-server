# LogSeq MCP Server - Technical Context

## Privacy: Never Commit Details From the Personal Graph

The LogSeq instance this server is developed against is the maintainer's **personal** graph. Integration tests, probes and scripts read real data from it. None of that data may leave the machine through this repo or its GitHub project.

**Never put any of the following in committed files** (code, tests, fixtures, docs, skills, CLAUDE.md), **commit messages, GitHub issues, PR descriptions or comments:**
- Page names, journal titles, tags or property values from the graph
- Block content, quotes or paraphrases of what the graph says
- People's names (journals mention real colleagues, friends and family)
- Dates of specific journal entries, or anything that reveals what happened on a given day
- Raw output from `scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`, `scripts/measure-output-size.ts` or integration-test runs. Their output includes real page names.

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

Adding an ADR or rule, or any of these changes, needs the maintainer's OK before merge (see Merge policy).

**Format.** `src/docs-format.test.ts` checks both directories in CI: filenames, the Index table, required headings, ADR status lines, business-rule Changelog tables, `<tier>: <reference>` enforcement lines and relative links. Run `npx tsx scripts/docs-format.ts` to check locally.

---

## Development Workflow

Work is tracked in GitHub issues and the [LogSeq MCP Workflow](https://github.com/users/eborden/projects/1) project board.

### Plans live in issues
- Write a plan as GitHub issues, not as a file in `docs/plans/` and not only in the conversation. (Plans aren't kept in `docs/`. Git history holds the old ones.)
- Split anything multi-part into sub-issues linked to a parent. Record sequencing (waves, dependencies) in the parent or a comment on it. Close the parent when its sub-issues are done.
- Sequence in waves so at most one open PR touches a given file area. Guardrails and conventions first, features next, output-wide changes last.
- Add new issues to the board: *Backlog*, or *Ready* once the maintainer has approved the plan. When a plan changes, edit the issues (scope comments, new sub-issues, close obsolete ones).
- **Hard ordering uses GitHub issue dependencies.** If B can't start until A merges (file overlap, needs A's code, or a migration order), mark B **blocked by** A and record why in a comment. The edges are the source of truth. A wave list in a comment can summarise the plan, but when a plan changes, update the edges too.
  ```bash
  gh api repos/eborden/logseq-mcp-server/issues/<A> --jq .id    # A's REST id (not its number)
  gh api -X POST repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by -F issue_id=<A's REST id>
  gh api repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by --jq 'map(.number)'    # list B's blockers
  ```
- **Grouping uses sub-issues.** A multi-part plan is a parent with sub-issues, as above.
- **Priority only breaks ties.** P0/P1/P2 on the board orders items that aren't blocked. It doesn't express ordering.

### Board statuses
Flow: **Backlog → Ready → In progress → In review → Done**. Move an item to *In progress* when work starts, to *In review* when its PR opens (add the PR to the board too), and to *Done* on merge.

The board has three fields: **Status** (the flow above), **Priority** (P0-P2) and **Size**.

```bash
gh project item-add 1 --owner eborden --url <issue-or-pr-url>
gh project item-edit 1 --owner eborden --url <issue-or-pr-url> --field Status --value "In review"
gh project item-list 1 --owner eborden --format json    # items[].status
```

These need the `project` scope: `gh auth refresh -s project`.

### Ready items go to subagents
- **Anything in *Ready* is implemented by a subagent**, not inline in the main session. The main session picks Ready items, sequences them, briefs one subagent per issue, spawns a separate reviewer subagent for each PR it opens (see Code review) and updates the board.
- Pick from *Ready* by taking unblocked items (no open blocked-by issue, see "Plans live in issues"), highest priority first. Run in parallel only items with no blocked-by edge between them and no file overlap.
- Each subagent works in its own git worktree branched from `origin/main`.
- Run subagents in parallel only when their files don't overlap. Give each a distinct anchor for new `DatalogQueryBuilder` methods and its own new test file.
- Subagents open PRs and don't merge. They stage files by explicit path and never commit `node_modules`, `dist`, local settings or draft docs.

### PR conventions
- Atomic commits, `Closes #N`, a design section, a test plan with checkboxes, and approximate measurements (no graph data, see Privacy).
- A PR that edits a business rule adds a row to that rule's Changelog table citing the PR. The format check can't tell whether a row is new, so the reviewer checks it. A new rule also adds its Index row and an `Introduced.` Changelog row. A retired rule's Index summary starts with `Retired.`, and its Changelog row reads `Retired.`.
- A PR that adds an ADR opens it as `proposed` and edits the status to `accepted` in the same PR before merge.
- Rebase-merge so the atomic commits stay on `main`. Delete the branch on merge.

### Code review (required for every PR)
1. After a PR opens, a **separate reviewer subagent** reviews it. It starts fresh, with only the PR number, the linked issue and this file.
2. It posts **one review with inline comments** on specific lines. Each comment says what's wrong, why, and what to do. Focus on correctness, the constraints in this file, privacy, test gaps and contract changes. No nits about style the codebase doesn't enforce.
   - Does the PR add, change, supersede or retire an ADR or business rule, including an edit to its Mechanical enforcement lines? If so, say in the review body that it needs the maintainer's OK before merge, even with self-merge (see Merge policy).
   - Does the PR contradict an accepted ADR or business rule without citing the change that allows it (a superseding ADR or an edited rule)? If so, comment on the contradicting line.
   ```bash
   gh api repos/eborden/logseq-mcp-server/pulls/<n>/reviews --input review.json
   # review.json: {"event": "COMMENT", "body": "...",
   #   "comments": [{"path": "src/x.ts", "line": 12, "side": "RIGHT", "body": "..."}]}
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

### Verification before merge
Done by whoever merges:
- CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` and `vitest run src` on Node 22 and 24 on every PR and push to `main`. It must be green. `engines.node` is `>=22.12.0`, the floor of the dev toolchain (vite 7). The integration tests and measure script stay local.
- Privacy grep of the diff, commit messages, PR body and review comments/replies. Don't paste integration-test or measure-script output anywhere on GitHub. Report pass/fail and approximate counts only.
- `npx tsc --noEmit`
- `npx vitest run src`
- `npm run test:integration` against the live graph (read-only)
- `npx tsx scripts/measure-api-calls.ts` still runs
- A clean merge against current `main`. If `main` has moved, test the PR merged onto it.

### Merge policy
- **Three actions need the maintainer's explicit OK:** merging a PR, moving a board item from *Backlog* to *Ready*, and merging any PR that adds, changes, supersedes or retires an ADR or business rule, even with self-merge. Everything else (issues, PRs, reviews, resolving threads, pushing to feature branches, other status moves) is allowed by default.
- **The maintainer merges by default.** Claude may merge its own PRs only if the maintainer has explicitly granted self-merge to the session. Without that grant, open the PR and stop.
- **The ADR and business-rule gate applies even with self-merge.** Before merge, a PR comment records the approval: the maintainer writes it, or Claude posts it quoting the maintainer's message verbatim with its date. If the maintainer merges the PR, the merge is the record (see the Approval gate in [`docs/adr/README.md`](docs/adr/README.md#change-process)). What an approval survives is set here only, not in the READMEs:
  - A rebase or conflict resolution that changes nothing of substance keeps the approval.
  - A renumber on rebase (the stem, Index row and citations only, required when another PR merged the number first) is mechanical and keeps the approval. Whoever merges reports the new number to the maintainer.
  - Any push after the approval that changes the wording of an ADR or rule, or the behaviour of the PR, needs a fresh OK.
- Even with self-merge, the verification and the merge gate above still apply. Raise decisions that belong to the maintainer (behaviour changes, publishing, accounts) instead of merging past them.

---

## Overview

This is an MCP (Model Context Protocol) server that provides Claude with 15 tools for querying LogSeq knowledge graphs. Built with TypeScript, it uses LogSeq's HTTP API and DataScript query engine to enable efficient graph traversal and context building.

**Key Stats:**
- 15 MCP tools for graph operations, search, and temporal queries
- Unit tests (`npx vitest run src`) plus integration tests against a live graph (`npm run test:integration`). `npm test` runs both.
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

Measured with `npx tsx scripts/measure-api-calls.ts` (Oct 2026, ~2k-page graph, hub page with ~100 direct neighbours):

| Tool | API calls | Time | Notes |
|---|---|---|---|
| `build_context` | 3 (4 with an alias) | ~0.2s | 2 Datalog + 1 linked refs. A page with aliases adds 1 alias-group query and takes its blocks and linked references from Datalog over the group instead of the Editor call (#69) |
| `get_context_for_query` (1 topic) | 3 (4 with an alias) | ~0.1s | Delegates to `build_context` |
| `get_concept_network` depth=1 | 2 (3 with an alias) | ~0.1s | Default caps: 16 nodes. A root with aliases adds 1 alias-group query; the depth-1 walk then covers every name in one grouped query (#69) |
| `get_concept_network` depth=2 | 3 (4 with an alias) | ~0.2s | One batched query per depth, both directions. Default caps: 50 nodes. Was ~120 calls (#3) |
| `search_blocks` | 1 | ~0.1s | One case-insensitive regex query. Was ~130 calls, or ~2k for a search with no match (#4) |
| `query_by_date_range` (7 days) | 2 (3 with `search_term`) | ~0.2s | Journal pages + blocks, tree rebuilt in TypeScript. Same at 30 or 90 days. Was 1 + journal days (#5). A `search_term` adds 1 query that looks for a page of that name and its aliases, skipped when no journal is in range (#69) |
| `get_page` | 1 | ~0.01s | Exact name of a page with a file: `Editor.getPage` alone, no resolver query (2 with children). An alias, ISO date, namespace leaf, file-less stub or miss adds one resolver query: 3 for an alias or date, 4 for a miss (first lookup, resolve, leaf, `getAllPages`) (#41) |
| `get_page_outline` | 2 | ~0.05s | 1 resolver query + 1 query for the page's top-level blocks and their direct children, so child counts need no call per block. An alias or ISO date costs the same 2; a namespace leaf adds 1, a miss adds the suggestion lookup. Capped at 200 blocks (#43) |
| `get_backlinks` | 2 (3 with an alias) | ~0.2s | 1 resolver query + 1 linked-references call. Was 1 before page resolution (#41). A page with aliases adds 1 alias-group query, and the references come from one Datalog query over the group in place of the Editor call (#69) |
| `get_concept_evolution` | 4 (5 with an alias) | ~0.1s | 1 resolver query + page tree + page + 1 mentions query. Was 3 before page resolution (#41). A page with aliases adds 1 alias-group query; the mentions query then covers the whole group (#69) |
| `search_by_relationship` | 3 (4 with an alias) | ~0.05s | `references` / `in-pages-linking-to`: 2 resolver queries (run in parallel; 1 when both topics are the same name) + 1 query. Was 1 before page resolution (#41, #7). `connected-within` is O(maxDistance): 2 resolver queries, then 1 per hop, and the resolved ids seed the BFS. Either topic having aliases adds 1 alias-group query for both topics together, and the queries match by the groups' ids (#69). `connected-within` for two names of one page makes no hop query and returns a `same_topic` warning |
| `query_by_property` | 1 | ~0.02s | One query over `:block/properties`, page name inline. Blocks are flat (no `children`). Was ~2k calls, ~10s (#33) |
| `resolve_refs: true` on `get_block`, `get_page` (with children), `build_context`, `query_by_date_range` | +0 to +2 | ~0.03-0.1s | Opt-in (#18). One batched query per nesting level, depth 2: +1 when the refs point at plain blocks, +2 when those hold refs of their own, +0 when nothing in the result has a ref. Same cost for 1 day or 30. Off: calls and output unchanged |
| `format: "markdown"` on `get_page`, `get_block`, `build_context`, `get_context_for_query`, `get_concept_network` | +0 | | Rendering only, no extra call, except a no-topic `get_context_for_query` in markdown: +1 batched query for the hit pages. About 45-85% fewer bytes than the JSON (a long page ~80%, `build_context` ~75-80%, a depth-2 network ~45%). `compact` on `build_context` and `get_context_for_query` also saves calls: it skips `resolve_refs`, with a warning (#43) |
| `get_current_context` | 3-4 | ~0.01s | 3 Editor calls (`getCurrentPage`, `getCurrentBlock`, `getSelectedBlocks`) + 1 Datalog pull by `:db/id` only when a block's page isn't the open page (#15) |

Re-run the script after changing any of these tools, and update this table.

## Critical LogSeq Datalog Constraints

LogSeq's Datalog implementation (via `logseq.DB.datascriptQuery`) has significant limitations compared to standard DataScript. Understanding these constraints is essential for writing working queries.

Every constraint below marked **Verified** is reproduced by `npx tsx scripts/probe-constraints.ts` (read-only, needs a running LogSeq). Re-run it after LogSeq upgrades.

### 1. `:in` Parameters Need EDN-Encoded Inputs

`:in` works, but LogSeq reads every input passed after the query string as EDN. A bare string is read as a **symbol**, so it matches nothing.

| Call | Rows |
|---|---|
| `datascriptQuery(query-with-embedded-literal)` | 1 |
| `datascriptQuery(query-with-:in, "my page")` (bare string) | **0** |
| `datascriptQuery(query-with-:in, "\"my page\"")` (EDN-quoted) | 1 |

**Verified.** The "0 results" recorded in commit c108174 matches the bare-string case: the original example passed `'my-page'` unquoted. Why strings were once embedded and are now bound with `:in`: [ADR-0013 (strings-bound-via-in-inputs)](docs/adr/0013-strings-bound-via-in-inputs.md), which supersedes ADR-0006.

**Current practice:** string parameters go through `:in`. `LogseqClient.executeDatalogQuery(query, ...inputs)` sends each input as `JSON.stringify(value)` (a JSON string literal is also a valid EDN string literal), and every `DatalogQueryBuilder` method returns `{ query, inputs }`:
```typescript
const { query, inputs } = DatalogQueryBuilder.getPage(pageName); // inputs: [pageName.toLowerCase()]
await client.executeDatalogQuery(query, ...inputs);
// query: [:find (pull ?page [*]) :in $ ?page-name :where [?page :block/name ?page-name]]
```

Pass raw values as inputs. The client does the EDN encoding, so never `JSON.stringify` an input yourself (it would be encoded twice). See constraint 6 for what is still embedded.

---

### 2. Most clojure.string Functions Work; `lower-case` Does Not

| Function | Result |
|---|---|
| `clojure.string/lower-case` | **Error:** `Unknown function 'clojure.string/lower-case` |
| `clojure.string/starts-with?` | Works |
| `clojure.string/includes?` | Works, including on `:block/content` |
| `re-pattern` + `re-find`, e.g. `"(?i)foo"` | Works (case-insensitive matching) |

**Verified.** Lowercase in TypeScript (`pageName.toLowerCase()`) and pass the result as an `:in` input, as in constraint 1. Use `includes?` or `re-find` to filter content inside a query instead of fetching every page's blocks.

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
```typescript
await client.callAPI('logseq.DB.datascriptQuery', [datalogQuery]);
```

**Don't** treat a `null` from `DB.q` as "no results". It usually means the wrong dialect was sent.

**References:**
- Implemented in: `executeDatalogQuery()` in `src/client.ts`

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

Lowercase the name before passing it as an `:in` input, so `getPage('Alice')`, `getPage('alice')` and `getPage('ALICE')` all find `alice` (Pattern 3 below). This matches LogSeq's own UI, which lowercases before lookup. Every builder in `src/datalog/queries.ts` does it.

---

### 6. Don't Embed Strings; Escape Anything You Must

Embedding a string that contains `"` in the query text produces a malformed query:

```
[?p :block/name "foo "bar"]   →  LogSeq API error: Unexpected EOF reading string starting ""]].
```

**Verified.** `JSON.stringify(value)` produces a valid EDN string literal for quotes, backslashes and newlines, and the escaped form runs correctly.

**DO:** pass strings as `:in` inputs (constraint 1). The client does the escaping, and the value is never part of the query text, so there is nothing to inject into. All of `src/datalog/queries.ts` works this way ([ADR-0013 (strings-bound-via-in-inputs)](docs/adr/0013-strings-bound-via-in-inputs.md)).

- Numeric IDs are still embedded, in `ground` vectors, because collection `:in` inputs are unprobed. Build them with `DatalogQueryBuilder.groundIds(ids)`, which throws unless every id passes `Number.isInteger`. Bind the ids straight to the entity variable (`groundIds(ids, '?p')` followed by a pattern on `?p`). `[?p :db/id ?id]` matches nothing, and a query whose only clause is the `ground` binding errors.
- If you ever must embed a string literal, use `JSON.stringify(value)`. A string used inside `re-pattern` also needs regex metacharacters escaped first (#4).

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

**Current practice:** `DatalogQueryBuilder.groundUuids(uuids, '?u')` embeds `#uuid "..."` literals. It throws unless every uuid matches the strict 8-4-4-4-12 hex pattern first, and that pattern rules out quotes, brackets and whitespace, so nothing can escape the literal. Page names for embeds still go through `:in $ [?n ...]` (a string collection works for names), with the or-join head `[?e ?n]`. Block uuids come back from pulls as plain strings. See `DatalogQueryBuilder.refTargets` and `src/utils/resolve-refs.ts`.

---

## Design Patterns

### Pattern 1: Two-Query Pattern for Optional Data

When related data might not exist (pages without blocks, pages without connections), split into separate queries instead of an `or-join` (constraint 3):

1. Query the main entity. If it's absent, throw (page-taking tools throw `PageNotFoundError` through the resolver).
2. Query the related data. An empty result is a valid answer: `(results || []).map(r => r[0])`.

Why, and what it costs: [ADR-0007 (two-query-pattern-for-optional-data)](docs/adr/0007-two-query-pattern-for-optional-data.md).

**Used in:** `buildContextForTopic` in `src/tools/build-context.ts`: page query, blocks query, then linked references via `getPageLinkedReferences`.

---

### Pattern 2: Multi-Query BFS for Graph Traversal

Instead of recursive queries or N sequential API calls, use BFS with one batched query per depth level:

```typescript
let currentFrontier = [rootId];

for (let depth = 1; depth <= maxDepth; depth++) {
  // Query ALL pages at current depth in ONE call
  const { query, inputs } = DatalogQueryBuilder.connectedPages(currentFrontier);
  const results = await client.executeDatalogQuery(query, ...inputs);

  // Process results for next depth
  currentFrontier = extractNewPages(results);
}
```

**Performance:** at most maxDepth + 1 calls, asserted by a unit test. Depth 2 from a hub with ~100 neighbours takes 3 calls, down from ~120.

> **Implemented in `get-concept-network.ts` (#3).** Caps matter: journal pages link to almost everything, and an uncapped depth-2 walk from one hub reached ~550 nodes once outbound links were followed. Defaults are `maxNodes` 50 (root included) and `maxFanout` 15 new pages per page. Journal pages are leaves unless `expandJournals` is set, and `truncated: true` is set whenever a cap bites. MCP clients set them with `max_nodes` (≤ 500), `max_fanout` (≤ 100) and `expand_journals` on `logseq_get_concept_network`. Why every walk is capped: [ADR-0011 (bounded-calls-and-results)](docs/adr/0011-bounded-calls-and-results.md).

**Real implementation:** `DatalogQueryBuilder.connectedPages` and `getConceptNetwork`. When the root has aliases, depth 1 uses `connectedPagesGrouped` instead, so one query covers every name in the alias group (#69). One `or-join` covers both directions (outbound: blocks on the source page that ref another page; inbound: blocks on another page that ref the source). Frontier ids are bound with `groundIds` directly to the entity variable (see constraint 6), and each page pair gets one edge with a reference count.

---

### Pattern 3: Case-Insensitive Lookup

Always lowercase page names in TypeScript before passing them as `:in` inputs, to match `:block/name` (constraints 1, 2 and 5).

**Used in:** `conceptNetwork()`, `getPage()`, `getPageBlocks()` and `getBlocksReferencingPage()` in `src/datalog/queries.ts`.

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
- Redundant tools removed, 13 to 11 (9642558, 34a699a): [ADR-0008 (remove-redundant-tools)](docs/adr/0008-remove-redundant-tools.md). Later work added tools back. There are 15 registered in `src/index.ts` today.
- Oct 2026: a review of 11 LogSeq, Obsidian, Roam, Notion, Tana and Basic Memory MCP servers set the roadmap in GitHub issues #3–#18. Probing the Datalog constraints and measuring API calls against a live graph (`scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`) corrected constraints 1, 2 and 4.

### Lessons Learned

1. **LogSeq's Datalog ≠ standard DataScript.** Probe before concluding something "doesn't work": the original conclusions on `:in` and `clojure.string` were over-generalized from a single failing case (constraints 1 and 2, ADR-0013).
2. **Simple is better.** Two queries that always work beat one query that sometimes works. No clever `or-join` tricks (Pattern 1, ADR-0007).
3. **Test with real data.** Property-style tests against a live graph found the empty-page and case-sensitivity bugs (Testing Philosophy, below).
4. **Feature flags added complexity.** They maintained dual implementations and were eventually removed in favor of simplicity: one direct Datalog path (ADR-0005).

---

## Common Gotchas

Quick reference checklist for future work:

**Queries**
- [ ] Pre-lowercase page names before passing them to queries
- [ ] Pass strings as `:in` inputs, never embedded in the query text. Pass raw values: `executeDatalogQuery` EDN-encodes them (a bare string would be read as a symbol).
- [ ] Embed numeric IDs only through `DatalogQueryBuilder.groundIds`, which checks `Number.isInteger`
- [ ] Don't use `clojure.string/lower-case`. `includes?`, `starts-with?`, `re-pattern` and `re-find` work.
- [ ] Split queries when data might be empty (don't rely on or-join with ground nil)
- [ ] Send Datalog to `logseq.DB.datascriptQuery`. `logseq.DB.q` takes the simple query DSL and returns `null` for Datalog.
- [ ] Handle empty arrays from queries gracefully (`(results || [])`)
- [ ] Page names in `:block/name` are lowercase, not original casing
- [ ] Use `[(ground [id1 id2 id3]) [?id ...]]` for batch queries
- [ ] Never crawl `getAllPages` + one call per page (Pattern 4)
- [ ] `:with` can't name a variable that's also aggregated in `:find` (error: `:find and :with should not use same variables`)
- [ ] Match `:block/uuid` with `#uuid "..."` literals via `groundUuids`; strings never match (constraint 7)
- [ ] Remember: LogSeq Datalog ≠ Standard DataScript

**Data shapes** (verified by `scripts/probe-constraints.ts`)
- [ ] `:block/journal-day` is an integer `YYYYMMDD` (e.g. `20260422`). Parse its digits; never pass it to `new Date()`.
- [ ] Blocks with a scheduled/deadline date also carry `:block/journal-day`. A query for journal pages must require `[?page :block/name]`, or those blocks match as duplicate "pages" for the same day.
- [ ] `logseq.Editor.getBlock` returns `page` and `parent` as bare `{id}` objects. Resolve them; don't expect names.
- [ ] `:block/path-refs` includes refs inherited from ancestor blocks. Use it for "anything under a block tagged X".
- [ ] A nested pull works on refs: `(pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])` returns each ref as a page map in the same call (`query_by_date_range` uses it for `topConcepts`). A ref to a block (`((uuid))`) has no `name`, and journal pages carry `journal?` true and `journal-day`.
- [ ] `:block/updated-at` is missing on some pages (roughly 1 in 10 pages lacked it in testing). Use `get-else` with a default.
- [ ] Many pages are empty link targets with no blocks or file. Test with them.
- [ ] Resolve page names with `requirePage`, not `getPage`: [BR-0010 (page-names-resolved-via-resolver)](docs/business-rules/0010-page-names-resolved-via-resolver.md)
- [ ] An alias group is the pages that name one thing (#69). `alias:: x` stores `:block/alias` in **both directions** between the declaring page and the stub `x`, and LogSeq keeps a group of three or more as a **clique** (every page links every other), with no self-links. A reference points at whichever page entity the block named, so `[[Jordan]]` and `[[Jordan Rivera]]` are refs to different pages. Any tool that follows links to a page must use the whole group: `resolveAliasSet(s)` in `src/utils/alias-set.ts` (one Datalog query for any number of pages, two hops, bound with `groundIds`; it makes no call for a page whose pulled entity has no `alias` key, which relies on the symmetry above). Don't write the same variable twice in one pattern to test for a self-link (`[?p :block/alias ?p]` matched every link). A runaway query blocks LogSeq's HTTP API until it finishes, so bind every variable in a new `or-join` before running it. `getPageLinkedReferences` spans the group for the declaring page but not exactly for the stub (a few ids differ), which is why the aliased path uses `linkedReferencesOfPages` (same block set as the Editor call for the declaring page, symmetric for every name). A tool that unions names reports them as `resolvedAliases` (original case, sorted; in `meta` for a bare-array result, keyed by topic in `search_by_relationship`), absent when the page has no aliases. Re-run the probe after LogSeq upgrades: its "must be 0" lines are what the resolver assumes.
- [ ] `:block/properties` is a map keyed by **keywords**, lowercase and dashed. `[(get ?props ?key) ?v]` needs a keyword: a string key, or a string `:in` input, matches nothing. Build it with `[(keyword ?key) ?kw]` from a string `:in` input. The Editor API returns the same keys camelCase.
- [ ] A property value is a string, number or boolean, or an array (a set) for multi-value properties and page refs. `(str ?v)` of a set is `#{...}`, so match scalars with `str` and set elements with `contains?`. `string?`, `coll?`, `seq` and `clojure.string/join` are unavailable.
- [ ] Page entities and their first (pre-)block both carry `:block/properties`. Require `[?b :block/page]` to get blocks only.

**HTTP API behaviour** (verified)
- [ ] An unknown method returns **HTTP 200** with body `{"error": "MethodNotExist: ..."}`. Always check the body; `client.ts` does.
- [ ] A bad token returns HTTP 401. `client.ts` maps it to `LogSeqAuthError` (the message never contains the token).
- [ ] A hung request is aborted after `timeoutMs` (config field, default 30000, applied per `callAPI` call) and surfaces as `LogSeqTimeoutError`.
- [ ] `logseq.Editor.getEditingBlockSelection` doesn't exist. Use `getSelectedBlocks`, which returns `null` when nothing is selected.
- [ ] Without `includeChildren`, Editor API blocks carry `children` as unfetched `["uuid", "<id>"]` tuples, not block entities. `getCurrentPage` can return `null` while `getCurrentBlock` returns a block, or return a block when zoomed in. `get_current_context` handles all three.

**Tool behaviour**
- [ ] Don't turn errors into empty results; re-throw infrastructure errors: [BR-0003 (infrastructure-errors-propagate)](docs/business-rules/0003-infrastructure-errors-propagate.md)
- [ ] Never cut results silently; any cap reports `ResultMeta`: [BR-0006 (no-silent-truncation)](docs/business-rules/0006-no-silent-truncation.md)
- [ ] `null` from an API call is not `[]`: [BR-0011 (null-is-not-empty)](docs/business-rules/0011-null-is-not-empty.md)
- [ ] `resolve_refs` is opt-in and non-lossy; one resolver, `resolveBlockRefs`: [BR-0007 (resolve-refs-non-lossy)](docs/business-rules/0007-resolve-refs-non-lossy.md)
- [ ] Guidance for the model (#44) lives outside the tools. Server `instructions` are in `src/instructions.ts`. Next-step tips: [BR-0009 (tips-are-advisory)](docs/business-rules/0009-tips-are-advisory.md). Parameter aliases: [BR-0008 (param-aliases-best-effort)](docs/business-rules/0008-param-aliases-best-effort.md). Every tool description needs a "Can't find" line ([ADR-0015 (tool-descriptions-state-limits)](docs/adr/0015-tool-descriptions-state-limits.md)).
- [ ] Prompts and resources (#46) live in `src/prompts.ts` and `src/resources.ts`; `index.ts` only declares the capabilities and calls `registerPrompts` and `registerResources`. Both are read-only. A prompt returns one short user message naming the tools to call, defers to the `logseq-skills` workflow rather than copying it, quotes any argument it embeds, and rejects unknown or malformed arguments as `InvalidParams`. Tests check that a prompt names only existing tools, so a tool rename fails them. `serverInfo.version` is read from `package.json` (`src/version.ts`), and a test keeps `.claude-plugin/plugin.json` on the same version.
- [ ] Publishing (#46) is manual: `.github/workflows/publish.yml` runs only on `workflow_dispatch`, needs the `NPM_TOKEN` secret, and defaults to a dry run. Never publish, tag or release from a session. Why: [ADR-0017 (manual-npm-publish)](docs/adr/0017-manual-npm-publish.md).
- [ ] Slim output is the default: [BR-0012 (slim-output-default)](docs/business-rules/0012-slim-output-default.md)
- [ ] Output format (#43). `get_page`, `get_block`, `build_context`, `get_context_for_query` and `get_concept_network` take `format: "json" | "markdown"` (default `json`, unchanged). Markdown is one plain text content block, not JSON-escaped, rendered by the one shared renderer in `src/utils/markdown.ts` (`markdown-context.ts` for the context and network tools). `logseq://page/{name}` renders through the same `renderPage`: never add a second renderer. Layout: page properties as `key:: value` (the page's pre-block text verbatim when the tree has one, so `[[refs]]` and hyphenated keys survive; only when there is no pre-block does `renderProperties` rebuild them from the map: kebab-case keys, multi-value as `[[a]], [[b]]`; never rewrite a pre-block), blocks as tab-indented `- ` bullets, `((uuid))` refs untouched, `resolvedContent` on a `[resolved]` line under its block, related pages as `[[links]]`, references grouped by source page, and a footer after `---` for `warnings`, `hasMore` and tips (tips ride in the footer, not a second content block). Full Markdown omits block uuids on purpose (they bloat every bullet; `compact` adds them), with one exception: keyword search hits in `get_context_for_query` always end with `((uuid)) (in [[Page]])`, since for a query with no topic they are the whole answer and would otherwise be a dead end. That needs one extra batched page query, made only for `format: "markdown"` (`hitPages`). An ambiguous name stays a structured JSON result in both formats; errors stay JSON `{error}`. `format` and `compact` are parsed at the boundary (`parseFormat`, `parseCompact`) and reject bad values with `InvalidParameterError`. Markdown renders the full result, uncapped except the resource's `MAX_PAGE_CHARS`.
- [ ] `compact` (#43) exists on `build_context` and `get_context_for_query` only: block bodies become a first-line snippet (`firstLineSnippet`, 80 characters) plus the block's `((uuid))`; in JSON a block is `{ uuid, snippet }` and pages are `{ id, name, originalName }` (`src/utils/compact.ts`). `summary`, `totals`, `warnings` and `hasMore` stay. It is off for `get_page` and `get_block` (the outline tool covers that), and for `get_concept_network`, which already carries no bodies. Compact skips `resolve_refs`, and `build_context` says so with a `resolve_refs_ignored_in_compact` warning (resolving would put the bodies back and defeat compact; the warning names `compact: false` and `get_block` as the ways to get resolved text). `get_context_for_query` has no `resolve_refs`. For blocks shorter than the uuid, compact can be larger than the full markdown; it pays off on long blocks.
- [ ] `logseq_get_page_outline` (#43): top-level `{ uuid, snippet, childCount }` (direct children only), in two calls. The query (`DatalogQueryBuilder.pageOutlineBlocks`) binds the resolved page id and returns the top-level blocks plus their direct children in one `or-join`; the tool counts children per parent in TypeScript and orders siblings by the `:block/left` chain. Capped at `MAX_OUTLINE_BLOCKS` (200) with an `outline_truncated` warning and no `howToFetchAll` (an outline cannot be paged; `hasMore` stays false). It is the step before `get_block` in the server `instructions`.
- [ ] Tool results are minified JSON (`JSON.stringify(result)` with no spacing argument). `src/index.minified.test.ts` fails if any handler adds layout whitespace. `format: "markdown"` is the opt-in plain text exception (#43). Pretty output would need an opt-in parameter and an exemption there. Why: [ADR-0009 (minified-json-output)](docs/adr/0009-minified-json-output.md).
- [ ] Never write to stdout (`console.log`, `console.info`, `console.debug`, `process.stdout`). It's the MCP stdio channel; log with `console.error`. `src/no-stdout.test.ts` fails on any hit in non-test `src/` files (#82). Never log graph data either: [ADR-0004 (stderr-only-logging)](docs/adr/0004-stderr-only-logging.md).

---

## Testing Philosophy

### Property-Based Testing
Tests work with ANY LogSeq graph without requiring specific test data.

**Pattern:**
```typescript
// Discover pages dynamically
const pages = await discoverPages(client, 5);

// Test universal properties
for (const page of pages) {
  const result = await getConceptNetwork(client, page.name, 2);

  // Property: All nodes should have IDs
  expect(result.nodes.every(n => n.id)).toBe(true);

  // Property: Root node always at depth 0
  expect(result.nodes.find(n => n.depth === 0)).toBeDefined();
}
```

**Benefits:**
- No test data setup required
- Tests real-world scenarios
- Discovers edge cases (empty pages, special characters)
- Works across different LogSeq databases

**Test Categories:**
- **Unit tests** (`npx vitest run src`, 181 as of Oct 2026): Query builders, data transformations, mocked clients
- **Integration tests** (`npm run test:integration`, 60 as of Oct 2026, with real LogSeq): API connectivity, actual graph queries
- Note: `npm test` runs **both** suites (the default vitest config doesn't exclude `tests/integration/`), so it needs a running LogSeq
- **Property tests**: Universal invariants, equivalence validation

### Integration Test Requirements (Hard Failures)

Integration tests must fail loud on BOTH setup issues AND missing test data.

**Rules:**
1. **NO it.skipIf() for integration tests** - Tests must run or fail, never skip
2. **NO console.warn() in tests** - Silent warnings hide real failures
3. **REQUIRE prerequisites explicitly** - Config file, LogSeq connection, test data
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

// ✅ GOOD: Fail loud with clear message
beforeAll(async () => {
  try {
    await access(configPath);
  } catch {
    throw new Error(
      'Config file not found at ~/.logseq-mcp/config.json. ' +
      'See tests/integration/setup.md for setup instructions.'
    );
  }
});

it('test', async () => {
  const result = await searchBlocks(client, 'test');
  expect(result).toBeDefined();
  expect(result.length).toBeGreaterThan(0,
    'No pages found. Create test data in LogSeq graph. ' +
    'See tests/integration/setup.md'
  );
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
npx tsx scripts/measure-output-size.ts          # output size, slim vs full (#42), markdown and compact vs json (#43); bytes only, no names
```

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
│   └── output-format.ts           - parseFormat / parseCompact
└── types.ts                       - TypeScript interfaces

tests/
├── integration/                   - Tests against real LogSeq
│   └── properties/                - Property-based tests
└── [unit test files]              - Mocked tests (co-located in src/)

scripts/
├── probe-constraints.ts           - Verifies the Datalog/API constraints against a live graph
├── measure-api-calls.ts           - Counts API calls per tool against a live graph
└── measure-output-size.ts         - Output bytes per tool, slim vs full and markdown/compact vs json, through the MCP server

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
# Run all tests (unit + integration; integration needs a running LogSeq)
npm test

# Run unit tests only
npx vitest run src

# Run specific test file
npx vitest run src/tools/build-context.test.ts

# Build the project
npm run build

# Test against real LogSeq (requires running instance)
npm run test:integration

# Verify Datalog/API constraints against the live graph (read-only)
npx tsx scripts/probe-constraints.ts

# Count API calls per tool against the live graph (read-only)
npx tsx scripts/measure-api-calls.ts

# Output size per tool: slim vs full, markdown and compact vs json (read-only; prints byte counts only)
npx tsx scripts/measure-output-size.ts

# Debug Datalog query
npx tsx scripts/test-datalog-query.ts
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
   - Use property-based testing if possible
   - Fail loud if no real data is available (never skip; see Integration Test Requirements)

5. **Documentation** - Update MCP tool handler in `src/index.ts`
   - Give the tool `annotations: readOnlyAnnotations('Title')` (a guard test in `src/index.test.ts` fails without it). Every tool is read-only: [BR-0002 (tools-read-only)](docs/business-rules/0002-tools-read-only.md)

6. **Measure** - Add the tool to `scripts/measure-api-calls.ts` and record its call count in "Current Implementation Status"

7. **Tool-list guardrails** - `src/tool-list.test.ts` checks the `tools/list` payload ([ADR-0016 (tool-list-size-guardrails)](docs/adr/0016-tool-list-size-guardrails.md))
   - Size budget: `TOOL_LIST_BUDGET_CHARS` (~15% headroom over the size measured when it was added). If your tool or parameters push past it, trim first. If the growth is worth it, raise the constant and justify it in the PR description.
   - Description cap: 400 characters per tool. A new tool gets no allowance. Existing long descriptions are listed in `DESCRIPTION_ALLOWANCES` and may shrink but not grow. Delete an entry once its tool fits the cap.
   - Snapshot: any change to a name, title, annotation, description or input schema fails the snapshot test. Review the diff, then run `npx vitest run src/tool-list.test.ts -u` and commit `src/__snapshots__/tool-list.test.ts.snap`.

---

## References

- **LogSeq HTTP API:** http://127.0.0.1:12315/api (default)
- **DataScript Docs:** https://github.com/tonsky/datascript (note: LogSeq subset only)
- **Decisions and rules:** [`docs/adr/`](docs/adr/README.md) (why we chose X) and [`docs/business-rules/`](docs/business-rules/README.md) (what must stay true). The Datalog migration is recorded in [ADR-0002 (datalog-over-editor-api)](docs/adr/0002-datalog-over-editor-api.md) and [ADR-0005 (datalog-only-no-feature-flags)](docs/adr/0005-datalog-only-no-feature-flags.md).
- **Example Scripts:** `scripts/test-datalog-query.ts`
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

When a constraint seems to block you, re-run `scripts/probe-constraints.ts` before working around it.

When in doubt, look at `src/datalog/queries.ts` for working patterns and `src/tools/build-context.ts` or `src/tools/get-concept-network.ts` for implementation examples.
