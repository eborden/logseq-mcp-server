# `resolve_refs` is opt-in and non-lossy

## Statement

`resolve_refs` is opt-in and non-lossy. `content` never changes. A block holding a `((uuid))` ref or `{{embed}}` gains `resolvedContent` and `resolvedRefs: [{ uuid?, embed?, content, page, status }]` (`status` is one of `ok`, `missing`, `depth_limit`, `cycle`; unresolved refs stay as written). The result gains `hasMore` and `warnings` (embed caps, depth limit). Slim blocks carry the same fields.

With `resolve_refs` off, calls and output are unchanged. Sibling blocks that share a target both get it resolved.

## Rationale

A reader that gets rewritten `content` can't tell what the author wrote, and a second resolver would drift from the first. Opt-in keeps the default call count and output size unchanged. Introduced in #18.

## Mechanical enforcement

One resolver serves every tool: `resolveBlockRefs` in `src/utils/resolve-refs.ts`, with one Datalog query per nesting level and `seen` tracked per path, so siblings that share a target both resolve. A new tool that returns blocks should call the resolver rather than add its own.

test: `src/utils/resolve-refs.test.ts`
test: `src/index.resolve-refs.test.ts`
test: `src/tools/get-block.resolve-refs.test.ts`
reviewer: A new tool that returns blocks should call `resolveBlockRefs` rather than resolve refs itself.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #54 |
