# Orchestrator

A Temporal-based orchestrator for the issue-to-PR loop (parent plan #625). It lives beside the Rust server and has its own `package.json`, lockfile and `tsconfig.json`, so Temporal's dependencies stay out of the root tooling. Nothing here is part of the MCP server.

This first slice (#626) proves the engine runs here and survives a crash. It holds one workflow, `helloWorkflow`, with two activities (`greet` and `farewell`), a worker and a client.

## What v1 does not do

- No `gh` or board code yet (later tasks in #625). The `runClaudeSession` activity (#627) exists but is not registered on the worker or called by a workflow yet (#629 wires it).
- No Postgres, Docker, extra task queues or scheduler. One task queue, `orchestrator`.
- It never merges, never applies `golden-change` and never moves a board item from Backlog to Ready.

## Setup

Needs Node 22.12 or newer.

```bash
cd orchestrator
npm ci
npm run typecheck
```

## Run it

Three terminals, all inside `orchestrator/`.

```bash
npm run start-server    # terminal 1: Temporal dev server on 127.0.0.1:7233, history in .temporal/dev.sqlite
npm run worker          # terminal 2: polls the "orchestrator" task queue
npm run run-hello       # terminal 3: starts one run and waits for it
```

`start-server` runs in the foreground and stays up until you press Ctrl-C (or send SIGTERM), which stops it cleanly. Leave that terminal open: the worker and the client both need the server running, and fail with a connection error if nothing listens on `127.0.0.1:7233`.

`run-hello` takes options after `--`, for example `npm run run-hello -- --name Alice --work-ms 15000`. The second activity writes its line and then wraps up for `--work-ms` (default 10 seconds), which leaves time to crash the worker after the write. Each activity appends one line to a temp file (`--log-file`, default `orchestrator-hello.log` in your temp directory), and `run-hello` prints the lines for its run.

### Try a crash by hand

1. Start the server and the worker, then `npm run run-hello`.
2. While it waits, kill the worker with `kill -9 <pid>`. Ctrl-C is a graceful shutdown, so use SIGKILL to simulate a crash.
3. Start the worker again. The same run finishes, after the dead worker's activity times out (3 seconds without a heartbeat) and is retried.
4. The log holds one `greet` line and one `farewell` line for the run, not two of either. The retried `farewell` finds its line already there and writes nothing.

Running `run-hello` again with the same `--run-key` attaches to the open run, or prints the result of a completed one without running it again. A failed run may start again under the same key.

### The server

`start-server` runs `temporal server start-dev` through the SDK's launcher (`@temporalio/testing`), with a SQLite file so history survives a restart. It uses an installed `temporal` CLI when `TEMPORAL_CLI_PATH` points at one. Otherwise the SDK downloads and caches the CLI binary on first start (from `temporal.download`), and that needs network access. No installer script is run.

### The crash test

```bash
npm run test:crash   # starts its own in-memory server and workers, SIGKILLs one after farewell wrote its line, checks the retry wrote nothing
npm run test:server  # runs start-server as a child process: it must stay up, accept a connection and exit 0 on SIGTERM
npm run test:unit    # no server needed: activity idempotency (repeat, overlap, partial line, stale lock), input parsing, workflow bundling, and `runClaudeSession` against a fake `claude`
```

`test:crash` and `test:server` start servers on free ports, so they do not touch `.temporal/dev.sqlite`. Both need the Temporal CLI, and both fail (never skip) when it is missing. If the SDK cannot download it, check the network (a VPN can break the download) or install the CLI and set `TEMPORAL_CLI_PATH` to it. On a failed assertion `test:server` stops its child with SIGTERM first, so the `temporal` process does not outlive the test.

## Configuration

Read once at startup in `src/config.ts`. A bad value fails fast, naming the variable. All are optional.

| Variable | Default | Used by |
|---|---|---|
| `TEMPORAL_ADDRESS` | `127.0.0.1:7233` | worker, client |
| `TEMPORAL_NAMESPACE` | `default` | worker, client |
| `TASK_QUEUE` | `orchestrator` | worker, client |
| `TEMPORAL_PORT` | `7233` | start-server |
| `TEMPORAL_DB_FILE` | `.temporal/dev.sqlite` | start-server |
| `TEMPORAL_CLI_PATH` | unset (SDK downloads one) | start-server, `test:server`, `test:crash` |
| `CLAUDE_BIN` | `claude` | `runClaudeSession` (tests set it to `test/fake-claude.sh`) |
| `CLAUDE_PERMISSION_MODE` | unset (the CLI's default) | `runClaudeSession`; one of `default`, `acceptEdits`, `plan`, `bypassPermissions` |

There are no secrets. Workflow history is stored, so a run carries identifiers only, never graph data (BR-0001).

## How the crash guarantee works

Temporal runs an activity at least once: a worker can die after the side effect and before the server hears about it. So the workflow decides the order and the bounds, and each activity is safe to run again.

- **Bounded.** Every activity has a start-to-close timeout and a retry policy with a maximum number of attempts (`src/workflows/hello.ts`). `farewell` also has a heartbeat timeout, so a dead worker is noticed in seconds.
- **Idempotent.** Each activity appends `<runKey> <step> ...` only if that exact line is not already there (`src/activities/hello.ts`). The check and the append run under one lock file, so two overlapping attempts (a stalled worker whose attempt was retried elsewhere) cannot both write, and a line cut short by a kill never counts as done. A lock left behind by a killed worker is broken after 1.5 seconds. The remaining gap: a holder that stalls for more than that between taking the lock and writing could be overtaken. The lock is held for milliseconds, and v1 accepts that.
- **Deterministic workflow.** The workflow file has no clock, I/O or randomness. The run key and the work duration come in as input.
- **Parsed at the boundary.** Activity input is parsed into a typed value first (`src/hello-types.ts`). A bad input is a non-retryable failure.

## Files

| File | Role |
|---|---|
| `src/workflows/hello.ts` | `helloWorkflow`: `greet`, then `farewell` |
| `src/activities/hello.ts` | The two activities |
| `src/worker.ts`, `src/client.ts` | The worker and the run starter |
| `src/start-server.ts`, `src/dev-server.ts` | The dev server launcher |
| `src/activities/claude-session.ts` | `runClaudeSession`: one worktree, one branch, one `claude -p` session |
| `src/claude-session-policy.ts` | Its timeouts, heartbeat and retry bounds (importable from workflow code) |
| `src/config.ts`, `src/hello-types.ts`, `src/types.ts` | Typed config and input and output parsing |
| `test/` | The crash test, the server-free unit tests, and `fake-claude.sh` (a stand-in for `claude`, so no test calls the model) |

## Dependencies

All pinned to exact versions in `package.json`: the Temporal TypeScript SDK 1.24.0 (`@temporalio/client`, `worker`, `workflow`, `activity`, `testing`; MIT, maintained by the Temporal SDK team), plus `typescript`, `@types/node` and `tsx` for the toolchain. `@temporalio/testing` is a runtime dependency here because it is the SDK's launcher for the dev server.

## The Claude session activity

`runClaudeSession` (`src/activities/claude-session.ts`, #627) creates a git worktree on a named branch, runs `claude -p` in it and returns `{ branch, headSha, exitStatus }`. It is built with `createClaudeSessionActivities(loadClaudeConfig(process.env))`, so the executable comes from config and tests substitute a fake.

- **One branch, one session.** The branch is created with `git worktree add -b`, which fails if it exists, so overlapping attempts cannot both start. An attempt that finds the branch locally, or on `origin` (where an open PR's branch lives), returns that state and starts nothing. `exitStatus` says what it found: `success` or `error` (a session of ours finished, recorded in the repo's config as `branch.<name>.orchestratorsession`), `interrupted` (one started and never finished, and it may still be running) or `existing` (not ours, or just created by an overlapping attempt). An unreachable `origin` is an error, never "no branch".
- **The prompt is one argv element**, after `--`, spawned without a shell. Only `type` and `is_error` are read from the JSON on stdout. A session's text is never returned, logged or put in an error message. Exit 0 with output that is not a result document fails the activity as `MalformedResult` (non-retryable, and the branch is marked `error` so a retry cannot start another session).
- **Bounded.** 30 minute session timeout enforced by the activity, 5 second heartbeat, 1 MB output cap, 20 second timeout on each git command, and a retry maximum of 3 for infrastructure failures only (`src/claude-session-policy.ts`). A timeout fails as `SessionTimeout` (non-retryable). A timeout or a cancel sends SIGTERM to the child's whole process group and SIGKILL after 5 seconds.
- **Known gap.** A worker that is itself SIGKILLed cannot stop its child. The next attempt reports `interrupted` and starts nothing.
