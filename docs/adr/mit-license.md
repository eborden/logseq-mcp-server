# License the project under MIT

## Context

The project is a public repository, and a package users are meant to install. When the package was prepared for npm (PR #70), `package.json` already said ISC but the repository had no LICENSE file, so there was no license text a user could rely on. The PR added an ISC LICENSE file.

Shortly after, the license was switched to MIT (commit b5de573). The commit and the issues record the change but not the reason. We do not guess at it here. Both are permissive licenses with the same practical terms: use, modify and redistribute with the notice kept, and no warranty.

## Decision

We license the project under the MIT License. The text lives in `LICENSE`, `package.json` declares `"license": "MIT"`, and the lockfile root entry matches. The `LICENSE` file ships in the npm package.

## Consequences

- Users get a standard, widely recognised permissive license, with the legal text in the repository.
- A later change of license needs a new ADR, because relicensing code already distributed is not a quiet edit.
- Git history before commit b5de573, and the first `LICENSE` file from PR #70, contain ISC text. That is not a conflict, since both are permissive, but the history is not uniform.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/package-metadata.test.ts` (`package.json` license is MIT and the `LICENSE` file starts with the MIT header, and ships in `files`)
