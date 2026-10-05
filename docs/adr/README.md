# Architecture Decision Records

## Purpose

An ADR records **why we chose X**: one decision, the context that forced it, and what it costs. Accepted ADRs are history. They are never rewritten to match today's code.

How this differs from its neighbours:

- [`../business-rules/`](../business-rules/README.md) holds **what must stay true**. A rule is edited in place and has a changelog. An ADR is a dated decision and is immutable once accepted.
- [`../architecture-foundations.md`](../architecture-foundations.md) holds **principles for how to think** while changing the code. It isn't a list of decisions.

An ADR's [Mechanical enforcement](#template) section often points at a business rule that encodes the decision.

## Index

One row per slug, sorted by slug. See [Format rules](#format-rules) for what each cell must hold.

| Slug | Title | Status |
|---|---|---|

## Slug naming rule

- Short, kebab-case, lowercase: `[a-z0-9]+(-[a-z0-9]+)*`.
- Unique. The filename is the ID: `docs/adr/<slug>.md`.
- Never reused. ADR files are never deleted, even once superseded or deprecated, so a slug always names the same ADR. Cite an ADR by slug.
- No number or date prefixes. The optional `Date:` line in the Status section carries the date.

## Status vocabulary

| Status | Meaning |
|---|---|
| `proposed` | Under discussion. May be edited freely. |
| `accepted` | In force. |
| `superseded by <slug>` | Replaced by another ADR, which must exist in this directory. |
| `deprecated` | No longer applies, with no replacement. |

**Lifecycle.** An ADR is `proposed` while the PR that adds it is open. It becomes `accepted` when that PR merges: the author edits the status to `accepted` in the same PR, before merge.

An accepted ADR is **immutable except for its status and a pointer** to its replacement. Don't reword the Context, Decision or Consequences. **A reversal is a new ADR**: write it, then mark the old one `superseded by <new-slug>` in the same PR.

## Template

Copy this into `docs/adr/<slug>.md`.

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

The CI guard in #78 parses these files. These rules are exact.

1. **Slug set.** Every `*.md` file directly in this directory except `README.md`. Subdirectories and other files (such as `.gitkeep`) are ignored. The slug is the filename without `.md` and must match the slug naming rule, so an `.md` file with an uppercase name fails.
2. **Index.** The first markdown table in this README. Its first column holds `[<slug>](<slug>.md)` for each slug (plain link text, no backticks) and covers the slug set exactly, with no extra rows. The Title cell equals the text of the file's `#` heading. The Status cell is plain text (no backticks, no link) equal to the file's status line. Sorting by slug is a convention the guard doesn't check.
3. **Headings.** Each required heading is an exact, case-sensitive `## <Name>` line with no trailing whitespace, and appears exactly once: `## Context`, `## Decision`, `## Consequences`, `## Status`, `## Mechanical enforcement`. Order isn't enforced and extra headings are allowed. Lines inside fenced code blocks are ignored. The title is the file's single `#` heading.
4. **Status line.** The first non-empty line under `## Status` is exactly one of `proposed`, `accepted`, `deprecated` or `superseded by <slug>`, where `<slug>` is in the slug set. An optional `Date: YYYY-MM-DD` line may follow as the next non-empty line. It dates the last status change. Omit it if the date isn't known.
5. **Mechanical enforcement body.** At least one line or list item of the form `<tier>: <reference>`, where `<tier>` is one of `type`, `test`, `ci`, `reviewer` or `none-yet`. Other lines are ignored. Replace the template's placeholder line. The reference is:
   - `type`, `test`, `ci`: a backticked repo-relative file path or workflow, which must exist (for example ``test: `src/index.test.ts` ``).
   - `reviewer`: the checklist item, as plain text.
   - `none-yet`: an issue link, `#N` or a full URL. It should be open when written, since the issue is meant to add the mechanism. The guard accepts open or closed.

   The numbered list in the template maps to tiers 1 `type`, 2 `test`, 3 `ci`, 4 `reviewer`, 5 `none-yet`, strongest first. Prefer the strongest that applies.

## Change process

1. Open or find a GitHub issue for the decision.
2. Open a PR that adds `docs/adr/<slug>.md` and its row in the Index above, starting at status `proposed`. Before merge, edit the status to `accepted` in that same PR. To reverse an ADR, the same PR also changes the old ADR's status to `superseded by <slug>`.
3. Reviewers check each PR against the accepted ADRs and business rules. A PR that contradicts one must cite the change that allows it.

Adding an ADR, including one that supersedes another, follows this normal PR and review process. It doesn't need the maintainer's explicit OK. (Loosening or removing a *business rule* does. See [`../business-rules/`](../business-rules/README.md).)
