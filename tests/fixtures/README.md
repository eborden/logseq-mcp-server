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
`src/fixture-graph.test.ts` checks that the graph folder holds only `pages/`, `journals/` and `logseq/`, and
that `pages/` and `journals/` hold only `.md` files. Put any new notes about the fixture here, not in `graph/`.

Page counts are the same however the folder is opened. Tests need not allow for a `readme` page or for
`#NN` tag pages. The README's text is not searchable, so words like "importer", "meeting" and "test" in it
do not add `search_blocks` hits.

## What is here so far

The skeleton (#87) and its content:

- #88: edge cases (aliases, namespaces, block refs and embeds, properties), journals, tags and tasks (done, see "Edge cases, journals, tags and tasks" below)
- #89: a hub page with 100+ neighbours (done, see "The hub" below)
- #90: moves `npm run test:integration` from the maintainer's own graph to this one

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
| `archive` | none | **Exists with no file, blocks, refs or aliases**: the namespace parent of `archive/old plans`. Nothing links it, so `get_concept_evolution` returns an empty timeline |
| `archive/old plans` | `pages/archive___old plans.md` | Makes the `archive` page above |
| `empty page` | `pages/empty page.md` | **Empty page with a file**: one block with empty content. A file with no bytes is never indexed (the instance waits for it forever), so the file holds a single `-` |
| `alice`, `bob` | `pages/Alice.md`, `pages/Bob.md` | Pages with a file, a page property (`role`) and **no alias** (the unchanged case in `alias-sets`). The files are capitalized, so `original-name` is `Alice` and `Bob`: lookups by `alice`, `Alice` or `ALICE` all find them |
| `carol`, `bird watching`, `test data` | none | **Link targets only**: linked from blocks or a property value, with no file and no blocks |
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
| A ref to `...00000000dead` and an embed of `...00000000beef` (no such block) | `ok`, **not** `missing`. LogSeq 0.10 makes a placeholder block for a uuid nobody has: no page, content `id:: <uuid>`. The resolver finds that row, so `missing` never shows up for a ref in a file graph (#138). When that is fixed, these become `missing` |

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

`query_by_property` matches set elements with their original casing (`participants` = `Bob`, not `bob`).
`status` = `testing` finds the one block on this page. `type` = `project` finds the three project pages.
The page holds the word "test" for `search_blocks`.

With `:property-pages/enabled?`, every property key that is not built in (`status`, `effort`,
`created-by` and so on, but not `alias`, `tags` or `id`) is also a page with no file.

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

`query_by_date_range` from 20250101 to 20250131 returns 7 days (Jan 2nd to Jan 15th). Add the Dec 31st
and Feb 3rd days, and the hub's journal below, for wider windows.

| Page | File | Exists to test |
|---|---|---|
| `project cascade` | `pages/project cascade.md` | Every task marker on one page: `TODO`, `DOING`, `DONE`, `LATER`, `NOW`, `WAITING`, `CANCELED`, a priority `[#A]` (LogSeq links the page `a` for it), and tasks nested under a task. Page `tags:: planning` |
| `deep outline` | `pages/deep outline.md` | Six levels of nesting: a `TODO` with a tag at level 6, a `DONE` at level 3, and a second root block |

Counts across these pages and journals: 8 `TODO`, 7 `DONE`, 2 each of `DOING`, `LATER`, `NOW`,
`WAITING` and `CANCELED`; 2 `SCHEDULED` and 2 `DEADLINE` blocks. None of them links the hub pages below.
The dates are integers `YYYYMMDD` in `:block/scheduled` and `:block/deadline`. The `DEADLINE` blocks
carry no `:block/journal-day`, unlike what CLAUDE.md's data shapes say (#140).

## The hub (#89)

`hub central` has **120 neighbours** (non-journal pages that link it, or that it links), plus one
journal that links it. It is the fixture for the caps and `hasMore`/`warnings` of
`get_concept_network`, `build_context` and `get_backlinks`. The files are generated, then committed:

```bash
npx tsx scripts/generate-hub-fixture.ts          # rewrite the files
npx tsx scripts/generate-hub-fixture.ts --check  # exit 1 if a committed file differs
```

`scripts/fixture-hub/hub-graph.ts` holds the shape and the counts. `src/fixture-hub.test.ts` fails if
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
| `get_concept_network` depth 1, defaults | 16 nodes (root + 15), exactly `neighbour-both-01..10` and `neighbour-in-01..05` (the only pages with 2 references, 15 of them, equal to `max_fanout`), `truncated` and `hasMore` true, one `network_truncated` warning |
| `get_concept_network` depth 2, defaults | 50 nodes (1 + 15 + 34 `fringe-*`), `truncated` true. The `max_nodes` cap bites, the 15 kept pages reach all 40 fringe pages |
| depth 1, `max_nodes` 500, `max_fanout` 100 (the most an MCP client can ask for) | 101 nodes (the fanout cap keeps 100 of 121 candidates), `truncated` true. The journal ranks last, so it is dropped |
| depth 1, `maxNodes` 500, `maxFanout` `Infinity` (library call only) | 122 nodes (the hub, 120 neighbours, the journal), `truncated` false. The journal is a depth-1 node |
| depth 2, same caps | 162 nodes (+40 `fringe-*`). The journal is a leaf: its 30 topics are not reached |
| depth 2, same caps, `expandJournals` true | 192 nodes (+30 `journal-topic-*`) |
| `get_concept_network` on `journal-topic-01`, depth 2, defaults | 2 nodes: itself and the journal (a leaf) |
| same, `expand_journals` true | 17 nodes (the journal, then 15 of its other pages: `max_fanout` 15 bites), `truncated` true. Add `max_fanout` 100 for 32 nodes (the journal, 29 other topics, `hub central`), `truncated` false |
| `build_context` on the hub | 50 of 71 blocks, 20 of 66 references, 10 of 61 related pages; totals `blocks` 71, `references` 66, `relatedPages` 61; `hasMore` true with `blocks_truncated`, `references_truncated` and `related_pages_truncated` |
| `get_backlinks` on the hub | 61 source pages, 66 blocks. It has no cap yet, so no `meta` |
| `get_page` on the hub, with children | 71 children |

What is fixed and what is not. `selectCandidates` ranks non-journal pages first, then by references, then by
lower `:db/id` (LogSeq assigns ids in file load order, so ties at the same count are not stable names):

- **Fixed by name.** The depth-1 default keeps exactly `neighbour-both-01..10` (1 block on the hub + 1 back) and
  `neighbour-in-01..05` (2 blocks that link the hub). Those are the only 15 pages with 2 references and every
  other neighbour has 1, so there is no tie at the cap. Tests may assert these names.
- **Depends on id order.** Which 34 of the 40 `fringe-*` pages depth 2 admits; which 85 of the 105 one-reference
  pages the `max_fanout` 100 case keeps; which 15 pages the `journal-topic-01` / `expand_journals` case keeps, and
  whether `hub central` is among them. For these, assert only the node count, `truncated` and the
  `network_truncated` warning (#90). A test that needs a particular fringe or topic page present must use a case
  where the cap does not bite (the `Infinity` rows).
- **Not covered: `get_backlinks` `max_blocks_per_page` (#61).** The hub exceeds a `max_pages` cap (61 source pages),
  but no page has more than 2 blocks that link the hub. A test for the per-page cap needs a neighbour with 11 or more
  linking blocks, and this README to change with it. That page would also change the depth-1 ranking above.

Pages the hub fixture adds to the graph: 1 hub, 120 neighbours, 40 fringe, 30 topics and 1 journal,
192 in all. They come on top of the sentinel page, the built-in pages and today's journal (see below).

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
the file, and its date changes every day. Exact assertions on page, journal or `list_pages`
counts must exclude it, and date-range tests must use fixed windows that end before 2026.

Measured total (#139, LogSeq 0.10.15 on a per-worktree instance, after the README moved out): the graph
holds **263 pages** in `:block/name`, built-in pages and today's journal included. They are:

| Part | Count |
|---|---|
| Pages with a file (`pages/` and `journals/`; 10 of them are journals) | 145 |
| Built-in pages, none with a file (the 16 listed above) | 16 |
| Today's journal | 1 |
| Pages with no file: link targets, property keys, block-embed uuids, alias stubs, namespace parents | 101 |

Without today's journal that is 262, and without the built-ins too, 246. There is no `readme` page and no
`#NN` tag page, and no README among the 146 indexed files (145 pages plus `config.edn`). The number moves
whenever a page, a property key or a block embed is added to the fixture, and nothing in the tests pins it,
so #90 should compute what it needs rather than copy it.
