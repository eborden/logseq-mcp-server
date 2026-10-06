---
name: Proposal (ADR or business rule)
about: Propose adding, changing, superseding or retiring an ADR or business rule.
title: "Propose ADR: "
labels: proposal
---

<!--
MERGING THE RESULTING PR NEEDS THE MAINTAINER'S EXPLICIT OK, even with self-merge. The one
exception is a PR that only adds or strengthens Mechanical enforcement lines (see CLAUDE.md,
"ADRs and business rules").

This issue is the proposal. The deliverable is a PR that adds `docs/adr/NNNN-<slug>.md` or
edits `docs/business-rules/NNNN-<slug>.md`. Read the README of the directory you're changing first.

Sub-issues for the follow-up work go in the Sub-issues field, with "blocked by" edges in
Relationships, not as a list in this text.

PRIVACY (BR-0001): public repo. No personal-graph data; made-up examples only.

Delete these comments before you file.
-->

## Problem
<!-- What forced a decision? Link the issues, incidents or measurements. -->

## Kind of change
- [ ] New ADR
- [ ] New business rule
- [ ] Edit to a business rule (adds a Changelog row)
- [ ] Supersedes ADR-NNNN (the PR marks the old one `superseded by <NNNN-slug>`)
- [ ] Retires a rule (follow the README; the file is kept)

## Options considered
| Option | Pros | Cons / cost |
|---|---|---|
| | | |

## Recommendation
<!-- One option, and why. A recommendation, not a survey. -->

## Consequences
<!-- What gets easier, what gets harder, what existing code or tests this touches. -->

## Mechanical enforcement
<!-- Tiers, strongest first: `type`, `test`, `ci`, `reviewer`, `none-yet`. Name the guard,
or say what issue will add it. -->
- <tier>: <reference>

## Open questions
<!-- For the maintainer. Write "None" if there are none. -->

## Acceptance
- [ ] Maintainer accepts the direction (comment here)
- [ ] ADR PR opens as `proposed` and is set to `accepted` in the same PR before merge
- [ ] `npx tsx scripts/docs-format.ts` passes
- [ ] Maintainer's OK is recorded on the PR before merge
