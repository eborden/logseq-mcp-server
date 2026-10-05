# Make every tool description say what the tool can't find

## Context

Tool descriptions are what the model reads to choose a tool. Issue #13 (section 4) and issue #44 asked to "make tool descriptions say what each tool can't find (search is lexical; traversal only reaches linked pages)". Commit a460d5c (PR #56) added a "Can't find" line to every description, trimmed each one under the 400-character cap (see `tool-list-size-guardrails`), and added a test that requires the line.

The foundations doc (PR #38, section 4.11) states the surrounding rule: descriptions live in `src/tool-descriptions.ts`, are kept accurate when behavior changes, and each needs a "Can't find" line. Model guidance lives in three places: tool descriptions, server instructions in `src/instructions.ts`, and next-step tips from `src/utils/tips.ts`.

Inferred, not recorded: a model that doesn't know what a tool can't find will retry it with other arguments instead of switching to a tool that can.

## Decision

Every tool description carries a "Can't find" line that states the tool's limits, and the line is kept accurate when the tool's behavior changes. Longer guidance goes in the server instructions or tips, not the description.

## Consequences

- The model sees each tool's blind spots at the point where it picks a tool.
- The line spends part of each description's 400-character cap.
- The test checks that the line is present, not that it is true. Accuracy after a behavior change rests on review.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/tool-list.test.ts` (fails for any tool whose description lacks "Can't find")
- reviewer: A PR that changes what a tool can return also updates that tool's "Can't find" line.
