#!/usr/bin/env bash
# Validate a LogSeq summary against the terseness budget.
# Usage: check-terseness.sh "<graph>/pages/Weekly YYYY-MM-DD.md"
#        check-terseness.sh "<graph>/pages/Monthly YYYY-MM.md"
#        check-terseness.sh --monthly <path>     # force granularity
#
# Budget (see references/summary-compression.md):
#                       weekly            monthly
#   words per signal    10-15, 20 max     12-18, 22 max
#   total signal words  150               200
#   signal items        12 target, 14 max 10 target, 12 max
#   em-dashes           0                 0
# Two-sentence bullets are flagged for review, not auto-failed.
#
# Source line (read-only, no graph access): the page must carry a `source::` property that records the
# roll-up of the period query it was built from, as
#   source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Name 12/4, Name 9/2
# (days and blocks from summary.totalDays and summary.totalBlocks, top from the first five of
# summary.topConcepts as "name count/days", or "top none" when the field is absent). A page with no such
# line was not built from the query, and fails. `source:: files; <error>` is the fallback after a tool call
# failed; it fails too unless --allow-files is given.
#
# Usage: check-terseness.sh [--weekly|--monthly] [--allow-files] <path to summary .md>

set -uo pipefail

GRAN=""
ALLOW_FILES=0
FILE=""
while (( $# )); do
  case "$1" in
    --weekly)      GRAN=weekly ;;
    --monthly)     GRAN=monthly ;;
    --allow-files) ALLOW_FILES=1 ;;
    *)             FILE="$1" ;;
  esac
  shift
done

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "usage: $(basename "$0") [--weekly|--monthly] [--allow-files] <path to summary .md>" >&2
  exit 2
fi

# Detect granularity from the filename when not forced.
if [[ -z "$GRAN" ]]; then
  base=$(basename "$FILE")
  shopt -s nocasematch
  if   [[ "$base" == Monthly* ]]; then GRAN=monthly
  elif [[ "$base" == Weekly*  ]]; then GRAN=weekly
  else
    # fall back to the gist label inside the file
    if grep -qE '^- \*\*Month\*\*:' "$FILE"; then GRAN=monthly; else GRAN=weekly; fi
  fi
  shopt -u nocasematch
fi

if [[ "$GRAN" == monthly ]]; then
  TARGET_WORDS_PER_SIGNAL=18; MAX_WORDS_PER_SIGNAL=22
  MAX_TOTAL_WORDS=200; TARGET_ITEMS=10; HARD_MAX_ITEMS=12
else
  TARGET_WORDS_PER_SIGNAL=15; MAX_WORDS_PER_SIGNAL=20
  MAX_TOTAL_WORDS=150; TARGET_ITEMS=12; HARD_MAX_ITEMS=14
fi

signals=$(awk '/^- ## Signals/{f=1;next} /^- ## /{f=0} f && /^\t+- /' "$FILE")

if [[ -z "$signals" ]]; then
  echo "FAIL: no Signals section found (expected a '- ## Signals' heading with tab-indented bullets)" >&2
  exit 1
fi

fail=0; warn=0; total_words=0; items=0

echo "Signals in $(basename "$FILE")  [$GRAN budget]:"
while IFS= read -r line; do
  items=$((items + 1))
  text=${line#"${line%%[![:space:]]*}"}
  text=${text#- }
  words=$(printf '%s' "$text" | wc -w | tr -d ' ')
  total_words=$((total_words + words))

  flag="  "
  if (( words > MAX_WORDS_PER_SIGNAL )); then
    flag="!!"; fail=1
  elif (( words > TARGET_WORDS_PER_SIGNAL )); then
    flag=" ~"; warn=1
  fi
  printf '%s %3d words  %s\n' "$flag" "$words" "$(printf '%s' "$text" | cut -c1-72)"

  if printf '%s' "$text" | grep -Eq '[.!?] +([A-Z]|\[\[)'; then
    printf '   ^ two sentences: delete the explaining clause unless it carries the stake\n'
    warn=1
  fi
done <<< "$signals"

echo
printf 'items: %d / %d\n' "$items" "$TARGET_ITEMS"
printf 'signal words: %d / %d\n' "$total_words" "$MAX_TOTAL_WORDS"

if (( items > HARD_MAX_ITEMS )); then
  echo "FAIL: $items signals, merge related items onto one line"; fail=1
elif (( items > TARGET_ITEMS )); then
  echo "WARN: $items signals, over the target of $TARGET_ITEMS. Fine if every line is tight; merge if not."; warn=1
fi

if (( total_words > MAX_TOTAL_WORDS )); then
  echo "FAIL: over the word budget by $((total_words - MAX_TOTAL_WORDS)), cut the read-through clauses"; fail=1
fi

if grep -q '—' "$FILE"; then
  echo "FAIL: em-dashes present (reads as AI-generated), use commas/semicolons/periods/parentheticals:"
  grep -n '—' "$FILE" | sed 's/^/  /'
  fail=1
fi

gist=$(grep -m1 -E '^- \*\*(Week|Month)\*\*:' "$FILE" || true)
if [[ -n "$gist" ]]; then
  sentences=$(printf '%s' "$gist" | grep -Eo '[.!?]( |$)' | wc -l | tr -d ' ')
  (( sentences > 2 )) && { echo "FAIL: gist is $sentences sentences, max 2"; fail=1; }
fi

for sect in Signals Unresolved Personal; do
  grep -qE "^- ## $sect" "$FILE" || { echo "FAIL: missing mandatory '## $sect' section"; fail=1; }
done

# The page must record the roll-up of the period query it came from.
source_line=$(grep -m1 -E '^source::' "$FILE" || true)
source_re='^source:: query_by_date_range ([0-9]{8})-([0-9]{8}); days ([0-9]+); blocks ([0-9]+); top (.+)$'
top_re='^(none|[^,/]+ [0-9]+/[0-9]+(, [^,/]+ [0-9]+/[0-9]+)*)$'
src_hint="Run logseq_query_by_date_range for the period and record its summary on a source:: line under the tags line (Step 6 of the sub-skill)."
if [[ -z "$source_line" ]]; then
  echo "FAIL: no 'source::' line, so the page was not built from logseq_query_by_date_range. $src_hint"
  fail=1
elif [[ "$source_line" =~ ^source::\ files(\;|$) ]]; then
  if (( ALLOW_FILES )); then
    echo "WARN: source is journal files, not the query (--allow-files). That is valid only after a tool call failed, and the gist must say so."
    warn=1
  else
    echo "FAIL: source is journal files. Files are a fallback after a tool call has actually failed. $src_hint If a call did fail, say so in the gist and re-run with --allow-files."
    fail=1
  fi
elif [[ "$source_line" =~ $source_re ]]; then
  src_start=${BASH_REMATCH[1]}; src_end=${BASH_REMATCH[2]}
  src_days=${BASH_REMATCH[3]}; src_blocks=${BASH_REMATCH[4]}; src_top=${BASH_REMATCH[5]}
  printf 'source: query_by_date_range %s-%s, %s days, %s blocks\n' "$src_start" "$src_end" "$src_days" "$src_blocks"
  (( src_days >= 1 && src_blocks >= 1 )) || { echo "FAIL: the source line records no days or no blocks; there is nothing to summarize"; fail=1; }
  (( 10#$src_end >= 10#$src_start )) || { echo "FAIL: source range ends ($src_end) before it starts ($src_start)"; fail=1; }
  [[ "$src_top" =~ $top_re ]] || { echo "FAIL: source 'top' must be 'none' or 'name count/days' entries separated by ', '"; fail=1; }
  base=$(basename "$FILE" .md)
  if [[ "$base" =~ ^Weekly\ ([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]]; then
    want="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
    [[ "$src_start" == "$want" ]] || { echo "FAIL: source range starts $src_start but the page is for the week of $want"; fail=1; }
    day_links=$(grep -m1 -E '^tags::' "$FILE" | grep -Eo '\[\[[A-Z][a-z]{2} [0-9]{1,2}(st|nd|rd|th), [0-9]{4}\]\]' | wc -l | tr -d ' ')
    if [[ "$day_links" != "$src_days" ]]; then
      echo "WARN: the tags line links $day_links journal days but the source line says $src_days"
      warn=1
    fi
  elif [[ "$base" =~ ^Monthly\ ([0-9]{4})-([0-9]{2})$ ]]; then
    want="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
    [[ "${src_start:0:6}" == "$want" && "${src_end:0:6}" == "$want" ]] || { echo "FAIL: source range $src_start-$src_end is not inside the month $want"; fail=1; }
  fi
else
  echo "FAIL: malformed source line. Expected 'source:: query_by_date_range YYYYMMDD-YYYYMMDD; days N; blocks N; top none' or 'top Name 12/4, Name 9/2'. $src_hint"
  fail=1
fi

echo
if (( fail )); then
  echo "BUDGET VIOLATION. Rewrite the flagged bullets and re-run. Do not hand this over."
  exit 1
fi
if (( warn )); then
  echo "PASS with warnings. Bullets marked ~ or flagged as two sentences are the usual chattiness."
  exit 0
fi
echo "PASS. Within budget."
