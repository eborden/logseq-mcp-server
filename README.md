# LogSeq MCP Server

A read-only [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) search and read your [LogSeq](https://logseq.com) graph. It follows links, builds context for a topic and reads journals by date, using batched Datalog queries so a question costs a handful of LogSeq calls, not one per page.

It never writes to your graph. Every tool only reads.

Install: see [Install](#install) (Claude Code plugin, `uvx`, or a clone).

## Who it is for

You keep notes in LogSeq and want an AI assistant to use them: "what do I know about project atlas?", "what was I working on last week?", "how does this page connect to that one?". You run LogSeq desktop with its HTTP API on, reachable at `apiUrl` (default `127.0.0.1`).

## What you can ask

- "What do I know about project atlas?" (a page, its blocks, related pages and what links to it)
- "What was I working on last week?" (the journal days in a period)
- "Find every block that mentions the importer and links to Alice."
- "How does project atlas connect to Bob's team page?" (the shortest path of links)
- "How did my thinking on testing change this year?" (a page over time, by month)
- "What should I work on?" (open TODOs, stale ones, an order)

## The tools

10 tools in four kinds, named after what they do:

| Kind | Tools | Use for |
|---|---|---|
| `get` | `get_page`, `get_block`, `get_current`, `get_graph` | One thing you can name: a page, a block, what is open now, the graph |
| `find` | `find_blocks`, `find_pages` | Things that match a filter: text, page, links, property, period |
| `explore` | `explore_context`, `explore_network`, `explore_timeline` | Walking outward from a page: context, links, time |
| `check` | `check_links` | A gate on a `[[link]]` pass before you save it |

Long results are cut with a warning and a `nextCursor` you pass back as `cursor`. Details, parameters, Markdown output, prompts and resources: [docs/tools.md](docs/tools.md).

## Install

You need LogSeq desktop with its HTTP API on, and one of the options below. The server is a native Rust binary; Node is only for developing it.

**1. Set up LogSeq.** Turn on the HTTP API server (Settings, then API) and generate an auth token. Then create `~/.logseq-mcp/config.json`:

```json
{
  "apiUrl": "http://127.0.0.1:12315",
  "authToken": "your-token-here"
}
```

The token lives only in that file, so no credentials go in your client's config. Other settings and environment variables: [docs/configuration.md](docs/configuration.md).

**2. Connect a client.** Pick one.

Claude Code plugin (also bundles the skills, and downloads the release binary for you):

```bash
claude plugin marketplace add eborden/logseq-mcp-server
claude plugin install logseq@logseq-mcp-server
```

Claude Code with `uvx` (needs [uv](https://docs.astral.sh/uv/); the package is [`logseq-mcp-server` on PyPI](https://pypi.org/project/logseq-mcp-server/)):

```bash
claude mcp add logseq -- uvx logseq-mcp-server
```

Claude Desktop, in `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart it:

```json
{
  "mcpServers": {
    "logseq": {
      "command": "uvx",
      "args": ["logseq-mcp-server"]
    }
  }
}
```

From a clone (needed on Windows and Linux arm64, which have no prebuilt binary or wheel): build with `cargo build --release --locked` in `rust/` (see [docs/development.md](docs/development.md)), then use the absolute path of `rust/target/release/logseq-mcp-server` as the command, with no args.

Prebuilt binaries and wheels cover macOS (Apple silicon and Intel) and Linux x86_64. A desktop app may not find `uvx` on its PATH; if so, set `command` to the full path of `uvx`. There is no npm package: the name `logseq-mcp-server` on npm is not this project, so don't run `npx logseq-mcp-server`. Plugin details (cache, checksums, offline use): [docs/plugin.md](docs/plugin.md).

## Skills and prompts

The `logseq-skills` workflows (recall a topic, refresh on a person, history of a decision, connect two projects, plan the week, stale work, who owns it, weekly and monthly summaries, link concepts) ship with the plugin and live in `skills/logseq-skills/`. The server also offers five prompts and two resources; see [docs/tools.md](docs/tools.md).

## Privacy and read-only

- The server only reads. It has no tool that edits, creates or deletes anything in your graph (BR-0002).
- It talks to LogSeq on your machine (`apiUrl`, `127.0.0.1` by default). It makes no other network calls while serving, and it logs to stderr only, never graph content.
- Your token stays in `~/.logseq-mcp/config.json`. Error messages never echo it.
- What a client does with the results (for example, sending them to a model) is up to that client.

## Learn more

- [Changelog](CHANGELOG.md), with the v1 to v2 migration note
- [Tools, prompts and resources](docs/tools.md)
- [Configuration](docs/configuration.md)
- [Claude Code plugin](docs/plugin.md)
- [Architecture](docs/architecture.md), then the [decisions](docs/adr/README.md) and [rules](docs/business-rules/README.md)
- [Development](docs/development.md) and [releasing](docs/releasing.md)

Licensed under MIT; see `LICENSE`.
