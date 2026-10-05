#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'path';
import { homedir } from 'os';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig, resolveTipsEnabled } from './config.js';
import { LogseqClient } from './client.js';
import { getPage } from './tools/get-page.js';
import { getBacklinksWithMeta } from './tools/get-backlinks.js';
import { getBlock } from './tools/get-block.js';
import { getPageOutline } from './tools/get-page-outline.js';
import { searchBlocksWithMeta } from './tools/search-blocks.js';
import { queryByProperty } from './tools/query-by-property.js';
import { getConceptNetwork } from './tools/get-concept-network.js';
import { searchByRelationship } from './tools/search-by-relationship.js';
import { buildContextForTopic } from './tools/build-context.js';
import { getContextForQuery } from './tools/get-context-for-query.js';
import { queryJournals } from './tools/query-by-date-range.js';
import { DATE_PRESETS } from './utils/date-presets.js';
import { getConceptEvolution } from './tools/get-concept-evolution.js';
import { getGraphInfo } from './tools/get-graph-info.js';
import { listPages } from './tools/list-pages.js';
import { getCurrentContext } from './tools/get-current-context.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';
import { metaContent } from './utils/result-meta.js';
import { buildTips } from './utils/tips.js';
import type { ResultMeta } from './types.js';
import { resolveParamAliases } from './utils/param-aliases.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { SERVER_VERSION } from './version.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { AmbiguousPageError } from './errors.js';
import { ambiguousPageResult } from './utils/resolve-page.js';
import { wantsSlim } from './utils/slim-entities.js';
import { parseCompact, parseFormat } from './utils/output-format.js';
import { compactQueryContext, compactTopicContext } from './utils/compact.js';
import { renderNetwork, renderQueryContext, renderTopicContext } from './utils/markdown-context.js';
import { renderBlock, renderPage, withFooter } from './utils/markdown.js';
import { parseArgs, toInputSchema } from './utils/parse-args.js';
import {
  FORMAT_DESCRIPTION,
  RESOLVE_REFS_DESCRIPTION,
  getBacklinksArgs,
  getBlockArgs,
  getConceptNetworkArgs,
  getPageArgs,
  queryByPropertyArgs,
  searchBlocksArgs,
  searchByRelationshipArgs,
} from './tool-args.js';

/**
 * Hints shared by every tool. This server only reads from LogSeq, so each tool
 * is read-only, non-destructive, idempotent, and talks to a single known local
 * system rather than an open world. Per the MCP spec, omitting these makes
 * clients assume a tool may be destructive and open-world.
 */
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function readOnlyAnnotations(title: string) {
  return { title, ...READ_ONLY_HINTS };
}

/** `format` parameter shared by the tools that can render Markdown (#43). */
const FORMAT_PARAM = {
  type: 'string',
  enum: ['json', 'markdown'],
  description: FORMAT_DESCRIPTION,
} as const;

/** `compact` parameter shared by the tools whose blocks can shrink to snippets (#43). */
const COMPACT_PARAM = {
  type: 'boolean',
  description: 'Block snippets and uuids, no bodies. Read one with logseq_get_block',
  default: false,
} as const;

// Define MCP tool schemas for all 15 tools
const TOOLS = [
  {
    name: 'logseq_get_page',
    description: TOOL_DESCRIPTIONS.logseq_get_page,
    annotations: readOnlyAnnotations('Get Page'),
    inputSchema: toInputSchema(getPageArgs),
  },
  {
    name: 'logseq_get_page_outline',
    description: TOOL_DESCRIPTIONS.logseq_get_page_outline,
    annotations: readOnlyAnnotations('Get Page Outline'),
    inputSchema: {
      type: 'object',
      properties: {
        page_name: {
          type: 'string',
          description: 'Page name, alias, or ISO date (2025-01-01) for a journal',
        },
      },
      required: ['page_name'],
    },
  },
  {
    name: 'logseq_get_backlinks',
    description: TOOL_DESCRIPTIONS.logseq_get_backlinks,
    annotations: readOnlyAnnotations('Get Backlinks'),
    inputSchema: toInputSchema(getBacklinksArgs),
  },
  {
    name: 'logseq_get_block',
    description: TOOL_DESCRIPTIONS.logseq_get_block,
    annotations: readOnlyAnnotations('Get Block'),
    inputSchema: toInputSchema(getBlockArgs),
  },
  {
    name: 'logseq_search_blocks',
    description: TOOL_DESCRIPTIONS.logseq_search_blocks,
    annotations: readOnlyAnnotations('Search Blocks'),
    inputSchema: toInputSchema(searchBlocksArgs),
  },
  {
    name: 'logseq_query_by_property',
    description: TOOL_DESCRIPTIONS.logseq_query_by_property,
    annotations: readOnlyAnnotations('Query by Property'),
    inputSchema: toInputSchema(queryByPropertyArgs),
  },
  {
    name: 'logseq_get_concept_network',
    description: TOOL_DESCRIPTIONS.logseq_get_concept_network,
    annotations: readOnlyAnnotations('Get Concept Network'),
    inputSchema: toInputSchema(getConceptNetworkArgs),
  },
  {
    name: 'logseq_search_by_relationship',
    description: TOOL_DESCRIPTIONS.logseq_search_by_relationship,
    annotations: readOnlyAnnotations('Search by Relationship'),
    inputSchema: toInputSchema(searchByRelationshipArgs),
  },
  {
    name: 'logseq_build_context',
    description: TOOL_DESCRIPTIONS.logseq_build_context,
    annotations: readOnlyAnnotations('Build Context'),
    inputSchema: {
      type: 'object',
      properties: {
        topic_name: {
          type: 'string',
          description: 'Topic to build context for (page name, alias or ISO date)',
        },
        max_blocks: {
          type: 'number',
          description: 'Maximum number of blocks to include (default: 50)',
          default: 50,
        },
        max_related_pages: {
          type: 'number',
          description: 'Maximum number of related pages to include (default: 10)',
          default: 10,
        },
        max_references: {
          type: 'number',
          description: 'Maximum number of reference blocks to include (default: 20)',
          default: 20,
        },
        include_temporal_context: {
          type: 'boolean',
          description: 'Include temporal context for journal pages (default: true)',
          default: true,
        },
        resolve_refs: {
          type: 'boolean',
          description: RESOLVE_REFS_DESCRIPTION,
          default: false,
        },
        format: FORMAT_PARAM,
        compact: COMPACT_PARAM,
      },
      required: ['topic_name'],
    },
  },
  {
    name: 'logseq_get_context_for_query',
    description: TOOL_DESCRIPTIONS.logseq_get_context_for_query,
    annotations: readOnlyAnnotations('Get Context for Query'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query (can include [[page references]] and #tags)',
        },
        max_topics: {
          type: 'number',
          description: 'Maximum number of topics to extract context for (default: 5)',
          default: 5,
        },
        max_search_results: {
          type: 'number',
          description: 'Maximum number of search results for queries without explicit topics (default: 20)',
          default: 20,
        },
        format: FORMAT_PARAM,
        compact: COMPACT_PARAM,
      },
      required: ['query'],
    },
  },
  {
    name: 'logseq_query_by_date_range',
    description: TOOL_DESCRIPTIONS.logseq_query_by_date_range,
    annotations: readOnlyAnnotations('Query by Date Range'),
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'number',
          description: 'Start date in YYYYMMDD format (e.g., 20251115). Needs end_date',
        },
        end_date: {
          type: 'number',
          description: 'End date in YYYYMMDD format (e.g., 20251120). Needs start_date',
        },
        last_n: {
          type: 'number',
          description: 'The N most recent journals that exist (whole number, 1+), newest first',
        },
        preset: {
          type: 'string',
          enum: [...DATE_PRESETS],
          description: 'Named period in local time; weeks run Monday to Sunday',
        },
        search_term: {
          type: 'string',
          description: 'Optional search term to filter blocks',
        },
        slim_results: {
          type: 'boolean',
          description: 'Slim blocks (default). false returns full entities',
          default: true,
        },
        include_content: {
          type: 'boolean',
          description: 'false returns only per-day block counts and top-level snippets',
          default: true,
        },
        top_concepts_limit: {
          type: 'number',
          description: 'Entries in summary.topConcepts, the most-linked pages (default 10). 0 omits it',
          default: 10,
        },
        resolve_refs: {
          type: 'boolean',
          description: RESOLVE_REFS_DESCRIPTION,
          default: false,
        },
      },
    },
  },
  {
    name: 'logseq_get_concept_evolution',
    description: TOOL_DESCRIPTIONS.logseq_get_concept_evolution,
    annotations: readOnlyAnnotations('Get Concept Evolution'),
    inputSchema: {
      type: 'object',
      properties: {
        concept_name: {
          type: 'string',
          description: 'Concept to track (page name, alias or ISO date)',
        },
        start_date: {
          type: 'number',
          description: 'Optional start date in YYYYMMDD format',
        },
        end_date: {
          type: 'number',
          description: 'Optional end date in YYYYMMDD format',
        },
        group_by: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Optional grouping period',
        },
      },
      required: ['concept_name'],
    },
  },
  {
    name: 'logseq_get_graph_info',
    description: TOOL_DESCRIPTIONS.logseq_get_graph_info,
    annotations: readOnlyAnnotations('Get Graph Info'),
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'logseq_get_current_context',
    description: TOOL_DESCRIPTIONS.logseq_get_current_context,
    // Read-only like every other tool, but not idempotent: the result depends on
    // what the user has open in the LogSeq UI, which changes between calls.
    annotations: { ...readOnlyAnnotations('Get Current Context'), idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'logseq_list_pages',
    description: TOOL_DESCRIPTIONS.logseq_list_pages,
    annotations: readOnlyAnnotations('List Pages'),
    inputSchema: {
      type: 'object',
      properties: {
        name_contains: {
          type: 'string',
          description: 'Filter page names containing this text (case-insensitive)',
        },
      },
      required: [],
    },
  },
];

/** A tool result that is one plain-text block, e.g. Markdown (#43). Not JSON-escaped. */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Create and configure the MCP server
 */
export function createServer(client: LogseqClient, options: { tips?: boolean } = {}): Server {
  const tipsEnabled = options.tips !== false;

  const server = new Server(
    {
      name: 'logseq-mcp-server',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Prompts and resources (#46): read-only, handlers live in their own modules
  registerPrompts(server);
  registerResources(server, client);

  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Handler for calling tools
  server.setRequestHandler(CallToolRequestSchema, async (request) => {

    const { name, arguments: rawArgs } = request.params;

    try {
      // Fold unadvertised aliases (`name`, `page`, ...) into their canonical parameter (#44)
      const args = resolveParamAliases(name, rawArgs);
      // Next-step tips ride in the trailing meta block (#44); none when disabled
      const tipsFor = (result: unknown, meta?: ResultMeta | null) => (tipsEnabled ? buildTips(name, args, result, meta) : []);
      switch (name) {
        case 'logseq_get_page': {
          const { page_name: pageName, include_children: includeChildren, resolve_refs: resolveRefs, format } =
            parseArgs(getPageArgs, args);
          const result = await getPage(client, pageName, includeChildren, { resolveRefs });
          if (format === 'markdown') {
            const text = renderPage(result, { blocksFetched: includeChildren });
            return textResult(withFooter(text, { ...result, tips: tipsFor(result) }));
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(result)),
            ],
          };
        }

        case 'logseq_get_page_outline': {
          const pageName = args?.page_name as string;
          const result = await getPageOutline(client, pageName);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(result)),
            ],
          };
        }

        case 'logseq_get_backlinks': {
          const { page_name: pageName } = parseArgs(getBacklinksArgs, args);
          const { results: result, meta } = await getBacklinksWithMeta(client, pageName);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(meta, tipsFor(result, meta)),
            ],
          };
        }

        case 'logseq_get_block': {
          const { block_uuid: blockUuid, include_children: includeChildren, resolve_refs: resolveRefs, format } =
            parseArgs(getBlockArgs, args);
          const result = await getBlock(client, blockUuid, includeChildren, { resolveRefs });
          if (format === 'markdown') return textResult(withFooter(renderBlock(result), result));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_search_blocks': {
          const { query, limit, include_context: includeContext, slim_results: slimResults } =
            parseArgs(searchBlocksArgs, args);
          const { results: result, meta } = await searchBlocksWithMeta(client, query, limit, includeContext, slimResults);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(meta, tipsFor(result, meta)),
            ],
          };
        }

        case 'logseq_query_by_property': {
          const { property_key: propertyKey, property_value: propertyValue, slim_results: slimResults } =
            parseArgs(queryByPropertyArgs, args);
          const result = await queryByProperty(client, propertyKey, propertyValue, slimResults);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(result)),
            ],
          };
        }

        case 'logseq_get_concept_network': {
          const {
            concept_name: conceptName,
            max_depth: maxDepth,
            max_nodes: maxNodes,
            max_fanout: maxFanout,
            expand_journals: expandJournals,
            format,
          } = parseArgs(getConceptNetworkArgs, args);
          // Safeguards: caps on the walk, whatever the caller asks for
          const result = await getConceptNetwork(client, conceptName, Math.min(maxDepth, 3), {
            maxNodes: Math.min(maxNodes, 500),
            maxFanout: Math.min(maxFanout, 100),
            expandJournals,
          });
          if (format === 'markdown') return textResult(withFooter(renderNetwork(result), result));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_search_by_relationship': {
          const {
            topic_a: topicA,
            topic_b: topicB,
            relationship_type: relationshipType,
            max_distance: maxDistance,
          } = parseArgs(searchByRelationshipArgs, args);
          const result = await searchByRelationship(
            client,
            topicA,
            topicB,
            relationshipType,
            maxDistance
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_build_context': {
          const topicName = args?.topic_name as string;
          const format = parseFormat(args?.format);
          const compact = parseCompact(args?.compact);
          const options = {
            maxBlocks: args?.max_blocks as number | undefined,
            maxRelatedPages: args?.max_related_pages as number | undefined,
            maxReferences: args?.max_references as number | undefined,
            includeTemporalContext: args?.include_temporal_context as boolean | undefined,
            // Compact output drops the bodies, so there is nothing to resolve refs in
            resolveRefs: args?.resolve_refs === true && !compact
          };
          const result = await buildContextForTopic(client, topicName, options);
          // Compact output has no block bodies to resolve refs in. Say so rather than drop the request silently.
          if (compact && args?.resolve_refs === true) {
            result.warnings = [
              ...result.warnings,
              {
                code: 'resolve_refs_ignored_in_compact',
                message:
                  'compact output has no block bodies, so resolve_refs was skipped. Set compact to false for resolved text, or read a block with logseq_get_block and resolve_refs.',
              },
            ];
          }
          if (format === 'markdown') return textResult(withFooter(renderTopicContext(result, { compact }), result));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(compact ? compactTopicContext(result) : result),
              },
            ],
          };
        }

        case 'logseq_get_context_for_query': {
          const query = args?.query as string;
          const format = parseFormat(args?.format);
          const compact = parseCompact(args?.compact);
          const options = {
            maxTopics: args?.max_topics as number | undefined,
            maxSearchResults: args?.max_search_results as number | undefined,
            // Markdown names the page of each keyword hit; JSON hits keep their shape
            hitPages: format === 'markdown'
          };
          const result = await getContextForQuery(client, query, options);
          if (format === 'markdown') return textResult(withFooter(renderQueryContext(result, { compact }), result));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(compact ? compactQueryContext(result) : result),
              },
            ],
          };
        }

        case 'logseq_query_by_date_range': {
          const result = await queryJournals(client, {
            startDate: args?.start_date as number | undefined,
            endDate: args?.end_date as number | undefined,
            lastN: args?.last_n as number | undefined,
            preset: args?.preset as string | undefined,
            searchTerm: args?.search_term as string | undefined,
            slimResults: wantsSlim(args?.slim_results),
            includeContent: (args?.include_content as boolean) ?? true,
            topConceptsLimit: args?.top_concepts_limit as number | undefined,
            resolveRefs: args?.resolve_refs === true,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(result)),
            ],
          };
        }

        case 'logseq_get_concept_evolution': {
          const conceptName = args?.concept_name as string;
          const options = {
            startDate: args?.start_date as number | undefined,
            endDate: args?.end_date as number | undefined,
            groupBy: args?.group_by as any
          };
          const result = await getConceptEvolution(client, conceptName, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_graph_info': {
          const result = await getGraphInfo(client);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_current_context': {
          const result = await getCurrentContext(client);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_list_pages': {
          const result = await listPages(client, {
            nameContains: args?.name_contains as string | undefined,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(result)),
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // A name that matches several pages is a result, not a failure: the
      // candidates tell the caller which exact name to repeat the call with.
      if (error instanceof AmbiguousPageError) {
        return {
          content: [{ type: 'text', text: JSON.stringify(ambiguousPageResult(error)) }],
        };
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Main function to start the MCP server
 */
async function main() {
  try {
    // Load config from ~/.logseq-mcp/config.json
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
    const config = await loadConfig(configPath);

    // Create LogSeq client
    const client = new LogseqClient(config);

    // Create and configure server with client
    const server = createServer(client, { tips: resolveTipsEnabled(config) });

    // Create transport and connect
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('LogSeq MCP server running on stdio');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Run main if this is the entry point
// Resolve symlinks to support npm link
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMainModule) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// Export for testing and CLI usage
export { main };
