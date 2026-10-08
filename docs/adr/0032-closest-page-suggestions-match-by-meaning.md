# Hold a Rust implementation to the TypeScript tool contract: by meaning for tools/list and closest-name suggestions, byte for byte for the rest

## Context

The maintainer wants a self-contained binary with a lower startup time and memory footprint than the Node server, and a stricter type system. Node single-executable builds are fragile, and a Node process's footprint is the part that stays. Rust's type system can make more illegal states unrepresentable, which suits the parse-at-the-boundary principle ([ADR-0019 (parse-input-at-boundary)](0019-parse-input-at-boundary.md)). The maintainer expects to review little of the code the agents write, so the safety net is tests, not a human reading the diff. A rewrite would also strand the process docs: several ADRs, `docs/architecture-foundations.md` and `CLAUDE.md` name TypeScript mechanisms, and accepted ADRs are immutable. Tracked in #122. The full reasoning is in [ADR-0025 (rust-implementation-alongside-typescript)](0025-rust-implementation-alongside-typescript.md).

ADR-0025 Decision 2 said the Rust server "must emit the same `tools/list` (the ADR-0016 snapshot)" and results equal byte for byte. The spike showed what the first half costs: the Rust schema adapter had to copy zod's serialization quirks (inlined enums instead of `$defs` and `$ref`, optional fields that aren't `["T", "null"]`, no `format` keyword, `50` rather than `50.0`). None of them changes what a client may send. The maintainer, 2026-10-08, on #122: "let's copy semantics that are important, not quirks." [ADR-0031 (second-implementation-matches-tool-list-by-meaning)](0031-second-implementation-matches-tool-list-by-meaning.md) applied that to `tools/list` and kept results byte for byte.

One part of a result makes that expensive too. When no page matches, the not-found message gives the closest page names, `No page "<input>". Closest: A, B, C. Try logseq_search_blocks ...` (`PageNotFoundError`, `src/errors.ts`). `suggestPages` (`src/utils/resolve-page.ts`) picks them with fuzzysort 3.1.0 `go`, `limit` 3. To make those three names come out the same, the Rust spike ports fuzzysort step for step. `rust/src/fuzzy.rs` on `feature/rust-spike` is about 600 lines (about 420 of code before its tests), with four `PARITY(#299)` tags. It copies UTF-16 counting, accent stripping for Latin-script letters only (two ICU crates), a copy of fuzzysort's priority queue so that equal scores come out in its order, and a `threshold` that fuzzysort turns into `NaN` and so never applies. A 22 KB oracle file, the script that writes it and a TypeScript test that recomputes it keep the port honest. #299 would remove all of it, but only after a cutover (#127).

The list is guidance. A search of `src/`, `skills/` and `tests/` finds nothing that parses it, and `PageNotFoundError.suggestions` is read only to write the message. It is also where the reference gives results that nobody should copy. Over the oracle's 49 made-up names and 66 searches, the TypeScript result ranks a name that merely contains an emoji above one that starts with it, and with a plain lowercase comparison it lists an unaccented name before the accented name that the search typed. A rule about exact and prefix matches has to be written around those. Proposed in #333.

This ADR restates ADR-0025's and ADR-0031's decisions, so that the rules that bind a second implementation live in one ADR that isn't superseded. Both stay as history. ADR-0031 is marked superseded by this ADR, and ADR-0025 already points to ADR-0031.

## Decision

1. **We explore a Rust implementation beside the TypeScript one.** Both live in this repo and the TypeScript server stays the shipped one. A spike (#123 to #126) ports one representative tool, `logseq_get_page_outline` (it needs the shared page resolver, a bound Datalog query, a capped result and sibling ordering, in 2 API calls), measures startup and footprint, and evaluates the official Rust MCP SDK. A go/no-go decision (#127) follows. A "no-go" marks this ADR `deprecated`. A "go" leaves it accepted and opens the port.

2. **The TypeScript tool contract is the specification.** Until TypeScript is retired, a second implementation must meet it, as checked by a differential parity harness over synthetic fixtures (#124, #292). The harness compares four things, each as follows.

   - **`tools/list` is compared by meaning.** Both lists are normalized the same way before they are compared, and only these differences are treated as serialization, not meaning:
     1. **`$ref` resolution.** A `$ref` into `$defs` or `definitions` is replaced by what it points at, and the definitions are dropped. A `$ref` with sibling keywords, or an `allOf` of one schema, is merged into one schema; a clash stays an `allOf`, so it still shows as a difference. Only local JSON-pointer refs (`#` or `#/...`) are resolved. An anchor-style (`#Foo`), non-local, recursive or dangling `$ref` isn't resolved and is reported as a difference.
     2. **Null on optional fields.** A **top-level** property of `inputSchema` that isn't in `required` loses the null it also accepts (`[T, "null"]`, a null branch of `anyOf` or `oneOf`, `null` in `enum`), because the TypeScript server treats an explicit top-level `null` as absent (`withoutNulls` in `parseArgs`, `src/utils/parse-args.ts`). A required property, and any property of a nested object or of an object inside `items`, keeps its null, since the TypeScript server rejects a `null` there.
     3. **Non-validating annotation keywords.** The `$schema`, `format` and `title` keywords inside a schema are dropped. A property named `format`, and the tool's own `title` and `annotations`, are kept.
     4. **Numbers by value.** `50`, `50.0` and `5e1` are the same number.
     5. **Set-like `required`.** `required` is compared as a set, and object key order never matters.
   - **What stays exact in `tools/list`:** tool names, titles, annotations, descriptions, types, `required` members, bounds, enum values (in order), defaults, parameter descriptions and `additionalProperties`.
   - **The ADR-0016 snapshot stays byte-exact for TypeScript.** [ADR-0016 (tool-list-size-guardrails)](0016-tool-list-size-guardrails.md) is unchanged: its snapshot is the TypeScript server's byte-exact guard and its size budget. The harness's reference list is recorded from the TypeScript server and held to that snapshot byte for byte, so the reference can't drift from it.
   - **Tool results are byte for byte, except the closest-name list.** For the same stubbed LogSeq responses, the result text is equal byte for byte as the TypeScript server serializes it ([ADR-0009 (minified-json-output)](0009-minified-json-output.md); Markdown likewise), and the same LogSeq calls are made with the same inputs, compared in order when TypeScript makes them one after another and as a set when it makes them concurrently. Contract changes stay additive ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)) and apply to both. The one exception is the list of names after `Closest:` in a page-not-found message, below.

3. **The closest-name list is checked by rules, not bytes.** A second implementation need not choose those names the way fuzzysort does, and may use any matcher. The TypeScript server keeps fuzzysort, and its own run keeps comparing its bytes with its record exactly, which is also how a fuzzysort upgrade shows up.

   **Terms.**
   - The **reference** is the TypeScript server's recorded result for a case.
   - The **candidates** are the `originalName` strings of the pages in the stubbed `logseq.Editor.getAllPages` answer, strings only, as `suggestPages` reads them.
   - `fold(s)` is: trim, Unicode NFD, drop combining marks, lowercase. The harness writes it once. A second implementation doesn't need it.
   - The input's **tokens** are `fold(input)` split on spaces, empty pieces dropped. A name **covers** a token when the token's characters appear in order, not necessarily next to each other, in the name's fold.
   - **E** is the candidates whose fold equals the input's fold. **P** is the candidates whose fold starts with the input's fold and isn't equal to it. **T** is E and P together. **N** is the candidates that cover every token, and **n** is the number of them.

   **The message is read decoded.** The harness compares the message string, not the bytes around it: the `error` string of a tool result's `{"error": ...}` JSON, or the message of the JSON-RPC error for the page resource. A name with a quote, a backslash or a control character is therefore compared as the name, not as its escaped form. The message is `No page <input as a JSON string>. <guidance>` with no list, or `No page <input as a JSON string>. Closest: <list>. <guidance>`, where the guidance is the fixed sentence `Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.`

   **Rules**, for every result that carries a page-not-found message. Rules 1 and 2 apply to every such result. Rules 3 to 6 apply only when the reference message uses the `Closest:` form, and rule 2 makes the second implementation's message use it too. A reference message with no list (an ISO date, or an input no candidate covers) is then checked by rules 1 and 2 alone, and rule 6 does not look for matches the reference didn't list.
   1. **Frame.** The message, with the list cut out, equals the reference's, and the rest of the result (the envelope, `isError`) is byte-equal to the reference's. The list is everything between the opening `No page <json>. Closest: ` and the closing `. <guidance>`. The opening is matched at the start of the message and the closing at its end, so a name that contains `. Try` or ends with a full stop doesn't move the edges.
   2. **Presence.** The `Closest:` form is used if and only if the reference uses it. An ISO date as the input gets none, as today.
   3. **Members.** The list is one to three distinct candidates, each equal byte for byte to a candidate's name, joined by `, `. A name can contain `, `, so the harness splits the list by trying candidates left to right, the longest matching name first, and backing up when a choice leaves the rest unreadable. That split is the one rules 4 to 6 use. It exists if and only if some split does, and it is unique for any list the harness records, because a case whose reference list can be split in two ways isn't recorded.
   4. **Exact and prefix first.** Let k be the smaller of 3 and the size of T. The first k names are all in T, and every name from E comes before every name from P. The rule is skipped when the input's fold is empty.
   5. **Relevance.** Every listed name is in N. The list therefore can't be the same three pages for every input.
   6. **Count.** The list has at least the smaller of 3 and n names.

   **The reference has to pass rules 3 to 6** when a case is recorded and its message uses the `Closest:` form (rules 1 and 2 hold for it by construction), and a case it fails isn't recorded, so a fuzzysort quirk can't become contract. Rules 4 and 6 are therefore properties of the recorded cases, not promises about every input on every graph. Over the oracle's 66 searches the reference meets rules 5 and 6 every time, and breaks rule 4 only for an emoji search.

   **The recorded set has to exercise the rules,** or rule 4 could pass without checking anything. The harness fails if the set lacks any of these cases, each recorded from the TypeScript server:
   - an exact hit, with E and P both non-empty (the order of E before P);
   - a prefix hit, with E empty and P non-empty;
   - more than three names in T (the cap of three);
   - a typo with no prefix hit and at least one name in N (T empty, so rules 5 and 6 are what is checked);
   - no suggestion: an ISO date, and an input that no candidate covers;
   - a candidate whose name contains `, `, in the list (rule 3's split);
   - the page resource's error, not only a tool result.

   The stubbed resolver may answer no page for a name that `getAllPages` still lists, which is how the exact-hit cases arise.

   **Left unchecked on purpose:**
   - which names fill the list beyond the first k, among those in N, and in what order (typo quality, where two matchers differ), and any overlap with the reference's list;
   - which of more than three exact or prefix matches are listed, their order among themselves, and ties;
   - how accents beyond `fold`, non-Latin scripts, emoji, surrogate pairs, tabs and other white space, and mid-word inputs rank, since the recorded names are ordinary ones;
   - whether a suggestion helps a model or a person, which no client study covers;
   - behaviour on a graph of thousands of pages with long names, since the harness has dozens of synthetic names.

4. **Process docs are re-scoped per toolchain, not superseded.**
   - An ADR whose Decision describes the contract, LogSeq's behaviour or how we work binds every implementation. Reading it for Rust means reading its intent, with the mechanism that names TypeScript read as "the TypeScript mechanism".
   - An ADR whose Decision is itself about the TypeScript toolchain (for example the Node floor and the npm publish path) applies to the TypeScript implementation only. The Rust equivalent, if there is one, gets its own ADR. This is a scope reading, not a supersession: those ADRs say nothing about Rust, so a second implementation reverses nothing in them. #128 adds a `reviewer:` line to each such ADR's Mechanical enforcement section stating its scope, so a reader of ADR-0022 alone can find out.
   - Each accepted ADR keeps its text. Rust's way of meeting it is recorded by adding a `<tier>: <reference>` line to its Mechanical enforcement section, which the ADR README already allows to be updated in place.
   - `docs/architecture-foundations.md`, `CLAUDE.md` and the business rules are editable. Foundations is split into toolchain-neutral principles and a section per toolchain. Business rules are edited in place with Changelog rows, as their README says.
   - The classification of each ADR and the doc rewrite happen in #128, after a "go", working from this ADR. Nothing is reclassified before then. **Interim rule for the spike:** the Rust code follows every ADR by its intent, except ADR-0017, ADR-0022 and the `node dist/index.js` launch in ADR-0018, which are TypeScript-only.

5. **Retiring the TypeScript implementation is a separate decision** and gets its own ADR, if and when the Rust server reaches parity and ships.

## Consequences

- A second implementation emits the schemas its own library writes, and its adapter copies only what clients rely on. It can pick closest names with an off-the-shelf matcher. The proposal (#333) names `nucleo-matcher` (maintained, MPL-2.0) over the archived `fuzzy-matcher`, and the dependency is vetted when it is added, not by this ADR. `fuzzy.rs`, the oracle file, the script that writes it, its TypeScript test and the `icu_properties` dependency can then go, and a fuzzysort release stops forcing a Rust change.
- MPL-2.0 next to [ADR-0023 (mit-license)](0023-mit-license.md)'s MIT is not decided here. It is decided when the dependency is vetted, and it needs the maintainer's call. If it is refused, the fallback is a small hand-written ranker (exact, then prefix, then substring, then subsequence) that meets rules 4 to 6 by construction.
- The harness, not the snapshot, defines "same contract" for a second implementation, so the normalization rules and the suggestion rules are part of the contract. Loosening one is a change to this decision. The harness gains a parser for the message and the six checks, and a coverage check on its cases. The suggestion list is no longer a pinned part of the result, so a skill or client that ever parses it needs its own decision.
- Two clients could still read two `tools/list` payloads differently even when they compare equal: some MCP clients may handle `$ref` or nullable arrays worse than inlined schemas. That is a client-compatibility check for the go/no-go (#127), not for the harness.
- Two servers can suggest different names for the same typo. That is the cost accepted here, and it ends when TypeScript is retired.
- Two implementations are kept in step while both exist: every contract change lands twice, and the harness has to stay green. The harness doubles as a regression suite for the contract. A spike that ends in "no-go" still leaves it and a record of why.
- "Read the intent" leaves some judgment to the reader until #128 classifies each ADR. Each Rust enforcement line added in #128 is an edit to an accepted ADR and needs the maintainer's approval, so #128 is a long approval queue. A `test:` line can only land once the Rust file it names exists.
- ADR-0018 launches the server with `node dist/index.js`, and a Rust CI or release workflow could trip the checks in `src/adr-workflow-guards.test.ts`. The spike keeps its workflow separate. Publishing a binary is a new release path: [ADR-0017 (manual-npm-publish)](0017-manual-npm-publish.md) applies to npm only, and a binary release needs its own ADR, with the same "never publish from a session" stance.
- A tool name, parameter or result field is untouched (BR-0004), and the message frame stays byte-exact. The TypeScript server's bytes, size budget and description cap are guarded as before.
- The harness and the Rust swap live on `feature/rust-spike` until the spike merges to `main`, so on `main` the comparisons are enforced by nothing yet (#336). Comments there that cite ADR-0031 are accurate history and are updated when they are next touched.
- ADR-0031's text, and ADR-0025's, are history now. A reader who wants the binding rules reads this ADR alone. A later change to them restates this ADR in full instead of adding a link in a chain.

## Status

accepted

Date: 2026-10-08

## Mechanical enforcement

- test: `tests/guards/tool-list.test.ts` (the recorded `tools/list`: size budget and description cap, unchanged from ADR-0016; the TypeScript server's byte-exact snapshot went with that server, #356)
- none-yet: #335 (the harness check of the suggestion rules and the required cases of Decision 3; it becomes a `test:` line when the harness is on `main`)
- none-yet: #336 (lands the parity harness on `main`: the byte comparison of results, the comparison of `tools/list` by meaning and the same LogSeq calls, from #124 and #292, which are closed; becomes `test:` lines)
- none-yet: #299 (the Rust swap and the removal of the fuzzysort port)
- reviewer: a PR that adds Rust code checks it against every ADR by intent and against Decision 4's interim rule (Decision 4 has no mechanical guard; #128 adds the per-ADR scope lines), and a PR that changes the harness's suggestion rules or records a case the reference fails is checked against Decision 3
