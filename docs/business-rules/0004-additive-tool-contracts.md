# Tool contracts change additively

## Statement

Tool names, parameter names, required fields and the shape of results are the contract. Clients and skills call tools by name with named parameters, so tool contracts change additively: add optional parameters, new tools and new optional result fields. A rename or removal needs an explicit decision and a migration note.

## Rationale

An MCP client, a skill, or a prompt that names a tool and its parameters is a consumer the server can't see. The schema is how it agrees with the server about reality. A silent rename or removal breaks those callers. The tool-list snapshot (#39) makes any change to a name, description or schema visible in review. Restated as a hard rule in the foundations doc (#38).

## Mechanical enforcement

test: `src/tool-list.test.ts`
test: `src/__snapshots__/tool-list.test.ts.snap`

The snapshot test fails on any change to a tool's name, title, annotation, description or input schema, so a rename or removal can't land unseen. Update the snapshot only for additive changes and call out the diff in the PR. The snapshot can't tell an additive change from a breaking one, so a reviewer still checks the diff.
reviewer: A snapshot diff in `src/__snapshots__/tool-list.test.ts.snap` only adds optional parameters, tools or result fields.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a hard rule in the foundations doc. | #38 |
| 2026-10-05 | Tool-list snapshot added as the mechanism. | #47 |
