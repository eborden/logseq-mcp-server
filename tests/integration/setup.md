# Integration Test Setup

The integration tests (`tests/integration/`) run against a live LogSeq with the HTTP API enabled, and only against the **fixture graph**: `tests/fixtures/graph/`, a small, made-up graph committed to the repo (#86, #90). Every suite calls `connectFixture` (`helpers/fixture-client.ts`), which loads the config and calls `requireFixtureGraph` (`helpers/fixture-graph.ts`), and the run's global setup (`global-setup.ts`) does the same once before any suite. Against any other graph, a stopped LogSeq or a missing config, the run fails loud with a pointer here. No test reads your own graph.

Because the data is known, the tests assert exact values: names, counts, aliases, `resolvedFrom`, truncation and caps. `tests/fixtures/README.md` describes every page and the results it was built to produce.

## Running the integration tests

The usual way is this worktree's own LogSeq instance (macOS), which opens the worktree's fixture next to your own LogSeq, on its own profile, port and token (#118):

```bash
npx tsx scripts/logseq-instance.ts start   # opens a copy of this worktree's tests/fixtures/graph, waits until indexed
npm run test:integration                   # finds .logseq-instance/config.json by itself
npx tsx scripts/logseq-instance.ts stop
```

While an instance is running, `vitest.integration.config.ts` sets `LOGSEQ_MCP_CONFIG` to its `.logseq-instance/config.json` unless the variable is already set, so a run never falls back to `~/.logseq-mcp/config.json` (your own LogSeq) while the instance is up. `stop` deletes that file. To name a config explicitly:

```bash
LOGSEQ_MCP_CONFIG=$PWD/.logseq-instance/config.json npm run test:integration
```

`npm test` runs the unit tests, then `npm run test:integration`. The default vitest config leaves `tests/integration/` out, so the integration suites always run through the config with the fixture check. Other options pass through as usual:

```bash
npm run test:integration -- tests/integration/page-resolution.test.ts   # one file
npm run test:integration -- --reporter=verbose
```

**The run does not start LogSeq for you.** Launching a desktop app from a test command is slow (the instance waits up to 90 seconds for indexing), macOS-only, and would restart LogSeq on every run, while an instance started by hand serves any number of runs. If nothing serves the fixture, the global setup stops the run with the three commands above.

**After a run, `git status` should show nothing under `tests/fixtures/graph/`.** LogSeq writes to the graph it opens (it rewrites `logseq/config.edn` and adds `logseq/bak/`), which is why the instance opens a copy (#151) and the committed fixture is only read. A change there means something opened the fixture itself, such as your own LogSeq (below). Never commit a change LogSeq made to the fixture.

### The other way: open the fixture in your own LogSeq

Without the instance (or off macOS), make the fixture the current graph of your own LogSeq:

1. **Open the folder as its own graph.** In LogSeq desktop, open the graph menu (top of the left sidebar), choose **Add new graph** (or **Open a local directory**), and pick `tests/fixtures/graph` inside your checkout. LogSeq names the graph after the folder (`graph`). Your own graph stays where it is.
2. **Make it the current graph in the window that runs the HTTP API server**, and keep a single LogSeq window open while testing. Graph switching can't be scripted: the plugin API cannot list or switch graphs, and the `logseq://graph/<name>` deep link opens the graph in a *new window* while the API keeps serving the window that started the server. A second window looks right on screen but is not what the API serves; the guard catches that.
3. **Enable the HTTP API** and put its token in `~/.logseq-mcp/config.json` (see "Server configuration" below). The API server and its tokens belong to the app, not the graph, so a token you already use keeps working after you switch.
4. **Check it.** Search for the page `logseq-mcp-fixture-sentinel`. It should exist and show `fixture-version: 1`. If it is missing, re-index the graph (graph menu → **Re-index**).
5. Run `npm run test:integration` with no instance running and `LOGSEQ_MCP_CONFIG` unset, then switch back to your own graph.

Opening the folder makes LogSeq write a few files of its own (`logseq/custom.css`, `logseq/bak/`, `pages/contents.md`, today's journal and the like). The repo `.gitignore` ignores most of them, and `tests/fixtures/README.md` lists them. Fixture journals are dated 2025 or earlier so that today's journal is never committed by mistake.

### When the run fails before any test

- **`FixtureGraphError` "not serving the fixture graph"**: LogSeq has another graph open. Start the instance, or switch your LogSeq to the fixture.
- **`FixtureGraphError` "no integer fixture-version"**: the sentinel page lost its property, or LogSeq is still indexing. Re-index the graph.
- **`FixtureGraphError` "the tests expect version N"**: LogSeq has an older or newer copy of the fixture open, probably from another checkout. Open this checkout's `tests/fixtures/graph`.
- **"Cannot query the fixture graph at http://127.0.0.1:…"**: nothing answers on that port (the instance stopped, or a stale `LOGSEQ_MCP_CONFIG`), the token is wrong, or LogSeq timed out. Run `npx tsx scripts/logseq-instance.ts status`.
- **"Config file not found"**: no instance is running and `~/.logseq-mcp/config.json` does not exist. Start the instance.

## Per-worktree instance (macOS)

`status` says whether the instance is running, which graph it opened and copied from, and whether `requireFixtureGraph` passes against it. `start` takes another graph folder as an argument, but refuses one without the fixture's sentinel page, and one inside `.logseq-instance/` or holding it. Agents in separate worktrees can each run their own instance at the same time.

What `start` does:

- **A fresh profile each time**, in `.logseq-instance/` (gitignored): `profile/` (LogSeq's `--user-data-dir`), `home/` (its home directory, so its `~/.logseq` is its own), `graph/` (the copy of the graph it opens), `logseq.log`, `instance.json` (pid, port, the graph copy and its source) and `config.json` (the file `LOGSEQ_MCP_CONFIG` points at).
- **A fresh copy of the graph each time** (#151). LogSeq writes to the graph it opens: it rewrites `logseq/config.edn` and adds `logseq/bak/`, today's journal and `pages/contents.md`. So `start` copies the graph folder to `.logseq-instance/graph/`, leaving out `logseq/bak/`, and opens the copy. The committed `tests/fixtures/graph` is only read, so the worktree stays clean while the instance runs. The sentinel check runs against the source before the copy is made. An edit to the fixture reaches the instance on the next `start`, not while it runs.
- **A port from the worktree path**, in 12320-12399, or the next free one in that range. Your LogSeq keeps 12315.
- **A new random API token on every start**, written only to the gitignored `.logseq-instance/config.json` and the profile's `configs.edn` (owner-only files). No token is committed (ADR-0003). It has to stay secret even though the graph is made up: LogSeq's API answers CORS `*` and can run git commands, write files and open links, so a web page that knew the token could drive the instance from a browser.
- **Waits** up to 90 seconds until the API serves the graph, `requireFixtureGraph` passes and every page and journal is indexed. If that fails, it stops the instance again and points at `logseq.log`.
- **`stop` signals only the pid it recorded**, and only while that process still runs on this worktree's profile. It never quits your LogSeq. It also deletes `config.json`, so a leftover config never points the tests at a port another worktree's instance has taken since. It leaves `graph/`, `profile/`, `home/` and `logseq.log`, so you can look at what LogSeq wrote; the next `start` replaces them.

It never touches your LogSeq, its profile, your `~/.logseq` or `~/.logseq-mcp/config.json`. Set `LOGSEQ_APP` if LogSeq is not at `/Applications/Logseq.app`.

How it opens the graph without the UI: a new LogSeq profile opens the demo graph, and the API server does not start there. Before the first launch, `start` writes the profile's localStorage (`current-repo` names the graph copy, `http-server-enabled` turns the API server on) and an empty graph cache file, without which LogSeq falls back to the demo graph. `scripts/logseq-instance/local-storage.ts` has the details.

## Writing an integration test

- **Connect with `connectFixture()`** in `beforeAll`. It is the guard; never load the config by hand.
- **Name fixture pages and assert exact values.** Take them from `tests/fixtures/README.md`, which records what each page was built to test and the results measured against an instance. If a test needs data the fixture lacks, add it to the fixture (and the README) in the same PR, made up like the rest. Never discover data at run time, and never return early when something is missing.
- **Compute what drifts; hard-code what doesn't.** LogSeq creates today's journal (one empty block) when the graph opens, and its date moves every day; `laterJournalDays(client)` returns it, and anything counted back from today (`last_n`, the `today` and `year_to_date` presets) adds it. Use fixed windows that end before 2026 for everything else (`FIXTURE_JOURNAL_DAYS` lists the fixture's days). Page counts include 16 built-in pages and a page per property key; compute them from the graph rather than copying the README's total.
- **Caps that pick by `:db/id` order** (ties at the same reference count) are not stable by name. The hub section of `tests/fixtures/README.md` lists which cases may assert names and which only counts, `truncated` and warnings.
- **Invariants still have a place.** `properties/graph-properties.test.ts` checks properties that hold for every page over a fixed list of fixture pages.
- **Fail loud.** No `it.skip`/`it.skipIf`, no `console.warn` (CLAUDE.md, "Integration Test Requirements"). A known bug is an `it.fails` case that names its issue, so the fix has to flip it.
- **PRs that add integration cases** (such as the `list_pages` cap) must add them as fixture-based cases with `connectFixture`, in `tests/integration/`. `fixture-only/` is not for new files.

`fixture-only/resolve-refs-missing.test.ts` predates the move (#138) and runs with the rest. It stays at that path because BR-0007 cites it.

## Probe and measure scripts

All three read `LOGSEQ_MCP_CONFIG`, else `~/.logseq-mcp/config.json`, and are read-only.

- **`scripts/probe-constraints.ts`**: run it against the fixture instance (`LOGSEQ_MCP_CONFIG=$PWD/.logseq-instance/config.json npx tsx scripts/probe-constraints.ts`). The constraints are properties of LogSeq's Datalog engine and HTTP API, not of a graph's content, and the fixture reproduces every one. Re-run it after LogSeq upgrades.
- **`scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts`**: the numbers in CLAUDE.md ("Current Implementation Status") are measured on a real ~2k-page graph, because time and output size depend on scale, so those runs keep the default config. Against the fixture instance they give reproducible call counts (the subject page is `hub central`) that match the table for most tools; use that run to check a change's call count, and the real graph to update the table. Their real-graph output contains real page names: never paste it anywhere (CLAUDE.md, "Privacy").

## Server configuration

What the MCP server and the "other way" above need from LogSeq:

1. **LogSeq desktop**, with a graph open.
2. **The HTTP API**: Settings → Features → API, enable "HTTP APIs server". Note the server URL (default `http://127.0.0.1:12315`).
3. **An auth token**: on the same page, "Generate token" or copy an existing one.
4. **A config file** at `~/.logseq-mcp/config.json`, or at the absolute path in `LOGSEQ_MCP_CONFIG`:
   ```json
   {
     "apiUrl": "http://127.0.0.1:12315",
     "authToken": "your-token-here"
   }
   ```
   Optional: add `"timeoutMs"` (positive number, default `30000`) to change the per-call timeout.
   Optional: add `"tips": false` (or set `LOGSEQ_MCP_TIPS=off`, which wins over the file) to drop the next-step hints from results. The variable accepts `on`/`true`/`1`/`yes` and `off`/`false`/`0`/`no`; any other value is a configuration error.

## Test Behavior

- Tests **FAIL** (not skip) if LogSeq is not running, not configured, or not serving the fixture graph
- Tests assert exact results on the fixture's known data
- Tests are non-destructive (read-only operations)

Integration tests must prove the system works. A test that skips, or passes without finding data, proves nothing; with the fixture, missing data means the fixture changed, and the test says so.

## Troubleshooting

**Connection Refused Error:**
- Ensure the instance (or LogSeq) is running: `npx tsx scripts/logseq-instance.ts status`
- Check that the HTTP server is enabled in settings
- Verify the API URL in your config

**Authentication Error (401, `LogSeqAuthError`):**
- The instance makes a new token on every `start`; a config copied from an earlier run is stale
- For your own LogSeq: regenerate the token in its settings, update the config file, and restart LogSeq

**Timeout Error:**
- LogSeq is reachable but not answering; check it is not busy or stuck
- Raise `timeoutMs` in the config file if calls are legitimately slow

**A test fails on a value:**
- The fixture changed (a page, a property key or a block embed adds pages), or LogSeq indexed it differently. Re-index, compare with `tests/fixtures/README.md`, and update the README and the test together
- After editing the fixture, restart the instance: it serves the copy made at `start`
