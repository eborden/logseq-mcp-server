# Fixture: concept linking

A synthetic LogSeq graph for exercising `.claude/skills/logseq-skills/skills/concept-linking.md`
and its gate, `scripts/check-link-safety.sh`.

Every name, page and event here is invented. Nothing in this fixture comes from a real graph,
which is what allows it to live in a public repository.

```
pages/       12 pages, each engineered for one rule
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

Each line of `journals/2024_03_11.md` tests exactly one branch of the decision table.

| Prose in the input | Candidate page | Correct action | Rule under test |
|---|---|---|---|
| `Priya Raghavan` | `Priya` with `alias:: Priya Raghavan` | `[[Priya Raghavan]]` | Alias resolution beats substring bracketing |
| `Kofi Mensah` | `Kofi` | `[[Kofi]] Mensah` | Partial name, corroborated by `Atlas Squad.manager` |
| `Devon` | `Devon` | `[[Devon]]` | Exact title match |
| `Tobias` | `Tobias Fenn` | ask; plain unless confirmed | **Regression: a lone candidate is not evidence** |
| `Marisol` | `Marisol Vega`, `Marisol Okonkwo` | ask; plain unless confirmed | Two candidates means never pick |
| `Beacon's` | `Beacon` | `[[Beacon]]'s` | Possessive stays outside the brackets |
| `NorthWind` | `Northwind` | `[[NorthWind]]` | Case-only difference links, prose spelling kept |
| `structured logs` | `Structured Logging` | leave plain | Different string, so a new page; skip and report |
| `automation-driven`, `the automation budget` | `Automation` | leave plain | Generic and adjectival mentions |
| `[[Quarterly Planning]]` | `Quarterly Planning` | unchanged | Never double-bracket |

The corroboration chain for `Kofi` is deliberate: the block names Priya, Kofi and Devon, and
`Atlas Squad` carries Priya and Devon as `teamMembers::` with Kofi as `manager::`. One page
fetch settles the name. `Tobias Fenn` is attached to nothing, which is what makes it the
regression case.

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
links nothing at all passes every check. Judgement cases (`Tobias`, `Marisol`, `structured logs`)
need the case map above as their expectation, compared against `expected/2024_03_11.md`.
