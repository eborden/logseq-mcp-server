# Integration Test Setup

The integration tests (`tests/integration/`) run against a live LogSeq with the HTTP API enabled, and only against the **fixture graph**: `tests/fixtures/graph/`, a small, made-up graph committed to the repo (#86, #90). Every suite calls `connectFixture` (`helpers/fixture-client.ts`), and the run's global setup (`global-setup.ts`) does the same once before any suite. It takes the config from `LOGSEQ_MCP_CONFIG` or this worktree's `.logseq-instance/config.json` and nowhere else, refuses a config on port 12315 (a personal LogSeq), and then calls `requireFixtureGraph` (`helpers/fixture-graph.ts`). Against any other graph, a stopped LogSeq or no config, the run fails loud with a pointer here.

**The tests never contact your own LogSeq.** They never read `~/.logseq-mcp/config.json`: with no instance running and `LOGSEQ_MCP_CONFIG` unset, the run stops before any network call. `tests/guards/integration-guard.test.ts` checks that every suite connects through `connectFixture` and loads no config of its own.

Because the data is known, the tests assert exact values: names, counts, aliases, `resolvedFrom`, truncation and caps. `tests/fixtures/README.md` describes every page and the results it was built to produce.

## Running the integration tests

The usual way is this worktree's own LogSeq instance (macOS), which opens the worktree's fixture next to your own LogSeq, on its own profile, port and token (#118):

```bash
npx tsx scripts/logseq-instance.ts start   # opens a copy of this worktree's tests/fixtures/graph, waits until indexed
npm run test:integration                   # finds .logseq-instance/config.json by itself
npx tsx scripts/logseq-instance.ts stop
```

While an instance is running, `vitest.integration.config.ts` sets `LOGSEQ_MCP_CONFIG` to its `.logseq-instance/config.json` unless the variable is already set. `stop` deletes that file, so after `stop` a run fails at once instead of finding a stale port. To name a config explicitly:

```bash
LOGSEQ_MCP_CONFIG=$PWD/.logseq-instance/config.json npm run test:integration
```

`npm test` runs the unit tests, then `npm run test:integration`. The default vitest config leaves `tests/integration/` out, so the integration suites always run through the config with the fixture check. Other options pass through as usual:

```bash
npm run test:integration -- tests/integration/page-resolution.test.ts   # one file
npm run test:integration -- --reporter=verbose
```

**The run does not start LogSeq for you.** Launching a desktop app from a test command is slow (the instance waits up to 90 seconds for indexing), macOS-only, and would restart LogSeq on every run, while an instance started by hand serves any number of runs. If nothing serves the fixture, the global setup stops the run with the three commands above.

**After a run, `git status` should show nothing under `tests/fixtures/graph/`.** LogSeq writes to the graph it opens (it rewrites `logseq/config.edn` and adds `logseq/bak/`), which is why the instance opens a copy (#151) and the committed fixture is only read. A change there means something opened the fixture itself, such as a LogSeq of your own (below). Never commit a change LogSeq made to the fixture.

### The server under test (#352, #356)

The suites run against the Rust server (`rust/`, #122), the only server since the TypeScript one was retired (#356). Build it first:

```bash
npx tsx scripts/logseq-instance.ts start
(cd rust && cargo build)                   # the debug build: rust/target/debug/logseq-mcp-server
npm run test:integration
npx tsx scripts/logseq-instance.ts stop
```

`LOGSEQ_MCP_RUST_BIN` names another binary (a release build, say). The global setup stops the run when the binary is missing.

How it works (`helpers/server-under-test.ts` and `helpers/tools.ts`, over `scripts/lib/rust-server.ts`):

- **A suite that sends `tools/call`** (`output-format`, `result-caps`, `slim-default`) gets its client from `connectMcp(client, options)`: the Rust binary over stdio.
- **A suite that calls a tool as a function** (`getPage`, `queryJournals`, ...) imports it from `helpers/tools.js`. Each function calls the tool through MCP and turns the result back into a value: the first content block as JSON, a bare-array tool's `meta` block as `meta`, an error result as a thrown `PageNotFoundError`, `InvalidParameterError` and so on (`helpers/errors.ts`), and the ambiguous-name result as an `AmbiguousPageError`. Each function sends the default a direct call had in the TypeScript server where the tool's differs (`slim_results` is false there: BR-0012). `tests/guards/integration-guard.test.ts` fails on a suite that imports from `src/` or starts a server of its own.
- **The Rust server never talks to LogSeq itself** (except in `auth-error`, which gives it a bogus token on purpose). Its config points at a small HTTP forwarder in the test process, which makes each call through the suite's own `LogseqClient.callAPI` (`scripts/lib/logseq-api.ts`). The fixture check, the token and the port-12315 refusal stay with that client, and a test that counts or wraps `client.callAPI` counts the server's calls. The server gets a home directory of its own, so it has no `~/.logseq-mcp/config.json` to fall back on (BR-0001).
- **What no tool argument can express is not tested here.** The caps a direct call to the old TypeScript functions could lift or lower (`maxLimit`, `maxFanout: Infinity`) are covered by the Rust unit tests, which feed the tools more results than a fixture holds.
- **There is no suite on the old TypeScript internals** (the resolver, `DatalogQueryBuilder`, `resolveBlockRefs`): their promises are held at the tool (`datalog-inputs`, `page-resolution`, `resolve-refs`).
- `LOGSEQ_MCP_NOW` is how a test that passes a `now` to `queryJournals` fixes the server's clock. A release build ignores it, so such a test needs the debug build.

### Without the instance (not recommended)

**Use the instance script when you can.** The fallback below writes to the committed fixture and needs a LogSeq whose API is not on port 12315, because the tests refuse that port: it is LogSeq's default, so it is taken to be your personal LogSeq. It is for machines where the instance script cannot run (it is macOS-only). On such a machine, use a separate LogSeq install or profile, not the one with your own graph:

1. **Open the folder as its own graph.** In LogSeq desktop, open the graph menu (top of the left sidebar), choose **Add new graph** (or **Open a local directory**), and pick `tests/fixtures/graph` inside your checkout. LogSeq names the graph after the folder (`graph`). Your own graph stays where it is.
2. **Make it the current graph in the window that runs the HTTP API server**, and keep a single LogSeq window open while testing. Graph switching can't be scripted: the plugin API cannot list or switch graphs, and the `logseq://graph/<name>` deep link opens the graph in a *new window* while the API keeps serving the window that started the server. A second window looks right on screen but is not what the API serves; the guard catches that.
3. **Enable the HTTP API on a port other than 12315** (Settings → Features → API, then the server's host and port), and write a config file for it somewhere other than `~/.logseq-mcp/` (see "Server configuration" below).
4. **Check it.** Search for the page `logseq-mcp-fixture-sentinel`. It should exist and show `fixture-version: 1`. If it is missing, re-index the graph (graph menu → **Re-index**).
5. **Run** `LOGSEQ_MCP_CONFIG=/absolute/path/to/that/config.json npm run test:integration`.
6. **Restore the fixture.** That LogSeq rewrites the committed `logseq/config.edn` and adds `logseq/bak/`: run `git checkout -- tests/fixtures/graph`, delete `tests/fixtures/graph/logseq/bak/`, and check that `git status` shows nothing under `tests/fixtures/graph/`.

Opening the folder makes LogSeq write a few files of its own (`logseq/custom.css`, `logseq/bak/`, `pages/contents.md`, today's journal and the like). The repo `.gitignore` ignores most of them, and `tests/fixtures/README.md` lists them. Fixture journals are dated 2025 or earlier so that today's journal is never committed by mistake.

### When the run fails before any test

- **`FixtureGraphError` "not serving the fixture graph"**: LogSeq has another graph open. Start the instance, or switch your LogSeq to the fixture.
- **`FixtureGraphError` "no integer fixture-version"**: the sentinel page lost its property, or LogSeq is still indexing. Re-index the graph.
- **`FixtureGraphError` "the tests expect version N"**: LogSeq has an older or newer copy of the fixture open, probably from another checkout. Open this checkout's `tests/fixtures/graph`.
- **"Cannot query the fixture graph at http://127.0.0.1:…"**: nothing answers on that port (the instance stopped, or a stale `LOGSEQ_MCP_CONFIG`), the token is wrong, or LogSeq timed out. Run `npx tsx scripts/logseq-instance.ts status`.
- **`FixtureConfigError` "No fixture instance is running"**: no `.logseq-instance/config.json` and no `LOGSEQ_MCP_CONFIG`. Start the instance. No network call was made.
- **`FixtureConfigError` "points at port 12315"**: `LOGSEQ_MCP_CONFIG` names a config for a personal LogSeq. Unset it and start the instance. No network call was made.
- **`FixtureConfigError` "Config file not found"**: `LOGSEQ_MCP_CONFIG` names a file that does not exist.

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
- **Call tools through `helpers/tools.js`** (or `connectMcp` for `tools/call`), as above.
- **Name fixture pages and assert exact values.** Take them from `tests/fixtures/README.md`, which records what each page was built to test and the results measured against an instance. If a test needs data the fixture lacks, add it to the fixture (and the README) in the same PR, made up like the rest. Never discover data at run time, and never return early when something is missing.
- **Compute what drifts; hard-code what doesn't.** LogSeq creates today's journal (one empty block) when the graph opens, and its date moves every day; `laterJournalDays(client)` returns it, and anything counted back from today (`last_n`, the `today` and `year_to_date` presets) adds it. Use fixed windows that end before 2026 for everything else (`FIXTURE_JOURNAL_DAYS` lists the fixture's days). Page counts include 16 built-in pages and a page per property key; compute them from the graph rather than copying the README's total.
- **Caps that pick by `:db/id` order** (ties at the same reference count) are not stable by name. The hub section of `tests/fixtures/README.md` lists which cases may assert names and which only counts, `truncated` and warnings.
- **Invariants still have a place.** `properties/graph-properties.test.ts` checks properties that hold for every page over a fixed list of fixture pages.
- **Fail loud.** No `it.skip`/`it.skipIf`, no `console.warn` (CLAUDE.md, "Integration Test Requirements"). A known bug is a plain `it` that asserts the current wrong value and names its issue, so the fix has to flip it. Not `it.fails`, which also passes when the body throws for any other reason.
- **PRs that add integration cases** (such as the `list_pages` cap) must add them as fixture-based cases with `connectFixture`, in `tests/integration/`. `fixture-only/` is not for new files.

`fixture-only/resolve-refs-missing.test.ts` predates the move (#138) and runs with the rest. It stays at that path because BR-0007 cites it.

## Probe and measure scripts

All three are read-only.

- **`scripts/probe-constraints.ts`** resolves its config like the integration tests: `LOGSEQ_MCP_CONFIG`, else the instance's `.logseq-instance/config.json`, never `~/.logseq-mcp/config.json`. So `npx tsx scripts/probe-constraints.ts` with the instance running probes the fixture, and with neither it stops before any network call. The constraints are properties of LogSeq's Datalog engine and HTTP API, not of a graph's content, and the fixture reproduces every one; row counts (such as constraint 4's) differ from the real-graph numbers in CLAUDE.md. Re-run it after LogSeq upgrades.
- **`scripts/measure-api-calls.ts` and `scripts/measure-output-size.ts`** read `LOGSEQ_MCP_CONFIG`, else `~/.logseq-mcp/config.json`: **they read the real graph on purpose.** The numbers in CLAUDE.md ("Current Implementation Status") are measured on a real ~2k-page graph, because time and output size depend on scale, so those runs keep the default config. Against the fixture instance they give reproducible call counts (the subject page is `hub central`) that match the table for most tools; use that run to check a change's call count, and the real graph to update the table. Their real-graph output contains real page names: never paste it anywhere (CLAUDE.md, "Privacy").

## Server configuration

What the MCP server, and a LogSeq used without the instance, need:

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
- A test (not a call) that times out after 120 s means the instance was swamped: LogSeq answers one request at a time, so several suites on one instance, or many instances on one machine, queue behind each other. Stop other runs and rerun. A test that fails after about 30 s with `LogSeqTimeoutError` is a single call that never answered

**A test fails on a value:**
- The fixture changed (a page, a property key or a block embed adds pages), or LogSeq indexed it differently. Re-index, compare with `tests/fixtures/README.md`, and update the README and the test together
- After editing the fixture, restart the instance: it serves the copy made at `start`
