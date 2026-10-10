# LogSeq MCP Server

Turn your LogSeq knowledge graph into an AI-accessible database.

## What This Does

Provides 16 MCP tools for Claude to traverse your LogSeq graph, track concepts over time, and build comprehensive context. Goes beyond basic search: understand relationships, discover connections, analyze temporal patterns.

## Quick Start

1. Enable LogSeq HTTP server (Settings → API → Enable HTTP server)
2. Generate auth token in LogSeq
3. Create `~/.logseq-mcp/config.json`:
   ```json
   {
     "apiUrl": "http://127.0.0.1:12315",
     "authToken": "your-token-here"
   }
   ```
   `apiUrl` defaults to `http://127.0.0.1:12315`. Optionally add `"timeoutMs"` (a whole number of milliseconds from 1 to 2147483647, default `30000`) to change how long each LogSeq API call may take before it fails with a timeout error. The limit applies per call, not per tool run.

   To load the config from another file, set the environment variable `LOGSEQ_MCP_CONFIG` to its absolute path. A relative path stops the server at startup with a configuration error. The integration tests use it to run against a per-worktree LogSeq instance (`tests/integration/setup.md`).

   Tips are on by default: seven tools (`search_blocks`, `get_page`, `get_page_outline`, `get_backlinks`, `query_by_property`, `query_by_date_range`, `list_pages`) add a trailing `meta.tips` block suggesting a next call. Set `"tips": false` in the config file, or the environment variable `LOGSEQ_MCP_TIPS=off`, to drop them. The variable wins over the file, in both directions. It accepts `on`, `true`, `1`, `yes` and `off`, `false`, `0`, `no` (case-insensitive); any other value stops the server at startup with a configuration error.

   Some tools also accept `name`, `page` (and `page_name` or `uuid` where it fits) in place of their canonical parameter (`page_name`, `topic_name`, `concept_name`, `block_uuid`). This is best-effort only: the aliases are not in the input schemas, so a client that validates arguments against the schema rejects an alias-only call. Always use the canonical names.
4. Connect it to your MCP client (next section). The server is a Rust binary you build from a clone, which needs the Rust toolchain that `rust/rust-toolchain.toml` pins (rustup reads it). Node is only for the repo's tooling and tests.

## Install

The server is a Rust binary. It ships as native binaries on GitHub Releases (ADR-0035), which the Claude Code plugin downloads for you, and there is no npm package: the name `logseq-mcp-server` on npm is not this project, so don't run `npx logseq-mcp-server`; it would run someone else's package. The first release is not published yet, so for now build it from a clone. Do steps 1-3 of Quick Start first; the server reads its token from `~/.logseq-mcp/config.json`, so no credentials go into the client config.

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server/rust             # a clone checks out `main`, which holds the Rust server
cargo build --release --locked        # rust/target/release/logseq-mcp-server
```

### Claude Code

```bash
claude mcp add logseq -- /absolute/path/to/logseq-mcp-server/rust/target/release/logseq-mcp-server
```

Or install the [plugin](#install-as-a-claude-code-plugin), which also bundles the skills and downloads the release binary (once a release is published).

### Claude Desktop

Add the server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "logseq": {
      "command": "/absolute/path/to/logseq-mcp-server/rust/target/release/logseq-mcp-server"
    }
  }
}
```

## Install as a Claude Code plugin

The repo is both a Claude Code plugin and its own marketplace. The plugin bundles the MCP server and the `logseq-skills` workflows.

First do steps 1-3 of Quick Start (HTTP server on, token, `~/.logseq-mcp/config.json`). The plugin carries no credentials.

```bash
claude plugin marketplace add eborden/logseq-mcp-server
claude plugin install logseq@logseq-mcp-server
```

The plugin starts `scripts/logseq-mcp-server.sh`, a small POSIX `sh` launcher (ADR-0035). On the first start it downloads the release binary for your platform and for the plugin's own version from [GitHub Releases](https://github.com/eborden/logseq-mcp-server/releases), checks each download against the release's `SHA256SUMS` (it never runs a freshly downloaded file that doesn't match), caches it and replaces itself with the server. Later starts run the cached binary as it sits, without checking it again. Everything it says goes to stderr, since stdout is the MCP channel.

- **Platforms:** macOS (Apple silicon and Intel) and Linux x86_64. Windows and Linux arm64 have no release binary yet; build from a clone and use `LOGSEQ_MCP_BINARY` below.
- **Needs:** `sh`, `curl`, and `shasum` or `sha256sum`. No Node. The first start needs the network (a few MB from `github.com`); a proxy is read from `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`.
- **Cache:** `~/Library/Caches/logseq-mcp-server/<version>/` on macOS, `~/.cache/logseq-mcp-server/<version>/` elsewhere (`XDG_CACHE_HOME` replaces the parent, and must be an absolute path). It holds the binary, `SHA256SUMS`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`, created readable by you only (0700 and 0600). Because a cached binary is trusted as it sits and is not re-checked, the launcher refuses a cache directory that someone else owns or that group or others can write to. The check follows symlinks and tests the effective user, so it fails closed on purpose in two cases: a `sudo` or root run that keeps your `HOME`, and an NFS mount that maps owners differently. Both refusals name `XDG_CACHE_HOME`; point it at a directory of your own. A start that was killed hard can leave a `.partial.*` directory in it; the next download removes the ones over a day old, and nothing in them is ever run.
- **Trust limits:** `SHA256SUMS` comes from the same release as the binary, so the check catches a corrupt or truncated download but not a compromised release or account (ADR-0035 Decision 4). The launcher doesn't verify a signature or an attestation; to tie a binary to the workflow run and commit that built it, run `gh attestation verify <binary> --repo eborden/logseq-mcp-server` by hand.
- **Not released yet:** the first release is cut by the maintainer by hand, so until it is published the launcher stops with a message naming the file it couldn't find. Use the clone build below meanwhile.

Two environment variables, set where the plugin's server starts, change where the binary comes from:

| Variable | Effect |
|---|---|
| `LOGSEQ_MCP_BINARY` | An absolute path to a server binary to run as it is: no download, no checks. For offline use, or a binary you built (`cd rust && cargo build --release --locked`). |
| `LOGSEQ_MCP_RELEASE_BASE_URL` | Where the release files are fetched from, in place of `https://github.com/eborden/logseq-mcp-server/releases/download/v<version>`. An `https://`, `http://` or `file://` base. The checksum checks still run, but over plain `http://` the checksums come from the same unprotected place as the binary, so they prove nothing against an attacker on the network (the launcher warns on stderr). |

To use a clone's plugin with your own build, with no download:

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server/rust && cargo build --release --locked && cd ..
LOGSEQ_MCP_BINARY="$PWD/rust/target/release/logseq-mcp-server" claude --plugin-dir .
```

A binary you download by hand through a browser is quarantined by macOS, and Gatekeeper refuses it until you run `xattr -d com.apple.quarantine <file>`. The launcher's `curl` download isn't affected.

Under a plugin, the tools appear as `mcp__plugin_logseq_logseq__logseq_*`. The skills refer to them by bare name, so either form works.

## 16 Tools at a Glance

### Basic Operations (7)
| Tool | Purpose |
|------|---------|
| `search_blocks` | Full-text search with optional semantic context |
| `get_page` | Retrieve page content with children |
| `get_page_outline` | Top-level blocks of a page: uuid, first-line snippet, child count |
| `get_backlinks` | Find all references to a page |
| `get_block` | Get specific block by UUID |
| `query_by_property` | Find blocks by property key/value |
| `list_pages` | List non-journal pages as `{ name, aliases? }`, optionally filtered by name or alias |

### Graph Traversal (1)
| Tool | Purpose |
|------|---------|
| `get_concept_network` | Build network graph with nodes/edges |

### Semantic Search (1)
| Tool | Purpose |
|------|---------|
| `search_by_relationship` | Find blocks based on topic relationships |

### Context Building (3)
| Tool | Purpose |
|------|---------|
| `build_context` | Gather comprehensive topic context in one call |
| `get_context_for_query` | Parse natural language and build context |
| `get_current_context` | What the user has open in LogSeq right now |

### Temporal Queries (2)
| Tool | Purpose |
|------|---------|
| `query_by_date_range` | Query journal entries by date |
| `get_concept_evolution` | Track concept mentions over time (replaces get_entity_timeline) |

### Graph Information (1)
| Tool | Purpose |
|------|---------|
| `get_graph_info` | Get current LogSeq graph information including filesystem path |

### Linking Gate (1)
| Tool | Purpose |
|------|---------|
| `check_links` | Check a `[[link]]` pass on a note: prose unchanged, brackets balanced, no ref dropped, every ref names a page or alias |

### Markdown output and compact results

`get_page`, `get_block`, `build_context`, `get_context_for_query` and `get_concept_network` take `format: "markdown"` (the default is `"json"`). The result is one plain text block: page properties as `key:: value` lines, blocks as indented `- ` bullets with `((uuid))` refs kept (block uuids are left out, except on keyword search hits and in `compact`), related pages and references grouped by source page, and a short footer for warnings, `hasMore` and tips. It is roughly 45-80% smaller than the JSON. `build_context` and `get_context_for_query` also take `compact: true`, which swaps block bodies for a first-line snippet plus the block's uuid (it pays off on long blocks, and `resolve_refs` is skipped with a warning). For a long page, `get_page_outline` lists the top-level blocks (uuid, snippet, child count) and `get_block` reads the ones you pick. The `logseq://page/{name}` resource renders through the same code.

## Prompts

Prompts are ready-made starting points that a host shows as slash commands or a menu. Each one sends the model a short message naming the tools to call and the limits to keep. They only read.

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `weekly_summary` | `week` (optional): `this` (default), `last`, or a date in the week | Summarize a Monday-to-Friday week of journals into a few short signals |
| `monthly_summary` | `month` (optional): `this` (default), `last`, or `YYYY-MM` | Summarize a month from its weekly pages, with each thread's trajectory |
| `continue_on` | `topic` (required) | Pick up where you left off: current state, latest activity, open tasks, next step |
| `what_do_i_know` | `topic` (required) | Research a topic across the graph, with sources and gaps |
| `prioritize_tasks` | `focus` (optional) | Find open TODO and DOING tasks, spot stale ones, suggest an order |

The server cannot write to your graph. The summary prompts end by showing the summary in the chat. If you want it saved as a page, ask, and a host with file access can do it.

## Resources

| URI | Contents |
|-----|----------|
| `logseq://guide` | The reading guide: how to read results (case-insensitive names, `((uuid))` refs, `hasMore` and `warnings`), which tool to start with, and an index of tools and prompts |
| `logseq://page/{name}` | One page as Markdown text. The name is URL-encoded and may be an alias or an ISO date (`logseq://page/2025-01-01`). Pages over 50,000 characters are cut with a notice |

## Skills

Beyond individual tools, the `logseq-skills` provides structured workflows that combine multiple tools:

**Available workflows:**
- **Research Assistant** - "What do I know about X?" - comprehensive topic research
- **Task Prioritization** - "What should I work on?" - find and organize TODOs
- **Stale Task Detection** - Find tasks with no recent activity
- **Weekly Summary** - Generate structured summaries from journal entries
- **Graph Exploration** - Discover connections between concepts
- **Temporal Analysis** - Track how concepts evolved over time
- **Smart Context Building** - Natural language queries with automatic context gathering

See `skills/logseq-skills/` for complete workflow documentation (also reachable at `.claude/skills/logseq-skills/` through a symlink for project-local use).

## Example Usage

**"What do I know about React?"**
```
Use: build_context("React")
Gets: Page + blocks + related pages + references + temporal context
```

**"Show everything connected to Machine Learning"**
```
Use: get_concept_network("Machine Learning", max_depth=2)
Gets: Network graph with nodes and edges
```

**"How did my thinking on testing evolve this year?"**
```
Use: get_concept_evolution("testing", 20250101, 20251231, group_by='month')
Gets: Timeline grouped by month showing pattern changes
```

**"What was I working on last week?"**
```
Use: query_by_date_range(20251114, 20251120)
Gets: All journal entries in date range
```

## Releasing

For the maintainer. Nothing releases or publishes automatically, and nothing publishes to npm (ADR-0035). A release is the native binaries, the three PyPI wheels built from them and `SHA256SUMS` on a GitHub Release, built by a manual workflow (`release.yml`) that runs only when started by hand from the Actions tab, only on `main`, and creates a draft release. You publish the draft yourself, which creates the tag. A second manual workflow (`pypi.yml`, ADR-0036) then uploads the wheels of the public release to PyPI.

**One-time setup before the first PyPI upload.** Without the environment, a real run of `pypi.yml` uploads with no second click, because GitHub creates an unprotected one.

- In the repository settings, create the `pypi` environment with yourself as a required reviewer and deployment limited to `main`. Leave "Prevent self-review" off, or you can't approve your own run.
- On PyPI, add a pending trusted publisher for the project `logseq-mcp-server`: owner `eborden`, repository `logseq-mcp-server`, workflow `pypi.yml`, environment `pypi`.

The order, from ADR-0035 (Decision 12) and ADR-0036 (Decision 9):

1. Bump the version in `rust/Cargo.toml`, `package.json` and both `.claude-plugin/` manifests together (a test keeps them equal), and move the `CHANGELOG.md` "Unreleased" entries under it with the release date. Merge that first: the release is built at the commit the run starts from.
2. Run `release.yml` with `dry_run` on, read the artifacts and the logs (every leg of the build, and the `wheels` job), then with it off to create the draft.
3. **Pre-publish check.** Draft assets can't be downloaded anonymously, so download them with `gh release download v<version> --dir <empty dir>`. On a clean macOS and a clean Linux machine, run the launcher against that directory and call one tool, then install a wheel from it and call one tool:

   ```bash
   LOGSEQ_MCP_RELEASE_BASE_URL="file://<empty dir>" sh scripts/logseq-mcp-server.sh
   uvx --from <empty dir>/logseq_mcp_server-<version>-<tag>.whl logseq-mcp-server
   ```

4. Publish the draft. Then, on a clean machine with no override, start the plugin once and call one tool. A bad release is fixed by a new patch version, not an edit.
5. Run `pypi.yml` with `dry_run` on and read its log (checksums, attestations, the install check), then with it off, and approve the `pypi` environment. PyPI never accepts a file name twice, so a mistake costs a version number.
6. On a clean macOS and a clean Linux machine with no override, run `uvx logseq-mcp-server` through an MCP client and call one tool. Only then add the `uvx` install to this README and the changelog.

## Development

The server is Rust (`rust/`, since #356). The TypeScript tooling (`scripts/`, `tests/`) holds the guard tests, the integration suites and the measure scripts:

```bash
npm ci
(cd rust && cargo build && cargo test --locked)   # includes the golden-result test: the Rust server against the recorded results
npx vitest run tests/guards tests/rust-guards  # the repo's guard tests
npm run test:integration              # needs LogSeq serving the fixture graph; see tests/integration/setup.md
```

## Architecture

- **Rust** MCP server (`rust/`, rmcp) that talks to LogSeq's HTTP API over stdio. The TypeScript server it replaced was removed in #356
- **Golden results**: `rust/tests/data/parity/` holds the cases and the results recorded from the TypeScript server, and `cargo test --test parity` holds the Rust server to them (`PARITY_RECORD=1 cargo test --test parity_record` records them)
- **Vitest** for the repo's guard tests and the integration suites, **cargo test** for the server
- **TDD approach** - all tools have comprehensive test coverage
