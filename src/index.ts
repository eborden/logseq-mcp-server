#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig, resolveConfigPath, resolveTipsEnabled } from './config.js';
import { LogseqClient } from './client.js';
import { getPage } from './tools/get-page.js';
import { getBacklinksWithMeta } from './tools/get-backlinks.js';
import { getBlock } from './tools/get-block.js';
import { getPageOutline } from './tools/get-page-outline.js';
import { searchBlocksWithMeta } from './tools/search-blocks.js';
import { queryByProperty } from './tools/query-by-property.js';
import { getConceptNetwork, MAX_FANOUT_LIMIT, MAX_NODES_LIMIT } from './tools/get-concept-network.js';
import { searchByRelationship } from './tools/search-by-relationship.js';
import { buildContextForTopic } from './tools/build-context.js';
import { getContextForQuery } from './tools/get-context-for-query.js';
import { queryJournals } from './tools/query-by-date-range.js';
import { getConceptEvolution } from './tools/get-concept-evolution.js';
import { getGraphInfo } from './tools/get-graph-info.js';
import { listPages } from './tools/list-pages.js';
import { getCurrentContext } from './tools/get-current-context.js';
import { checkLinks } from './tools/check-links.js';
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
import { compactQueryContext, compactTopicContext } from './utils/compact.js';
import { renderNetwork, renderQueryContext, renderTopicContext } from './utils/markdown-context.js';
import { renderBlock, renderPage, withFooter } from './utils/markdown.js';
import { parseArgs, toInputSchema, type ToolInputSchema } from './utils/parse-args.js';
import {
  buildContextArgs,
  checkLinksArgs,
  getBacklinksArgs,
  getBlockArgs,
  getConceptEvolutionArgs,
  getConceptNetworkArgs,
  getContextForQueryArgs,
  getCurrentContextArgs,
  getGraphInfoArgs,
  getPageArgs,
  getPageOutlineArgs,
  listPagesArgs,
  queryByDateRangeArgs,
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

/**
 * These tools have always advertised `required: []`, which zod leaves out when no
 * field is required. Kept so tools/list doesn't change; a generated `required` wins.
 */
function withEmptyRequired(schema: ToolInputSchema): ToolInputSchema {
  return { required: [], ...schema };
}

// Define MCP tool schemas for all 16 tools
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
    inputSchema: toInputSchema(getPageOutlineArgs),
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
    inputSchema: toInputSchema(buildContextArgs),
  },
  {
    name: 'logseq_get_context_for_query',
    description: TOOL_DESCRIPTIONS.logseq_get_context_for_query,
    annotations: readOnlyAnnotations('Get Context for Query'),
    inputSchema: toInputSchema(getContextForQueryArgs),
  },
  {
    name: 'logseq_query_by_date_range',
    description: TOOL_DESCRIPTIONS.logseq_query_by_date_range,
    annotations: readOnlyAnnotations('Query by Date Range'),
    inputSchema: toInputSchema(queryByDateRangeArgs),
  },
  {
    name: 'logseq_get_concept_evolution',
    description: TOOL_DESCRIPTIONS.logseq_get_concept_evolution,
    annotations: readOnlyAnnotations('Get Concept Evolution'),
    inputSchema: toInputSchema(getConceptEvolutionArgs),
  },
  {
    name: 'logseq_get_graph_info',
    description: TOOL_DESCRIPTIONS.logseq_get_graph_info,
    annotations: readOnlyAnnotations('Get Graph Info'),
    inputSchema: withEmptyRequired(toInputSchema(getGraphInfoArgs)),
  },
  {
    name: 'logseq_get_current_context',
    description: TOOL_DESCRIPTIONS.logseq_get_current_context,
    // Read-only like every other tool, but not idempotent: the result depends on
    // what the user has open in the LogSeq UI, which changes between calls.
    annotations: { ...readOnlyAnnotations('Get Current Context'), idempotentHint: false },
    inputSchema: withEmptyRequired(toInputSchema(getCurrentContextArgs)),
  },
  {
    name: 'logseq_list_pages',
    description: TOOL_DESCRIPTIONS.logseq_list_pages,
    annotations: readOnlyAnnotations('List Pages'),
    inputSchema: withEmptyRequired(toInputSchema(listPagesArgs)),
  },
  {
    name: 'logseq_check_links',
    description: TOOL_DESCRIPTIONS.logseq_check_links,
    annotations: readOnlyAnnotations('Check Links'),
    inputSchema: toInputSchema(checkLinksArgs),
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
      // Next-step tips ride in the trailing meta block (#44); none when disabled. They
      // read the parsed arguments (#60), never the raw ones.
      const tipsFor = (parsed: Record<string, unknown>, result: unknown, meta?: ResultMeta | null) =>
        tipsEnabled ? buildTips(name, parsed, result, meta) : [];
      switch (name) {
        case 'logseq_get_page': {
          const parsed = parseArgs(getPageArgs, args);
          const { page_name: pageName, include_children: includeChildren, resolve_refs: resolveRefs, format } = parsed;
          const result = await getPage(client, pageName, includeChildren, { resolveRefs });
          if (format === 'markdown') {
            const text = renderPage(result, { blocksFetched: includeChildren });
            return textResult(withFooter(text, { ...result, tips: tipsFor(parsed, result) }));
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(parsed, result)),
            ],
          };
        }

        case 'logseq_get_page_outline': {
          const parsed = parseArgs(getPageOutlineArgs, args);
          const result = await getPageOutline(client, parsed.page_name);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(parsed, result)),
            ],
          };
        }

        case 'logseq_get_backlinks': {
          const parsed = parseArgs(getBacklinksArgs, args);
          const { results: result, meta } = await getBacklinksWithMeta(client, parsed.page_name, {
            maxPages: parsed.max_pages,
            maxBlocksPerPage: parsed.max_blocks_per_page,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(meta, tipsFor(parsed, result, meta)),
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
          const parsed = parseArgs(searchBlocksArgs, args);
          const { query, limit, include_context: includeContext, slim_results: slimResults } = parsed;
          const { results: result, meta } = await searchBlocksWithMeta(client, query, limit, includeContext, slimResults);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(meta, tipsFor(parsed, result, meta)),
            ],
          };
        }

        case 'logseq_query_by_property': {
          const parsed = parseArgs(queryByPropertyArgs, args);
          const { property_key: propertyKey, property_value: propertyValue, slim_results: slimResults } = parsed;
          const result = await queryByProperty(client, propertyKey, propertyValue, slimResults);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(parsed, result)),
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
            maxNodes: Math.min(maxNodes, MAX_NODES_LIMIT),
            maxFanout: Math.min(maxFanout, MAX_FANOUT_LIMIT),
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
          const {
            topic_name: topicName,
            max_blocks: maxBlocks,
            max_related_pages: maxRelatedPages,
            max_references: maxReferences,
            include_temporal_context: includeTemporalContext,
            resolve_refs: resolveRefs,
            format,
            compact,
          } = parseArgs(buildContextArgs, args);
          const options = {
            maxBlocks,
            maxRelatedPages,
            maxReferences,
            includeTemporalContext,
            // Compact output drops the bodies, so there is nothing to resolve refs in
            resolveRefs: resolveRefs && !compact
          };
          const result = await buildContextForTopic(client, topicName, options);
          // Compact output has no block bodies to resolve refs in. Say so rather than drop the request silently.
          if (compact && resolveRefs) {
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
          const {
            query,
            max_topics: maxTopics,
            max_search_results: maxSearchResults,
            format,
            compact,
          } = parseArgs(getContextForQueryArgs, args);
          const options = {
            maxTopics,
            maxSearchResults,
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
          const parsed = parseArgs(queryByDateRangeArgs, args);
          const result = await queryJournals(client, {
            startDate: parsed.start_date,
            endDate: parsed.end_date,
            lastN: parsed.last_n,
            preset: parsed.preset,
            searchTerm: parsed.search_term,
            slimResults: parsed.slim_results,
            includeContent: parsed.include_content,
            topConceptsLimit: parsed.top_concepts_limit,
            resolveRefs: parsed.resolve_refs,
            maxBlocks: parsed.max_blocks,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(parsed, result)),
            ],
          };
        }

        case 'logseq_get_concept_evolution': {
          const {
            concept_name: conceptName,
            start_date: startDate,
            end_date: endDate,
            group_by: groupBy,
            max_entries: maxEntries,
          } = parseArgs(getConceptEvolutionArgs, args);
          const options = { startDate, endDate, groupBy, maxEntries };
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
          parseArgs(getGraphInfoArgs, args);
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
          parseArgs(getCurrentContextArgs, args);
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
          const parsed = parseArgs(listPagesArgs, args);
          const result = await listPages(client, {
            nameContains: parsed.name_contains,
            limit: parsed.limit,
            offset: parsed.offset,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
              ...metaContent(null, tipsFor(parsed, result)),
            ],
          };
        }

        case 'logseq_check_links': {
          const parsed = parseArgs(checkLinksArgs, args);
          const result = await checkLinks(client, parsed.before, parsed.after);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
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
    // ~/.logseq-mcp/config.json, or the file LOGSEQ_MCP_CONFIG names
    const configPath = resolveConfigPath();
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
