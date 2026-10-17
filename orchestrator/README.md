# Orchestrator

A Temporal-based orchestrator for the issue-to-PR loop (parent plan #625). It lives beside the Rust server and has its own `package.json`, lockfile and `tsconfig.json`, so Temporal's dependencies stay out of the root tooling. Nothing here is part of the MCP server.

This first slice (#626) proves the engine runs here and survives a crash. It holds one workflow, `helloWorkflow`, with two activities (`greet` and `farewell`), a worker and a client.

## What v1 does not do

- Both activity sets exist (`runClaudeSession`, #627, and the GitHub activities, #628), but neither is registered on the worker or called by a workflow yet (#629 wires them).
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
| `CLAUDE_PERMISSION_MODE` | unset (no flag is passed, so the CLI's own default applies) | `runClaudeSession`; one of `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan`, `bypassPermissions` (see "Permission modes") |
| `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS` | unset | `runClaudeSession`; must be `yes-skip-all-permission-checks` for `bypassPermissions` to be accepted |

There are no secrets. Workflow history is stored, so a run carries identifiers only, never graph data (BR-0001).

## How the crash guarantee works

Temporal runs an activity at least once: a worker can die after the side effect and before the server hears about it. So the workflow decides the order and the bounds, and each activity is safe to run again.

- **Bounded.** Every activity has a start-to-close timeout and a retry policy with a maximum number of attempts (`src/workflows/hello.ts`). `farewell` also has a heartbeat timeout, so a dead worker is noticed in seconds.
- **Idempotent.** Each activity appends `<runKey> <step> ...` only if that exact line is not already there (`src/activities/hello.ts`). The check and the append run under one lock file, so two overlapping attempts (a stalled worker whose attempt was retried elsewhere) cannot both write, and a line cut short by a kill never counts as done. A lock left behind by a killed worker is broken after 1.5 seconds. The remaining gap: a holder that stalls for more than that between taking the lock and writing could be overtaken. The lock is held for milliseconds, and v1 accepts that.
- **Deterministic workflow.** The workflow file has no clock, I/O or randomness. The run key and the work duration come in as input.
- **Parsed at the boundary.** Activity input is parsed into a typed value first (`src/hello-types.ts`). A bad input is a non-retryable failure.

## GitHub activities (#628)

`src/activities/github.ts` holds the activities the workflow will call, built by `createGithubActivities(config)`: `listReadyIssues`, `readIssue`, `claimIssue`, `addToBoard`, `getBoardStatus`, `setStatus`, `openPr`, `postReview` and `getGateStatus`. Each is a thin wrapper over `gh` (`src/gh.ts`): one process per call, an argv array and never a shell string, a timeout (30 s) and an output cap, and an answer parsed at the boundary (`src/github-parse.ts`). A malformed answer fails with the path of the first mismatch, never a value and never a partial result.

- **Trust.** `readIssue` drops, while listing, every comment whose `author_association` is not `OWNER`, `MEMBER` or `COLLABORATOR`, and refuses an issue written by anyone else. The same filter applies to the PRs and reviews the claim and review activities scan. A session never receives the text of a stranger.
- **Idempotent writes.** `claimIssue` and `setStatus` read the item's Status and write only when it differs. `openPr` looks for an open PR with the same head and base first. `postReview` looks for its idempotency key (a hidden comment in the body) first. A repeat changes nothing. `setStatus` makes only the forward steps In progress to In review and In review to Done for an issue (it refuses a Ready item, which is `claimIssue`'s, a Backlog item, and any move out of Done), plus a PR's own first move, Backlog to In review; it reads the board back after a write and fails if the board disagrees (see "Board items for PRs (#635)" below).
- **Gate.** `getGateStatus` runs the query of CLAUDE.md "Code review" step 5 and counts only submitted reviews (COMMENTED, APPROVED or CHANGES_REQUESTED, not a PENDING draft or a DISMISSED one) with a non-empty body, by a trusted author, on the head commit. The step 5 query itself counts a review of any state; the activity is stricter. A PR with more than 100 reviews or threads fails rather than being counted from part of its list.
- **Rate limits.** A primary limit waits until the reset time. A secondary limit waits `Retry-After`, or at least 60 seconds, doubling on each repeat. Three waits at most per call, and a wait longer than 10 minutes fails the activity (`GitHubRateLimitTooLong`, non-retryable) instead of sleeping. The workflow must give these activities a start-to-close timeout above the longest wait.
- **Never.** It cannot merge, apply a label (`golden-change` included), resolve a thread, or move an item into Ready or out of Backlog. `setStatus` accepts only In progress, In review and Done. `addToBoard` only adds an item to the board.

### What the workflow (#629) must do with them

- **The workflow ID is the claim.** `claimIssue` is read, then write, so two concurrent claims can both answer `claimed: true`, and an activity cannot see whether another workflow runs for the issue. Start one workflow per issue with a deterministic ID built from the issue number, and a reuse policy that rejects a duplicate (Temporal's `REJECT_DUPLICATE` for a closed one, and a start that fails when one is running). That, not the board, keeps two runs off one issue.
- **Act on `proceed`, never on `claimed` alone.** If the worker dies after `claimIssue` moved the item and before its answer was recorded, the retry reads In progress and answers `claimed: false, reason: already_in_progress, proceed: true`. That means carry on. `proceed: false` (an open PR, a `claude/` branch, or an item already In review or Done) means stop.
- **Timeouts.** Give every GitHub activity `GITHUB_ACTIVITY_TIMEOUTS` (`src/gh-config.ts`): a start-to-close of 45 minutes and a heartbeat timeout of 2 minutes. One attempt can wait out three rate limits of up to ten minutes each (the waits are counted over the whole attempt, not per request), which is 30 minutes before the requests' own time. The wait heartbeats every 5 seconds and stops when the activity is cancelled.

### Board items for PRs (#635): what #629 and #631 call

A PR is not on the board until something adds it, and the board puts a new item in Backlog. Three activities cover that, and none of them assumes a board write happened (foundations 4.10).

| Activity | Input | Does | Answer |
|---|---|---|---|
| `addToBoard(target)` | an issue or PR URL of the configured repo, `{ kind: 'issue' \| 'pr', number }`, or a bare number (an issue) | Reads the board first. Adds the item only when it is not there, then reads the board again | `{ kind, number, itemId, added, status }`. `added: false` means it was already there and nothing was written, its Status included. `status` is what the board shows now (`null` for none) |
| `getBoardStatus(target)` | the same | One read | `{ kind, number, onBoard, status }`, `status: null` when off the board or without one |
| `setStatus(target, status)` | the same, plus In progress, In review or Done | Reads, writes only if the Status differs and the move is allowed, then reads the board again | `{ changed, status }`. Fails if the board does not show `status` afterwards |

**The calls, in order.**

- **After `openPr` (#629):** `addToBoard(pr.url)`, then `setStatus(pr.url, 'In review')`, then `getBoardStatus(pr.url)` and compare it with In review. `setStatus` already fails when its own read-back disagrees, and the extra `getBoardStatus` is the workflow's independent check. Then `setStatus(issueNumber, 'In review')` for the issue (In progress to In review).
- **On merge (#631):** `setStatus(pr.url, 'Done')` and `setStatus(issueNumber, 'Done')`, then `getBoardStatus` for each. Closing the issue, if the merge did not, is #631's own step and not in these activities.
- **Every call is safe to run again.** A repeat of the whole sequence adds and writes nothing.

**A failed read-back is retryable, and bounded by the workflow.** If an add or a move exits 0 and the board does not show it, the activity fails as `BoardReadbackMismatch` (retryable). The message says what the board shows (a Status name or "no item", never a raw answer). The retry reads the board first and writes only what is still missing, so a board that was slow to show the change passes on the next attempt. Give these activities a retry policy with a maximum number of attempts, so a board that never shows it fails the step instead of looping. Do not catch `BoardReadbackMismatch` and carry on.

**Which moves are allowed.** `setStatus` keys its moves by the item's current Status, once for an issue and once for a PR.

| Current Status | Issue may go to | PR may go to |
|---|---|---|
| Backlog | nothing (Backlog to Ready is the maintainer's) | In review (the PR's own first move) |
| Ready | nothing (`claimIssue` claims a Ready item) | nothing |
| In progress | In review | In review |
| In review | Done | Done |
| Done, or no Status | nothing | nothing |

The one difference is Backlog to In review, and it is for a PR only: a PR is added in Backlog and never passes through Ready or In progress, while for an issue that move would skip the maintainer's gate. Everything else is the issue rule for both: a repeat is a no-op, a skipped step (Backlog to Done), a move back and anything out of Done are refused (`InvalidState`, non-retryable), and Ready and Backlog are never a target (`InvalidInput`).

**Trust.** `addToBoard` checks the item's `author_association` before it adds: an item by anyone but an OWNER, MEMBER or COLLABORATOR is refused as `UntrustedAuthor` and none of its text is read. An item that is already on the board is not checked, since nothing is written for it. `setStatus` and `getBoardStatus` never add an item: a PR that is off the board fails `setStatus` as `InvalidState`, so call `addToBoard` first.

**What the board's default is not ours to set.** `addToBoard` does not set a Status. The "Backlog" a new PR shows comes from the board's own default, which this code only reads. If a board ever adds an item with no Status, `setStatus` refuses it (`InvalidState`, "without a status") and the step fails visibly rather than guessing. `claimIssue` still does not read back after its write; only `setStatus` and `addToBoard` do.

Settings (all optional, read once in `src/gh-config.ts`): `ORCHESTRATOR_GH_PATH` (default `gh`), `ORCHESTRATOR_GITHUB_REPO` (`eborden/logseq-mcp-server`), `ORCHESTRATOR_PROJECT_OWNER` (`eborden`), `ORCHESTRATOR_PROJECT_NUMBER` (`1`), `ORCHESTRATOR_GH_TIMEOUT_MS` (`30000`). `npm run test:github` runs the tests against a fake `gh` (`test/fake-gh.mjs`), so it makes no GitHub call. The GitHub token is whatever `gh auth` holds, and it needs the `repo` and `project` scopes.

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
| `src/gh.ts`, `src/gh-config.ts`, `src/github-parse.ts`, `src/activities/github.ts` | The `gh` wrapper, its config, the parsers and the GitHub activities |
| `test/` | The crash test, the server-free unit tests, and `fake-claude.sh` (a stand-in for `claude`, so no test calls the model) and `fake-gh.mjs` (a stand-in for `gh`) |

## Dependencies

All pinned to exact versions in `package.json`: the Temporal TypeScript SDK 1.24.0 (`@temporalio/client`, `worker`, `workflow`, `activity`, `testing`; MIT, maintained by the Temporal SDK team), plus `typescript`, `@types/node` and `tsx` for the toolchain. `@temporalio/testing` is a runtime dependency here because it is the SDK's launcher for the dev server.

## The Claude session activity

`runClaudeSession` (`src/activities/claude-session.ts`, #627) creates a git worktree on a named branch, runs `claude -p` in it and returns `{ branch, headSha, exitStatus }`. It is built with `createClaudeSessionActivities(loadClaudeConfig(process.env))`, so the executable comes from config and tests substitute a fake.

- **One branch, one session.** The branch is created with `git worktree add -b`, which fails if it exists, so overlapping attempts cannot both start. An attempt that finds the branch locally, or on `origin`, returns that state and starts nothing. "An open PR exists" is implemented as "the branch exists on `origin`", because a PR's branch is pushed and this activity makes no GitHub call (#628 does). So a pushed branch with no PR also counts as taken. An unreachable `origin` is an error, never "no branch".
- **`exitStatus`** says what it found. The session marker is `branch.<name>.orchestratorsession` in the repo's config (`started`, then `success` or `error`), and the claim is `branch.<name>.orchestratorclaimed`, written before the branch exists.

| `exitStatus` | Meaning | Session started now? |
|---|---|---|
| `success`, `error` | A session of ours finished (`error` also covers a non-zero exit, `is_error`, a timeout and malformed output) | No |
| `interrupted` | A session started and never finished; it may still be running | No |
| `claimed` | An attempt created the branch and died before recording a start (or is doing so right now). The marker is written before the spawn, so no session ran. Nothing can tell a dead attempt from a live one | No |
| `existing` | The branch exists and has no claim: not made by this activity, or only on `origin` | No |

- **The prompt is one argv element**, after `--`, spawned without a shell. Only `type` and `is_error` are read from the JSON on stdout. A session's text is never returned, logged or put in an error message. Exit 0 with output that is not a result document fails the activity as `MalformedResult` (non-retryable, and the branch is marked `error` so a retry cannot start another session).
- **Bounded.** 30 minute session timeout enforced by the activity, a heartbeat every 5 seconds from the start of the activity to its end (the git phase included, so a slow `git ls-remote` cannot look like a dead worker; the heartbeat timeout is 30 seconds), 1 MB output cap, 20 second timeout on each git command, and a retry maximum of 3 for infrastructure failures only (`src/claude-session-policy.ts`). A timeout fails as `SessionTimeout` (non-retryable). A timeout or a cancel sends SIGTERM to the child's whole process group and SIGKILL after 5 seconds. However the child ends, the group then gets a final SIGKILL, so a descendant that ignores SIGTERM and holds no pipe does not outlive the activity.
- **Known gap.** A worker that is itself SIGKILLed cannot stop its child. The next attempt reports `interrupted` and starts nothing.

### Permission modes

`CLAUDE_PERMISSION_MODE` is a closed set, the choices `claude --help` lists for `--permission-mode` in CLI 2.1.302: `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan`, `bypassPermissions`. Re-check `claude --help` when the CLI is upgraded, since a value the CLI does not know makes every session exit non-zero (recorded as `error`). Unset passes no flag at all.

- `plan` only plans; a session cannot finish an issue in it.
- `acceptEdits` lets file edits through; other tools may still ask.
- `dontAsk` and `auto` decide without asking. Read the CLI's own help for exactly what each allows before using them unattended.
- `bypassPermissions` skips every permission check and can do anything the OS user can. It is refused unless `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS=yes-skip-all-permission-checks` is also set. The CLI itself recommends it only for sandboxes with no internet access.

**An unattended session can stall on a permission prompt.** In `-p` mode, `claude --help` says prompts go to `--permission-prompts host` by default, and with no host nobody answers. Such a session may sit until the 30 minute session timeout, fail as `SessionTimeout` and mark the branch `error`. The activity does not pass `--permission-prompts none` or pick a mode for you: which mode an unattended orchestrator should use is a decision for #629, taken with the risk above in mind.

### Verify before relying on it

The prompt is passed as `claude -p --output-format json [--permission-mode m] -- <prompt>`. Nothing has run this against the real `claude`: the tests use a fake that only proves what the activity sends, and `claude --help` does not mention `--`. It should follow the usual convention that `--` ends option parsing, so a prompt that starts with a dash is safe. Before #629 relies on it, one cheap manual check by the maintainer, which does call the model once: `claude -p -- "reply with ok"` and, for the dash case, `claude -p -- "-reply with ok"`. Record the result here.

### Recovering a stuck branch

By design nothing retries `interrupted`, `claimed` or `existing`, so a person (or a workflow step) clears them. Run these in the repo the activity used (`<repo>`), with the `branch` and worktree directory of the step.

1. For `interrupted` (and `claimed`, to be sure), make sure no session is still running: `pgrep -fl "claude -p"` and stop the one working in that worktree.
2. Remove the worktree, then the branch. Deleting the branch also deletes its `orchestratorsession` and `orchestratorclaimed` config:

   ```bash
   git -C <repo> worktree remove --force <worktreeDir>
   git -C <repo> branch -D <branch>
   git -C <repo> worktree prune
   ```
3. If the branch is on `origin` and should go too: `git -C <repo> push origin --delete <branch>`. Skip this when a PR is open on it and you want to keep that work.
4. Run the step again. `existing` for a branch you want to keep needs no recovery: it is the activity doing its job.

A claim left with no branch (a crash before `git worktree add`) needs nothing: the next attempt starts fresh. To drop it anyway: `git -C <repo> config --local --unset branch.<branch>.orchestratorclaimed`.
