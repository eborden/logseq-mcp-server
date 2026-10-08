# Tool responses list their keys in a deliberate order

## Statement

A model reads a tool result from the top, so the order of its keys carries meaning. Every tool lists the keys of a result in the same sequence of four categories, and a new key goes in the category it belongs to:

1. **What was answered.** The echo of the request and how a name was resolved (the topic asked about, the page an alias stood for). The reader learns first whether the result is about what it asked.
2. **What must not be missed.** Whether the result is complete, what was cut or left out, warnings, how much exists in all, and a short overview of what the result holds. This comes before the data, so the reader knows how far to trust the data before reading it. Within it, the yes-or-no completeness flags come first, then the warnings that explain them, then the counts.
3. **The data.**
4. **Optional guidance.** Advice the reader may ignore, such as next-step tips. It comes last because nothing depends on it ([BR-0009 (tips-are-advisory)](0009-tips-are-advisory.md)).

The sequence is the same in every tool and does not depend on which optional keys are present: an absent key leaves the others in order.

- **An error** stands alone as the whole answer, and anything added to it later comes after.
- **An ambiguous-name answer** follows the sequence like any other result: that it is ambiguous and for which name, then the completeness keys, then the candidates as the data.
- **A result that is a bare array** keeps the array as its first content block, with the meta block after it ([BR-0006 (no-silent-truncation)](0006-no-silent-truncation.md)). The meta block follows the same sequence inside itself: what was answered, what must not be missed, then guidance.
- **Envelopes the server builds** (a warning, a resolution record, a meta block) follow the same logic: say what it is first, the detail next, the remedy last.
- **A LogSeq entity with additions** keeps its own fields together, in the order LogSeq gives them ([BR-0004 (additive-tool-contracts)](0004-additive-tool-contracts.md)), as the data. The server's additions go by category: resolution and completeness before the entity, data the server built from it after.

The rule leaves alone the order of fields inside a LogSeq entity or any record passed through, the order of items in an array (each tool's own sort rule decides that), and Markdown output.

## Rationale

A reader that takes a result in order is framed by what comes first and may skim or lose what comes last, especially in a long result or one a client cuts off. A cap warning that sits after the data is read after the reader has already formed a view of it. Putting completeness before the data, and ignorable guidance after it, makes the first lines of any result answer "is this about what I asked, and is it all there?". Keeping one order across tools means the reader learns it once.

The order used to be fixed only by chance, because the first server's bytes were the specification. The parity harness now compares results by deep equality, so nothing else pins it, and tools had drifted: completeness sat after the data in most tools and before it in one. The maintainer, 2026-10-08, on #122: "We probably do want to have a deliberate order for response contracts. The order can create semantic meaning and contextual relevance for agents." Proposed in #377.

The rule states an intent, not a layout. Which key belongs to which category, and the current order of each tool, are in #377 as evidence and as a guide for implementing it.

## Mechanical enforcement

none-yet: #299 (a later wave gives each tool a typed output whose declaration order is its wire order, and pins that order with a unit test per tool)
reviewer: A new key in a tool result goes in the position of its category, and an optional key does not move the others.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-08 | Introduced. | #377 |
