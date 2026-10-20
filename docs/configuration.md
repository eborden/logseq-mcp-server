# Configuration

The server reads one config file, `~/.logseq-mcp/config.json`, once at startup. Set up LogSeq first: turn on the HTTP API server (Settings, then API) and generate an auth token. The token goes in this file, never in your MCP client's config.

```json
{
  "apiUrl": "http://127.0.0.1:12315",
  "authToken": "your-token-here"
}
```

| Setting | Default | What it does |
|---|---|---|
| `apiUrl` | `http://127.0.0.1:12315` | Where LogSeq's HTTP API listens. An absolute `http` or `https` URL with a host, or the server stops at startup with a configuration error. Whitespace, control characters, a query and a fragment are refused. Trailing slashes are dropped |
| `authToken` | none, required | The token you generated in LogSeq. It may not contain whitespace or control characters (a trailing newline from a copy is refused at startup) |
| `timeoutMs` | `30000` | How long each LogSeq API call may take before it fails with a timeout error. A whole number of milliseconds from 1 to 2147483647. The limit applies per call, not per tool run |
| `tips` | `true` | Whether four tools (`find_blocks`, `get_page`, `explore_timeline`, `find_pages`) add a trailing `meta.tips` block suggesting a next call. Set `false` to drop them |

## Environment variables

- `LOGSEQ_MCP_CONFIG`: an absolute path to load the config from instead of `~/.logseq-mcp/config.json`. A relative path stops the server at startup with a configuration error. The integration tests use it to run against a per-worktree LogSeq instance (`tests/integration/setup.md`).
- `LOGSEQ_MCP_TIPS`: `on`, `true`, `1`, `yes` or `off`, `false`, `0`, `no` (case-insensitive). It wins over `tips` in the file, in both directions. Any other value stops the server at startup with a configuration error.

## Parameter aliases

Some tools also accept `name` or `page_name` in place of `page`, and `block_uuid` in place of `uuid`. This is best-effort only: the aliases are not in the input schemas, so a client that validates arguments against the schema rejects an alias-only call. Always use the canonical names.
