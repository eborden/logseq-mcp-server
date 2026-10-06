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
- #89: a hub page with 100+ neighbours
- #90: moves `npm run test:integration` from the maintainer's own graph to this one

| Page | Exists to test |
|---|---|
| `logseq-mcp-fixture-sentinel` | `requireFixtureGraph` (`tests/integration/helpers/fixture-graph.ts`) checks for it and its `fixture-version:: 1` property, so a test run fails loud against any other graph. |

`fixture-version` and `FIXTURE_VERSION` in the helper change together. Bump both when the tests
start depending on content an older copy of the fixture doesn't have.

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
