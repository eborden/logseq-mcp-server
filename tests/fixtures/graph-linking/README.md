# Fixture: concept linking

A synthetic LogSeq graph for exercising `skills/logseq-skills/skills/concept-linking.md`
and its gate, the `logseq_check_links` tool (`src/tools/check-links.ts`).

Every name, page and event here is invented. Nothing in this fixture comes from a real graph,
which is what allows it to live in a public repository.

```
pages/       13 pages, each engineered for one rule
pages.txt    the page names, as logseq_list_pages would return them (the unit tests build their fake graph from it)
journals/    2024_03_11.md  the unlinked input
expected/    2024_03_11.md  the only correct result
negative/    deliberate defects the gate must reject
variants/    the same note against a graph with a few pages changed (see "Variant: bare")
```

**Where this fixture is easier than reality:** every page here has a file, so scanning `pages/`
happens to enumerate the graph. Real graphs do not work that way. A page that is referenced but
never given content has no file at all, and one real graph carries 621 pages against 149 files.
`pages.txt` exists so the fixture exercises the code path a real graph actually needs, rather than
the one the directory listing makes convenient.

## Case map

Each term in `journals/2024_03_11.md` tests exactly one branch of the decision table. The rows run
patterns-to-copy first, then the cases that must go to a question.

| Prose in the input | Candidate page | Correct action | Rule under test |
|---|---|---|---|
| `Priya Raghavan` | `Priya` with `alias:: Priya Raghavan` | `[[Priya Raghavan]]` | **The preferred pattern for any full name:** a full-name alias links it whole |
| `Beacon's` | `Beacon` | `[[Beacon]]'s` | **The canonical safe substring case:** the leftover `'s` is inflection, not part of the noun |
| `Devon` | `Devon` | `[[Devon]]` | Exact title match on a bare first name, so it needs corroboration: `Atlas Squad` lists Devon beside Priya, whom the same sentence names. Without that roster entry it would go to the question: see "Variant: bare" |
| `Kofi Mensah` | `Kofi` | ask; plain without an alias | **Regression: a proper-noun leftover fragments the name.** Corroborated by `Atlas Squad.manager`, and still not bracketable safely |
| `Wren` | `Wren Calloway`, in `Atlas Squad.teamMembers` | ask; plain without an alias | **Regression: prose inside the title is not bracketable at all, however certain the identity** |
| `Tobias` | `Tobias Fenn` | ask; plain unless confirmed | **Regression: a lone candidate is not evidence.** Identity only; the mechanics questions are `Kofi`'s and `Wren`'s |
| `Marisol` | `Marisol Vega`, `Marisol Okonkwo` | ask; plain unless confirmed | Two candidates means never pick |
| `NorthWind` | `Northwind` | `[[NorthWind]]` | Case-only difference links, prose spelling kept |
| `structured logs` | `Structured Logging` | leave plain | Different string, so a new page; skip and report |
| `automation-driven`, `the automation budget` | `Automation` | leave plain | Generic and adjectival mentions |
| `[[Quarterly Planning]]` | `Quarterly Planning` | unchanged | Never double-bracket |

The corroboration chain is deliberate, and one page fetch settles three names at once: the journal
names Priya, Kofi, Devon and Wren, and `Atlas Squad` carries Priya, Devon and Wren Calloway as
`teamMembers::` with Kofi as `manager::`. That leaves exactly two identity questions in the fixture,
`Tobias`, which is attached to nothing, and `Marisol`, which has two candidates. `Tobias Fenn` is
the regression case for candidate count, and it now tests identity alone.

`Kofi` and `Wren` are the two halves of the mechanics question, and they fail for opposite reasons.

`Kofi Mensah` against a `Kofi` page is title-inside-prose, so `[[Kofi]] Mensah` can be written and
preserves every character. It is still wrong, because the leftover is a surname rather than an
inflection, and the result names a person half in a ref and half in plain text while the graph
records an edge to a first name. This is the case that looks safest and is not: the prose is intact
and all three gate checks pass. Compare `Beacon's`, where the leftover really is inflection.

`Wren` against a `Wren Calloway` page is prose-inside-title, so brackets cannot be placed at all:
`[[Wren]]` points at a different page and `[[Wren Calloway]]` adds a surname the note never carried.
Identity is not the issue in either case. `Wren Calloway` sits in the same `Atlas Squad` roster as
Priya and Devon, so the one page fetch that settles `Kofi` settles `Wren` too.

Both arrive at the same remedy, an `alias::` on the target page with the owner's consent, carrying
the full name for `Kofi` and the short form for `Wren`. That is what `Priya` already demonstrates.
`expected/` shows the outcome where consent was not given, so both stay plain there. Together the pair proves that direction decides whether brackets
are *possible* and the leftover decides whether they are *right*, and that neither question answers
the other.

## Variant: bare (#147, #169)

The `Devon` row above links only because `Atlas Squad` lists him. This variant is the same graph with
that corroboration taken away, so the other half of the rule has a reproducible case: a bare first name
that matches a page title exactly, with nothing tying it to the note, goes to the step 7 question and
stays plain. ADR-0024 baseline runs for the #147 rule cite this variant as the "bare" graph and the
base fixture as the "roster" graph.

```
variants/bare/pages/Atlas Squad.md     teamMembers:: [[Priya]], [[Wren Calloway]]  (no Devon)
variants/bare/pages/Devon.md           "Engineer." with no link to anything
variants/bare/expected/2024_03_11.md   the only correct result for this graph
```

**Structure.** A variant is an overlay, not a second copy of the graph. Take the base `pages/`, then
replace the files of the same name from `variants/bare/pages/`. Everything else is shared: the input
note (`journals/2024_03_11.md`) and `pages.txt` are the same, because no page is added or removed (the
`Devon` page still exists, since an exact title match is the premise). Only the two pages that differ
are stored, so a change to any other page reaches both graphs and the two cannot drift apart.

**What differs from the base graph.** Nothing else in the graph mentions Devon: no roster, no property,
no page that links to or from the `Devon` page. The page's only text is a job title, which matches the
title and so cannot corroborate itself.

**Expected result.** Identical to `expected/2024_03_11.md` except `Devon` is plain text, so it is the
step 7 question's subject, like `Tobias`. The single-referent matches still link, so the variant doubles
as the control that the rule did not turn into "ask about everything":

| Prose | Result in the bare graph |
|---|---|
| `Devon` | plain, ask (the change from the base graph) |
| `Priya Raghavan`, `Beacon's`, `NorthWind` | link, as in the base graph |
| `Kofi Mensah`, `Wren`, `Tobias`, `Marisol`, `structured logs`, `automation` | plain, as in the base graph |

As with the base fixture, the gate cannot judge this. The roster-graph `expected/` passes the gate
against the bare graph too, because `[[Devon]]` resolves and the prose is intact. A run is judged by
comparing its question and diff against this table, not by the gate.

## Negative cases

| File | Defect | Check that must fire |
|---|---|---|
| `negative/reworded.md` | `structured logs` rewritten to `[[Structured Logging]]` | 1, prose preservation |
| `negative/invented-page.md` | `[[Retry Budget]]`, which no page backs | 1 and 3 |
| `negative/unresolved-only.md` | `[[retry budget]]`, prose case kept | 3 alone |

`invented-page.md` trips check 1 as well as check 3, because bracketing `Retry Budget` over prose
that read `retry budget` changes the capitalisation. That is correct, and it is the distinction
worth understanding: bracketing the text as written passes, substituting the page's spelling for
the note's does not. `unresolved-only.md` isolates check 3 by keeping the prose case intact.

## Running

`src/tools/check-links.test.ts` runs `checkLinks` on `expected/` and on each file in `negative/`
against a fake graph built from `pages.txt`. It passes `expected/` and fails each negative case
on the checks in the table above:

```bash
npx vitest run src/tools/check-links.test.ts
```

The shell script that used to be the gate, `skills/logseq-skills/scripts/check-link-safety.sh`,
was retired in #142. The tool runs the same checks, plus one the script lacked: every ref in the
input is still a ref in the result.

The gate proves an edit was safe. It cannot prove the classification was right, since a pass that
links nothing at all passes every check. Judgement cases (`Kofi`, `Wren`, `Tobias`, `Marisol`, `structured logs`)
need the case map above as their expectation, compared against `expected/2024_03_11.md`.
