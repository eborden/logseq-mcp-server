#!/usr/bin/env bash
# A stand-in for the `claude` CLI, so the orchestrator tests never call the real model (#627). The tests select
# it with CLAUDE_BIN. It is told what to do through the environment, and it prints nothing the real one would
# not: one JSON document on stdout.
#
#   FAKE_CLAUDE_MODE      success (default) | session-error | nonzero | malformed | slow | hang | stubborn |
#                         orphan-hang | orphan-exit
#   FAKE_CLAUDE_LOG       a file that gets one line per invocation, so a test can count sessions
#   FAKE_CLAUDE_ARGS_FILE a file that gets the arguments, each followed by a NUL byte
#   FAKE_CLAUDE_PID_FILE  a file that gets "<its pid> <its child's pid>" in the modes that wait or leave a child
#   FAKE_CLAUDE_SLOW_SECONDS  how long `slow` takes (default 1)
set -euo pipefail

mode="${FAKE_CLAUDE_MODE:-success}"

if [ -n "${FAKE_CLAUDE_LOG:-}" ]; then
  echo invoked >>"$FAKE_CLAUDE_LOG"
fi
if [ -n "${FAKE_CLAUDE_ARGS_FILE:-}" ]; then
  printf '%s\0' "$@" >"$FAKE_CLAUDE_ARGS_FILE"
fi

# Like a real session that finished some work: one commit in the current directory (the worktree).
commit_work() {
  echo "work" >session.txt
  git add session.txt
  git -c user.name=Fake -c user.email=fake@example.invalid commit -q -m "fake session"
}

wait_forever() {
  sleep 300 &
  if [ -n "${FAKE_CLAUDE_PID_FILE:-}" ]; then
    echo "$$ $!" >"$FAKE_CLAUDE_PID_FILE"
  fi
  wait
}

# A descendant that ignores SIGTERM and holds none of this process's pipes, so only SIGKILL to the group ends it
# and the parent's exit does not wait for it.
leave_orphan() {
  (
    trap '' TERM
    exec sleep 300
  ) </dev/null >/dev/null 2>&1 &
  if [ -n "${FAKE_CLAUDE_PID_FILE:-}" ]; then
    echo "$$ $!" >"$FAKE_CLAUDE_PID_FILE"
  fi
}

case "$mode" in
  success)
    commit_work
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"fake"}'
    ;;
  slow)
    sleep "${FAKE_CLAUDE_SLOW_SECONDS:-1}"
    commit_work
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"fake"}'
    ;;
  session-error)
    echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"stopped","session_id":"fake"}'
    ;;
  nonzero)
    exit 3
    ;;
  malformed)
    commit_work
    echo 'this is not json'
    ;;
  hang)
    wait_forever
    ;;
  stubborn)
    # Ignores SIGTERM (and so does what it spawns), so only SIGKILL stops it.
    trap '' TERM
    wait_forever
    ;;
  orphan-hang)
    # Hangs until stopped; SIGTERM ends this process but not the orphan.
    leave_orphan
    wait
    ;;
  orphan-exit)
    leave_orphan
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"fake"}'
    ;;
  *)
    echo "unknown FAKE_CLAUDE_MODE" >&2
    exit 64
    ;;
esac
