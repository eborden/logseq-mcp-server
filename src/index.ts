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
import { loadConfig } from './config.js';
import { LogseqClient } from './client.js';
import { getPage } from './tools/get-page.js';
import { getBacklinks } from './tools/get-backlinks.js';
import { getBlock } from './tools/get-block.js';
import { searchBlocks } from './tools/search-blocks.js';
import { queryByProperty } from './tools/query-by-property.js';
import { getConceptNetwork } from './tools/get-concept-network.js';
import { searchByRelationship } from './tools/search-by-relationship.js';
import { buildContextForTopic } from './tools/build-context.js';
import { getContextForQuery } from './tools/get-context-for-query.js';
import { queryByDateRange } from './tools/query-by-date-range.js';
import { getConceptEvolution } from './tools/get-concept-evolution.js';
import { getGraphInfo } from './tools/get-graph-info.js';
import { listPages } from './tools/list-pages.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';

// Define MCP tool schemas for all 13 tools
const TOOLS = [
  {
    name: 'logseq_get_page',
    description: TOOL_DESCRIPTIONS.logseq_get_page,
    inputSchema: {
      type: 'object',
      properties: {
        page_name: {
          type: 'string',
          description: 'Name of the page to retrieve',
        },
        include_children: {
          type: 'boolean',
          description: 'Whether to include child blocks/pages',
          default: false,
        },
      },
      required: ['page_name'],
    },
  },
  {
    name: 'logseq_get_backlinks',
    description: TOOL_DESCRIPTIONS.logseq_get_backlinks,
    inputSchema: {
      type: 'object',
      properties: {
        page_name: {
          type: 'string',
          description: 'Name of the page to get backlinks for',
        },
      },
      required: ['page_name'],
    },
  },
  {
    name: 'logseq_get_block',
    description: TOOL_DESCRIPTIONS.logseq_get_block,
    inputSchema: {
      type: 'object',
      properties: {
        block_uuid: {
          type: 'string',
          description: 'UUID of the block to retrieve',
        },
        include_children: {
          type: 'boolean',
          description: 'Whether to include child blocks',
          default: false,
        },
      },
      required: ['block_uuid'],
    },
  },
  {
    name: 'logseq_search_blocks',
    description: TOOL_DESCRIPTIONS.logseq_search_blocks,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in block content',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (optional)',
        },
        include_context: {
          type: 'boolean',
          description: 'Include semantic context (page, references, tags)',
          default: false,
        },
        slim_results: {
          type: 'boolean',
          description: 'Return slim results (40-50% fewer tokens, essential data only)',
          default: false,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'logseq_query_by_property',
    description: TOOL_DESCRIPTIONS.logseq_query_by_property,
    inputSchema: {
      type: 'object',
      properties: {
        property_key: {
          type: 'string',
          description: 'Name of the property to query',
        },
        property_value: {
          type: 'string',
          description: 'Value to match for the property',
        },
        slim_results: {
          type: 'boolean',
          description: 'Return slim results (40-50% fewer tokens, essential data only)',
          default: false,
        },
      },
      required: ['property_key', 'property_value'],
    },
  },
  {
    name: 'logseq_get_concept_network',
    description: TOOL_DESCRIPTIONS.logseq_get_concept_network,
    inputSchema: {
      type: 'object',
      properties: {
        concept_name: {
          type: 'string',
          description: 'Name of the root concept',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 2, max: 3)',
          default: 2,
        },
      },
      required: ['concept_name'],
    },
  },
  {
    name: 'logseq_search_by_relationship',
    description: TOOL_DESCRIPTIONS.logseq_search_by_relationship,
    inputSchema: {
      type: 'object',
      properties: {
        topic_a: {
          type: 'string',
          description: 'Primary topic to search for',
        },
        topic_b: {
          type: 'string',
          description: 'Related topic that defines the relationship',
        },
        relationship_type: {
          type: 'string',
          enum: ['references', 'referenced-by', 'in-pages-linking-to', 'connected-within'],
          description: 'Type of relationship: references (blocks about A that reference B), referenced-by (blocks about A in pages referenced by B), in-pages-linking-to (blocks about A in pages linking to B), connected-within (topics connected within N hops)',
        },
        max_distance: {
          type: 'number',
          description: 'Maximum graph distance for connected-within (default: 2)',
          default: 2,
        },
      },
      required: ['topic_a', 'topic_b', 'relationship_type'],
    },
  },
  {
    name: 'logseq_build_context',
    description: TOOL_DESCRIPTIONS.logseq_build_context,
    inputSchema: {
      type: 'object',
      properties: {
        topic_name: {
          type: 'string',
          description: 'Name of the topic to build context for',
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
      },
      required: ['topic_name'],
    },
  },
  {
    name: 'logseq_get_context_for_query',
    description: TOOL_DESCRIPTIONS.logseq_get_context_for_query,
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
      },
      required: ['query'],
    },
  },
  {
    name: 'logseq_query_by_date_range',
    description: TOOL_DESCRIPTIONS.logseq_query_by_date_range,
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'number',
          description: 'Start date in YYYYMMDD format (e.g., 20251115)',
        },
        end_date: {
          type: 'number',
          description: 'End date in YYYYMMDD format (e.g., 20251120)',
        },
        search_term: {
          type: 'string',
          description: 'Optional search term to filter blocks',
        },
        slim_results: {
          type: 'boolean',
          description: 'Return slim results (40-50% fewer tokens, essential data only)',
          default: false,
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'logseq_get_concept_evolution',
    description: TOOL_DESCRIPTIONS.logseq_get_concept_evolution,
    inputSchema: {
      type: 'object',
      properties: {
        concept_name: {
          type: 'string',
          description: 'Name of the concept to track',
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
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'logseq_list_pages',
    description: TOOL_DESCRIPTIONS.logseq_list_pages,
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

/**
 * Create and configure the MCP server
 */
export function createServer(client: LogseqClient): Server {
  const server = new Server(
    {
      name: 'logseq-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Handler for calling tools
  server.setRequestHandler(CallToolRequestSchema, async (request) => {

    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'logseq_get_page': {
          const pageName = args?.page_name as string;
          const includeChildren = (args?.include_children as boolean) ?? false;
          const result = await getPage(client, pageName, includeChildren);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_backlinks': {
          const pageName = args?.page_name as string;
          const result = await getBacklinks(client, pageName);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_block': {
          const blockUuid = args?.block_uuid as string;
          const includeChildren = (args?.include_children as boolean) ?? false;
          const result = await getBlock(client, blockUuid, includeChildren);
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
          const query = args?.query as string;
          const limit = args?.limit as number | undefined;
          const includeContext = (args?.include_context as boolean) ?? false;
          const slimResults = (args?.slim_results as boolean) ?? false;
          let result = await searchBlocks(client, query, limit, includeContext, slimResults);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_query_by_property': {
          const propertyKey = args?.property_key as string;
          const propertyValue = args?.property_value as string;
          const slimResults = (args?.slim_results as boolean) ?? false;
          const result = await queryByProperty(client, propertyKey, propertyValue, slimResults);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_concept_network': {
          const conceptName = args?.concept_name as string;
          const maxDepth = Math.min((args?.max_depth as number) ?? 2, 3);
          const result = await getConceptNetwork(client, conceptName, maxDepth);
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
          const topicA = args?.topic_a as string;
          const topicB = args?.topic_b as string;
          const relationshipType = args?.relationship_type as any;
          const maxDistance = (args?.max_distance as number) ?? 2;
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
          const options = {
            maxBlocks: args?.max_blocks as number | undefined,
            maxRelatedPages: args?.max_related_pages as number | undefined,
            maxReferences: args?.max_references as number | undefined,
            includeTemporalContext: args?.include_temporal_context as boolean | undefined
          };
          const result = await buildContextForTopic(client, topicName, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_get_context_for_query': {
          const query = args?.query as string;
          const options = {
            maxTopics: args?.max_topics as number | undefined,
            maxSearchResults: args?.max_search_results as number | undefined
          };
          const result = await getContextForQuery(client, query, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'logseq_query_by_date_range': {
          const startDate = args?.start_date as number;
          const endDate = args?.end_date as number;
          const searchTerm = args?.search_term as string | undefined;
          const slimResults = (args?.slim_results as boolean) ?? false;
          const result = await queryByDateRange(
            client,
            startDate,
            endDate,
            searchTerm,
            slimResults
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
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
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
    const server = createServer(client);

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
