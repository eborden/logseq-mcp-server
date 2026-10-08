# Change tool contracts additively

## Context

Clients, skills and prompts call tools by name with named parameters, and they read named fields in the results. A model-driven client has no compile step that would flag a rename: it just fails at call time, or silently reads a field that no longer exists. The skills ship in the same repository as the server (`skills/logseq-skills/`) and name tools directly.

Early on the surface moved freely. Two tools were deleted ([ADR-0008 (remove-redundant-tools)](0008-remove-redundant-tools.md)), `slim_results` was added and later made the default, and tools gained parameters. The architectural foundations doc (PR #38) then wrote the principle down as hard rule 8, "Tool contracts change additively", with the reason in section 4.3: "An MCP client, a skill, or a prompt that names `logseq_search_blocks` and its parameters is a consumer you can't see." Inferred, not recorded: the timing followed the Claude Code plugin and the npm package being prepared ([ADR-0018 (ship-as-claude-code-plugin)](0018-ship-as-claude-code-plugin.md), [ADR-0017 (manual-npm-publish)](0017-manual-npm-publish.md)), which would put the tools in front of callers the maintainer can't reach, where before there was one user and no release.

## Decision

We change tool contracts additively: new optional parameters, new tools and new optional result fields (foundations, hard rule 8 and section 4.3). A rename or removal needs an explicit decision and a migration note.

The exact promise to callers, including how parameter aliases fit (issue #44), lives in the business rules [BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md) and [BR-0008 (param-aliases-best-effort)](../business-rules/0008-param-aliases-best-effort.md) (PR #84). This ADR records why contracts moved from free-form to additive.

## Consequences

- Callers and skills keep working across versions. New capability reaches them as new optional input and new fields.
- The schema only grows. Old parameters stay, even when a better name exists, and clutter accumulates until a deliberate break.
- The tool list is part of the context every session pays for, so growth competes with the budget (see [ADR-0016 (tool-list-size-guardrails)](0016-tool-list-size-guardrails.md)).
- Output changes that look harmless, such as dropping a field, count as contract changes: foundations section 4.3 names "the shape of results" as part of the contract.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

The recorded `tools/list` (`scripts/parity/expected/tool-list.json`) records every tool's name, description, annotations and input schema, and the parity step of CI holds the Rust server to it by meaning (ADR-0031), so a rename, removal or new required parameter fails until a reviewer accepts the change to the recorded file deliberately.

- test: `tests/guards/tool-list.test.ts` (the recorded list is the one the guardrails of ADR-0015 and ADR-0016 hold)
- test: `tests/guards/tool-list.test.ts` (the canonical parameter stays required for every aliased tool of the recorded list, and no alias is advertised; the aliases are checked against the `ALIASES` constants in `rust/src/tools`)
- ci: `.github/workflows/ci.yml` (the parity step holds `tools/list` to the recorded one by meaning: `compareToolLists` in `scripts/parity/tool-list-compare.ts`)
- test: `rust/src/params.rs` (an alias is folded into the canonical name, and a conflicting alias is refused)
- reviewer: A PR that renames or removes a tool, parameter or result field says so and includes a migration note.
