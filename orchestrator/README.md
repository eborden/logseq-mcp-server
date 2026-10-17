# Orchestrator

A Temporal-based orchestrator for the issue-to-PR loop (parent plan #625). It lives beside the Rust server and has its own `package.json`, lockfile and `tsconfig.json`, so Temporal's dependencies stay out of the root tooling. Nothing here is part of the MCP server.

The first slice (#626) proved the engine runs here and survives a crash (`helloWorkflow`, kept as the engine check). `IssueWorkflow` (#629) is the first real workflow: it takes one Ready issue to an open PR that is In review on the board. See "IssueWorkflow" below.

## What v1 does not do

- No reviewer, no fix loop and no merge gate yet (#630), and nothing that watches for the merge and closes out the issue and the PR (#631). A run ends when the PR is In review.
- No scheduler and no approval signal: a person starts each run (`npm run run-issue`). Nothing picks Ready issues by itself.
- No Postgres, Docker or extra task queues. One task queue, `orchestrator`.
- It never merges, never applies `golden-change`, never resolves a review thread and never moves a board item to Ready or Backlog. The one board move into In review that skips a step is a PR's own first one (Backlog to In review, #635).

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
npm run test:unit    # no server needed: activity idempotency (repeat, overlap, partial line, stale lock), input parsing, workflow bundling, `runClaudeSession` against a fake `claude`, the GitHub activities against a fake `gh`, the brief builder and `runImplementerSession`
npm run test:workflow  # starts its own in-memory server: IssueWorkflow with fake activities (each side effect counted, each step's result lost once), and with the real activities against the fake gh and claude; every task replays the whole history
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
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | `runClaudeSession`; one of `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan`, `bypassPermissions` (see "Permission modes") |
| `CLAUDE_PERMISSION_PROMPTS` | `none` | `runClaudeSession`; `none` (a prompt is denied at once) or `host` (the CLI's own default) |
| `CLAUDE_ALLOWED_TOOLS` | the list in `DEFAULT_ALLOWED_TOOLS` (`src/config.ts`) | `runClaudeSession`; comma-separated tool rules such as `Edit,Bash(git status *)`, replaces the default list |
| `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS` | unset | `runClaudeSession`; must be `yes-skip-all-permission-checks` for `bypassPermissions` to be accepted. Never set it for the workflow |

There are no secrets. Workflow history is stored, so a run carries identifiers only, never graph data (BR-0001).

## How the crash guarantee works

Temporal runs an activity at least once: a worker can die after the side effect and before the server hears about it. So the workflow decides the order and the bounds, and each activity is safe to run again.

- **Bounded.** Every activity has a start-to-close timeout and a retry policy with a maximum number of attempts (`src/workflows/hello.ts`). `farewell` also has a heartbeat timeout, so a dead worker is noticed in seconds.
- **Idempotent.** Each activity appends `<runKey> <step> ...` only if that exact line is not already there (`src/activities/hello.ts`). The check and the append run under one lock file, so two overlapping attempts (a stalled worker whose attempt was retried elsewhere) cannot both write, and a line cut short by a kill never counts as done. A lock left behind by a killed worker is broken after 1.5 seconds. The remaining gap: a holder that stalls for more than that between taking the lock and writing could be overtaken. The lock is held for milliseconds, and v1 accepts that.
- **Deterministic workflow.** The workflow file has no clock, I/O or randomness. The run key and the work duration come in as input.
- **Parsed at the boundary.** Activity input is parsed into a typed value first (`src/hello-types.ts`). A bad input is a non-retryable failure.

## IssueWorkflow (#629)

`issueWorkflow` (`src/workflows/issue.ts`) takes one Ready issue to an open PR that is In review on the board. It is the first half of the loop: the reviewer, the fix loop and the merge gate are #630, and the merge is the maintainer's.

**What it does, in order.** Each step is an activity with a timeout and a bounded retry; the workflow code has no I/O and no clock.

1. `checkIssue`: the trusted-author read, answered as numbers (text never enters the history). A closed issue ends the run as `skipped`.
2. `claimIssue`: moves Ready to In progress unless a PR or a `claude/` branch exists. The workflow acts on `proceed`, never on `claimed` alone, so a retry of its own claim (`claimed: false, already_in_progress, proceed: true`) carries on. `proceed: false` ends the run as `skipped` (`open_pr`, `claude_branch` or `already_past_in_progress`), with no comment.
3. `getBoardStatus` until the board shows In progress (3 reads, 5 s apart). The claim does not read its own write back, so the workflow does.
4. `runImplementerSession`: reads the issue (trusted authors only), builds the brief (`src/brief.ts`) and runs one `claude -p` session on the branch `claude/<n>` in a worktree. It returns a branch, a SHA and a status. Only `success` goes on.
5. `openPr`: the PR is opened by the workflow, not by the session, with a body in the sections of the PR template (`Closes #<n>`). The session's own account of the work is its status comment on the issue.
6. `addToBoard`, `setStatus` In review, then `getBoardStatus` for the PR, then `setStatus` In review and `getBoardStatus` for the issue. A PR the workflow opens is In review on the board with no manual step, and the workflow reads the board back instead of assuming the move.

The run's result is `{ outcome: 'in_review', issueNumber, branch, headSha, pr }` or `{ outcome: 'skipped', issueNumber, reason }`. A run that needs a person ends as a Failed workflow of type `IssueStopped` with the step and the reason as its details, after one comment on the issue (see "Recovering a stuck run").

**What it never does.** Merge, apply `golden-change`, resolve a review thread, publish, tag or release, or move an item to Ready or Backlog. Its board writes are the claim (Ready to In progress), the PR's own first move (Backlog to In review, #635) and In progress to In review for the issue. The implementer session is told the same, and the permission list (below) does not allow `gh pr create`, `gh api` or a merge.

**Start a run.** One workflow per issue, by number. In `orchestrator/`, with `npm run start-server` and `npm run worker` running and `gh` authenticated (scopes `repo` and `project`) and the `claude` CLI on the worker's PATH:

```bash
npm run run-issue -- --issue 123                    # base main, repo dir = .., worktree <repo>/.claude/worktrees/issue-123
npm run run-issue -- --issue 123 --base feature/x --wait   # PR against another base, and wait for the result
```

`run-issue` prints `{"status":"started",...}`, `{"status":"already_running",...}` or `{"status":"already_finished","closedAs":"COMPLETED"|"FAILED"|...}`. The last two are reported, not errors, and start nothing.

**The claim and the retry rules.**

- **The workflow ID is the claim.** The ID is `issue-<n>` (`issueWorkflowId`). The client starts with a conflict policy of FAIL and a reuse policy of REJECT_DUPLICATE (`src/issue-client.ts`): while a run is open a second start is refused, and once a run has closed, whatever way, the ID cannot start again. `claimIssue` is read then write and cannot see another workflow, so this, not the board, keeps two runs off one issue.
- **A failed premise is never retried.** An activity's retryable failures (a timeout, a 5xx from GitHub) are retried by its own bounded policy (3 attempts; `src/github-policy.ts`, `src/board-policy.ts`, `src/claude-session-policy.ts`). A permanent one (`NotFound`, `UntrustedAuthor`, `InvalidState`, `SessionTimeout`, `MalformedResult`, `ClaudeUnavailable`, `BriefTooLarge`) is not retried, and neither is a session that ends `error`, `interrupted`, `claimed` or `existing`: any of those means a person must look, and the workflow never starts a second session.
- **Bounds.** The whole run is limited to 8 hours (the workflow execution timeout), and each step, retries included, to 2 hours (`scheduleToCloseTimeout`). A step that hits its bound stops the run as `ActivityTimeout`.
- **One comment per stop.** The comment is fixed words and identifiers (workflow ID, step, reason, PR number), keyed by the step, so a repeat does not post twice. No comment is posted when the reason is `UntrustedAuthor` (not ours to talk on) or `NotFound` (nowhere to post). If the comment itself cannot be posted the run still ends Failed with the reason in its failure.
- **A crash at any point.** Temporal replays the workflow and does not run a finished step again. A step that did its side effect and died before its result was recorded is run again, and each is safe to: `claimIssue` answers `proceed`, `runClaudeSession` starts no second session for a branch that exists, `openPr` finds the open PR, `addToBoard` and `setStatus` write only what is missing, `commentIssue` finds its key. The tests lose the result of each step once and count the side effects.

**The issue text and the history.** Temporal stores every activity input and result. The issue's body and comments therefore never pass through the workflow: `runImplementerSession` reads the issue and builds the brief inside the activity, and `checkIssue` answers counts. The history holds numbers, SHAs, statuses, branch names, the PR title and body (fixed text) and local paths from the start input. The brief puts the issue and its trusted comments in one tagged block as escaped JSON, after the repo's rules (untrusted-content rule, privacy rule, `--body-file`, no merging, atomic commits with the Co-Authored-By line, a status comment at the end), so issue text cannot be read as part of the rules.

**Recovering a stuck run.** A run that needs a person ends Failed with an `IssueStopped` failure: `temporal workflow show --workflow-id issue-<n>` shows its step and reason, and so does the comment on the issue. A closed run holds its ID. After you have fixed the cause, remove the closed run and start again: `temporal workflow delete --workflow-id issue-<n>` (it deletes the history, and it would terminate a run that is still open, so use it only on a closed one), then `npm run run-issue`. A restart is safe: the claim answers `already_in_progress`, a finished session is not run again, and the PR is found.

| Step and reason | What happened | What to do |
|---|---|---|
| `check` `UntrustedAuthor` | The issue's author is not an OWNER, MEMBER or COLLABORATOR. Nothing was read or changed, and no comment was posted | Re-file the issue yourself, or ignore it |
| `check` `NotFound` | The number is not an issue of the repo (a PR number is refused too) | Start it with the right number |
| `check` or `claim` other | GitHub failed after its retries, or the item is not Ready (`InvalidState`) | Fix the board or the cause, then delete the run and start again |
| `skipped` (`open_pr`, `claude_branch`, `already_past_in_progress`, `issue_closed`) | Nothing to do: a PR or branch already exists, the item is In review or Done, or the issue is closed. The run completed | To run it anyway, close the PR, delete the branch and move the item back to Ready (the maintainer's move), then delete the run and start again |
| `confirm_claim` `BoardDisagrees` | The claim's write did not show on the board in 3 reads | Look at the board. Set In progress by hand if it is wrong, then delete the run and start again |
| `session` `SessionTimeout`, `SessionError`, `MalformedResult` | The session ran past 30 minutes, ended in error or printed something that is not a result. The branch is marked `error` | Read the worktree and the issue comment, then "Recovering a stuck branch" (delete the branch to try again) before deleting the run |
| `session` `ClaudeUnavailable` | The `claude` executable could not start. The branch and worktree were removed | Fix `CLAUDE_BIN` or PATH, then delete the run and start again |
| `session` `SessionInterrupted`, `SessionClaimed`, `SessionExistingBranch` | A session started and never finished (a killed worker), or the branch exists and was not made by this workflow | "Recovering a stuck branch": make sure no `claude -p` is still running, then remove the worktree and branch |
| `session` `BriefTooLarge`, `InvalidState` | The issue and its comments do not fit a prompt, or the issue is closed | Shorten the issue, or leave it closed |
| `open_pr` any | The PR was not opened. A common cause is that the session did not push the branch, or made no commit | Push the branch from its worktree (`git -C <worktree> push -u origin claude/<n>`), then delete the run and start again: the finished session is not run again |
| `board_pr`, `board_issue` | The PR is open but the board did not show the move. The comment names the PR | Move the item by hand if you must, or delete the run and start again: the restart finds the open PR and writes only what is missing |
| `ActivityTimeout`, `ActivityFailed` at any step | The step hit its 2 hour bound, or failed in a way that was not classified | Read the worker's log, then as for the step |

## GitHub activities (#628)

`src/activities/github.ts` holds the activities the workflow calls, built by `createGithubActivities(config)`: `listReadyIssues`, `readIssue`, `checkIssue`, `commentIssue`, `claimIssue`, `addToBoard`, `getBoardStatus`, `setStatus`, `openPr`, `postReview` and `getGateStatus`. `checkIssue` is `readIssue` answered as numbers and flags (`{ number, open, trustedComments, droppedUntrustedComments }`), so the workflow can gate on an issue without the issue's text entering the stored history. `commentIssue({ issue, key, body })` posts one comment and a retry finds it by a hidden `<!-- orchestrator-comment:<key> -->` marker, looking only at comments of trusted authors (the same rule as `postReview`; it assumes this account's own comments count as trusted). Each is a thin wrapper over `gh` (`src/gh.ts`): one process per call, an argv array and never a shell string, a timeout (30 s) and an output cap, and an answer parsed at the boundary (`src/github-parse.ts`). A malformed answer fails with the path of the first mismatch, never a value and never a partial result.

- **Trust.** `readIssue` drops, while listing, every comment whose `author_association` is not `OWNER`, `MEMBER` or `COLLABORATOR`, and refuses an issue written by anyone else. The same filter applies to the PRs and reviews the claim and review activities scan. A session never receives the text of a stranger.
- **Idempotent writes.** `claimIssue` and `setStatus` read the item's Status and write only when it differs. `openPr` looks for an open PR with the same head and base first. `postReview` looks for its idempotency key (a hidden comment in the body) first. A repeat changes nothing. `setStatus` makes only the forward steps In progress to In review and In review to Done for an issue (it refuses a Ready item, which is `claimIssue`'s, a Backlog item, and any move out of Done), plus a PR's own first move, Backlog to In review; it reads the board back after a write and fails if the board disagrees (see "Board items for PRs (#635)" below).
- **Gate.** `getGateStatus` runs the query of CLAUDE.md "Code review" step 5 and counts only submitted reviews (COMMENTED, APPROVED or CHANGES_REQUESTED, not a PENDING draft or a DISMISSED one) with a non-empty body, by a trusted author, on the head commit. The step 5 query itself counts a review of any state; the activity is stricter. A PR with more than 100 reviews or threads fails rather than being counted from part of its list.
- **Rate limits.** A primary limit waits until the reset time. A secondary limit waits `Retry-After`, or at least 60 seconds, doubling on each repeat. Three waits at most per call, and a wait longer than 10 minutes fails the activity (`GitHubRateLimitTooLong`, non-retryable) instead of sleeping. The workflow must give these activities a start-to-close timeout above the longest wait.
- **Never.** It cannot merge, apply a label (`golden-change` included), resolve a thread, or move an item into Ready or out of Backlog. `setStatus` accepts only In progress, In review and Done. `addToBoard` only adds an item to the board.

### What the workflow does with them (#629)

- **The workflow ID is the claim.** `claimIssue` is read, then write, so two concurrent claims can both answer `claimed: true`, and an activity cannot see whether another workflow runs for the issue. `IssueWorkflow` runs under the deterministic ID `issue-<number>` and the client starts it with a conflict policy of FAIL and a reuse policy of REJECT_DUPLICATE (`src/issue-client.ts`). That, not the board, keeps two runs off one issue.
- **Act on `proceed`, never on `claimed` alone.** If the worker dies after `claimIssue` moved the item and before its answer was recorded, the retry reads In progress and answers `claimed: false, reason: already_in_progress, proceed: true`. That means carry on. `proceed: false` (an open PR, a `claude/` branch, or an item already In review or Done) means stop.
- **Timeouts.** Every GitHub activity gets `GITHUB_ACTIVITY_TIMEOUTS` from `src/github-policy.ts` (a file workflow code can import; `gh-config.ts` re-exports it): a start-to-close of 45 minutes and a heartbeat timeout of 2 minutes. One attempt can wait out three rate limits of up to ten minutes each (the waits are counted over the whole attempt, not per request), which is 30 minutes before the requests' own time. The wait heartbeats every 5 seconds and stops when the activity is cancelled. The non-board activities have at most `GITHUB_ACTIVITY_MAX_ATTEMPTS` (3) attempts, the board ones `BOARD_ACTIVITY_MAX_ATTEMPTS`.

### Board items for PRs (#635): what #629 and #631 call

A PR is not on the board until something adds it, and the board puts a new item in Backlog. Three activities cover that, and none of them assumes a board write happened (foundations 4.10).

| Activity | Input | Does | Answer |
|---|---|---|---|
| `addToBoard(target)` | an issue or PR URL of the configured repo, `{ kind: 'issue' \| 'pr', number }`, or a bare number (an issue) | Reads the board first. Adds the item only when it is not there, then reads the board again | `{ kind, number, itemId, added, status }`. `added: false` means it was already there and nothing was written, its Status included. `status` is what the board shows now (`null` for none) |
| `getBoardStatus(target)` | the same | One read | `{ kind, number, onBoard, status }`, `status: null` when off the board or without one |
| `setStatus(target, status)` | the same, plus In progress, In review or Done | Reads, writes only if the Status differs and the move is allowed, then reads the board again | `{ changed, status }`. Fails if the board does not show `status` afterwards |

**The calls, in order.**

- **After `openPr` (#629, `IssueWorkflow`):** `addToBoard({ kind: 'pr', number })`, then `setStatus` to In review, then `getBoardStatus` and compare it with In review. `setStatus` already fails when its own read-back disagrees, and the extra `getBoardStatus` is the workflow's independent check (up to 3 reads, 5 s apart, as a workflow timer). Then the same two calls for the issue (In progress to In review).
- **On merge (#631):** `setStatus(pr.url, 'Done')` and `setStatus(issueNumber, 'Done')`, then `getBoardStatus` for each. Closing the issue, if the merge did not, is #631's own step and not in these activities.
- **Every call is safe to run again.** A repeat of the whole sequence adds and writes nothing.

**Re-reads and retries are bounded by constants, not by prose.** `src/board-policy.ts` holds them and imports nothing from Node or `config.ts`, so workflow code can import it. After a write, `addToBoard` and `setStatus` re-read the board up to `BOARD_RE_READS` (3) more times, waiting `BOARD_RE_READ_DELAY_MS` (2 s) before each; the wait heartbeats and stops when the activity is cancelled. GitHub Projects can show a stale Status for a moment after a write, so one stale read does not fail the step. If the board still disagrees, the attempt fails as `BoardReadbackMismatch`, which is retryable on purpose: the retry reads first and writes only what is missing. Give the three board activities `BOARD_ACTIVITY_OPTIONS` (or at least `retry.maximumAttempts: BOARD_ACTIVITY_MAX_ATTEMPTS`, 3), because Temporal's default is unlimited attempts and a board that never shows the change would loop. The message says what the board shows (a Status name or "no item", never a raw answer). Do not catch `BoardReadbackMismatch` and carry on.

**Which moves are allowed.** `setStatus` keys its moves by the item's current Status, once for an issue and once for a PR.

| Current Status | Issue may go to | PR may go to |
|---|---|---|
| Backlog | nothing (Backlog to Ready is the maintainer's) | In review (the PR's own first move) |
| Ready | nothing (`claimIssue` claims a Ready item) | nothing |
| In progress | In review | In review |
| In review | Done | Done |
| Done, or no Status | nothing | nothing |

The one difference is Backlog to In review, and it is for a PR only: a PR is added in Backlog and never passes through Ready or In progress, while for an issue that move would skip the maintainer's gate. Everything else is the issue rule for both: a repeat is a no-op, a skipped step (Backlog to Done), a move back and anything out of Done are refused (`InvalidState`, non-retryable), and Ready and Backlog are never a target (`InvalidInput`).

**A missing item is `NotFound`, not a retry.** GitHub answers a missing issue or PR as a `null` item plus a `NOT_FOUND` error, and `gh` exits 1 on it. `gh.graphql` returns that answer's data when every error is `NOT_FOUND`, so the activity fails as `NotFound` (non-retryable, no GitHub text in the message). A PR number looked up as an issue (a bare number is an issue) gets the same answer from GitHub and fails the same way, so name a PR by URL or `{ kind: 'pr', number }`.

**Trust.** `addToBoard` checks the item's `author_association` before it adds: an item by anyone but an OWNER, MEMBER or COLLABORATOR, or with no `author_association` at all (missing or null), is refused as `UntrustedAuthor` and none of its text is read. An item that is already on the board is not checked, since nothing is written for it. `setStatus` and `getBoardStatus` never add an item: a PR that is off the board fails `setStatus` as `InvalidState`, so call `addToBoard` first.

**A new item's Status arrives a moment after the add.** `addToBoard` does not set a Status: the Backlog a new PR shows is set by a board workflow that runs after the add, and this code only reads it. `addToBoard` waits (the same bounded re-reads) for it and answers `status: null` if it never shows; `setStatus` waits the same way, and an item that is on the board but still shows no Status then fails as the retryable `BoardReadbackMismatch` (#629), so the retry policy's three attempts cover about 40 seconds (6 s of re-reads each, 5 s and 10 s between attempts) before the step fails visibly. Every other refusal of `setStatus` (a move it does not allow) stays non-retryable `InvalidState`. `claimIssue` still does not read back after its write; only `setStatus` and `addToBoard` do.

Settings (all optional, read once in `src/gh-config.ts`): `ORCHESTRATOR_GH_PATH` (default `gh`), `ORCHESTRATOR_GITHUB_REPO` (`eborden/logseq-mcp-server`), `ORCHESTRATOR_PROJECT_OWNER` (`eborden`), `ORCHESTRATOR_PROJECT_NUMBER` (`1`), `ORCHESTRATOR_GH_TIMEOUT_MS` (`30000`). `npm run test:github` runs the tests against a fake `gh` (`test/fake-gh.mjs`), so it makes no GitHub call. The GitHub token is whatever `gh auth` holds, and it needs the `repo` and `project` scopes.

## Files

| File | Role |
|---|---|
| `src/workflows/hello.ts` | `helloWorkflow`: `greet`, then `farewell` |
| `src/activities/hello.ts` | The two activities |
| `src/worker.ts`, `src/client.ts` | The worker (it registers every activity set) and the `hello` run starter |
| `src/workflows/issue.ts` | `issueWorkflow`: the steps of "IssueWorkflow" above |
| `src/issue-types.ts` | Its input, result, workflow ID, branch name, bounds and the fixed text of the stop comment and the PR (importable from workflow code) |
| `src/issue-client.ts`, `src/run-issue.ts` | Starts a run for one issue (the claim policy), and the `npm run run-issue` script |
| `src/brief.ts` | `buildBrief`: the implementer's brief, a pure function |
| `src/activities/implementer.ts` | `runImplementerSession`: reads the issue, builds the brief and runs the session in one activity, so issue text stays out of the history |
| `src/start-server.ts`, `src/dev-server.ts` | The dev server launcher |
| `src/activities/claude-session.ts` | `runClaudeSession`: one worktree, one branch, one `claude -p` session |
| `src/claude-session-policy.ts` | Its timeouts, heartbeat and retry bounds (importable from workflow code) |
| `src/config.ts`, `src/hello-types.ts`, `src/types.ts` | Typed config and input and output parsing |
| `src/gh.ts`, `src/gh-config.ts`, `src/github-parse.ts`, `src/activities/github.ts` | The `gh` wrapper, its config, the parsers and the GitHub activities |
| `src/board-policy.ts`, `src/github-policy.ts` | The re-read and retry bounds of the board activities, and the timeouts and attempts of the other GitHub activities (importable from workflow code) |
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

`CLAUDE_PERMISSION_MODE` is a closed set, the choices `claude --help` lists for `--permission-mode` in CLI 2.1.302: `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan`, `bypassPermissions`. Re-check `claude --help` when the CLI is upgraded, since a value the CLI does not know makes every session exit non-zero (recorded as `error`). The activity passes a flag only when the config has a value for it; `loadClaudeConfig` gives the unattended defaults below when nothing is set.

- `plan` only plans; a session cannot finish an issue in it.
- `acceptEdits` lets file edits through; other tools may still ask.
- `dontAsk` and `auto` decide without asking. Read the CLI's own help for exactly what each allows before using them unattended.
- `bypassPermissions` skips every permission check and can do anything the OS user can. It is refused unless `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS=yes-skip-all-permission-checks` is also set. The CLI itself recommends it only for sandboxes with no internet access.

**An unattended session can stall on a permission prompt.** In `-p` mode, `claude --help` says prompts go to `--permission-prompts host` by default, and with no host nobody answers. Such a session may sit until the 30 minute session timeout, fail as `SessionTimeout` and mark the branch `error`.

**The decision for the implementer session (#629), pending the maintainer's confirmation before the first real run.** Not `bypassPermissions`, and the workflow never sets `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS`. The default is the least permissive configuration `claude --help` (CLI 2.1.302) documents that lets an implementer edit files, run git and run the repo's checks:

- `--permission-mode acceptEdits`: file edits go through without a prompt.
- `--permission-prompts none`: anything that would prompt is denied at once instead of waiting for nobody, so a session cannot sit on a prompt until the timeout. A denied tool call is the session's to work around, or to report in its status comment; the run then stops at the `session` step with a comment if it ends without success.
- `--allowedTools=<comma list>` (`DEFAULT_ALLOWED_TOOLS` in `src/config.ts`): Read, Glob, Grep, Edit and Write; git by verb (status, diff, log, show, add, commit, fetch, rebase, rev-parse) and `git push` only to a `claude/` branch; `cargo`, `npm`, `npx`, `node` and `shellcheck` (the repo's checks); `gh issue view`, `gh issue comment` and `gh pr view`. No `gh api`, no `gh pr create` (the workflow opens the PR), no merge, no shell, no `curl`, no `rm`. It is passed as one `--allowedTools=...` argument so the variadic option cannot swallow the prompt that follows `--`.

What this does not give you, plainly: the list limits what the model may ask for, it is not a sandbox. `cargo`, `npm`, `npx` and `node` run whatever the repo's files say, so a session that can run the tests can run arbitrary code as your OS user, and `Edit` can change any file under the worktree. Your user and project settings files (`~/.claude/settings.json` and the worktree's `.claude/settings.json`) still apply, and can allow more than this list. Do not run the worker as a user with credentials you would not hand to the maintainer's own Claude session. Change the three settings with `CLAUDE_PERMISSION_MODE`, `CLAUDE_PERMISSION_PROMPTS` and `CLAUDE_ALLOWED_TOOLS` (a list replaces the default; it is not merged).

### Verify before relying on it

The prompt is passed as `claude -p --output-format json --permission-mode m --permission-prompts p --allowedTools=<list> -- <prompt>`.

- **Checked by the maintainer on Claude Code 2.1.302 (recorded for #627):** `claude -p -- "reply with ok"` answered `ok`, and `claude -p -- "--version"` treated the text as the prompt and did not parse it as a flag. So `--` ends option parsing, and a prompt that starts with a dash is safe.
- **Checked for #629, without calling the model:** `claude --help` lists `--permission-mode`, `--permission-prompts` (`host` or `none`) and `--allowedTools`; and `claude -p --output-format json --permission-mode acceptEdits --permission-prompts none --allowedTools "Bash(git *)" "Edit" --` with no prompt and no stdin was accepted by the option parser and stopped at "Input must be provided" before any model call.
- **Not verified:** that the comma-joined `--allowedTools=...` value is split into separate rules the way the help text's example suggests (including patterns with spaces and `*`), that `Bash(git push -u origin claude/*)` matches the command a session really types, that a `git commit -m "$(cat <<EOF ...)"` is allowed by `Bash(git commit *)`, and what a denied call looks like to the session. No real session was run with these flags. The first real run is the check, so watch it, and read the session's status comment for denied calls.

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
