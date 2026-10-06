---
name: Bug
about: Something behaves differently from what the tools, docs or an ADR/business rule promise.
title: ""
labels: bug
---

<!--
PRIVACY (BR-0001): this repo and its GitHub project are public.
Do NOT paste output from a personal graph, page names, block content, people, journal dates
or your API token. Reproduce against the fixture graph (or a made-up page) and describe
shape and counts instead ("a page with ~100 neighbours", "~2k-page graph").

Delete these comments before you file.
-->

## What happened
<!-- Observed behavior, with the exact error text if it is short. -->

## What you expected
<!-- Which tool contract, doc, ADR or business rule says so? Link it (BR-0006, "Common Gotchas", a tool description). -->

## Reproduce
<!-- Against the fixture instance (`npx tsx scripts/logseq-instance.ts start`) using fixture
pages from tests/fixtures/README.md, or a made-up page. Give the exact call. -->
```json
{ "tool": "logseq_get_page_outline", "arguments": { "page": "hub central" } }
```
Observed:
```
```
Expected:
```
```

## Environment
- Server version (`package.json`):
- LogSeq version:
- Node version:
- Deterministic? <!-- always / intermittent (how often, under what load) -->

## Suspected area
<!-- Optional, but it saves an agent a search: tool, query builder, or the CLAUDE.md constraint or BR it may violate. -->

## Acceptance for the fix
<!-- A known bug is pinned by a plain `it` that asserts the current wrong value and names this
issue, flipped when fixed. Not `it.fails`. -->
- [ ] A plain `it` pins the current wrong value on the fixture and names this issue; the fix flips the assertion
- [ ] The fix changes only what this bug needs; any behavior change is flagged in the PR
- [ ] <!-- anything else that must hold afterwards -->
