# Log to stderr only, never to stdout

## Context

The server talks to its MCP client over the stdio transport, which uses stdout as the protocol channel. Issue #82: "any `console.log` or `process.stdout.write` in the server corrupts the stream."

The server has logged with `console.error` since the first commit that added it (c8a9301, 2025-11-20: the startup message and fatal errors). The rule was first written down on 2026-10-05, in CLAUDE.md's Common Gotchas (commit 33a038a, PR #19) and in the foundations doc (PR #38, section 4.9), which adds that logging is sparing and never includes graph data (hard rule 6). The Status date is when it was written down.

## Decision

Nothing in the server writes to stdout. We log with `console.error`, sparingly, and never log block content, page names or other graph data.

## Consequences

- The protocol stream carries only protocol messages.
- Diagnostics go to stderr. Inferred: whether a user sees them depends on the MCP client, so an error that matters to the caller goes in the tool result, not only in a log.
- Nothing enforces this yet. One `console.log` in a new code path would corrupt the stream for every call that reaches it. Issue #82 tracks a guard.
- The guard in #82 would catch stdout writes, not what a `console.error` line contains. Keeping graph data out of logs rests on review.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- reviewer: No console.log, console.info, console.debug or process.stdout write in src outside tests.
- reviewer: No log line includes block content, page names or other graph data.
- none-yet: #82 (stdout guard)

Not mechanised yet, and no issue is open for it: a check on what log lines contain. That stays reviewer-only.
