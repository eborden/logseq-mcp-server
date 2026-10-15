# Tools, prompts and resources

The server has 10 tools in four kinds, named in the tool names: `get`, `find`, `explore` and `check`. Tools are shown here by bare name (`find_blocks`); your host may add a prefix such as `mcp__plugin_logseq_logseq__logseq_*`. Every tool is read-only. The skills refer to them by bare name, so either form works.

## Get: one thing you can name

| Tool | Purpose |
|------|---------|
| `get_page` | Retrieve a page. `detail`: `page` (default), `full` (with its blocks) or `outline` (top-level blocks: uuid, first-line snippet, child count) |
| `get_block` | Get a specific block by UUID |
| `get_current` | What the user has open in LogSeq right now |
| `get_graph` | Current LogSeq graph information, including the filesystem path |

## Find: things that match a filter

| Tool | Purpose |
|------|---------|
| `find_blocks` | Find blocks, newest first, by `text` (a case-insensitive substring), the `page` they are on, the pages they link to (`links_to`, 1 to 5; `[[x]]` and `#x` count, plain text does not; every page's aliases are followed), a block property (`property` with `value`), a period of journal days (`start_date` with `end_date`, `last_n` days or a `preset`), or any of them together. Paged with `limit` and a `cursor` (the `nextCursor` of a cut result, passed alone); `include_context` adds each block's page, references and tags |
| `find_pages` | Find non-journal pages as `{ name, aliases? }`, filtered by `text` (a substring of a name or alias), exact `names` (up to 50, each answered with its page or `null` and the closest names) and a page property (`property` with `value`) |

## Explore: walk outward from a page

| Tool | Purpose |
|------|---------|
| `explore_context` | One page in one call: its blocks, related pages and the blocks that link to it (references, most-linking pages first), read to the end with a cursor |
| `explore_network` | The pages linked to a page as nodes and edges, in both link directions (a walk of up to 500 pages read in pages of `max_nodes` with `cursor`; `max_depth` up to 3; journals and roll-up pages that link over 30 pages are leaves; `with_snippets` says why two pages connect). With `to`, the shortest link path to a second page instead, as nodes and edges with their reference counts. Blocks that link to a page are `find_blocks` with `links_to` |
| `explore_timeline` | A page or a period over time: the journal days in a period, or the blocks on a page and the blocks that link to it by day, oldest first; or both (a period leaves out non-journal pages). `group_by` week or month, `top_concepts_limit` for what a period was about, capped by `max_blocks` and a 30,000-character budget |

## Check: a gate before you write

| Tool | Purpose |
|------|---------|
| `check_links` | Check a `[[link]]` pass on a note: prose unchanged, brackets balanced, no ref dropped, every ref names a page or alias |

## Long results

A result that is cut says so in `warnings` and sets `hasMore`. Where a call can read on, the result carries a `nextCursor`; pass it back as `cursor`, alone, to get the next part. A cursor only moves forward.

## Markdown output and compact results

`get_page`, `get_block`, `explore_context` and `explore_network` take `format: "markdown"` (the default is `"json"`). The result is one plain text block: page properties as `key:: value` lines, blocks as indented `- ` bullets with `((uuid))` refs kept (block uuids are left out, except in `compact`), related pages and references grouped by source page, and a short footer for warnings, `hasMore` and tips. It is roughly 45-80% smaller than the JSON. `explore_context` also takes `compact: true`, which swaps block bodies for a first-line snippet plus the block's uuid (it pays off on long blocks, and `resolve_refs` is skipped with a warning). For a long page, `get_page` with `detail: "outline"` lists the top-level blocks (uuid, snippet, child count) and `get_block` reads the ones you pick. The `logseq://page/{name}` resource renders through the same code.

## Prompts

Prompts are ready-made starting points that a host shows as slash commands or a menu. Each one sends the model a short message naming the tools to call and the limits to keep. They only read.

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `weekly_summary` | `week` (optional): `this` (default), `last`, or a date in the week | Summarize a Monday-to-Friday week of journals into a few short signals |
| `monthly_summary` | `month` (optional): `this` (default), `last`, or `YYYY-MM` | Summarize a month from its weekly pages, with each thread's trajectory |
| `continue_on` | `topic` (required) | Pick up where you left off: current state, latest activity, open tasks, next step |
| `what_do_i_know` | `topic` (required) | Research a topic across the graph, with sources and gaps |
| `prioritize_tasks` | `focus` (optional) | Find open TODO and DOING tasks, spot stale ones, suggest an order |

The server cannot write to your graph. The summary prompts end by showing the summary in the chat. If you want it saved as a page, ask, and a host with file access can do it.

## Resources

| URI | Contents |
|-----|----------|
| `logseq://guide` | The reading guide: how to read results (case-insensitive names, `((uuid))` refs, `hasMore` and `warnings`), which tool to start with, and an index of tools and prompts |
| `logseq://page/{name}` | One page as Markdown text. The name is URL-encoded and may be an alias or an ISO date (`logseq://page/2025-01-01`). Pages over 50,000 characters are cut with a notice |

## Skills

The `logseq-skills` workflows combine several tools. The tool references are one file per kind (`get`, `find`, `explore`, `check`), each tool with parameters and worked JSON examples. The files are in `skills/logseq-skills/` (also reachable at `.claude/skills/logseq-skills/` through a symlink for project-local use).

- **Recall a topic**: "What do I know about X?", one `explore_context` call per page, in parallel for several
- **Refresh on a person**: a pre-meeting read of a person's page, their recent days and what is open with them
- **History of a decision**: how a page or decision changed over time, with the blocks that matter
- **Connect two projects**: the shortest path of links between two pages, and what each link says
- **Plan the week**: "What should I work on?", find and organize TODOs, by marker and by property
- **Stale work**: find old, waiting or blocked tasks
- **Who owns it**: for a page you can name, `get_page` and its properties give the owner; for a property value you already have ("everything Alice owns"), `find_pages` or `find_blocks` with `property` and `value`
- **Weekly and monthly summaries**: structured summaries from journal entries
- **Link concepts**: add `[[links]]` to notes already written, with a gate
