# Hold a second implementation to the closest-name suggestions by rule, not by bytes

## Context

[ADR-0031 (second-implementation-matches-tool-list-by-meaning)](0031-second-implementation-matches-tool-list-by-meaning.md) relaxed the `tools/list` comparison to meaning and left tool results byte for byte: "for the same stubbed LogSeq responses, the result text is equal byte for byte". One part of a result makes that expensive. When no page matches, the not-found message ends its first sentence with the closest page names, `No page "<input>". Closest: A, B, C. Try logseq_search_blocks ...` (`PageNotFoundError`, `src/errors.ts`). `suggestPages` (`src/utils/resolve-page.ts`) picks them with fuzzysort 3.1.0 `go`, `limit` 3.

To make those three names come out the same, the Rust spike (#122) ports fuzzysort step for step. `rust/src/fuzzy.rs` on `feature/rust-spike` is about 600 lines (about 420 of code before its tests), with four `PARITY(#299)` tags. It copies UTF-16 counting, accent stripping for Latin-script letters only (two ICU crates), a copy of fuzzysort's priority queue so that equal scores come out in its order, and a `threshold` that fuzzysort turns into `NaN` and so never applies. A 22 KB oracle file, the script that writes it and a TypeScript test that recomputes it keep the port honest. #299 would remove all of it, but only after a cutover (#127).

The list is guidance. A search of `src/`, `skills/` and `tests/` finds nothing that parses it, and `PageNotFoundError.suggestions` is read only to write the message. It is also where the reference gives results that nobody should copy. Over the oracle's 49 made-up names and 66 searches, the TypeScript result ranks a name that merely contains an emoji above one that starts with it, and with a plain lowercase comparison it lists an unaccented name before the accented name that the search typed. A rule about exact and prefix matches has to be written around those.

The maintainer, 2026-10-08, on #122: "let's copy semantics that are important, not quirks." ADR-0031 applied that to `tools/list`. Proposed in #333.

## Decision

This ADR restates ADR-0031 and changes only its last Decision bullet, "Tool results stay byte for byte", by adding one exception. ADR-0031 is marked superseded by it. ADR-0031 is accepted and can't be reworded, and a carve-out here alone would leave it saying "byte for byte" with nothing pointing to the exception. Everything else in ADR-0031 stands as it wrote it: the five normalization rules for `tools/list` and what stays exact, the byte-exact ADR-0016 snapshot for TypeScript, and, through ADR-0031, ADR-0025's spike and go/no-go (Decision 1), the per-toolchain re-scoping of the process docs (Decision 3) and the separate decision to retire TypeScript (Decision 4). Where those say the go/no-go (#127) marks "this ADR" `deprecated`, that now applies to this ADR, the live record of them all. The classification of each ADR under Decision 3 (#128) works from this ADR.

**Tool results, as changed.** For the same stubbed LogSeq responses, the result text is equal byte for byte as the TypeScript server serializes it ([ADR-0009 (minified-json-output)](0009-minified-json-output.md); Markdown likewise), and the same LogSeq calls are made with the same inputs, compared in order when TypeScript makes them one after another and as a set when it makes them concurrently. Contract changes stay additive ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)) and apply to both. **One part is excepted: the list of names after `Closest:` in a page-not-found message.** A second implementation need not choose those names the way fuzzysort does, and may use any matcher. It must meet these rules, which the parity harness checks.

Terms:

- The **reference** is the TypeScript server's recorded result for a case.
- The **candidates** are the `originalName` strings of the pages in the stubbed `logseq.Editor.getAllPages` answer, strings only, as `suggestPages` reads them.
- `fold(s)` is: trim, Unicode NFD, drop combining marks, lowercase. The harness writes it once. A second implementation doesn't need it.
- **E** is the candidates whose fold equals the input's fold. **P** is the candidates whose fold starts with the input's fold and isn't equal to it.

Rules, for every result that carries a page-not-found message (a tool result or the page resource's error):

1. **Frame.** With the suggestion list cut out, the result is byte-equal to the reference's: the error envelope, `No page <input as a JSON string>.`, and the guidance after the list.
2. **Presence.** ` Closest: ...` is there if and only if the reference has it. An ISO date as the input gets none, as today.
3. **Members.** The list is 1 to 3 distinct candidates, each equal byte for byte to a candidate's name, joined by `, `. The harness finds the list by matching against the candidates, because a page name can contain `, `.
4. **Exact and prefix first.** Let T be E and P together, and k the smaller of 3 and the size of T. The first k names are all in T, and every name from E comes before every name from P. The rule is skipped when the input's fold is empty.

The reference has to pass rules 1 to 4 when a case is recorded. A case that the TypeScript result fails can't be recorded, so a fuzzysort quirk can't become contract. Rule 4 is therefore a property of the recorded cases, not a promise about every input on every graph. The run against the TypeScript server keeps comparing its bytes with its record exactly, which is also how a fuzzysort upgrade shows up.

**Left unchecked on purpose:**

- which names fill the list when none starts with the input, and in what order (typo quality, where two matchers differ), and any overlap with the reference's list;
- which of more than three exact or prefix matches are listed, their order among themselves, and ties;
- how accents beyond `fold`, non-Latin scripts, emoji, surrogate pairs, multi-word and mid-word inputs rank;
- whether a suggestion helps a model or a person, which no client study covers;
- behaviour on a graph of thousands of pages with long names, since the harness has dozens of synthetic names.

## Consequences

- The Rust server can use an off-the-shelf matcher. The proposal (#333) names `nucleo-matcher` (MPL-2.0, maintained) over the archived `fuzzy-matcher`, and the dependency is vetted when it is added, not by this ADR. `fuzzy.rs`, the oracle file, the script that writes it, its TypeScript test and the `icu_properties` dependency can go, and a fuzzysort release stops forcing a Rust change.
- The harness gains a parser for the message and the four checks above. The suggestion list is no longer a pinned part of the result, so a skill or client that ever parses it needs its own decision.
- Two servers can suggest different names for the same typo. That is the cost accepted here, and it ends when TypeScript is retired.
- A tool name, parameter or result field is untouched (BR-0004). The message frame stays byte-exact.
- The TypeScript server keeps fuzzysort and its exact bytes. The ADR-0016 snapshot, size budget and description cap are guarded as before.
- ADR-0031's comparison of `tools/list` by meaning stands, and so does the rest of the harness. A reader starts here and follows the links back to ADR-0031 and ADR-0025 for the parts that stand, as ADR-0031 did for ADR-0025. Comments on `feature/rust-spike` that cite ADR-0031 are accurate history and are updated when they are next touched.
- The rules and the Rust swap live on `feature/rust-spike` until the spike merges to `main`, so on `main` the rules are enforced by nothing yet.

## Status

proposed

Date: 2026-10-08

## Mechanical enforcement

- test: `src/tool-list.test.ts` (the TypeScript server's byte-exact snapshot, size budget and description cap, unchanged from ADR-0016 and ADR-0031)
- none-yet: #333 (the harness check of rules 1 to 4 and the cases for them; filed as a task once the direction is accepted, and it becomes a `test:` line when the spike merges to `main`)
- none-yet: #299 (the Rust swap and the removal of the fuzzysort port)
- none-yet: #292 (the parity harness's comparison of `tools/list` by meaning, carried over from ADR-0031; it lands on `feature/rust-spike` and becomes a `test:` line when the spike merges to `main`)
- none-yet: #124 (the differential harness that holds the Rust server to the TypeScript contract, carried over from ADR-0031)
- reviewer: a PR that adds Rust code checks it against every ADR by intent and against ADR-0025 Decision 3's interim rule (that decision has no mechanical guard; #128 adds the per-ADR scope lines), and a PR that changes the harness's suggestion rules or records a case the reference fails is checked against this ADR
