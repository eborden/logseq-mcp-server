# Name tools by four types (get, find, explore, check) with one parameter vocabulary, in a v2.0.0 hard cut

## Context

The 16 tools grew one capability at a time. Their names mix five verbs (`get`, `list`, `search`, `query`, `build`), the same input has three names (`page_name`, `topic_name`, `concept_name`), and several tools return the same data in different shapes. A review of how a model actually uses them (local Claude Code transcripts, approximate aggregates, no graph data) found:

- About 200 calls in non-dev sessions. Lookup, keyword search, page reads and date ranges carry nearly all of them.
- 4 tools were never called outside dev sessions: `search_by_relationship`, `get_context_for_query`, `get_page_outline` and `get_block`.
- The graph tools mostly failed when they were called. `get_concept_network` (3 of 8 calls), `get_backlinks` (2 of 2) and `get_concept_evolution` (1 of 2) returned 50k to 110k characters, past the host's MCP output limit, so the model saw only an error. The size limit is #485.
- 3 calls failed on guessed parameter names (`topic`, `concept`, `property_name`), each one a word taken from the tool's own name or description.
- The server instructions route only to lookup, search and journals, and the skills use a second, different grouping of six categories.

The parent plan is #500, and this ADR is its #484.

[ADR-0020 (additive-tool-contracts)](0020-additive-tool-contracts.md) and [BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md) allow a rename or removal with "an explicit decision and a migration note". This ADR is the decision, and the v2.0.0 release notes carry the migration note (#499). It supersedes nothing. [ADR-0008 (remove-redundant-tools)](0008-remove-redundant-tools.md) says its removals are not a precedent, and that holds: this goes through ADR-0020's path rather than around it.

Options considered:

| Option | Pros | Cons / cost |
|---|---|---|
| Keep v1 names; fix only parameter aliases, instructions and size limits | No contract break | The noise stays, and overlapping tools keep competing for the same questions |
| Rename and merge in one major release (v2.0.0), a hard cut | One clean surface; the tool list shrinks; skills and server move together in one plugin | Breaks v1 callers. The maintainer confirms there are none yet (v1.0.0 shipped 2026-10-10) |
| v2 names alongside v1, with a deprecation window | Old callers keep working | Doubles the tool list past the [ADR-0016 (tool-list-size-guardrails)](0016-tool-list-size-guardrails.md) budget (19,383 of 19,700 characters used today), and the model has twice as many tools to choose from |

## Decision

We rename and merge the tools in v2.0.0 as a hard cut, with no deprecation window (maintainer decision, 2026-10-12).

**Four tool types.** A type is chosen by what the caller already has, not by subject:

| Type | When | Returns |
|---|---|---|
| `get` | The caller knows which thing: a page name, a block uuid, "the one that's open" | That one thing, or not-found with suggestions. Never a list |
| `find` | The caller knows criteria, not the thing | A flat list of pages or blocks, paged with `limit` and `offset`, with `ResultMeta` ([BR-0006 (no-silent-truncation)](../business-rules/0006-no-silent-truncation.md)) |
| `explore` | The caller has a starting point and wants what surrounds it: what is said about it, how it connects, how it changed | A structured result built for synthesis, bounded in characters as well as counts ([ADR-0011 (bounded-calls-and-results)](0011-bounded-calls-and-results.md), #485) |
| `check` | The caller is about to write to the graph | A verdict on a proposed change. Still read-only ([BR-0002 (tools-read-only)](../business-rules/0002-tools-read-only.md)) |

Boundary test: if the answer is a list of hits, it is `find`. If it is what something is, how it connects or how it changed, it is `explore`.

**Names** follow `logseq_<type>_<object>`. Each description opens with the type verb ("Get…", "Find…", "Explore…", "Check…") and keeps its "Can't find" line ([ADR-0015 (tool-descriptions-state-limits)](0015-tool-descriptions-state-limits.md)).

**The v2 surface (10 tools):**

| Type | Tool | Takes | Replaces |
|---|---|---|---|
| get | `logseq_get_page` | `page`, `detail` (`page` / `outline` / `full`), `resolve_refs`, `format` | `get_page`, `get_page_outline` |
| get | `logseq_get_block` | `uuid`, `include_children`, `resolve_refs`, `format` | `get_block` |
| get | `logseq_get_current` | nothing | `get_current_context` |
| get | `logseq_get_graph` | nothing | `get_graph_info` |
| find | `logseq_find_pages` | `text`, `names`, `property` + `value`, `limit`, `offset`, `format` | `list_pages` |
| find | `logseq_find_blocks` | `text`, `page`, `links_to`, `property` + `value`, period, `limit`, `offset`, `include_context`, `slim_results` | `search_blocks`, `query_by_property`, the `references` mode of `search_by_relationship` |
| explore | `logseq_explore_context` | `page`, its caps, `references_offset`, `resolve_refs`, `format`, `compact` | `build_context`, `get_backlinks`, `get_context_for_query` |
| explore | `logseq_explore_network` | `page`, `to`, `max_depth`, `max_nodes`, `max_fanout`, `expand_journals`, `format` | `get_concept_network`, the `connected-within` mode of `search_by_relationship` |
| explore | `logseq_explore_timeline` | `page`, period, `group_by`, `max_blocks`, `top_concepts_limit`, `include_content`, `slim_results`, `resolve_refs` | `query_by_date_range`, `get_concept_evolution` |
| check | `logseq_check_links` | `before`, `after` | `check_links` (unchanged) |

Dropped on purpose:

- Multi-topic context (`get_context_for_query`). The model calls `explore_context` in parallel instead, and each answer is smaller.
- The `referenced-by` and `in-pages-linking-to` modes of `search_by_relationship`, which were never used outside dev sessions.

**One parameter vocabulary:**

- `page`: any page-name input, resolved by `require_page` ([BR-0010 (page-names-resolved-via-resolver)](../business-rules/0010-page-names-resolved-via-resolver.md)). On `find_blocks` it scopes the search to that page. `to` names a second page.
- `uuid` for a block. `text` for a case-insensitive literal match. `links_to` for a list of pages a block must link to. `property` + `value` for properties.
- Period: `start_date` + `end_date`, `last_n` or `preset` (exactly one), shared by `find_blocks` and `explore_timeline`.
- `limit` + `offset` page the main list of every `find` tool.

**Aliases ([BR-0008 (param-aliases-best-effort)](../business-rules/0008-param-aliases-best-effort.md)):** `name` and `page_name` for `page`, and `block_uuid` for `uuid`. There are no `topic`, `concept` or `property_name` aliases: those guesses came from words in the v1 names and descriptions, which v2 removes. An alias is added later only if the re-scan in #500's exit criteria shows a specific wrong guess.

A future tool must fit exactly one of the four types, or it needs a new ADR.

## Consequences

- Easier: the tool list gets smaller and shrinks against the ADR-0016 budget (#499 lowers it). A model can choose a type before it chooses a tool. Skills, instructions and descriptions share one vocabulary.
- Harder: every v1 caller breaks once. Every parity group file, call ceiling and recorded `tools/list` entry is renamed, so each merge PR is a golden change that needs the maintainer's `golden-change` label.
- Touches: `rust/src/tools/*`, `rust/src/tools/mod.rs`, `rust/src/instructions.rs`, `rust/src/prompts.rs`, `rust/tests/data/parity/*`, the guards, the integration helpers, the measure and smoke scripts, the skills and CLAUDE.md.
- The renames land one at a time in the order set by #500, because each edits the same shared files. Until the last one merges, `main` holds a mix of v1 and v2 names, so no release is cut part-way through.
- The `find` / `explore` verbs are a judgment call, not a measured one. The routing eval (#487) tests them, and a find/explore confusion there reopens the choice.

## Status

proposed

Date: 2026-10-12

## Mechanical enforcement

- none-yet: #488 (a guard over the recorded `tools/list`: name pattern, description verb, no v1 parameter names; a v1 allowlist that shrinks to empty as each rename lands)
- reviewer: a new tool fits exactly one type and uses the shared parameter vocabulary
