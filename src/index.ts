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
import { getRelatedPages } from './tools/get-related-pages.js';
import { getEntityTimeline } from './tools/get-entity-timeline.js';
import { getConceptNetwork } from './tools/get-concept-network.js';
import { searchByRelationship } from './tools/search-by-relationship.js';
import { buildContextForTopic } from './tools/build-context.js';

// Define MCP tool schemas for all 5 tools
const TOOLS = [
  {
    name: 'logseq_get_page',
    description: 'Get a LogSeq page by name with optional child blocks/pages',
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
    description: 'Get all pages/blocks that link to a specific page',
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
    description: 'Get a LogSeq block by UUID with optional child blocks',
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
    description: 'Search for blocks containing specific text with optional semantic context',
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
      },
      required: ['query'],
    },
  },
  {
    name: 'logseq_query_by_property',
    description: 'Query blocks by a specific property name and value',
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
      },
      required: ['property_key', 'property_value'],
    },
  },
  {
    name: 'logseq_get_related_pages',
    description: 'Get pages related to a source page through references and backlinks',
    inputSchema: {
      type: 'object',
      properties: {
        page_name: {
          type: 'string',
          description: 'Name of the source page',
        },
        depth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 1, max: 3)',
          default: 1,
        },
      },
      required: ['page_name'],
    },
  },
  {
    name: 'logseq_get_entity_timeline',
    description: 'Get timeline of blocks mentioning an entity, sorted chronologically',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: {
          type: 'string',
          description: 'Name of the entity (page name)',
        },
        start_date: {
          type: 'number',
          description: 'Optional start date in YYYYMMDD format',
        },
        end_date: {
          type: 'number',
          description: 'Optional end date in YYYYMMDD format',
        },
      },
      required: ['entity_name'],
    },
  },
  {
    name: 'logseq_get_concept_network',
    description: 'Get network of pages related to a concept with nodes and edges',
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
    description: 'Search for blocks based on relationship between topics (e.g., blocks about X that reference Y)',
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
    description: 'Build comprehensive context for a topic including related pages, blocks, and references',
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
];

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
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

  // Load config and create client (will be initialized in main)
  let client: LogseqClient | null = null;

  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Handler for calling tools
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!client) {
      throw new Error('LogSeq client not initialized');
    }

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
                text: JSON.stringify(result, null, 2),
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
                text: JSON.stringify(result, null, 2),
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
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'logseq_search_blocks': {
          const query = args?.query as string;
          const limit = args?.limit as number | undefined;
          const includeContext = (args?.include_context as boolean) ?? false;
          let result = await searchBlocks(client, query, limit, includeContext);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'logseq_query_by_property': {
          const propertyKey = args?.property_key as string;
          const propertyValue = args?.property_value as string;
          const result = await queryByProperty(client, propertyKey, propertyValue);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'logseq_get_related_pages': {
          const pageName = args?.page_name as string;
          const depth = Math.min((args?.depth as number) ?? 1, 3);
          const result = await getRelatedPages(client, pageName, depth);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'logseq_get_entity_timeline': {
          const entityName = args?.entity_name as string;
          const startDate = args?.start_date as number | undefined;
          const endDate = args?.end_date as number | undefined;
          const result = await getEntityTimeline(
            client,
            entityName,
            startDate,
            endDate
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
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
                text: JSON.stringify(result, null, 2),
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
                text: JSON.stringify(result, null, 2),
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
                text: JSON.stringify(result, null, 2),
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
            text: JSON.stringify({ error: errorMessage }, null, 2),
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

    // Create and configure server
    const server = createServer();

    // Set the client on the server instance (using a closure hack)
    // This is a workaround since we can't easily pass the client through the handler
    const originalHandler = server.setRequestHandler.bind(server);
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Re-bind client in closure
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
                  text: JSON.stringify(result, null, 2),
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
                  text: JSON.stringify(result, null, 2),
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
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'logseq_search_blocks': {
            const query = args?.query as string;
            const limit = args?.limit as number | undefined;
            const includeContext = (args?.include_context as boolean) ?? false;
            let result = await searchBlocks(client, query, limit, includeContext);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'logseq_query_by_property': {
            const propertyKey = args?.property_key as string;
            const propertyValue = args?.property_value as string;
            const result = await queryByProperty(client, propertyKey, propertyValue);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'logseq_get_related_pages': {
            const pageName = args?.page_name as string;
            const depth = Math.min((args?.depth as number) ?? 1, 3);
            const result = await getRelatedPages(client, pageName, depth);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'logseq_get_entity_timeline': {
            const entityName = args?.entity_name as string;
            const startDate = args?.start_date as number | undefined;
            const endDate = args?.end_date as number | undefined;
            const result = await getEntityTimeline(
              client,
              entityName,
              startDate,
              endDate
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
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
                  text: JSON.stringify(result, null, 2),
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
                  text: JSON.stringify(result, null, 2),
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
                  text: JSON.stringify(result, null, 2),
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
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });

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
