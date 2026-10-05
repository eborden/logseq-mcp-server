# Business Rules

## Purpose

A business rule states **what must stay true** about this server: a behaviour, constraint or contract that code and agents must not break. Each rule is edited in place, and its Changelog table records when it changed and why.

How this differs from its neighbours:

- [`../adr/`](../adr/README.md) holds **why we chose X**. An ADR is a dated decision and is immutable once accepted. A rule can be reworded as long as the Changelog says so.
- [`../architecture-foundations.md`](../architecture-foundations.md) holds **principles for how to think** while changing the code. A principle that must never be violated belongs here as a rule, with a [Mechanical enforcement](#template) section.

## Index

One row per file in this directory (except this README), sorted by slug. Link text is the slug and the target is `<slug>.md`. The summary is one line.

| Slug | Summary |
|---|---|

## Slug naming rule

- Short, kebab-case, lowercase: `[a-z0-9]+(-[a-z0-9]+)*`.
- Unique. The filename is the ID: `docs/business-rules/<slug>.md`.
- Never reused, even after a rule is retired. Cite a rule by slug.

## Status vocabulary

Rules have no status field. A rule in this directory is in force, and it is **edited in place**. Every edit adds a row to the file's Changelog table.

To retire a rule, delete the file and its Index row in a PR. Record why in the PR description. Git history keeps the file and the slug stays reserved.

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

1. Type or schema (illegal state unrepresentable)
2. Test or snapshot, named by file
3. CI check, lint or hook, named by file or workflow
4. Reviewer checklist item (weakest; human/agent judgment)
5. None yet: must link an open issue that adds a mechanism

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| YYYY-MM-DD | Introduced. | #N |
````

**Required headings** (exact `##` lines, checked by the CI guard in #78):

- `## Statement`
- `## Rationale`
- `## Mechanical enforcement`
- `## Changelog`

The Changelog table needs at least one row. The title is the single `#` heading. Any extra headings are allowed.

## Change process

1. Open or find a GitHub issue for the rule.
2. Open a PR with the file change **and a new Changelog row** (date, what changed, issue or PR). For a new rule, also add its Index row.
3. Reviewers check each PR against the accepted ADRs and these rules. A PR that contradicts one must cite the change that allows it.

Adding a rule doesn't need the maintainer's explicit OK. **Loosening or removing a rule does**: record the maintainer's OK in the issue or PR, and cite it in the Changelog row.
