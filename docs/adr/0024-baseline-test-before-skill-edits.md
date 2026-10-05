# Baseline-test a skill before editing it

## Context

The skills in `skills/logseq-skills/` are instructions an agent follows. Editing one changes what the agent does, but no compiler or unit test runs it, so a change that reads as an improvement can still be a regression.

The practice of testing a skill before and after an edit came from these changes:

- 2025-12-05, commit 1161061, redesigned the weekly-summary skill "using TDD methodology for documentation" and recorded the process in `1161061:docs/skill-redesign-tdd-methodology.md`. A RED phase recorded what the skill's existing example actually did before any edit. A GREEN phase changed only what that baseline showed. A REFACTOR phase checked the result and closed the gaps it found. The doc states the rule as "NO SKILL EDITS WITHOUT BASELINE TESTING FIRST" and attributes it to the external `superpowers:writing-skills` skill. The compression design it justified now lives in [`summary-compression.md`](../../skills/logseq-skills/references/summary-compression.md) and isn't repeated here.
- 2025-12-08, commit 5a97c2c (context-efficiency patterns): "Developed using TDD approach with subagent baseline/post-skill testing."
- 2026-09-14, commit a569202 (terseness budget and monthly summary): "Validated with 13 blind agent runs against an approved summary." Before the new rule, 10 of 10 runs dropped the same signal. After it, 3 of 3 kept it within the word budget.
- 2026-09-16, commit 7c9618b, added the concept-linking sub-skill with a synthetic fixture graph, `tests/fixtures/graph-linking/`, that holds an expected result and negative cases. `SKILL.md` calls it "the worked example and the regression suite".

Inferred: the reason is the one [architecture-foundations.md §4.7](../architecture-foundations.md#47-changing-existing-code-safely) gives for code. Without a recorded baseline you can't tell a regression from an intended change.

This ADR was backfilled in #77. The practice was adopted in the 2025-12 weekly-summary redesign (commit 1161061) and used in some later skill work (5a97c2c, a569202, 7c9618b), but not consistently: later skill commits, including at least one that changed behaviour, record no baseline (see Consequences). Like the backfilled ADRs 0001 to 0023, it records a decision already made, so it was added as `accepted` rather than going through `proposed`.

## Decision

We don't edit a skill without a baseline test first. Before changing a skill file, run the current skill on the behaviour the change targets, with agent runs or the skill's fixture, and record what it actually does. Change only what the baseline shows is wrong. Then run the same test again and compare. The commit or PR reports the baseline and the result as approximate counts, as commits 5a97c2c and a569202 did.

## Consequences

- A claim about a skill change ("fewer items", "keeps the people read") comes with evidence, not just an assertion.
- Skill changes cost more: agent runs before and after, in tokens and time.
- Baselines often run against the personal graph, so their output stays local. Only approximate counts reach commits and PRs, and committed examples and fixtures are synthetic ([BR-0001 (no-graph-data-in-repo)](../business-rules/0001-no-graph-data-in-repo.md)).
- Inferred: agent runs vary from run to run, so a baseline is a handful of runs, not a proof. Commit a569202 used 13.
- No test runs a skill, so nothing mechanical stops an untested edit. The concept-linking fixture is run by hand.
- The practice hasn't been followed on every edit. Several 2026-10-05 commits kept the skills in step with the server (tool names, parameter defaults, tool counts), and at least one changed behaviour: f9b7699 changed the trigger phrases and sibling routing in the skill descriptions. 174364a, which tells the summaries to start from topConcepts, is borderline, since it follows a server feature (#17). None of them records a baseline. Whether in-step edits are exempt isn't recorded and is left open for the maintainer.

## Status

accepted

Date: 2025-12-05

## Mechanical enforcement

- reviewer: A PR that changes a file under `skills/logseq-skills/` states the baseline test run before the edit and the result after it, with approximate counts and no graph data.

No test or CI check runs a skill yet, and no issue tracks adding one.
