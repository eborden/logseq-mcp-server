# Removed: Datalog debugging summary (2025-11-21)

This historic summary was deleted in #77. Git history keeps it. This stub stays because accepted ADRs cite the path and can't be edited.

Read the last version with:

```bash
git show df7503a:docs/datalog-debugging-summary.md
```

What it recorded now lives in:

- [ADR-0002 (datalog-over-editor-api)](adr/0002-datalog-over-editor-api.md): the switch from `logseq.DB.q` to `logseq.DB.datascriptQuery`
- [ADR-0005 (datalog-only-no-feature-flags)](adr/0005-datalog-only-no-feature-flags.md): the failing equivalence tests and the removal of the feature flags
- [ADR-0006 (embed-strings-in-datalog-queries)](adr/0006-embed-strings-in-datalog-queries.md), superseded by [ADR-0013 (strings-bound-via-in-inputs)](adr/0013-strings-bound-via-in-inputs.md): the belief that `:in` didn't work, and the fix
- `CLAUDE.md`, "Critical LogSeq Datalog Constraints": the verified constraints
