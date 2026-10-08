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
   `apiUrl` defaults to `http://127.0.0.1:12315`. Optionally add `"timeoutMs"` (a positive number, default `30000`) to change how long each LogSeq API call may take before it fails with a timeout error. The limit applies per call, not per tool run.

   To load the config from another file, set the environment variable `LOGSEQ_MCP_CONFIG` to its absolute path. A relative path stops the server at startup with a configuration error. The integration tests use it to run against a per-worktree LogSeq instance (`tests/integration/setup.md`).

   Tips are on by default: seven tools (`search_blocks`, `get_page`, `get_page_outline`, `get_backlinks`, `query_by_property`, `query_by_date_range`, `list_pages`) add a trailing `meta.tips` block suggesting a next call. Set `"tips": false` in the config file, or the environment variable `LOGSEQ_MCP_TIPS=off`, to drop them. The variable wins over the file, in both directions. It accepts `on`, `true`, `1`, `yes` and `off`, `false`, `0`, `no` (case-insensitive); any other value stops the server at startup with a configuration error.

   Some tools also accept `name`, `page` (and `page_name` or `uuid` where it fits) in place of their canonical parameter (`page_name`, `topic_name`, `concept_name`, `block_uuid`). This is best-effort only: the aliases are not in the input schemas, so a client that validates arguments against the schema rejects an alias-only call. Always use the canonical names.
4. Connect it to your MCP client (next section). The server is a Rust binary you build from a clone, which needs the Rust toolchain that `rust/rust-toolchain.toml` pins (rustup reads it). Node is only for the repo's tooling and tests.

## Install

The server is a Rust binary. There is no npm package or release binary yet: how it ships is open (#350, #355). Until then, build it from a clone. Do steps 1-3 of Quick Start first; the server reads its token from `~/.logseq-mcp/config.json`, so no credentials go into the client config.

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server
git checkout feature/rust-spike       # `main` still has the TypeScript server until the Rust branch merges
cd rust
cargo build --release --locked        # rust/target/release/logseq-mcp-server
```

### Claude Code

```bash
claude mcp add logseq -- /absolute/path/to/logseq-mcp-server/rust/target/release/logseq-mcp-server
```

Or install the [plugin](#install-as-a-claude-code-plugin), which also bundles the skills (stale for now, see there).

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

> **Stale until #350 and #355.** This section and [Publishing](#publishing) describe how the TypeScript server was packaged and published. The plugin manifest still starts `node dist/index.js`, `dist/` no longer builds (`npm run build` stops with a pointer to the Rust build), and nothing here has been updated for the Rust binary. Use the clone install above for now.

The repo is both a Claude Code plugin and its own marketplace. The plugin bundles the MCP server and the `logseq-skills` workflows.

First do steps 1-3 of Quick Start (HTTP server on, token, `~/.logseq-mcp/config.json`). The plugin carries no credentials.

```bash
claude plugin marketplace add eborden/logseq-mcp-server
claude plugin install logseq@logseq-mcp-server
```

The plugin starts the server with `node dist/index.js`, and `dist/` is not committed. Until the package is published to npm (tracked in #14), a marketplace install has no built server. Build from a clone and load the plugin from there instead:

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server
npm ci && npm run build
claude --plugin-dir .
```

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

## Publishing

> **Stale until #350 and #355**, as above: this is the npm flow of the TypeScript server, which is retired. How the Rust binary is published needs its own decision.

For the maintainer. Nothing publishes automatically: `.github/workflows/publish.yml` runs only when started by hand from the Actions tab, and only on `main`.

1. Add an npm access token that can publish `logseq-mcp-server` as the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions).
2. Set the version in `package.json` and `.claude-plugin/plugin.json` (a test keeps them equal), and move the `CHANGELOG.md` "Unreleased" entries under it.
3. Run the workflow with **dry_run** ticked first. It type-checks, runs the unit tests, builds, lists the tarball and runs `npm publish --dry-run`.
4. Run it again with **dry_run** cleared. It runs `npm publish --provenance --access public`, which signs a provenance statement linking the package to the commit.

To check a build locally first, `npm pack --dry-run` lists the tarball, and `npm pack` followed by `npm install ./logseq-mcp-server-*.tgz` in a scratch directory installs it.

## Development

The server is Rust (`rust/`, since #356). The TypeScript tooling (`scripts/`, `tests/`) holds the golden-result harness and the integration suites:

```bash
npm ci
(cd rust && cargo build && cargo test --locked)
npx vite-node scripts/parity.ts       # the Rust server against the recorded results
npx vitest run tests/guards tests/rust-guards  # the repo's guard tests
npm run test:integration              # needs LogSeq serving the fixture graph; see tests/integration/setup.md
```

## Architecture

- **Rust** MCP server (`rust/`, rmcp) that talks to LogSeq's HTTP API over stdio. The TypeScript server it replaced was removed in #356
- **Golden results**: `scripts/parity/expected/` holds the results recorded from the TypeScript server, and `scripts/parity.ts` holds the Rust server to them
- **Vitest** for the repo's guard tests and the integration suites, **cargo test** for the server
- **TDD approach** - all tools have comprehensive test coverage
