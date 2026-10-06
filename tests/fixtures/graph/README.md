# Fixture graph

A small LogSeq file graph that the integration tests will run against (#86). Open this folder
as its own graph in LogSeq; `tests/integration/setup.md` ("Fixture graph") has the steps.

Every page, name, date and line of content here is made up. Nothing comes from a real graph,
which is what lets it live in a public repository (CLAUDE.md, Privacy).

```
logseq/config.edn   pins the settings that change parsing and page names
pages/              one file per page
journals/           one file per journal day (yyyy_MM_dd.md)
README.md           this file, hidden from LogSeq by :hidden in config.edn
```

## What is here so far

This is the skeleton (#87). Content comes next:

- #88: edge cases (aliases, namespaces, block refs and embeds, properties), journals, tags and tasks
- #89: a hub page with 100+ neighbours (done, see "The hub" below)
- #90: moves `npm run test:integration` from the maintainer's own graph to this one

| Page | Exists to test |
|---|---|
| `logseq-mcp-fixture-sentinel` | `requireFixtureGraph` (`tests/integration/helpers/fixture-graph.ts`) checks for it and its `fixture-version:: 1` property, so a test run fails loud against any other graph. |

`fixture-version` and `FIXTURE_VERSION` in the helper change together. Bump both when the tests
start depending on content an older copy of the fixture doesn't have.

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
| `get_concept_network` depth 1, defaults | 16 nodes (root + 15), all 10 `neighbour-both-*` among them (they have the most references, 2 each), `truncated` and `hasMore` true, one `network_truncated` warning |
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

The hub's ranking at depth 1 depends on the order LogSeq assigns ids in beyond the 10 two-way pages, so
tests should assert counts and the two-way pages, not which 5 of the one-way pages are kept.

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
database even without files, so exact page counts in tests need to allow for them. LogSeq also
creates **today's journal page** in its database when the graph opens, whether or not it writes
the file, and its date changes every day. Exact assertions on page, journal or `list_pages`
counts must exclude it, and date-range tests must use fixed windows that end before 2026.
