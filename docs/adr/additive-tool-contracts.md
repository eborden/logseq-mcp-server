# Change tool contracts additively

## Context

Clients, skills and prompts call tools by name with named parameters, and they read named fields in the results. A model-driven client has no compile step that would flag a rename: it just fails at call time, or silently reads a field that no longer exists. The skills ship in the same repository as the server (`skills/logseq-skills/`) and name tools directly.

Early on the surface moved freely. Two tools were deleted (`remove-redundant-tools`), `slim_results` was added and later made the default, and tools gained parameters. That was fine with one user and no release. With the Claude Code plugin and an npm package on the way (`ship-as-claude-code-plugin`, `manual-npm-publish`), each change can reach callers who cannot be told in advance. The architectural foundations doc (PR #38) wrote the principle down as hard rule 8.

## Decision

We change tool contracts additively. We add optional parameters, add fields to results, and add new tools. Existing parameter names, required parameters, result fields and tool names keep their meaning.

A rename, a removal, a new required parameter or a change to a default needs an explicit maintainer decision and a migration note, in the PR and in the CHANGELOG. Making `slim_results` the default (see `slim-output-by-default`) is the worked example: it was called out as a behaviour change with before and after per tool.

Parameter aliases (issue #44) are an additive tool for model mistakes, not a way to rename. An alias is accepted for an identical parameter, never advertised in the schema, and the canonical name stays required.

## Consequences

- Callers and skills keep working across versions. New capability reaches them as new optional input and new fields.
- The schema only grows. Old parameters stay, even when a better name exists, and clutter accumulates until a deliberate break.
- The tool list is part of the context every session pays for, so growth competes with the budget (see `tool-list-size-guardrails`).
- Output changes that look harmless, such as dropping a field or changing an error into an empty result, count as contract changes and need the same care.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

The tool-list snapshot records every tool's name, description, annotations and input schema, so a rename, removal or new required parameter appears as a snapshot diff that a reviewer must accept deliberately.

- test: `src/tool-list.test.ts` (snapshot at `src/__snapshots__/tool-list.test.ts.snap`)
- test: `src/index.aliases.test.ts` (the canonical parameter stays required for every aliased tool)
- reviewer: A PR that changes a result field or a default must say so as a contract change and add a CHANGELOG note.
