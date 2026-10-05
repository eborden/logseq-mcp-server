# Budget and snapshot the tool list that every session loads

## Context

The `tools/list` response is sent into the model's context at the start of every session that uses the server, whether or not any tool is called. Every added tool, parameter or word of description is a recurring cost, and descriptions are also what a model uses to choose between tools. When the guard was added (commit 4033720), the payload measured 16,014 characters (about 4,000 tokens at four characters per token) across 13 tools, and 12 of the 13 descriptions were over 400 characters.

Issue #39 asked for guardrails before the rest of #13 (formats, outline tool, hints) added more: a budget at the measured size plus ~15% headroom, a ~400-character description cap, and a snapshot, so that "later PRs that add tools or parameters must update the snapshot deliberately, and stay within the budget or raise it with a justification in the PR". The test's own comment gives the reason: "Every session pays for this payload in context, so growth should be a deliberate choice".

## Decision

A unit test measures the serialized tool list and enforces three things:

1. A budget on `JSON.stringify(tools)`, set in the test as `TOOL_LIST_BUDGET_CHARS` with about 15% headroom over the measured size. Raising it is allowed, in the PR that grows the list, with a justification in the PR description of why the extra tokens are worth paying every session. Never raise it just to make room (foundations, section 4.11).
2. A cap of 400 characters (`DESCRIPTION_CAP`) on each tool's description text, schema excluded. A new tool gets no allowance and must fit it. Existing long descriptions are listed in `DESCRIPTION_ALLOWANCES`, as ceilings that may shrink but not grow, and an entry is deleted once its tool fits the cap (the test fails on stale entries).
3. A snapshot of every tool's name, title, annotations, description and input schema, so any change shows up in review. Updating the snapshot is deliberate: review the diff, then `-u` and commit.

History of the budget, from `git log -S` on `src/tool-list.test.ts`:

| Commit | Budget | Why |
|---|---|---|
| 4033720 | 18,500 | 16,014 measured plus ~15% headroom (#39, PR #47) |
| a460d5c | 16,000 | Every description trimmed under the cap with a "Can't find" line, the list down to about 13,870, `DESCRIPTION_ALLOWANCES` emptied (#44, PR #56) |
| 629d017 | 17,000 | Deliberate headroom for the `format`, `compact` and outline work in #43 |

The constants in the test are the source of truth. This table is history and is not updated.

## Consequences

- Growth of the tool list is a visible, justified decision.
- Descriptions are short and say what a tool cannot find, not a manual. Longer guidance moves to the server instructions, the `logseq://guide` resource and the skills.
- Any change to a description or schema touches a snapshot file, which adds churn to PRs. We accept it because that churn is the review signal.
- The number of characters is an approximation of tokens, not a tokenizer count.
- The snapshot also supports [ADR-0020 (additive-tool-contracts)](0020-additive-tool-contracts.md), because renames and removals appear as diffs.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/tool-list.test.ts` (token budget, description cap, no stale allowances, snapshot)
- reviewer: A PR that raises TOOL_LIST_BUDGET_CHARS explains in its description why the growth is worth it.
