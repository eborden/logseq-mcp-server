# No personal graph data in committed files, posts or logs

## Statement

No personal graph data in committed files, commit messages, GitHub issues, PR descriptions or comments, or logs. The LogSeq instance this server is developed against is the maintainer's personal graph, and none of its data may leave the machine through this repo or its GitHub project. Never put any of the following in committed files (code, tests, fixtures, docs, skills, CLAUDE.md), commit messages, GitHub issues, PR descriptions or comments:
- Page names, journal titles, tags or property values from the graph.
- Block content, quotes or paraphrases of what the graph says.
- People's names (journals mention real colleagues, friends and family).
- Dates of specific journal entries, or anything that reveals what happened on a given day.
- Raw output from `scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`, `scripts/measure-output-size.ts` or integration-test runs. Their output includes real page names.

Use made-up examples instead (`"Alice"`, `"Bob"`, `"my page"`, `"project atlas"`, `"20250101"`), report measurements as approximate aggregates without names ("~2k-page graph", "a hub page with ~100 neighbours", "~120 API calls"), and write a synthetic fixture when a test needs data shaped like the real graph. Before committing or posting anything, grep the diff and text for names seen in tool output during the session. Older commits contain a few real page names that have since been replaced with fictional ones. Removing them would require rewriting history, which is the maintainer's call, not something to do on your own.

## Rationale

The repo and its GitHub project are public, and integration tests, probes and scripts read real data from the personal graph. Introduced in #20; also a hard rule in the foundations doc (#38).

## Mechanical enforcement

reviewer: The privacy grep of the diff, commit messages, PR body and review comments and replies (CLAUDE.md, Verification before merge) finds no names, content or dates from the graph.

Real names can't be listed in a repo check without publishing them. A CI guard for tracked raw-output files and a local hook that reads names at run time can enforce it without that.
none-yet: #95

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #20 |
| 2026-10-05 | Restated as a hard rule in the foundations doc. | #38 |
