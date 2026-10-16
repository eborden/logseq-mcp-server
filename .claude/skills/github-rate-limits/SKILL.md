---
name: github-rate-limits
description: 'Use when a `gh` or GitHub API call fails with 403, 429, a rate-limit or secondary-limit message, or before a burst of writes (many comments, replies or thread resolutions).'
---

# GitHub rate limits

`gh` hides the headers by default, so a failure doesn't say which limit it hit. Diagnose first, then pick a response. There is no wrapper script: the agent decides.

**Diagnose.** Re-run the failing call with `gh api -i ...` to see the status line and headers. `gh api rate_limit` shows the primary buckets (`core`, `graphql`, `search`) and doesn't count against them.
- **Primary:** `X-Ratelimit-Remaining: 0` and a future `X-Ratelimit-Reset` (epoch seconds), or `rate_limit` shows that bucket at 0. Each bucket is separate, so `core` can be empty while `graphql` is not.
- **Secondary:** HTTP 403 or 429, a `Retry-After` header, and a body that says "secondary rate limit". `rate_limit` still shows plenty left, since it doesn't report secondary limits.

**Respond.**
- Primary: wait until the reset time. Don't retry before it.
- Secondary: wait `Retry-After` seconds. With no header, wait at least 60s, and double the wait on each repeat. Never retry in a tight loop, because that extends the block.
- Wait with `sleep` in a background command or a Monitor `until` loop rather than a foreground sleep, and tell the maintainer how long you're waiting and why.
- If the wait is long (a primary reset more than ~10 minutes away, or repeated secondary hits), stop and say so. Don't burn the session polling.

**Avoid secondary limits.** They count bursts of writes (roughly 80 content-creating requests a minute, 500 an hour, 100 concurrent), and they're per account, so parallel subagents share one budget.
- Post a review's inline comments in one `reviews` call (see "Code review" in the `work-the-queue` skill), not one call per comment.
- Don't run several subagents' write phases at once (comments, replies, thread resolutions, issue edits). Reads are cheap. Stagger the writes.
- A fixer with many threads replies and resolves them in sequence, not in parallel.
