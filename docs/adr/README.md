# Architecture Decision Records

## Purpose

An ADR records **why we chose X**: one decision, the context that forced it, and what it costs. Accepted ADRs are history. They are never rewritten to match today's code.

How this differs from its neighbours:

- [`../business-rules/`](../business-rules/README.md) holds **what must stay true**. A rule is edited in place and has a changelog. An ADR is a dated decision and is immutable once accepted.
- [`../architecture-foundations.md`](../architecture-foundations.md) holds **principles for how to think** while changing the code. It isn't a list of decisions.

An ADR's [Mechanical enforcement](#template) section often points at a business rule that encodes the decision.

## Index

One row per file in this directory (except this README), sorted by slug. Link text is the slug and the target is `<slug>.md`. The status is the exact text of the file's `## Status` line.

| Slug | Title | Status |
|---|---|---|

## Slug naming rule

- Short, kebab-case, lowercase: `[a-z0-9]+(-[a-z0-9]+)*`.
- Unique. The filename is the ID: `docs/adr/<slug>.md`.
- Never reused, even after the ADR is superseded or deprecated. Cite an ADR by slug.
- No number or date prefixes. The file's Status section carries the date.

## Status vocabulary

The first line of the `## Status` section is exactly one of:

| Status | Meaning |
|---|---|
| `proposed` | Under discussion. May be edited freely. |
| `accepted` | In force. |
| `superseded by <slug>` | Replaced by another ADR, which must exist in this directory. |
| `deprecated` | No longer applies, with no replacement. |

An accepted ADR is **immutable except for its status and a pointer** to its replacement. Don't reword the Context, Decision or Consequences. **A reversal is a new ADR**: write it, then mark the old one `superseded by <new-slug>` in the same PR.

The line after the status may be `Date: YYYY-MM-DD` taken from git or the issue. Write `Date: undated` rather than guess.

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

1. Type or schema (illegal state unrepresentable)
2. Test or snapshot, named by file
3. CI check, lint or hook, named by file or workflow
4. Reviewer checklist item (weakest; human/agent judgment)
5. None yet: must link an open issue that adds a mechanism

Usually this is a guard test, or a business rule in `docs/business-rules/` that encodes the decision and names its own enforcement.
````

**Required headings** (exact `##` lines, checked by the CI guard in #78):

- `## Context`
- `## Decision`
- `## Consequences`
- `## Status`
- `## Mechanical enforcement`

The title is the single `#` heading. Any extra headings are allowed.

## Change process

1. Open or find a GitHub issue for the decision.
2. Open a PR that adds `docs/adr/<slug>.md` and its row in the Index above. To reverse an ADR, the same PR also changes the old ADR's status to `superseded by <slug>`.
3. Reviewers check each PR against the accepted ADRs, and the PR cites the ADR it follows or replaces.

Adding an ADR doesn't need the maintainer's explicit OK. Reversing an accepted ADR does, because it changes a decision the maintainer already made.
