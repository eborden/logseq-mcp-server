# Fixture graph

A small LogSeq file graph (`tests/fixtures/graph/`) that the integration tests will run against (#86). Open that folder
as its own graph in LogSeq; `tests/integration/setup.md` ("Fixture graph") has the steps.

Every page, name, date and line of content here is made up. Nothing comes from a real graph,
which is what lets it live in a public repository (CLAUDE.md, Privacy).

```
tests/fixtures/
  README.md         this file. It sits outside the graph folder on purpose (see below)
  graph/            the graph: open this folder in LogSeq
    logseq/config.edn   pins the settings that change parsing and page names
    pages/              one file per page
    journals/           one file per journal day (yyyy_MM_dd.md)
  graph-linking/    a separate fixture for the concept-linking skill, with its own README
```

**Nothing but the graph lives in `graph/`.** LogSeq indexes every `.md` file in the folder as a page.
This README used to sit in `graph/` with `:hidden ["/README.md"]` in `config.edn`, but LogSeq 0.10.15
applies `:hidden` on only one of its two load paths (`load-new-repo-to-db!`, used by **Add new graph**).
`load-repo-to-db!`, which the per-worktree instance (#118) and any re-index use, passes a misspelled key
(`:file/node-node-path`) to `remove-hidden-files`, so it keeps the file. The README then showed up as a page
`readme`, plus a tag page for every issue number written with a `#`, and page counts depended on which way
the folder was opened (#139). Moving the file out removed the difference, so `config.edn` no longer lists it.
`tests/guards/fixture-graph.test.ts` checks that the graph folder holds only `pages/`, `journals/` and `logseq/`, and
that `pages/` and `journals/` hold only `.md` files. Put any new notes about the fixture here, not in `graph/`.

Page counts are the same however the folder is opened. Tests need not allow for a `readme` page or for
`#NN` tag pages. The README's text is not searchable, so words like "importer", "meeting" and "test" in it
do not add `find_blocks` hits.

## What is here so far

The skeleton (#87) and its content:

- #88: edge cases (aliases, namespaces, block refs and embeds, properties), journals, tags and tasks (done, see "Edge cases, journals, tags and tasks" below)
- #89: a hub page with 100+ neighbours (done, see "The hub" below)
- #61: a topic with a page of 12 linking blocks, for the ranking of the references of `explore_context` (see "The crowded topic" below)
- #498: roll-up pages for the leaf rule and the snippets of `explore_network`, at, under and over the threshold (see "Roll-up pages" below)
- #90: `npm run test:integration` runs against this graph only, with exact assertions (done; see `tests/integration/setup.md`)

| Page | Exists to test |
|---|---|
| `logseq-mcp-fixture-sentinel` | `requireFixtureGraph` (`tests/integration/helpers/fixture-graph.ts`) checks for it and its `fixture-version:: 1` property, so a test run fails loud against any other graph. |

`fixture-version` and `FIXTURE_VERSION` in the helper change together. Bump both when the tests
start depending on content an older copy of the fixture doesn't have.

## Edge cases, journals, tags and tasks

Hand-written. Names in the tables are `:block/name` (lowercase). Every result below was checked
against a per-worktree instance (#118, LogSeq 0.10.15).

### Page resolution and aliases

| Page | File | Exists to test |
|---|---|---|
| `project atlas` | `pages/project atlas.md` | **Unique alias**: `alias:: atlas`, declared by no other page. `atlas` resolves to it (`matchedBy` alias), and journal blocks link `atlas`, so asking by either name covers the same blocks (`alias-sets`). Also a page with a file, page properties (`type`, `status`, `owner`) and 3 or more blocks, a nested list, and the block `0088f1a0-...-000000000001` that other pages ref |
| `atlas` | none | The stub LogSeq makes for that alias: no file, no blocks, linked both ways to `project atlas` by `:block/alias` |
| `project borealis`, `project cascade` | `pages/project borealis.md`, `pages/project cascade.md` | **Ambiguous alias**: both say `alias:: roadmap`. `roadmap` resolves as ambiguous with those two candidates (`AmbiguousPageError`) |
| `project atlas/notes` | `pages/project atlas___notes.md` | **Unique namespace leaf**: `notes` resolves to it (`matchedBy` namespace-leaf). No page or alias is named `notes` |
| `project atlas/meetings`, `project borealis/meetings` | `pages/project atlas___meetings.md`, `pages/project borealis___meetings.md` | **Ambiguous namespace leaf**: `meetings` under two namespaces, with no page or alias named `meetings`. Resolves as ambiguous with both |
| `archive` | none | **Exists with no file, blocks, refs or aliases**: the namespace parent of `archive/old plans`. Nothing links it, so `explore_timeline` with this page returns no entries |
| `archive/old plans` | `pages/archive___old plans.md` | Makes the `archive` page above |
| `empty page` | `pages/empty page.md` | **Empty page with a file**: one block with empty content. A file with no bytes is never indexed (the instance waits for it forever), so the file holds a single `-` |
| `alice`, `bob` | `pages/Alice.md`, `pages/Bob.md` | Pages with a file, a page property (`role`) and **no alias** (the unchanged case in `alias-sets`). The files are capitalized, so `original-name` is `Alice` and `Bob`: lookups by `alice`, `Alice` or `ALICE` all find them |
| `carol`, `bird watching`, `test data` | none | **Link targets only**: linked from blocks or a property value, with no file and no blocks |
| `dave` | none | **Absent on purpose**: no page, link, alias or mention anywhere. The routing eval question `find-pages-2` asks which of Alice, Bob, Carol and Dave are missing, so Dave must stay absent (`tests/guards/routing-eval.test.ts` fails if it appears) |
| `meeting`, `moving`, `planning`, `weekly review` | none | **Tags**: `#meeting`, `#moving`, `#[[weekly review]]` in blocks, `tags:: planning` on `project cascade` (its `:block/tags`) and `topic:: #planning` |

### Block refs and embeds (`block refs`, `pages/block refs.md`)

Every target has a pinned `id::`, so tests can name it. The uuids are
`0088f1a0-0000-4000-8000-0000000000NN`; below, `NN` is the last part.

| Block | `resolve_refs` gives |
|---|---|
| `02`, the target | no refs (`resolvedRefs` absent) |
| `03`: a ref to `02` | one ref, `ok` |
| A ref to `01` on `project atlas` | one ref, `ok`, `page` is `project atlas` |
| `04`: a ref to `03` | two refs (`03`, then `02`), both `ok` |
| A ref to `04` | three: `ok`, `ok`, then `depth_limit` at the default depth 2, with a `refs_depth_limit` warning |
| Two sibling blocks, each a ref to `02` | each one `ok` (seen is tracked per path) |
| A block embed of `02` | one embed, `ok` |
| A page embed of `bob` | one embed, `ok` |
| `10` and `11`: refs to each other | `ok`, then `cycle` |
| `20` and `21`: embeds of each other | `ok`, then `cycle` |
| A ref to `...00000000dead` and an embed of `...00000000beef` (no such block) | each one `missing`, left as written. LogSeq 0.10 makes a placeholder block for a uuid nobody has: no page, content `id:: <uuid>`. The resolver reads a row with no page and no name as not found (#138). `tests/integration/fixture-only/resolve-refs-missing.test.ts` checks both |

LogSeq also makes a **page named after each block-embed uuid** (`0088f1a0-...-000000000002`, `...020`,
`...021`, `...beef`), with no file and no blocks. Plain `((uuid))` refs make no such page.

### Properties (`property types`, `pages/property types.md`)

One block per value type, and page properties on the first lines. Types as `:block/properties` returns them:

| Property | Written | Comes back as |
|---|---|---|
| `status` | `testing` | text `"testing"` |
| `effort` | `3` | number `3` |
| `ratio` | `0.75` | text `"0.75"`: a decimal is not a number |
| `reviewed`, `archived` | `true`, `false` | booleans (`false` is a value; slim output keeps it) |
| `owner` | `[[Alice]]` | one-element set `["Alice"]` |
| `participants` | `[[Alice]], [[Bob]]` | set `["Alice", "Bob"]` |
| `reviewers` | `Bob, Carol` | set `["Bob", "Carol"]`, because `config.edn` lists it in `:property/separated-by-commas` |
| `summary` | text with commas | one text value: not listed, so not split |
| `created-by` | `Bob` (block), `Alice` (page) | text. A **dashed key**: the Editor API returns it as `createdBy` |
| `due-date` | `[[Jan 15th, 2025]]` | set `["Jan 15th, 2025"]`, a ref to that journal page |
| `topic` | `#planning` | set `["planning"]` |
| `link` | a URL on `example.com` | text |
| `type`, `category`, `created-by` (page) | `reference`, `[[test data]]`, `Alice` | page properties: text, set, text |

`find_blocks` with a property matches set elements with their original casing (`participants` = `Bob`, not `bob`).
`status` = `testing` finds the one block on this page. `type` = `project` finds the three project pages.
The page holds the word "test" for `find_blocks`.

With `:property-pages/enabled?`, every property key that is not built in (`status`, `effort`,
`created-by` and so on, but not `alias`, `tags` or `id`) is also a page with no file.

#### Page properties, for `find_pages` (#490)

`getAllPages` carries a page's own (page-level) properties, and `find_pages` filters by them with `property` and
`value`. A property of a block, such as `status:: testing` or `effort:: 3` on a block of `property types`, is not on
the page and finds nothing. The page-level properties the integration tests (`find-pages-filters.test.ts`) rely on:

| Page | Page properties | Found by |
|---|---|---|
| `alice`, `bob` | `role` (`designer`, `engineer`) | `role` = `designer` finds `Alice` |
| `project atlas` | `alias` (`atlas`), `type` (`project`), `status` (`active`), `owner` (`[[Alice]]`, a set) | `status` = `active` finds it and `project cascade`; `owner` = `Alice` finds it |
| `project borealis` | `alias` (`roadmap`), `type`, `status` (`planning`) | `type` = `project` finds all three project pages |
| `project cascade` | `alias` (`roadmap`), `type`, `status` (`active`), `tags` (`planning`, a set) | `tags` = `planning` finds it |
| `property types` | `type` (`reference`), `category` (`[[test data]]`, a set), `created-by` (`Alice`, camelCase `createdBy` on the entity) | `created-by`, `createdBy` or `CREATED_BY` = `Alice` finds it; `category` = `test data` finds it |
| `logseq-mcp-fixture-sentinel` | `fixture-version` (the number `1`) | `fixture-version` = `1` or `"1"` finds it |

`names` answers against the same pages: `alice`, `carol` and `archive` are pages (the last two have no file), `atlas`
is the alias of `project atlas`, `roadmap` is declared by two pages and so names no one page, and `dave` has no page
and no closest name (the routing eval's `find-pages-2` depends on it, so it must stay absent).

### Journals, tasks, tags and nesting

| Journal | File | Has |
|---|---|---|
| `dec 31st, 2024` | `journals/2024_12_31.md` | The year boundary: links `project atlas` and `alice`, a `DONE` |
| `jan 2nd, 2025` | `journals/2025_01_02.md` | A link to the alias `atlas`, a `TODO` with `SCHEDULED: <2025-01-06 Mon>`, the only link to `bird watching` |
| `jan 6th, 2025` | `journals/2025_01_06.md` | A `#meeting` nested three levels, a `DOING`, a ref to block `01` on `project atlas` |
| `jan 7th, 2025` | `journals/2025_01_07.md` | A `TODO` with `DEADLINE: <2025-01-10 Fri>`, a link to `atlas`, `#moving` |
| `jan 8th, 2025` | `journals/2025_01_08.md` | `DONE`, `NOW`, and a `TODO` with both `SCHEDULED: <2025-01-15 Wed>` and `DEADLINE: <2025-01-24 Fri>` |
| `jan 10th, 2025` | `journals/2025_01_10.md` | `#[[weekly review]]` with links to the three projects |
| `jan 13th, 2025` | `journals/2025_01_13.md` | `LATER`, `WAITING`, `CANCELED` |
| `jan 15th, 2025` | `journals/2025_01_15.md` | A `#meeting` with nested blocks. Also the target of `due-date` and a `SCHEDULED` date |
| `feb 3rd, 2025` | `journals/2025_02_03.md` | After a gap of almost three weeks, so a January window ends before it |

`explore_timeline` from 20250101 to 20250131 returns 7 days (Jan 2nd to Jan 15th). Add the Dec 31st
and Feb 3rd days, and the hub's journal below, for wider windows.

| Page | File | Exists to test |
|---|---|---|
| `project cascade` | `pages/project cascade.md` | Every task marker on one page: `TODO`, `DOING`, `DONE`, `LATER`, `NOW`, `WAITING`, `CANCELED`, a priority `[#A]` (LogSeq links the page `a` for it), and tasks nested under a task. Page `tags:: planning` |
| `deep outline` | `pages/deep outline.md` | Six levels of nesting: a `TODO` with a tag at level 6, a `DONE` at level 3, and a second root block |
| `schedule cases` | `pages/schedule cases.md` | The dated blocks on a **non-journal page**, for the `:block/journal-day` probe (#140): one `SCHEDULED`, one `DEADLINE`, one with both (past dates in January 2025), and a plain block. No task markers, links, tags or properties, so no other count moves. The same three shapes exist on the journals above (`jan 2nd`, `jan 7th`, `jan 8th`) |

Counts across these pages and journals: 8 `TODO`, 7 `DONE`, 2 each of `DOING`, `LATER`, `NOW`,
`WAITING` and `CANCELED`; 4 `SCHEDULED` and 4 `DEADLINE` blocks (2 and 2 of them on `schedule cases`, above). None of them links the hub pages below.
The dates are integers `YYYYMMDD` in `:block/scheduled` and `:block/deadline`. None of these blocks
carries `:block/journal-day` (#140): the probe in `scripts/probe-constraints.ts` ("Scheduled / deadline
blocks and :block/journal-day") answers no for `SCHEDULED`, `DEADLINE` and both, on a journal and on a
non-journal page. The dates are all in the past, 2025.

## The hub (#89)

`hub central` has **120 neighbours** (non-journal pages that link it, or that it links), plus one
journal that links it. It is the fixture for the caps and `hasMore`/`warnings` of
`explore_network` and `explore_context`. The files are generated, then committed:

```bash
npx tsx scripts/generate-hub-fixture.ts          # rewrite the files
npx tsx scripts/generate-hub-fixture.ts --check  # exit 1 if a committed file differs
```

`scripts/fixture-hub/hub-graph.ts` holds the shape and the counts. `tests/guards/fixture-hub.test.ts` fails if
the committed files differ from it, or if the numbers below stop holding when the files are read back.
Change the generator, regenerate, and update this section together.

| Pages | Files | Link |
|---|---|---|
| `neighbour-out-01` .. `60` | `pages/neighbour-out-NN.md` | the hub links them, they do not link back (60) |
| `neighbour-both-01` .. `10` | `pages/neighbour-both-NN.md` | linked both ways (10) |
| `neighbour-in-01` .. `50` | `pages/neighbour-in-NN.md` | they link the hub, it does not link them (50). `01` .. `05` hold two blocks that link it |
| `fringe-01` .. `40` | none (link targets only) | linked by `neighbour-out-*` (3 each) and `neighbour-both-*` (4 each); depth 2 from the hub |
| 2024-06-17 (`Jun 17th, 2024`) | `journals/2024_06_17.md` | links the hub and `journal-topic-01` .. `30` |
| `journal-topic-01` .. `30` | none (link targets only) | linked only by that journal |

Page and block counts (each block holds at most one link):

| What | Count |
|---|---|
| Pages the hub links (outbound) | 70 (60 out-only + 10 both) |
| Non-journal pages that link the hub (inbound) | 60 (50 in-only + 10 both) |
| Distinct non-journal neighbours | 120 |
| Journals that link the hub | 1 |
| Blocks on the hub page | 71 (1 intro with no link, 70 with one link each) |
| Blocks elsewhere that link the hub | 66 (55 on `neighbour-in-*`, 10 on `neighbour-both-*`, 1 in the journal) |
| Source pages of those blocks | 61 (60 pages + the journal) |

Expected results, measured against a live instance (#118) with the code at the time of writing:

| Call | Result |
|---|---|
| `explore_network` depth 1, defaults | 16 nodes (root + 15), exactly `neighbour-both-01..10` and `neighbour-in-01..05` (the only pages with 2 references, 15 of them, equal to `max_fanout`), `truncated` true, `hasMore` false (no cursor: the walk fits a page), one `network_truncated` warning that offers a higher `max_fanout` (#556) |
| `explore_network` depth 2, defaults | page 1: 50 nodes (1 + 15 + 34 `fringe-*`), `truncated` true, `hasMore` true and a `nextCursor` to the last 6 `fringe-*` pages (the walk has 56, `max_nodes` is the page size, #556). The 15 kept pages reach all 40 fringe pages |
| depth 1, `max_nodes` 500, `max_fanout` 100 (the most an MCP client can ask for) | 101 nodes (the fanout cap keeps 100 of 121 candidates), `truncated` true. The journal ranks last, so it is dropped |
| depth 1, `maxNodes` 500, `maxFanout` `Infinity` (library call only) | 122 nodes (the hub, 120 neighbours, the journal), `truncated` false. The journal is a depth-1 node |
| depth 2, same caps | 162 nodes (+40 `fringe-*`). The journal is a leaf: its 30 topics are not reached |
| depth 2, same caps, `expandJournals` true | 192 nodes (+30 `journal-topic-*`) |
| `explore_network` on `journal-topic-01`, depth 2, defaults | 2 nodes: itself and the journal (a leaf) |
| same, `expand_journals` true | 17 nodes (the journal, then 15 of its 29 other topics: `max_fanout` 15 bites, and `hub central`, which links 70 pages, is a roll-up and ranks after every topic), `truncated` true. Add `max_fanout` 100 for 32 nodes (the journal, 29 other topics, `hub central`), `truncated` false |
| `explore_context` on the hub | 50 of 71 blocks, 20 of 66 references, 10 of 61 related pages; totals `blocks` 71, `references` 66, `relatedPages` 61; `hasMore` true with `blocks_truncated`, `references_truncated` and `related_pages_truncated`. The references are a prefix of the full ranking (see "Fixed by ranking") |
| `explore_context` on the hub, read to the end with its cursor | 7 pages (the blocks 50 + 21, the references 20 + 20 + 20 + 6, the related pages 10 x 6 + 1; `tests/integration/context-cursor.test.ts`): each list once, each ending on its own page. `references_truncated` says "Showing 21-40 of 66 references." on the second page, and the last page has no `nextCursor`, no `hasMore` and no warning |
| `get_page` on the hub, with children | 71 children |
| `explore_network` with `to`: `alice` to `project atlas`, `max_depth` 2 | 1 hop: `Alice`, `project atlas`; one edge of count 2 (one block each way), and `resolvedAliases.to` is `atlas`, `project atlas` |
| same, `Alice` to `Bob`, and `Bob` to `Alice`, `max_depth` 1 | 1 hop, one edge of count 1: Alice's block links Bob, so it is a `reference` from Alice and a `backlink` when asked from Bob |
| same, `journal-topic-01` to `hub central`, `max_depth` 2 | 2 hops through the journal `Jun 17th, 2024` (two edges of count 1). With `max_depth` 1 there is no path: `no_path_within`, and `howToFetchAll` offers `max_depth` 2 |
| same, `archive` or `empty page` to `Bob` | no path, and the walk ran out of pages after 1 hop: nothing links them. `Alice` to `archive` at depth 3 is no path within the maximum depth |
| same, `project atlas` to `atlas` | the same page: `same_page` and no walk |

What is fixed and what is not. `selectCandidates` ranks non-journal pages first, then by references, then by
lower `:db/id` (LogSeq assigns ids in file load order, so ties at the same count are not stable names):

- **Fixed by name.** The depth-1 default keeps exactly `neighbour-both-01..10` (1 block on the hub + 1 back) and
  `neighbour-in-01..05` (2 blocks that link the hub). Those are the only 15 pages with 2 references and every
  other neighbour has 1, so there is no tie at the cap. Tests may assert these names.
- **Depends on id order.** Which 34 of the 40 `fringe-*` pages depth 2 admits; which 85 of the 105 one-reference
  pages the `max_fanout` 100 case keeps; which 15 of the 29 topics the `journal-topic-01` / `expand_journals` case keeps. For these, assert only the node count, `truncated` and the
  `network_truncated` warning (#90). A test that needs a particular fringe or topic page present must use a case
  where the cap does not bite (the `Infinity` rows).
- **Fixed by ranking (#178, #493).** `explore_context` ranks its references by the blocks of their source page that link
  the target, most first, ties by lowercase page name, the blocks of one page together. The hub's 61 source pages come
  out as `neighbour-in-01..05` (2 blocks each), then the 56 single-block pages by name: `jun 17th, 2024`,
  `neighbour-both-01..10`, `neighbour-in-06..50`. The default 20 references are `neighbour-in-01..05` (2 each),
  `jun 17th, 2024` and `neighbour-both-01..09`. Tests may assert these names. The related pages are not ranked:
  they keep LogSeq's order, which changes between instance starts.
- **Not covered by the hub: a source page with many linking blocks (#61).** No hub neighbour has more than 2 blocks that
  link it, and giving one 11 would change the depth-1 ranking above. The crowded topic below covers it.

Pages the hub fixture adds to the graph: 1 hub, 120 neighbours, 40 fringe, 30 topics and 1 journal,
192 in all. They come on top of the sentinel page, the built-in pages and today's journal (see below).

## The crowded topic (#61)

`popular topic` has **14 linking blocks on 2 source pages**, for the ranking of the references of `explore_context`. It is separate
from the hub so the hub's depth-1 ranking stays as documented. Both source pages hold nothing but linking blocks,
written `Row N on [[popular topic]]`, and the target has no file.

| Page | File | Holds |
|---|---|---|
| `popular topic` | none (link target only) | the target |
| `busy source` | `pages/busy source.md` | 12 blocks that link the target, more than the default of 10 per page, fewer than the maximum of 50 |
| `light source` | `pages/light source.md` | 2 blocks that link the target, under every cap |

`explore_context` on `popular topic`: 14 references on 2 source pages. `busy source`'s 12 come first and then `light source`'s 2
(ranked by linking blocks, #178), and the default `max_references` of 20 holds all 14, so there is no `references_truncated`.
`max_references` 10 keeps the first 10 of `busy source`'s, with the `nextCursor` for the last 2 of them and the 2 of
`light source`.

The blocks avoid the letter `e` on purpose: `tests/integration/result-caps.test.ts` searches for `e` and expects fewer than
`find_blocks`' maximum of 500 matches. The fixture holds 1,145 blocks, 478 of them with an `e` (667 without: 2 older ones, these 14,
the 10 of the roll-up pages below, the 101 of `quartz log` and the 540 of `quartz outline`). With an `e` in these 24 it would be 502. Keep new fixture blocks
without the letter, or change that test.

## Roll-up pages (#498)

A roll-up page links to almost everything, like the weekly or monthly summary pages a graph generates, and is no journal.
`explore_network` treats a page that links **more than 30 pages** (`HUB_LINKS`, `rust/src/tools/explore_network/selection.rs`)
as a leaf: it ranks after every other page and is not walked through unless `expand_journals` is set. The count is of
distinct pages the page's blocks link, not of blocks. It is separate from the hub so the hub's depth-1 ranking stays as
documented. Every name is made up, and the blocks avoid the letter `e` (see "The crowded topic").

| Page | File | Links |
|---|---|---|
| `solo topic` | `pages/solo topic.md` | one block that links `solo link 01` .. `12` (12 topical pages, link targets only) |
| `rollup 29` | `pages/rollup 29.md` | **29 pages**, one under the threshold: `solo topic` in two blocks (`Row A`, `Row B`) and `rollup topic 01` .. `28` in a third |
| `rollup 30` | `pages/rollup 30.md` | **30 pages**, at the threshold: `solo topic` in two blocks and `rollup topic 01` .. `29` |
| `rollup 31` | `pages/rollup 31.md` | **31 pages**, one over it: `solo topic` in two blocks and `rollup topic 01` .. `30` |
| `solo link 01` .. `12`, `rollup topic 01` .. `30` | none | link targets only. `rollup topic 30` is linked by `rollup 31` alone |

Measured with the connected-pages query on an instance (#118, LogSeq 0.10.15): the pages each roll-up links are 29, 30 and
31, and the ordinary pages of the hub fixture link far fewer (`neighbour-in-NN` 1, `neighbour-out-NN` 3, `neighbour-both-NN` 5),
while `hub central` links 70. The threshold of 30 sits between them, at twice the default `max_fanout`.

| Call | Result |
|---|---|
| `explore_network` on `solo topic`, depth 1, defaults | 16 nodes: the root, `rollup 29`, `rollup 30` (two blocks each: they lead as they did before), the 12 `solo link NN` (one block each, order by id), then `rollup 31` last. `rollup 31` has the same two blocks as the others and used to rank with them. Nothing is dropped; no warning (a roll-up at the last depth has nothing to walk through) |
| same, `max_fanout` 14 | 15 nodes: `rollup 31` is the page the cap drops, with a `network_truncated` warning only. Before, a `solo link NN` went |
| depth 2, `max_fanout` 100 | 45 nodes: the 16 above and `rollup topic 01` .. `29`. `rollup 29` and `rollup 30` are walked through, `rollup 31` is not: `rollup topic 30` is absent. A `hub_pages_not_expanded` warning names `rollup 31 (31 pages)` and offers nothing to fetch, since the network already holds more pages than it links |
| depth 2, `max_fanout` 100, `expand_journals` true | 46 nodes: `rollup topic 30` joins, no warning |
| `explore_network` on `neighbour-out-01`, depth 2, defaults | `hub central` (70 pages) is a depth-1 leaf, none of the `neighbour-in-NN` that only it reaches is in the result, and `hub_pages_not_expanded` offers `expand_journals`. With `expand_journals` the `neighbour-both-NN` and `neighbour-in-01` .. `05` that link it twice join |
| `with_snippets` on `solo topic`, depth 2, `max_fanout` 100 | the same nodes, and the same 3 calls. The edges of the root carry a `snippet`: `Row A on [[solo topic]]` for each roll-up, and the root's own block, cut at 80 characters with `...`, for each `solo link NN`. Edges deeper than the root have none |

## A long page (#552)

`quartz log` (`pages/quartz log.md`) exists for the cursor of `get_page` with `detail: "full"` and of `get_block` with
`include_children` (ADR-0038): a page whose full tree is several times the 30,000-character budget, so a call can only read it
in pages. Nothing else reads it, and nothing links it. It has no page properties and no links, tags or `[[refs]]`, and no block
holds the letter `e` (see "The crowded topic" above). 101 blocks, about 103,500 characters:

| Blocks | Shape |
|---|---|
| `Quartz log, a long scroll of blocks in parts` | a short first block |
| `Log part 1 holds 60 blocks`, id `0088f1a0-0000-4000-8000-000000000b01` | 60 children `Block 1-01` to `Block 1-60` of about 1,100 characters, and under `Block 1-02` 3 more, `Bit 1-02-1` to `Bit 1-02-3`, of about 500: a subtree of 64 blocks, about 70,000 characters, so `get_block` on it makes 3 pages |
| `Log part 2 holds a chain`, id `0088f1a0-0000-4000-8000-000000000b02` | a subtree of 6 blocks, 3 levels deep (`Block 2-01`, its child `Block 2-01-a` with two children, and `Block 2-01-b`), about 6,200 characters sent: under the budget, so it is never cut |
| `Block 3-01` to `Block 3-30` | 30 top-level blocks of about 1,000 characters |

Read in pages the page makes 5 (about 29,000 characters each, the last 16,000), and the second starts inside `Log part 1`, so its blocks name it in `ancestors`. The tests
(`tests/integration/tree-cursor.test.ts`) take the expected blocks from the bullets of this file, in order, and the block text
names each block, so nothing is read from the instance to know what to expect.

## A page with many top-level blocks (#553)

`quartz outline` (`pages/quartz outline.md`) exists for the cursor of `get_page` with `detail: "outline"` (ADR-0038): a page
with more top-level blocks than one page of the outline holds (200), and more than fits the 30,000-character budget. Nothing
else reads it, and nothing links it. It has no page properties and no links, and no block holds the letter `e` (see "The
crowded topic" above). 540 blocks, 450 of them top-level:

| Blocks | Shape |
|---|---|
| `Row 001` to `Row 200` | 200 top-level blocks with a first line of about 20 characters |
| `Row 201` to `Row 450` | 250 top-level blocks with a first line of about 150 characters, cut to 80 in the outline |
| `Bit 005`, `Bit 010` .. `Bit 450` | one child under each `Row` whose number is a multiple of 5 (90 in all), so its `childCount` is 1 and every other block's is 0 |

The outline read in pages makes 3: the first holds `Row 001` to `Row 200` and is cut by the page size (`outline_truncated`), the
second starts at `Row 201` and is cut by the budget (`result_size_truncated`, about 185 blocks), and the third holds the rest.
The tests (`tests/integration/outline-cursor.test.ts`) take the expected blocks from the bullets of this file, in order, and the
text of each names the block, so nothing is read from the instance to know what to expect.

## Files LogSeq writes when it opens the folder

The repo `.gitignore` ignores them, so they never get committed:

- everything under `logseq/` except `config.edn`: `custom.css`, `bak/`, `.recycle/`,
  `version-files/` and the like
- `pages/contents.md` (the built-in Contents page)
- today's journal, e.g. `journals/2026_01_01.md`. The ignore patterns cover every date from
  2026 on, so **fixture journals must be dated 2025 or earlier**. A tracked file is never
  ignored, so an older journal added on purpose is unaffected.

The built-in pages LogSeq adds to every graph (Contents, Favorites and the like) exist in its
database even without files, so exact page counts in tests need to allow for them. On LogSeq
0.10.15 there are **16** of them, none with a file: the task markers (`todo`, `doing`, `done`,
`later`, `now`, `wait`, `waiting`, `canceled`, `cancelled`, `in-progress`), the priorities `a`, `b`
and `c`, and `card`, `contents` and `favorites`. That count comes from an instance (#118) on a graph
holding only the sentinel page and `config.edn`, which had 19 pages: the 16, the sentinel, its
property page `fixture-version` and today's journal. Every property key that isn't built in is
also a page with no file, so each new key in the fixture adds one. LogSeq also
creates **today's journal page** in its database when the graph opens, whether or not it writes
the file, and its date changes every day. Exact assertions on page, journal or `find_pages`
counts must exclude it, and date-range tests must use fixed windows that end before 2026.

Measured total (#139, re-measured with #553 on LogSeq 0.10.15, a per-worktree instance: `getAllPages`): the graph
holds **298 pages** in `:block/name`, built-in pages and today's journal included. They are:

| Part | Count |
|---|---|
| Pages with a file (`pages/` and `journals/`; 10 of them are journals) | 154 |
| Built-in pages, none with a file (the 16 listed above) | 16 |
| Today's journal | 1 |
| Pages with no file: link targets, property keys, block-embed uuids, alias stubs, namespace parents | 127 |

Without today's journal that is 297, and without the built-ins too, 281. There is no `readme` page and no
`#NN` tag page, and no README among the 155 indexed files (154 pages plus `config.edn`). The number moves
whenever a page, a property key or a block embed is added to the fixture, and nothing in the tests pins it,
so the tests compute what they need rather than copy it (#90).
