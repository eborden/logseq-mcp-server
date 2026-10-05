# Business Rules

## Purpose

A business rule states **what must stay true** about this server: a behaviour, constraint or contract that code and agents must not break. Each rule is edited in place, and its Changelog table records when it changed and why.

How this differs from its neighbours:

- [`../adr/`](../adr/README.md) holds **why we chose X**. An ADR is a dated decision and is immutable once accepted. A rule can be reworded as long as the Changelog says so.
- [`../architecture-foundations.md`](../architecture-foundations.md) holds **principles for how to think** while changing the code. A principle that must never be violated belongs here as a rule, with a [Mechanical enforcement](#template) section.

## Index

One row per slug, sorted by slug. See [Format rules](#format-rules) for what each cell must hold.

| Slug | Summary |
|---|---|

## Slug naming rule

- Short, kebab-case, lowercase: `[a-z0-9]+(-[a-z0-9]+)*`.
- Unique. The filename is the ID: `docs/business-rules/<slug>.md`.
- Never reused. Rule files are never deleted, even once retired, so a slug always names the same rule. Cite a rule by slug.

## Status vocabulary

Rules have no status field. A rule in this directory is in force unless it is retired, and it is **edited in place**. Every edit adds a row to the file's Changelog table.

**Retiring a rule.** Don't delete the file. Mark it retired: make the first non-empty line under `## Statement` read `Retired.`, keep the original text below it, add a Changelog row (change: `Retired.`) that cites the approving PR (the maintainer's approval, per Change process), and start the Index summary with `Retired.`. The Index row stays, because every file needs a row. Since files are never deleted, a slug can't be reused, so no history-aware reuse check is needed.

## Template

Copy this into `docs/business-rules/<slug>.md`.

````markdown
# <Title: the rule, in a few words>

## Statement

What must stay true, in one or two sentences, using "must" or "never". Stay precise enough that a reviewer can decide whether a diff breaks it.

## Rationale

Why the rule exists: the failure it prevents, and the issue, PR or ADR it came from. No graph data (see CLAUDE.md, Privacy).

## Mechanical enforcement

How we make sure this holds without relying on an agent remembering it, and what stops drift. Name the strongest mechanism that applies, in this order of preference:

1. Type or schema (illegal state unrepresentable) [tier `type`]
2. Test or snapshot, named by file [tier `test`]
3. CI check, lint or hook, named by file or workflow [tier `ci`]
4. Reviewer checklist item (weakest; human/agent judgment) [tier `reviewer`]
5. None yet: must link an open issue that adds a mechanism [tier `none-yet`]

Replace this guidance with the line below. The guard reads only `<tier>: <reference>` lines (see Format rules).

<tier>: <reference>

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| YYYY-MM-DD | Introduced. | #N |
````

## Format rules

The CI guard in #78 parses these files. These rules are exact.

1. **Slug set.** Every `*.md` file directly in this directory except `README.md`. Subdirectories and other files (such as `.gitkeep`) are ignored. The slug is the filename without `.md` and must match the slug naming rule, so an `.md` file with an uppercase name fails.
2. **Index.** The first markdown table in this README. Its first column holds `[<slug>](<slug>.md)` for each slug (plain link text, no backticks) and covers the slug set exactly, with no extra rows. The Summary cell is one line of free text that the guard doesn't check. Sorting by slug is a convention the guard doesn't check.
3. **Headings.** Each required heading is an exact, case-sensitive `## <Name>` line with no trailing whitespace, and appears exactly once: `## Statement`, `## Rationale`, `## Mechanical enforcement`, `## Changelog`. Order isn't enforced and extra headings are allowed. Lines inside fenced code blocks are ignored. The title is the file's single `#` heading.
4. **Changelog.** The first markdown table under `## Changelog` has the columns Date, Change and Issue/PR, and at least one row besides the header and delimiter rows. A retired rule's last row cites the approving PR, the same as every other row.
5. **Mechanical enforcement body.** At least one line or list item of the form `<tier>: <reference>`, where `<tier>` is one of `type`, `test`, `ci`, `reviewer` or `none-yet`. Other lines are ignored. Replace the template's placeholder line. The reference is:
   - `type`, `test`, `ci`: a backticked repo-relative file path or workflow, which must exist (for example ``test: `src/index.test.ts` ``).
   - `reviewer`: the checklist item, as plain text.
   - `none-yet`: an issue link, `#N` or a full URL. It should be open when written, since the issue is meant to add the mechanism. The guard accepts open or closed.

   The numbered list in the template maps to tiers 1 `type`, 2 `test`, 3 `ci`, 4 `reviewer`, 5 `none-yet`, strongest first. Prefer the strongest that applies.

## Change process

1. Open or find a GitHub issue for the rule.
2. Open a PR with the file change **and a new Changelog row** (date, what changed, issue or PR). For a new rule, also add its Index row.
3. Reviewers check each PR against the accepted ADRs and business rules. A PR that contradicts one must cite the change that allows it.

**Approval gate.** Any PR that adds, changes, supersedes or retires an ADR or business-rule file needs the maintainer's explicit approval before merge. Record the approval like this. Before merging, a PR comment records the maintainer's approval: either the maintainer writes it, or Claude posts it, quoting the maintainer's approval message verbatim with its date. The Changelog row's Issue/PR column cites that PR. If the maintainer merges the PR themselves, the merge is the record.

Every Changelog row cites the approving PR, and the approval is the maintainer's.
