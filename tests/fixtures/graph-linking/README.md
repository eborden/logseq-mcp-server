# Fixture: concept linking

A synthetic LogSeq graph for exercising `.claude/skills/logseq-skills/skills/concept-linking.md`
and its gate, `scripts/check-link-safety.sh`.

Every name, page and event here is invented. Nothing in this fixture comes from a real graph,
which is what allows it to live in a public repository.

```
pages/       13 pages, each engineered for one rule
pages.txt    the page list, as logseq_list_pages would return it
journals/    2024_03_11.md  the unlinked input
expected/    2024_03_11.md  the only correct result
negative/    deliberate defects the gate must reject
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
| `Devon` | `Devon` | `[[Devon]]` | Exact title match |
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

```bash
S=.claude/skills/logseq-skills/scripts/check-link-safety.sh
F=tests/fixtures/graph-linking

./$S "$F/journals/2024_03_11.md" "$F/expected/2024_03_11.md"      "$F" "$F/pages.txt"  # exit 0
./$S "$F/journals/2024_03_11.md" "$F/negative/reworded.md"        "$F" "$F/pages.txt"  # exit 1
./$S "$F/journals/2024_03_11.md" "$F/negative/invented-page.md"   "$F" "$F/pages.txt"  # exit 1
./$S "$F/journals/2024_03_11.md" "$F/negative/unresolved-only.md" "$F" "$F/pages.txt"  # exit 1

# Omitting the page list downgrades check 3 to a warning:
./$S "$F/journals/2024_03_11.md" "$F/negative/unresolved-only.md"                      # exit 0
```

The gate proves an edit was safe. It cannot prove the classification was right, since a pass that
links nothing at all passes every check. Judgement cases (`Kofi`, `Wren`, `Tobias`, `Marisol`, `structured logs`)
need the case map above as their expectation, compared against `expected/2024_03_11.md`.
