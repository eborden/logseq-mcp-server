#!/usr/bin/env bash
# Validation gate for concept-linking. Proves a linking pass added [[refs]]
# without rewording the note and without inventing pages.
#
# Usage: check-link-safety.sh <before> <after> [graph-root]
#
# Checks:
#   1. Prose preservation: stripping [[ ]] from <after> must equal <before> byte for byte
#   2. Bracket balance: no unbalanced or nested [[ ]]
#   3. Resolvability: every bracketed term must match an existing page or alias
#
# Usage: check-link-safety.sh <before> <after> [graph-root] [page-list]
#
# IMPORTANT about <page-list>: a LogSeq graph's page files are NOT the list of its
# pages. A page that is referenced but never given content exists in the database
# with no file on disk, so scanning pages/ badly undercounts (one real graph: 621
# pages, 149 files). Pass a page list, one title per line, captured from
# logseq_list_pages. Without it check 3 degrades to a warning, because the
# filesystem alone cannot distinguish "page does not exist" from "page has no body".
#
# Exits non-zero on any violation. Fix the edit and re-run; do not explain a failure away.

set -uo pipefail

BEFORE="${1:-}"
AFTER="${2:-}"
GRAPH="${3:-}"
PAGELIST="${4:-}"

if [[ -z "$BEFORE" || -z "$AFTER" ]]; then
  echo "usage: check-link-safety.sh <before> <after> [graph-root] [page-list]" >&2
  exit 2
fi

for f in "$BEFORE" "$AFTER"; do
  [[ -f "$f" ]] || { echo "FAIL: no such file: $f" >&2; exit 2; }
done

FAILED=0
note() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILED=1; }

# ---------------------------------------------------------------- check 1
# The invariant that matters: with all brackets removed, both files must be
# identical. Stripping BOTH sides is what makes this work on a note that
# already contained refs before the pass ran.
STRIPPED_BEFORE="$(mktemp)"
STRIPPED_AFTER="$(mktemp)"
trap 'rm -f "$STRIPPED_BEFORE" "$STRIPPED_AFTER" "${KNOWN:-}"' EXIT
perl -pe 's/\[\[([^\[\]]+)\]\]/$1/g' "$BEFORE" > "$STRIPPED_BEFORE"
perl -pe 's/\[\[([^\[\]]+)\]\]/$1/g' "$AFTER"  > "$STRIPPED_AFTER"

if diff -q "$STRIPPED_BEFORE" "$STRIPPED_AFTER" >/dev/null 2>&1; then
  note "PASS  prose preserved (brackets strip back to identical text)"
else
  fail "prose changed. Linking may only add brackets, never reword, reorder or drop text."
  diff -u "$STRIPPED_BEFORE" "$STRIPPED_AFTER" | sed -n '1,40p' >&2
fi

# ---------------------------------------------------------------- check 2
OPENS=$(grep -o '\[\[' "$AFTER" | wc -l | tr -d ' ')
CLOSES=$(grep -o '\]\]' "$AFTER" | wc -l | tr -d ' ')
if [[ "$OPENS" == "$CLOSES" ]]; then
  note "PASS  brackets balanced ($OPENS pairs)"
else
  fail "unbalanced brackets: $OPENS '[[' vs $CLOSES ']]'"
fi
if grep -q '\[\[[^][]*\[\[' "$AFTER"; then
  fail "nested '[[' detected; a page ref cannot contain another"
fi

# ---------------------------------------------------------------- check 3
# Infer the graph root if not supplied: walk up from <after> for a directory
# holding both pages/ and journals/.
if [[ -z "$GRAPH" ]]; then
  probe="$(cd "$(dirname "$AFTER")" && pwd)"
  while [[ "$probe" != "/" ]]; do
    if [[ -d "$probe/pages" && -d "$probe/journals" ]]; then GRAPH="$probe"; break; fi
    probe="$(dirname "$probe")"
  done
fi

LINKS="$(perl -nE 'while (/\[\[([^\[\]]+)\]\]/g) { say $1 }' "$AFTER" | sort -u)"

KNOWN="$(mktemp)"

# Authoritative source: a page list captured from logseq_list_pages.
if [[ -n "$PAGELIST" && -f "$PAGELIST" ]]; then
  tr '[:upper:]' '[:lower:]' < "$PAGELIST" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' >> "$KNOWN"
fi

# Supplementary: page files and their alias:: properties. Files are a subset of
# pages, never the whole set, so this can only add names and never authorise a FAIL.
if [[ -n "$GRAPH" && -d "$GRAPH/pages" ]]; then
  while IFS= read -r -d '' page; do
    basename "$page" .md | tr '[:upper:]' '[:lower:]' >> "$KNOWN"
    perl -nE 'if (/^alias::\s*(.+)$/) { for my $a (split /,/, $1) { $a =~ s/^\s+|\s+$//g; $a =~ s/^\[\[|\]\]$//g; say lc $a if length $a } }' "$page" >> "$KNOWN"
  done < <(find "$GRAPH/pages" -maxdepth 1 -name '*.md' -print0)
fi

if [[ ! -s "$KNOWN" ]]; then
  note "SKIP  resolvability (no page list and no graph root; pass either to enable)"
else
  unresolved=()
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    if ! grep -Fqx "$(printf '%s' "$link" | tr '[:upper:]' '[:lower:]')" "$KNOWN"; then
      unresolved+=("$link")
    fi
  done <<< "$LINKS"

  if [[ ${#unresolved[@]} -eq 0 ]]; then
    note "PASS  all refs resolve to a known page or alias"
  elif [[ -n "$PAGELIST" && -f "$PAGELIST" ]]; then
    for link in "${unresolved[@]}"; do
      fail "unresolved ref [[$link]] is in no page list entry or alias. Linking never creates pages."
    done
  else
    note "WARN  ${#unresolved[@]} ref(s) matched no page FILE. Page files are a subset of pages,"
    note "      so this is inconclusive. Re-run with a page list to check properly:"
    for link in "${unresolved[@]}"; do note "        [[$link]]"; done
  fi
fi

# ---------------------------------------------------------------- report
ADDED_BEFORE=$(grep -o '\[\[' "$BEFORE" | wc -l | tr -d ' ')
note ""
note "refs before: $ADDED_BEFORE    refs after: $OPENS    added: $(( OPENS - ADDED_BEFORE ))"
if [[ -n "$LINKS" ]]; then
  note "linked terms:"
  printf '%s\n' "$LINKS" | sed 's/^/  - /'
fi

exit "$FAILED"
