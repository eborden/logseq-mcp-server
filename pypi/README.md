# logseq-mcp-server

A read-only [MCP](https://modelcontextprotocol.io) server for [LogSeq](https://logseq.com) graphs. It gives an AI client 16 tools to search a graph, follow links, build context for a topic and read journals by date. It never writes to the graph.

This package is the server itself: one native Rust binary, with no Python code and no runtime dependencies. It is the same binary, byte for byte, as the one on the project's [GitHub Releases](https://github.com/eborden/logseq-mcp-server/releases). The wheels are built and attested by the release workflow, attached to the release beside the binaries, and uploaded here from there once the release is public.

## Install

Wheels exist for macOS (Apple silicon and Intel) and Linux (x86_64, glibc and musl). There is no Windows wheel yet, so installing on Windows fails with "no matching distribution".

```bash
uvx logseq-mcp-server      # run it without installing
uv tool install logseq-mcp-server
pipx install logseq-mcp-server
```

## Set up LogSeq

1. In LogSeq, turn on the HTTP API server (Settings, then API) and generate an auth token.
2. Create `~/.logseq-mcp/config.json`:

   ```json
   {
     "apiUrl": "http://127.0.0.1:12315",
     "authToken": "your-token-here"
   }
   ```

The server reads its token from that file, so no credentials go in your client's config.

## Connect a client

Claude Desktop (`claude_desktop_config.json`), or any client that starts MCP servers over stdio:

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

Claude Code:

```bash
claude mcp add logseq -- uvx logseq-mcp-server
```

## More

The tools, the options (`timeoutMs`, `tips`, `LOGSEQ_MCP_CONFIG`), the Claude Code plugin with skills, and the design notes are in the [project README](https://github.com/eborden/logseq-mcp-server#readme). Report problems on the [issue tracker](https://github.com/eborden/logseq-mcp-server/issues).

Licensed under MIT. The licences of the crates inside the binary are in `THIRD-PARTY-NOTICES.txt`, installed in the package's `.dist-info/licenses` directory.
