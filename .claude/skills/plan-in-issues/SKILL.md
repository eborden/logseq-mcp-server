---
name: plan-in-issues
description: 'Use when planning multi-part work, filing an issue or PR, splitting work into sub-issues, or setting blocked-by edges or board status.'
---

# Plan in issues

Work is tracked in GitHub issues and the [LogSeq MCP Workflow](https://github.com/users/eborden/projects/1) project board. The two sections below moved here from CLAUDE.md ("Development Workflow") with their text unchanged; only the heading levels and the relative link paths changed.

## Issue and PR templates
Templates live in `.github/` and are the source of truth for what an issue or PR body contains. Blank issues are off. `gh` applies a template only in its interactive flow (picked by the front-matter name), so agents fill the body to match and pass it with `--body-file`.

| Kind | Template | Label | Use for |
|---|---|---|---|
| Task | [`task.md`](../../../.github/ISSUE_TEMPLATE/task.md) | `task` | A bounded change a subagent implements. The issue is its whole brief: context, scope, out of scope, files, constraints, acceptance, verification, open questions, Definition of Ready |
| Bug | [`bug.md`](../../../.github/ISSUE_TEMPLATE/bug.md) | `bug` | Misbehaviour, reproduced on the fixture graph, never the personal one |
| Plan | [`plan.md`](../../../.github/ISSUE_TEMPLATE/plan.md) | `plan` | A parent: goal, decisions, non-goals, current state, exit criteria |
| Proposal | [`proposal.md`](../../../.github/ISSUE_TEMPLATE/proposal.md) | `proposal` | A new or changed ADR or business rule. Merging its PR needs the maintainer's OK |
| Pull request | [`pull_request_template.md`](../../../.github/pull_request_template.md) | | The handoff from [`docs/architecture-foundations.md`](../../../docs/architecture-foundations.md) section 6, plus the author-attested verification and the conditional rows |

- Sub-issues and "blocked by" edges are set in GitHub (next section), never listed in the issue body.
- A subagent that finds a Ready issue ambiguous, or its premise wrong, comments on the issue instead of starting (the "Open questions" section; foundations section 0).
- Subagents pass `--body-file` filled from the template, since `gh` skips templates when given `--body`. A guard test (`tests/guards/github-templates.test.ts`) keeps the templates and these links in step.

## Plans live in issues
- Write a plan as GitHub issues, not as a file in `docs/plans/` and not only in the conversation. (Plans aren't kept in `docs/`. Git history holds the old ones.)
- Split anything multi-part into sub-issues linked to a parent. Record sequencing (waves, dependencies) in the parent or a comment on it. Close the parent when its sub-issues are done.
- Sequence in waves so at most one open PR touches a given file area. Guardrails and conventions first, features next, output-wide changes last.
- Add new issues to the board: *Backlog*, or *Ready* once the maintainer has approved the plan. When a plan changes, edit the issues (scope comments, new sub-issues, close obsolete ones).
- **Hard ordering uses GitHub issue dependencies.** If B can't start until A merges (file overlap, needs A's code, or a migration order), mark B **blocked by** A and record why in a comment. The edges are the source of truth. A wave list in a comment can summarise the plan, but when a plan changes, update the edges too. Waves are a summary of the edges, not a substitute.
  ```bash
  gh api repos/eborden/logseq-mcp-server/issues/<A> --jq .id    # A's REST id (not its number)
  gh api -X POST repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by -F issue_id=<A's REST id>
  gh api repos/eborden/logseq-mcp-server/issues/<B>/dependencies/blocked_by --jq 'map(select(.state=="open") | .number)'    # list B's open blockers
  ```
- **Grouping uses sub-issues.** A multi-part plan is a parent with sub-issues, as above.
