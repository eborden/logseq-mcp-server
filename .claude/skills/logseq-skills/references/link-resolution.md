# Link Resolution

Shared rules for adding `[[refs]]` to existing prose. Read this alongside `skills/concept-linking.md`.

Two failure modes drive every rule here, and both are silent:

1. **Misidentification.** Linking a first name to the wrong person. The note still reads correctly, so nobody notices until the person mentioned reads it.
2. **Rewording.** Changing what the note says in order to make a link resolve. The graph gains an edge and the record loses fidelity.

Everything below exists to make those two impossible rather than unlikely.

## Resolution Semantics

LogSeq matches `[[X]]` to a page by name, **case-insensitively but not fuzzily**.

- `[[ledger service]]`, `[[Ledger Service]]` and `[[LEDGER SERVICE]]` all resolve to the same page, and each renders with the capitalisation you typed. So bracketing text whose case differs from the page title is safe and preserves the prose.
- `[[Structured Logs]]` does **not** reach a page called `Structured Logging`. Any difference beyond case creates a new, empty page. Near-misses are not matches.
- An `alias::` property makes its values resolve to the aliased page. If `Priya` carries `alias:: Priya Raghavan`, then `[[Priya Raghavan]]` resolves to `Priya`. Check aliases before reaching for substring bracketing, because the full-string link is the better one.

### Which pages exist

`logseq_list_pages` is the authority. The filesystem is not.

A page that is referenced but never given content exists in LogSeq's database with **no file on disk**. One real graph carries 621 pages against 149 page files, so more than three quarters of its pages are file-less. Deciding a page does not exist because `pages/<Title>.md` is missing will wrongly skip most of the graph's vocabulary, and the error is invisible: it looks like a conservative decision not to link.

Call `list_pages` once, use that listing as the candidate set, and keep it for the gate in the last step.

### Substring bracketing

When a page title is a prefix of the phrase in the prose, bracket the title and leave the remainder outside the brackets:

```
Beacon's rollout slipped      ->  [[Beacon]]'s rollout slipped
the Atlas Squad roadmap       ->  the [[Atlas Squad]] roadmap
Kofi Mensah walked us through ->  [[Kofi]] Mensah walked us through
```

This is what lets a link coexist with plurals, possessives, hyphenated suffixes and surnames without touching a character of the original text.

## Decision Table

| Prose relative to candidate page | Action |
|---|---|
| Identical ignoring case | **Link.** Bracket the text exactly as written |
| Matches an `alias::` value | **Link** the full alias string |
| Page title is a substring, remainder is a suffix, possessive or surname | **Link** the substring only |
| Partial name (first name), two or more candidate pages | **Ask.** Never pick |
| Partial name, exactly one candidate page, no corroboration | **Ask.** Never link on candidate count alone |
| Partial name, exactly one candidate page, corroborated | **Link** the substring |
| Linking would require adding or expanding words in the prose | **Ask,** and state that cost in the question |
| A different string for the same concept | **Skip.** Report it if it recurs |
| Generic or adjectival use of a concept page | **Skip** |
| Already bracketed | **Leave alone.** Never double-bracket |
| No candidate page at all | **Skip.** Report if it recurs |

Note the fourth and fifth rows. **A lone candidate is not evidence.** That exactly one page happens to share a first name says nothing about whether this mention is that person. Candidate count measures the graph's vocabulary, not the identity of the mention, so one candidate and five candidates get the same treatment: ask.

## Asking Is Part of the Job

This workflow is not trying to be autonomous. The person who wrote the note knows who they meant, and they can settle in two seconds what no amount of graph traversal will resolve. A question is the cheapest instrument available here, and a good disambiguation exchange is the process working rather than the process failing.

So do not price asking as a cost to be minimised. Price it against the alternative, which is either a confidently wrong link or a silently dropped one.

Ask well:

- **Batch.** Corroborate first, then put everything corroboration could not settle into one question with one row per term. Six separate questions about six names is an interrogation; one question with six rows is a checklist.
- **Offer the real options.** Name the candidate pages as they exist in the graph, and include a "leave it unlinked" choice, because that is frequently the right answer.
- **State the cost when there is one.** If honouring a link means changing the prose, say which words change. Someone choosing a link target has not thereby agreed to have their note reworded, and conflating those two is how a note ends up claiming something the meeting never said.
- **Do not ask what the graph already answers.** A term with no candidate page has nothing to choose between, and an exact title match needs no permission. Spend the question budget on genuine ambiguity.

## What Counts as Corroboration

Corroboration is independent evidence, elsewhere in the graph, that this short form refers to this page in this context:

- A **roster or team page** listing the candidate alongside other people named in the same block. If a block names three people and a team page carries two of them as `teamMembers::` and the third as `manager::`, the third is corroborated.
- A **property pointing at the candidate**: `manager::`, `owner::`, `teamMembers::`, `reports::`.
- **Backlinks** showing the short form already used for that page in comparable blocks.
- An **`alias::`** covering the exact string, which is corroboration and resolution at once.

What does not count: the name being the only match, the name being plausible in context, or the surname appearing nowhere else in the graph.

Each corroboration check costs one or two tool calls, so only run them on partial names you would otherwise link, and batch the lookups. A block naming six people rarely needs six checks; fetching the one team page that covers most of them usually settles several at once.

## Anti-Patterns

**Rewording to force a match.** Prose says `structured logs`, the page is `Structured Logging`. Changing the prose to match the title makes the link resolve and corrupts the record. Skip it. If the concept recurs, report that the page might deserve an `alias:: structured logs` and let the graph's owner decide.

**Substituting a page title for a name.** Prose says a person's full name and the graph represents them with a page under a different label. Replacing the name with the label alters what the note says, and a note that others will read should keep the name. Skip it.

**Expanding abbreviations.** Prose says `TS`, the page is `TypeScript`. That is a different string, so it is a new page, and the expansion is a guess about intent. Skip it.

**Linking generic or adjectival mentions.** A page named `Automation` does not mean every `automation-driven` and `the automation budget` should carry a ref. Link a concept where the note is about it, not everywhere the word appears. When in doubt, once per block at most, at the mention that carries the meaning.

**Coincidental string matches.** A page title can appear inside prose that has nothing to do with it, especially short titles and common nouns. Read the sentence before bracketing.

**Over-linking a single block.** A block where every third word is bracketed is harder to read than one with three good refs. Links are for retrieval, and retrieval does not improve past the first ref to a given page in a block.

## The Gate

Before reporting a linking pass complete, run:

```bash
scripts/check-link-safety.sh <before> <after> [graph-root] [page-list]
```

It asserts that stripping every `[[` and `]]` from both files leaves them byte-identical, that brackets are balanced and unnested, and that every ref resolves to a known page or alias.

The first check is the load-bearing one. It proves mechanically that the pass added brackets and changed nothing else, capitalisation included, which is what distinguishes bracketing the text as written from substituting a page's spelling for the note's. Keep a copy of the file from before the edit so the gate has a baseline.

Pass the `page-list` (one title per line, from `list_pages`) to make the resolvability check meaningful. Without it the check degrades to a warning, because page files are a subset of pages and absence of a file proves nothing.

Exits non-zero on violation. Fix the edit and re-run rather than explaining the failure away.

### What the gate cannot do

It proves an edit was **safe**, not that the classification was **right**. A pass that links nothing at all passes every check. Identity errors, the failure this skill exists to prevent, are invisible to it: `[[Kofi]]` and a wrongly-linked `[[Devon]]` are equally well-formed. Corroboration in step 6 is the only defence there, and the gate is no substitute for it.
