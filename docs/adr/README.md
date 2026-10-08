# Architecture Decision Records

## Purpose

An ADR records **why we chose X**: one decision, the context that forced it, and what it costs. Accepted ADRs are history. They are never rewritten to match today's code.

How this differs from its neighbours:

- [`../business-rules/`](../business-rules/README.md) holds **what must stay true**. A rule is edited in place and has a changelog. An ADR is a dated decision and is immutable once accepted.
- [`../architecture-foundations.md`](../architecture-foundations.md) holds **principles for how to think** while changing the code. It isn't a list of decisions.

An ADR's [Mechanical enforcement](#template) section often points at a business rule that encodes the decision.

## Index

One row per ADR, sorted by number. See [Format rules](#format-rules) for what each cell must hold.

| ADR | Title | Status |
|---|---|---|
| [0001-read-only-server](0001-read-only-server.md) | Keep the server read-only | accepted |
| [0002-datalog-over-editor-api](0002-datalog-over-editor-api.md) | Query the graph with batched Datalog, not per-entity Editor API calls | accepted |
| [0003-no-secrets-in-source](0003-no-secrets-in-source.md) | Keep secrets out of source, logs and error messages | accepted |
| [0004-stderr-only-logging](0004-stderr-only-logging.md) | Log to stderr only, never to stdout | accepted |
| [0005-datalog-only-no-feature-flags](0005-datalog-only-no-feature-flags.md) | Ship one Datalog implementation per tool, with no feature flags | accepted |
| [0006-embed-strings-in-datalog-queries](0006-embed-strings-in-datalog-queries.md) | Embed string parameters directly in Datalog query text | superseded by 0013-strings-bound-via-in-inputs |
| [0007-two-query-pattern-for-optional-data](0007-two-query-pattern-for-optional-data.md) | Split queries when related data may be empty | accepted |
| [0008-remove-redundant-tools](0008-remove-redundant-tools.md) | Remove tools that duplicate or only partly implement another tool | accepted |
| [0009-minified-json-output](0009-minified-json-output.md) | Write tool results as minified JSON | accepted |
| [0010-slim-output-by-default](0010-slim-output-by-default.md) | Return slim results by default and keep full output as an opt-out | accepted |
| [0011-bounded-calls-and-results](0011-bounded-calls-and-results.md) | Bound every call, loop and result | accepted |
| [0012-resultmeta-for-capped-results](0012-resultmeta-for-capped-results.md) | Mark capped results with one shared ResultMeta convention | accepted |
| [0013-strings-bound-via-in-inputs](0013-strings-bound-via-in-inputs.md) | Bind Datalog string parameters with :in inputs | accepted |
| [0014-resolve-page-names-via-shared-resolver](0014-resolve-page-names-via-shared-resolver.md) | Resolve page names in every page-taking tool through one shared resolver | accepted |
| [0015-tool-descriptions-state-limits](0015-tool-descriptions-state-limits.md) | Make every tool description say what the tool can't find | accepted |
| [0016-tool-list-size-guardrails](0016-tool-list-size-guardrails.md) | Budget and snapshot the tool list that every session loads | accepted |
| [0017-manual-npm-publish](0017-manual-npm-publish.md) | Publish to npm only from a manual workflow run by the maintainer | accepted |
| [0018-ship-as-claude-code-plugin](0018-ship-as-claude-code-plugin.md) | Ship the server and skills as a Claude Code plugin with skills at the repo root | accepted |
| [0019-parse-input-at-boundary](0019-parse-input-at-boundary.md) | Parse external input at the boundary | accepted |
| [0020-additive-tool-contracts](0020-additive-tool-contracts.md) | Change tool contracts additively | accepted |
| [0021-rebase-merge-to-main](0021-rebase-merge-to-main.md) | Merge pull requests by rebase to keep atomic commits on main | accepted |
| [0022-minimum-node-22-12](0022-minimum-node-22-12.md) | Require Node 22.12 or newer | accepted |
| [0023-mit-license](0023-mit-license.md) | License the project under MIT | accepted |
| [0024-baseline-test-before-skill-edits](0024-baseline-test-before-skill-edits.md) | Baseline-test a skill before editing it | accepted |
| [0025-rust-implementation-alongside-typescript](0025-rust-implementation-alongside-typescript.md) | Explore a Rust implementation alongside TypeScript, and re-scope the process docs per toolchain | superseded by 0031-second-implementation-matches-tool-list-by-meaning |
| [0026-mutation-testing-ratchet](0026-mutation-testing-ratchet.md) | Ratchet per-file mutation scores on the unit suite | superseded by 0027-cap-mutation-cache-miss-set |
| [0027-cap-mutation-cache-miss-set](0027-cap-mutation-cache-miss-set.md) | Cap the mutation job's cache-miss set and correct its audit claim | superseded by 0028-cap-mutation-cache-miss-set-by-mutant-budget |
| [0028-cap-mutation-cache-miss-set-by-mutant-budget](0028-cap-mutation-cache-miss-set-by-mutant-budget.md) | Cap the mutation job's cache-miss set by an estimated mutant budget | superseded by 0029-mutation-cache-miss-plan-uses-the-prs-own-diff |
| [0029-mutation-cache-miss-plan-uses-the-prs-own-diff](0029-mutation-cache-miss-plan-uses-the-prs-own-diff.md) | Plan the mutation cache-miss run from the PR's own diff, and ask for a weekly run only for a left-out changed source | superseded by 0033-rust-mutation-testing-ratchet |
| [0030-nightly-check-resets-a-stale-mutation-cache](0030-nightly-check-resets-a-stale-mutation-cache.md) | Reset a stale mutation cache with a nightly check that dispatches at most one weekly run a night | deprecated |
| [0031-second-implementation-matches-tool-list-by-meaning](0031-second-implementation-matches-tool-list-by-meaning.md) | Hold a second implementation to the tools/list contract by meaning, not by bytes | accepted |
| [0033-rust-mutation-testing-ratchet](0033-rust-mutation-testing-ratchet.md) | Ratchet per-file mutation scores on the Rust crate with cargo-mutants | accepted |

## File naming rule

- The filename is `docs/adr/NNNN-<slug>.md`. `NNNN` is a four-digit, zero-padded sequence starting at `0001`. `<slug>` is short, kebab-case and lowercase. The stem (the filename without `.md`) matches `^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$`.
- **The number is the ID.** It is unique in this directory and is never changed or reused. ADR files are never deleted, even once superseded or deprecated, so a number always names the same ADR.
- **Citation.** Cite an ADR as `ADR-0007`. The slug may follow for readability: `ADR-0007 (datalog-over-editor-api)`. A `superseded by` status uses the full stem: `superseded by 0012-new-slug`.
- **Assigning numbers.** A new ADR takes the highest existing number + 1 in its PR. If another PR merges that number first, renumber on rebase before merge.
- **Backfill.** ADR-0001 to ADR-0023 were backfilled in #75, numbered in order of each ADR's earliest cited commit, issue or PR, with ties broken by slug (decision on #73). So a number is not a decision date; the Status `Date:` line is. A backfill records decisions already in force, so those ADRs were added as `accepted` rather than going through `proposed` (see Lifecycle).
- The optional `Date:` line in the Status section carries the date. Filenames have no date.

## Status vocabulary

| Status | Meaning |
|---|---|
| `proposed` | Under discussion. May be edited freely. |
| `accepted` | In force. |
| `superseded by <NNNN-slug>` | Replaced by another ADR, named by its full stem, which must exist in this directory. |
| `deprecated` | No longer applies, with no replacement. |

**Lifecycle.** An ADR is `proposed` while the PR that adds it is open. It becomes `accepted` when that PR merges: the author edits the status to `accepted` in the same PR, before merge.

An accepted ADR is **immutable**, with three exceptions:

1. Its **status and a pointer** to its replacement.
2. A citation of a file that has since been deleted. The citation may be rewritten in place as a pinned `<commit>:<path>` reference to the file's last version (for example `` `df7503a:docs/datalog-debugging-summary.md` ``, readable with `git show`), with no other rewording.
3. The **Mechanical enforcement** section, which may be updated in place, for example when a `none-yet` issue lands its guard and the line becomes `test:` or `ci:`. That section records how the decision is currently enforced, not the decision itself. A PR that adds or strengthens enforcement (on ADRs, and on business rules too), and changes no other ADR or business-rule content, needs no maintainer approval. Adding or strengthening means `none-yet` to `test:` or `ci:`, a new `type:`, `test:` or `ci:` line, or a stronger tier (the order is in the [Template](#template)). Dropping a `none-yet` line only because a guard for that same issue replaced it counts as strengthening. Removing or weakening enforcement (any other dropped line, a weaker tier, or back to `none-yet`) still needs approval, like any other ADR change (see Change process).

Don't reword the Context, Decision or Consequences. **A reversal is a new ADR**: write it, then mark the old one `superseded by <NNNN-new-slug>` in the same PR.

## Template

Copy this into `docs/adr/NNNN-<slug>.md`.

````markdown
# <Title: the decision, in a few words>

## Context

What forced a choice? The constraints, the alternatives considered, and the issue or PR that raised it. No graph data (see CLAUDE.md, Privacy).

## Decision

What we chose, in the active voice: "We bind strings with `:in`."

## Consequences

What gets easier, what gets harder, and what we accept. Include the costs.

## Status

proposed

Date: YYYY-MM-DD

## Mechanical enforcement

How this decision is kept from being silently reversed, without relying on an agent remembering it. Name the strongest mechanism that applies, in this order of preference:

1. Type or schema (illegal state unrepresentable) [tier `type`]
2. Test or snapshot, named by file [tier `test`]
3. CI check, lint or hook, named by file or workflow [tier `ci`]
4. Reviewer checklist item (weakest; human/agent judgment) [tier `reviewer`]
5. None yet: must link an open issue that adds a mechanism [tier `none-yet`]

Replace this guidance with the line below. The guard reads only `<tier>: <reference>` lines (see Format rules).

<tier>: <reference>

Usually this is a guard test, or a business rule in `docs/business-rules/` that encodes the decision and names its own enforcement.
````

## Format rules

The CI guard, `tests/guards/docs-format.test.ts` (#78), parses these files with `scripts/docs-format.ts`. These rules are exact. To check locally, run `npx tsx scripts/docs-format.ts`.

1. **Stem set.** Every `*.md` file directly in this directory except `README.md`. Subdirectories and other files (such as `.gitkeep`) are ignored. The stem is the filename without `.md` and must match `^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$`, so an `.md` file with an uppercase name or no number fails. No two stems share a number.
2. **Index.** The first markdown table in this README. Its first column holds `[<NNNN-slug>](<NNNN-slug>.md)` for each stem (plain link text, no backticks) and covers the stem set exactly, with no extra rows. The Title cell equals the text of the file's `#` heading. The Status cell is plain text (no backticks, no link) equal to the file's status line. Sorting by number is a convention the guard doesn't check. Every row of a table the guard reads, including the header and delimiter rows, starts with `|`. A table without leading pipes isn't read as a table.
3. **Headings.** Each required heading is an exact, case-sensitive `## <Name>` line with no trailing whitespace, and appears exactly once: `## Context`, `## Decision`, `## Consequences`, `## Status`, `## Mechanical enforcement`. Order isn't enforced and extra headings are allowed. Lines inside fenced code blocks are ignored. The title is the file's single `#` heading.
4. **Status line.** The first non-empty line under `## Status` is exactly one of `proposed`, `accepted`, `deprecated` or `superseded by <NNNN-slug>`, where `<NNNN-slug>` is in the stem set. An optional `Date: YYYY-MM-DD` line may follow as the next non-empty line. It dates the last status change. Omit it if the date isn't known.
5. **Mechanical enforcement body.** At least one line or list item of the form `<tier>: <reference>`. `<tier>` is one of `type`, `test`, `ci`, `reviewer` or `none-yet`, in plain lowercase, followed by a colon, a space and a non-empty reference. Replace the template's placeholder line. Other lines are ignored, except two kinds of broken tier line, which are errors:
   - A line that starts with the exact tier and a colon but doesn't parse, such as `test:` with no space after the colon, or a `reviewer:` with nothing after it.
   - A list item whose leading word, ignoring `**`, `__` or backticks around it, is a tier or `none yet` in any case, such as `- Test:`, `- **test:**` or ``- `ci`:``.

   The reference is:
   - `type`, `test`, `ci`: a backticked repo-relative file path, which must exist (for example ``test: `rust/src/server.rs` ``). A workflow is named by its file path (for example ``ci: `.github/workflows/ci.yml` ``). Explanatory text may follow the path. Any further backticked span on the line that is a file path must exist too. A span counts as a file path when it has a directory and its last segment has an extension, such as `rust/src/meta.rs`. Other spans, such as `:block/name`, `Issue/PR` or `ResultMeta`, are prose.
   - `reviewer`: the checklist item, as plain text.
   - `none-yet`: an issue, written as `#N`, as `https://github.com/<owner>/<repo>/issues/N`, or as a markdown link to that URL. Explanatory text may follow it (for example `none-yet: #61 (adds a cap test)`). The issue should be open when written, since it is meant to add the mechanism. The guard checks only the form. It accepts open or closed issues and doesn't call GitHub.

   The numbered list in the template maps to tiers 1 `type`, 2 `test`, 3 `ci`, 4 `reviewer`, 5 `none-yet`, strongest first. Prefer the strongest that applies.
6. **Links.** Every relative markdown link in these files and in this README resolves to a file or directory in the repo, matched case-sensitively. A `#fragment` isn't checked. Links inside fenced code blocks and code spans are skipped, and so are external URLs (such as `https:` and `mailto:`) and same-file `#anchor` links.

## Change process

1. Open or find a GitHub issue for the decision.
2. Open a PR that adds `docs/adr/NNNN-<slug>.md` (see [Assigning numbers](#file-naming-rule)) and its row in the Index above, starting at status `proposed`. Before merge, edit the status to `accepted` in that same PR. To reverse an ADR, the same PR also changes the old ADR's status to `superseded by <NNNN-slug>`.
3. Reviewers check each PR against the accepted ADRs and business rules. A PR that contradicts one must cite the change that allows it.

**Approval gate.** Any PR that adds, changes, supersedes or retires an ADR or business-rule file needs the maintainer's explicit approval before merge, except a PR that adds or strengthens Mechanical enforcement lines on ADRs and business rules, and changes no other ADR or business-rule content (Lifecycle exception 3). Removing or weakening enforcement, and any other content change, still needs approval. Record the approval like this. Before merging, a PR comment records the maintainer's approval: either the maintainer writes it, or Claude posts it, quoting the maintainer's approval message verbatim with its date. The Changelog row's Issue/PR column cites that PR. If the maintainer merges the PR themselves, the merge is the record.
