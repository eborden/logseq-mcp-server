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

When a page title is a prefix of the phrase in the prose, you can often bracket the title and leave the remainder outside the brackets. Read the next subsection before using it, because "often" is doing real work in that sentence:

```
Beacon's rollout slipped   ->  [[Beacon]]'s rollout slipped
a Northwind-wide freeze    ->  a [[Northwind]]-wide freeze
the Atlas Squad roadmap    ->  the [[Atlas Squad]] roadmap
```

This is what lets a link coexist with plurals, possessives and hyphenated suffixes without touching a character of the original text. `[[Beacon]]'s` is the case to copy: the leftover `'s` is morphology hanging off the noun, and splitting it out changes nothing about what the note names.

#### The leftover decides

Substring bracketing is not uniformly safe, and whether it is safe has nothing to do with which string is longer. It depends on what the text left outside the brackets turns out to be.

- **Leftover is an inflection.** A possessive, a plural, a hyphenated modifier. Safe, as above. Those characters attach to the noun rather than belonging to it.
- **Leftover is part of the same proper noun**, which in practice means a surname. **This fragments the name**, and it is a defect even though the brackets sit in a legal place:

```
Kofi Mensah walked us through  ->  [[Kofi]] Mensah walked us through   # fragments the name
```

The rendered characters are identical to the original, so the gate passes this without complaint. What the gate cannot see is that the note now names a person in two pieces, a ref to a first name plus an orphaned surname, and the graph records an edge to `Kofi` rather than to the person the note actually named. Nobody writes `Kofi Mensah` meaning `Kofi` followed by a stray word, so treating the surname as leftover misreads the prose even while preserving it.

So when the title is a proper-name prefix and the remainder belongs to that same name, do not bracket it silently. Prefer an `alias::` carrying the **full** name on the target page: `alias:: Kofi Mensah` on the `Kofi` page makes `[[Kofi Mensah]]` resolve whole, the prose keeps every character, and the edge points at the person as the note named them. That writes to a page outside the note, so it needs the owner's consent, exactly like the alias remedy in the next section. Ask rather than fragment.

`Priya` carrying `alias:: Priya Raghavan`, which yields `[[Priya Raghavan]]`, is not a quirk of one page. It is the pattern to aim for with any full name, and it is why aliases are worth checking before substring bracketing is considered at all.

### Mismatch direction

Whenever the prose and a candidate title differ by more than case, work out which one contains the other before deciding anything else. The check is mechanical: take the phrase as the note wrote it and the title as the graph spells it, and see which is the substring of which.

- **Title inside the prose.** Prose says `Beacon's`, the page is `Beacon`. Bracketable, subject to the leftover test above: an inflection is safe, the rest of a proper noun is not.
- **Prose inside the title.** Prose says `Wren`, the page is `Wren Calloway`. **Not bracketable at all**, by any arrangement of brackets. `[[Wren]]` resolves to a page called `Wren`, which is a different page and usually an empty new one. `[[Wren Calloway]]` puts a surname into the note that the writer never typed. There is no third bracketing to reach for, which is why this direction needs its own handling rather than a harder look at the text.

Run this check on every partial name, including the ones corroboration has already settled. Corroboration answers who the mention refers to; direction answers whether that answer can be honoured with brackets. Being certain `Wren` means Wren Calloway does nothing to make `[[Wren]]` resolve there, and treating the two questions as one is how a surname ends up silently inserted into somebody's journal.

When the prose sits inside the title there are exactly three responses:

1. **Add an `alias::` to the target page.** Putting `alias:: Wren` on `Wren Calloway` makes a bare `[[Wren]]` resolve there, so the prose is bracketed exactly as written and nothing is reworded. This is usually the right answer, because it is the only response that both links this mention and fixes every future bare mention of that short form anywhere in the graph. Two conditions attach to it:
   - **The short form must be unambiguous**, meaning exactly one page in the listing could claim it. If two pages carry `Chris`, an `alias:: Chris` on either one makes that page win every future `[[Chris]]` silently, including the mentions that meant the other person. An ambiguous short form never gets an alias.
   - **It edits a page outside the note being worked on**, which is beyond what a linking pass was asked to do and affects every other note in the graph. Get the user's consent before writing it, and say which page gains the property.
2. **Expand the prose to the full title.** Available only if the writer explicitly asks for it, because it changes what the note says. It is an edit to the note rather than a linking pass, so the gate will reject it against the original baseline, correctly.
3. **Leave it unlinked.** Always available and always safe. A missing edge costs retrieval; a reworded note costs the record.

Hold `Kofi` and `Wren` side by side, because together they say what neither says alone. `Kofi Mensah` against a `Kofi` page is title-inside-prose, so brackets can be placed legally; `Wren` against a `Wren Calloway` page is prose-inside-title, so they cannot be placed at all. Mechanically those are opposite cases, and both arrive at the same remedy: an `alias::` on the target page, with the owner's consent, carrying the full name in one case and the short form in the other. Direction tells you whether brackets are *possible*. The leftover tells you whether they are *right*. Neither question answers the other, and a name is at stake in both.

## Decision Table

| Prose relative to candidate page | Action |
|---|---|
| Identical ignoring case | **Link.** Bracket the text exactly as written |
| Matches an `alias::` value | **Link** the full alias string |
| Page title is a substring, remainder is an inflection (possessive, plural, hyphenated suffix) | **Link** the substring only |
| Page title is a substring, remainder is the rest of the same proper noun (a surname) | **Ask.** See The leftover decides: offer a full-name `alias::` rather than fragmenting the name |
| Partial name (first name), two or more candidate pages | **Ask.** Never pick |
| Partial name, exactly one candidate page, no corroboration | **Ask.** Never link on candidate count alone |
| Partial name, exactly one candidate page, corroborated | **Link** the substring, provided the leftover test allows it |
| Prose is a substring of the candidate page title | **Not bracketable.** See Mismatch direction: offer the `alias::`, and state the prose cost of the alternative |
| A different string for the same concept | **Skip.** Report it if it recurs |
| Generic or adjectival use of a concept page | **Skip** |
| Already bracketed | **Leave alone.** Never double-bracket |
| No candidate page at all | **Skip.** Report if it recurs |

Note the two candidate-count rows. **A lone candidate is not evidence.** That exactly one page happens to share a first name says nothing about whether this mention is that person. Candidate count measures the graph's vocabulary, not the identity of the mention, so one candidate and five candidates get the same treatment: ask.

Note also that the surname row and the prose-inside-title row land on the same remedy from opposite mechanics. Four of the twelve rows send a name to a question rather than to a link, and that proportion is the table working rather than the table being timid: names are where this goes wrong, and a question is cheaper than an edge recorded against the wrong person or against half of a right one.

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

**Fragmenting a proper noun.** Prose says `Kofi Mensah` and the page is `Kofi`, so `[[Kofi]] Mensah` is available and preserves every character. Do it anyway and the note names a person half in a ref and half in plain text. This one is worth listing separately because it feels like the safe move: the prose is intact, the gate is green, and the mistake is only visible to someone who reads the name as a name. Ask for a full-name `alias::` instead. Doing this at scale, ten names in one pass, turns a graph's people into first-name stubs.

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

It proves an edit was **safe**, not that the classification was **right**. A pass that links nothing at all passes every check. Two whole classes of error are invisible to it:

- **Identity errors**, the failure this skill exists to prevent. A wrongly-linked `[[Devon]]` is as well-formed as a right one. Corroboration in step 6 is the only defence.
- **Fragmented names.** `[[Kofi]] Mensah` preserves the prose byte for byte, balances its brackets, and resolves to a real page, so all three checks pass while the note has stopped naming a person in one piece. The leftover test in step 6 is the only defence.

Both failures are judgement, and the gate does not do judgement. Do not read a green gate as a correct pass.
