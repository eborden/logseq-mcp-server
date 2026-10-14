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

- [BR-0002 (tools-read-only)](../business-rules/0002-tools-read-only.md) says the server keeps no hidden progress and no cursor, and that paging uses `limit` and `offset` "rather than a server-side cursor". That is about stateful cursors. The cursor decided here is stateless: the token carries everything the next page needs, so the server keeps no progress, a call stays read-only and safe to repeat, and the snapshot cache is neither progress nor needed for a correct result. The foundations doc, 4.4 and 4.5, says the server holds no state between calls and allows a cache only with a measured reason, one owner, and a correct slower server without it.
- [ADR-0012 (resultmeta-for-capped-results)](0012-resultmeta-for-capped-results.md) and [BR-0006 (no-silent-truncation)](../business-rules/0006-no-silent-truncation.md) make `hasMore` true only when a warning's `howToFetchAll` names a parameter to raise, with `offset` as the one paging exception.
- [ADR-0037 (tool-taxonomy-get-find-explore-check)](0037-tool-taxonomy-get-find-explore-check.md) names `limit` and `offset` as the paging vocabulary of every `find` tool and lists `references_offset` on `explore_context`. v2.0.0 is unreleased and ADR-0037 is the hard cut, so these parameters can still change.
- [ADR-0011 (bounded-calls-and-results)](0011-bounded-calls-and-results.md) and #485 bound each result in characters. That stays.
- The maintainer does not want a second or third pagination implementation, so adding `offset` to trees on its own is out.

Options considered:

| Option | Pros | Cons / cost |
|---|---|---|
| Keep each tool's way on and add `offset` to trees | Smallest change | A third unit for trees (an index into a tree that can change between calls) and a fifth mechanism. The cap-raise logic stays |
| One `offset` with a unit per tool kind | Stays inside ADR-0037 | A position in a list that moves, with no way to notice. Each page repeats page 1's calls. Trees, days and sections each still need their own unit and wording |
| An opaque cursor with no cache | No server state | Every page repeats page 1's LogSeq calls and may see a changed graph. The call ceilings (ADR-0034) hold per page, but nothing is saved |
| An opaque cursor with a snapshot cache (chosen) | One mechanism for every cut list. A later page costs 0 LogSeq calls and is consistent with the pages before it. Correct without the cache, only slower | The server holds a bounded cache that can be rebuilt, which the foundations doc's "no state between calls" doesn't mention today |

## Decision

We page every cut list with one forward-only opaque cursor, built once and shared by the tools. The design was agreed with the maintainer on 2026-10-13 (comment on #528).

**Contract.**
- Every paged tool takes an optional `cursor` and returns `nextCursor`, absent on the last page. A call with `cursor` takes no other argument: the arguments are in the token.
- Forward only. No previous, first or last.
- `hasMore` is true exactly when `nextCursor` is present, and `howToFetchAll` says to pass it.
- `offset` (`find_blocks`, `find_pages`) and `references_offset` (`explore_context`) are removed in v2.0.0, which is unreleased. This changes the vocabulary ADR-0037 set. The count caps (`limit`, `max_blocks`, `max_references`, `max_related_pages`, `max_nodes`) stay, as the page size.

**Model.** Every tool already builds its whole bounded result before it cuts it. That result is an ordered list of entries with stable ids. A page is the slice from the cursor's position that fits both the count cap (now a page size) and the 30,000-character budget (`budget::fit` over the slice that starts at the cursor's position, so its signature stays; `size_of` counts the warning and the cursor's own length). Page 1 is today's result plus `nextCursor`.

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

Page 1 of `explore_network` equals today's result for the same arguments, apart from the cursor and warning fields. It should: `select_candidates` ranks the candidates of each depth and then truncates to the node budget, so a walk allowed to reach 500 pages has today's result as a prefix. The depth labels are recomputed over the links known among the kept pages (`relabel_depths`), and a larger walk can know a link a capped one didn't, so whether the edges and labels are equal is checked, not assumed. The maintainer asked for page 1 to equal today's result, so a test on the hub fixture, written before the walk changes, pins the nodes, the edges and the depths. If a difference shows, that PR stops and asks which of the three to keep.

**Token.**
- base64url (`base64` crate, `URL_SAFE_NO_PAD`, the 0.22 that `reqwest` already pulls in, declared directly) of a versioned payload: the tool, its arguments, the position, the id of the last entry sent and a snapshot key. The arguments are stored as resolved: a period given as `last_n` or `preset` is stored as its start and end dates, so a rebuild after midnight reads the same window.
- No HMAC. Nothing in the token is trusted unchecked (the arguments are parsed again by `parse_args`, the position is bounds-checked), and every tool is read-only.
- No hand-rolled encoding or hashing. No new crates.
- A snapshot stores the arguments it was built from, and a call serves it only when they equal the token's, so a forged or crossed token can't read another tool's data.
- An unknown version, a payload that doesn't parse, or a token made for another tool is `InvalidParameter` before any LogSeq call.

**Snapshot cache.**
- The first call keeps its full result in a bounded per-process cache (least-recently-used, capped in bytes, with a time limit), keyed by a counter and the process start time, so a restarted server never reuses a key a client still holds. A later page served from the cache costs 0 LogSeq calls and is consistent with the pages before it. A step a tool runs after the cut (`include_context` on `find_blocks`, `resolve_refs` on `explore_timeline` and `explore_context`) still runs for the entries of that page.
- On a cache miss the tool makes the same calls as page 1, so no call ceiling rises. It then checks the anchor: the id of the last entry sent must sit just before the position. If it doesn't, the tool resumes after the anchor (or at the position if the anchor is gone) with a `cursor_stale` warning (BR-0006).
- A change that swaps one entry before the position for another, keeping the count, goes undetected. A hash of the ids before the position in the token would catch it. `sha2` is the fallback if that turns out to matter, and it is not in `Cargo.lock`, so it would be a new dependency to vet (foundations, 4.10). `std::hash::DefaultHasher` is the standard-library alternative.
- The cache is bounded in count, in bytes (in all, and per snapshot) and in age. At the time of writing the starting values are 16 snapshots, 32 MiB in all, 8 MiB per snapshot (a larger one is served by the miss path) and a maximum age of 1 minute since the snapshot was made (maintainer, 2026-10-14: "Let's go with 1 minute"). Reading a page does not extend that life. A snapshot older than that is a miss: the tool re-reads with the same calls as page 1, runs the anchor check, says `cursor_stale` if the list moved, and the rebuilt snapshot has a fresh creation time. With a life of one minute the count and byte bounds are generous, since a model reads a few lists at a time, so they are ceilings and not targets, and the core PR may lower them after measuring. From then on the constants in `snapshots.rs`, with their comment, are the record, and this ADR is not updated when they are tuned (ADR-0011 treats caps as tuning).
- The cursor is stateless: the token carries everything the next page needs, and the tool is correct without the cache, only slower. A cache hit serves the snapshot of page 1, so its page reflects LogSeq as it was when page 1 was read (at most a minute before, the snapshot's maximum age). A miss reads LogSeq again, so its page reflects LogSeq now, and the anchor check says `cursor_stale` if the list moved in between.

**Removed.** `raise_only_if_it_fits`, `offer_related_raise_only_if_it_fits`, `network_truncated_then_cut_by_size`, the `Raise` logic, and every "No parameter raises this limit" line. Once a result of any size can be read in pages, a cap raise can always be offered. A warning may offer a cap raise beside the cursor, and the model chooses which path to take (maintainer, 2026-10-14). `howToFetchAll` leads with the cursor and may add the raise as the alternative, as the warnings of `find_blocks` and `find_pages` word their two ways today. `hasMore` is true exactly when `nextCursor` is present, so a raise offer never makes it true by itself.

## Consequences

- Easier: a tree or any list larger than the budget is read to the end by repeated calls, with no tool left without a way on. One mechanism, one implementation, one wording of the warning. The cap-raise measuring code goes, and so does the timeline's date paging in the summary prompts.
- Harder: the server keeps a cache for the first time (a cache, not cursor state: nothing in it is progress). The cache is separate, has one owner (the server) and one invalidation (the limits above), and can be rebuilt, which is what the foundations doc's balance clause asks. A snapshot is dropped a minute after it was made, so a hit reflects LogSeq at most a minute before. A read that runs longer re-reads, which costs page 1's 1 to 5 calls per minute of reading and raises no call ceiling, since each call is the same as page 1's. A rebuild that finds the list changed says so with `cursor_stale`.
- The measured reason foundations 4.4 asks for is the call count and latency of page 1 (CLAUDE.md, "Current Implementation Status": 1 to 5 calls and about 0.01 to 0.2s per tool on the real-graph baseline), which a cursor with no cache would pay again on every page, and pages read from one version of the graph for up to a minute at a time. The cursor core PR measures a hit against a miss on the fixture instance and reports to the maintainer before relying on the cache. If the numbers don't support it, the cache is the part that goes, since the cursor is correct without it.
- Every paged tool changes its contract in the same release (v2.0.0, unreleased): `cursor` and `nextCursor` are new, and `offset` and `references_offset` go. This ADR is the explicit decision BR-0004 and ADR-0020 require for removing `offset` and `references_offset`: ADR-0037's hard cut covers the renames and merges of its surface table, which lists them as vocabulary, not as removals. The v2.0.0 release note (#499) is the migration note.
- The guard `tests/guards/tool-taxonomy-rules.ts` builds `ALLOWED_PARAMETERS` from ADR-0037's vocabulary (it lists `references_offset` and the `limit` and `offset` pair), so adding `cursor` fails it until the core PR edits it. That PR cites this ADR in the allowlist comment, since ADR-0037 can't carry a pointer. Each tool's PR changes goldens (`nextCursor`, the warning text, new cursor-miss cases and their call ceilings), so each needs the maintainer's `golden-change` label.
- Calls: page 1 makes today's calls, so no ceiling rises. A miss makes page 1's calls. A hit makes none, plus the after-the-cut steps above. `explore_network` makes the same number of queries, but its frontier is larger, so each returns more rows: measure latency in its PR.
- Tool-list size (ADR-0016): `cursor` is about 100 characters on 7 tools (`get_page`, `get_block`, `find_blocks`, `find_pages`, `explore_context`, `explore_timeline`, `explore_network`), against the three removed `offset` parameters at about 145 each. The net is a few hundred characters on a 14,500-character list. Each PR measures it against the budget, and #499 sets the v2 budget.
- What this ADR does not decide, left to the cursor core PR and the maintainer: whether a rule-made omission such as the `max_fanout` raise offer of `explore_network` still counts as "more" for `hasMore`. A raise of `max_fanout` is a different walk, not a later page, and `hasMore` is true exactly when `nextCursor` is present.
- Relation to existing records:
  - ADR-0037 stays `accepted`. Its `limit` and `offset` vocabulary and the `references_offset` entry of its table are changed by this ADR, which is the change a reviewer cites. The status vocabulary has no "superseded in part", and an accepted ADR is immutable.
  - ADR-0012's "`hasMore` is derived from the warnings" becomes "`hasMore` is true when `nextCursor` is present". ADR-0011 stands: the budget bounds each page.
  - This PR edits the rules and the foundations text the decision touches (maintainer, 2026-10-14: "A superceding BR should go in the current PR."), each BR with a Changelog row citing it. BR-0002 gets the one clarification its wording needs, since "no cursor" and "rather than a server-side cursor" could be read as banning a stateless token: it reads "no cursor state" and allows an opaque cursor token that carries what the next page needs (maintainer, 2026-10-14: "The cursor doesn't really fall in conflict with BR002. It is talking about stateful cursors. We are designing a stateless cursor."). BR-0006 gets the promise that a cut result can be read to the end, with the `hasMore` definition and the `offset` exception to match. BR-0008 says the canonical name stays `required`, except where a tool takes a `cursor`. BR-0013 names `nextCursor` among the completeness keys. Foundations 4.4 and 4.5 ("No tool keeps state between calls") name the snapshot cache as the one exception. Each is worded as the rule plus this ADR and says the implementation lands with the cursor core task and the tool PRs, so none claims behavior `main` doesn't have. BR-0008 is a design choice: the edit follows the option where `page` and `uuid` become optional in the schema and the handler refuses a call with neither them nor a `cursor`, and the maintainer confirms it. Its guard, `tests/guards/tool-list.test.ts`, which checks the canonical name is `required` for every aliased tool, gets that exception in the core PR.
  - `idempotentHint: true` stays accurate: no tool writes, a cursor call returns the same page while its snapshot lives, and a rebuilt page says `cursor_stale` if the list moved.
- The `logseq://page/{name}` resource has its own 50,000-character cut and notice. It is not a tool result and stays as it is, apart from the notice's wording.

## Status

accepted

Date: 2026-10-13

## Mechanical enforcement

- test: `tests/guards/tool-list.test.ts` (the ADR-0016 budget and the recorded list hold the cost of `cursor` on each tool)
- test: `rust/src/budget.rs` (`fit`, which measures each page against the 30,000 characters)
- reviewer: A tool that can cut a list pages it with `cursor` and `nextCursor`, has no `offset` and offers no cap raise as the way on.
- test: `rust/src/cursor.rs` (the token round trip and every refusal: a bad version, a payload that doesn't parse, a token of another tool)
- test: `rust/src/snapshots.rs` (the cache's bounds in count, bytes and age, and that it serves only the arguments it was built from)
- test: `rust/tests/find_blocks_cursor_calls.rs` (a hit costs 0 calls, a miss costs page 1's calls, a stale anchor says `cursor_stale`, a cut list is read to the end, and a bad token or a cursor beside another argument is refused before any call; `find_blocks` is the first tool on the cursor, #550)
- test: `tests/guards/tool-taxonomy-rules.ts` (`ALLOWED_PARAMETERS` gives every paged tool a `cursor` and none an `offset`, so this guard is the `test:` for "no `offset`")
- test: `rust/tests/network_cursor_calls.rs` (`explore_network` without `to`, #556: the walk runs to 500 pages and `max_nodes` is the page size; a hit costs 0 calls, a miss page 1's calls, a stale anchor says `cursor_stale`, a walk several times the budget is read to the end with every page and edge once, and a bad token or a cursor beside another argument is refused before any call)
- test: `tests/integration/explore-network-page1.test.ts` (page 1 of the walk equals the capped walk's nodes, depths and edges on the hub fixture, written before the walk changed)
