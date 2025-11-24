# LogSeq MCP Server

Turn your LogSeq knowledge graph into an AI-accessible database.

## What This Does

Provides 11 MCP tools for Claude to traverse your LogSeq graph, track concepts over time, and build comprehensive context. Goes beyond basic search: understand relationships, discover connections, analyze temporal patterns.

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
4. Install: `npm install -g logseq-mcp-server`
5. Add to Claude Desktop MCP settings

## 11 Tools at a Glance

### Basic Operations (5)
| Tool | Purpose |
|------|---------|
| `search_blocks` | Full-text search with optional semantic context |
| `get_page` | Retrieve page content with children |
| `get_backlinks` | Find all references to a page |
| `get_block` | Get specific block by UUID |
| `query_by_property` | Find blocks by property key/value |

### Graph Traversal (1)
| Tool | Purpose |
|------|---------|
| `get_concept_network` | Build network graph with nodes/edges |

### Semantic Search (1)
| Tool | Purpose |
|------|---------|
| `search_by_relationship` | Find blocks based on topic relationships |

### Context Building (2)
| Tool | Purpose |
|------|---------|
| `build_context` | Gather comprehensive topic context in one call |
| `get_context_for_query` | Parse natural language and build context |

### Temporal Queries (2)
| Tool | Purpose |
|------|---------|
| `query_by_date_range` | Query journal entries by date |
| `get_concept_evolution` | Track concept mentions over time (replaces get_entity_timeline) |

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

## Development

```bash
npm install
npm run build
npm test
npm run test:integration  # Requires running LogSeq instance
```

## Architecture

- **TypeScript** MCP server using `@modelcontextprotocol/sdk`
- **LogSeq HTTP API** client for graph queries
- **Vitest** for unit and integration testing
- **TDD approach** - all tools have comprehensive test coverage
