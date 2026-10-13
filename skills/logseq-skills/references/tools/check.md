# Check tools

You are about to write to the graph. A `check` tool gives a verdict on the change you propose and is still read-only: it compares two texts and looks the refs up in the graph. It never edits anything. There is one, the gate for any pass that adds `[[links]]` to existing notes.

| Tool | Takes | Returns |
|------|-------|---------|
| `logseq_check_links` | `before`, `after` | `ok` and the four checks behind it |

## logseq_check_links

Check a `[[link]]` pass. `ok` is true only if `after` strips back to `before`, brackets balance and don't nest, every ref in `before` is kept, and each `[[term]]` names exactly one page or alias.

| Parameter | Type | What it does |
|-----------|------|--------------|
| `before` | string, required | The text before linking, at most 50,000 characters |
| `after` | string, required | The same text with `[[brackets]]` added, at most 50,000 characters and 500 distinct terms |

**Returns:**

| Key | Meaning |
|-----|---------|
| `ok` | True only when all four checks pass |
| `prose` | `{ ok, firstDifference? }`. Stripping `[[ ]]` from both texts leaves them identical, so the pass added brackets and changed nothing else, capitalisation included. `firstDifference` gives the line, column and an excerpt of each side |
| `brackets` | `{ ok, opens, closes, nested? }`. Balanced, and no `[[` opened inside another |
| `refs` | `{ ok, resolved, unresolved, ambiguous }`. Every `[[term]]` in `after` names exactly one page or alias, file-less pages included. An alias several pages declare is `ambiguous`. One the note already had, with no copy added, is reported but doesn't fail |
| `refsPreserved` | `{ ok, removed }`. Every ref in `before` is still a ref in `after`, as many times |
| `hasMore`, `warnings`, `totals` | `totals` holds `refsBefore`, `refsAfter` and `terms`. A `refs_unchecked` warning means LogSeq gave no answer, so no ref was checked: call again once, and if it comes back, say the refs couldn't be checked and don't report the pass as done |

**Cost:** 0 or 1 LogSeq call (none when `after` has no `[[term]]`), however many terms. About 100 to 500 tokens. Only `refs.resolved` is ever cut for size, last terms first; the failures never are (`results-and-limits.md`).

**Use when:** a linking pass has been applied and is about to be reported done (`skills/concept-linking.md`, step 8). For a long page, gate only the edited blocks, with `before` and `after` cut at the same block boundaries.

**Can't find:** a link to the wrong page, or a name split across a ref (`[[Kofi]] Mensah`). Both pass every check. A pass that links nothing passes too. A green gate means the edit was safe, never that it was right: `references/link-resolution.md` says what protects against identity errors and fragmented names.

**Never remove a ref the note already had** to make it pass. `refsPreserved` fails if you do. An unresolved term the note already linked is a lookup problem: confirm the page with `logseq_find_pages` and `text`, leave the ref and report it.

**Example 1.** A linking pass added two brackets. Check before reporting done.

```json tool=logseq_check_links
{"before": "- met Alice about project atlas", "after": "- met [[Alice]] about [[project atlas]]"}
```

Read `ok`. If true, report the pass done (and that the gate proves safety, not correctness). If false, read the failing key: `prose` means you reworded something (undo it), `refs.unresolved` names a term that would create a new page (remove your bracket on it), `refs.ambiguous` names an alias several pages share (ask which page was meant). Fix what you added and call again.

**Example 2.** The pass tried to link a name the note wrote in full to a page called `Kofi`.

```json tool=logseq_check_links
{"before": "Kofi Mensah walked us through the rollout.", "after": "[[Kofi]] Mensah walked us through the rollout."}
```

Read the result: `ok` is true, and that is the trap. The prose is intact, the brackets balance and the page resolves, but the note now names a person half in a ref and half in plain text. The gate cannot see that. Undo the bracket and ask for a full-name `alias::` on the page, as `references/link-resolution.md` explains.

**Example 3.** The edit fixed a typo along with the links, so the text is no longer the same.

```json tool=logseq_check_links
{"before": "- Ledger Service owns the audit trail", "after": "- [[Ledger Service]] owns the audit trial"}
```

Read `prose.firstDifference`: it gives the line, column and an excerpt of each side. Revert the typo fix, keep the brackets and call again. Fix typos in a separate edit that is not a linking pass.
