# License the project under MIT

## Context

The project is a public repository, and a package users are meant to install. When the package was prepared for npm (PR #70), `package.json` already said ISC but the repository had no LICENSE file, so there was no license text a user could rely on. The PR added an ISC LICENSE file.

The PR's review recorded the switch: "Maintainer decision: license. The maintainer has chosen **MIT** over ISC", and listed the changes needed. The switch landed as a commit in the same PR, after the review (b5de573 on `main`, 0cf1ab8 on the PR branch before the rebase-merge). Neither the review nor the commit gives a reason, and we do not guess at one here.

## Decision

We license the project under the MIT License. The text lives in `LICENSE`, `package.json` declares `"license": "MIT"`, and the lockfile root entry matches. The `LICENSE` file ships in the npm package.

## Consequences

- The repository has license text a user can rely on, and `package.json` agrees with it.
- The first `LICENSE` file, added earlier in PR #70, held ISC text, so `main` carries an ISC `LICENSE` in the commits between that one and b5de573.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `tests/guards/package-metadata.test.ts` (package.json license is MIT and the LICENSE file starts with the MIT header)
- test: `tests/guards/release-assets.test.ts` (the LICENSE ships as a release asset: release.yml copies it into the release set, lists it in SHA256SUMS and uploads it with the draft release, and the repository's LICENSE is the MIT text)
