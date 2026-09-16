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

### Step 6: Settle Identity, Then Settle Mechanics

Two kinds of determination, in this order. Running them together is the mistake: identity says who a name refers to, mechanics says whether that answer can be expressed in brackets, and a term can pass one and fail the other. Only a term that clears both gets linked without asking.

**Identity.** For every partial name you are inclined to link, find independent evidence it refers to that page, per the corroboration section of the reference. Fetch the team or roster pages covering the people named in the block; one page often settles several names at once.

Corroboration exists to shrink the next step, not to replace it. What it settles, carry forward. What it cannot settle goes to step 7 rather than being linked on a hunch or dropped on a shrug.

**Mechanics.** Then, for every term whose prose differs from its candidate title by more than case, including the ones identity just settled, run two checks from the reference:

1. **Direction**, per the mismatch direction section. Which string contains which? If the prose sits inside the title, no bracketing exists at all: `Wren` cannot be linked to `Wren Calloway` without either an `alias:: Wren` on that page or extra words in the note.
2. **The leftover**, per the leftover-decides section, whenever the title does sit inside the prose. Look at what falls outside the brackets. An inflection is fine, so `[[Beacon]]'s` links. The rest of a proper noun is not, so `[[Kofi]] Mensah` fragments a person's name into a ref plus an orphan word and belongs in step 7 asking for an `alias:: Kofi Mensah` instead.

Do both as a mechanical pass over the candidate list rather than trusting yourself to notice. Neither is caught by anything downstream: the gate passes a fragmented name without complaint, and certainty about identity is exactly what makes bracketing a first name feel settled. The pass that nearly wrote a surname into somebody's journal, and the pass that split ten names in one sitting, both had the identity right.

### Step 7: Ask, Then Propose the Diff

Put everything corroboration left open into **one batched question**, one row per term, each row offering the real candidate pages plus a "leave unlinked" choice. Read the asking-well section of the reference before writing the question; the short version is batch it, offer real options, and state the prose cost when honouring a link would change the wording.

The mechanics checks change what a row should offer, which is why they run first. Neither blocker can be offered as a plain link:

- **Prose inside the title** (`Wren` against `Wren Calloway`). Options are an `alias:: Wren` on the target page, expanding the prose, or leaving it unlinked. Offering "link it" here is offering something that does not exist, and whoever answers yes has not agreed to either of the things that would actually have to happen.
- **Proper-noun leftover** (`Kofi Mensah` against `Kofi`). Options are an `alias:: Kofi Mensah` on the target page, leaving it unlinked, or fragmenting the name. Offer the first two. If you name the third at all, say plainly that it links a first name and leaves the surname outside, because "link it" reads as a clean link to anyone who has not been staring at the brackets.

Both options that actually work write to a page outside the note, so say which page gains the property. That is a broader edit than a linking pass was asked for and it changes how every other note in the graph resolves that string, which is the user's call and not yours.

Asking is the designed path here, not a fallback. The person who wrote the note knows who they meant, and a two-second answer beats both a confident guess and a silent skip.

Then show the proposed edits as a diff and wait for confirmation before writing. Anyone can eyeball twenty bracket insertions in a diff; nobody can audit them after the fact inside a knowledge graph. Skip the confirmation only when the requester has said to.

### Step 8: Apply, Then Run the Gate

Make the edits, then:

```bash
scripts/check-link-safety.sh /tmp/link-baseline-<name> <file> <graph> /tmp/link-pages.txt
```

All three checks must pass. The prose-preservation check is the important one: it proves the pass added brackets and altered nothing else, capitalisation included. A failure here means the edit reworded something, which is a defect regardless of how much better the new wording reads.

The most common way to trip it is inserting a word so a ref reads naturally. Wanting to link a page called `Ledger Service` from prose that says `the ledger`, and writing `the [[Ledger Service]]`, adds two words the note never said. Bracket what is there or skip it.

The gate cannot see identity errors or fragmented names. A confidently wrong `[[Devon]]` and a `[[Kofi]] Mensah` both pass every check, because the prose is intact and the refs resolve. Step 6 is what protects against those, not this. A green gate means the edit was safe, never that it was right.

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
[[Priya Raghavan]] walked Kofi Mensah through the migration plan; [[Devon]] took the rollback owner slot.
Tobias raised concerns about the retry budget during the review.
[[Beacon]]'s rollout slipped a week; [[NorthWind]] is unaffected.
Wren owns the failover runbook.
```

`Priya Raghavan` resolved through an `alias:: Priya Raghavan` on the `Priya` page, so the whole name is bracketed as one ref. That is the pattern to aim for with any full name, and it is worth noticing that the graph had to be set up for it. `Devon` matched a page title exactly. `Beacon` took a possessive outside the brackets, which is the model case for substring bracketing because `'s` is inflection rather than part of the noun. `NorthWind` differs from its page title only in case, so it links while keeping the spelling the note used.

`Tobias` and `Marisol` both went into the batched question, and both stayed plain here: `Marisol` because two pages carry that first name, `Tobias` because the single page carrying it had nothing corroborating this mention. Note that `Tobias` is the interesting one. A pass that linked it without asking would look identical to a correct pass, right up until the wrong person read the note.

`Kofi` and `Wren` also stayed plain, and neither of them for `Tobias`'s reason. Both had identity settled outright; both failed on mechanics instead.

`Kofi Mensah` stays plain even though `[[Kofi]] Mensah` was available and would have passed the gate. `Atlas Squad` carries Kofi as `manager::` alongside two other people the block names, so identity was never in doubt. The leftover is what stops it: `Mensah` is the rest of the name, not an inflection, and bracketing around it would have recorded an edge to a first name while leaving the surname stranded in plain text. The remedy is an `alias:: Kofi Mensah` on the `Kofi` page, which would make `[[Kofi Mensah]]` resolve whole. Nobody granted it here, so the name is left alone.

`Wren` stays plain for the opposite mechanical reason. `Atlas Squad` lists `Wren Calloway` in its roster, so identity is again settled outright, but the prose sits inside the title rather than the other way round and there is no bracketing to attempt at all. The remedy is an `alias:: Wren` on `Wren Calloway`, also not granted here.

Read `Kofi` and `Wren` together. One is bracketable and wrong to bracket; the other is not bracketable at all. Both are fully corroborated, both want an alias plus the owner's consent, and neither has anything to do with how confident you are about who is meant.
