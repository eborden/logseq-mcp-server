# No personal graph data in committed files, posts or logs

## Statement

No personal graph data in committed files, commit messages, GitHub issues, PR descriptions or comments, or logs. The LogSeq instance this server is developed against is the maintainer's personal graph, and none of its data may leave the machine through this repo or its GitHub project. Never put any of the following in committed files (code, tests, fixtures, docs, skills, CLAUDE.md), commit messages, GitHub issues, PR descriptions or comments:
- Page names, journal titles, tags or property values from the graph.
- Block content, quotes or paraphrases of what the graph says.
- People's names (journals mention real colleagues, friends and family).
- Dates of specific journal entries, or anything that reveals what happened on a given day.
- Raw output from `scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`, `scripts/measure-output-size.ts` or any integration-test run against a non-fixture instance. Their output includes real page names.

One case is allowed: bounded output (test names, counts, assertion messages) from a run against the committed fixture graph (`tests/fixtures/graph/`), because every value in it is fictional. It is a bounded failure summary, never a pasted suite log or raw script output, and what a tool posts passes the orchestrator's sanitiser (length bound, no raw suite log). A run counts as a fixture run only when it started the fixture instance itself (`scripts/logseq-instance.ts`) and the suite ran under `connectFixture()`; a run pointed at any other instance, by `LOGSEQ_MCP_CONFIG` or otherwise, is a non-fixture run.

Use made-up examples instead (`"Alice"`, `"Bob"`, `"my page"`, `"project atlas"`, `"20250101"`), report measurements as approximate aggregates without names ("~2k-page graph", "a hub page with ~100 neighbours", "~120 API calls"), and write a synthetic fixture when a test needs data shaped like the real graph. Before committing or posting anything, grep the diff and text for names seen in tool output during the session. Older commits contain a few real page names that have since been replaced with fictional ones. Removing them would require rewriting history, which is the maintainer's call, not something to do on your own.

## Rationale

The repo and its GitHub project are public, and some paths still reach real data from the personal graph. The integration tests and `scripts/probe-constraints.ts` run against the fixture instance by default, and both refuse a config on port 12315 (#90). The paths that remain: the `scripts/measure-*.ts` scripts, which read the real graph by explicit choice as the documented baseline; `scripts/probe-constraints.ts`, only when `LOGSEQ_MCP_CONFIG` points it at a personal instance on another port; and normal sessions that use the MCP tools on the real graph. The tests refuse only port 12315, so a `LOGSEQ_MCP_CONFIG` that points a run at a personal instance on another port would still produce real page names. That is why the allowance for a fixture run depends on proving the run was on the fixture, not on the kind of command. A remote fixer needs a failed host run's test names, counts and assertion messages to act on, and posting them is safe when they come from the fixture. Introduced in #20; also a hard rule in the foundations doc (#38).

## Mechanical enforcement

- test: `tests/guards/repo-hygiene.test.ts` (fails when a raw-output file from the integration tests or the probe and measure scripts is tracked, or when .gitignore stops ignoring one)
- reviewer: The privacy grep of the diff, commit messages, PR body and review comments and replies (CLAUDE.md, Verification before merge) finds no names, content or dates from the graph. This stays the fallback for names typed into code, docs or GitHub text, which the test can't see.

Real names can't be listed in a repo check without publishing them. A local hook that reads names from the graph at run time can check diffs and GitHub text without that.

- none-yet: #98 (local hook)
- none-yet: #643 (the host integration activity's fixture-only check, named by the task that routes a failure to a fixer; an unsound claim of "fixture" is the failure this rule must still catch)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #20 |
| 2026-10-05 | Restated as a hard rule in the foundations doc. | #38 |
| 2026-10-05 | Enforcement: the tracked raw-output test replaces `none-yet: #95`, the reviewer step stays as the fallback, and the local hook is tracked as `none-yet: #98`. | #99, #103 |
| 2026-10-06 | Rationale only: the integration tests and the probe no longer read the personal graph, so it names the paths that still can. Statement unchanged. | #158 |
| 2026-10-08 | Mechanical enforcement: the test that checks tracked raw-output files moved from `src/` to `tests/guards/` with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-18 | Statement narrowed: bounded output (test names, counts, assertion messages) from a run against the committed fixture graph may be posted; raw output of the probe, the measure scripts and any non-fixture integration run stays forbidden. Added `none-yet: #643` for the fixture-only check. Needs the maintainer's OK before merge. | #669, #685 |
