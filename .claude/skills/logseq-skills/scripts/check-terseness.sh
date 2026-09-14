#!/usr/bin/env bash
# Validate a LogSeq summary against the terseness budget.
# Usage: check-terseness.sh "$HOME/Documents/Logs/pages/Weekly YYYY-MM-DD.md"
#        check-terseness.sh "$HOME/Documents/Logs/pages/Monthly YYYY-MM.md"
#        check-terseness.sh --monthly <path>     # force granularity
#
# Budget (see references/summary-compression.md):
#                       weekly            monthly
#   words per signal    10-15, 20 max     12-18, 22 max
#   total signal words  150               200
#   signal items        12 target, 14 max 10 target, 12 max
#   em-dashes           0                 0
# Two-sentence bullets are flagged for review, not auto-failed.

set -uo pipefail

GRAN=""
case "${1:-}" in
  --weekly)  GRAN=weekly;  shift ;;
  --monthly) GRAN=monthly; shift ;;
esac

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "usage: $(basename "$0") [--weekly|--monthly] <path to summary .md>" >&2
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
