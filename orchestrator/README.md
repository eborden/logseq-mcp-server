# Orchestrator

A Temporal-based orchestrator for the issue-to-PR loop (parent plan #625). It lives beside the Rust server and has its own `package.json`, lockfile and `tsconfig.json`, so Temporal's dependencies stay out of the root tooling. Nothing here is part of the MCP server.

The first slice (#626) proved the engine runs here and survives a crash (`helloWorkflow`, kept as the engine check). `IssueWorkflow` (#629) is the first real workflow: it takes one Ready issue to an open PR that is In review on the board, and (#630) reviews that PR, runs a bounded fix loop and stops at "gate clear, waiting for the maintainer". See "IssueWorkflow" and "The review loop" below.

## What v1 does not do

- No webhook and no UI for the maintainer's decision: it is a signal sent by a CLI (`npm run signal`, #631). The merge is always the maintainer's.
- No scheduler: a person starts each run (`npm run run-issue`). Nothing picks Ready issues by itself.
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
npm run test:unit    # no server needed: activity idempotency (repeat, overlap, partial line, stale lock), input parsing, workflow bundling, `runClaudeSession` against a fake `claude`, the GitHub activities against a fake `gh`, the brief builder, `runImplementerSession`, and the diff guard and the branch activities against throwaway repositories with a local bare origin
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
| `CLAUDE_DISALLOWED_TOOLS` | the list in `DEFAULT_DISALLOWED_TOOLS` | `runClaudeSession`; comma-separated tool rules that are denied whatever an allow rule says. What you set is added to the default list and never replaces it |
| `CLAUDE_SETTING_SOURCES` | `project` | `runClaudeSession`; comma-separated, from `user`, `project`, `local` (`--setting-sources`). The default leaves the host user's settings and hooks out |
| `REMOTE_ROUTINE_IMPLEMENTER`, `REMOTE_ROUTINE_REVIEWER`, `REMOTE_ROUTINE_FIXER` | unset | `runRemoteSession` (#672): the id (`trig_...`) of each role's routine. Setting any of the six remote variables turns the activity on, and then all six are required |
| `REMOTE_ROUTINE_IMPLEMENTER_TOKEN`, `REMOTE_ROUTINE_REVIEWER_TOKEN`, `REMOTE_ROUTINE_FIXER_TOKEN` | unset | **Secrets.** The bearer token of each routine (see "Remote sessions") |
| `REMOTE_REPO_DIR` | the worker's directory | `runRemoteSession`: the working copy whose git config holds the session markers (an absolute path) |
| `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS` | unset | `runClaudeSession`; must be `yes-skip-all-permission-checks` for `bypassPermissions` to be accepted. Never set it for the workflow |

The only secrets are the three routine tokens of the remote sessions: they are read once at startup, handed to the fire client and nowhere else, and never logged or put in a result, an error message or the workflow history. Workflow history is stored, so a run carries identifiers only, never graph data (BR-0001).

## How the crash guarantee works

Temporal runs an activity at least once: a worker can die after the side effect and before the server hears about it. So the workflow decides the order and the bounds, and each activity is safe to run again.

- **Bounded.** Every activity has a start-to-close timeout and a retry policy with a maximum number of attempts (`src/workflows/hello.ts`). `farewell` also has a heartbeat timeout, so a dead worker is noticed in seconds.
- **Idempotent.** Each activity appends `<runKey> <step> ...` only if that exact line is not already there (`src/activities/hello.ts`). The check and the append run under one lock file, so two overlapping attempts (a stalled worker whose attempt was retried elsewhere) cannot both write, and a line cut short by a kill never counts as done. A lock left behind by a killed worker is broken after 1.5 seconds. The remaining gap: a holder that stalls for more than that between taking the lock and writing could be overtaken. The lock is held for milliseconds, and v1 accepts that.
- **Deterministic workflow.** The workflow file has no clock, I/O or randomness. The run key and the work duration come in as input.
- **Parsed at the boundary.** Activity input is parsed into a typed value first (`src/hello-types.ts`). A bad input is a non-retryable failure.

## IssueWorkflow (#629)

`issueWorkflow` (`src/workflows/issue.ts`) takes one Ready issue to an open PR that is In review on the board. The steps below are the first half of the loop; the second half (the reviewer, the fix loop and the merge gate, #630) is "The review loop" below, and the merge is the maintainer's.

**What it does, in order.** Each step is an activity with a timeout and a bounded retry; the workflow code has no I/O and no clock.

1. `checkIssue`: the trusted-author read, answered as numbers (text never enters the history). A closed issue ends the run as `skipped`.
2. `claimIssue`: moves Ready to In progress unless a PR or a `claude/` branch exists. The workflow acts on `proceed`, never on `claimed` alone, so a retry of its own claim (`claimed: false, already_in_progress, proceed: true`) carries on. `proceed: false` ends the run as `skipped` (`open_pr`, `claude_branch` or `already_past_in_progress`), with no comment.
3. `getBoardStatus` until the board shows In progress (3 reads, 5 s apart). The claim does not read its own write back, so the workflow does.
4. `runImplementerSession`: reads the issue (trusted authors only), builds the brief (`src/brief.ts`) and runs one `claude -p` session on the branch `claude/<n>` in a worktree. It returns a branch, a SHA and a status. Only `success` goes on.
5. `guardBranch`: what the session changed, over **the same range the push publishes**. It reads two lists with `git log --raw` and `git diff --raw` (names and modes, `-z`, `--no-renames` so a rename is seen at both ends): HISTORY, `origin/<base>..<sha>`, is every commit reachable from the head and not already on the base, which is exactly the set `git push` of the branch sends; NET, `origin/<base>...<sha>`, is the merge base to the head, the change the PR shows. A protected path or a special file in ANY commit of HISTORY refuses the branch, even if a later commit undoes it (a secret or a workflow added and removed is still published). NET decides whether there is anything to push (empty is refused) and whether it is too big (over 300 files is refused). A base that moved on, or that the branch was rebased or merged onto, adds nothing to either list that is not the session's own. The activity does not fetch: the worktree's `origin/<base>` is the one it started from, and a stale one can only widen HISTORY, never narrow it. The failure carries counts and no path. See "The protected set" below. Tests (`test/branch.test.ts`) cover a protected change in the first of two or three commits, one added and removed, a clean multi-commit branch, and a moved, rebased and merged base.
6. `pushBranch`: the only push. The session cannot push (no push rule is allowed to it). The activity accepts only `claude/<number>`, never a refspec or an option, and runs exactly `git -c core.hooksPath=/dev/null push -u origin claude/<number>` (hooks off, because a session can write into the shared `.git/hooks`), then reads the remote back. Pushing an up-to-date branch changes nothing.
7. `openPr`: the PR is opened by the workflow, not by the session, with a body in the sections of the PR template (`Closes #<n>`). The session's own account of the work is its status comment on the issue.
8. `addToBoard`, `setStatus` In review, then `getBoardStatus` for the PR, then `setStatus` In review and `getBoardStatus` for the issue. A PR the workflow opens is In review on the board with no manual step, and the workflow reads the board back instead of assuming the move.

After step 8 the run goes on with the review loop (below) and then the maintainer's decision ("The maintainer's decision", below). Its result is `{ outcome: 'merged' | 'changes_requested' | 'decision_timeout' | 'merge_timeout', ... }`, `{ outcome: 'skipped', issueNumber, reason }`, or, with `awaitDecision: false` (the review loop's own tests), `{ outcome: 'gate_clear', ... }` or `{ outcome: 'waiting_for_threads', ... }`. A run that needs a person ends as a Failed workflow of type `IssueStopped` with the step and the reason as its details, after one comment on the issue (see "Recovering a stuck run").

**What it never does.** Merge, apply `golden-change`, resolve a review thread, publish, tag or release, or move an item to Ready or Backlog. Its board writes are the claim (Ready to In progress), the PR's own first move (Backlog to In review, #635) and In progress to In review for the issue. The implementer session is told the same, and its permission lists (below) allow no push of any kind, no `gh pr`, no `gh api` and no merge. The only push is `pushBranch`, to `claude/<number>`.

**Start a run.** One workflow per issue, by number. In `orchestrator/`, with `npm run start-server` and `npm run worker` running and `gh` authenticated (scopes `repo` and `project`) and the `claude` CLI on the worker's PATH:

```bash
npm run run-issue -- --issue 123                    # base main, repo dir = .., worktree <repo>/.claude/worktrees/issue-123
npm run run-issue -- --issue 123 --base feature/x --wait   # PR against another base, and wait for the result
```

`run-issue` prints `{"status":"started",...}`, `{"status":"already_running",...}` or `{"status":"already_finished","closedAs":"COMPLETED"|"FAILED"|...}`. The last two are reported, not errors, and start nothing.

**The claim and the retry rules.**

- **The workflow ID is the claim.** The ID is `issue-<n>` (`issueWorkflowId`). The client starts with a conflict policy of FAIL and a reuse policy of REJECT_DUPLICATE (`src/issue-client.ts`): while a run is open a second start is refused, and once a run has closed, whatever way, the ID cannot start again. `claimIssue` is read then write and cannot see another workflow, so this, not the board, keeps two runs off one issue.
- **REJECT_DUPLICATE is a deliberate choice, for now.** A run that stopped and needs a person holds its ID, so starting it again takes a manual `temporal workflow delete --workflow-id issue-<n>`. That is a cheap human acknowledgement while the permission model is unproven (the first real runs have not happened). The duplicate-session risk is already blocked by the branch marker, so ALLOW_DUPLICATE_FAILED_ONLY is a candidate once the first runs behave; it is a one-line change in `src/issue-client.ts`, and the tests that pin the current policy would change with it.
- **A failed premise is never retried.** An activity's retryable failures (a timeout, a 5xx from GitHub) are retried by its own bounded policy (3 attempts; `src/github-policy.ts`, `src/board-policy.ts`, `src/claude-session-policy.ts`). A permanent one (`NotFound`, `UntrustedAuthor`, `InvalidState`, `SessionTimeout`, `MalformedResult`, `ClaudeUnavailable`, `BriefTooLarge`) is not retried, and neither is a session that ends `error`, `interrupted`, `claimed` or `existing`: any of those means a person must look, and the workflow never starts a second session.
- **Bounds.** The whole run is limited to 21 days (the workflow execution timeout, #631: room for at most 10 days to wait for the decision and 10 days for the merge). Before the gate nothing caps the run as a whole except the review loop's own 4 hour timer; each step, retries included, to 2 hours (`scheduleToCloseTimeout`). A step that hits its bound stops the run as `ActivityTimeout`. `runImplementerSession` has its own start-to-close of 75 minutes (`IMPLEMENTER_START_TO_CLOSE_MS`): the read of the issue can wait out three rate limits of ten minutes before the session starts, and the session has its own 30 minute limit, so the two cannot share the session activity's 35 minutes. The guard and the push have 5 minutes each (`BRANCH_ACTIVITY_OPTIONS`).
- **One comment per stop.** The comment is fixed words and identifiers (workflow ID, step, reason, PR number), keyed by the step and the reason (`stopped-<step>-<reason>`), so the same stop does not post twice and a different reason at the same step does. No comment is posted when the reason is `UntrustedAuthor` (not ours to talk on) or `NotFound` (nowhere to post). If the comment itself cannot be posted the run still ends Failed with the reason in its failure.
- **A crash at any point.** Temporal replays the workflow and does not run a finished step again. A step that did its side effect and died before its result was recorded is run again, and each is safe to: `claimIssue` answers `proceed`, `runClaudeSession` starts no second session for a branch that exists, `guardBranch` only reads, `pushBranch` of an up-to-date branch changes nothing, `openPr` finds the open PR, `addToBoard` and `setStatus` write only what is missing, `commentIssue` finds its key. The tests lose the result of each step once and count the side effects.

**The issue text and the history.** Temporal stores every activity input and result. The issue's body and comments therefore never pass through the workflow: `runImplementerSession` reads the issue and builds the brief inside the activity, and `checkIssue` answers counts. The history holds numbers, SHAs, statuses, branch names, the PR title and body (fixed text) and local paths from the start input. The brief puts the issue and its trusted comments in one tagged block as escaped JSON, after the repo's rules (untrusted-content rule, privacy rule, `--body-file`, no merging, atomic commits with the Co-Authored-By line, a status comment at the end), so issue text cannot be read as part of the rules.

**Recovering a stuck run.** A run that needs a person ends Failed with an `IssueStopped` failure: `temporal workflow show --workflow-id issue-<n>` shows its step and reason, and so does the comment on the issue. A closed run holds its ID. After you have fixed the cause, remove the closed run and start again: `temporal workflow delete --workflow-id issue-<n>` (it deletes the history, and it would terminate a run that is still open, so use it only on a closed one), then `npm run run-issue`. A restart is safe: the claim answers `already_in_progress`, a finished session is not run again, and the PR is found.

| Step and reason | What happened | What to do |
|---|---|---|
| `check` `UntrustedAuthor` | The issue's author is not an OWNER, MEMBER or COLLABORATOR. Nothing was read or changed, and no comment was posted | Re-file the issue yourself, or ignore it |
| `check` `NotFound` | The number is not an issue of the repo (a PR number is refused too) | Start it with the right number |
| `check` or `claim` other | GitHub failed after its retries, or the item is not Ready (`InvalidState`) | Fix the board or the cause, then delete the run and start again |
| `skipped` (`open_pr`, `claude_branch`, `already_past_in_progress`, `issue_closed`) | Nothing to do: a PR or branch already exists, the item is In review or Done, or the issue is closed. The run completed | To run it anyway, close the PR, delete the branch and move the item back to Ready (the maintainer's move), then delete the run and start again. A stopped review loop is not resumed this way: a restart ends here as `skipped` |
| `confirm_claim` `BoardDisagrees` | The claim's write did not show on the board in 3 reads | Look at the board. Set In progress by hand if it is wrong, then delete the run and start again |
| `session` `SessionTimeout`, `SessionError`, `MalformedResult` | The session ran past 30 minutes, ended in error or printed something that is not a result. The branch is marked `error` | Read the worktree and the issue comment, then "Recovering a stuck branch" (delete the branch to try again) before deleting the run |
| `session` `ClaudeUnavailable` | The `claude` executable could not start. The branch and worktree were removed | Fix `CLAUDE_BIN` or PATH, then delete the run and start again |
| `session` `SessionInterrupted`, `SessionClaimed`, `SessionExistingBranch` | A session started and never finished (a killed worker), or the branch exists and was not made by this workflow | "Recovering a stuck branch": make sure no `claude -p` is still running, then remove the worktree and branch |
| `review_session`, `fix_session` `RemoteExecutorUnavailable` | The run asked for `executor: 'remote'` on a worker that has no remote session activity (the six `REMOTE_ROUTINE_*` variables are unset). The remote steps are not registered, so the run stops at the first one | Set the variables, or run with `--executor local` after deleting the closed run ("Recovering a stuck run") |
| `session` `RemoteSessionClaimed`, `RemoteLaunchFailed`, `RemoteSessionTimedOut`, `RemoteSessionNoHead` | The remote implementer: the work was already taken (an open PR or a `claude/<n>` branch), the fire failed within its budget, the session pushed nothing or its push never settled within the cap (after the one second attempt), or it finished with no head. No PR was opened | "The remote implementer" and "Remote sessions": look at the session at claude.ai/code and at the branch, delete an orphan branch, then start again |
| `guard` `ProtectedPath`, `SpecialFile`, `DiffTooLarge`, `EmptyDiff` (remote) | The guard refused the branch the remote session pushed. It was deleted from the remote and no PR was opened. The comment has counts only | Make the change yourself in a PR you write, or file a smaller issue |
| `guard` `BranchMoved`, `BranchMissing`, `DeleteRejected`, `MalformedGitOutput` (remote) | The branch is not at the sha the session reported (or moved after the guard, with the PR already open), is gone, could not be deleted, or git's output could not be read. Nothing is deleted except on a refusal | "Recovering from an orphan remote branch" in "The remote implementer" |
| `session` `BriefTooLarge`, `InvalidState` | The issue and its comments do not fit a prompt, or the issue is closed | Shorten the issue, or leave it closed |
| `guard` `ProtectedPath`, `SpecialFile`, `DiffTooLarge`, `EmptyDiff` | Some commit of the branch changes a protected path or a symlink, submodule or file mode, or the branch changes more than 300 files, or nothing. Nothing was pushed. The comment has counts only | Look at `git log --raw origin/<base>..claude/<n>` in the worktree. If the change is wanted, make it yourself in a PR you write; to run the issue again, delete the branch ("Recovering a stuck branch"), then the run |
| `push` `PushRejected`, `BranchMoved` | The remote refused the push (for example `claude/<n>` already exists with other history), or the branch is not at the commit the session ended at | Look at the remote branch and the local one, fix or delete the one that is wrong, then delete the run and start again: the finished session is not run again |
| `open_pr` any | The branch was pushed but the PR was not opened (GitHub refused it, or failed after its retries) | Open the PR by hand or delete the run and start again: the finished session is not run again, the guard and the push repeat as no-ops |
| `board_pr`, `board_issue` | The PR is open but the board did not show the move. The comment names the PR | Move the item by hand if you must, or delete the run and start again: the restart finds the open PR and writes only what is missing |
| `review_session`, `fix_session` `SessionError`, `SessionInterrupted`, `SessionTimeout`, `MalformedResult` | A reviewer or fixer session failed or never finished. Its marker holds the state | The loop cannot be resumed: finish the PR by hand ("The review loop", Recovering) |
| `review_session`, `fix_session` `MalformedFindings`, `FindingsTooLarge`; `review_post` `DiffUnreadable` | The session's file was refused (see "The review loop"). Nothing was posted | Read the file in the review worktree, then finish the PR by hand (a restart skips the loop) |
| `review_post`, `threads`, `fix_reply` any | GitHub refused the review (for example an inline comment on a line the diff does not change, which GitHub rejects) or the reply, or failed after its retries | Read the worker's log and finish the PR by hand: a restart skips the loop |
| `fix_guard`, `fix_push` any | As `guard` and `push` above, for the fixer's commits (a `remote` run has no `fix_push`, and its refusal is `FixerPushRejected`: "The remote fixer") | As above, on `claude/<n>` |
| `review_loop` `MaxRoundsReached`, `ReviewLoopTimeout`; `gate` `ReviewNotCounted`, `HeadMismatch` | See "The review loop" | The PR is the maintainer's, by hand |
| `ActivityTimeout`, `ActivityFailed` at any step | The step hit its 2 hour bound, or failed in a way that was not classified | Read the worker's log, then as for the step |

## The review loop (#630)

`reviewLoop` (`src/workflows/review-loop.ts`) is the second half of `issueWorkflow`: CLAUDE.md "Code review" steps 1 to 5, as code. It starts when the PR is open and In review, and it never merges, never applies a label, never approves or requests changes and **never resolves a review thread**. No activity does, and `test/review-loop.test.ts` fails if any source file names a call that would.

**What it does, in order, until it ends.**

1. **Review.** `runReviewerSession`: a fresh `claude -p` session each time, never the author's, in a detached worktree of its own at the head commit (`<worktree>-review-<round>`). Its brief (`buildReviewerBrief`) holds the PR number, the linked issue (trusted authors only) and a pointer to CLAUDE.md, and the open threads as quoted data. It cannot call `gh` or push, so it writes one JSON file, `review-findings.json`, and `postSessionReview` reads it, parses it and posts ONE review through the existing `postReview` (event `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`, with the findings as inline comments), keyed `review-<pr>-r<round>-<head>`.
2. **Gate.** `getGateStatus`, then `gateClear` (`src/gate.ts`): at least one review on the head and no unresolved thread. A pure function; no model is involved. Zero threads with zero reviews on the head is **not** clear. If GitHub still shows an older head than the one just pushed, the gate is read again (3 reads, 5 s apart) and then the run stops as `HeadMismatch`.
3. **Threads.** `listOpenThreads` answers ids and a trusted flag, no text. A thread is the fixer's to act on when its first comment is by an OWNER, MEMBER or COLLABORATOR and the reviewer has not accepted a reply on it. With none left, the run ends (below).
4. **Fix.** At most `maxFixRounds` times (default 3): `runFixerSession` in the implementer's worktree, then `guardBranch` and `pushBranch` for the new commits (the session cannot push), then `postFixerReplies`, then back to step 1 on the new head. **That review is the closing review**: a push moves the head, a review on an older commit never counts for the gate, so a new one is always made on the new head before the gate is read.

**How it ends.**

| Outcome | Meaning |
|---|---|
| `gate_clear` | A review on the head, no unresolved thread. The run is **waiting for the maintainer**. Result: the PR, the head, the number of fix rounds, the reviews on the head, and `advisory` and `advisoryOmitted` (counts of the last review's advisory findings, which sit in its body and hold no thread) |
| `waiting_for_threads` | Every open thread is one the reviewer accepted a reply on (`acceptedThreadIds`) or one the loop may not act on (an untrusted author's). The run says so in one comment on the issue and ends (with `awaitDecision: false`; otherwise it holds at the gate, see "The maintainer's decision"). The result carries the same `advisory` and `advisoryOmitted` counts (of the last review), and the comment names them when there are any. **Only a person resolves a thread, so the gate stays not clear until the maintainer resolves them.** After that, the gate is clear (a review is on the head) |
| stopped, `review_loop` `MaxRoundsReached` | Threads were still open for the fixer after `maxFixRounds` rounds. One comment, a Failed run, the PR is the maintainer's |
| stopped, `review_loop` `ReviewLoopTimeout` | The loop took longer than `reviewLoopTimeoutMs` (default 4 hours): the running step is cancelled (its session is stopped), one comment, a Failed run |
| stopped, `gate` `ReviewNotCounted` | No thread is open yet no review counts on the head (a review that landed on another commit, or was not counted). Looping would post review after review, so a person looks |
| stopped, `gate` `HeadMismatch` | GitHub did not show the head the loop pushed, after 3 reads |
| stopped at `review_session`, `review_post`, `threads`, `fix_session`, `fix_guard`, `fix_push`, `fix_reply` | A step failed: one comment keyed by step and reason, a Failed run, as in the first half |

**Why the workflow does not resolve threads.** The issue's first draft had the reviewer session resolve the threads it accepts. Sessions are denied `gh api`, and the loop does not loosen that to give them a GraphQL mutation, so nothing in the orchestrator resolves a thread. The reviewer records the threads it accepts in its output, the workflow carries those ids in its result, and a person resolves them. This is an **open question for the maintainer** (below): if a run should clear its own gate, that needs a decision about who may resolve a thread and with which token.

**Bounds** (all in `src/review-policy.ts`, importable from workflow code; the numbers are assumptions for the maintainer to confirm):

- `DEFAULT_MAX_FIX_ROUNDS = 3`. The input may set `maxFixRounds` (1 to 10).
- `DEFAULT_REVIEW_LOOP_TIMEOUT_MS = 4 hours` for the whole loop, enforced by a cancellable scope in `issue.ts`. The input may set `reviewLoopTimeoutMs` (1 second to 6 hours; the small values are for tests). The whole run is limited to 21 days (see "Bounds" above).
- Each step, retries included, 2 hours (`ISSUE_STEP_TIMEOUT`); the reviewer and the fixer activities have the implementer's 75 minutes (`REVIEW_SESSION_ACTIVITY_OPTIONS`), with 3 attempts. A session is never run twice: its marker in the repo's git config (`orchestrator.reviewer-<pr>-r<round>`, `orchestrator.fixer-<pr>-r<round>`: `started`, then `success` or `error`) turns a retry into the finished result, `SessionInterrupted` or `SessionError`, and these are not retried.
- The thread list, the gate and the posting use the GitHub activity timeouts and 3 attempts.

**What comes back from a session is untrusted output.** The reviewer's and the fixer's files are read by the activity at the boundary (`src/review-types.ts`): a file that is missing, not a plain file (a symlink is refused), over 64000 bytes, not JSON, or not in the asked shape (at most 30 findings, 50 replies, 3000 characters per comment, 4000 for the summary, a relative path with no `..`, a positive line, thread ids of a fixed alphabet) is **refused whole, never cut**, as `MalformedFindings` or `FindingsTooLarge`, and the run stops. What passes is sanitised before it is posted: control and reordering characters removed, `<!--` and `-->` written as entities (so text cannot forge the hidden idempotency markers), every `@name` mention broken with a zero-width space (in a code span too), HTML closed (`<` becomes `&lt;`), link and image targets cut off from their text, raw URLs and `www.` no longer autolinking, and the "suggestion" code block made inert. Review and reply text never reaches the workflow: the activities return counts, thread ids and review ids, and the history tests scan every string of a finished and of a failed run.

**Trust.** Only an OWNER, MEMBER or COLLABORATOR's text reaches a brief. A thread whose first comment is by anyone else is left out and counted; a comment by anyone else inside a trusted thread is dropped. The comments that remain may have been written by an earlier session (a review comment, a fixer reply); the briefs say so, and quote and escape them as data in one tagged block (`<thread-data>`), so they cannot be read as instructions.

**What the sessions may do** (README, "Permission modes", for the mechanism; both are unverified until the maintainer's drill):

- The reviewer (`reviewerAllowedTools`): Read, Glob, Grep, read-only git (`status`, `diff`, `log`, `show`, `rev-parse`), and `Write(/review-findings.json)`. No commit, no `npm`, no `cargo`, no `gh`. It runs under the same deny list as the implementer. With `acceptEdits` it could edit files of its own throwaway worktree, which nobody reads or pushes.
- The fixer: the implementer's allowed tools (it needs to edit, commit and run the checks), in the implementer's worktree on `claude/<n>`. It writes its replies to `fixer-replies.json` there (kept out of `git status` through `.git/info/exclude`). Its commits go through the same `guardBranch` and `pushBranch` as the implementer's.

**Recovering: a stopped review loop is finished by hand.** There is no way to resume the loop in v1. By the time it runs, the PR is open, the issue is In review and the branch `claude/<n>` exists, so a restarted `issueWorkflow` ends at the claim as `skipped` (`already_past_in_progress` or `open_pr`) and never reaches `reviewLoop`; removing a session marker changes nothing. After a stop in the loop (`SessionError`, `SessionInterrupted`, `MalformedFindings`, `FindingsTooLarge`, `DiffUnreadable`, `HeadMismatch`, `ReviewNotCounted`, a GitHub refusal at `review_post`, `MaxRoundsReached`, `ReviewLoopTimeout`), the PR is the maintainer's: read the stop comment, look at the PR and its threads, and review, fix and resolve by hand. For `MalformedFindings` and `FindingsTooLarge` the refused file is still in the review worktree (`<worktree>-review-<round>`), for reading before you remove it with `git worktree remove --force`. Resuming the loop from an open PR (an entry point that skips the first half) is a follow-up needed before a run is left unattended. The session markers are `orchestrator.reviewer-<pr>-r<round>-<head>` and `orchestrator.fixer-<pr>-r<round>` in the repo's git config (a `remote` run's are `orchestrator.remote-reviewer-<pr>-r<round>-<head12>` and `orchestrator.remote-fixer-<pr>-r<round>`) (`git -C <repo> config --local --get-regexp '^orchestrator\.'` lists them).

*To continue by hand:* read the stop comment (and `temporal workflow show --workflow-id issue-<n>`), then review the PR's head, fix what the open threads ask on `claude/<n>` and push, reply on the threads, resolve the answered ones (only a person does) and merge as for any PR. The run is already closed (Failed), so nothing else waits on it. For `ReviewNotCounted`, first check that the account whose token the orchestrator uses is an OWNER, MEMBER or COLLABORATOR of the repo.

*To abandon it,* after stopping any `claude -p` still running (`pgrep -fl "claude -p"`): `git -C <repo> worktree remove --force <worktree>-review-<round>`, `git -C <repo> worktree prune`, `git -C <repo> config --local --unset <marker>` for each marker the list shows for the PR, close the PR, and delete the branch if it should go (`git -C <repo> push origin --delete claude/<n>`, then "Recovering a stuck branch"). Removing a marker resumes nothing: the run that read it is closed. Moving the issue back to Ready is the maintainer's. To run the issue again after that, delete the run (`temporal workflow delete --workflow-id issue-<n>`) and `npm run run-issue`.

**Findings on lines the commit did not change are advisory.** GitHub rejects a whole review (422) when one inline comment is not on a line the PR changes, and refusing the whole file would stop the run just the same. So before it posts, the activity runs `git diff -U0 origin/<base>...<head>` (in the repo, not in the session's worktree), parses the changed lines with a pure function (`changedLines`, `splitFindings` in `src/review-types.ts`) and posts only the findings on those lines as inline comments. The others are listed in the review body under a note that says they are **advisory**: a body-only finding opens no thread, so it does not hold the gate and nothing makes the fixer act on it. A person reading the review sees it; the loop does not. If the diff cannot be read and the file has findings, the run stops as `DiffUnreadable` and posts nothing, because a review whose findings no thread holds could clear the gate; with no findings the review is still posted. The body list is capped at 20000 characters and says how many more were left out. The result carries counts only (`comments`, `advisory`, `omitted`), never the text.

**A findings file is read only when the session wrote it.** The reviewer's worktree is a checkout of the PR's own tree, so before the session starts the activity removes any `review-findings.json` that tree carries (a link itself, not its target). After the session it refuses the file when it is missing, is not a plain file (a link is not followed), or is tracked by git (the PR's own file, not the session's). The fixer's replies file gets the same checks.

**Reviewer read access.** The reviewer, like the implementer, is allowed bare `Read`, `Glob` and `Grep`, so a session steered by hostile issue or PR text could read host files outside its worktree and quote them in a finding, which is then posted publicly. The permission lists are risk reduction, not a boundary. The boundary is the dedicated OS user that runs the worker, which has no personal files, and the narrowly scoped GitHub token. The sanitiser covers only the output side: it neutralises mentions, links, images, raw URLs and hidden markers in what is posted, and it cannot know that a quoted line came from a file the session should not have read.

**The token's account must count.** The gate counts only reviews by an OWNER, MEMBER or COLLABORATOR. If the orchestrator's `gh` token belongs to an account that is none of these on the repository, its own reviews never count and every run stops at `ReviewNotCounted`. The gate is read up to 3 times (5 s apart) before that stop, to allow for GitHub lagging a review it just accepted.

**`test/review-loop.test.ts` checks the source for calls that resolve, approve, merge, label or write to the board.** The scan is in `test/invariants.ts`: GraphQL mutation names, REST routes, `gh` argv, method names and event names, read through comments, string concatenation, template literals and `join`, with board writes allowed only in `activities/github.ts`. A test adds each form to a scratch copy of the review activity to show it is caught. It is a text scan and a **tripwire, not a proof**: a name built at run time from data, or code outside `src/`, is invisible to it, and the permission model, the token's scopes and review are what hold the line.


## The maintainer's decision (#631)

After the review loop the run waits for the maintainer, with a signal, at no cost and across restarts. Nothing here merges, applies `golden-change`, or moves a board item into Ready or out of Backlog.

**Send it.** `npm run signal -- <issue> approved|changes_requested [--message "<text>"]`. The CLI parses the arguments into the typed payload `{ decision, at, message? }` (`at` is today's local date, or `--date YYYY-MM-DD`; a message is at most 1000 characters), refuses when `issue-<n>` is not running, and sends the `maintainerDecision` signal. The workflow parses the payload again at its boundary. The message is the one piece of free text that reaches the workflow's history, because it travels in the signal.

**What the run does, in order** (`src/workflows/decision.ts`):

1. **Hold.** It reads the PR (`getPrState`) and the gate (`getGateStatus`, then `gateClear`) every `decisionPollMs` (default 1 hour) until the gate is clear. A PR the maintainer merged with no signal goes straight to step 6 after one comment saying no decision was recorded (`decisionRecorded: false`); a PR closed unmerged stops the run (`PrClosedUnmerged`). A decision that arrives before that is **held, not rejected**: it is kept, and used only on a clear gate. A decision that arrives and finds the gate open again (a thread was opened) waits again.
2. **Wait.** On a clear gate with no decision, it waits for the signal until `decisionTimeoutMs` (default 7 days, 1 second to 10 days; an assumption for the maintainer to confirm) in all, held time included.
3. **Comment.** One PR comment (key `decision-<pr>`): the decision, its date, the maintainer's message as a quote, the head commit, and, when the PR changes golden results, call ceilings, ADRs or business rules (counted by `getPrChanges`, no path leaves the activity), a sentence saying that the label or the OK is the maintainer's and the workflow applies nothing.
4. **`changes_requested`** ends the run (`outcome: 'changes_requested'`). It does not touch the branch.
5. **`approved`** goes on: it reads the PR (`getPrState`) every `decisionPollMs` until it is merged, up to `decisionTimeoutMs` more. A PR closed unmerged stops the run (`merge_wait`, `PrClosedUnmerged`), and so does a head that moved after the approval (`HeadMovedAfterApproval`: an approval does not survive a push). No merge in time is `outcome: 'merge_timeout'` with one comment on the PR.
6. **Done.** On a merge it sets the PR and then its issue to Done with the #635 activities and reads each status back (`BoardDisagrees` if the board does not show it), then checks the issue is closed (`checkIssue`) and closes it if not (`closeIssue`: the one new write, `state: closed` with the reason `completed`, read back, an issue of a trusted author only). A PR merged into a branch other than the default does not close its issue, and the cause of #626 closing on its own was not established, so the run verifies instead of assuming. `outcome: 'merged'` says whether the run closed it (`issueClosedByRun`).

**A decision binds to the head current when the gate clears**, not to the head the maintainer saw when they sent it; the comment names that head. A push after the comment stops the run (`HeadMovedAfterApproval`).

**A merge wins over a decision.** If the PR is merged while a `changes_requested` is held, the run records that decision (its comment says the run does not change the branch again), then moves the PR and the issue to Done anyway, since the merge happened.

**A timeout never approves.** With no decision by the limit the run comments on the PR (key `decision-timeout-<pr>`) and ends `outcome: 'decision_timeout'`.

**A duplicate or malformed signal changes nothing.** The inbox keeps the first well-formed decision. Everything after it, and every payload that does not parse, is only counted (`ignoredSignals` in the result). So a second, different word cannot undo the first; to change a decision before it is used, start the review again by hand.

**What changed for the review loop.** With the decision wait on, a loop that finds only threads it may not act on (`waiting_for_threads`) no longer ends the run: it comments once, then holds at the gate until the maintainer resolves them, so a decision signalled meanwhile is not lost. At the limit it ends `decision_timeout`. `awaitDecision: false` keeps the old endings.

**Not done here.** A webhook, a UI, the merge, and the `golden-change` label.

## The executor flag (#671)

`executor` is a field of the run's input, `'local'` or `'remote'`, and says where the model sessions (implementer, reviewer, fixer) run. Absent means `local`. It is parsed with the rest of the input (`parseIssueWorkflowInput`), so any other value fails the run as `InvalidInput` before an activity, and the review loop gets it with the rest of the input.

- `local` is v1, unchanged: the workflow calls `runImplementerSession`, `runReviewerSession` and `runFixerSession` exactly as before. The default does not change.
- `remote` runs the **implementer** (#673, "The remote implementer" below), the **reviewer** (#674, "The remote reviewer" below) and the **fixer** (#675, "The remote fixer" below) remotely. On a worker without the remote session activity the run stops at the first remote step with `RemoteExecutorUnavailable`, one comment on the issue and no session started.

**Turn it on.** `npm run run-issue -- --issue 123 --executor remote`. Any value other than `local` and `remote` is an error before a workflow starts. The one choice point is `onExecutor` in `src/workflows/executor.ts`.

## The remote implementer (#673)

With `executor: 'remote'` the implementer step runs a remote session, and **the order of the guard and the push changes**, because the session pushes its own `claude/<n>` branch and the worker cannot stop it (spike #645: a cloud session can push `claude/<n>`, a bare push runs no CI, and it cannot delete a remote branch). Code: `src/workflows/remote-implementer.ts`.

| | `local` (v1, unchanged) | `remote` |
|---|---|---|
| 1 | `runImplementerSession`: `claude -p` on the worker | `runRemoteImplementerSession`: reads the issue, builds the brief inside the activity (so the issue text stays out of the history), calls `runRemoteSession` as role `implementer` with the attempt number |
| 2 | `guardBranch` on the **local** branch | `guardRemoteBranch`: fetches `claude/<n>` and the base with fixed argv (hooks off), checks the fetched tip is the sha the session reported, runs the same HISTORY and NET checks, and reads the remote again: a tip that changed while it ran is refused |
| 3 | `pushBranch`, the only push | **no push**: the session already pushed |
| 4 | `openPr` | `openPr`, only on the sha the guard passed |

**The remote implementer's brief** is `buildRemoteImplementerBrief` (`src/brief.ts`, #688), not the local `buildBrief`. It shares the rules and the issue data block with the local brief (one function, so a rule change reaches both) and differs in one place: it tells the session to push its own `claude/<n>` branch with a normal push (`git push -u origin claude/<n>`, never forced), tells it not to open a PR (the orchestrator guards the pushed branch and opens it), and does not say "you cannot push" or that skills are unavailable, which are false in a cloud session. The local brief is pinned byte for byte by `test/data/local-brief.snapshot.txt`.

**A guard refusal** (`ProtectedPath`, `DiffTooLarge`, `EmptyDiff`, `SpecialFile`) deletes the remote branch with `deleteRemoteBranch` (`git -c core.hooksPath=/dev/null push origin --delete claude/<n>`, then it reads the remote back; a branch that is already gone is success, so a retry is safe), then stops the run at `guard` with the guard's reason, one keyed comment (`stopped-guard-<reason>`) holding the counts and the fact that the branch was deleted, and no PR. No path is in the comment. If the delete itself fails, the run stops at `guard` with the delete's reason (`DeleteRejected` or an activity failure) and the branch is still there: see below.

**Head movement.** After the PR opens, the workflow reads the PR's head back; if it is not the guarded sha (the branch moved between the guard's last read and the PR's creation) the run stops at `guard` with `BranchMoved`, says in the comment that the PR is open on an unchecked commit, and does not delete the branch. A branch whose tip is not the sha the session reported (`BranchMoved`), or that is gone (`BranchMissing`), or that moved while the guard ran, stops the run at `guard`. It is **not** deleted: nothing says the branch is bad, only that it was not the one that was checked. No PR is opened on an unguarded sha.

**The attempt counter** lives in the workflow. The first call passes attempt 1. A session that ended with no push at all (`timed_out`, no head) gets one more attempt, number 2, which fires a new session because the marker key carries the attempt ("Remote sessions" below); a second miss stops with `RemoteSessionTimedOut`. A claim (`RemoteSessionClaimed`), a failed launch (`RemoteLaunchFailed`), a push that never settled (`RemoteSessionTimedOut`) and a finish with no head (`RemoteSessionNoHead`) stop at `session` with no second attempt. A guard refusal stops the run for a person, so the counter does not advance there. **Residual risk:** `timed_out` means the wait hit its cap, not that the session is dead, and a remote session cannot be stopped from here. Attempt 1 may still be running when attempt 2 fires, and both would push `claude/<n>`. The claim stops attempt 2 only when attempt 1 has already pushed (`branch_exists`). Check claude.ai/code and stop the old session before a re-run. The run input takes an optional `attempt` (a positive whole number, `--attempt <n>` on `run-issue`, default 1): the first attempt number of the remote implementer, with the in-run counter going on from there. **To recover from a guard refusal, delete the closed run and start it again with the next attempt number** (`npm run run-issue -- --issue <n> --executor remote --attempt 2`): the new key fires a fresh session and does not re-attach to the old one, and no marker is edited by hand. A re-run without `--attempt` starts at 1 and re-attaches to the first session's marker.

**Recovering from an orphan remote branch.** The branch `claude/<n>` is left on the remote when a run stops at `guard` for head movement or when the delete failed, and when a worker dies between the session and the guard. Nothing opens a PR for it, and CI does not run on a bare push. A new run for the issue is refused by the claim (`branch_exists`) while it is there. To recover:
1. Look at the branch (`git fetch origin claude/<n>`, then `git log origin/main..FETCH_HEAD`). It is the session's work, unchecked.
2. If it is not wanted, delete it from your own credential: `git push origin --delete claude/<n>`.
3. Delete the closed workflow run ("Recovering a stuck run") and start again with the next attempt number (`--attempt`, above), so the new run fires a fresh session.

**What these tests do not cover.** A real remote session, a real worker, the LogSeq suite and a real `git push --delete` against GitHub (including branch-protection answers) are not run: the branch activities run against local bare repositories, and the session is a fake that pushes from a second clone.

## Host integration (#647)

`runHostIntegration` (`src/activities/host-integration.ts`) runs the integration suite on a PR head. The suite needs the LogSeq desktop app, which is macOS only, so this is the one activity that runs on the maintainer's Mac and the only one on the `host` task queue. It uses no model and no GitHub call. The issue workflow calls it at the gate when a run is started with `--host-integration` (#648, "The host integration check at the gate" below); without that flag nothing calls it.

**What runs.** For `{ pr, headSha, base }`, in a throwaway detached worktree under the OS temp directory (`logseq-mcp-orchestrator-host/pr-<n>/tree`, never inside your working copy):

1. remove what an earlier run of the same PR left (stop its instance, remove its worktree);
2. `git fetch` the base and `refs/pull/<n>/head`, `git worktree add --detach` at `origin/<base>`, `git merge --no-edit <headSha>`. A merge conflict is the outcome `conflict` and no suite starts;
3. `npm ci`, `cargo build --locked`, `npx tsx scripts/logseq-instance.ts start`, `npm run test:integration -- --reporter=json --outputFile=<file>`, and `npx tsx scripts/logseq-instance.ts stop` (in a `finally`: after a failure, a timeout and a cancellation too);
4. `git status --porcelain -- tests/fixtures/graph` must be empty, or the outcome is `fixture_dirty`;
5. remove the worktree and every output file.

**The result** is `{ outcome: 'pass' | 'fail' | 'conflict' | 'fixture_dirty' | 'setup_error', passed, failed }`: one fixed word and two integers (from the JSON reporter's `numPassedTests` and `numFailedTests`). No test name, message or path is returned. The raw output of every command goes to a file in the run's directory, capped at 64 MiB per command, and is deleted with the worktree. Log lines carry a step name and an exit code only.

**Bounds.** One deadline for the whole run (40 minutes), cut into a timeout per command, a heartbeat from start to end, and a start-to-close backstop of 50 minutes. A failing suite is returned as `fail` and never retried. A failure before the suite starts (fetch, worktree, install, build, instance start) is thrown once and retried once; the second attempt returns `setup_error`. A timeout returns `setup_error` and is not retried. A report-less suite (its global setup refused, or it crashed) is `setup_error`, never a pass.

**The commands run the PR's code** (install scripts, `build.rs`, the tests) as the worker's user, so they get an allowlist of environment variables (`PATH`, `HOME`, `CARGO_HOME` and a few more) and not the worker's: no token reaches them, and no `LOGSEQ_MCP_CONFIG`. Send a branch here only after `guardBranch` accepted it. LogSeq starts only through `scripts/logseq-instance.ts`, which sandboxes the app's profile; the suite refuses port 12315 and never reads `~/.logseq-mcp/config.json`.

**Turning it on.** The worker starts a second worker in the same process, for the `host` queue, only when `HOST_TASK_QUEUE` is set (`host`, `1` or `true`; anything else stops the worker at startup). It registers only `runHostIntegration` with `maxConcurrentActivityTaskExecutions: 1`: **one run at a time**, because one LogSeq instance serves one suite. Run exactly one such worker. **UNVERIFIED:** whether a `SIGINT` or `SIGTERM` waits for the running activity's cleanup (instance stop, worktree removal) before the process exits; neither worker sets `shutdownGraceTime`. The drill below checks it. Until then, treat Ctrl-C during a run as a crash and use the recovery below. `HOST_REPO_DIR` (an absolute path) names the working copy the worktrees are made from; without it the worker uses the directory it started in. Without `HOST_TASK_QUEUE` the worker is exactly as before.

```bash
HOST_TASK_QUEUE=host HOST_REPO_DIR=$HOME/src/logseq-mcp-server npm run worker
```

**Recovering.**

- *A stuck worktree.* The next run of the same PR removes it first. By hand: `git -C <repo> worktree remove --force <tmp>/logseq-mcp-orchestrator-host/pr-<n>/tree`, then `git -C <repo> worktree prune`, then delete `<tmp>/logseq-mcp-orchestrator-host/pr-<n>`.
- *A LogSeq instance left running* (the worker was killed with SIGKILL, so no `finally` ran). From the worktree, if it still exists: `npx tsx scripts/logseq-instance.ts stop`. The next run of the same PR does this itself. Otherwise `npx tsx scripts/logseq-instance.ts status` in the worktree shows it, and a second LogSeq app on its own profile can be quit by hand. Your own LogSeq is never touched.
- *`fixture_dirty`.* Something wrote to the committed fixture. Find out what before running again; never commit a change LogSeq made to it (`tests/integration/setup.md`).

## The host integration check at the gate (#648)

With `hostIntegration: 'auto'` the run checks the PR head on the host before it lets the maintainer's decision through. The check is the integration suite of `runHostIntegration` (#647), the rule for when it is needed and the `host/integration` commit status are `src/integration-policy.ts` (#646), and the workflow side is `src/workflows/host-integration.ts`, called from the hold loop of `src/workflows/decision.ts`. **The default is `off`: with the field absent or `off` no new activity is called and the run is what it was.**

**Turn it on.** `npm run run-issue -- --issue 123 --host-integration` sets `hostIntegration: 'auto'` in the run's input. It needs a worker polling the `host` queue (`HOST_TASK_QUEUE=host`, see "Host integration" above) on a machine with the LogSeq desktop app. Without one the check waits in the queue and the step ends at its 2 hour bound as `IntegrationTimeout`. It applies when the run waits for the decision (`awaitDecision` true, the default): with `awaitDecision: false` the run ends at the review loop and the check is not run.

**What it does, in order**, for the head the gate shows, once a review is on it and no thread is open (the head the review loop settled, or a later head a person reviewed):

1. `getHostIntegrationNeed`: the pure rule over the PR's changed files. A change under `src/`, `scripts/`, `tests/fixtures/` or `tests/integration/`, a `Cargo.*` file or the toolchain pin needs it, and so does a PR with more files than one call reads. `orchestrator/src/` is not `src/`. Only a boolean leaves the activity, never a path. If it is not needed the gate is as before and nothing is posted.
2. `getHostIntegration` for the head. A `success` already on it ends here: the suite is not run again, so a replay or a restarted run does not run it twice.
3. `postCommitStatus` `pending`, then `runHostIntegration` on the `host` queue (40 minute deadline, 50 minute backstop, two attempts, no retry of a test failure), then the result as the status: `pass` is `success`, `fail` is `failure`, and `conflict`, `fixture_dirty` and `setup_error` are `error`. The description is `<n> passed, <n> failed` or `no counts` (a conflict or a setup error ran no suite, so no counts are given).
4. Anything but `pass` stops the run for a person (below). No fixer is started.
5. The gate reads `getHostIntegration` for the gate's own head on every pass and holds unless it shows `success` (`gateClear` with its `hostIntegration` field). A status on another commit counts for nothing: after a push the new head has no status, so once a person has reviewed it the check runs again for that head (once per settled head, not after each fix push), and the old pass does not clear the gate.

A pass does not replace the maintainer: the decision comment, the merge and everything after it are as before. Nothing here merges, applies a label or resolves a thread.

**Stop reasons** (step `host_integration`; one keyed comment on the issue with the commit, the outcome word and the counts, no output of the suite):

| Reason | Status written | What happened | What to do |
|---|---|---|---|
| `IntegrationFailed` | `failure` | The suite ran and some tests failed | Fix the change in the PR (by hand: no fixer is started for it yet), push, then delete the run and start again. The new head is checked afresh |
| `IntegrationConflict` | `error` | The head does not merge onto its base, so no suite ran | Merge or rebase the base into the branch, push, then start again |
| `IntegrationFixtureDirty` | `error` | The suite ran but changed the committed fixture graph, so its result is not trusted | Find what wrote to `tests/fixtures/graph/` (never commit a change LogSeq made to it), then start again |
| `IntegrationSetupError` | `error` | The host could not set up or run the suite (fetch, install, build, instance start), or it produced no report | Read the host worker's log and "Host integration" above, fix the host, then start again |
| `IntegrationTimeout` | `error` | The activity hit its bound (heartbeat, deadline or the 2 hour step limit), or no host worker took it | Check that the host worker is running and LogSeq is installed, then start again |

To start again after a stop, delete the closed run and start it ("Recovering a stuck run"). The restart finds the open PR, and the head is checked again unless it already shows `success`.

**What it does not do.** Run the suite anywhere but the host, send a failure to a fixer (open question 4 of #643), post or log any output beyond the counts, or change the default to `auto` (a later change, after one real run). **UNVERIFIED:** a real run needs LogSeq and the host worker, and the tests use fakes for both.

## Remote sessions (#672)

`runRemoteSession` (`src/activities/remote-session.ts`) runs one implementer, reviewer or fixer as a **remote Claude Code session**, started by firing a routine (`POST /v1/claude_code/routines/{id}/fire`, a bearer token per routine, one routine per role, `src/routine-fire.ts`). The brief built by `brief.ts` goes in the per-run `text` (at most 65,536 characters; a longer brief is refused, never cut) and is data to the session. The review loop calls it for the reviewer when a run has `executor: 'remote'` ("The remote reviewer" below), and the implementer step of a `remote` run calls it (#673, through `runRemoteImplementerSession`); and the fix step of the loop calls it for the fixer (#675, "The remote fixer" below). It is registered only when the six `REMOTE_ROUTINE_*` variables are set, so a worker without them is exactly as before.

A remote session cannot be stopped or messaged from the workflow, and the fire call is not idempotent (each success makes a session). So the activity, in order:

1. **Parses** `{ role, issue, pr?, branch, base, headSha?, brief, attempt? }` (`src/remote-session-policy.ts`). The reviewer and the fixer need `pr` and `headSha`.
2. **Reads its marker** in the repo's git config, `orchestratorremote.<issue>-<role>-<head>[-a<attempt>].state` (`<head>` is `none` for the implementer; the `-a<attempt>` part is absent for attempt 1, the default, so it is the key of #672). `fired <id> <ms>` means the session exists: nothing is launched, the call waits for it again and returns the same `sessionId`. `firing` means an earlier attempt may have made a session whose id was lost: GitHub is watched for up to 10 minutes for its work before another is fired.
3. **Claims.** The implementer launches only when the issue has no open PR and no `claude/<n>` branch. The fixer and reviewer launch only when the one open PR is theirs, the one branch is theirs and its tip is `headSha` (the reviewer also only when that head has no review yet). Otherwise the result is `failed` with `claim` set (`open_pr`, `branch_exists`, `branch_moved`, `already_reviewed`) and nothing is launched.
4. **Writes `firing`, fires, records `fired <id> <ms>`** before the wait begins.
5. **Waits** by reading GitHub every 30 seconds, with a heartbeat and a one hour cap counted from the recorded start (a restart does not extend it). The implementer and fixer are done when the branch tip differs from where they started, has not moved for 3 minutes and has no check pending. The reviewer is done at the first of two end signals, both read on the same 30 second schedule: a trusted review with a body on `headSha`, or (when the input carries `findingsMarker`, #682) a comment of a trusted author on the PR whose first line is that marker, the keyed findings comment of "The remote reviewer". The marker is checked against `findingsMarker` in `src/findings-comment.ts`, and the same trusted-author and first-line rule decides which comments count (`hasFindingsComment`), so a forged comment from anyone else never ends the wait. The wait reads and never posts. Nothing the session says is read, and the comment's text is not parsed here: it only ends the wait, and the reviewer step parses it afterwards. A cap returns `timed_out`. For the reviewer, `finished` means one of those two signals is present, not that the session posted a review: the session posts as the maintainer's account, so a human review on that head ends the wait early too (the claim already refuses a head that was reviewed before the call).

**Result:** `{ outcome: 'finished' | 'timed_out' | 'failed', sessionId?, headSha?, claim?, failure? }`. `sessionId` is absent when none is known (a claim, a failed launch, work found after a lost id).

**Fire errors.** 400 and 404 stop for a person (`RoutineRejected`, not retried, marker cleared). 401 and 403 are a token problem (`RoutineAuth`, same). 429 waits for `Retry-After` when it is at most 2 minutes and the budget of 3 calls per attempt allows, else returns `failed` with `failure: 'rate_limited'` (no session was made, marker cleared). 5xx retries with a 2 s then 4 s backoff within the budget, then `failed` with `server_error`. A timeout or an unreadable answer is not retried (a session may exist), returns `failed` with `network`, and leaves `firing` behind, so the next call watches GitHub first.

**The real ceiling on fire calls.** 3 per activity attempt, and the activity retries at most twice in all (`maximumAttempts: 2`), so at most 6 calls for one issue, role and head. Reaching it takes a crash, or a 5xx that came after a session was made (the in-attempt retry does not watch GitHub first).

**Setup (maintainer, once).** Create three routines (implementer, reviewer, fixer) at claude.ai/code/routines whose saved prompt says to read the routine-fire payload and do exactly the task it describes, following the repo skills. Add an API trigger to each, generate a token, and put the three ids and three tokens in the worker's environment. Tokens are shown once. Generating a new one revokes the old one. The fire endpoint is experimental. Limits: 30 fires per hour per routine and 100 per hour per account.

**Recovering from a stopped or stuck remote session.** A session cannot be stopped from here: open it at claude.ai/code (the id is in the worker's log line `remote session <id> fired ...`) and stop or delete it by hand.
- *A new attempt for the same issue, role and head.* A `fired` marker is never cleared, and nothing clears it. The maintainer's decision (2026-10-18): the key carries an **attempt number**, `(issue, role, head, attempt)`. The same attempt, repeated, re-attaches to its session (a retry of one call never fires twice); a higher attempt is a new key and fires a new session. Attempt 1 is the default and has the key of #672. The workflow owns the counter and passes it (the remote implementer does, "The remote implementer" above); for a manual call, give `attempt`. A past attempt's marker stays: it records which session that attempt launched.
- *The session ended with no push.* The wait returns `timed_out` after the cap. The workflow's second attempt fires a new session by itself. To fire one by hand, unset the marker (`git config --local --unset orchestratorremote.<issue>-<role>-<head>.state`, with the `-a<attempt>` part when it is not attempt 1) or call again with the next `attempt`.
- *A `firing` marker and no session exists* (the call failed after the marker). The next call watches GitHub for 10 minutes and then fires again; or unset the marker to fire at once.
- *A session you do not want to continue.* Stop it at claude.ai/code first. A push it makes later moves the head, which the head checks of the workflow already handle.
- *`MalformedMarker`.* Something other than this code wrote the key. Look at it with `git config --local --get-regexp '^orchestratorremote\.'` and unset it.

**Not verified.** No real fire has been made: the first acceptance item of #672 is a live no-op fire by the maintainer once the tokens exist, and the result is recorded on the issue. Until then the activity is tested against a fake fire client and fake GitHub reads only.

## The remote reviewer (#674)

With `executor: 'remote'` the review step of the loop (`src/workflows/review-loop.ts`) runs the reviewer as a **remote session** through `runRemoteSession` (role `reviewer`, used as it is) and posts the review itself. A remote session cannot hand text to the worker, and a review it posted itself would skip the sanitiser, so it writes its findings as JSON into **one keyed comment**, and the worker parses, cleans and posts them (plan #643, open question 3, option b). The local path (`executor: 'local'`, the default) is untouched. The implementer (#673) and the fixer (#675) are remote too.

**Per round, in order** (`runRemoteReviewerSession`, `postRemoteSessionReview`, `minimizeFindingsComment` in `src/activities/review.ts`):

1. The activity builds the brief (`buildRemoteReviewerBrief`, `src/brief.ts`: the issue and threads as data, the marker, the one-comment rule; a brief over 65,536 characters is `BriefTooLarge`) and calls `runRemoteSession` with the PR, the branch and the head. A launch that failed or a claim that refuses (`open_pr`, `branch_exists`, `branch_moved`) stops the run as `RemoteSessionFailed` with the fixed word in the message. `already_reviewed` is not a stop: the comment is what counts.
2. It reads the PR's comments and `parseFindingsComment` (`src/findings-comment.ts`) picks the findings. **The findings comment** starts with this line alone, naming the PR, the exact head and the round, then holds exactly one fenced `json` block of the shape the local reviewer's file has (`summary`, `findings` of `path`, `line`, `body`, `acceptedThreadIds`):

   ```
   <!-- orchestrator-findings pr=<pr> head=<40 hex> round=<n> -->

   ```json
   {"summary": "...", "findings": [{"path": "a.ts", "line": 12, "body": "..."}], "acceptedThreadIds": []}
   ```
   ```

   A reviewer that finds nothing writes `"findings": []`, which is accepted.
3. The parsed findings are staged (a file in the repo's git directory, `orchestrator-remote-review-<pr>-r<round>-<head12>.json`) and the round's marker `orchestrator.remote-reviewer-<pr>-r<round>-<head12>` is set to `success`. Only counts, thread ids and the comment's node id reach the workflow history.
4. `postRemoteSessionReview` posts the staged findings through the same `postFindings` the local path uses: placed against the diff of the head, cleaned by `sanitiseText`, one `COMMENT` review bound to the reviewed head, keyed so a retry posts once.
5. `minimizeFindingsComment` hides the raw comment (`minimizeComment` with the classifier `OUTDATED`, idempotent). It runs after the review is posted, with the GitHub activity timeouts and attempts. If it fails the run goes on: it is counted in the result (`rawCommentsNotHidden`, present only for `remote`) and said once on the issue (key `findings-not-hidden-<pr>-r<round>`, identifiers only).

**Trust.** The comment is untrusted input. Only a comment whose author association is `OWNER`, `MEMBER` or `COLLABORATOR` is read: the listing leaves an other author's body empty, and the parser ignores such a candidate again. Marker text from anyone else is data, including a copy of the marker in a longer comment or a marker for another head or round.

**Stop reasons** (one comment on the issue, keyed by step and reason, a Failed run, nothing posted; counts only, never the comment's text):

| Step and reason | Meaning | What to do |
|---|---|---|
| `review_session` `MalformedFindings` | No trusted comment carries the marker, more than one does, the comment has no or more than one `json` block, or the JSON is not in the asked shape | Look at the PR's comments. The review loop cannot be resumed (see "The review loop"): finish the PR by hand |
| `review_session` `FindingsTooLarge` | The comment is over 66,000 characters, or the findings are over a bound (30 findings, 3000 characters per body, 4000 for the summary, 64,000 bytes of JSON) | The same |
| `review_session` `RemoteSessionFailed` | `runRemoteSession` launched nothing: a claim (`open_pr`, `branch_exists`, `branch_moved`) or a launch failure (`rate_limited`, `server_error`, `network`) | See "Remote sessions" for each; then delete the run and start again |
| `review_session` `BriefTooLarge` | The brief does not fit a routine's text | Shorten the issue or the threads |
| `review_session` `RemoteExecutorUnavailable` | The worker has no remote session activity (the six `REMOTE_ROUTINE_*` variables are unset) | Set them, or run with `--executor local` |
| `review_post` `DiffUnreadable` | The head is not in the working copy or the diff cannot be read, and there are findings to place | Fetch the branch and look |

**The wait.** `runRemoteSession` ends a reviewer's wait on the keyed findings comment of this head and round as well as on a trusted review with a body (#682, "Remote sessions"), so a reviewer that posts its comment is read within about one poll (30 seconds), not after the one hour cap. The input field `findingsMarker` carries the marker. **Known limit:** `runRemoteReviewerSession` (`src/activities/review.ts`) does not pass `findingsMarker` yet, so until it does (a one line change, left to the change that owns that file) this reviewer's wait still runs to its cap and returns `timed_out`; the comment is read after any outcome that launched, so the result is correct but slow.

**Not verified.** No real remote session, no real routine and no real `minimizeComment` call have run: the activities are tested against a fake `gh`, a fake `runRemoteSession` and a Temporal dev server with fake activities.

## The remote fixer (#675)

With `executor: 'remote'` the fix step of the loop (`remoteFixRound` in `src/workflows/review-loop.ts`) runs the fixer as a **remote session** through `runRemoteSession` (role `fixer`, used as it is). The local path (`executor: 'local'`, the default) is untouched: `runFixerSession`, `guardBranch`, `pushBranch` and `postFixerReplies` run in the order they always did. A remote fixer **pushes its own fix commits to the PR's branch**, and a push to an open PR's branch moves the PR's head at once. The worker cannot delete or reset that branch (the #645 spike), so the order is not the local one:

1. `runRemoteFixerSession` (`src/activities/review.ts`) builds the brief (`buildRemoteFixerBrief`: the actionable threads as data, the marker, the one-comment rule, the push rules) and calls `runRemoteSession` with the PR, the branch, the head and `attempt` = round + 1. The attempt is part of the session's marker key, so a new round on a head that did not move fires a new session, and a retry of the same round re-attaches to the one it fired. A launch that failed or a claim that refuses (`open_pr`, `branch_exists`, `branch_moved`) stops the run as `RemoteSessionFailed`. A cap reached with a tip that had not rested stops it as `RemoteSessionTimedOut`: the session may still push.
2. It reads the PR's comments and `parseFixerRepliesComment` (`src/findings-comment.ts`, the parser the reviewer's findings use) picks the replies. **The replies comment** starts with `<!-- orchestrator-fixer-replies pr=<pr> head=<40 hex> round=<n> -->` alone on the first line (the head the round started from), then holds exactly one fenced `json` block of the shape the local fixer's file has (`{"replies": [{"threadId": "...", "body": "..."}]}`, at most 50 replies of 3000 characters). The replies are staged in the repo's git directory (`orchestrator-remote-fixer-<pr>-r<round>.json`) and the marker `orchestrator.remote-fixer-<pr>-r<round>` is set to `success`. Only the tip, a count and the comment's node id reach the workflow.
3. If the tip moved, **`guardRemoteBranch` runs on the fetched tip** (the same fetch-then-guard as the remote implementer: HISTORY and NET ranges, the tip must be the one the session reported before and after). A pass makes the tip the loop's head.
4. `postRemoteFixerReplies` posts the staged replies through the same code as the local replies (same keys: `reply-r<round>-<thread>`, each once, only in a thread that is open, trusted and not accepted), then `minimizeFindingsComment` hides the raw comment (best effort, counted in `rawCommentsNotHidden`).
5. The loop goes back to the review, which reviews the new head with a fresh session. That review is the closing review the gate needs, as for a local fix.

**A guard refusal cannot un-push.** A protected path, an empty or oversized diff or a special file in the fix commits stops the run with the new stop reason **`FixerPushRejected`** at `fix_guard`: one keyed comment on the issue (`stopped-fix_guard-FixerPushRejected`) with the reason class and the counts line only, never a path. Nothing else is posted for that head: no review, no reply. The worker deletes nothing and resets nothing; the raw comment is hidden. **The branch is left as the session pushed it** (the PR shows the new commits) for a person to look at and to reset to the last reviewed head. A guard failure that is not a refusal (`BranchMoved`: the branch moved again after the session reported its tip, or `BranchMissing`, or a failed read) says nothing about the diff, so it stops with its own reason at `fix_guard` and is not called a rejection.

**No progress.** A fixer that pushed nothing (the wait runs to its cap and returns `timed_out` with no tip), or pushed only to a branch other than the PR's, leaves the head where it was. That is handled as a local fixer that made no commit: no guard, the replies are posted, the round counts, and the loop reviews the same head again with a new round. `maxFixRounds` and the loop timer count every remote round, so a fixer that never makes progress ends the run as `MaxRoundsReached`. The replies comment is required even then: a fixer that pushed nothing and posted no comment stops the run as `MalformedFindings` at `fix_session` (an empty `replies` list is a valid comment). The guard checks the pushed commits against the base, not that the old head is an ancestor of the new tip; the brief forbids force-pushes and the next review sees the new head (a possible follow-up). A branch other than `claude/<n>` that the fixer made is a claim against the next round (`branch_exists`, so `RemoteSessionFailed`).

**Trust.** As for the reviewer: only a comment by an OWNER, MEMBER or COLLABORATOR is read, and the marker has to be the comment's whole first line. A forged comment is ignored and cannot stop the real one; two trusted comments with the marker, none, a missing or second `json` block, a bad shape or a bound passed stop the run (`MalformedFindings`, `FindingsTooLarge`) with counts only. The replies are cleaned by the same sanitiser before they are posted.

| Step and reason | Meaning | What to do |
|---|---|---|
| `fix_guard` `FixerPushRejected` | The guard refused the fixer's pushed commits (protected path, empty or oversized diff, special file). The branch holds them | Read the PR's new commits, reset `claude/<n>` to the last reviewed head (the maintainer does it; the worker does not), then finish by hand: the loop cannot be resumed |
| `fix_guard` `BranchMoved`, `BranchMissing` | The branch is not at the tip the session reported, or is gone | Look at the branch; as above |
| `fix_session` `MalformedFindings`, `FindingsTooLarge` | The replies comment is missing, duplicated, malformed or over a bound. A fix may already be pushed and has **not** been guarded | Look at the PR's comments and new commits before anything else; as above |
| `fix_session` `RemoteSessionFailed`, `RemoteSessionTimedOut`, `BriefTooLarge` | No session ran, the cap passed with an unsettled push, or the brief does not fit a routine | See "Remote sessions"; as above |

**Not verified.** No real remote fixer, real routine or real push to GitHub has run. The tests (`test/remote-fixer.test.ts`) use the real review and branch activities over real git in throwaway repos with a local bare `origin`, a fake `runRemoteSession` that pushes from a second clone, fake GitHub reads and a Temporal dev server.

## GitHub activities (#628)

`src/activities/github.ts` holds the activities the workflow calls, built by `createGithubActivities(config)`: `listReadyIssues`, `readIssue`, `checkIssue`, `commentIssue`, `claimIssue`, `addToBoard`, `getBoardStatus`, `setStatus`, `openPr`, `postReview`, `getGateStatus` and, for the maintainer's decision (#631), `getPrState` (open, closed, merged: flags and the head SHA), `getPrChanges` (counts of golden, ceiling, ADR and business-rule files a PR changes, no paths) and `closeIssue` (closes an open issue of a trusted author as completed and reads it back). `checkIssue` is `readIssue` answered as numbers and flags (`{ number, open, trustedComments, droppedUntrustedComments }`), so the workflow can gate on an issue without the issue's text entering the stored history. `commentIssue({ issue, key, body })` posts one comment and a retry finds it by a hidden `<!-- orchestrator-comment:<key> -->` marker, looking only at comments of trusted authors (the same rule as `postReview`; it assumes this account's own comments count as trusted). Each is a thin wrapper over `gh` (`src/gh.ts`): one process per call, an argv array and never a shell string, a timeout (30 s) and an output cap, and an answer parsed at the boundary (`src/github-parse.ts`). A malformed answer fails with the path of the first mismatch, never a value and never a partial result.

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
| `src/brief.ts` | `buildBrief`: the implementer's brief, a pure function, and `briefCommands`, the commands it tells the session to run (checked against the tool lists by a test). Also `buildReviewerBrief` and `buildFixerBrief` (#630) |
| `src/workflows/review-loop.ts`, `src/gate.ts`, `src/review-policy.ts` | The review loop, the pure `gateClear`, and the loop's bounds (importable from workflow code) |
| `src/workflows/decision.ts`, `src/approval-types.ts`, `src/signal.ts` | The maintainer's decision (#631): the signal inbox, the wait and the merge watch; the payload, bounds, classifier and comment texts (importable from workflow code); the `npm run signal` CLI |
| `src/activities/review.ts`, `src/review-types.ts` | The reviewer, fixer and posting activities, and the parsing, bounds and sanitising of what the sessions write |
| `src/activities/branch.ts`, `src/branch-types.ts`, `src/diff-guard.ts` | `guardBranch` and `pushBranch` (the only push), their input parsing and bounds, and the pure diff guard |
| `src/activities/implementer.ts` | `runImplementerSession`: reads the issue, builds the brief and runs the session in one activity, so issue text stays out of the history |
| `src/activities/host-integration.ts`, `src/host-integration-policy.ts` | `runHostIntegration` (#647): the integration suite on a PR head, on the host only; its input, result, queue name and bounds (importable from workflow code) |
| `src/run-issue-input.ts` | `buildRunInput` (#671): the run input from the `run-issue` flags, testable apart from the script |
| `src/workflows/executor.ts` | `onExecutor` (#671): the one place the workflow chooses `local` or `remote` for a session |
| `src/workflows/host-integration.ts`, `src/integration-policy.ts` | The host integration check at the gate (#648): once per head, run, record, stop; the rule for when it is needed and the commit status (#646, importable from workflow code) |
| `src/workflows/remote-implementer.ts` | The implementer step of a `remote` run (#673): session, guard on the fetched branch, delete on refusal, the attempt counter |
| `src/activities/remote-session.ts`, `src/remote-session-policy.ts`, `src/routine-fire.ts` | `runRemoteSession` (#672): claim, marker, fire and bounded wait for a remote session; its input, result and bounds (importable from workflow code); the routine fire client |
| `src/findings-comment.ts` | `parseFindingsComment` (#674) and `parseFixerRepliesComment` (#675): the remote reviewer's and fixer's keyed comments turned into the local sessions' typed output |
| `src/workflows/failure-reason.ts` | The type word of a failed activity and the counts line of a guard refusal, shared by `issue.ts` and the review loop |
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

**The decision for the implementer session (#629), pending the maintainer's confirmation before the first real run.** Not `bypassPermissions`, and the workflow never sets `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS`. The default is the least permissive configuration `claude --help` (CLI 2.1.302) documents that lets an implementer edit files, commit and run the repo's checks:

- `--permission-mode acceptEdits`: file edits go through without a prompt.
- `--permission-prompts none`: anything that would prompt is denied at once instead of waiting for nobody, so a session cannot sit on a prompt until the timeout. A denied tool call is the session's to work around, or to report in its status comment; the run then stops at the `session` step with a comment if it ends without success.
- `--allowedTools=<comma list>` (`DEFAULT_ALLOWED_TOOLS` in `src/config.ts`): Read, Glob, Grep, Edit and Write; git in the worktree only by verb (`status`, `diff`, `log`, `show`, `rev-parse`, `add`, `rm`, `mv`, `commit -m *`); `npm ci` and the exact scripts `npm run typecheck`, `test:unit`, `test:github`, `test:workflow`, `test:server`, `test:crash`; `cargo build`, `test`, `fmt` and `clippy`; `shellcheck`; and `gh issue comment * --body *`. **No push of any kind**, no `git rebase` (`--exec`), no `git fetch` (`--upload-pack`), no `node`, no `npx`, no `npm exec`, no `gh issue view` or `gh pr view` (they would show the comments the brief left out), no `gh pr`, no `gh api`. It is passed as one `--allowedTools=...` argument so the variadic option cannot swallow the prompt that follows `--`.
- `--disallowedTools=<comma list>` (`DEFAULT_DISALLOWED_TOOLS`): deny beats allow, so these hold even when a settings file allows them: `gh api`, `gh pr`, `git push`, `gh issue comment` with `--body-file` or `-F`, WebFetch, WebSearch, **`git * --output*`** (`git diff`, `git log` and `git show` are allowed, and `--output=<file>` makes any of them write to any path; I read `git help diff` for it and the other allowed verbs for a write-anywhere or run-a-program option, and found only this one), **`git diff --no-index`** (it reads any two files into the session), and Edit and Write of the whole protected set below, generated from the same constants as the guard (`protectedDenyRules`), including **any `.git` directory** (hooks and config the worker's own git would run) and **`.mcp.json`**. The path syntax of those rules is unverified (see below), which is why `guardBranch` checks the same paths after the session and does not depend on them.
- `--setting-sources project`: the host user's own settings, allow rules and hooks do not load. The project's `.claude/settings.json` in the worktree does, and the session cannot edit it (denied above, and refused by the guard).
- `--strict-mcp-config` with no `--mcp-config`: no MCP server loads.

**This is risk reduction, not a sandbox.** The commands that run the repo's tests (`npm run test:*`, `cargo test`, `cargo build`) run whatever the repo's files say, as the worker's OS user, so a session that can run the tests can run arbitrary code. No pattern prevents that. `npm ci` runs the install scripts of the locked dependencies. `git diff --output=<file>` and `git log --output=<file>` write where they are told. Patterns for `Bash` rules are matched by the CLI in ways the maintainer has to confirm (see "Before the first real run"). So the boundary that actually holds is the account the worker runs as:

- **Run the worker as a dedicated OS user** that has no access to personal files, no other repositories, no SSH keys, no cloud credentials and no browser profile. Its home directory holds only what the worker needs.
- **Give that user a narrowly scoped `gh` token**: this repository only, with the `repo` and `project` scopes the activities need (a fine-grained token for one repository where the board's scope allows it), never the maintainer's own login. Nothing in the workflow merges or labels, but a session that escapes its rules can do whatever the token can.
- Change the settings with `CLAUDE_PERMISSION_MODE`, `CLAUDE_PERMISSION_PROMPTS`, `CLAUDE_ALLOWED_TOOLS` (a list replaces the default), `CLAUDE_DISALLOWED_TOOLS` (added to the default) and `CLAUDE_SETTING_SOURCES`.

### The protected set

The principle (`src/diff-guard.ts` has it in full, and `protectedDenyRules` turns it into the file-tool deny rules): a session may change the feature, meaning the source, the tests and the docs it was asked to change. It may not change anything that decides how code is built, run, tested, released or permitted, because the next command executes it with more reach than the session has. A path is protected when it is

1. **executed by an allowed command, the worker or CI**: `package.json`, `package-lock.json` and `npm-shrinkwrap.json` at any depth (the allowed `npm run` and `npm ci` run them), `build.rs`, `scripts/`, `.husky/`, `.githooks/`, `.pre-commit-config.yaml`, and `vitest`, `vite`, `jest`, `webpack`, `rollup` and `esbuild` configs (JavaScript that runs);
2. **a configuration for git, npm, cargo, node or claude**: `.npmrc`, `.cargo/`, `Cargo.toml` and `Cargo.lock`, `rust-toolchain*`, `.gitattributes`, `.gitmodules`, `.gitignore` (it decides what `git add` skips), `.mcp.json`, `.claude/`, `CLAUDE.md` and `CLAUDE.local.md` at any depth, anything under a `.git` directory, `.env*`, `.eslintrc*`, `.babelrc*`, `.mocharc*`, `.devcontainer/`, `.vscode/`, and keys and databases (`.pem`, `.key`, `.p12`, `.sqlite`);
3. **CI, release or a rule CI enforces**: `.github/`, `CODEOWNERS`, `.claude-plugin/` (its entry runs the launcher for users), `pypi/` (release packaging), `about.toml`, `about.hbs`, `Makefile`, `Dockerfile*`, `docker-compose*`, `docs/adr/`, `docs/business-rules/`, `tests/guards/`, `tests/rust-guards/`;
4. **the orchestrator itself**: all of `orchestrator/src/` (it decides what the next session may do), and its `package.json`, lockfile and `.npmrc` by the rules above.

Paths are normalised before they are compared (`docs/./adr/x`, `docs//adr/x`, `src/../.github/x`, a backslash as a separator), and compared in lower case. A path outside the work tree is refused. A branch is also refused as `SpecialFile` when any commit adds, changes or removes a symlink, a submodule or a file mode (anything but a plain `100644` file, so a new executable or a flipped executable bit too): a link can point a later write into a protected place.

**What this means, stated plainly: an issue that must change `package.json` or another manifest, a lockfile, a build file, a script, CI, the ADRs or business rules, `CLAUDE.md`, or the orchestrator itself (so #630 and #631 too) cannot be implemented by the orchestrator, and needs a human. That is by design for now.** Dependencies are on the list because foundations 7 asks for a verified, maintained dependency, and a person does that. The list can be narrowed once the first runs behave; a change to it is a change to `src/diff-guard.ts`, which is itself protected.

The commands that run the tests still execute the session's feature code: no path list prevents that. That is the dedicated OS user's job.

### Verify before relying on it

The prompt is passed as `claude -p --output-format json --permission-mode m --permission-prompts p --allowedTools=<list> --disallowedTools=<list> --setting-sources project --strict-mcp-config -- <prompt>`.

- **Checked by the maintainer on Claude Code 2.1.302 (recorded for #627):** `claude -p -- "reply with ok"` answered `ok`, and `claude -p -- "--version"` treated the text as the prompt and did not parse it as a flag. So `--` ends option parsing, and a prompt that starts with a dash is safe.
- **Checked for #629, without calling the model:** `claude --help` lists `--permission-mode`, `--permission-prompts` (`host` or `none`), `--allowedTools`, `--disallowedTools`, `--setting-sources <sources>` (comma-separated, `user`, `project`, `local`), `--strict-mcp-config` ("only use MCP servers from `--mcp-config`") and `--mcp-config`. The exact argv the activity builds from the default config (13 arguments, with no prompt and no stdin) was accepted by the option parser and stopped at "Input must be provided" before any model call.
- **Not established from `claude --help` alone:**
  - how the comma-joined `--allowedTools=...` and `--disallowedTools=...` values are split into rules, patterns with spaces, `*` and `**` included;
  - how a `Bash(...)` pattern matches a command: whether `Bash(git status)` and `Bash(git status *)` are both needed, whether `*` crosses a quote or a `&&`, and whether a command chained with `;`, `&&` or `$(...)` is matched as a whole or by its parts;
  - the path syntax of `Edit(...)` and `Write(...)` deny rules (`.github/**`, `CLAUDE.md`, `.env*`), and whether they apply to every file tool;
  - whether `--setting-sources project` really leaves out the host user's allow rules and hooks, and whether `--strict-mcp-config` with no config loads no server;
  - what a denial looks like to the session, and whether `--permission-prompts none` denies at once or ends the session;
  - **whether the bare `Edit` and `Write` allow rules reach outside the worktree.** Under `acceptEdits` a write outside the working directory should not be approved without a prompt, but that was not checked. If it does reach out, a session could write the main checkout's `.git/config` or `.git/hooks`, and so redirect or run code in the worker's own git calls (the push turns hooks off for itself, but `git diff`, `git log` and `git rev-parse` in the guard do not). The drill tests it (step 3, last item), and the deny rule for any `.git` directory is a second line, not a proof;
  - whether `Bash(git * --output*)` also matches `git log --output=x` with the option anywhere on the line, and whether a bare `*` between `git` and `--output` matches a verb;
  - **that every command the brief names is matched by its allowed rule in a real session.** A test checks the brief and the lists against a model of the rules, and that is all it proves. Until the maintainer's permission drill below, real-session matching of these patterns is UNVERIFIED.
- No real session was run with these flags.

### Before the first real run

A checklist for the maintainer, by hand, in a scratch repository with a local bare origin, never in this repository and never with a real `gh` token. Nothing here needs the model unless it says so.

1. **Make the scratch repo.** `git init --bare origin.git`, `git clone origin.git scratch`, one commit on `main`, `git push origin main`, `git checkout -b claude/1`. Run the rest from `scratch`. Use the OS user the worker will run as.
2. **Start an interactive `claude` there with the exact flags the activity builds.** `--permission-mode acceptEdits --permission-prompts none --allowedTools=<DEFAULT_ALLOWED_TOOLS joined with commas> --disallowedTools=<DEFAULT_DISALLOWED_TOOLS joined with commas> --setting-sources project --strict-mcp-config` (without `-p`; print the lists with `node --import tsx -e` against `src/config.ts`, or copy them from the source). Open `/permissions` and check how the two lists were split into rules: each rule on its own, patterns with spaces intact. Note what `/permissions` shows and what it does not. This is the one check that needs no model call.
3. **Try these, and expect each to be denied** (this calls the model, and the denial is what you are looking for): `git push origin claude/x:main`, `git push --delete origin claude/1`, a Write of a file outside the scratch repo, an Edit of `.github/x`, an Edit of `package.json` and of `.mcp.json`, `git log --output=/tmp/out.txt`, `git diff --no-index /etc/hosts /dev/null`, `node -e "1"`, `npx cowsay hi`, `gh api user`, `gh pr merge 1`, a Skill invocation, a read of an issue with `gh issue view 1`. For each, write down what the denial looks like in the output and whether the session carried on or stopped. **Then test whether a write reaches outside the worktree**, because everything above assumed it does not: from a worktree of the scratch repo (`git worktree add ../wt -b claude/1`), start the session in `../wt` and ask it, one request each, to Write `../outside.txt`, to Write `<scratch>/.git/hooks/pre-commit` and `<scratch>/.git/config` (the main checkout's, which a worktree shares), and to Edit `<scratch>/README.md` from the worktree. Every one of those must be denied. If any succeeds, the bare `Edit` and `Write` allow rules are too wide: replace them with path-scoped rules (`Edit(src/**)`, `Edit(tests/**)`, `Edit(docs/**)`) in `CLAUDE_ALLOWED_TOOLS` before any real run, and treat the `.git` deny rule as unproven.
4. **Confirm the forms the brief uses work:** `git add <path>` then `git commit -m "subject" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"` (no heredoc, no command substitution), and `gh issue comment 1 --body "text"` (point `gh` at a throwaway repo, or put a fake `gh` first on PATH that records its argv), `npm run typecheck` and `cargo test --locked` in a repo that has them. Check that a commit with quotes, a `$` or a backtick in the message is handled the way the brief says (it tells the session to avoid them).
5. **Check the protected paths twice:** the deny rules (step 3 shows whether `Edit(.github/**)` and `Edit(**/package.json)` are refused) and the guard. For the guard, make two commits on `claude/1`, the FIRST touching `package.json` and the second an ordinary file, and run `guardBranch` against it with `node --import tsx` (it must refuse as `ProtectedPath`, with a count and no path); then a branch whose first commit adds `.env` and whose second removes it (still refused); then a clean branch of two commits (it must pass). `test/branch.test.ts` does the same on throwaway repos.
6. **Kill the worker mid-session.** Start the dev server, the worker with `CLAUDE_BIN=<repo>/orchestrator/test/fake-claude.sh` and `FAKE_CLAUDE_MODE=slow FAKE_CLAUDE_SLOW_SECONDS=60`, and a fake `gh` (`ORCHESTRATOR_GH_PATH`) from the tests, then `npm run run-issue -- --issue <n>`. While the fake session sleeps, `kill -9` the worker, start it again, and watch: the run must stop at the `session` step with the reason `SessionInterrupted` and one comment, with one line in the fake's invocation log, never a second session.
7. **The review sessions (#630).** In the same scratch repo, with a `claude/1` worktree and a detached worktree: start the reviewer with its flags (`reviewerAllowedTools` in `src/activities/review.ts` instead of the default allowed list) and check that `Write(/review-findings.json)` lets it write that one file and nothing else, that it cannot commit, run `npm`, or call `gh`, and what a denial looks like. Check that the fixer's `fixer-replies.json` does not show in `git status` (`.git/info/exclude` of the shared repo) and that it is not picked up by `git add <path>`. Check that a committed `review-findings.json`, or a link of that name, in the PR's tree does not survive into the session (the activity removes it after `git worktree add`), and whether `Write(/review-findings.json)` writes through a link.
8. **A real run, watched, on a throwaway issue** in a throwaway repository, with a fine-grained token for that repository only: read the status comment and the denied calls it reports, then widen or narrow `CLAUDE_ALLOWED_TOOLS` from what you saw.

9. **The host integration activity (#647), once by hand on a small PR.** On the Mac, with LogSeq installed: start `HOST_TASK_QUEUE=host npm run worker`, start `runHostIntegration` on the `host` queue for a small open PR (`temporal workflow start` of a one-activity workflow, or a throwaway client), and wait for the result. Check that it is `pass` with plausible counts, and that `git status` in your working copy is clean (and that the worktree under the temp directory and the instance are gone). Then kill the worker with `kill -9` while the suite runs, start it again, run the same PR once more, and check that the stale instance and worktree were cleared first. Last, send `SIGTERM` (Ctrl-C) while the suite runs and note whether the instance and worktree were cleaned up before the process exited; write the result here. If creating the host worker fails (for example a bad namespace), the worker closes its connection and reports that error; this path has no test, since it needs a live server.

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
