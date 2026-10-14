# Page every cut result with one forward-only opaque cursor

## Context

A tool that cuts a result says so with a warning, but the way on differs per tool, and for some tools there is none (#528, parent of the work below). A survey of the 10 tools on `main`:

| Tool | Cut by | Way on today | Unit |
|---|---|---|---|
| `find_blocks` | `limit`, then the 30,000-character budget | `offset` | hit |
| `find_pages` | `limit`, then the budget | `offset` | page |
| `explore_timeline` | `max_blocks`, then the budget | a new `start_date` (a day cut mid-way repeats its kept blocks) | nested block |
| `explore_context` | `max_blocks`, `max_references`, `max_related_pages`, then the budget | `references_offset`, for references only | reference |
| `explore_network` | `max_nodes`, `max_fanout`, `max_depth`, then the budget | none, only a raise of a cap | page |
| `get_page` with `detail: "full"`, `get_block` with `include_children` | the budget only | none | nested block |
| `get_page` with `detail: "outline"` | 200 top-level blocks, then the budget | none | top-level block |
| `get_current`, `check_links` | the budget, on one list each | none | selected block, resolved ref |

So there are four mechanisms (`offset`, `references_offset`, moving a date, nothing). A made-up page with 90 top-level blocks of about 1,000 characters returns about 28 of them, and blocks 29 to 90 can't be read by any call. A block with 60 children returns the first 25 and the other 35 have no way on. The outline stops at its first 200 blocks. Since #507 the warnings of these tools carry no `howToFetchAll`, and `hasMore` stays false.

The code pays for the variety. Each paged tool measures whether a raise of its cap "fits" before it may offer it (`raise_only_if_it_fits`, `offer_related_raise_only_if_it_fits`, `network_truncated_then_cut_by_size`, the `Raise` types of `find_blocks` and `find_pages`, and the date wordings of `explore_timeline/cap.rs`), because a raise that would only be cut again is a false promise (BR-0006). The summary prompts in `rust/src/prompts.rs` carry paragraph-long instructions for paging the timeline by dates.

Positions this decision meets:

- [BR-0002 (tools-read-only)](../business-rules/0002-tools-read-only.md) says "The server keeps no hidden progress and no cursor ... If a tool needs paging, it uses explicit `limit` and `offset` parameters rather than a server-side cursor." The foundations doc, 4.4 and 4.5, says the server holds no state between calls and allows a cache only with a measured reason, one owner, and a correct slower server without it.
- [ADR-0012 (resultmeta-for-capped-results)](0012-resultmeta-for-capped-results.md) and [BR-0006 (no-silent-truncation)](../business-rules/0006-no-silent-truncation.md) make `hasMore` true only when a warning's `howToFetchAll` names a parameter to raise, with `offset` as the one paging exception.
- [ADR-0037 (tool-taxonomy-get-find-explore-check)](0037-tool-taxonomy-get-find-explore-check.md) names `limit` and `offset` as the paging vocabulary of every `find` tool and lists `references_offset` on `explore_context`. v2.0.0 is unreleased and ADR-0037 is the hard cut, so these parameters can still change.
- [ADR-0011 (bounded-calls-and-results)](0011-bounded-calls-and-results.md) and #485 bound each result in characters. That stays.
- The maintainer does not want a second or third pagination implementation, so adding `offset` to trees on its own is out.

Options considered:

| Option | Pros | Cons / cost |
|---|---|---|
| Keep each tool's way on and add `offset` to trees | Smallest change | A third unit for trees (an index into a tree that can change between calls) and a fifth mechanism. The cap-raise logic stays |
| One `offset` with a unit per tool kind | Stays inside BR-0002 and ADR-0037 | A position in a list that moves, with no way to notice. Each page repeats page 1's calls. Trees, days and sections each still need their own unit and wording |
| An opaque cursor with no cache | No server state | Every page repeats page 1's LogSeq calls and may see a changed graph. The call ceilings (ADR-0034) hold per page, but nothing is saved |
| An opaque cursor with a snapshot cache (chosen) | One mechanism for every cut list. A later page costs 0 LogSeq calls and is consistent with the pages before it. Correct without the cache, only slower | The server holds state: a bounded cache that can be rebuilt. BR-0002 and the foundations doc say otherwise today |

## Decision

We page every cut list with one forward-only opaque cursor, built once and shared by the tools. The design was agreed with the maintainer on 2026-10-13 (comment on #528).

**Contract.**
- Every paged tool takes an optional `cursor` and returns `nextCursor`, absent on the last page. A call with `cursor` takes no other argument: the arguments are in the token.
- Forward only. No previous, first or last.
- `hasMore` is true exactly when `nextCursor` is present, and `howToFetchAll` says to pass it.
- `offset` (`find_blocks`, `find_pages`) and `references_offset` (`explore_context`) are removed in v2.0.0, which is unreleased. This changes the vocabulary ADR-0037 set. The count caps (`limit`, `max_blocks`, `max_references`, `max_related_pages`, `max_nodes`) stay, as the page size.

**Model.** Every tool already builds its whole bounded result before it cuts it. That result is an ordered list of entries with stable ids. A page is the slice from the cursor's position that fits both the count cap (now a page size) and the 30,000-character budget (`budget::fit`, given a start position). Page 1 is today's result plus `nextCursor`.

| Tool | Entries, in order | Page size |
|---|---|---|
| `find_blocks` | hits, newest first | `limit` |
| `find_pages` | pages | `limit` |
| `get_page` full, `get_block` | blocks in document order. A page that starts mid-tree names the ancestor path | the budget |
| `get_page` outline | top-level blocks | 200 |
| `explore_timeline` | days, and the blocks within each | `max_blocks` |
| `explore_context` | blocks, then references, then related pages | `max_blocks`, `max_references` and `max_related_pages` as each section's share. 0 leaves a section out |
| `explore_network` | pages by depth, then rank, each with its edges to pages already sent | `max_nodes`. The walk runs to 500 pages |

Not paged: `explore_network` with `to` (at most 4 pages), `get_graph`, and `get_current` and `check_links`, which keep today's cut. In `explore_network`, `max_depth`, `max_fanout` and `expand_journals` still decide what is in the walk, and `truncated` still means a rule left pages out.

Page 1 of `explore_network` equals today's result for the same arguments, apart from the cursor and warning fields. It should: `select_candidates` ranks the candidates of each depth and then truncates to the node budget, so a walk allowed to reach 500 pages has today's result as a prefix. The depth labels are recomputed over the links among the kept pages (`relabel_depths`), which are the same links. A test on the hub fixture, written before the walk changes, pins the nodes, edges and depths. If it can't hold, that PR stops and asks.

**Token.**
- base64url (`base64` crate, `URL_SAFE_NO_PAD`, the 0.22 that `reqwest` already pulls in, declared directly) of a versioned payload: the tool, its arguments, the position, the id of the last entry sent and a snapshot key. The arguments are stored as resolved: a period given as `last_n` or `preset` is stored as its start and end dates, so a rebuild after midnight reads the same window.
- No HMAC. Nothing in the token is trusted unchecked (the arguments are parsed again by `parse_args`, the position is bounds-checked), and every tool is read-only.
- No hand-rolled encoding or hashing. No new crates.
- An unknown version, or a payload that doesn't parse, is `InvalidParameter` before any LogSeq call.

**Snapshot cache.**
- The first call keeps its full result in a bounded per-process cache (least-recently-used, capped in bytes, with a time limit), keyed by a counter and the process start time, so a restarted server never reuses a key a client still holds. A later page served from the cache costs 0 LogSeq calls and is consistent with the pages before it. A step a tool runs after the cut (`include_context` on `find_blocks`, `resolve_refs` on `explore_timeline` and `explore_context`) still runs for the entries of that page.
- On a cache miss the tool makes the same calls as page 1, so no call ceiling rises. It then checks the anchor: the id of the last entry sent must sit just before the position. If it doesn't, the tool resumes after the anchor (or at the position if the anchor is gone) with a `cursor_stale` warning (BR-0006).
- A change that swaps one entry before the position for another, keeping the count, goes undetected. A hash of the ids before the position in the token would catch it. `sha2` is the fallback if that turns out to matter, and it is not in `Cargo.lock`, so it would be a new dependency to vet (foundations, 4.10). `std::hash::DefaultHasher` is the standard-library alternative.
- The cache holds at most 16 snapshots and 32 MiB in all, never keeps one over 8 MiB (a larger one is served by the miss path), and drops a snapshot 10 minutes after its last use. These are starting values, to be checked in the cursor core PR against the sizes of a long page and a 500-hit search on the fixture instance, and tuned like any cap (ADR-0011) without a new ADR.
- The tool is correct without the cache, only slower.

**Removed.** `raise_only_if_it_fits`, `offer_related_raise_only_if_it_fits`, `network_truncated_then_cut_by_size`, the `Raise` logic, and every "No parameter raises this limit" line. Once a result of any size can be read in pages, a cap raise can always be offered, and the warning of a cut list offers the cursor first.

## Consequences

- Easier: a tree or any list larger than the budget is read to the end by repeated calls, with no tool left without a way on. One mechanism, one implementation, one wording of the warning. The cap-raise measuring code goes, and so does the timeline's date paging in the summary prompts.
- Harder: the server keeps state for the first time. The cache is separate, has one owner (the server) and one invalidation (the limits above), and can be rebuilt, which is what the foundations doc's balance clause asks. Its age is bounded by the 10-minute limit, and a rebuild that finds the list changed says so with `cursor_stale`.
- Every paged tool changes its contract in the same release (v2.0.0, unreleased): `cursor` and `nextCursor` are new, and `offset` and `references_offset` go. ADR-0037 is the decision that allows a removal and the v2.0.0 release note (#499) is the migration note, as BR-0004 and ADR-0020 require. Each tool's PR changes goldens (`nextCursor`, the warning text, new cursor-miss cases and their call ceilings), so each needs the maintainer's `golden-change` label.
- Calls: page 1 makes today's calls, so no ceiling rises. A miss makes page 1's calls. A hit makes none, plus the after-the-cut steps above. `explore_network` makes the same number of queries, but its frontier is larger, so each returns more rows: measure latency in its PR.
- Tool-list size (ADR-0016): `cursor` is about 100 characters on 7 tools (`get_page`, `get_block`, `find_blocks`, `find_pages`, `explore_context`, `explore_timeline`, `explore_network`), against the three removed `offset` parameters at about 145 each. The net is a few hundred characters on a 14,500-character list. Each PR measures it against the budget, and #499 sets the v2 budget.
- What this ADR does not decide, left to the cursor core PR and the maintainer: how a cursor call with no `page` or `uuid` sits with BR-0008 (a canonical name stays `required` only where an alias exists), and whether a rule-made omission such as the `max_fanout` raise offer still counts as "more" for `hasMore`.
- Relation to existing records, none reworded here:
  - ADR-0037 stays `accepted`. Its `limit` and `offset` vocabulary and the `references_offset` entry of its table are changed by this ADR, which is the change a reviewer cites. The status vocabulary has no "superseded in part", and an accepted ADR is immutable.
  - ADR-0012's "`hasMore` is derived from the warnings" becomes "`hasMore` is true when `nextCursor` is present". ADR-0011 stands: the budget bounds each page.
  - BR-0002 (no cursor, `offset` for paging) and BR-0006 (the `hasMore` definition and the `offset` exception) contradict this ADR as written. The cursor core PR edits both in place, each with a Changelog row, and needs the maintainer's OK for that. BR-0013 gets `nextCursor` in its second category (additive). The foundations doc, 4.4 and 4.5, gets a sentence on the cache. These edits wait for that PR so no rule describes behavior `main` doesn't have yet.
- The `logseq://page/{name}` resource has its own 50,000-character cut and notice. It is not a tool result and stays as it is, apart from the notice's wording.

## Status

proposed

Date: 2026-10-13

## Mechanical enforcement

- test: `tests/guards/tool-list.test.ts` (the ADR-0016 budget and the recorded list hold the cost of `cursor` on each tool)
- test: `rust/src/budget.rs` (`fit`, which measures each page against the 30,000 characters)
- reviewer: A tool that can cut a list pages it with `cursor` and `nextCursor`, has no `offset` and offers no cap raise as the way on.
- none-yet: #528 (the cursor core and each tool's migration add the guards: a token round trip, a hit costing 0 calls, a miss costing page 1's calls, and the `explore_network` page 1 pin)
