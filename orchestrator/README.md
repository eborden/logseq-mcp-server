# Orchestrator

A Temporal-based orchestrator for the issue-to-PR loop (parent plan #625). It lives beside the Rust server and has its own `package.json`, lockfile and `tsconfig.json`, so Temporal's dependencies stay out of the root tooling. Nothing here is part of the MCP server.

The first slice (#626) proved the engine runs here and survives a crash (`helloWorkflow`, kept as the engine check). `IssueWorkflow` (#629) is the first real workflow: it takes one Ready issue to an open PR that is In review on the board, and (#630) reviews that PR, runs a bounded fix loop and stops at "gate clear, waiting for the maintainer". See "IssueWorkflow" and "The review loop" below.

## What v1 does not do

- Nothing that waits for the maintainer's decision, watches for the merge, or closes out the issue and the PR (#631). A run ends at "gate clear, waiting for the maintainer" (or at "waiting for threads to be resolved by the maintainer"), and the merge is always the maintainer's.
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
| `ORCHESTRATOR_ALLOW_BYPASS_PERMISSIONS` | unset | `runClaudeSession`; must be `yes-skip-all-permission-checks` for `bypassPermissions` to be accepted. Never set it for the workflow |

There are no secrets. Workflow history is stored, so a run carries identifiers only, never graph data (BR-0001).

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

After step 8 the run goes on with the review loop (below). Its result is `{ outcome: 'gate_clear', ... }`, `{ outcome: 'waiting_for_threads', ... }` (both from the review loop) or `{ outcome: 'skipped', issueNumber, reason }`. A run that needs a person ends as a Failed workflow of type `IssueStopped` with the step and the reason as its details, after one comment on the issue (see "Recovering a stuck run").

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
- **Bounds.** The whole run is limited to 8 hours (the workflow execution timeout), and each step, retries included, to 2 hours (`scheduleToCloseTimeout`). A step that hits its bound stops the run as `ActivityTimeout`. `runImplementerSession` has its own start-to-close of 75 minutes (`IMPLEMENTER_START_TO_CLOSE_MS`): the read of the issue can wait out three rate limits of ten minutes before the session starts, and the session has its own 30 minute limit, so the two cannot share the session activity's 35 minutes. The guard and the push have 5 minutes each (`BRANCH_ACTIVITY_OPTIONS`).
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
| `session` `BriefTooLarge`, `InvalidState` | The issue and its comments do not fit a prompt, or the issue is closed | Shorten the issue, or leave it closed |
| `guard` `ProtectedPath`, `SpecialFile`, `DiffTooLarge`, `EmptyDiff` | Some commit of the branch changes a protected path or a symlink, submodule or file mode, or the branch changes more than 300 files, or nothing. Nothing was pushed. The comment has counts only | Look at `git log --raw origin/<base>..claude/<n>` in the worktree. If the change is wanted, make it yourself in a PR you write; to run the issue again, delete the branch ("Recovering a stuck branch"), then the run |
| `push` `PushRejected`, `BranchMoved` | The remote refused the push (for example `claude/<n>` already exists with other history), or the branch is not at the commit the session ended at | Look at the remote branch and the local one, fix or delete the one that is wrong, then delete the run and start again: the finished session is not run again |
| `open_pr` any | The branch was pushed but the PR was not opened (GitHub refused it, or failed after its retries) | Open the PR by hand or delete the run and start again: the finished session is not run again, the guard and the push repeat as no-ops |
| `board_pr`, `board_issue` | The PR is open but the board did not show the move. The comment names the PR | Move the item by hand if you must, or delete the run and start again: the restart finds the open PR and writes only what is missing |
| `review_session`, `fix_session` `SessionError`, `SessionInterrupted`, `SessionTimeout`, `MalformedResult` | A reviewer or fixer session failed or never finished. Its marker holds the state | The loop cannot be resumed: finish the PR by hand ("The review loop", Recovering) |
| `review_session`, `fix_session` `MalformedFindings`, `FindingsTooLarge` | The session's file was refused (see "The review loop"). Nothing was posted | Read the file in the review worktree, then finish the PR by hand (a restart skips the loop) |
| `review_post`, `threads`, `fix_reply` any | GitHub refused the review (for example an inline comment on a line the diff does not change, which GitHub rejects) or the reply, or failed after its retries | Read the worker's log and finish the PR by hand: a restart skips the loop |
| `fix_guard`, `fix_push` any | As `guard` and `push` above, for the fixer's commits | As above, on `claude/<n>` |
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
| `gate_clear` | A review on the head, no unresolved thread. The run is **waiting for the maintainer**. Result: the PR, the head, the number of fix rounds, the reviews on the head |
| `waiting_for_threads` | Every open thread is one the reviewer accepted a reply on (`acceptedThreadIds`) or one the loop may not act on (an untrusted author's). The run says so in one comment on the issue and ends. **Only a person resolves a thread, so the gate stays not clear until the maintainer resolves them.** After that, the gate is clear (a review is on the head) |
| stopped, `review_loop` `MaxRoundsReached` | Threads were still open for the fixer after `maxFixRounds` rounds. One comment, a Failed run, the PR is the maintainer's |
| stopped, `review_loop` `ReviewLoopTimeout` | The loop took longer than `reviewLoopTimeoutMs` (default 4 hours): the running step is cancelled (its session is stopped), one comment, a Failed run |
| stopped, `gate` `ReviewNotCounted` | No thread is open yet no review counts on the head (a review that landed on another commit, or was not counted). Looping would post review after review, so a person looks |
| stopped, `gate` `HeadMismatch` | GitHub did not show the head the loop pushed, after 3 reads |
| stopped at `review_session`, `review_post`, `threads`, `fix_session`, `fix_guard`, `fix_push`, `fix_reply` | A step failed: one comment keyed by step and reason, a Failed run, as in the first half |

**Why the workflow does not resolve threads.** The issue's first draft had the reviewer session resolve the threads it accepts. Sessions are denied `gh api`, and the loop does not loosen that to give them a GraphQL mutation, so nothing in the orchestrator resolves a thread. The reviewer records the threads it accepts in its output, the workflow carries those ids in its result, and a person resolves them. This is an **open question for the maintainer** (below): if a run should clear its own gate, that needs a decision about who may resolve a thread and with which token.

**Bounds** (all in `src/review-policy.ts`, importable from workflow code; the numbers are assumptions for the maintainer to confirm):

- `DEFAULT_MAX_FIX_ROUNDS = 3`. The input may set `maxFixRounds` (1 to 10).
- `DEFAULT_REVIEW_LOOP_TIMEOUT_MS = 4 hours` for the whole loop, enforced by a cancellable scope in `issue.ts`. The input may set `reviewLoopTimeoutMs` (1 second to 6 hours; the small values are for tests). The whole run is still limited to 8 hours.
- Each step, retries included, 2 hours (`ISSUE_STEP_TIMEOUT`); the reviewer and the fixer activities have the implementer's 75 minutes (`REVIEW_SESSION_ACTIVITY_OPTIONS`), with 3 attempts. A session is never run twice: its marker in the repo's git config (`orchestrator.reviewer-<pr>-r<round>`, `orchestrator.fixer-<pr>-r<round>`: `started`, then `success` or `error`) turns a retry into the finished result, `SessionInterrupted` or `SessionError`, and these are not retried.
- The thread list, the gate and the posting use the GitHub activity timeouts and 3 attempts.

**What comes back from a session is untrusted output.** The reviewer's and the fixer's files are read by the activity at the boundary (`src/review-types.ts`): a file that is missing, not a plain file (a symlink is refused), over 64000 bytes, not JSON, or not in the asked shape (at most 30 findings, 50 replies, 3000 characters per comment, 4000 for the summary, a relative path with no `..`, a positive line, thread ids of a fixed alphabet) is **refused whole, never cut**, as `MalformedFindings` or `FindingsTooLarge`, and the run stops. What passes is sanitised before it is posted: control and reordering characters removed, `<!--` and `-->` written as entities (so text cannot forge the hidden idempotency markers), every `@name` mention broken with a zero-width space (in a code span too), HTML closed (`<` becomes `&lt;`), link and image targets cut off from their text, raw URLs and `www.` no longer autolinking, and the "suggestion" code block made inert. Review and reply text never reaches the workflow: the activities return counts, thread ids and review ids, and the history tests scan every string of a finished and of a failed run.

**Trust.** Only an OWNER, MEMBER or COLLABORATOR's text reaches a brief. A thread whose first comment is by anyone else is left out and counted; a comment by anyone else inside a trusted thread is dropped. The comments that remain may have been written by an earlier session (a review comment, a fixer reply); the briefs say so, and quote and escape them as data in one tagged block (`<thread-data>`), so they cannot be read as instructions.

**What the sessions may do** (README, "Permission modes", for the mechanism; both are unverified until the maintainer's drill):

- The reviewer (`reviewerAllowedTools`): Read, Glob, Grep, read-only git (`status`, `diff`, `log`, `show`, `rev-parse`), and `Write(/review-findings.json)`. No commit, no `npm`, no `cargo`, no `gh`. It runs under the same deny list as the implementer. With `acceptEdits` it could edit files of its own throwaway worktree, which nobody reads or pushes.
- The fixer: the implementer's allowed tools (it needs to edit, commit and run the checks), in the implementer's worktree on `claude/<n>`. It writes its replies to `fixer-replies.json` there (kept out of `git status` through `.git/info/exclude`). Its commits go through the same `guardBranch` and `pushBranch` as the implementer's.

**Recovering: a stopped review loop is finished by hand.** There is no way to resume the loop in v1. By the time it runs, the PR is open, the issue is In review and the branch `claude/<n>` exists, so a restarted `issueWorkflow` ends at the claim as `skipped` (`already_past_in_progress` or `open_pr`) and never reaches `reviewLoop`; removing a session marker changes nothing. After a stop in the loop (`SessionError`, `SessionInterrupted`, `MalformedFindings`, `FindingsTooLarge`, `HeadMismatch`, `ReviewNotCounted`, a GitHub refusal at `review_post`, `MaxRoundsReached`, `ReviewLoopTimeout`), the PR is the maintainer's: read the stop comment, look at the PR and its threads, and review, fix and resolve by hand. For `MalformedFindings` and `FindingsTooLarge` the refused file is still in the review worktree (`<worktree>-review-<round>`), for reading before you remove it with `git worktree remove --force`. Resuming the loop from an open PR (an entry point that skips the first half) is a follow-up needed before a run is left unattended. The session markers are `orchestrator.reviewer-<pr>-r<round>-<head>` and `orchestrator.fixer-<pr>-r<round>` in the repo's git config (`git -C <repo> config --local --get-regexp '^orchestrator\.'` lists them).

*To continue by hand:* read the stop comment (and `temporal workflow show --workflow-id issue-<n>`), then review the PR's head, fix what the open threads ask on `claude/<n>` and push, reply on the threads, resolve the answered ones (only a person does) and merge as for any PR. The run is already closed (Failed), so nothing else waits on it. For `ReviewNotCounted`, first check that the account whose token the orchestrator uses is an OWNER, MEMBER or COLLABORATOR of the repo.

*To abandon it,* after stopping any `claude -p` still running (`pgrep -fl "claude -p"`): `git -C <repo> worktree remove --force <worktree>-review-<round>`, `git -C <repo> worktree prune`, `git -C <repo> config --local --unset <marker>` for each marker the list shows for the PR, close the PR, and delete the branch if it should go (`git -C <repo> push origin --delete claude/<n>`, then "Recovering a stuck branch"). Removing a marker resumes nothing: the run that read it is closed. Moving the issue back to Ready is the maintainer's. To run the issue again after that, delete the run (`temporal workflow delete --workflow-id issue-<n>`) and `npm run run-issue`.

**Findings on lines the commit did not change are advisory.** GitHub rejects a whole review (422) when one inline comment is not on a line the PR changes, and refusing the whole file would stop the run just the same. So before it posts, the activity runs `git diff -U0 origin/<base>...<head>` (in the repo, not in the session's worktree), parses the changed lines with a pure function (`changedLines`, `splitFindings` in `src/review-types.ts`) and posts only the findings on those lines as inline comments. The others are listed in the review body under a note that says they are **advisory**: a body-only finding opens no thread, so it does not hold the gate and nothing makes the fixer act on it. A person reading the review sees it; the loop does not. If the diff cannot be read, every finding goes in the body. The body list is capped at 20000 characters and says how many more were left out. The result carries counts only (`comments`, `advisory`, `omitted`), never the text.

**A findings file is read only when the session wrote it.** The reviewer's worktree is a checkout of the PR's own tree, so before the session starts the activity removes any `review-findings.json` that tree carries (a link itself, not its target). After the session it refuses the file when it is missing, is not a plain file (a link is not followed), or is tracked by git (the PR's own file, not the session's). The fixer's replies file gets the same checks.

**Reviewer read access.** The reviewer, like the implementer, is allowed bare `Read`, `Glob` and `Grep`, so a session steered by hostile issue or PR text could read host files outside its worktree and quote them in a finding, which is then posted publicly. The permission lists are risk reduction, not a boundary. The boundary is the dedicated OS user that runs the worker, which has no personal files, and the narrowly scoped GitHub token. The sanitiser covers only the output side: it neutralises mentions, links, images, raw URLs and hidden markers in what is posted, and it cannot know that a quoted line came from a file the session should not have read.

**The token's account must count.** The gate counts only reviews by an OWNER, MEMBER or COLLABORATOR. If the orchestrator's `gh` token belongs to an account that is none of these on the repository, its own reviews never count and every run stops at `ReviewNotCounted`. The gate is read up to 3 times (5 s apart) before that stop, to allow for GitHub lagging a review it just accepted.

**`test/review-loop.test.ts` checks the source for calls that resolve, approve, merge, label or write to the board.** The scan is in `test/invariants.ts`: GraphQL mutation names, REST routes, `gh` argv, method names and event names, read through comments, string concatenation, template literals and `join`, with board writes allowed only in `activities/github.ts`. A test adds each form to a scratch copy of the review activity to show it is caught. It is a text scan and a **tripwire, not a proof**: a name built at run time from data, or code outside `src/`, is invisible to it, and the permission model, the token's scopes and review are what hold the line.

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
| `src/brief.ts` | `buildBrief`: the implementer's brief, a pure function, and `briefCommands`, the commands it tells the session to run (checked against the tool lists by a test). Also `buildReviewerBrief` and `buildFixerBrief` (#630) |
| `src/workflows/review-loop.ts`, `src/gate.ts`, `src/review-policy.ts` | The review loop, the pure `gateClear`, and the loop's bounds (importable from workflow code) |
| `src/activities/review.ts`, `src/review-types.ts` | The reviewer, fixer and posting activities, and the parsing, bounds and sanitising of what the sessions write |
| `src/activities/branch.ts`, `src/branch-types.ts`, `src/diff-guard.ts` | `guardBranch` and `pushBranch` (the only push), their input parsing and bounds, and the pure diff guard |
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
