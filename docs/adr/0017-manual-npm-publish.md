# Publish to npm only from a manual workflow run by the maintainer

## Context

Issue #14 asked for an install path of a couple of commands: `npx -y logseq-mcp-server`. Issue #46 made the first step explicit: decide whether to publish to npm at all, or whether the Claude Code plugin is enough. Issue #46 gives what that depends on: an npm account and an `NPM_TOKEN` secret. A publish also creates a public artifact that cannot be taken back, since npm does not allow a published version number to be reused. CLAUDE.md's merge policy lists publishing among the decisions that belong to the maintainer. The same issue wanted `npm publish --provenance` from GitHub Actions, which needs a workflow.

Inferred, not recorded as an option weighed: triggering the workflow on every push or tag would publish without a deliberate choice at that moment, so it is started by hand. PR #70, which added the workflow, describes it as "`workflow_dispatch` only (never push or PR), only on `main`".

## Decision

Publishing is a manual GitHub Actions workflow, `.github/workflows/publish.yml`. It runs only on `workflow_dispatch` (never on push or pull request), only from `main`, and the maintainer starts it from the Actions tab. It runs `npm ci`, the type-check, the unit tests, the build and `npm pack --dry-run`, then `npm publish --provenance --access public`. A `dry_run` input defaults to true and runs `npm publish --dry-run` without needing a secret. The real run needs the `NPM_TOKEN` repository secret and fails with a clear message when it is missing. Third-party actions are pinned to commit SHAs.

The working rule that follows (never publish, tag or release from a session) lives in CLAUDE.md, Common Gotchas, and is not repeated here.

## Consequences

- Nothing reaches npm without a deliberate click, and the tarball matches code on `main` that has passed review and CI.
- Provenance ties each published version to the workflow run and commit.
- Releases need a person to run them. There is no continuous release, and a merged fix is not available to users until the maintainer publishes.
- The workflow's own steps cannot be fully tested without publishing, so the first dry run on GitHub is the real test.
- The `.mcpb` package for Claude Desktop was left out of this decision. It needs an environment-variable path in the config and a release step, and is not part of this ADR.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- ci: `.github/workflows/publish.yml` (triggered only by workflow_dispatch, main only, dry_run defaults to true)
- test: `tests/guards/package-metadata.test.ts` (prepublishOnly runs the build, and files includes dist, README.md and LICENSE)
- test: `tests/rust-guards/version.test.ts` (the plugin manifest carries the same version as package.json)
- test: `tests/guards/adr-workflow-guards.test.ts` (publish.yml triggers only on workflow_dispatch, the dry_run input defaults to true and the Publish step runs npm publish --dry-run when it is set, every job is gated to refs/heads/main, and no other workflow runs npm publish)
