# Budget and snapshot the tool list that every session loads

## Context

The `tools/list` response is sent into the model's context at the start of every session that uses the server, whether or not any tool is called. Every added tool, parameter or word of description is a recurring cost, and descriptions are also what a model uses to choose between tools. By the time this was measured, the payload was about 16,000 characters (roughly 4,000 tokens at four characters per token) across 13 tools, and 12 of 13 descriptions were over 400 characters.

Without a guard, growth happens one reasonable PR at a time and nobody decides it. The planned work in issue #13 (formats, outline tool, hints) would add more. Issue #39 asked for guardrails first, so later PRs grow the list deliberately.

## Decision

A unit test measures the serialized tool list and enforces three things:

1. A budget on `JSON.stringify(tools)`, set in the test as `TOOL_LIST_BUDGET_CHARS` with headroom over the measured size (17,000 characters when this was written, against about 14,000 in use). Raising it is allowed, in the PR that grows the list, with a justification of why the extra tokens are worth paying every session.
2. A cap of 400 characters on each tool's description text, schema excluded. New tools must fit it. A tool that exceeds it needs an entry in a named allowance table, as a ceiling that may shrink but not grow. The allowance table was later emptied when every description was trimmed to fit.
3. A snapshot of every tool's name, title, annotations, description and input schema, so any change shows up in review. Updating the snapshot is deliberate: review the diff, then `-u` and commit.

## Consequences

- Growth of the tool list is a visible, justified decision.
- Descriptions are short and say what a tool cannot find, not a manual. Longer guidance moves to the server instructions, the `logseq://guide` resource and the skills.
- Any change to a description or schema touches a snapshot file, which adds churn to PRs. We accept it because that churn is the review signal.
- The number of characters is an approximation of tokens, not a tokenizer count.
- The snapshot also supports `additive-tool-contracts`, because renames and removals appear as diffs.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/tool-list.test.ts` (token budget, description cap, no stale allowances, snapshot)
