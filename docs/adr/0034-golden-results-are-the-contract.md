# Make the recorded golden results the contract, compared by meaning, with LogSeq calls held to a bounded count

## Context

[ADR-0025 (rust-implementation-alongside-typescript)](0025-rust-implementation-alongside-typescript.md) set the TypeScript server's contract as the specification for a Rust one, and [ADR-0031 (second-implementation-matches-tool-list-by-meaning)](0031-second-implementation-matches-tool-list-by-meaning.md) and [ADR-0032 (closest-page-suggestions-match-by-meaning)](0032-closest-page-suggestions-match-by-meaning.md) loosened it where it cost more than it protected. ADR-0032 still says that, for the same stubbed LogSeq responses, results equal byte for byte "as the TypeScript server serializes it", and that the server makes "the same LogSeq calls, the same inputs, in order".

That premise is gone. The exploration ended in a go, the Rust server is the only server, and the TypeScript server is retired (#356). Nothing serializes a result "as the TypeScript server" any more, and nothing makes the calls it made. What is left of that server is what was recorded from it: the golden results, which the parity test holds the Rust server to. The test already compares a JSON result by meaning (deep equality, decided on #371), so the ADR text is behind the practice.

ADR-0032 Decision 5 said that retiring the TypeScript implementation would be a separate decision with its own ADR. That decision was taken on the issues (#127, the go/no-go; #349, the cutover; #356, the removal), and this ADR is the ADR for it: it records what the retirement changes about the contract, and no other ADR is owed.

The other half of ADR-0032's sentence costs more than it protects, now that there is one implementation. Holding the server to the retired server's query text and call order ties it to choices that were never part of what a tool promises. A client sees a tool's result and nothing else. A leaner query, a merged call, two independent calls swapped, or the removal of a shim that only copied the old server (#299) changes nothing a client can observe, yet each fails a case until someone re-records it as if it were a change of contract. What the calls do matter for is how many there are, since each costs LogSeq time and a runaway query blocks its HTTP API ([ADR-0011 (bounded-calls-and-results)](0011-bounded-calls-and-results.md)), and whether they ask the right thing.

The maintainer approved drafting this successor on 2026-10-08, with this decision: "the recorded golden results are the contract, compared by meaning, and query text and call order are implementation details as long as call counts stay bounded". The words were "Draft the successor ADR". It reflects their earlier decisions: results are compared by deep equality with key order ignored and array order kept; Markdown, prompts and resources are compared byte for byte; output stays minified ([ADR-0009 (minified-json-output)](0009-minified-json-output.md)); key order is a deliberate contract of its own ([BR-0013 (response-key-order)](../business-rules/0013-response-key-order.md)); the closest-name suggestions follow ADR-0032's rules; and golden changes need the `golden-change` label, which needs the maintainer's OK. On #122 they said "let's copy semantics that are important, not quirks".

This ADR restates what it keeps from ADR-0025, ADR-0031 and ADR-0032, so that the rules that bind the server live in one ADR that isn't superseded. They stay as history. ADR-0032 is marked superseded by this ADR, and ADR-0025 and ADR-0031 already point onward to it.

## Decision

1. **There is one implementation, and its recorded golden results are the contract.** The Rust server is held to the results recorded from the TypeScript server before it was retired, and to nothing else about that server. A golden result changes only with the maintainer's explicit OK, recorded on the pull request. A recorded result that no one should copy, because it only reflects how the retired server happened to work, is changed the same way, not worked around. Contract changes stay additive ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)).

2. **Results are compared by meaning where meaning is all a client reads, and exactly where the exact text is the meaning.**
   - **A JSON tool result is compared by deep equality.** Object key order is ignored, array order is kept, numbers are compared by value (`50`, `50.0` and `5e1` are one number), and every string is compared exactly, except the closest-name list of a page-not-found message, which Decision 4 compares by rules.
   - **A JSON tool result must also be minified** (ADR-0009): the text has to be as short as the same value written with no layout and in the compact spelling of every number and string. Deep equality alone would let layout whitespace through, so this is checked on its own.
   - **Key order is not compared, and is still a contract.** BR-0013 fixes the order of the keys of a result, because a model reads a result from the top. The comparison ignores order, so BR-0013 is held by its own enforcement, not by the golden comparison.
   - **Compared byte for byte:** a Markdown result, a prompt's messages, a resource read, any other text that isn't JSON, the frame of a page-not-found message outside its list of names (below), and every non-text field of a result (its envelope, its content block types, its error flag). Array order is kept everywhere.
   - **`tools/list` is compared by meaning**, as below.
   - **The closest names of a page-not-found message are compared by rules**, as below.

3. **`tools/list` is compared by meaning.** The server's list and the recorded list are normalized the same way before they are compared, and only these differences are treated as serialization, not meaning:
   1. **`$ref` resolution.** A `$ref` into `$defs` or `definitions` is replaced by what it points at, and the definitions are dropped. A `$ref` with sibling keywords, or an `allOf` of one schema, is merged into one schema; a clash stays an `allOf`, so it still shows as a difference. Only local JSON-pointer refs (`#` or `#/...`) are resolved. An anchor-style (`#Foo`), non-local, recursive or dangling `$ref` isn't resolved and is reported as a difference.
   2. **Null on optional fields.** A **top-level** property of `inputSchema` that isn't in `required` loses the null it also accepts (`[T, "null"]`, a null branch of `anyOf` or `oneOf`, `null` in `enum`), because the server treats an explicit top-level `null` as absent. A required property, and any property of a nested object or of an object inside `items`, keeps its null, since the server rejects a `null` there.
   3. **Non-validating annotation keywords.** The `$schema`, `format` and `title` keywords inside a schema are dropped. A property named `format`, and the tool's own `title` and `annotations`, are kept.
   4. **Numbers by value.** `50`, `50.0` and `5e1` are the same number.
   5. **Set-like `required`.** `required` is compared as a set, and object key order never matters.

   **What stays exact in `tools/list`:** tool names, titles, annotations, descriptions, types, `required` members, bounds, enum values (in order), defaults, parameter descriptions and `additionalProperties`.

   **The size guardrails stay.** [ADR-0016 (tool-list-size-guardrails)](0016-tool-list-size-guardrails.md) holds: a budget on the serialized list and a cap on each description, with its reasons (every session pays for the payload). They are measured on the list the server actually sends, which is what a client receives, and on the recorded list. The byte-exact snapshot of the TypeScript server's list went with that server; the recorded list, held by meaning, takes its place as the reference for names, descriptions and schemas.

4. **The closest-name list is checked by rules, not bytes.** The server may choose those names with any matcher. The recorded lists came from the TypeScript server's matcher, which no server now has, so they are held to the rules below and not copied.

   **Terms.**
   - The **reference** is the recorded golden result for a case.
   - The **candidates** are the original names of the pages in the stubbed answer for the list of all pages, strings only.
   - `fold(s)` is: trim, Unicode NFD, drop combining marks, lowercase. The comparison writes it once. The server doesn't need it.
   - The input's **tokens** are `fold(input)` split on spaces, empty pieces dropped. A name **covers** a token when the token's characters appear in order, not necessarily next to each other, in the name's fold.
   - **E** is the candidates whose fold equals the input's fold. **P** is the candidates whose fold starts with the input's fold and isn't equal to it. **T** is E and P together. **N** is the candidates that cover every token, and **n** is the number of them.

   **The message is read decoded.** The comparison reads the message string, not the bytes around it: the `error` string of a tool result's `{"error": ...}` JSON, or the message of the JSON-RPC error for the page resource. A name with a quote, a backslash or a control character is therefore compared as the name, not as its escaped form. The message is `No page <input as a JSON string>. <guidance>` with no list, or `No page <input as a JSON string>. Closest: <list>. <guidance>`, where the guidance is the fixed sentence `Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.`

   **Rules**, for every result that carries a page-not-found message. Rules 1 and 2 apply to every such result. Rules 3 to 6 apply only when the reference message uses the `Closest:` form, and rule 2 makes the server's message use it too. A reference message with no list (an ISO date, or an input no candidate covers) is then checked by rules 1 and 2 alone, and rule 6 does not look for matches the reference didn't list.
   1. **Frame.** The message, with the list cut out, equals the reference's, and the rest of the result (the envelope, the error flag) is equal to the reference's. The list is everything between the opening `No page <json>. Closest: ` and the closing `. <guidance>`. The opening is matched at the start of the message and the closing at its end, so a name that contains `. Try` or ends with a full stop doesn't move the edges.
   2. **Presence.** The `Closest:` form is used if and only if the reference uses it. An ISO date as the input gets none.
   3. **Members.** The list is one to three distinct candidates, each equal byte for byte to a candidate's name, joined by `, `. A name can contain `, `, so the comparison splits the list by trying candidates left to right, the longest matching name first, and backing up when a choice leaves the rest unreadable. That split is the one rules 4 to 6 use. It exists if and only if some split does, and it is unique for any list that is recorded, because a case whose reference list can be split in two ways isn't recorded.
   4. **Exact and prefix first.** Let k be the smaller of 3 and the size of T. The first k names are all in T, and every name from E comes before every name from P. The rule is skipped when the input's fold is empty.
   5. **Relevance.** Every listed name is in N. The list therefore can't be the same three pages for every input.
   6. **Count.** The list has at least the smaller of 3 and n names.

   **The reference has to pass rules 3 to 6** when a case is recorded and its message uses the `Closest:` form (rules 1 and 2 hold for it by construction), and a case it fails isn't recorded, so a quirk of a matcher can't become contract. Rules 4 and 6 are therefore properties of the recorded cases, not promises about every input on every graph.

   **The recorded set has to exercise the rules,** or rule 4 could pass without checking anything. The comparison fails if the set lacks any of these cases:
   - an exact hit, with E and P both non-empty (the order of E before P);
   - a prefix hit, with E empty and P non-empty;
   - more than three names in T (the cap of three);
   - a typo with no prefix hit and at least one name in N (T empty, so rules 5 and 6 are what is checked);
   - no suggestion: an ISO date, and an input that no candidate covers;
   - a candidate whose name contains `, `, in the list (rule 3's split);
   - the page resource's error, not only a tool result.

   The stubbed resolver may answer no page for a name that the list of all pages still holds, which is how the exact-hit cases arise.

   **Left unchecked on purpose:**
   - which names fill the list beyond the first k, among those in N, and in what order (typo quality, where two matchers differ), and any overlap with the reference's list;
   - which of more than three exact or prefix matches are listed, their order among themselves, and ties;
   - how accents beyond `fold`, non-Latin scripts, emoji, surrogate pairs, tabs and other white space, and mid-word inputs rank, since the recorded names are ordinary ones;
   - whether a suggestion helps a model or a person, which no client study covers;
   - behaviour on a graph of thousands of pages with long names, since the comparison has dozens of synthetic names.

5. **LogSeq calls are compared for a bounded count and a correct effect, not for exact text or order.** What a tool asks LogSeq is an implementation detail, so long as the asking stays bounded and right:
   - **Bounded.** Each case has a call-count ceiling ([ADR-0011](0011-bounded-calls-and-results.md)): the most calls the tool may make for it. The server may make fewer calls and may not make more. The ceiling is recorded apart from the case's call fixtures, so adding or rewriting a fixture can't raise it unnoticed. Raising it is a contract change, made the way a golden change is, with the maintainer's explicit OK, because it changes what a tool costs LogSeq. When a change makes fewer calls, the same pull request lowers the ceiling to the new count, so a saved call can't be spent again without asking, as the mutation scores ratchet ([ADR-0033](0033-rust-mutation-testing-ratchet.md)). Lowering it needs no OK.
   - **Right.** The result still equals the golden result, so the data the calls fetched was the right data. The server asks only for what a case has an answer for. A call that no recorded call answers fails the case, whatever the server does with the answer, including a server that swallows the error on a best-effort path ([BR-0003 (infrastructure-errors-propagate)](../business-rules/0003-infrastructure-errors-propagate.md)). A query asked more than once in a case is matched to its recorded answers in the recorded order, so repeated identical calls stay ordered, and that is the one order the comparison keeps. Every recorded call is a read ([BR-0002 (tools-read-only)](../business-rules/0002-tools-read-only.md)), a re-recorded one included.
   - **Not held:** the query text, the order of the calls, and whether independent calls are made at once or one after another. The retired server's choices there bind nothing.
   - **Not bounded by the ceiling:** how the number of calls grows with the size of the input. A case holds a handful of entities, so a tool that turned two fixed calls into one call per page would still pass a case of one page. That growth is bounded by the implementation's call-shape tests, which pin the count against the size of the input ([ADR-0011](0011-bounded-calls-and-results.md); no per-page crawl, [ADR-0002 (datalog-over-editor-api)](0002-datalog-over-editor-api.md)). The ceiling is not ADR-0011's enforcement.

   **How the goldens record calls.** A case records its calls as fixtures: the method, the query text, the inputs and the answer the stub gives. They stay as fixtures, because the stub must still answer a call correctly, and it answers one by what the call asks. When the implementation changes a call, the same pull request re-records that fixture with the new text or inputs, and the stub answers the new call. A re-record is not a golden change. It is allowed when all of these hold:
   - no golden result changes;
   - the case's call count stays within its ceiling, which the PR doesn't raise;
   - every call is a read;
   - the new call is exercised by the integration suite on the fixture graph, which shows the query is right on real LogSeq. The parity answers are synthetic, made up for the case, so that suite checks the query and not the stub's answer;
   - the new stub answer is derived from the answers it replaces (a merged call's answer is the union of the old ones, a narrowed call's a subset), not from what the implementation happens to need, and the PR shows the derivation;
   - a reviewer checks the derivation against the diff.

   The implementation's own call tests guard the implementation, and its author may pin its calls as tightly as they like. Changing one is an ordinary code change, except where an ADR or business rule names the test as its enforcement (the error paths of [BR-0003](../business-rules/0003-infrastructure-errors-propagate.md), the alias coverage of [BR-0010 (page-names-resolved-via-resolver)](../business-rules/0010-page-names-resolved-via-resolver.md), the depth bound of ADR-0011). Changing such a test follows the rules for changing that enforcement line, and loosening what it pins is read against that rule and needs the maintainer's OK.

6. **Process docs are read by intent, per toolchain.** This keeps ADR-0025's decision for the accepted ADRs, which name mechanisms from the retired server's toolchain and are immutable.
   - An ADR whose Decision describes the contract, LogSeq's behaviour or how we work binds the server. Reading it means reading its intent, with a mechanism that names TypeScript read as "the TypeScript mechanism".
   - An ADR whose Decision is about the TypeScript toolchain (for example the Node floor and the npm publish path) applies to the dev tooling around the server, or to nothing now, and says so in a `reviewer:` line of its Mechanical enforcement section. This is a scope reading, not a supersession.
   - An accepted ADR keeps its text. How the Rust server meets it is recorded as a `<tier>: <reference>` line in its Mechanical enforcement section.
   - The foundations doc, the project instructions and the business rules are editable, and are rewritten per toolchain as their own READMEs describe.

## Consequences

- The server's queries are free to change. A leaner query, a merged or reordered call, or the removal of a shim that only copied the retired server needs a re-recorded fixture and nothing else, not a golden change and not the maintainer's OK. The cost of a call is bounded by the ceiling, not by one query's wording.
- A bug that changes the text or the order of a call but not the result no longer fails the golden comparison. The bound on the count, the golden result, the implementation's own call tests and the integration suite catch the rest. A mutant that changes only a call's text or order can survive the parity test and is left to those other tests ([ADR-0033 (rust-mutation-testing-ratchet)](0033-rust-mutation-testing-ratchet.md)).
- A count ceiling is a blunt bound. A cheaper call set passes, and so does a set of the same size whose queries are heavier. It also says nothing about growth with the size of the input, which the call-shape tests hold (Decision 5). Reviewers read a re-recorded query against ADR-0011 and against LogSeq's query constraints in the project instructions, and the ceiling doesn't replace that.
- A re-recorded answer is trusted on review. The parity answers are synthetic, so no run confirms that one is what LogSeq would return for the new query. The integration suite checks the query on the fixture graph, locally and not in CI, and the answer rests on its derivation from the answers it replaces and on a reviewer reading that derivation. This is a reviewer-tier guard, not a mechanical one.
- Until the call comparison is built (#385), the parity test still holds a case to its recorded calls in order, with their exact text. It is stricter than this ADR, so it errs toward failing and never toward passing a wrong call. The recorded results, the by-meaning comparison of `tools/list` and the closest-name rules are enforced as written.
- The golden files are a record of a server that no longer runs, and a re-recording from the Rust server is possible. The maintainer's explicit OK is the only thing between an implementation bug and a new golden, so a review of a golden diff reads it as a change of contract and not as a refresh.
- Deep equality ignores key order, so a tool's key order is held only by BR-0013's own enforcement, which is not yet mechanical (#299). Until it is, a reordered result passes the parity test.
- The server's own `tools/list` schemas are written by its library. The comparison by meaning needs no adapter that copies the retired library's spellings, and a client that handles `$ref` or nullable arrays worse than inlined schemas is a client-compatibility question, not one for this comparison.
- Two servers can no longer differ on what they suggest, because there is one. The closest-name rules stay, since they are what keeps a matcher change from becoming a contract change. The list is not a pinned part of the result, so a skill or client that ever parses it needs its own decision.
- Publishing a binary is a separate decision with the same "never publish from a session" stance. [ADR-0017 (manual-npm-publish)](0017-manual-npm-publish.md) applies to npm only (#350).
- ADR-0025, ADR-0031 and ADR-0032 are history. A reader who wants the binding rules reads this ADR alone. A later change to them restates this ADR in full instead of adding a link in a chain.

## Status

proposed

Date: 2026-10-08

## Mechanical enforcement

- test: `rust/tests/parity.rs` (every recorded case is run against the stub and its result compared by meaning, `tools/list` is compared by meaning against the recorded list, and the recorded set has to exercise the closest-name rules; it also holds a case to its recorded LogSeq calls, more tightly than Decision 5 until #385)
- test: `rust/tests/parity_support/compare.rs` (the one comparator: JSON results by deep equality with array order kept, every other text byte for byte, the minified check, and the `tools/list` normalization)
- test: `rust/tests/parity_support/suggestion_rules.rs` (the closest-name rules 1 to 6 and the recorded-case coverage of Decision 4)
- test: `rust/tests/parity_self_check.rs` (each case fails when the stub's answer is perturbed, so the comparison can fail)
- ci: `.github/workflows/ci.yml` (the golden-files job fails a pull request that changes a golden file unless it carries the `golden-change` label, which goes on only after the maintainer's OK; the cargo job runs the parity test)
- test: `tests/guards/golden-files-check.test.ts` (keeps the golden-files check in the workflow from being reworded away)
- test: `tests/guards/tool-list.test.ts` (the size budget and description cap over the recorded `tools/list`)
- test: `tests/rust-guards/tool-list-live.test.ts` (the same budget and cap over the list the server sends)
- none-yet: #385 (compare calls by a bounded count, with the order and exact grouping dropped but repeated identical calls kept in order, and a call no recorded call answers failing the case; write down how a call is re-recorded; replaces the parity test's call comparison)
- none-yet: #385 (record the ceiling apart from the call fixtures, lower it when a change makes fewer calls, and make a raised ceiling need the same OK as a golden change, shown in CI with the `golden-change` label)
- reviewer: a PR that re-records a call checks that no golden result changed, that the case's call count stayed within its ceiling and the ceiling was not raised, that every recorded call is a read, that the integration suite passed on the fixture graph for the new query, and that the PR shows how the new stub answer is derived from the answers it replaces; a PR that loosens a call test which an ADR or business rule names as its enforcement is read against that rule; a PR that records a closest-name case the recorded list fails, or adds a golden with a quirk, is checked against Decision 4 and Decision 1; the key order of a result is checked against BR-0013
