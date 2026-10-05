# Publish to npm only from a manual workflow run by the maintainer

## Context

Issue #14 asked for an install path of a couple of commands: `npx -y logseq-mcp-server`. Issue #46 made the first step explicit: decide whether to publish to npm at all, or whether the Claude Code plugin is enough. Publishing needs an npm account and a secret token, and creates a public artifact that cannot be taken back (npm does not allow a published version to be reused). Those are decisions for the maintainer, not for an automated session. The same issue wanted `npm publish --provenance` from GitHub Actions, which needs a workflow.

Triggering the workflow on every push or tag would publish without a deliberate choice at that moment, so the workflow is started by hand.

## Decision

Publishing is a manual GitHub Actions workflow, `.github/workflows/publish.yml`. It runs only on `workflow_dispatch` (never on push or pull request), only from `main`, and the maintainer starts it from the Actions tab. It runs `npm ci`, the type-check, the unit tests, the build and `npm pack --dry-run`, then `npm publish --provenance --access public`. A `dry_run` input defaults to true and runs `npm publish --dry-run` without needing a secret. The real run needs the `NPM_TOKEN` repository secret and fails with a clear message when it is missing. Third-party actions are pinned to commit SHAs.

A session, human or agent, never publishes, tags or releases outside this workflow. Version numbers are the maintainer's call: `package.json` and `.claude-plugin/plugin.json` must carry the same version.

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

- ci: `.github/workflows/publish.yml` (triggered only by `workflow_dispatch`, `main` only, `dry_run` defaults to true)
- test: `src/package-metadata.test.ts` (the package is built before publish and ships only built output, docs and the LICENSE)
- test: `src/version.test.ts` (the plugin manifest carries the same version as `package.json`)
