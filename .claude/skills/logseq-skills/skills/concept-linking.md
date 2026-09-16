# LogSeq Concept Linking

Add `[[refs]]` to existing notes for concepts that already have pages, without changing what the notes say and without guessing who a name refers to.

**Read `references/link-resolution.md` first.** It holds the resolution semantics, the decision table, what counts as corroboration, and the anti-patterns. This file covers only the workflow.

## Parameters

| | Value |
|---|---|
| Target | A block ref `((uuid))`, a page name, or a date range |
| Source of truth | Page titles and `alias::` properties already in the graph |
| Output | The same file, with brackets added and nothing else changed |
| Default mode | Propose a diff, apply after confirmation |
| New pages | Never created. Recurring unlinked terms are reported instead |
| Gate | `scripts/check-link-safety.sh` (mandatory) |

## Workflow

### Step 1: Resolve the Target

For a block ref, fetch it with children:

```
mcp__logseq__logseq_get_block(block_uuid="<uuid>", include_children=true)
```

For a page, use `logseq_get_page`. For a date range, `logseq_query_by_date_range` with `slim_results=true`.

Note the scope you were given. A block ref means that block and its descendants, not the whole journal day. Linking outside the requested scope is unwanted work and it puts edits somewhere the requester is not looking.

### Step 2: Discover the Graph's Vocabulary

```
mcp__logseq__logseq_list_pages()
```

One call gives every page title, which is the candidate set. Do not guess at page names, and do not assume a concept has a page because it plainly deserves one. This listing is also what tells you a term has zero candidates, which is a skip and not a question.

**Do not substitute a directory listing for this call.** A referenced page with no content has no file, so `pages/` is a strict subset of the graph's pages and often a small one. Save the listing for the gate in step 8:

```bash
cat > /tmp/link-pages.txt <<'EOF'
<one page title per line, from the list_pages result>
EOF
```

### Step 3: Locate the File and Detect Its Shape

Find the graph root, then the file:

```
mcp__logseq__logseq_get_graph_info()
```

Journals live at `<graph>/journals/YYYY_MM_DD.md` and pages at `<graph>/pages/<Title>.md`. Never hardcode a path; different graphs sit in different places.

To find the block a `((uuid))` refers to, grep for its `id::` line:

```bash
grep -rn "id:: <uuid>" <graph>/journals <graph>/pages
```

The block owning that id is the bullet on the line **above** the `id::` line.

Then detect the indentation before editing, because it varies by graph and by editor:

```bash
grep -c $'^\t' <file>    # tab-indented if non-zero
```

Match whatever the file already uses. Mixing tabs and spaces breaks the outline.

### Step 4: Check Whether Writes Are Available

The LogSeq MCP server is commonly read-only, exposing query tools with no write counterpart. Check the tools actually available to you this session. If a write tool exists, prefer it. If not, edit the file on disk with the normal file-editing tools, which is a supported path because LogSeq reads these markdown files as its source of truth.

Either way, **keep a copy of the pre-edit file** so the gate in step 8 has a baseline:

```bash
cp <file> /tmp/link-baseline-$(basename <file>)
```

### Step 5: Classify Every Candidate

Walk the target's text against the page listing and sort each candidate term into link, ask, or skip using the decision table in the reference. Build the classification before making any edit, because the ask branch has to be resolved first and because a term appearing several times should be decided once.

### Step 6: Corroborate Identity, Then Check Direction

Two separate determinations, in this order. Running them together is the mistake: the first says who a name refers to, the second says whether that can be expressed in brackets, and a term can pass one and fail the other.

**Identity.** For every partial name you are inclined to link, find independent evidence it refers to that page, per the corroboration section of the reference. Fetch the team or roster pages covering the people named in the block; one page often settles several names at once.

Corroboration exists to shrink the next step, not to replace it. What it settles, carry forward. What it cannot settle goes to step 7 rather than being linked on a hunch or dropped on a shrug.

**Direction.** Then, for every term whose prose differs from its candidate title by more than case, including the ones identity just settled, check which string contains which, per the mismatch direction section of the reference. If the title sits inside the prose, substring bracketing handles it. If the prose sits inside the title, no bracketing exists: `Wren` cannot be linked to `Wren Calloway` without either an `alias:: Wren` on that page or extra words in the note.

Do this as a mechanical pass over the candidate list rather than trusting yourself to notice. Certainty about identity is exactly what makes it tempting to type the full title, and the pass that nearly wrote a surname into somebody's journal was a pass that had the identity right.

### Step 7: Ask, Then Propose the Diff

Put everything corroboration left open into **one batched question**, one row per term, each row offering the real candidate pages plus a "leave unlinked" choice. Read the asking-well section of the reference before writing the question; the short version is batch it, offer real options, and state the prose cost when honouring a link would change the wording.

The direction check changes what a row should offer, which is why it runs first. A term whose prose sits inside its title cannot be offered as a plain link at all; its options are an `alias::` on the target page (naming the page that gains it, since that edit reaches outside this note), expanding the prose, or leaving it unlinked. Offering "link it" there is offering something that does not exist, and whoever answers yes has not agreed to either of the things that would actually have to happen.

Asking is the designed path here, not a fallback. The person who wrote the note knows who they meant, and a two-second answer beats both a confident guess and a silent skip.

Then show the proposed edits as a diff and wait for confirmation before writing. Anyone can eyeball twenty bracket insertions in a diff; nobody can audit them after the fact inside a knowledge graph. Skip the confirmation only when the requester has said to.

### Step 8: Apply, Then Run the Gate

Make the edits, then:

```bash
scripts/check-link-safety.sh /tmp/link-baseline-<name> <file> <graph> /tmp/link-pages.txt
```

All three checks must pass. The prose-preservation check is the important one: it proves the pass added brackets and altered nothing else, capitalisation included. A failure here means the edit reworded something, which is a defect regardless of how much better the new wording reads.

The most common way to trip it is inserting a word so a ref reads naturally. Wanting to link a page called `Ledger Service` from prose that says `the ledger`, and writing `the [[Ledger Service]]`, adds two words the note never said. Bracket what is there or skip it.

The gate cannot see identity errors. A confidently wrong `[[Devon]]` passes every check, so step 6 is what protects against that, not this.

### Step 9: Report

State what was linked, then what was skipped and why. The skip list is the substance of the report, because a skip is where a judgement was made:

- Names skipped for want of corroboration, since the requester knows who they meant
- Concepts whose prose differs from an existing page title, which may deserve an `alias::` on that page
- Terms that recur unlinked across the target and have no page at all, which the graph's owner may want to create

Recommend, never create. A page is cheap to add and awkward to remove once other notes reference it.

## Worked Example

A fixture graph exercising every branch lives at `tests/fixtures/graph-linking/`, with the input in `journals/`, the correct result in `expected/`, and deliberate defects in `negative/`. Its `README.md` maps each line of the fixture to the rule it tests.

The short version, from that fixture:

```
Priya Raghavan walked Kofi Mensah through the migration plan; Devon took the rollback owner slot.
Tobias raised concerns about the retry budget during the review.
Beacon's rollout slipped a week; NorthWind is unaffected.
Wren owns the failover runbook.
```

becomes

```
[[Priya Raghavan]] walked [[Kofi]] Mensah through the migration plan; [[Devon]] took the rollback owner slot.
Tobias raised concerns about the retry budget during the review.
[[Beacon]]'s rollout slipped a week; [[NorthWind]] is unaffected.
Wren owns the failover runbook.
```

`Priya Raghavan` resolved through an alias, so the whole string is bracketed. `Kofi` is a first name corroborated by a roster page and gets substring bracketing. `Devon` matched a page title exactly. `Beacon` took a possessive outside the brackets. `NorthWind` differs from its page title only in case, so it links while keeping the spelling the note used.

`Tobias` and `Marisol` both went into the batched question, and both stayed plain here: `Marisol` because two pages carry that first name, `Tobias` because the single page carrying it had nothing corroborating this mention. Note that `Tobias` is the interesting one. A pass that linked it without asking would look identical to a correct pass, right up until the wrong person read the note.

`Wren` is the direction case, and it fails for a different reason than `Tobias`. `Atlas Squad` lists `Wren Calloway` in its roster alongside two other people the block names, so identity is settled outright; there is no doubt who is meant. The prose still sits inside the title, so no bracketing links it. It stays plain because the question came back without consent for an `alias:: Wren` on that page, and the alternative would have been typing a surname the note never carried.
