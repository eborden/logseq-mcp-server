# Report only success you have verified

## Statement

Don't report success you haven't verified. Tool outputs, status fields, summaries and notes must report what actually happened, not what was intended. Report what the tool did, including that nothing matched. Error messages guide recovery and stay actionable (`PageNotFoundError` suggests close matches). Partial and truncated results say so through `ResultMeta` `warnings`.

## Rationale

People and agents act on what they are shown. A summary that counts attempts as successes, or a status that claims more than was checked, causes wrong decisions. Introduced as a hard rule in the foundations doc (#38).

## Mechanical enforcement

reviewer: Tool outputs, status fields, summaries and PR notes describe what actually happened, not what was intended.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a hard rule in the foundations doc. | #38 |
