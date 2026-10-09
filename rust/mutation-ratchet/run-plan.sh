#!/usr/bin/env bash
# Run the `cargo mutants` calls a plan asks for and record how each one ended (ADR-0033, #364).
#
#   run-plan.sh PLAN_DIR RESULTS_DIR      both absolute
#
# PLAN_DIR is what `mutation-ratchet plan` or `full-plan` wrote: `in-diff-files.txt` and `in-diff.diff` for the files measured by
# their changed lines, `whole-files.txt` for the files measured whole. Each call writes `RESULTS_DIR/<in-diff|whole>/` with the
# tool's own `mutants.out/`, the exit code it returned (`exit`) and its wall time in seconds (`wall`). A call's exit code is
# recorded and never fails this script: 0, 2 and 3 are results, and the others are read by `mutation-ratchet report`, which fails
# the job for them. Needs MUTANT_JOBS (limits.env), and `cargo mutants` on the PATH.
set -euo pipefail

plan_dir="${1:?usage: run-plan.sh PLAN_DIR RESULTS_DIR}"
results="${2:?usage: run-plan.sh PLAN_DIR RESULTS_DIR}"
: "${MUTANT_JOBS:?MUTANT_JOBS must be set (rust/mutation-ratchet/limits.env)}"

crate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A line of what the machine has left, every two minutes, in the job log. A hosted runner that runs out of memory or disk is
# lost without a trace ("lost communication with the server"), which is what ended two slices of the first full run of #364 PR 1
# after 70 and 130 minutes, and the log of a lost runner is gone. This leaves the trend in the log of a run that is cancelled
# instead, and says whether the disk or the memory was climbing.
monitor() {
  while true; do
    sleep 120
    echo "machine: $(date -u +%H:%M:%S) disk free $(df -m / | awk 'NR==2 {print $4}') MB, scratch $(du -sm "${TMPDIR:-/tmp}" 2> /dev/null | cut -f1) MB, memory available $(free -m | awk 'NR==2 {print $7}') MB, load $(cut -d' ' -f1 /proc/loadavg)"
  done
}
monitor &
monitor_pid=$!
trap 'kill "${monitor_pid}" 2> /dev/null || true' EXIT

run() {
  local name="$1"
  shift
  local dir="${results}/${name}"
  mkdir -p "${dir}"
  local start code=0
  start="$(date +%s)"
  # Incremental builds on: the build job turns them off (setup-rust-toolchain), but every mutant is a small edit of one file, and
  # the calibration of #364 PR 1 measured about half the seconds per mutant with them (12 s against 23 s). --caught and
  # --unviable print every mutant as it finishes, not only the missed ones, so the log says where a run stopped.
  # Niced, so the runner's own agent keeps its CPU: builds and tests use all 4 cores for hours, and three slices of the first
  # full runs of #364 PR 1 ended with "The runner has received a shutdown signal" or "lost communication" while the disk
  # (100 GB free) and the memory (13 GB free) were fine, which is what a starved agent looks like.
  (cd "${crate_dir}" && CARGO_INCREMENTAL=1 nice -n 15 cargo mutants --jobs "${MUTANT_JOBS}" --no-shuffle --colors never --caught \
    --unviable --output "${dir}" "$@") || code=$?
  echo "${code}" > "${dir}/exit"
  echo "$(($(date +%s) - start))" > "${dir}/wall"
  echo "cargo mutants (${name}) exited ${code} after $(cat "${dir}/wall") s"
}

if [ -s "${plan_dir}/in-diff-files.txt" ]; then
  run in-diff --in-diff "${plan_dir}/in-diff.diff"
fi

if [ -s "${plan_dir}/whole-files.txt" ]; then
  mapfile -t files < "${plan_dir}/whole-files.txt"
  file_args=()
  for file in "${files[@]}"; do
    file_args+=(--file "${file}")
  done
  run whole "${file_args[@]}"
fi
