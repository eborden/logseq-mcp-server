# Keep secrets out of source, logs and error messages

## Context

The repository is public (CLAUDE.md, Privacy). The server needs one secret, the LogSeq API token, and the release workflow needs another, the npm token.

- The LogSeq token has come from `~/.logseq-mcp/config.json`, outside the repository, since the server's first commit (c8a9301). The plugin manifest carries no secrets for the same reason ([ADR-0018 (ship-as-claude-code-plugin)](0018-ship-as-claude-code-plugin.md)).
- Issue #8 asked for an actionable error on a rejected token, and PR #26 added `LogSeqAuthError`. What that error says is recorded in CLAUDE.md, Common Gotchas, "HTTP API behaviour".
- The npm token is the `NPM_TOKEN` repository secret, read only by `.github/workflows/publish.yml` (issue #46, PR #70).
- The foundations doc (PR #38) wrote the rule down as hard rule 6: "No secrets in source, and no personal graph data in committed files or logs."

Inferred, not recorded: a token in a public repository, a log or an error message pasted into an issue is a leak that can't be taken back.

## Decision

No token, key or password appears in source, fixtures, logs or error messages. Credentials come from the config file outside the repository or from repository secrets. Tests use obviously fake values.

The graph-data half of hard rule 6 is a promise to the user, kept in the business rule [BR-0001 (no-graph-data-in-repo)](../business-rules/0001-no-graph-data-in-repo.md) (PR #84).

## Consequences

- Error messages point at the config field to fix (`authToken`).
- Nothing scans commits for secrets, so a pasted token is caught only by review.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/client.test.ts` (the LogSeqAuthError message never includes the token)
- test: `src/index.test.ts` (the same through the MCP caller)
- reviewer: No token, key or password appears in a diff, fixture, log line or error message.

Not mechanised yet, and no issue is open for it: secret scanning of commits and PRs (for example GitHub secret scanning or a scanner in CI).
