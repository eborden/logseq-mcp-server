# Get tools

You already have the thing: a page name, a block uuid, "the page that's open". A `get` tool returns that one thing, or not-found with the closest names. It never returns a list of hits (that is `find`) or what surrounds the thing (that is `explore`).

| Tool | Takes | Returns |
|------|-------|---------|
| `logseq_get_page` | `page`, `detail`, `resolve_refs`, `format`, `cursor` | A page, its blocks, or its outline |
| `logseq_get_block` | `uuid`, `include_children`, `resolve_refs`, `format`, `cursor` | One block, optionally with its subtree |
| `logseq_get_current` | nothing | The open page, the block being edited, the selected blocks |
| `logseq_get_graph` | nothing | The connected graph's name and path |

Each example is a question, a call, what to read in the result and the next call. Cuts and warnings are explained once, in `results-and-limits.md`.

## logseq_get_page

Get a page by name, with `detail` choosing how much of it.

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `page` | string, required unless `cursor` is given | | Page name (any case), an alias, or an ISO date (`2025-01-01`) for a journal. `name` and `page_name` are accepted for it, but send `page` |
| `detail` | `page`, `full`, `outline` | `page` | `page`: the page and its properties, no blocks. `full`: adds its blocks, nested, under `children`. `outline`: its top-level blocks as `{ uuid, snippet, childCount }`, no bodies |
| `resolve_refs` | boolean | false | Adds `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s, two levels deep. Refused with `detail` `outline` |
| `format` | `json`, `markdown`, `toon` | `json` | `markdown` for `page` and `full` (plain text, about 80% smaller on a long page). `toon` for `outline` only. Any other combination is refused with an error naming the valid ones |
| `cursor` | string | | `detail` `full` only: the `nextCursor` of a cut page, passed alone (no other argument). It reads the next blocks |

**Use when:** you know the page name and want its content. For related pages and what links to it, use `logseq_explore_context`. For pages by keyword, `logseq_find_blocks` or `logseq_find_pages`.

**Returns:** `detail` `page` and `full` give the page entity. `full` adds its blocks as nested `children` (the key is absent when the page has no blocks, and also when LogSeq sent no answer for them: a `page_blocks_unavailable` warning says so, and that page is not known to be empty, so retry before you report it empty); only `outline` calls them `blocks`. `detail` `outline` gives `{ page, blocks: [{ uuid, snippet, childCount }], hasMore, warnings, totals }`: `snippet` is the first line cut to 80 characters and `childCount` counts direct children only. It costs 2 LogSeq calls however long the page is, and is about 98% smaller than `full` on a long page.

**Not found:** a missing page is an error with the closest names, so retry with one of them or use `logseq_find_pages` with `text`. A name that matches several pages comes back as `{ ambiguous: true, candidates }`: pick one by its exact name.

**A long page:** `detail` `full` has no block cap, only the 30,000-character budget (`results-and-limits.md`), and nothing pages a tree. Read the outline first.

**Example 1.** "What does my project atlas page say about the first release?" A short page, read it whole.

```json tool=logseq_get_page
{"page": "project atlas", "detail": "full"}
```

Read the nested `children` for the answer (each block has its own `children`). If `warnings` holds `result_size_truncated`, the page was longer than the budget: `hasMore` is true and `nextCursor` reads on. Call again with only that `nextCursor` as `cursor`, until it is gone. A block marked `childrenTruncated: true` continues at the top of the next page, and a block that sits under another one names it in `ancestors`. To read less, use the outline below, then `logseq_get_block` on the blocks you pick.

**Example 2.** "What's on my long meeting notes page about the budget?" Don't read it whole.

```json tool=logseq_get_page
{"page": "meeting notes", "detail": "outline", "format": "toon"}
```

Read `blocks`: each `snippet` is a first line and `childCount` says how much sits under it. Pick the blocks that look relevant. Next call: `logseq_get_block` with each chosen `uuid` and `include_children: true`.

**Example 3.** "Pull up my journal for 2025-03-14." A journal is a page, named by its ISO date.

```json tool=logseq_get_page
{"page": "2025-03-14", "detail": "full", "format": "markdown"}
```

Read the bullets (tab-indented, `((uuid))` refs kept). A `((uuid))` you want to follow is read with `logseq_get_block`, or pass `resolve_refs: true` on this call to get a `[resolved]` line under its bullet. To read a period of journals, use `logseq_explore_timeline`.

## logseq_get_block

Get one block by uuid, optionally with its children. Uuids come from other results and from `((uuid))` refs in content.

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `uuid` | string, required unless `cursor` is given | | The block's uuid. `block_uuid` is accepted for it, but send `uuid` |
| `include_children` | boolean | **false** | Adds the nested child blocks. Without it `children` are unfetched references |
| `resolve_refs` | boolean | false | Adds `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s, two levels deep |
| `format` | `json`, `markdown` | `json` | `markdown` gives a `# Block ((uuid))` heading and the block with its children as bullets |
| `cursor` | string | | With `include_children`: the `nextCursor` of a cut result, passed alone (no other argument). It reads the next blocks |

**Use when:** you have a uuid from an outline, a search hit or a `((uuid))` ref. For blocks by text, `logseq_find_blocks`. There is no lookup by numeric id.

**A cut subtree:** with `include_children`, a very large subtree is cut to the 30,000-character budget, in document order, and `nextCursor` reads on. Call again with only that `nextCursor` as `cursor`, until it is gone. A kept block that lost children carries `childrenTruncated: true`. The next page is `{ uuid, continued: true, children }` (the block's own text is not repeated): its children come first, and a block that sits below one of them names it in `ancestors`. Without `include_children` the result is one block and is never cut.

**Example 1.** "Show me the block `0088f1a0-0000-4000-8000-000000000001` and what's under it."

```json tool=logseq_get_block
{"uuid": "0088f1a0-0000-4000-8000-000000000001", "include_children": true}
```

Read `content`, then the nested `children`. If a child shows a `((uuid))` ref you need, follow it with the next call.

**Example 2.** The block above quotes another one as `((0088f1a0-0000-4000-8000-000000000002))`.

```json tool=logseq_get_block
{"uuid": "0088f1a0-0000-4000-8000-000000000002"}
```

Read the quoted text. When a page has many refs, one call with `resolve_refs: true` on the page or the block is cheaper than one `logseq_get_block` per ref.

**Example 3.** "Read the block I picked from the outline, with its sub-bullets, as text."

```json tool=logseq_get_block
{"uuid": "0088f1a0-0000-4000-8000-000000000003", "include_children": true, "resolve_refs": true, "format": "markdown"}
```

Read the bullets. A `[resolved]` line under a bullet is the text a ref points at. If a block you need to quote has `childrenTruncated: true`, fetch it again by its own uuid.

## logseq_get_current

Get what the user is looking at in LogSeq right now: the open page, the block being edited and the selected blocks. It takes no arguments.

**Use when:** the user says "this page", "this block" or "what I'm looking at" without naming it. Then pass the page name to `logseq_explore_context` or `logseq_get_page`.

**Returns:** `{ hasMore?, warnings?, message?, page, focusedBlock?, selectedBlocks? }`. `page` is `null` and `message` says so when no page is open. The result is live UI state, so two calls can differ. It takes 3 to 4 LogSeq calls. A `page_names_unavailable` warning with `page: null` means the open page couldn't be determined, which is not "no page is open": retry, or call `logseq_get_graph` to check which graph is open.

**Example 1.** "Summarize this page."

```json tool=logseq_get_current
{}
```

Read `page`: its `originalName` is the name to pass on. If `page` is `null` and a `message` says none is open, ask the user which page they mean. Next call: `logseq_explore_context` with `page` set to that name.

**Example 2.** "What did I just select?" The same call, a different part of the result.

```json tool=logseq_get_current
{}
```

Read `selectedBlocks` (and `focusedBlock` for the block being edited). Next call: `logseq_get_block` with the block's `uuid` and `include_children: true` when the selection needs its subtree.

## logseq_get_graph

Get the connected graph's name and filesystem path. It takes no arguments and answers in 1 LogSeq call.

**Use when:** confirming which graph is attached, or you need the graph's root on disk (the summary sub-skills read `logseq/config.edn` under it). It says nothing about content: for that use `logseq_find_pages` and `logseq_explore_context`. LogSeq answering `null` is an error, not an empty result.

**Example 1.** "Which graph am I connected to?"

```json tool=logseq_get_graph
{}
```

Read `name` and `path`. Next call: usually none. If the name isn't the graph the user means, say so before answering anything from it.

**Example 2.** Step 0 of a summary: take the graph root from the tool, never from memory or a note.

```json tool=logseq_get_graph
{}
```

Read `path`: it is `<graph>` in `<graph>/logseq/config.edn` and `<graph>/journals/`. Next call: the period query with `logseq_explore_timeline`, before any shell command reads the graph.
