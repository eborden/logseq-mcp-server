# LogSeq Datalog: constraints, patterns and history

Reference for anyone writing or changing a query. It moved here from `CLAUDE.md` word for word; the `datalog-queries` skill (`.claude/skills/datalog-queries/SKILL.md`) holds the checklist and points here.

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

**Verified.** The "0 results" recorded in commit c108174 matches the bare-string case: the original example passed `'my-page'` unquoted. Why strings were once embedded and are now bound with `:in`: [ADR-0013 (strings-bound-via-in-inputs)](adr/0013-strings-bound-via-in-inputs.md), which supersedes ADR-0006.

**Current practice:** string parameters go through `:in`. `LogseqClient::execute_datalog_query(query, inputs)` (`src/client.rs`) sends each input as its JSON text (a JSON string literal is also a valid EDN string literal), and every query builder returns a `Query { text, inputs }` (`src/edn.rs`). An input is a `DatalogInput`, a type that says what the value means, and a `PageName` is lowercase by construction:
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

**DO:** split into separate queries (Pattern 1 below): the page first, failing if it's absent, then its blocks, where an empty array is a valid answer. The decision: [ADR-0007 (two-query-pattern-for-optional-data)](adr/0007-two-query-pattern-for-optional-data.md).

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
- Implemented in: `LogseqClient::execute_datalog_query` in `src/client.rs`

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

Lowercase the name before passing it as an `:in` input, so a lookup for `Alice`, `alice` or `ALICE` finds `alice` (Pattern 3 below). This matches LogSeq's own UI, which lowercases before lookup. `PageName::new` (`src/edn.rs`) does it, and the query builders take a `PageName`, not a string, so none can skip it.

---

### 6. Don't Embed Strings; Escape Anything You Must

Embedding a string that contains `"` in the query text produces a malformed query:

```
[?p :block/name "foo "bar"]   →  LogSeq API error: Unexpected EOF reading string starting ""]].
```

**Verified.** A JSON string literal (what `serde_json` writes, and `JSON.stringify` in the scripts) is a valid EDN string literal for quotes, backslashes and newlines, and the escaped form runs correctly.

**DO:** pass strings as `:in` inputs (constraint 1). The client does the escaping, and the value is never part of the query text, so there is nothing to inject into. Every `queries.rs` in `src` works this way ([ADR-0013 (strings-bound-via-in-inputs)](adr/0013-strings-bound-via-in-inputs.md)).

- Numeric IDs are still embedded, in `ground` vectors, because collection `:in` inputs are unprobed. Build them with `ground_ids(&ids, "?p")` (`src/edn.rs`), which takes `PageId`s: a `PageId` is only ever a positive whole number, so nothing else can reach the query text. Bind the ids straight to the entity variable (`ground_ids(&ids, "?p")` followed by a pattern on `?p`). `[?p :db/id ?id]` matches nothing, and a query whose only clause is the `ground` binding errors.
- If you ever must embed a string literal, write it with `serde_json::to_string`. A string used inside `re-pattern` also needs regex metacharacters escaped first (`src/escape.rs`, #4).

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

**Current practice:** `ground_uuids(&uuids, "?u")` (`src/edn.rs`) embeds `#uuid "..."` literals. It takes `BlockUuid`s, and `BlockUuid::parse` accepts only the strict 8-4-4-4-12 hex pattern (any case, stored lowercase), which rules out quotes, brackets and whitespace, so nothing can escape the literal. Page names for embeds still go through `:in $ [?n ...]` (a string collection works for names), with the or-join head `[?e ?n]`. Block uuids come back from pulls as plain strings. See `ref_targets` in `src/resolve_refs/queries.rs` and `src/resolve_refs/mod.rs`.

---

## Design Patterns

### Pattern 1: Two-Query Pattern for Optional Data

When related data might not exist (pages without blocks, pages without connections), split into separate queries instead of an `or-join` (constraint 3):

1. Query the main entity. If it's absent, fail (page-taking tools return `ToolError::PageNotFound` through the resolver).
2. Query the related data. An empty result is a valid answer: an empty `Vec`, not an error. (`null` is its own case, BR-0011.)

Why, and what it costs: [ADR-0007 (two-query-pattern-for-optional-data)](adr/0007-two-query-pattern-for-optional-data.md).

**Used in:** `src/tools/explore_context/mod.rs`: page query, blocks query, then linked references via `logseq.Editor.getPageLinkedReferences`.

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

**Performance:** at most max_depth + 1 calls, asserted by a call-count test (`tests/concept_calls.rs`; the path with `to` has `tests/network_path_calls.rs`). Depth 2 from a hub with ~100 neighbours takes 3 calls, down from ~120.

> **Implemented in `src/tools/explore_network/` (#3).** Caps matter: journal pages link to almost everything, and an uncapped depth-2 walk from one hub reached ~550 nodes once outbound links were followed. The walk holds at most 500 pages (`MAX_NODES_LIMIT`), `max_nodes` (default 50, root included) is the size of a page of it and is read to the end with `cursor` (#556), and `max_fanout` is 15 new pages per page. Journal pages are leaves unless `expand_journals` is set, and `truncated: true` is set whenever a rule of the walk (`max_fanout` or the limit of 500) left a page out. Roll-up pages are leaves too (#498): a page that links more than 30 distinct pages (`HUB_LINKS`) ranks after every other page, is not walked through unless `expand_journals` is set, and is named in a `hub_pages_not_expanded` warning when a depth was left to walk it. The count comes from the same query as the links (a `degree` row per pair, with `count-distinct`, no call of its own); a page that links nothing has no such row, which reads as 0. MCP clients set the page size with `max_nodes` (≤ 500), the rules of the walk with `max_fanout` (≤ 100) and `expand_journals`, and read the next page with `cursor`, on `logseq_explore_network`, which refuses the first three with `to` (the path is one page after another, so they have nothing to bound), and `with_snippets` for the first line of a linking block on each edge of the root. Why every walk is capped: [ADR-0011 (bounded-calls-and-results)](adr/0011-bounded-calls-and-results.md).

**Real implementation:** `connected_pages` (`queries.rs`) and `explore_network` (`mod.rs`) in `src/tools/explore_network/`. With `to`, `explore_path` (`path.rs`) runs the same BFS from every name of the first page without the caps, stops at the first hop that reaches a name of the second and reads the path back through the page each page was reached through (a page that is no journal, then more references, then the lower id, among paths of one length). When the root has aliases, depth 1 uses `connected_pages_grouped` instead, so one query covers every name in the alias group (#69). One `or-join` covers both directions (outbound: blocks on the source page that ref another page; inbound: blocks on another page that ref the source). Frontier ids are bound with `ground_ids` directly to the entity variable (see constraint 6), and each page pair gets one edge with a reference count.

---

### Pattern 3: Case-Insensitive Lookup

Always lowercase page names before passing them as `:in` inputs, to match `:block/name` (constraints 1, 2 and 5). A `PageName` does it by construction, so build one and pass it on.

**Used in:** every query builder that takes a page name (the `queries.rs` files under `src/tools/` and `src/resolve/`).

**Also case-insensitive:** `find_blocks` matches `:block/refs` for `links_to` (and `:block/page` for `page`) by the ids of the resolved pages, whatever the casing of the names (#7, #492), and uses a `(?i)` regex for its `text` (#4).

---

### Pattern 4: No Per-Page Crawls

Never call `logseq.Editor.getAllPages` and then make one call per page. On a ~2k-page graph, `query_by_property` (now `find_blocks` with a property) used to make ~2k calls (one per page) and take ~10s this way (#33). <!-- guard:history query_by_property -->

Use one Datalog query, filtering in the query with `includes?` / `re-find` / `get` / `contains?`, or batched queries with `[(ground [ids...]) [?id ...]]`. No tool crawls any more. The decision: [ADR-0002 (datalog-over-editor-api)](adr/0002-datalog-over-editor-api.md).

---

## Migration History

The history and the reasons are in the ADRs ([index](adr/README.md)):

- Editor API crawls (O(n) calls), then batched Datalog: [ADR-0002 (datalog-over-editor-api)](adr/0002-datalog-over-editor-api.md)
- A feature-flagged dual HTTP/Datalog implementation, replaced by Datalog only (df7503a, 37fe0d6): [ADR-0005 (datalog-only-no-feature-flags)](adr/0005-datalog-only-no-feature-flags.md)
- Strings embedded in query text, later bound with `:in` once probing showed it works: [ADR-0006](adr/0006-embed-strings-in-datalog-queries.md), superseded by [ADR-0013 (strings-bound-via-in-inputs)](adr/0013-strings-bound-via-in-inputs.md)
- Pages without blocks, fixed by splitting queries (d6c3151): [ADR-0007 (two-query-pattern-for-optional-data)](adr/0007-two-query-pattern-for-optional-data.md)
- Redundant tools removed, 13 to 11 (9642558, 34a699a): [ADR-0008 (remove-redundant-tools)](adr/0008-remove-redundant-tools.md). Later work added tools back. There are 10 registered in `src/tools/mod.rs` today.
- A Rust implementation beside the TypeScript server (ADR-0025, ADR-0031, #122), held to its results byte for byte, then the TypeScript server removed after the Go on #349 (#356, last version at `35fa2dd3`)
- Oct 2026: a review of 11 LogSeq, Obsidian, Roam, Notion, Tana and Basic Memory MCP servers set the roadmap in GitHub issues #3–#18. Probing the Datalog constraints and measuring API calls against a live graph (`scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`) corrected constraints 1, 2 and 4.

### Lessons Learned

1. **LogSeq's Datalog ≠ standard DataScript.** Probe before concluding something "doesn't work": the original conclusions on `:in` and `clojure.string` were over-generalized from a single failing case (constraints 1 and 2, ADR-0013).
2. **Simple is better.** Two queries that always work beat one query that sometimes works. No clever `or-join` tricks (Pattern 1, ADR-0007).
3. **Test with real data.** Property-style tests against a live graph found the empty-page and case-sensitivity bugs. The fixture graph now holds those cases, so the tests assert them exactly (`CLAUDE.md`, Testing Philosophy).
4. **Feature flags added complexity.** They maintained dual implementations and were eventually removed in favor of simplicity: one direct Datalog path (ADR-0005).
